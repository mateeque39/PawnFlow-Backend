const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const { Pool } = require('pg');
const validators = require('./validators');
const { generateLoanPDF } = require('./pdf-invoice-generator');
const { processPaymentWithCapitalization, extendDateByOneMonth, processPaymentWithAutoExtend } = require('./payment-utils');
const { runMigrationOnStartup } = require('./migrate-on-startup');
const { calculateLoanState } = require('./loan-calculator');
const nodemailer = require('nodemailer');
const { initializeDatabase, isDatabaseInitialized } = require('./db-init');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Configure CORS origins from environment or default to localhost for development
const corsOrigins = process.env.CORS_ORIGINS 
  ? process.env.CORS_ORIGINS.split(',').map(origin => origin.trim())
  : [
      'http://localhost:3000',
      'http://localhost:3001',
      'http://127.0.0.1:3000',
      'http://127.0.0.1:3001',
      'http://localhost:5000',
      'https://pawn-flow-frontend-production.up.railway.app',
      'https://pawnflowsoftware.com',
      'https://www.pawnflowsoftware.com'
    ];

app.use(cors({
  origin: corsOrigins,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Environment', 'X-Client-Version'],
  exposedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400
}));

// Configure JWT secret
let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  // If no JWT_SECRET is provided, generate one (for development/testing only)
  console.warn('⚠️  JWT_SECRET not set in environment. Using fallback secret (NOT SECURE FOR PRODUCTION)');
  JWT_SECRET = 'default-fallback-secret-key-this-should-be-changed-in-production-12345';
}
console.log(`✅ JWT_SECRET configured: ${JWT_SECRET.length} characters`);

// Configure port
const PORT = process.env.PORT || 5000;

// Build database connection string
// Support multiple ways to configure the database connection
const getDatabaseUrl = () => {
  // Log all DATABASE related environment variables for debugging
  console.log('🔍 Checking environment variables:');
  console.log('  DATABASE_URL:', process.env.DATABASE_URL ? '✅ Set' : '❌ Not set');
  console.log('  PGHOST:', process.env.PGHOST ? '✅ Set' : '❌ Not set');
  console.log('  PGUSER:', process.env.PGUSER ? '✅ Set' : '❌ Not set');
  console.log('  PGPASSWORD:', process.env.PGPASSWORD ? '✅ Set' : '❌ Not set');
  console.log('  PGPORT:', process.env.PGPORT ? '✅ Set' : '❌ Not set');
  console.log('  PGDATABASE:', process.env.PGDATABASE ? '✅ Set' : '❌ Not set');
  console.log('  NODE_ENV:', process.env.NODE_ENV || 'Not set (defaults to development)');
  
  // First priority: explicit DATABASE_URL env var (Railway sets this)
  if (process.env.DATABASE_URL) {
    console.log('📍 Using DATABASE_URL from environment');
    return process.env.DATABASE_URL;
  }
  
  // Second priority: Railway-style individual connection variables
  if (process.env.PGHOST) {
    const connectionString = `postgresql://${process.env.PGUSER || 'postgres'}:${process.env.PGPASSWORD || ''}@${process.env.PGHOST}:${process.env.PGPORT || 5432}/${process.env.PGDATABASE || 'railway'}`;
    console.log('📍 Using Railway PostgreSQL environment variables (PGHOST, PGUSER, etc.)');
    return connectionString;
  }
  
  // Third priority: Local development defaults
  const localUrl = `postgresql://${process.env.DB_USER || 'postgres'}:${process.env.DB_PASSWORD || '1234'}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432}/${process.env.DB_NAME || 'pawn_shop'}`;
  console.log('📍 Using local development database configuration');
  return localUrl;
};

const DATABASE_URL = getDatabaseUrl();
// Log connection string with password masked
const loggingUrl = DATABASE_URL.replace(/:[^:@]+@/, ':****@').replace(/@.*/, '@****');
console.log('🔌 Database URL:', loggingUrl);

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  // Pool settings
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Add pool error handlers
pool.on('error', (err) => {
  console.error('❌ Unexpected pool error:', err.message);
  // Don't exit - allow graceful degradation
});

pool.on('connect', () => {
  console.log('✅ Database pool connected');
});

// Test the connection on startup and initialize database
pool.query('SELECT NOW()', async (err, res) => {
  if (err) {
    console.error('❌ Failed to connect to database:', err.message);
    console.error('Error code:', err.code);
    console.error('Error:', err);
    console.error('Database URL:', DATABASE_URL.replace(/:[^:@]+@/, ':****@'));
    console.error('Attempted connection to:', DATABASE_URL.split('@')[1] || 'unknown');
    process.exit(1);
  } else {
    console.log('✅ Database connection test passed at:', res.rows[0].now);
    
    // Initialize database schema (creates tables if they don't exist)
    try {
      console.log('🔄 Initializing database schema...');
      await initializeDatabase(pool);
      console.log('✅ Database schema initialized');
      
      // Run migrations after schema initialization
      await runMigrations();

      // Run automatic interest capitalization migration on startup FIRST
      console.log('\n🔄 Running automatic interest capitalization check...');
      const migrationResult = await runMigrationOnStartup(pool);
      if (migrationResult.success) {
        console.log(`✅ Auto-migration complete: ${migrationResult.message}`);
      } else {
        console.warn(`⚠️  Auto-migration warning: ${migrationResult.message}`);
      }

      // AUTO-FIX ALL CORRUPTED LOANS ON STARTUP (runs AFTER migration to overwrite any corruptions)
      console.log('\n🔧 AUTO-FIXING ALL CORRUPTED LOAN CALCULATIONS...\n');
      try {
        // Get all loans with all needed fields
        const allLoans = await pool.query(
          'SELECT id, loan_amount, initial_loan_amount, interest_rate, loan_term, loan_issued_date FROM loans ORDER BY id'
        );
        console.log(`Found ${allLoans.rows.length} loans - recalculating ALL fields\n`);
        
        let fixedCount = 0;
        let deleteCount = 0;
        
        for (const loan of allLoans.rows) {
          // Use initial_loan_amount as source of truth (correct principal)
          // If both are corrupted the same, use loan_amount; otherwise prefer initial_loan_amount
          const principal = parseFloat(loan.initial_loan_amount || loan.loan_amount || 0);
          const rate = parseFloat(loan.interest_rate || 0);
          const term = parseInt(loan.loan_term || 30);
          
          // Get total payments made so far for accurate remaining balance
          const paymentsResult = await pool.query(
            'SELECT SUM(payment_amount) AS total_paid FROM payment_history WHERE loan_id = $1',
            [loan.id]
          );
          const totalPaid = parseFloat(paymentsResult.rows[0].total_paid || 0);
          
          // Correct calculations
          const correctInterestAmount = (principal * rate) / 100;
          const correctTotalPayable = principal + correctInterestAmount;
          const correctRemainingBalance = correctTotalPayable - totalPaid;
          
          // Calculate correct due date
          let correctDueDate = null;
          if (loan.loan_issued_date) {
            const issued = new Date(loan.loan_issued_date);
            const dueDate = new Date(issued.getTime() + term * 24 * 60 * 60 * 1000);
            correctDueDate = dueDate.toISOString().split('T')[0];
          }
          
          console.log(`📊 Loan #${loan.id}:`);
          console.log(`   Principal: $${principal.toFixed(2)} | Interest (${rate}%): $${correctInterestAmount.toFixed(2)}`);
          console.log(`   Total Payable: $${correctTotalPayable.toFixed(2)} | Remaining: $${correctRemainingBalance.toFixed(2)} | Due: ${correctDueDate}`);
          
          // Update ALL fields with correct calculated values
          // CRITICAL: Do NOT use COALESCE - directly set the values
          await pool.query(
            `UPDATE loans 
             SET loan_amount = $1,
                 initial_loan_amount = $1,
                 interest_amount = $2, 
                 total_payable_amount = $3, 
                 remaining_balance = $4,
                 due_date = $5
             WHERE id = $6`,
            [
              principal,
              correctInterestAmount,
              correctTotalPayable,
              correctRemainingBalance,
              correctDueDate,
              loan.id
            ]
          );
          
          fixedCount++;
          
          // Remove duplicate payments
          const payments = await pool.query(
            'SELECT id FROM payment_history WHERE loan_id = $1 ORDER BY payment_date ASC',
            [loan.id]
          );
          
          if (payments.rows.length > 1) {
            for (let i = 1; i < payments.rows.length; i++) {
              await pool.query('DELETE FROM payment_history WHERE id = $1', [payments.rows[i].id]);
              deleteCount++;
            }
            console.log(`   ✅ Removed ${payments.rows.length - 1} duplicate payment(s)`);
          }
          
          console.log(`   ✅ Fixed\n`);
        }
        
        console.log(`✅ AUTO-FIX COMPLETE:\n   ✓ All ${fixedCount} loans recalculated\n   ✓ Removed ${deleteCount} duplicate payments\n`);
      } catch (autoFixErr) {
        console.error('❌ AUTO-FIX ERROR:', autoFixErr.message);
      }
      
      // Start HTTP server
      console.log('⚙️  Starting PawnFlow Server...');
      console.log('🔌 Listening on port', PORT);

      const server = app.listen(PORT, () => {
        console.log(`🚀 Server is running on port ${PORT}`);
        console.log('✅ Server started successfully');
      });

      // Handle server errors
      server.on('error', (err) => {
        console.error('❌ Server error:', err.message);
        process.exit(1);
      });

      // Log when server closes
      server.on('close', () => {
        console.log('⚠️  Server closed');
      });
    } catch (error) {
      console.error('❌ Fatal error during initialization:', error.message);
      process.exit(1);
    }
  }
});

// ======================== EMAIL TRANSPORTER CONFIGURATION ========================

// Configure email transporter using environment variables
const emailTransporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST || 'smtp.gmail.com',
  port: process.env.EMAIL_PORT || 587,
  secure: process.env.EMAIL_SECURE === 'true' || false,
  auth: {
    user: process.env.EMAIL_USER || '',
    pass: process.env.EMAIL_PASSWORD || '',
  },
});

// Verify email configuration
emailTransporter.verify((error, success) => {
  if (error) {
    console.warn('⚠️  Email transporter not configured or failed:', error.message);
    console.warn('Email notifications will not be sent.');
  } else {
    console.log('✅ Email transporter configured successfully');
  }
});

// ======================== UTILITY FUNCTIONS ========================

// Get current date in EST timezone (YYYY-MM-DD format)
// This ensures dates are created in Eastern Standard Time
function getLocalDateString() {
  const date = new Date();
  // Convert to EST (UTC-5) / EDT (UTC-4)
  const estDate = new Date(date.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const year = estDate.getFullYear();
  const month = String(estDate.getMonth() + 1).padStart(2, '0');
  const day = String(estDate.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// DISABLED: Cron jobs no longer needed - loan calculations are now done in real-time
// const cron = require('node-cron');

// // This cron job will run every day at midnight (00:00)
// cron.schedule('0 0 * * *', async () => {  
//   try {
//     const result = await pool.query(
//       'SELECT * FROM loans WHERE due_date < CURRENT_DATE AND status = $1',
//       ['active']
//     );

//     const loansDue = result.rows;

//     for (let loan of loansDue) {
//       const paymentResult = await pool.query(
//         'SELECT SUM(payment_amount) AS total_paid FROM payment_history WHERE loan_id = $1',
//         [loan.id]
//       );
//       const totalPaid = paymentResult.rows[0].total_paid || 0;

//       if (totalPaid >= loan.interest_amount) {
//         // Extend the due date by 30 days if interest is paid
//         const extendedDueDate = new Date(loan.due_date);
//         extendedDueDate.setDate(extendedDueDate.getDate() + 30);  // Extend by 30 days

//         await pool.query(
//           'UPDATE loans SET due_date = $1 WHERE id = $2 RETURNING *',
//           [extendedDueDate.toISOString().slice(0, 10), loan.id]
//         );
//       } else {
//         // If interest is not paid, mark the loan as overdue
//         await pool.query(
//           'UPDATE loans SET status = $1 WHERE id = $2 RETURNING *',
//           ['overdue', loan.id]
//         );
//       }
//     }
//   } catch (err) {
//     console.error('Error checking due date:', err);
//   }
// });

// // ======================== CRON JOB: SEND EMAIL REMINDERS FOR UPCOMING DUE DATES ========================
// // This cron job runs daily at 8:00 AM to send email reminders for customers with due dates within 7 days
// // DISABLED: No longer needed - loan calculations are done in real-time

// // cron.schedule('0 8 * * *', async () => {
// try {
//   console.log('🔔 Starting due date reminder email job...');
//   
//   // Calculate date range: today to 7 days from now
//   const today = new Date();
//   today.setHours(0, 0, 0, 0);
//   
//   const sevenDaysLater = new Date(today);
//   sevenDaysLater.setDate(sevenDaysLater.getDate() + 7);
//   sevenDaysLater.setHours(23, 59, 59, 999);

//   // Query for active loans with due dates within next 7 days
//   const result = await pool.query(
//     `SELECT l.*, c.first_name, c.last_name, c.email, c.mobile_phone
//      FROM loans l
//      JOIN customers c ON l.customer_id = c.id
//      WHERE l.status = $1 
//      AND l.due_date >= $2 
//      AND l.due_date <= $3
//      AND c.email IS NOT NULL
//      AND c.email != ''`,
//     ['active', today.toISOString().split('T')[0], sevenDaysLater.toISOString().split('T')[0]]
//   );

//   const loansUpcoming = result.rows;
//   console.log(`Found ${loansUpcoming.length} loans with due dates in next 7 days`);

//   // Send email for each loan
//   for (let loan of loansUpcoming) {
//     try {
//       // Calculate days until due date
//       const dueDate = new Date(loan.due_date);
//       const daysUntilDue = Math.ceil((dueDate - today) / (1000 * 60 * 60 * 24));

//       // Get payment history to calculate amount paid
//       const paymentResult = await pool.query(
//         'SELECT SUM(payment_amount) AS total_paid FROM payment_history WHERE loan_id = $1',
//         [loan.id]
//       );
//       const totalPaid = paymentResult.rows[0].total_paid || 0;
//       
//       // Calculate remaining balance
//       const remainingBalance = loan.interest_amount - totalPaid;

//       // Prepare email content
//       const customerName = `${loan.first_name} ${loan.last_name}`;
//       const emailSubject = `⏰ Loan Due Date Reminder - Your Loan is Due in ${daysUntilDue} Day${daysUntilDue !== 1 ? 's' : ''}`;
//       
//       const emailHTML = `
//         <!DOCTYPE html>
//         <html>
//           <head>
//             <style>
//               body { font-family: Arial, sans-serif; color: #333; line-height: 1.6; }
//               .container { max-width: 600px; margin: 0 auto; background-color: #f9f9f9; padding: 20px; border-radius: 8px; }
//               .header { background-color: #1a1a1a; color: #fff; padding: 20px; border-radius: 8px 8px 0 0; text-align: center; }
//               .content { background-color: #fff; padding: 20px; }
//               .loan-details { background-color: #f0f0f0; padding: 15px; border-radius: 5px; margin: 15px 0; }
//               .detail-row { display: flex; justify-content: space-between; margin: 8px 0; }
//               .detail-label { font-weight: bold; }
//               .footer { text-align: center; color: #666; font-size: 12px; margin-top: 20px; padding-top: 20px; border-top: 1px solid #ddd; }
//               .warning { color: #d32f2f; font-weight: bold; }
//               .important { background-color: #fff3cd; padding: 10px; border-radius: 5px; margin: 15px 0; border-left: 4px solid #ffc107; }
//             </style>
//           </head>
//           <body>
//             <div class="container">
//               <div class="header">
//                 <h1>🔔 Loan Due Date Reminder</h1>
//               </div>
//               <div class="content">
//                 <p>Dear ${customerName},</p>
//                 
//                 <p>This is a friendly reminder that your loan payment is due in <span class="warning">${daysUntilDue} day${daysUntilDue !== 1 ? 's' : ''}</span>.</p>
//                 
//                 <h3>📋 Loan Details:</h3>
//                 <div class="loan-details">
//                   <div class="detail-row">
//                     <span class="detail-label">Loan ID:</span>
//                     <span>${loan.id}</span>
//                   </div>
//                   <div class="detail-row">
//                     <span class="detail-label">Item Pawned:</span>
//                     <span>${loan.item_description || 'N/A'}</span>
//                   </div>
//                   <div class="detail-row">
//                     <span class="detail-label">Loan Amount:</span>
//                     <span>$${parseFloat(loan.loan_amount).toFixed(2)}</span>
//                   </div>
//                   <div class="detail-row">
//                     <span class="detail-label">Interest Amount:</span>
//                     <span>$${parseFloat(loan.interest_amount).toFixed(2)}</span>
//                   </div>
//                   <div class="detail-row">
//                     <span class="detail-label">Amount Paid:</span>
//                     <span>$${parseFloat(totalPaid).toFixed(2)}</span>
//                   </div>
//                   <div class="detail-row" style="font-weight: bold; border-top: 1px solid #ddd; padding-top: 8px; margin-top: 8px;">
//                     <span class="detail-label">Remaining Balance Due:</span>
//                     <span>$${parseFloat(remainingBalance).toFixed(2)}</span>
//                   </div>
//                   <div class="detail-row">
//                     <span class="detail-label">Due Date:</span>
//                     <span>${new Date(loan.due_date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</span>
//                   </div>
//                 </div>
//                 
//                 <div class="important">
//                   <strong>⚠️ Important:</strong> Please ensure payment is made by the due date to avoid additional fees or penalties. Your loan will be marked as overdue if not paid by ${new Date(loan.due_date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}.
//                 </div>
//                 
//                 <p>If you have any questions or need to make a payment, please contact us immediately at your earliest convenience.</p>
//                 
//                 <p>Thank you for your business!</p>
//                 
//                 <p style="color: #666; font-size: 14px;">Best regards,<br><strong>PawnFlow - Pawn Shop Management System</strong></p>
//               </div>
//               <div class="footer">
//                 <p>This is an automated reminder email. Please do not reply to this email. Contact the pawn shop directly for assistance.</p>
//               </div>
//             </div>
//           </body>
//         </html>
//       `;

//       // Send email
//       const mailOptions = {
//         from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
//         to: loan.email,
//         subject: emailSubject,
//         html: emailHTML,
//       };

//       await emailTransporter.sendMail(mailOptions);
//       console.log(`✅ Email sent to ${loan.email} for loan ID ${loan.id}`);

//     } catch (emailError) {
//       console.error(`❌ Failed to send email for loan ${loan.id}:`, emailError.message);
//     }
//   }

//   console.log('✅ Due date reminder email job completed');
// } catch (err) {
//   console.error('❌ Error in due date reminder email job:', err);
// }
// // });


// ======================== ADMIN SETTINGS INITIALIZATION ========================

// Initialize admin settings table on startup
const initializeAdminSettings = async () => {
  try {
    // Create admin_settings table if it doesn't exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS admin_settings (
        id SERIAL PRIMARY KEY,
        admin_password VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        changed_by VARCHAR(255),
        change_reason VARCHAR(500)
      )
    `);

    // Check if admin password exists
    const result = await pool.query('SELECT COUNT(*) as count FROM admin_settings');
    const count = parseInt(result.rows[0].count, 10);

    if (count === 0) {
      // Hash the default password using bcrypt
      const defaultPassword = 'pawnflowniran!@#12';
      const hashedPassword = await bcrypt.hash(defaultPassword, 10);
      
      // Insert default admin password
      await pool.query(
        `INSERT INTO admin_settings (admin_password, changed_by, change_reason)
         VALUES ($1, $2, $3)`,
        [hashedPassword, 'system', 'Initial setup - default password']
      );
      
      console.log('✅ Admin settings initialized with default password');
    } else {
      console.log('✅ Admin settings already initialized');
    }
  } catch (err) {
    console.error('❌ Error initializing admin settings:', err.message);
  }
};

// Call initialization on server startup
initializeAdminSettings();

// ======================== MIDDLEWARE DEFINITIONS ========================

// Verify JWT token and extract user info
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    console.warn('⚠️  Unauthorized access attempt - no token provided');
    return res.status(401).json({ message: 'Access denied. No token provided.' });
  }

  try {
    // Use the configured JWT_SECRET from app startup, not environment variable
    if (!JWT_SECRET || JWT_SECRET.length < 32) {
      console.error('❌ JWT_SECRET not properly configured');
      return res.status(500).json({ message: 'Server configuration error' });
    }
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    console.log(`✅ Token verified for user ID: ${decoded.user_id || decoded.id}`);
    next();
  } catch (err) {
    console.warn('⚠️  Invalid token:', err.message);
    return res.status(403).json({ message: 'Invalid or expired token' });
  }
};

// Check if user has admin or manager role
const authorizeRole = (...allowedRoles) => {
  return (req, res, next) => {
    // For now, we'll allow all authenticated users to access reports
    // In production, you might check req.user.role against allowedRoles
    if (!req.user) {
      return res.status(401).json({ message: 'User not authenticated' });
    }
    
    // Log the access
    console.log(`📊 Report access by user ${req.user.id} to ${req.path}`);
    next();
  };
};

// Check if user has an active shift - required for all loan/payment activities
const requireActiveShift = async (req, res, next) => {
  try {
    const userId = req.user?.user_id || req.user?.id;
    
    if (!userId) {
      return res.status(401).json({ message: 'User not authenticated' });
    }

    // Check if user has an active shift (shift_end_time is NULL)
    const shiftCheck = await pool.query(
      'SELECT id, shift_start_time, shift_end_time FROM shift_management WHERE user_id = $1 AND shift_end_time IS NULL ORDER BY id DESC LIMIT 1',
      [userId]
    );

    if (shiftCheck.rows.length === 0) {
      // Debug: Log recent shifts to understand why none are active
      const recentShifts = await pool.query(
        'SELECT id, shift_start_time, shift_end_time FROM shift_management WHERE user_id = $1 ORDER BY id DESC LIMIT 3',
        [userId]
      );
      console.warn(`⚠️  No active shift for user ${userId}. Recent shifts:`, recentShifts.rows);
      
      return res.status(403).json({ 
        message: 'No active shift. Please start a shift before performing any activities.',
        code: 'NO_ACTIVE_SHIFT'
      });
    }

    console.log(`✅ Active shift verified for user ${userId} - Shift ID: ${shiftCheck.rows[0].id}, Started: ${shiftCheck.rows[0].shift_start_time}`);
    next();
  } catch (err) {
    console.error('Error checking active shift:', err);
    res.status(500).json({ message: 'Error verifying shift status' });
  }
};

// ======================== END MIDDLEWARE DEFINITIONS ========================




// ---------------------------- REGISTER ----------------------------
app.post('/register', async (req, res) => {
  const { username, password } = req.body;

  try {
    // Validate input
    if (!username || !password) {
      return res.status(400).json({ message: 'Username and password are required' });
    }

    if (username.length < 3) {
      return res.status(400).json({ message: 'Username must be at least 3 characters long' });
    }

    if (password.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters long' });
    }

    // Add stronger password validation to prevent weak passwords
    if (!/[A-Z]/.test(password)) {
      return res.status(400).json({ message: 'Password must contain at least one uppercase letter' });
    }
    if (!/[0-9]/.test(password)) {
      return res.status(400).json({ message: 'Password must contain at least one number' });
    }

    // Prevent empty or whitespace-only usernames
    if (!username || username.trim().length === 0) {
      return res.status(400).json({ message: 'Username cannot be empty or whitespace' });
    }

    // Check if user already exists
    const existingUser = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (existingUser.rows.length > 0) {
      return res.status(400).json({ message: 'Username already exists' });
    }

    // Hash password and create user
    const hashedPassword = await bcrypt.hash(password, 10);

    console.log('📝 Attempting to register user:', username);
    
    // Find first available role ID (sorted ascending, so we get the lowest available)
    const rolesResult = await pool.query('SELECT id FROM user_roles ORDER BY id ASC LIMIT 1');
    let roleId = 1; // Default fallback to admin role
    
    if (rolesResult.rows.length > 0) {
      roleId = rolesResult.rows[0].id;
    }
    
    console.log(`Using role_id: ${roleId}`);
    
    const result = await pool.query(
      `INSERT INTO users (username, password, role_id) 
       VALUES ($1, $2, $3)
       RETURNING id, username, role_id`,
      [username, hashedPassword, roleId]
    );

    console.log('✅ New user registered:', { id: result.rows[0].id, username: result.rows[0].username, role_id: roleId });
    res.status(201).json({ message: 'User registered successfully', user: result.rows[0] });
  } catch (err) {
    console.error('❌ Registration error:', err.message);
    console.error('Error details:', err);
    res.status(500).json({ message: `Error creating user: ${err.message}` });
  }
});

// ---------------------------- LOGIN ----------------------------
app.post('/login', async (req, res) => {
  const { username, password } = req.body;

  try {
    console.log(`🔐 Login attempt for username: ${username}`);
    
    // Check if users table exists
    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'users'
      ) AS table_exists
    `);
    
    if (!tableCheck.rows[0].table_exists) {
      console.error('❌ Users table does not exist!');
      return res.status(500).json({ 
        message: 'Database not initialized - users table missing',
        error: 'Users table does not exist'
      });
    }
    
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);

    const user = result.rows[0];
    if (!user) {
      console.warn(`⚠️ Login failed - user not found: ${username}`);
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      console.warn(`⚠️ Login failed - password mismatch for user: ${username}`);
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    console.log(`✅ Login successful for user: ${username}`);
    
    const token = jwt.sign({ id: user.id, role: user.role_id }, JWT_SECRET, { expiresIn: '24h' });

    res.json({ 
      token,
      id: user.id,
      username: user.username,
      role: user.role_id
    });
  } catch (err) {
    console.error(`❌ Login error for ${username}:`, err.message);
    console.error('Error details:', err);
    console.error('Error stack:', err.stack);
    res.status(500).json({ 
      message: 'Error logging in',
      error: err.message,
      details: process.env.NODE_ENV === 'development' ? err.stack : undefined 
    });
  }
});

// ======================== ADMIN PANEL ENDPOINTS ========================

// GET ALL ACCOUNTS - Get list of all registered users
app.get('/all-accounts', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, username, role_id as role, created_at 
       FROM users 
       ORDER BY created_at DESC`
    );

    // Map role_id to role names
    const accounts = result.rows.map(user => ({
      ...user,
      role: user.role === 1 ? 'admin' : 'employee'
    }));

    res.json(accounts);
  } catch (err) {
    console.error('❌ Error fetching accounts:', err);
    res.status(500).json({ message: 'Error fetching accounts' });
  }
});

// DELETE ACCOUNT - Delete a user account
app.delete('/delete-account/:userId', async (req, res) => {
  const { userId } = req.params;

  try {
    const userIdNum = parseInt(userId, 10);

    if (isNaN(userIdNum)) {
      return res.status(400).json({ message: 'Invalid user ID' });
    }

    // Prevent deleting if user has active shifts
    const shiftCheck = await pool.query(
      'SELECT * FROM shift_management WHERE user_id = $1 AND shift_end_time IS NULL',
      [userIdNum]
    );

    if (shiftCheck.rows.length > 0) {
      return res.status(400).json({ message: 'Cannot delete user with active shift' });
    }

    // Delete the user
    const result = await pool.query(
      'DELETE FROM users WHERE id = $1 RETURNING username',
      [userIdNum]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }

    console.log(`✅ User deleted: ${result.rows[0].username}`);
    res.json({ message: 'Account deleted successfully', username: result.rows[0].username });
  } catch (err) {
    console.error('❌ Error deleting account:', err);
    res.status(500).json({ message: 'Error deleting account' });
  }
});

// VERIFY ADMIN PASSWORD - Check if provided password is correct
app.post('/verify-admin-password', async (req, res) => {
  const { password } = req.body;

  try {
    if (!password) {
      return res.status(400).json({ message: 'Password is required' });
    }

    // Get the stored admin password
    const result = await pool.query(
      'SELECT admin_password FROM admin_settings LIMIT 1'
    );

    if (result.rows.length === 0) {
      return res.status(500).json({ message: 'Admin settings not configured' });
    }

    const storedHash = result.rows[0].admin_password;

    // Compare provided password with stored hash
    const isMatch = await bcrypt.compare(password, storedHash);

    if (isMatch) {
      res.json({ message: 'Password verified', verified: true });
    } else {
      res.status(401).json({ message: 'Incorrect password', verified: false });
    }
  } catch (err) {
    console.error('❌ Error verifying admin password:', err);
    res.status(500).json({ message: 'Error verifying password' });
  }
});

// UPDATE ADMIN PASSWORD - Change the admin panel password
app.post('/update-admin-password', async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  try {
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: 'Current and new passwords are required' });
    }

    // Validate new password
    if (newPassword.length < 8) {
      return res.status(400).json({ message: 'New password must be at least 8 characters' });
    }

    if (!/[A-Z]/.test(newPassword)) {
      return res.status(400).json({ message: 'Password must contain at least one uppercase letter' });
    }

    if (!/[0-9]/.test(newPassword)) {
      return res.status(400).json({ message: 'Password must contain at least one number' });
    }

    // Get the stored admin password
    const result = await pool.query(
      'SELECT admin_password FROM admin_settings LIMIT 1'
    );

    if (result.rows.length === 0) {
      return res.status(500).json({ message: 'Admin settings not configured' });
    }

    const storedHash = result.rows[0].admin_password;

    // Verify current password
    const isMatch = await bcrypt.compare(currentPassword, storedHash);
    if (!isMatch) {
      return res.status(401).json({ message: 'Current password is incorrect' });
    }

    // Hash the new password
    const newHash = await bcrypt.hash(newPassword, 10);

    // Update the password
    await pool.query(
      `UPDATE admin_settings 
       SET admin_password = $1, updated_at = CURRENT_TIMESTAMP, changed_by = $2, change_reason = $3
       WHERE id = (SELECT id FROM admin_settings LIMIT 1)`,
      [newHash, 'admin', 'Manual change via admin panel']
    );

    console.log('✅ Admin password updated successfully');
    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    console.error('❌ Error updating admin password:', err);
    res.status(500).json({ message: 'Error updating password' });
  }
});

// UPDATE USER ROLE - Change a user's role (admin or employee)
app.put('/change-user-role/:userId', async (req, res) => {
  const { userId } = req.params;
  const { role } = req.body;

  try {
    const userIdNum = parseInt(userId, 10);

    if (isNaN(userIdNum)) {
      return res.status(400).json({ message: 'Invalid user ID' });
    }

    if (!role || (role !== 'admin' && role !== 'employee')) {
      return res.status(400).json({ message: 'Invalid role. Must be "admin" or "employee"' });
    }

    // Convert role to role_id
    const roleId = role === 'admin' ? 1 : 2;

    // Update the user's role
    const result = await pool.query(
      'UPDATE users SET role_id = $1 WHERE id = $2 RETURNING id, username, role_id',
      [roleId, userIdNum]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }

    console.log(`✅ User role updated: ${result.rows[0].username} -> ${role}`);
    res.json({ message: 'User role updated successfully', user: result.rows[0] });
  } catch (err) {
    console.error('❌ Error updating user role:', err);
    res.status(500).json({ message: 'Error updating user role' });
  }
});

// ======================== END ADMIN PANEL ENDPOINTS ========================

// EXTEND LOAN DUE DATE ----------------------------
app.post('/extend-loan', async (req, res) => {
  const { loanId } = req.body;

  try {
    // Fetch the loan details
    const loanResult = await pool.query('SELECT * FROM loans WHERE id = $1', [loanId]);
    const loan = loanResult.rows[0];

    if (!loan) {
      return res.status(404).json({ message: 'Loan not found' });
    }

    const currentDate = new Date();
    const dueDate = new Date(loan.due_date);

    // Check if due date has passed
    if (currentDate > dueDate) {
      // Check if at least interest amount has been paid
      const paymentResult = await pool.query(
        'SELECT SUM(payment_amount) AS total_paid FROM payment_history WHERE loan_id = $1',
        [loanId]
      );
      const totalPaid = paymentResult.rows[0].total_paid || 0;

      if (totalPaid >= loan.interest_amount) {
        // Extend the due date by 30 days and add new interest
        dueDate.setDate(dueDate.getDate() + 30);

        // Update the loan with the new due date
        const updateQuery = `
          UPDATE loans
          SET due_date = $1
          WHERE id = $2
          RETURNING *;
        `;
        const updatedLoan = await pool.query(updateQuery, [dueDate, loanId]);

        res.status(200).json({
          message: 'Loan extended by 30 days!',
          loan: updatedLoan.rows[0],
        });
      } else {
        res.status(400).json({ message: 'Interest not paid, cannot extend loan.' });
      }
    } else {
      res.status(400).json({ message: 'Due date has not passed, no need to extend.' });
    }
  } catch (err) {
    console.error('Error extending loan:', err);
    res.status(500).json({ message: 'Error extending loan' });
  }
});



// ---------------------------- ADD MONEY TO LOAN ----------------------------
app.post('/add-money', async (req, res) => {
  const { loanId, amount } = req.body;

  try {
    // Get current loan details
    const loanResult = await pool.query('SELECT * FROM loans WHERE id = $1', [loanId]);
    const loan = loanResult.rows[0];

    if (!loan) {
      return res.status(404).json({ message: 'Loan not found' });
    }

    // Get total payments made so far
    const paymentsResult = await pool.query(
      'SELECT SUM(payment_amount) AS total_paid FROM payment_history WHERE loan_id = $1',
      [loanId]
    );
    const totalPaid = paymentsResult.rows[0].total_paid || 0;

    // Update loan amount, recalculate interest, and total payable amount
    // NOTE: initial_loan_amount stays the same to prevent affecting cash balance checks
    const newLoanAmount = parseFloat(loan.loan_amount) + parseFloat(amount);
    const newInterestAmount = (newLoanAmount * parseFloat(loan.interest_rate)) / 100;
    const newTotalPayableAmount = newLoanAmount + newInterestAmount;
    const newRemainingBalance = newTotalPayableAmount - totalPaid;

    // Update loan details in the database
    const updateLoanResult = await pool.query(
      'UPDATE loans SET loan_amount = $1, interest_amount = $2, total_payable_amount = $3, remaining_balance = $4 WHERE id = $5 RETURNING *',
      [
        newLoanAmount,
        newInterestAmount,
        newTotalPayableAmount,
        newRemainingBalance,
        loanId
      ]
    );

    res.status(200).json({
      message: 'Money added successfully and loan recalculated',
      loan: updateLoanResult.rows[0],
    });
  } catch (err) {
    console.error('Error adding money:', err);
    res.status(500).json({ message: 'Error adding money to the loan' });
  }
});



// ---------------------------- CHECK DUE DATE ----------------------------

app.post('/check-due-date', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM loans WHERE due_date < CURRENT_DATE AND status = $1',
      ['active']
    );

    const loansDue = result.rows;

    for (let loan of loansDue) {
      const paymentResult = await pool.query(
        'SELECT SUM(payment_amount) AS total_paid FROM payment_history WHERE loan_id = $1',
        [loan.id]
      );
      const totalPaid = paymentResult.rows[0].total_paid || 0;

      if (totalPaid >= loan.interest_amount) {
        // If interest is paid, extend due date by 30 days
        const extendedDueDate = new Date(loan.due_date);
        extendedDueDate.setDate(extendedDueDate.getDate() + 30);

        await pool.query(
          'UPDATE loans SET due_date = $1 WHERE id = $2 RETURNING *',
          [extendedDueDate.toISOString().slice(0, 10), loan.id]
        );
      } else {
        // If interest is not paid, mark the loan as overdue
        await pool.query(
          'UPDATE loans SET status = $1 WHERE id = $2 RETURNING *',
          ['overdue', loan.id]
        );
      }
    }

    res.status(200).json({ message: 'Due date check completed successfully' });
  } catch (err) {
    console.error('Error checking due date:', err);
    res.status(500).json({ message: 'Error checking due date' });
  }
});

// ---------------------------- PAYMENT HISTORY ----------------------------

// ---------------------------- PAYMENT HISTORY ----------------------------
// ---------------------------- PAYMENT HISTORY ----------------------------
app.get('/payment-history', async (req, res) => {
  const { loanId } = req.query;  // Expect loanId as a query parameter

  try {
    // Check if loanId is provided
    if (!loanId || loanId.trim() === '') {
      return res.status(400).json({ message: 'Loan ID is required' });
    }

    // Validate that loanId is a valid number
    const parsedLoanId = parseInt(loanId, 10);
    if (isNaN(parsedLoanId)) {
      return res.status(400).json({ message: 'Loan ID must be a valid number' });
    }

    // Query the payment history for the specified loan
    const result = await pool.query(
      'SELECT * FROM payment_history WHERE loan_id = $1 ORDER BY payment_date DESC',
      [parsedLoanId]
    );

    // If no payments found, return an empty array instead of throwing a 404 error
    if (result.rows.length === 0) {
      return res.json([]);  // Return an empty array
    }

    // Return the payment history
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching payment history:', err);
    res.status(500).json({ message: 'Error fetching payment history', error: err.message });
  }
});








// ---------------------------- CREATE LOAN ----------------------------
app.post('/create-loan', authenticateToken, requireActiveShift, async (req, res) => {
  try {
    // Map request body (handles both camelCase and snake_case)
    const mapped = validators.mapRequestToDb(req.body);
    
    console.log('📝 [/create-loan] Mapped request body:');
    console.log('   first_name:', mapped.first_name);
    console.log('   last_name:', mapped.last_name);
    console.log('   email:', mapped.email);

    // Extract all customer and loan fields
    const {
      first_name,
      last_name,
      email,
      home_phone,
      mobile_phone,
      birthdate,
      id_type,
      id_number,
      referral,
      identification_info,
      street_address,
      city,
      state,
      zipcode,
      customer_number,
      loan_amount: loanAmount,
      interest_rate: interestRate,
      interest_amount: inputInterestAmount,
      total_payable_amount: inputTotalPayableAmount,
      recurring_fee: recurringFee,
      item_category,
      item_description,
      collateral_description,
      customer_note,
      collateral_image,
      loan_issued_date: loanIssuedDate,
      due_date: inputDueDate,
      loan_term: loanTerm,
      transaction_number: inputTransactionNumber,
      previous_loan_amount: previousLoanAmount,
      user_id: userId,
      created_by_user_id: createdByUserId,
      created_by_username: createdByUsername,
    } = mapped;

    // Validate required customer fields
    const nameValidation = validators.validateNames(first_name, last_name);
    if (!nameValidation.valid) {
      return res.status(400).json({ message: nameValidation.error });
    }

    // Validate loan amounts
    const amountValidation = validators.validateLoanAmounts(loanAmount, interestRate, loanTerm);
    if (!amountValidation.valid) {
      return res.status(400).json({ message: amountValidation.error });
    }

    // Validate optional customer fields
    const customerFieldsValidation = validators.validateCustomerFields({
      email,
      home_phone,
      mobile_phone,
      birthdate,
      loan_issued_date: loanIssuedDate,
      due_date: inputDueDate,
    });

    if (!customerFieldsValidation.valid) {
      return res.status(400).json({ 
        message: 'Validation failed', 
        errors: customerFieldsValidation.errors 
      });
    }

    // Calculate loan totals
    const totalLoanAmount = parseFloat(previousLoanAmount || 0) + parseFloat(loanAmount);
    const calculatedInterestAmount = parseFloat(inputInterestAmount) || 
      (totalLoanAmount * parseFloat(interestRate)) / 100;
    const calculatedRecurringFee = parseFloat(recurringFee) || 0;
    const calculatedTotalPayableAmount = parseFloat(inputTotalPayableAmount) || 
      (totalLoanAmount + calculatedInterestAmount + calculatedRecurringFee);

    // Calculate or use provided due date
    let dueDate;
    if (inputDueDate) {
      dueDate = inputDueDate;
    } else {
      const issued = new Date(loanIssuedDate || new Date());
      const due = new Date(issued);
      due.setDate(due.getDate() + parseInt(loanTerm));
      dueDate = due.toISOString().slice(0, 10);
    }

    // Generate or use provided transaction number
    const transactionNumber = inputTransactionNumber || Math.floor(Math.random() * 1000000000).toString();

    // Step 1: Find or create customer
    let customerId = null;
    
    // Try to find existing customer by email (most reliable)
    if (email) {
      const existingCustomer = await pool.query(
        'SELECT id FROM customers WHERE LOWER(email) = LOWER($1) LIMIT 1',
        [email]
      );
      if (existingCustomer.rows.length > 0) {
        customerId = existingCustomer.rows[0].id;
        console.log('✅ Found existing customer by email:', customerId);
      }
    }
    
    // If not found by email, try mobile phone
    if (!customerId && mobile_phone) {
      const existingCustomer = await pool.query(
        'SELECT id FROM customers WHERE mobile_phone = $1 LIMIT 1',
        [mobile_phone]
      );
      if (existingCustomer.rows.length > 0) {
        customerId = existingCustomer.rows[0].id;
        console.log('✅ Found existing customer by mobile phone:', customerId);
      }
    }

    // If customer not found, create a new one
    if (!customerId) {
      console.log('📝 Creating new customer for loan...');
      const newCustomer = await pool.query(
        `INSERT INTO customers (
          first_name, last_name, email, home_phone, mobile_phone, birthdate,
          id_type, id_number, referral, identification_info, street_address, city, state, zipcode,
          customer_number, created_by_user_id, created_by_username
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        RETURNING id`,
        [
          first_name,
          last_name,
          email || null,
          home_phone || null,
          mobile_phone || null,
          birthdate || null,
          id_type || null,
          id_number || null,
          referral || null,
          identification_info || null,
          street_address || null,
          city || null,
          state || null,
          zipcode || null,
          customer_number || null,
          createdByUserId || userId || null,
          createdByUsername || null
        ]
      );
      customerId = newCustomer.rows[0].id;
      console.log('✅ Created new customer:', customerId);
    }

    // Step 2: Insert loan with customer_id
    const generatedCustomerName = `${first_name} ${last_name}`;
    console.log('✅ Inserting loan with customer_name:', generatedCustomerName);
    
    const result = await pool.query(
      `INSERT INTO loans (
        customer_id, first_name, last_name, email, home_phone, mobile_phone, birthdate,
        id_type, id_number, referral, identification_info, street_address, city, state, zipcode,
        customer_number, loan_amount, initial_loan_amount, interest_rate, interest_amount, total_payable_amount, recurring_fee,
        item_category, item_description, collateral_description, customer_note, collateral_image, transaction_number,
        loan_issued_date, loan_term, due_date,
        status, remaining_balance, created_by, created_by_user_id, created_by_username, customer_name
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37)
      RETURNING *`,
      [
        customerId,
        first_name,
        last_name,
        email || null,
        home_phone || null,
        mobile_phone || null,
        birthdate || null,
        id_type || null,
        id_number || null,
        referral || null,
        identification_info || null,
        street_address || null,
        city || null,
        state || null,
        zipcode || null,
        customer_number || null,
        totalLoanAmount,
        totalLoanAmount,
        interestRate,
        calculatedInterestAmount,
        calculatedTotalPayableAmount,
        calculatedRecurringFee,
        item_category || null,
        item_description || null,
        collateral_description || null,
        customer_note || null,
        collateral_image || null,
        transactionNumber,
        loanIssuedDate || getLocalDateString(),
        loanTerm,
        dueDate,
        'active',
        calculatedTotalPayableAmount,
        userId || createdByUserId || null,
        createdByUserId || userId || null,
        createdByUsername || null,
        generatedCustomerName
      ]
    );

    const loan = result.rows[0]; // Bypass formatter for now

    res.status(201).json({ 
      loan,
      pdf_url: `/loan-pdf/${result.rows[0].id}`
    });
  } catch (err) {
    console.error('Error creating loan:', err);
    res.status(500).json({ message: 'Error creating loan', error: err.message });
  }
});



// ---------------------------- SEARCH LOAN ----------------------------
app.get('/search-loan', async (req, res) => {
  try {
    // Accept both camelCase and snake_case query parameters
    const firstName = req.query.firstName || req.query.first_name;
    const lastName = req.query.lastName || req.query.last_name;
    const customerNumber = req.query.customerNumber || req.query.customer_number;
    const email = req.query.email;
    const transactionNumber = req.query.transactionNumber || req.query.transaction_number;
    const mobilePhone = req.query.mobilePhone || req.query.mobile_phone;
    const homePhone = req.query.homePhone || req.query.home_phone;
    const customerName = req.query.customerName || req.query.customer_name;
    const city = req.query.city;
    const state = req.query.state;
    const zipcode = req.query.zipcode;

    // Build dynamic query
    let query = 'SELECT * FROM loans WHERE 1=1';
    const params = [];
    let paramIndex = 1;

    // Search by first name
    if (firstName) {
      params.push(`%${firstName}%`);
      query += ` AND first_name ILIKE $${paramIndex}`;
      paramIndex++;
    }

    // Search by last name
    if (lastName) {
      params.push(`%${lastName}%`);
      query += ` AND last_name ILIKE $${paramIndex}`;
      paramIndex++;
    }

    // Search by customer number
    if (customerNumber) {
      params.push(`%${customerNumber}%`);
      query += ` AND customer_number ILIKE $${paramIndex}`;
      paramIndex++;
    }

    // Search by email
    if (email) {
      params.push(`%${email}%`);
      query += ` AND email ILIKE $${paramIndex}`;
      paramIndex++;
    }

    // Search by transaction number (exact match)
    if (transactionNumber) {
      params.push(transactionNumber);
      query += ` AND transaction_number = $${paramIndex}`;
      paramIndex++;
    }

    // Search by mobile phone
    if (mobilePhone) {
      params.push(`%${mobilePhone}%`);
      query += ` AND mobile_phone ILIKE $${paramIndex}`;
      paramIndex++;
    }

    // Search by home phone
    if (homePhone) {
      params.push(`%${homePhone}%`);
      query += ` AND home_phone ILIKE $${paramIndex}`;
      paramIndex++;
    }

    // Search by city
    if (city) {
      params.push(`%${city}%`);
      query += ` AND city ILIKE $${paramIndex}`;
      paramIndex++;
    }

    // Search by state
    if (state) {
      params.push(`%${state}%`);
      query += ` AND state ILIKE $${paramIndex}`;
      paramIndex++;
    }

    // Search by zipcode
    if (zipcode) {
      params.push(`%${zipcode}%`);
      query += ` AND zipcode ILIKE $${paramIndex}`;
      paramIndex++;
    }

    // Fallback: search by full customer_name (backward compatibility)
    if (customerName && !firstName && !lastName) {
      params.push(`%${customerName}%`);
      query += ` AND customer_name ILIKE $${paramIndex}`;
      paramIndex++;
    }

    // If no search criteria provided, return error
    if (params.length === 0) {
      return res.status(400).json({ message: 'At least one search criteria is required' });
    }

    // Execute query
    const result = await pool.query(query, params);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'No loans found' });
    }

    // Format response with snake_case fields, add PDF links, and calculate dynamic state
    const formattedLoans = await Promise.all(result.rows.map(async (loan) => {
      try {
        // Simple calculation: Principal + Monthly Interest
        const calculatedBalance = getSimpleRemainingBalance(loan);
        
        // Return formatted loan with calculated values
        return {
          ...validators.formatLoanResponse(loan),
          pdf_url: `/loan-pdf/${loan.id}`,
          remaining_balance: calculatedBalance,
          interest_accrued: (calculatedBalance - parseFloat(loan.loan_amount || 0)).toFixed(2)
        };
      } catch (err) {
        console.warn(`Could not format loan ${loan.id}:`, err.message);
        // Return loan with original values if formatting fails
        return {
          ...validators.formatLoanResponse(loan),
          pdf_url: `/loan-pdf/${loan.id}`
        };
      }
    }));

    res.json(formattedLoans);
  } catch (err) {
    console.error('Error searching loans:', err);
    res.status(500).json({ message: 'Error searching loans', error: err.message });
  }
});


// ---------------------------- MAKE PAYMENT ----------------------------
app.post('/make-payment', authenticateToken, requireActiveShift, async (req, res) => {
  const { loanId, paymentMethod, paymentAmount, userId } = req.body;

  let client;
  try {
    // Validate inputs
    if (!loanId || !paymentAmount || parseFloat(paymentAmount) <= 0) {
      return res.status(400).json({ message: 'Valid loan ID and payment amount required' });
    }

    // Use transaction for safety
    client = await pool.connect();
    await client.query('BEGIN');

    // Fetch the loan details with row locking
    const loanResult = await client.query('SELECT * FROM loans WHERE id = $1 FOR UPDATE', [loanId]);
    const loan = loanResult.rows[0];

    if (!loan) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Loan not found' });
    }

    const payment = parseFloat(paymentAmount);
    const method = paymentMethod || 'cash';
    const paymentDate = new Date();

    console.log(`\n💳 AUTO-EXTEND PAYMENT ENDPOINT - Loan ${loanId}, Payment: $${payment.toFixed(2)}`);

    // Process payment with auto-extend logic
    const paymentResult = processPaymentWithAutoExtend(loan, payment, paymentDate);

    console.log(`   Auto-extend triggered: ${paymentResult.autoExtendTriggered}`);
    console.log(`   New due date: ${paymentResult.newDueDate}`);
    console.log(`   New remaining balance: $${paymentResult.finalRemainingBalance.toFixed(2)}`);

    // Update the loan with new calculated values using transaction
    const updatedLoanResult = await client.query(
      `UPDATE loans SET 
        loan_amount = $1,
        remaining_balance = $2, 
        interest_amount = $3, 
        due_date = $4, 
        status = $5,
        total_payable_amount = $6,
        interest_paid_this_cycle = $7,
        extended_this_cycle = $8,
        last_extended_at = CASE WHEN $8 = true THEN CURRENT_TIMESTAMP ELSE last_extended_at END,
        updated_at = CURRENT_TIMESTAMP
       WHERE id = $9 RETURNING *`,
      [
        paymentResult.newPrincipal,
        paymentResult.finalRemainingBalance,
        paymentResult.newInterestAmount,
        paymentResult.newDueDate,
        paymentResult.newStatus,
        paymentResult.finalRemainingBalance,
        paymentResult.newInterestPaidThisCycle,
        paymentResult.newExtendedThisCycle,
        loanId
      ]
    );

    // Insert payment history within same transaction
    const paymentHistoryResult = await client.query(
      'INSERT INTO payment_history (loan_id, payment_method, payment_amount, payment_date, created_by) VALUES ($1, $2, $3, CURRENT_TIMESTAMP, $4) RETURNING *',
      [loanId, method, payment, userId || null]
    );

    // Commit transaction
    await client.query('COMMIT');

    // Generate receipt PDF (outside transaction)
    let receiptPDF = null;
    try {
      const updatedLoan = updatedLoanResult.rows[0];
      const pdfBuffer = await generateLoanPDF(updatedLoan);
      receiptPDF = pdfBuffer.toString('base64');
      console.log('✅ Receipt PDF generated');
    } catch (pdfError) {
      console.warn('⚠️ PDF generation failed:', pdfError.message);
    }

    // Build response based on result
    let responseMessage = paymentResult.message || 'Payment successfully processed!';
    
    if (paymentResult.finalRemainingBalance === 0) {
      responseMessage = '🎉 Loan fully paid off and automatically redeemed!';
    } else if (paymentResult.autoExtendTriggered) {
      responseMessage = `✅ ${paymentResult.message}`;
    }

    res.status(200).json({
      message: responseMessage,
      loan: updatedLoanResult.rows[0],
      paymentHistory: paymentHistoryResult.rows[0],
      receiptPDF: receiptPDF,
      paymentDetails: {
        paymentAmount: payment.toFixed(2),
        autoExtendTriggered: paymentResult.autoExtendTriggered,
        autoExtendMessage: paymentResult.autoExtendTriggered ? 'Interest-only payment triggered auto-extension' : 'No auto-extension',
        newPrincipal: paymentResult.newPrincipal.toFixed(2),
        newInterestAmount: paymentResult.newInterestAmount.toFixed(2),
        newRemainingBalance: paymentResult.finalRemainingBalance.toFixed(2),
        newDueDate: paymentResult.newDueDate,
        newStatus: paymentResult.newStatus,
        interestPaidThisCycle: paymentResult.newInterestPaidThisCycle.toFixed(2),
        extendedThisCycle: paymentResult.newExtendedThisCycle
      }
    });
  } catch (err) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        console.error('Error rolling back transaction:', rollbackErr);
      }
    }
    console.error('❌ Error making payment:', err);
    res.status(500).json({ message: 'Error making payment', error: err.message });
  } finally {
    if (client) {
      client.release();
    }
  }
});

// ======================== LOAN STATE CALCULATION ========================

/**
 * Calculate Loan State - POST /api/loans/calculate-state
 * 
 * Calculates dynamic loan state based on:
 * - Original loan data
 * - Payment history
 * - Current date
 */
app.post('/api/loans/calculate-state', async (req, res) => {
  try {
    const { loan, payments = [], currentDate } = req.body;

    if (!loan) {
      return res.status(400).json({ 
        message: 'loan object is required in request body' 
      });
    }

    if (!loan.loan_amount || loan.interest_rate === undefined) {
      return res.status(400).json({ 
        message: 'loan must contain loan_amount and interest_rate' 
      });
    }

    if (!loan.created_at && !loan.issued_date) {
      return res.status(400).json({ 
        message: 'loan must contain either created_at or issued_date' 
      });
    }

    if (!loan.due_date) {
      return res.status(400).json({ 
        message: 'loan must contain due_date' 
      });
    }

    // Calculate loan state
    const loanState = calculateLoanState(
      loan,
      payments,
      currentDate ? new Date(currentDate) : new Date()
    );

    res.json(loanState);
  } catch (err) {
    console.error('❌ Error calculating loan state:', err);
    res.status(400).json({ 
      message: 'Error calculating loan state',
      error: err.message 
    });
  }
});

/**
 * Get Loan State - GET /api/loans/:loanId/calculate-state
 * 
 * Fetches loan and payment history from database and calculates state
 */
app.get('/api/loans/:loanId/calculate-state', async (req, res) => {
  try {
    const { loanId } = req.params;
    const { currentDate } = req.query;

    const loanIdNum = parseInt(loanId, 10);
    if (isNaN(loanIdNum)) {
      return res.status(400).json({ message: 'Invalid loan ID' });
    }

    // Fetch loan from database
    const loanResult = await pool.query(
      'SELECT * FROM loans WHERE id = $1',
      [loanIdNum]
    );

    if (loanResult.rows.length === 0) {
      return res.status(404).json({ message: 'Loan not found' });
    }

    const loan = loanResult.rows[0];

    // Fetch payment history for this loan
    const paymentsResult = await pool.query(
      'SELECT payment_amount, payment_date FROM payment_history WHERE loan_id = $1 ORDER BY payment_date ASC',
      [loanIdNum]
    );

    // Calculate loan state
    const loanState = calculateLoanState(
      loan,
      paymentsResult.rows,
      currentDate ? new Date(currentDate) : new Date()
    );

    res.json({
      loan: {
        id: loan.id,
        transaction_number: loan.transaction_number,
        customer_name: loan.customer_name,
        loan_amount: loan.loan_amount,
        interest_rate: loan.interest_rate,
        created_at: loan.created_at,
        due_date: loan.due_date,
        status: loan.status
      },
      state: loanState
    });
  } catch (err) {
    console.error('❌ Error calculating loan state:', err);
    res.status(500).json({ 
      message: 'Error calculating loan state',
      error: err.message 
    });
  }
});

// ======================== END LOAN STATE CALCULATION ========================

// Debug endpoint to check loan details
app.get('/debug/loan/:loanId', async (req, res) => {
  try {
    const { loanId } = req.params;
    const result = await pool.query('SELECT * FROM loans WHERE id = $1', [loanId]);
    const loan = result.rows[0];
    
    if (!loan) {
      return res.status(404).json({ message: 'Loan not found' });
    }
    
    // Calculate if overdue
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const dueDate = new Date(loan.due_date);
    dueDate.setHours(0, 0, 0, 0);
    
    const isOverdue = dueDate < today;
    const daysOverdue = Math.floor((today - dueDate) / (1000 * 60 * 60 * 24));
    
    res.json({
      loan: {
        id: loan.id,
        status: loan.status,
        remaining_balance: loan.remaining_balance,
        interest_amount: loan.interest_amount,
        total_payable_amount: loan.total_payable_amount,
        due_date: loan.due_date,
        due_date_as_date: dueDate,
        today_as_date: today,
        isOverdue,
        daysOverdue,
        loan_amount: loan.loan_amount,
        interest_rate: loan.interest_rate
      }
    });
  } catch (err) {
    console.error('Error in debug endpoint:', err);
    res.status(500).json({ message: 'Error', error: err.message });
  }
});

// Debug endpoint to check all loans for a customer
app.get('/debug/customer/:customerId/loans', async (req, res) => {
  try {
    const { customerId } = req.params;
    
    // Get ALL loans regardless of status
    const allLoansResult = await pool.query(
      'SELECT id, status, customer_id, remaining_balance, interest_amount, due_date, loan_amount FROM loans WHERE customer_id = $1 ORDER BY id DESC',
      [customerId]
    );
    
    console.log(`🔍 DEBUG: Customer ${customerId} - Found ${allLoansResult.rows.length} loans total`);
    
    if (allLoansResult.rows.length === 0) {
      return res.json({
        message: `No loans found for customer ${customerId}`,
        customerId,
        loansCount: 0,
        allLoans: []
      });
    }
    
    // Analyze each loan
    const loansAnalysis = allLoansResult.rows.map(loan => {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      
      const dueDate = new Date(loan.due_date);
      dueDate.setHours(0, 0, 0, 0);
      
      const isOverdue = dueDate < today;
      
      console.log(`  Loan ${loan.id}: status='${loan.status}', isOverdue=${isOverdue}, remaining=${loan.remaining_balance}`);
      
      return {
        ...loan,
        isOverdue,
        dueDate_formatted: loan.due_date
      };
    });
    
    res.json({
      message: 'All loans for customer',
      customerId,
      loansCount: allLoansResult.rows.length,
      allLoans: loansAnalysis
    });
  } catch (err) {
    console.error('Error in debug customer loans endpoint:', err);
    res.status(500).json({ message: 'Error', error: err.message });
  }
});



// ---------------------------- REDEEM LOAN ----------------------------


app.post('/redeem-loan', authenticateToken, requireActiveShift, async (req, res) => {
  const { loanId, userId } = req.body;

  try {
    // Get the loan details
    const loanResult = await pool.query('SELECT * FROM loans WHERE id = $1', [loanId]);
    const loan = loanResult.rows[0];

    if (!loan) {
      return res.status(404).json({ message: 'Loan not found' });
    }

    // Log loan details for debugging
    console.log('Loan found:', loan);

    // Use the remaining balance that's maintained with each payment
    const remainingBalance = parseFloat(loan.remaining_balance || 0);

    // Log remaining balance calculation for debugging
    console.log(`Remaining Balance: ${remainingBalance}`);

    // If the remaining balance is greater than 0, return an error
    if (remainingBalance > 0) {
      return res.status(400).json({ message: 'Loan is not fully paid, cannot redeem.' });
    }

    // Ensure the loan is not already redeemed
    if (loan.status === 'redeemed') {
      return res.status(400).json({ message: 'Loan has already been redeemed.' });
    }

    // Redeem the loan (update status to 'redeemed')
    const updatedLoan = await pool.query(
      'UPDATE loans SET status = $1 WHERE id = $2 RETURNING *',
      ['redeemed', loanId]
    );

    // Add to redeem history (if table exists)
    try {
      await pool.query(
        'INSERT INTO redeem_history (loan_id, redeemed_by) VALUES ($1, $2) RETURNING *',
        [loanId, userId]
      );
    } catch (historyErr) {
      console.warn('Warning: Could not insert redeem history:', historyErr.message);
      // Continue even if history insert fails - the main redeem is successful
    }

    res.status(200).json({
      message: 'Loan redeemed successfully!',
      loan: updatedLoan.rows[0],
    });
  } catch (err) {
    console.error('Error redeeming loan:', err);
    res.status(500).json({ message: 'Error redeeming loan.' });
  }
});








// ---------------------------- FORFEIT LOAN ----------------------------


// Forfeit Loan route
app.post('/forfeit-loan', authenticateToken, requireActiveShift, async (req, res) => {
  const { loanId, userId } = req.body;

  try {
    // Check if the loan exists and if it is active
    const loanQuery = 'SELECT * FROM loans WHERE id = $1';
    const loanResult = await pool.query(loanQuery, [loanId]);
    const loan = loanResult.rows[0];

    if (!loan) {
      return res.status(404).json({ message: 'Loan not found.' });
    }

    if (loan.status === 'redeemed' || loan.status === 'forfeited') {
      return res.status(400).json({ message: 'Loan is already redeemed or forfeited.' });
    }

    // Check forfeit conditions:
    // 1. Due date must be passed (past today)
    // 2. Remaining balance must be less than interest amount OR equal to 0
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const dueDate = new Date(loan.due_date);
    dueDate.setHours(0, 0, 0, 0);
    
    const isDueDatePassed = dueDate < today;
    const remainingBalance = parseFloat(loan.remaining_balance || 0);
    const interestAmount = parseFloat(loan.interest_amount || 0);
    const isBalanceLessThanInterest = remainingBalance < interestAmount || remainingBalance === 0;
    
    if (!isDueDatePassed) {
      return res.status(400).json({ message: 'Cannot forfeit: Loan due date has not passed yet.' });
    }
    
    if (!isBalanceLessThanInterest) {
      return res.status(400).json({ message: 'Cannot forfeit: Remaining balance must be less than interest amount or zero.' });
    }

    // Update loan status to 'forfeited'
    const updateQuery = 'UPDATE loans SET status = $1 WHERE id = $2 RETURNING *';
    const updatedLoan = await pool.query(updateQuery, ['forfeited', loanId]);

    // Add to forfeit history (similar to redeem history)
    const forfeitHistoryQuery = 'INSERT INTO redeem_history (loan_id, redeemed_by) VALUES ($1, $2) RETURNING *';
    const forfeitHistory = await pool.query(forfeitHistoryQuery, [loanId, userId]);

    return res.status(200).json({
      message: 'Loan forfeited successfully!',
      loan: updatedLoan.rows[0],
      forfeitHistory: forfeitHistory.rows[0],
    });
  } catch (error) {
    console.error('Error forfeiting loan:', error);
    return res.status(500).json({ message: 'Error forfeiting loan.' });
  }
});


// ======================== LOAN REACTIVATION ========================

// REACTIVATE FORFEITED LOAN - Reactivate a forfeited loan back to active status
app.post('/loans/:loanId/reactivate', async (req, res) => {
  const { loanId } = req.params;
  const { reactivatedByUserId, reactivatedByUsername, reactivationDate } = req.body;

  try {
    // Validate loanId
    const loanIdNum = parseInt(loanId, 10);
    if (isNaN(loanIdNum)) {
      return res.status(400).json({ message: 'Invalid loan ID' });
    }

    // Fetch the loan
    const loanResult = await pool.query('SELECT * FROM loans WHERE id = $1', [loanIdNum]);
    
    if (loanResult.rows.length === 0) {
      return res.status(404).json({ message: 'Loan not found' });
    }

    const loan = loanResult.rows[0];

    // Check if loan is forfeited
    if (loan.status !== 'forfeited' && loan.status !== 'FORFEITED') {
      return res.status(400).json({ message: 'Loan is not forfeited and cannot be reactivated' });
    }

    // Update loan status to active and record reactivation metadata
    const reactivationTime = reactivationDate || new Date().toISOString();
    const updateQuery = `
      UPDATE loans 
      SET status = 'active',
          reactivated_at = $1,
          reactivated_by_user_id = $2,
          reactivated_by_username = $3
      WHERE id = $4
      RETURNING *
    `;

    const updatedLoanResult = await pool.query(updateQuery, [
      reactivationTime,
      reactivatedByUserId || null,
      reactivatedByUsername || null,
      loanIdNum
    ]);

    const updatedLoan = updatedLoanResult.rows[0];

    // Create audit log entry
    try {
      await pool.query(
        `INSERT INTO audit_log (action_type, user_id, username, loan_id, timestamp, old_values, new_values)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          'REACTIVATE_LOAN',
          reactivatedByUserId || null,
          reactivatedByUsername || null,
          loanIdNum,
          reactivationTime,
          JSON.stringify({ status: loan.status }),
          JSON.stringify({ status: 'active' })
        ]
      );
    } catch (auditErr) {
      console.warn('Failed to create audit log entry:', auditErr);
      // Don't fail the request if audit log fails
    }

    res.status(200).json({
      message: 'Loan reactivated successfully!',
      loan: validators.formatLoanResponse(updatedLoan),
      reactivationMetadata: {
        reactivatedAt: reactivationTime,
        reactivatedByUserId: reactivatedByUserId,
        reactivatedByUsername: reactivatedByUsername
      }
    });
  } catch (err) {
    console.error('Error reactivating loan:', err);
    res.status(500).json({ message: 'Error reactivating loan', error: err.message });
  }
});

// ======================== END LOAN REACTIVATION ========================

// ======================== LOAN VOID/DELETE ========================

// VOID LOAN - Delete a loan (for correcting mistakes during creation)
app.delete('/customers/:customerId/loans/:loanId/void', async (req, res) => {
  const { customerId, loanId } = req.params;
  const { voidedByUserId, voidedByUsername, voidDate } = req.body || {};

  try {
    // Validate IDs
    const customerIdNum = parseInt(customerId, 10);
    const loanIdNum = parseInt(loanId, 10);
    if (isNaN(customerIdNum) || isNaN(loanIdNum)) {
      return res.status(400).json({ message: 'Invalid customer ID or loan ID' });
    }

    // Verify customer exists
    const customerCheck = await pool.query(
      'SELECT * FROM customers WHERE id = $1',
      [customerIdNum]
    );
    if (customerCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Customer not found' });
    }

    // Fetch the loan
    const loanResult = await pool.query(
      'SELECT * FROM loans WHERE id = $1 AND customer_id = $2',
      [loanIdNum, customerIdNum]
    );

    if (loanResult.rows.length === 0) {
      return res.status(404).json({ message: 'Loan not found for this customer' });
    }

    const loan = loanResult.rows[0];

    // Create audit log entry before deletion (optional - don't fail if it fails)
    if (pool) {
      try {
        await pool.query(
          `INSERT INTO audit_log (action_type, user_id, username, loan_id, timestamp, old_values)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            'VOID_LOAN',
            voidedByUserId || null,
            voidedByUsername || null,
            loanIdNum,
            voidDate || new Date().toISOString(),
            JSON.stringify({
              id: loan.id,
              transaction_number: loan.transaction_number,
              customer_id: loan.customer_id,
              loan_amount: loan.loan_amount,
              status: loan.status,
              created_at: loan.created_at
            })
          ]
        );
      } catch (auditErr) {
        console.warn('Failed to create audit log entry for void (table may not exist):', auditErr.message);
        // Continue - audit_log is optional
      }
    }

    // Delete the loan (payment_history will cascade delete via foreign key)
    let deleteResult;
    try {
      deleteResult = await pool.query(
        'DELETE FROM loans WHERE id = $1 AND customer_id = $2 RETURNING *',
        [loanIdNum, customerIdNum]
      );
    } catch (deleteErr) {
      console.error('Error deleting loan:', deleteErr.message);
      return res.status(500).json({ message: 'Failed to delete loan: ' + deleteErr.message });
    }

    if (deleteResult.rows.length === 0) {
      return res.status(500).json({ message: 'Failed to delete loan' });
    }

    res.status(200).json({
      message: 'Loan voided and permanently deleted!',
      voidedLoan: {
        id: deleteResult.rows[0].id,
        transactionNumber: deleteResult.rows[0].transaction_number,
        loanAmount: deleteResult.rows[0].loan_amount,
        status: deleteResult.rows[0].status
      },
      voidMetadata: {
        voidedAt: voidDate || new Date().toISOString(),
        voidedByUserId: voidedByUserId,
        voidedByUsername: voidedByUsername
      }
    });
  } catch (err) {
    console.error('Error voiding loan:', err);
    res.status(500).json({ message: 'Error voiding loan', error: err.message });
  }
});

// ======================== END LOAN VOID/DELETE ========================

// GET CUSTOMER INFO - Retrieve customer information by transaction number
app.get('/loans/transaction/:transactionNumber', async (req, res) => {
  const { transactionNumber } = req.params;

  try {
    // Validate transactionNumber
    if (!transactionNumber || transactionNumber.trim() === '') {
      return res.status(400).json({ message: 'Transaction number is required' });
    }

    // Fetch the loan by transaction number
    const loanResult = await pool.query('SELECT * FROM loans WHERE transaction_number = $1', [transactionNumber]);

    if (loanResult.rows.length === 0) {
      return res.status(404).json({ message: 'Loan not found' });
    }

    const loan = loanResult.rows[0];

    // Fetch payment history and calculate current state
    let calculatedState = null;
    try {
      const paymentsResult = await pool.query(
        'SELECT * FROM payment_history WHERE loan_id = $1 ORDER BY payment_date ASC',
        [loan.id]
      );
      calculatedState = calculateLoanState(loan, paymentsResult.rows, new Date());
    } catch (calcErr) {
      console.warn(`Could not calculate state for loan ${loan.id}:`, calcErr.message);
    }

    // Use calculated values if available, otherwise use database values
    const remainingBalance = calculatedState ? calculatedState.totalBalance : loan.remaining_balance;
    const dueDate = calculatedState ? calculatedState.nextDueDate : loan.due_date;
    const interestAmount = calculatedState ? calculatedState.interestAccrued : loan.interest_amount;

    res.json({
      id: loan.id,
      transactionNumber: loan.transaction_number,
      customerInfo: {
        firstName: loan.first_name || '',
        lastName: loan.last_name || '',
        homePhone: loan.home_phone || '',
        mobilePhone: loan.mobile_phone || '',
        email: loan.email || '',
        birthdate: loan.birthdate || '',
        referral: loan.referral || '',
        streetAddress: loan.street_address || '',
        city: loan.city || '',
        state: loan.state || '',
        zipcode: loan.zipcode || ''
      },
      loanDetails: {
        loanAmount: loan.loan_amount,
        interestRate: loan.interest_rate,
        interestAmount: interestAmount,  // ✅ Calculated
        totalPayableAmount: loan.total_payable_amount,
        remainingBalance: remainingBalance,  // ✅ Calculated
        status: loan.status,
        dueDate: dueDate,  // ✅ Calculated/Extended
        loanIssuedDate: loan.loan_issued_date
      },
      calculatedState: calculatedState  // Include full calculation for debugging
    });
  } catch (err) {
    console.error('Error retrieving customer data:', err);
    res.status(500).json({ message: 'Error retrieving customer data', error: err.message });
  }
});

// UPDATE CUSTOMER INFO - Update customer information for a loan by transaction number
app.put('/loans/:transactionNumber/customer-info', async (req, res) => {
  const { transactionNumber } = req.params;
  const {
    firstName,
    lastName,
    homePhone,
    mobilePhone,
    email,
    birthdate,
    referral,
    streetAddress,
    city,
    state,
    zipcode,
    updatedByUserId,
    updatedByUsername,
    updatedAt
  } = req.body;

  try {
    // Validate transactionNumber
    if (!transactionNumber || transactionNumber.trim() === '') {
      return res.status(400).json({ message: 'Transaction number is required' });
    }

    // Fetch the loan by transaction number
    const loanResult = await pool.query('SELECT * FROM loans WHERE transaction_number = $1', [transactionNumber]);
    
    if (loanResult.rows.length === 0) {
      return res.status(404).json({ message: 'Loan not found' });
    }

    const loan = loanResult.rows[0];

    // Validate required fields
    if (!firstName || !lastName) {
      return res.status(400).json({ message: 'First name and last name are required' });
    }

    // Validate email format if provided
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ message: 'Invalid email format' });
    }

    // Validate birthdate format if provided
    if (birthdate && !/^\d{4}-\d{2}-\d{2}$/.test(birthdate)) {
      return res.status(400).json({ message: 'Birthdate must be in YYYY-MM-DD format' });
    }

    // Validate state format if provided (2-letter code)
    if (state && !/^[A-Z]{2}$/.test(state)) {
      return res.status(400).json({ message: 'State must be a 2-letter code' });
    }

    const updateTime = updatedAt || new Date().toISOString();

    // Build update query dynamically
    const updateQuery = `
      UPDATE loans 
      SET first_name = $1,
          last_name = $2,
          home_phone = $3,
          mobile_phone = $4,
          email = $5,
          birthdate = $6,
          referral = $7,
          street_address = $8,
          city = $9,
          state = $10,
          zipcode = $11,
          customer_name = $12,
          updated_at = $13,
          updated_by_user_id = $14,
          updated_by_username = $15
      WHERE transaction_number = $16
      RETURNING *
    `;

    const updatedCustomerName = `${firstName} ${lastName}`;

    const updatedLoanResult = await pool.query(updateQuery, [
      firstName,
      lastName,
      homePhone || null,
      mobilePhone || null,
      email || null,
      birthdate || null,
      referral || null,
      streetAddress || null,
      city || null,
      state || null,
      zipcode || null,
      updatedCustomerName,
      updateTime,
      updatedByUserId || null,
      updatedByUsername || null,
      transactionNumber
    ]);

    const updatedLoan = updatedLoanResult.rows[0];

    // Create audit log entry
    try {
      const oldValues = {
        firstName: loan.first_name,
        lastName: loan.last_name,
        homePhone: loan.home_phone,
        mobilePhone: loan.mobile_phone,
        email: loan.email,
        birthdate: loan.birthdate,
        referral: loan.referral,
        streetAddress: loan.street_address,
        city: loan.city,
        state: loan.state,
        zipcode: loan.zipcode
      };

      const newValues = {
        firstName,
        lastName,
        homePhone: homePhone || null,
        mobilePhone: mobilePhone || null,
        email: email || null,
        birthdate: birthdate || null,
        referral: referral || null,
        streetAddress: streetAddress || null,
        city: city || null,
        state: state || null,
        zipcode: zipcode || null
      };

      await pool.query(
        `INSERT INTO audit_log (action_type, user_id, username, loan_id, timestamp, old_values, new_values)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          'UPDATE_CUSTOMER_INFO',
          updatedByUserId || null,
          updatedByUsername || null,
          loan.id,
          updateTime,
          JSON.stringify(oldValues),
          JSON.stringify(newValues)
        ]
      );
    } catch (auditErr) {
      console.warn('Failed to create audit log entry:', auditErr);
      // Don't fail the request if audit log fails
    }

    res.status(200).json({
      message: 'Customer information updated successfully!',
      customerInfo: {
        firstName: updatedLoan.first_name,
        lastName: updatedLoan.last_name,
        homePhone: updatedLoan.home_phone,
        mobilePhone: updatedLoan.mobile_phone,
        email: updatedLoan.email,
        birthdate: updatedLoan.birthdate,
        referral: updatedLoan.referral,
        streetAddress: updatedLoan.street_address,
        city: updatedLoan.city,
        state: updatedLoan.state,
        zipcode: updatedLoan.zipcode
      },
      updateMetadata: {
        updatedAt: updateTime,
        updatedByUserId: updatedByUserId,
        updatedByUsername: updatedByUsername
      }
    });
  } catch (err) {
    console.error('Error updating customer information:', err);
    res.status(500).json({ message: 'Error updating customer information', error: err.message });
  }
});

// ======================== END CUSTOMER INFORMATION UPDATE ========================


// ======================== LOAN DETAILS UPDATE ========================

// UPDATE LOAN DETAILS - Update loan amount, interest rate, term, collateral, notes
app.put('/loans/:loanId', async (req, res) => {
  const { loanId } = req.params;
  const {
    loanAmount,
    interestRate,
    loanTerm,
    collateralDescription,
    customerNote,
    updatedByUserId,
    updatedByUsername
  } = req.body;

  try {
    // Validate loanId
    if (!loanId || isNaN(loanId)) {
      return res.status(400).json({ message: 'Valid loan ID is required' });
    }

    // Fetch the loan
    const loanResult = await pool.query('SELECT * FROM loans WHERE id = $1', [loanId]);
    
    if (loanResult.rows.length === 0) {
      return res.status(404).json({ message: 'Loan not found' });
    }

    const loan = loanResult.rows[0];

    // Validate required fields
    if (loanAmount === undefined || loanAmount === null || loanAmount < 0) {
      return res.status(400).json({ message: 'Valid loan amount is required' });
    }

    if (interestRate === undefined || interestRate === null || interestRate < 0) {
      return res.status(400).json({ message: 'Valid interest rate is required' });
    }

    // Calculate new interest amount and total payable
    const newLoanAmount = parseFloat(loanAmount);
    const newInterestRate = parseFloat(interestRate);
    const newInterestAmount = (newLoanAmount * newInterestRate) / 100;
    const newTotalPayableAmount = newLoanAmount + newInterestAmount;

    // Calculate new due date if loanTerm is provided
    let newDueDate = loan.due_date;
    if (loanTerm && !isNaN(loanTerm) && loanTerm > 0) {
      const issuedDate = new Date(loan.loan_issued_date);
      newDueDate = new Date(issuedDate.getTime() + parseInt(loanTerm) * 24 * 60 * 60 * 1000);
      newDueDate = newDueDate.toISOString().split('T')[0];
    }

    const updateTime = new Date().toISOString();

    // Build update query
    const updateQuery = `
      UPDATE loans 
      SET loan_amount = $1,
          interest_rate = $2,
          interest_amount = $3,
          total_payable_amount = $4,
          remaining_balance = $5,
          loan_term = $6,
          due_date = $7,
          collateral_description = $8,
          customer_note = $9,
          updated_at = $10,
          updated_by_user_id = $11,
          updated_by_username = $12
      WHERE id = $13
      RETURNING *
    `;

    const updatedLoanResult = await pool.query(updateQuery, [
      newLoanAmount,
      newInterestRate,
      newInterestAmount,
      newTotalPayableAmount,
      newTotalPayableAmount, // remaining_balance set to total_payable_amount
      loanTerm || loan.loan_term,
      newDueDate,
      collateralDescription !== undefined ? collateralDescription : loan.collateral_description,
      customerNote !== undefined ? customerNote : loan.customer_note,
      updateTime,
      updatedByUserId || null,
      updatedByUsername || null,
      loanId
    ]);

    const updatedLoan = updatedLoanResult.rows[0];

    // Create audit log entry
    try {
      const oldValues = {
        loanAmount: loan.loan_amount,
        interestRate: loan.interest_rate,
        interestAmount: loan.interest_amount,
        totalPayableAmount: loan.total_payable_amount,
        loanTerm: loan.loan_term,
        dueDate: loan.due_date,
        collateralDescription: loan.collateral_description,
        customerNote: loan.customer_note
      };

      const newValues = {
        loanAmount: newLoanAmount,
        interestRate: newInterestRate,
        interestAmount: newInterestAmount,
        totalPayableAmount: newTotalPayableAmount,
        loanTerm: loanTerm || loan.loan_term,
        dueDate: newDueDate,
        collateralDescription: collateralDescription !== undefined ? collateralDescription : loan.collateral_description,
        customerNote: customerNote !== undefined ? customerNote : loan.customer_note
      };

      await pool.query(
        `INSERT INTO audit_log (action_type, user_id, username, loan_id, timestamp, old_values, new_values)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          'UPDATE_LOAN_DETAILS',
          updatedByUserId || null,
          updatedByUsername || null,
          loanId,
          updateTime,
          JSON.stringify(oldValues),
          JSON.stringify(newValues)
        ]
      );
    } catch (auditErr) {
      console.warn('Failed to create audit log entry:', auditErr);
    }

    res.status(200).json({
      message: 'Loan details updated successfully!',
      loan: {
        id: updatedLoan.id,
        transactionNumber: updatedLoan.transaction_number,
        loanAmount: updatedLoan.loan_amount,
        interestRate: updatedLoan.interest_rate,
        interestAmount: updatedLoan.interest_amount,
        totalPayableAmount: updatedLoan.total_payable_amount,
        remainingBalance: updatedLoan.remaining_balance,
        loanTerm: updatedLoan.loan_term,
        dueDate: updatedLoan.due_date,
        collateralDescription: updatedLoan.collateral_description,
        customerNote: updatedLoan.customer_note,
        status: updatedLoan.status
      },
      updateMetadata: {
        updatedAt: updateTime,
        updatedByUserId: updatedByUserId,
        updatedByUsername: updatedByUsername
      }
    });
  } catch (err) {
    console.error('Error updating loan details:', err);
    res.status(500).json({ message: 'Error updating loan details', error: err.message });
  }
});

// ======================== END LOAN DETAILS UPDATE ========================


// ======================== CUSTOMER PROFILE MANAGEMENT ========================

// CREATE CUSTOMER PROFILE - Create a new customer profile
app.post('/customers', async (req, res) => {
  try {
    const mapped = validators.mapRequestToDb(req.body);
    
    const {
      first_name,
      last_name,
      email,
      home_phone,
      mobile_phone,
      birthdate,
      id_type,
      id_number,
      referral,
      identification_info,
      street_address,
      city,
      state,
      zipcode,
      customer_number,
      created_by_user_id,
      created_by_username
    } = mapped;

    // Validate required fields
    const nameValidation = validators.validateNames(first_name, last_name);
    if (!nameValidation.valid) {
      return res.status(400).json({ message: nameValidation.error });
    }

    // Validate optional customer fields
    const customerFieldsValidation = validators.validateCustomerFields({
      email,
      home_phone,
      mobile_phone,
      birthdate
    });

    if (!customerFieldsValidation.valid) {
      return res.status(400).json({ 
        message: 'Validation failed', 
        errors: customerFieldsValidation.errors 
      });
    }

    // Insert customer profile
    const result = await pool.query(
      `INSERT INTO customers (
        first_name, last_name, email, home_phone, mobile_phone, birthdate,
        id_type, id_number, referral, identification_info, street_address, 
        city, state, zipcode, customer_number, created_by_user_id, created_by_username
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      RETURNING *`,
      [
        first_name,
        last_name,
        email || null,
        home_phone || null,
        mobile_phone || null,
        birthdate || null,
        id_type || null,
        id_number || null,
        referral || null,
        identification_info || null,
        street_address || null,
        city || null,
        state || null,
        zipcode || null,
        customer_number || null,
        created_by_user_id || null,
        created_by_username || null
      ]
    );

    res.status(201).json({
      message: 'Customer profile created successfully',
      customer: result.rows[0]
    });
  } catch (err) {
    console.error('Error creating customer profile:', err);
    res.status(500).json({ message: 'Error creating customer profile', error: err.message });
  }
});

// GET CUSTOMER PROFILE - Search customer by phone, first name, or last name
app.get('/customers/search-phone', async (req, res) => {
  try {
    const { phone } = req.query;

    if (!phone || phone.trim() === '') {
      return res.status(400).json({ message: 'Phone number is required' });
    }

    // Remove non-numeric characters for comparison
    const cleanPhone = phone.replace(/\D/g, '');

    let query = `SELECT * FROM customers WHERE 
                 REPLACE(REPLACE(REPLACE(mobile_phone, '-', ''), '(', ''), ')', '') ILIKE $1
                 OR REPLACE(REPLACE(REPLACE(home_phone, '-', ''), '(', ''), ')', '') ILIKE $2
                 ORDER BY created_at DESC`;

    const result = await pool.query(query, [`%${cleanPhone}%`, `%${cleanPhone}%`]);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'No customers found with that phone number' });
    }

    res.json(result.rows);
  } catch (err) {
    console.error('Error searching customers by phone:', err);
    res.status(500).json({ message: 'Error searching customers', error: err.message });
  }
});

// GET CUSTOMER PROFILE - Search customer by name
app.get('/customers/search-name', async (req, res) => {
  try {
    const { firstName, lastName } = req.query;

    if (!firstName && !lastName) {
      return res.status(400).json({ message: 'At least first name or last name is required' });
    }

    let query = 'SELECT * FROM customers WHERE 1=1';
    const params = [];
    let paramIndex = 1;

    if (firstName) {
      params.push(`%${firstName}%`);
      query += ` AND first_name ILIKE $${paramIndex}`;
      paramIndex++;
    }

    if (lastName) {
      params.push(`%${lastName}%`);
      query += ` AND last_name ILIKE $${paramIndex}`;
      paramIndex++;
    }

    query += ' ORDER BY created_at DESC';

    const result = await pool.query(query, params);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'No customers found with that name' });
    }

    res.json(result.rows);
  } catch (err) {
    console.error('Error searching customers by name:', err);
    res.status(500).json({ message: 'Error searching customers', error: err.message });
  }
});

// GET CUSTOMER - Get customer by ID
app.get('/customers/:customerId', async (req, res) => {
  try {
    const { customerId } = req.params;

    const customerIdNum = parseInt(customerId, 10);
    if (isNaN(customerIdNum)) {
      return res.status(400).json({ message: 'Invalid customer ID' });
    }

    const result = await pool.query('SELECT * FROM customers WHERE id = $1', [customerIdNum]);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Customer not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error fetching customer:', err);
    res.status(500).json({ message: 'Error fetching customer', error: err.message });
  }
});

// GET CUSTOMER PROFILE - Search customer by phone, first name, or last name (OLD - DEPRECATED)
app.get('/customers/search', async (req, res) => {
  try {
    const { firstName, lastName, mobilePhone, homePhone, email, customerId } = req.query;

    let query = 'SELECT * FROM customers WHERE 1=1';
    const params = [];
    let paramIndex = 1;

    if (customerId) {
      params.push(parseInt(customerId, 10));
      query += ` AND id = $${paramIndex}`;
      paramIndex++;
    }

    if (firstName) {
      params.push(`%${firstName}%`);
      query += ` AND first_name ILIKE $${paramIndex}`;
      paramIndex++;
    }

    if (lastName) {
      params.push(`%${lastName}%`);
      query += ` AND last_name ILIKE $${paramIndex}`;
      paramIndex++;
    }

    if (mobilePhone) {
      params.push(`%${mobilePhone.replace(/\D/g, '')}%`);
      query += ` AND REPLACE(REPLACE(REPLACE(mobile_phone, '-', ''), '(', ''), ')', '') ILIKE $${paramIndex}`;
      paramIndex++;
    }

    if (homePhone) {
      params.push(`%${homePhone.replace(/\D/g, '')}%`);
      query += ` AND REPLACE(REPLACE(REPLACE(home_phone, '-', ''), '(', ''), ')', '') ILIKE $${paramIndex}`;
      paramIndex++;
    }

    if (email) {
      params.push(`%${email}%`);
      query += ` AND email ILIKE $${paramIndex}`;
      paramIndex++;
    }

    if (params.length === 0) {
      return res.status(400).json({ message: 'At least one search criteria is required' });
    }

    query += ' ORDER BY created_at DESC';

    const result = await pool.query(query, params);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'No customers found' });
    }

    res.json(result.rows);
  } catch (err) {
    console.error('Error searching customers:', err);
    res.status(500).json({ message: 'Error searching customers', error: err.message });
  }
});

// GET CUSTOMER PROFILE WITH LOANS - Get customer profile and all associated loans (OLD - USE /customers/:customerId/loans instead)
app.get('/customers/:customerId/profile', async (req, res) => {
  try {
    const { customerId } = req.params;

    const customerIdNum = parseInt(customerId, 10);
    if (isNaN(customerIdNum)) {
      return res.status(400).json({ message: 'Invalid customer ID' });
    }

    // Get customer profile
    const customerResult = await pool.query(
      'SELECT * FROM customers WHERE id = $1',
      [customerIdNum]
    );

    if (customerResult.rows.length === 0) {
      return res.status(404).json({ message: 'Customer not found' });
    }

    const customer = customerResult.rows[0];

    // Get active loans
    const activeLoansResult = await pool.query(
      `SELECT id, transaction_number, loan_amount, interest_rate, interest_amount, total_payable_amount, recurring_fee,
              remaining_balance, due_date, loan_issued_date, status
       FROM loans
       WHERE customer_id = $1 AND status = 'active'
       ORDER BY loan_issued_date DESC`,
      [customerIdNum]
    );

    // Get redeemed loans
    const redeemedLoansResult = await pool.query(
      `SELECT id, transaction_number, loan_amount, interest_rate, interest_amount, total_payable_amount, recurring_fee, remaining_balance, due_date, loan_issued_date, status, item_description, item_category, street_address, city, state, zipcode, collateral_description FROM loans
       WHERE customer_id = $1 AND status = 'redeemed'
       ORDER BY loan_issued_date DESC`,
      [customerIdNum]
    );

    // Get forfeited loans
    const forfeitedLoansResult = await pool.query(
      `SELECT id, transaction_number, loan_amount, interest_rate, interest_amount, total_payable_amount, recurring_fee, remaining_balance, due_date, loan_issued_date, status, item_description, item_category, street_address, city, state, zipcode, collateral_description FROM loans
       WHERE customer_id = $1 AND status = 'forfeited'
       ORDER BY loan_issued_date DESC`,
      [customerIdNum]
    );

    // Get payment history
    const paymentHistoryResult = await pool.query(
      `SELECT ph.*, l.transaction_number, l.loan_amount
       FROM payment_history ph
       JOIN loans l ON ph.loan_id = l.id
       WHERE l.customer_id = $1
       ORDER BY ph.payment_date DESC`,
      [customerIdNum]
    );

    res.json({
      customer: customer,
      activeLoans: activeLoansResult.rows,
      redeemedLoans: redeemedLoansResult.rows,
      forfeitedLoans: forfeitedLoansResult.rows,
      paymentHistory: paymentHistoryResult.rows,
      summary: {
        totalActiveLoans: activeLoansResult.rows.length,
        totalRedeemedLoans: redeemedLoansResult.rows.length,
        totalForfeitedLoans: forfeitedLoansResult.rows.length,
        totalPayments: paymentHistoryResult.rows.length,
        totalOutstanding: activeLoansResult.rows.reduce((sum, loan) => sum + parseFloat(loan.remaining_balance || 0), 0)
      }
    });
  } catch (err) {
    console.error('Error fetching customer profile:', err);
    res.status(500).json({ message: 'Error fetching customer profile', error: err.message });
  }
});

// UPDATE CUSTOMER PROFILE - Update customer information
app.put('/customers/:customerId', async (req, res) => {
  try {
    const { customerId } = req.params;
    const mapped = validators.mapRequestToDb(req.body);

    const {
      first_name,
      last_name,
      email,
      home_phone,
      mobile_phone,
      birthdate,
      id_type,
      id_number,
      referral,
      identification_info,
      street_address,
      city,
      state,
      zipcode,
      customer_number,
      profile_image,
      updated_by_user_id,
      updated_by_username
    } = mapped;

    const customerIdNum = parseInt(customerId, 10);
    if (isNaN(customerIdNum)) {
      return res.status(400).json({ message: 'Invalid customer ID' });
    }

    // Check if customer exists
    const customerCheck = await pool.query(
      'SELECT * FROM customers WHERE id = $1',
      [customerIdNum]
    );

    if (customerCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Customer not found' });
    }

    // Validate email format if provided
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ message: 'Invalid email format' });
    }

    // Validate birthdate format if provided
    if (birthdate && !/^\d{4}-\d{2}-\d{2}$/.test(birthdate)) {
      return res.status(400).json({ message: 'Birthdate must be in YYYY-MM-DD format' });
    }

    // Update customer profile
    const result = await pool.query(
      `UPDATE customers
       SET first_name = $1, last_name = $2, email = $3, home_phone = $4,
           mobile_phone = $5, birthdate = $6, id_type = $7, id_number = $8,
           referral = $9, identification_info = $10, street_address = $11,
           city = $12, state = $13, zipcode = $14, customer_number = $15,
           profile_image = $16, updated_by_user_id = $17, updated_by_username = $18, updated_at = CURRENT_TIMESTAMP
       WHERE id = $19
       RETURNING *`,
      [
        first_name || null,
        last_name || null,
        email || null,
        home_phone || null,
        mobile_phone || null,
        birthdate || null,
        id_type || null,
        id_number || null,
        referral || null,
        identification_info || null,
        street_address || null,
        city || null,
        state || null,
        zipcode || null,
        customer_number || null,
        profile_image || null,
        updated_by_user_id || null,
        updated_by_username || null,
        customerIdNum
      ]
    );

    res.json({
      message: 'Customer profile updated successfully',
      customer: result.rows[0]
    });
  } catch (err) {
    console.error('Error updating customer profile:', err);
    res.status(500).json({ message: 'Error updating customer profile', error: err.message });
  }
});

// ======================== END CUSTOMER PROFILE MANAGEMENT ========================

// ======================== HELPER FUNCTIONS ========================

// Ensure interest_amount is always a valid number
const ensureInterestAmount = (loan) => {
  if (!loan) return 0;
  const amount = parseFloat(loan.interest_amount);
  if (!isNaN(amount) && amount > 0) return amount;
  // Fallback: calculate from loan_amount and interest_rate
  const loanAmount = parseFloat(loan.loan_amount) || 0;
  const interestRate = parseFloat(loan.interest_rate) || 0;
  return (loanAmount * interestRate) / 100;
};

// ======================== CUSTOMER-CENTRIC LOAN MANAGEMENT ========================

// CREATE LOAN FOR CUSTOMER - POST /customers/:customerId/loans
app.post('/customers/:customerId/loans', authenticateToken, requireActiveShift, async (req, res) => {
  try {
    const { customerId } = req.params;
    const mapped = validators.mapRequestToDb(req.body);

    console.log('📝 POST /customers/:customerId/loans request:');
    console.log('   customerId:', customerId);
    console.log('   Request body:', req.body);
    console.log('   Mapped body:', mapped);

    const {
      first_name,
      last_name,
      email,
      home_phone,
      mobile_phone,
      birthdate,
      id_type,
      id_number,
      referral,
      identification_info,
      street_address,
      city,
      state,
      zipcode,
      customer_number,
      loan_amount: loanAmount,
      interest_rate: interestRate,
      interest_amount: inputInterestAmount,
      total_payable_amount: inputTotalPayableAmount,
      recurring_fee: recurringFee,
      item_category,
      item_description,
      collateral_description,
      customer_note,
      collateral_image,
      loan_issued_date: loanIssuedDate,
      due_date: inputDueDate,
      loan_term: loanTerm,
      transaction_number: inputTransactionNumber,
      previous_loan_amount: previousLoanAmount,
      user_id: userId,
      created_by_user_id: createdByUserId,
      created_by_username: createdByUsername
    } = mapped;

    const customerIdNum = parseInt(customerId, 10);
    if (isNaN(customerIdNum)) {
      return res.status(400).json({ message: 'Invalid customer ID' });
    }

    // Fetch the actual customer from the database to get their real name
    const customerResult = await pool.query(
      'SELECT id, first_name, last_name FROM customers WHERE id = $1',
      [customerIdNum]
    );
    
    if (customerResult.rows.length === 0) {
      return res.status(404).json({ message: 'Customer not found' });
    }
    
    const customer = customerResult.rows[0];
    console.log('   ✅ Found customer:', { id: customer.id, first_name: customer.first_name, last_name: customer.last_name });

    // Try to get customer name from request first, then from customer record, then fall back
    let customerFirstName = first_name || customer.first_name || 'Unknown';
    let customerLastName = last_name || customer.last_name || 'Customer';
    if (!loanAmount || isNaN(parseFloat(loanAmount)) || parseFloat(loanAmount) <= 0) {
      return res.status(400).json({ 
        message: 'loan_amount is required and must be a positive number'
      });
    }
    if (!interestRate || isNaN(parseFloat(interestRate)) || parseFloat(interestRate) < 0) {
      return res.status(400).json({ 
        message: 'interest_rate is required and must be a non-negative number'
      });
    }
    if (!loanTerm || !Number.isInteger(parseInt(loanTerm)) || parseInt(loanTerm) < 0) {
      return res.status(400).json({ 
        message: 'loan_term is required and must be a non-negative integer'
      });
    }

    // Calculate loan totals
    const totalLoanAmount = parseFloat(previousLoanAmount || 0) + parseFloat(loanAmount);
    const calculatedInterestAmount = parseFloat(inputInterestAmount) || 
      (totalLoanAmount * parseFloat(interestRate)) / 100;
    const calculatedRecurringFee = parseFloat(recurringFee) || 0;
    const calculatedTotalPayableAmount = parseFloat(inputTotalPayableAmount) || 
      (totalLoanAmount + calculatedInterestAmount + calculatedRecurringFee);

    // Calculate or use provided due date
    let dueDate;
    if (inputDueDate) {
      dueDate = inputDueDate;
    } else {
      const issued = new Date(loanIssuedDate || new Date());
      const due = new Date(issued);
      due.setDate(due.getDate() + parseInt(loanTerm));
      dueDate = due.toISOString().slice(0, 10);
    }

    // Generate or use provided transaction number
    const transactionNumber = inputTransactionNumber || Math.floor(Math.random() * 1000000000).toString();

    console.log('🔍 About to execute INSERT with 34 values...');
    console.log('   Values count:', 34);
    console.log('   First value (first_name):', customerFirstName);
    console.log('   Loan amount value:', totalLoanAmount);

    // ===== CHECK AVAILABLE CASH IN STORE BEFORE CREATING LOAN =====
    // Get current active shift for this user
    const currentShiftResult = await pool.query(
      'SELECT * FROM shift_management WHERE user_id = $1 AND shift_end_time IS NULL ORDER BY id DESC LIMIT 1',
      [createdByUserId || userId]
    );

    if (currentShiftResult.rows.length > 0) {
      const shift = currentShiftResult.rows[0];
      const openingBalance = parseFloat(shift.opening_balance) || 0;
      const cashAdded = parseFloat(shift.cash_added) || 0;
      const totalAvailableCash = openingBalance + cashAdded;
      
      // Get all loans created in this shift (money gone OUT of store)
      // NOTE: Use initial_loan_amount instead of loan_amount to exclude added money
      const loansInShiftResult = await pool.query(
        `SELECT COALESCE(SUM(initial_loan_amount), 0) as total_loans_out 
         FROM loans 
         WHERE created_by_user_id = $1 
         AND DATE(created_at) = DATE($2)`,
        [createdByUserId || userId, new Date()]
      );
      const loansOut = parseFloat(loansInShiftResult.rows[0]?.total_loans_out || 0);

      // Get all payments made in this shift (money coming IN to store)
      const paymentsInShiftResult = await pool.query(
        `SELECT COALESCE(SUM(payment_amount), 0) as total_payments_in 
         FROM payment_history 
         WHERE created_by = $1 
         AND DATE(payment_date) = DATE($2)`,
        [createdByUserId || userId, new Date()]
      );
      const paymentsIn = parseFloat(paymentsInShiftResult.rows[0]?.total_payments_in || 0);

      // Calculate available balance (opening + cash added + payments - loans out)
      const currentBalance = totalAvailableCash + paymentsIn - loansOut;
      
      console.log('💰 Store Balance Check:');
      console.log('   Opening Balance:', openingBalance);
      console.log('   Cash Added:', cashAdded);
      console.log('   Total Available Cash:', totalAvailableCash);
      console.log('   Payments In Today:', paymentsIn);
      console.log('   Loans Out Today:', loansOut);
      console.log('   Current Available Balance:', currentBalance);
      console.log('   Requested Loan Amount:', totalLoanAmount);

      // Check if there's enough cash to give this loan
      if (totalLoanAmount > currentBalance) {
        return res.status(400).json({
          message: `❌ Insufficient store cash! Available: $${currentBalance.toFixed(2)}, Requested: $${totalLoanAmount.toFixed(2)}`,
          details: {
            openingBalance: openingBalance,
            paymentsIn: paymentsIn,
            loansOut: loansOut,
            availableBalance: currentBalance,
            requestedAmount: totalLoanAmount,
            shortfallAmount: (totalLoanAmount - currentBalance).toFixed(2)
          }
        });
      }
    }
    // ===== END CASH CHECK =====

    console.log('✅ Sufficient funds available, proceeding with loan creation...');

    // Insert loan with customer data from request
    const result = await pool.query(
      `INSERT INTO loans (
        customer_id, first_name, last_name, email, home_phone, mobile_phone, birthdate,
        id_type, id_number, referral, identification_info, street_address, city, state, zipcode,
        customer_number, loan_amount, initial_loan_amount, interest_rate, interest_amount, total_payable_amount, recurring_fee,
        item_category, item_description, collateral_description, customer_note, collateral_image, transaction_number,
        loan_issued_date, loan_term, due_date,
        status, remaining_balance, created_by, created_by_user_id, created_by_username, customer_name
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37)
      RETURNING *`,
      [
        customerIdNum,
        customerFirstName,
        customerLastName,
        email || null,
        home_phone || null,
        mobile_phone || null,
        birthdate || null,
        id_type || null,
        id_number || null,
        referral || null,
        identification_info || null,
        street_address || null,
        city || null,
        state || null,
        zipcode || null,
        customer_number || null,
        totalLoanAmount,
        totalLoanAmount,
        interestRate,
        calculatedInterestAmount,
        calculatedTotalPayableAmount,
        calculatedRecurringFee,
        item_category || null,
        item_description || null,
        collateral_description || null,
        customer_note || null,
        collateral_image || null,
        transactionNumber,
        loanIssuedDate || getLocalDateString(),
        loanTerm,
        dueDate,
        'active',
        calculatedTotalPayableAmount,
        userId || createdByUserId || null,
        createdByUserId || userId || null,
        createdByUsername || null,
        `${customerFirstName} ${customerLastName}`
      ]
    );

    const loan = validators.formatLoanResponse(result.rows[0]);

    res.status(201).json({
      message: 'Loan created successfully for customer',
      loan,
      pdf_url: `/loan-pdf/${result.rows[0].id}`
    });
  } catch (err) {
    console.error('Error creating loan with customer:', err);
    res.status(500).json({ message: 'Error creating loan', error: err.message });
  }
});

// GET ALL LOANS FOR CUSTOMER - GET /customers/:customerId/loans
app.get('/customers/:customerId/loans', async (req, res) => {
  try {
    const { customerId } = req.params;

    const customerIdNum = parseInt(customerId, 10);
    if (isNaN(customerIdNum)) {
      return res.status(400).json({ message: 'Invalid customer ID' });
    }

    // Verify customer exists
    const customerCheck = await pool.query('SELECT * FROM customers WHERE id = $1', [customerIdNum]);
    if (customerCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Customer not found' });
    }

    // Fetch all loans for this customer
    const result = await pool.query(
      'SELECT * FROM loans WHERE customer_id = $1 ORDER BY loan_issued_date DESC',
      [customerIdNum]
    );

    // Debug: Show what's in the DB for loans 8, 9, 11
    [8, 9, 11].forEach(loanId => {
      const dbLoan = result.rows.find(l => l.id === loanId);
      if (dbLoan) {
        console.log(`📥 Database for Loan #${loanId}: due_date=${dbLoan.due_date}, extended_this_cycle=${dbLoan.extended_this_cycle}`);
      }
    });

    // Helper function to compute overdue info
    const computeOverdueInfo = (loan) => {
      const isClosedStatus = ['PAID', 'CLOSED', 'paid', 'closed'].includes(loan.status);
      const hasDueDate = loan.due_date && !isNaN(new Date(loan.due_date).getTime());
      
      let isOverdue = false;
      let daysOverdue = 0;
      
      if (hasDueDate && !isClosedStatus) {
        const dueDateMs = new Date(loan.due_date).getTime();
        const nowMs = Date.now();
        
        isOverdue = dueDateMs < nowMs;
        
        if (isOverdue) {
          daysOverdue = Math.floor((nowMs - dueDateMs) / (1000 * 60 * 60 * 24));
        }
      }
      
      return { isOverdue, daysOverdue };
    };

    // Group loans by status AND by overdue status for active loans
    const loans = await Promise.all(result.rows.map(async (loan) => {
      try {
        // Simple calculation: Principal + Monthly Interest
        const calculatedBalance = getSimpleRemainingBalance(loan);
        const overdueInfo = computeOverdueInfo(loan);
        
        return {
          ...validators.formatLoanResponse(loan),
          pdf_url: `/loan-pdf/${loan.id}`,
          isOverdue: overdueInfo.isOverdue,
          daysOverdue: overdueInfo.daysOverdue,
          remaining_balance: calculatedBalance,
          interest_accrued: (calculatedBalance - parseFloat(loan.loan_amount || 0)).toFixed(2)
        };
      } catch (err) {
        console.warn(`Could not format loan ${loan.id}:`, err.message);
        const overdueInfo = computeOverdueInfo(loan);
        return {
          ...validators.formatLoanResponse(loan),
          pdf_url: `/loan-pdf/${loan.id}`,
          isOverdue: overdueInfo.isOverdue,
          daysOverdue: overdueInfo.daysOverdue
        };
      }
    }));

    // Categorize loans - PRIORITIZe database status field
    const activeLoans = loans.filter(l => {
      const match = l.status === 'active' && !l.isOverdue;
      console.log(`  activeLoans filter: Loan ${l.id} status='${l.status}' isOverdue=${l.isOverdue} → ${match ? '✓ INCLUDED' : '✗ excluded'}`);
      return match;
    });
    const overdueLoans = loans.filter(l => {
      // Include if database status is 'overdue' OR if due date has passed
      const match = l.status === 'overdue' || l.isOverdue;
      console.log(`  overdueLoans filter: Loan ${l.id} status='${l.status}' isOverdue=${l.isOverdue} → ${match ? '✓ INCLUDED' : '✗ excluded'}`);
      return match;
    });
    const redeemedLoans = loans.filter(l => {
      const match = l.status === 'redeemed';
      console.log(`  redeemedLoans filter: Loan ${l.id} status='${l.status}' → ${match ? '✓ INCLUDED' : '✗ excluded'}`);
      return match;
    });
    const forfeitedLoans = loans.filter(l => {
      const match = l.status === 'forfeited';
      console.log(`  forfeitedLoans filter: Loan ${l.id} status='${l.status}' → ${match ? '✓ INCLUDED' : '✗ excluded'}`);
      return match;
    });

    console.log(`🎯 Customer ${customerIdNum} loans summary: active=${activeLoans.length}, overdue=${overdueLoans.length}, redeemed=${redeemedLoans.length}, forfeited=${forfeitedLoans.length}`);

    // Debug log for loans 8, 9, 11 to verify due dates in API response
    console.log(`📤 Backend API Response for Customer ${customerIdNum}:`);
    [8, 9, 11].forEach(loanId => {
      const loan = loans.find(l => l.id === loanId);
      if (loan) {
        console.log(`  Loan #${loanId}: due_date=${loan.due_date}, extended_this_cycle=${loan.extended_this_cycle}`);
      }
    });

    // Disable caching for this endpoint to ensure fresh data is always returned
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.removeHeader('ETag');

    res.json({
      activeLoans,
      overdueLoans,
      redeemedLoans,
      forfeitedLoans,
      loans // Also include flat array for backwards compatibility
    });
  } catch (err) {
    console.error('Error fetching customer loans:', err);
    res.status(500).json({ message: 'Error fetching customer loans', error: err.message });
  }
});

// SEARCH LOANS FOR CUSTOMER - GET /customers/:customerId/loans/search?query=...
app.get('/customers/:customerId/loans/search', async (req, res) => {
  try {
    const { customerId } = req.params;
    const { status, transactionNumber, minAmount, maxAmount } = req.query;

    const customerIdNum = parseInt(customerId, 10);
    if (isNaN(customerIdNum)) {
      return res.status(400).json({ message: 'Invalid customer ID' });
    }

    // Verify customer exists
    const customerCheck = await pool.query('SELECT * FROM customers WHERE id = $1', [customerIdNum]);
    if (customerCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Customer not found' });
    }

    // Build dynamic search query
    let query = 'SELECT * FROM loans WHERE customer_id = $1';
    const params = [customerIdNum];
    let paramIndex = 2;

    if (status) {
      params.push(status);
      query += ` AND status = $${paramIndex}`;
      paramIndex++;
    }

    if (transactionNumber) {
      params.push(transactionNumber);
      query += ` AND transaction_number = $${paramIndex}`;
      paramIndex++;
    }

    if (minAmount) {
      params.push(parseFloat(minAmount));
      query += ` AND loan_amount >= $${paramIndex}`;
      paramIndex++;
    }

    if (maxAmount) {
      params.push(parseFloat(maxAmount));
      query += ` AND loan_amount <= $${paramIndex}`;
      paramIndex++;
    }

    query += ' ORDER BY loan_issued_date DESC';

    const result = await pool.query(query, params);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'No loans found for this customer matching criteria' });
    }

    const loans = await Promise.all(result.rows.map(async (loan) => {
      try {
        // Fetch payment history for this loan
        const paymentsResult = await pool.query(
          'SELECT * FROM payment_history WHERE loan_id = $1 ORDER BY payment_date ASC',
          [loan.id]
        );
        
        // Calculate loan state dynamically
        const loanState = calculateLoanState(loan, paymentsResult.rows, new Date());
        
        return {
          ...validators.formatLoanResponse(loan),
          pdf_url: `/loan-pdf/${loan.id}`,
          // Override static values with calculated values
          remaining_balance: loanState.totalBalance,
          principal_remaining: loanState.principalRemaining,
          interest_accrued: loanState.interestAccrued,
          penalty_accrued: loanState.penaltyAccrued,
          due_date: loanState.nextDueDate,
          is_overdue: loanState.isOverdue,
          days_overdue: loanState.daysOverdue,
          calculated_state: loanState
        };
      } catch (calcErr) {
        console.warn(`Could not calculate state for loan ${loan.id}:`, calcErr.message);
        return {
          ...validators.formatLoanResponse(loan),
          pdf_url: `/loan-pdf/${loan.id}`
        };
      }
    }));

    res.json(loans);
  } catch (err) {
    console.error('Error searching customer loans:', err);
    res.status(500).json({ message: 'Error searching loans', error: err.message });
  }
});

// MAKE PAYMENT FOR CUSTOMER LOAN - POST /customers/:customerId/loans/:loanId/payment
// Implements auto-extend business rule: extend due date by 1 month when interest-only payment made before/on due date
app.post('/customers/:customerId/loans/:loanId/payment', authenticateToken, requireActiveShift, async (req, res) => {
  const { customerId, loanId } = req.params;
  const { paymentMethod, paymentAmount, userId } = req.body;

  let client;
  try {
    const customerIdNum = parseInt(customerId, 10);
    const loanIdNum = parseInt(loanId, 10);

    if (isNaN(customerIdNum) || isNaN(loanIdNum)) {
      return res.status(400).json({ message: 'Invalid customer or loan ID' });
    }

    // Validate paymentAmount
    if (!paymentAmount || parseFloat(paymentAmount) <= 0) {
      return res.status(400).json({ message: 'Valid payment amount is required' });
    }

    // Use transaction for safety
    client = await pool.connect();
    await client.query('BEGIN');

    // Verify customer exists
    const customerCheck = await client.query('SELECT * FROM customers WHERE id = $1', [customerIdNum]);
    if (customerCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Customer not found' });
    }

    // Fetch the loan and verify it belongs to the customer (with row locking)
    const loanResult = await client.query(
      'SELECT * FROM loans WHERE id = $1 AND customer_id = $2 FOR UPDATE',
      [loanIdNum, customerIdNum]
    );
    const loan = loanResult.rows[0];

    if (!loan) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Loan not found for this customer' });
    }

    const payment = parseFloat(paymentAmount);
    const method = paymentMethod || 'cash';
    const paymentDate = new Date();

    console.log(`\n💳 AUTO-EXTEND PAYMENT ENDPOINT - Loan ${loanIdNum}, Payment: $${payment.toFixed(2)}`);

    // Process payment with auto-extend logic
    const paymentResult = processPaymentWithAutoExtend(loan, payment, paymentDate);

    console.log(`   Auto-extend triggered: ${paymentResult.autoExtendTriggered}`);
    console.log(`   New due date: ${paymentResult.newDueDate}`);
    console.log(`   New remaining balance: $${paymentResult.finalRemainingBalance.toFixed(2)}`);

    // Update the loan with new calculated values using transaction
    const updatedLoanResult = await client.query(
      `UPDATE loans SET 
        loan_amount = $1,
        remaining_balance = $2, 
        interest_amount = $3, 
        due_date = $4, 
        status = $5,
        total_payable_amount = $6,
        interest_paid_this_cycle = $7,
        extended_this_cycle = $8,
        last_extended_at = CASE WHEN $8 = true THEN CURRENT_TIMESTAMP ELSE last_extended_at END,
        updated_at = CURRENT_TIMESTAMP
       WHERE id = $9 RETURNING *`,
      [
        paymentResult.newPrincipal,
        paymentResult.finalRemainingBalance,
        paymentResult.newInterestAmount,
        paymentResult.newDueDate,
        paymentResult.newStatus,
        paymentResult.finalRemainingBalance,
        paymentResult.newInterestPaidThisCycle,
        paymentResult.newExtendedThisCycle,
        loanIdNum
      ]
    );

    // Insert payment history within same transaction
    const paymentHistoryResult = await client.query(
      'INSERT INTO payment_history (loan_id, payment_method, payment_amount, payment_date, created_by) VALUES ($1, $2, $3, CURRENT_TIMESTAMP, $4) RETURNING *',
      [loanIdNum, method, payment, userId || null]
    );

    // Commit transaction
    await client.query('COMMIT');

    // Generate receipt PDF (outside transaction)
    let receiptPDF = null;
    try {
      const updatedLoan = updatedLoanResult.rows[0];
      const pdfBuffer = await generateLoanPDF(updatedLoan);
      receiptPDF = pdfBuffer.toString('base64');
      console.log('✅ Receipt PDF generated');
    } catch (pdfError) {
      console.warn('⚠️ PDF generation failed:', pdfError.message);
    }

    // Build response based on result
    let responseMessage = paymentResult.message || 'Payment successfully processed!';
    
    if (paymentResult.finalRemainingBalance === 0) {
      responseMessage = '🎉 Loan fully paid off and automatically redeemed!';
    } else if (paymentResult.autoExtendTriggered) {
      responseMessage = `✅ ${paymentResult.message}`;
    }

    const loanWithInterest = {
      ...updatedLoanResult.rows[0],
      interest_amount: ensureInterestAmount(updatedLoanResult.rows[0])
    };

    res.status(200).json({
      message: responseMessage,
      loan: validators.formatLoanResponse(loanWithInterest),
      paymentHistory: paymentHistoryResult.rows[0],
      receiptPDF: receiptPDF,
      paymentDetails: {
        paymentAmount: payment.toFixed(2),
        autoExtendTriggered: paymentResult.autoExtendTriggered,
        autoExtendMessage: paymentResult.autoExtendTriggered ? 'Interest-only payment triggered auto-extension' : 'No auto-extension',
        newPrincipal: paymentResult.newPrincipal.toFixed(2),
        newInterestAmount: paymentResult.newInterestAmount.toFixed(2),
        newRemainingBalance: paymentResult.finalRemainingBalance.toFixed(2),
        newDueDate: paymentResult.newDueDate,
        newStatus: paymentResult.newStatus,
        interestPaidThisCycle: paymentResult.newInterestPaidThisCycle.toFixed(2),
        extendedThisCycle: paymentResult.newExtendedThisCycle
      }
    });
  } catch (err) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        console.error('Error rolling back transaction:', rollbackErr);
      }
    }
    console.error('Error making payment:', err);
    res.status(500).json({ message: 'Error making payment', error: err.message });
  } finally {
    if (client) {
      client.release();
    }
  }
});

// REDEEM LOAN FOR CUSTOMER - POST /customers/:customerId/loans/:loanId/redeem
app.post('/customers/:customerId/loans/:loanId/redeem', authenticateToken, requireActiveShift, async (req, res) => {
  const { customerId, loanId } = req.params;
  const { userId, redemptionFee } = req.body;

  try {
    const customerIdNum = parseInt(customerId, 10);
    const loanIdNum = parseInt(loanId, 10);

    if (isNaN(customerIdNum) || isNaN(loanIdNum)) {
      return res.status(400).json({ message: 'Invalid customer or loan ID' });
    }

    // Verify customer exists
    const customerCheck = await pool.query('SELECT * FROM customers WHERE id = $1', [customerIdNum]);
    if (customerCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Customer not found' });
    }

    // Fetch the loan and verify it belongs to the customer
    const loanResult = await pool.query('SELECT * FROM loans WHERE id = $1 AND customer_id = $2', [loanIdNum, customerIdNum]);
    const loan = loanResult.rows[0];

    if (!loan) {
      return res.status(404).json({ message: 'Loan not found for this customer' });
    }

    // Use the remaining balance that's maintained with each payment
    const remainingBalance = parseFloat(loan.remaining_balance || 0);

    // If the remaining balance is greater than 0, return an error
    if (remainingBalance > 0) {
      return res.status(400).json({ message: 'Loan is not fully paid, cannot redeem.' });
    }

    // Ensure the loan is not already redeemed
    if (loan.status === 'redeemed') {
      return res.status(400).json({ message: 'Loan has already been redeemed.' });
    }

    // Calculate redemption fee
    const calculatedRedemptionFee = parseFloat(redemptionFee) || 0;

    // Redeem the loan with the redemption fee
    const updatedLoan = await pool.query(
      'UPDATE loans SET status = $1, redemption_fee = $2 WHERE id = $3 RETURNING *',
      ['redeemed', calculatedRedemptionFee, loanIdNum]
    );

    // Add to redeem history (if table exists)
    try {
      await pool.query(
        'INSERT INTO redeem_history (loan_id, redeemed_by) VALUES ($1, $2) RETURNING *',
        [loanIdNum, userId]
      );
    } catch (historyErr) {
      console.warn('Warning: Could not insert redeem history:', historyErr.message);
      // Continue even if history insert fails - the main redeem is successful
    }

    res.status(200).json({
      message: 'Loan redeemed successfully!',
      loan: updatedLoan.rows[0],
    });
  } catch (err) {
    console.error('Error redeeming loan:', err.message, err.detail);
    res.status(500).json({ message: 'Error redeeming loan.', error: err.message });
  }
});

// FORFEIT LOAN FOR CUSTOMER - POST /customers/:customerId/loans/:loanId/forfeit
app.post('/customers/:customerId/loans/:loanId/forfeit', authenticateToken, requireActiveShift, async (req, res) => {
  const { customerId, loanId } = req.params;
  const { userId } = req.body;

  try {
    const customerIdNum = parseInt(customerId, 10);
    const loanIdNum = parseInt(loanId, 10);

    if (isNaN(customerIdNum) || isNaN(loanIdNum)) {
      return res.status(400).json({ message: 'Invalid customer or loan ID' });
    }

    // Verify customer exists
    const customerCheck = await pool.query('SELECT * FROM customers WHERE id = $1', [customerIdNum]);
    if (customerCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Customer not found' });
    }

    // Fetch the loan and verify it belongs to the customer
    const loanResult = await pool.query('SELECT * FROM loans WHERE id = $1 AND customer_id = $2', [loanIdNum, customerIdNum]);
    const loan = loanResult.rows[0];

    if (!loan) {
      return res.status(404).json({ message: 'Loan not found for this customer' });
    }

    if (loan.status === 'redeemed' || loan.status === 'forfeited') {
      return res.status(400).json({ message: 'Loan is already redeemed or forfeited.' });
    }

    // Check forfeit conditions:
    // 1. Due date must be passed (past today)
    // 2. Remaining balance must be less than interest amount OR equal to 0
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const dueDate = new Date(loan.due_date);
    dueDate.setHours(0, 0, 0, 0);
    
    const isDueDatePassed = dueDate < today;
    const remainingBalance = parseFloat(loan.remaining_balance || 0);
    const interestAmount = parseFloat(loan.interest_amount || 0);
    const isBalanceLessThanInterest = remainingBalance < interestAmount || remainingBalance === 0;
    
    if (!isDueDatePassed) {
      return res.status(400).json({ message: 'Cannot forfeit: Loan due date has not passed yet.' });
    }
    
    if (!isBalanceLessThanInterest) {
      return res.status(400).json({ message: 'Cannot forfeit: Remaining balance must be less than interest amount or zero.' });
    }

    // Update loan status to 'forfeited'
    const updatedLoan = await pool.query('UPDATE loans SET status = $1 WHERE id = $2 RETURNING *', ['forfeited', loanIdNum]);

    // Add to forfeit history (if table exists)
    try {
      await pool.query(
        'INSERT INTO redeem_history (loan_id, redeemed_by) VALUES ($1, $2) RETURNING *',
        [loanIdNum, userId]
      );
    } catch (historyErr) {
      console.warn('Warning: Could not insert forfeit history:', historyErr.message);
      // Continue even if history insert fails - the main forfeit is successful
    }

    res.status(200).json({
      message: 'Loan forfeited successfully!',
      loan: updatedLoan.rows[0],
    });
  } catch (err) {
    console.error('Error forfeiting loan:', err);
    res.status(500).json({ message: 'Error forfeiting loan.' });
  }
});

// REACTIVATE FORFEITED LOAN FOR CUSTOMER - POST /customers/:customerId/loans/:loanId/reactivate
app.post('/customers/:customerId/loans/:loanId/reactivate', authenticateToken, requireActiveShift, async (req, res) => {
  const { customerId, loanId } = req.params;
  const { reactivatedByUserId, reactivatedByUsername, reactivationDate } = req.body;

  try {
    const customerIdNum = parseInt(customerId, 10);
    const loanIdNum = parseInt(loanId, 10);

    if (isNaN(customerIdNum) || isNaN(loanIdNum)) {
      return res.status(400).json({ message: 'Invalid customer or loan ID' });
    }

    // Verify customer exists
    const customerCheck = await pool.query('SELECT * FROM customers WHERE id = $1', [customerIdNum]);
    if (customerCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Customer not found' });
    }

    // Fetch the loan and verify it belongs to the customer
    const loanResult = await pool.query('SELECT * FROM loans WHERE id = $1 AND customer_id = $2', [loanIdNum, customerIdNum]);
    const loan = loanResult.rows[0];

    if (!loan) {
      return res.status(404).json({ message: 'Loan not found for this customer' });
    }

    // Check if loan is forfeited
    if (loan.status !== 'forfeited' && loan.status !== 'FORFEITED') {
      return res.status(400).json({ message: 'Loan is not forfeited and cannot be reactivated' });
    }

    // Update loan status to active
    const reactivationTime = reactivationDate || new Date().toISOString();
    const updateQuery = `
      UPDATE loans 
      SET status = 'active',
          reactivated_at = $1,
          reactivated_by_user_id = $2,
          reactivated_by_username = $3
      WHERE id = $4
      RETURNING *
    `;

    const updatedLoanResult = await pool.query(updateQuery, [
      reactivationTime,
      reactivatedByUserId || null,
      reactivatedByUsername || null,
      loanIdNum
    ]);

    const updatedLoan = updatedLoanResult.rows[0];

    // Create audit log entry
    try {
      await pool.query(
        `INSERT INTO audit_log (action_type, user_id, username, loan_id, timestamp, old_values, new_values)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          'REACTIVATE_LOAN',
          reactivatedByUserId || null,
          reactivatedByUsername || null,
          loanIdNum,
          reactivationTime,
          JSON.stringify({ status: loan.status }),
          JSON.stringify({ status: 'active' })
        ]
      );
    } catch (auditErr) {
      console.warn('Failed to create audit log entry:', auditErr);
    }

    res.status(200).json({
      message: 'Loan reactivated successfully!',
      loan: validators.formatLoanResponse(updatedLoan),
      reactivationMetadata: {
        reactivatedAt: reactivationTime,
        reactivatedByUserId: reactivatedByUserId,
        reactivatedByUsername: reactivatedByUsername
      }
    });
  } catch (err) {
    console.error('Error reactivating loan:', err);
    res.status(500).json({ message: 'Error reactivating loan', error: err.message });
  }
});

// EXTEND DUE DATE FOR CUSTOMER LOAN - POST /customers/:customerId/loans/:loanId/extend-due-date
app.post('/customers/:customerId/loans/:loanId/extend-due-date', authenticateToken, requireActiveShift, async (req, res) => {
  const { customerId, loanId } = req.params;
  const { extendDays, extendedByUserId, extendedByUsername } = req.body;

  try {
    const customerIdNum = parseInt(customerId, 10);
    const loanIdNum = parseInt(loanId, 10);
    const extendDaysNum = parseInt(extendDays || 30, 10);

    if (isNaN(customerIdNum) || isNaN(loanIdNum)) {
      return res.status(400).json({ message: 'Invalid customer or loan ID' });
    }

    // Verify customer exists
    const customerCheck = await pool.query('SELECT * FROM customers WHERE id = $1', [customerIdNum]);
    if (customerCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Customer not found' });
    }

    // Fetch the loan and verify it belongs to the customer
    const loanResult = await pool.query('SELECT * FROM loans WHERE id = $1 AND customer_id = $2', [loanIdNum, customerIdNum]);
    const loan = loanResult.rows[0];

    if (!loan) {
      return res.status(404).json({ message: 'Loan not found for this customer' });
    }

    if (loan.status !== 'active') {
      return res.status(400).json({ message: 'Only active loans can be extended' });
    }

    // Check if at least interest amount has been paid
    const paymentResult = await pool.query(
      'SELECT SUM(payment_amount) AS total_paid FROM payment_history WHERE loan_id = $1',
      [loanIdNum]
    );
    const totalPaid = parseFloat(paymentResult.rows[0].total_paid) || 0;
    
    // Use helper function to ensure interest_amount is valid
    const requiredInterest = ensureInterestAmount(loan);

    if (totalPaid < requiredInterest) {
      return res.status(400).json({ 
        message: `Interest not paid. Paid: $${totalPaid.toFixed(2)}, Required: $${requiredInterest.toFixed(2)}, Cannot extend loan.`,
        details: {
          totalPaid: totalPaid.toFixed(2),
          requiredInterest: requiredInterest.toFixed(2)
        }
      });
    }

    // Extend the due date
    const currentDueDate = new Date(loan.due_date);
    currentDueDate.setDate(currentDueDate.getDate() + extendDaysNum);
    const newDueDate = currentDueDate.toISOString().slice(0, 10);

    const updateQuery = `
      UPDATE loans
      SET due_date = $1,
          extended_at = CURRENT_TIMESTAMP,
          extended_by_user_id = $2,
          extended_by_username = $3
      WHERE id = $4
      RETURNING *
    `;

    const updatedLoan = await pool.query(updateQuery, [newDueDate, extendedByUserId || null, extendedByUsername || null, loanIdNum]);

    res.status(200).json({
      message: `Loan extended by ${extendDaysNum} days!`,
      loan: validators.formatLoanResponse(updatedLoan.rows[0])
    });
  } catch (err) {
    console.error('Error extending loan due date:', err);
    res.status(500).json({ message: 'Error extending loan due date' });
  }
});



// APPLY DISCOUNT TO LOAN - POST /customers/:customerId/loans/:loanId/discount
app.post('/customers/:customerId/loans/:loanId/discount', authenticateToken, requireActiveShift, async (req, res) => {
  const { customerId, loanId } = req.params;
  const { discountAmount, userId, username } = req.body;

  try {
    const customerIdNum = parseInt(customerId, 10);
    const loanIdNum = parseInt(loanId, 10);
    const discount = parseFloat(discountAmount);

    if (isNaN(customerIdNum) || isNaN(loanIdNum) || isNaN(discount)) {
      return res.status(400).json({ message: 'Invalid customer ID, loan ID, or discount amount' });
    }

    if (discount <= 0) {
      return res.status(400).json({ message: 'Discount amount must be greater than 0' });
    }

    const customerCheck = await pool.query('SELECT * FROM customers WHERE id = $1', [customerIdNum]);
    if (customerCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Customer not found' });
    }

    const loanResult = await pool.query('SELECT * FROM loans WHERE id = $1 AND customer_id = $2', [loanIdNum, customerIdNum]);
    const loan = loanResult.rows[0];

    if (!loan) {
      return res.status(404).json({ message: 'Loan not found for this customer' });
    }

    if (loan.status !== 'active') {
      return res.status(400).json({ message: 'Only active loans can have discounts applied' });
    }

    const newRemainingBalance = Math.max(0, parseFloat(loan.remaining_balance) - discount);
    
    const updateResult = await pool.query(
      'UPDATE loans SET remaining_balance = $1 WHERE id = $2 RETURNING *',
      [newRemainingBalance, loanIdNum]
    );

    res.status(200).json({
      message: 'Discount of \$' + discount.toFixed(2) + ' applied successfully!',
      loan: validators.formatLoanResponse(updateResult.rows[0])
    });
  } catch (err) {
    console.error('Error applying discount:', err);
    res.status(500).json({ message: 'Error applying discount' });
  }
});

// ADD MONEY TO CUSTOMER LOAN - POST /customers/:customerId/loans/:loanId/add-money
app.post('/customers/:customerId/loans/:loanId/add-money', authenticateToken, requireActiveShift, async (req, res) => {
  const { customerId, loanId } = req.params;
  const { amount } = req.body;

  try {
    const customerIdNum = parseInt(customerId, 10);
    const loanIdNum = parseInt(loanId, 10);

    if (isNaN(customerIdNum) || isNaN(loanIdNum)) {
      return res.status(400).json({ message: 'Invalid customer or loan ID' });
    }

    // Verify customer exists
    const customerCheck = await pool.query('SELECT * FROM customers WHERE id = $1', [customerIdNum]);
    if (customerCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Customer not found' });
    }

    // Fetch the loan and verify it belongs to the customer
    const loanResult = await pool.query('SELECT * FROM loans WHERE id = $1 AND customer_id = $2', [loanIdNum, customerIdNum]);
    const loan = loanResult.rows[0];

    if (!loan) {
      return res.status(404).json({ message: 'Loan not found for this customer' });
    }

    // Get total payments made so far
    const paymentsResult = await pool.query(
      'SELECT SUM(payment_amount) AS total_paid FROM payment_history WHERE loan_id = $1',
      [loanIdNum]
    );
    const totalPaid = paymentsResult.rows[0].total_paid || 0;

    // Update loan amount, recalculate interest, and total payable amount
    const newLoanAmount = parseFloat(loan.loan_amount) + parseFloat(amount);
    const newInterestAmount = (newLoanAmount * parseFloat(loan.interest_rate)) / 100;
    const newTotalPayableAmount = newLoanAmount + newInterestAmount;
    const newRemainingBalance = newTotalPayableAmount - totalPaid;

    const updateLoanResult = await pool.query(
      'UPDATE loans SET loan_amount = $1, interest_amount = $2, total_payable_amount = $3, remaining_balance = $4 WHERE id = $5 RETURNING *',
      [newLoanAmount, newInterestAmount, newTotalPayableAmount, newRemainingBalance, loanIdNum]
    );

    res.status(200).json({
      message: 'Money added successfully and loan recalculated',
      loan: updateLoanResult.rows[0],
    });
  } catch (err) {
    console.error('Error adding money:', err);
    res.status(500).json({ message: 'Error adding money to the loan' });
  }
});

// GET LOAN DETAILS FOR CUSTOMER - GET /customers/:customerId/loans/:loanId
app.get('/customers/:customerId/loans/:loanId', async (req, res) => {
  const { customerId, loanId } = req.params;

  try {
    const customerIdNum = parseInt(customerId, 10);
    const loanIdNum = parseInt(loanId, 10);

    if (isNaN(customerIdNum) || isNaN(loanIdNum)) {
      return res.status(400).json({ message: 'Invalid customer or loan ID' });
    }

    // Verify customer exists
    const customerCheck = await pool.query('SELECT * FROM customers WHERE id = $1', [customerIdNum]);
    if (customerCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Customer not found' });
    }

    // Fetch the loan and verify it belongs to the customer
    const loanResult = await pool.query('SELECT * FROM loans WHERE id = $1 AND customer_id = $2', [loanIdNum, customerIdNum]);
    const loan = loanResult.rows[0];

    if (!loan) {
      return res.status(404).json({ message: 'Loan not found for this customer' });
    }

    // Get payment history for this loan
    const paymentsResult = await pool.query(
      'SELECT * FROM payment_history WHERE loan_id = $1 ORDER BY payment_date DESC',
      [loanIdNum]
    );

    // Ensure interest_amount is always valid
    const loanWithInterest = {
      ...loan,
      interest_amount: ensureInterestAmount(loan)
    };

    res.json({
      loan: validators.formatLoanResponse(loanWithInterest),
      paymentHistory: paymentsResult.rows,
      pdf_url: `/loan-pdf/${loanIdNum}`
    });
  } catch (err) {
    console.error('Error fetching loan details:', err);
    res.status(500).json({ message: 'Error fetching loan details', error: err.message });
  }
});

// GET COLLATERAL IMAGE - GET /customers/:customerId/loans/:loanId/collateral-image
app.get('/customers/:customerId/loans/:loanId/collateral-image', async (req, res) => {
  const { customerId, loanId } = req.params;

  try {
    const customerIdNum = parseInt(customerId, 10);
    const loanIdNum = parseInt(loanId, 10);

    if (isNaN(customerIdNum) || isNaN(loanIdNum)) {
      return res.status(400).json({ message: 'Invalid customer or loan ID' });
    }

    // Fetch the loan's collateral image
    const result = await pool.query(
      'SELECT collateral_image FROM loans WHERE id = $1 AND customer_id = $2',
      [loanIdNum, customerIdNum]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Loan not found' });
    }

    const collateralImage = result.rows[0].collateral_image;

    if (!collateralImage) {
      return res.status(404).json({ message: 'No collateral image found for this loan' });
    }

    // If it's a blob URL (temporary browser URL), it can't be retrieved
    if (collateralImage.startsWith('blob:')) {
      return res.status(410).json({ 
        message: 'Collateral image has expired',
        expired: true,
        hint: 'Please re-upload the collateral image to persist it'
      });
    }

    // If it's already base64, return it directly
    if (collateralImage.startsWith('data:')) {
      return res.json({ image: collateralImage });
    }

    // If it's base64 without the data URL prefix, add it
    if (!/^http/.test(collateralImage)) {
      return res.json({ image: `data:image/jpeg;base64,${collateralImage}` });
    }

    // Otherwise return as-is (shouldn't reach here for normal operation)
    res.json({ image: collateralImage });
  } catch (err) {
    console.error('Error fetching collateral image:', err);
    res.status(500).json({ message: 'Error fetching collateral image' });
  }
});

// ======================== END CUSTOMER-CENTRIC LOAN MANAGEMENT ========================

// ======================== PUBLIC API ENDPOINTS (FOR PRODUCTION/FRONTEND) ========================

// HEALTH CHECK - GET /health
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// GET ALL LOANS WITH OVERDUE INFO - GET /api/loans
// Returns all loans from DB with computed isOverdue and daysOverdue fields
// Optional query param: ?debug=1 to log detailed overdue information
// No authentication required for this endpoint (can be restricted if needed)
app.get('/api/loans', async (req, res) => {
  try {
    const debug = req.query.debug === '1';
    const query = `
      SELECT 
        id,
        customer_id,
        customer_name,
        loan_amount,
        initial_loan_amount,
        interest_rate,
        interest_amount,
        total_payable_amount,
        loan_issued_date,
        due_date,
        status,
        transaction_number,
        remaining_balance,
        first_name,
        last_name,
        email,
        mobile_phone,
        home_phone,
        collateral_description,
        item_description,
        created_at,
        updated_at
      FROM loans
      ORDER BY due_date DESC, created_at DESC
    `;

    const result = await pool.query(query);
    
    // Compute overdue fields and calculate state for each loan
    const loansWithOverdue = await Promise.all(result.rows.map(async (loan) => {
      try {
        // Simple calculation: Principal + Monthly Interest
        const calculatedBalance = getSimpleRemainingBalance(loan);
        
        // Check if overdue
        const isClosedStatus = ['PAID', 'CLOSED', 'paid', 'closed'].includes(loan.status);
        let isOverdue = false;
        let daysOverdue = 0;
        
        if (loan.due_date && !isClosedStatus) {
          const dueDateMs = new Date(loan.due_date).getTime();
          const nowMs = Date.now();
          isOverdue = dueDateMs < nowMs;
          if (isOverdue) {
            daysOverdue = Math.floor((nowMs - dueDateMs) / (1000 * 60 * 60 * 24));
          }
        }
        
        return {
          ...loan,
          remaining_balance: calculatedBalance,
          isOverdue,
          daysOverdue,
          pdf_url: `/loan-pdf/${loan.id}`
        };
      } catch (err) {
        console.error(`Error processing loan ${loan.id}:`, err.message);
        
        const isClosedStatus = ['PAID', 'CLOSED', 'paid', 'closed'].includes(loan.status);
        let isOverdue = false;
        let daysOverdue = 0;
        
        if (loan.due_date && !isClosedStatus) {
          const dueDateMs = new Date(loan.due_date).getTime();
          const nowMs = Date.now();
          isOverdue = dueDateMs < nowMs;
          if (isOverdue) {
            daysOverdue = Math.floor((nowMs - dueDateMs) / (1000 * 60 * 60 * 24));
          }
        }
        
        return {
          ...loan,
          remaining_balance: getSimpleRemainingBalance(loan),
          isOverdue,
          daysOverdue,
          pdf_url: `/loan-pdf/${loan.id}`
        };
      }
    }));

    // Log summary for monitoring
    const overdueCount = loansWithOverdue.filter(l => l.isOverdue).length;
    const summary = `📊 /api/loans: Returned ${loansWithOverdue.length} total loans, ${overdueCount} overdue`;
    console.log(summary);
    
    // Log detailed overdue info if debug flag is set
    if (debug && overdueCount > 0) {
      const overdueList = loansWithOverdue.filter(l => l.isOverdue).map(l => ({
        id: l.id,
        customer: `${l.first_name || ''} ${l.last_name || ''}`.trim(),
        dueDate: l.due_date,
        daysOverdue: l.daysOverdue,
        amount: l.loan_amount
      }));
      console.log('🔴 Overdue Loans Details:', JSON.stringify(overdueList, null, 2));
    }

    res.json({
      count: loansWithOverdue.length,
      overdueCount,
      loans: loansWithOverdue
    });
  } catch (err) {
    console.error('❌ Error fetching loans:', err);
    res.status(500).json({ 
      message: 'Error fetching loans', 
      error: process.env.NODE_ENV === 'production' ? undefined : err.message 
    });
  }
});

// ===== DIAGNOSTIC ENDPOINT - Test calculation on Loan #8 =====
app.get('/test-calculation/:loanId', async (req, res) => {
  try {
    const { loanId } = req.params;
    console.log(`\n🧪 TEST-CALC: Starting test for loan ${loanId}`);
    
    // Get loan from DB
    const loanResult = await pool.query('SELECT * FROM loans WHERE id = $1', [loanId]);
    if (loanResult.rows.length === 0) {
      return res.status(404).json({ message: 'Loan not found' });
    }
    
    const dbLoan = loanResult.rows[0];
    console.log(`🧪 TEST-CALC: Found loan in DB: $${dbLoan.remaining_balance} (transaction: ${dbLoan.transaction_number})`);
    
    // Get payments
    const paymentResult = await pool.query(
      'SELECT * FROM payment_history WHERE loan_id = $1 ORDER BY payment_date ASC',
      [loanId]
    );
    const payments = paymentResult.rows;
    console.log(`🧪 TEST-CALC: Found ${payments.length} payments`);
    payments.forEach((p, i) => {
      console.log(`  Payment ${i+1}: ${p.payment_date} - $${p.payment_amount}`);
    });
    
    // Try to calculate
    console.log(`🧪 TEST-CALC: Calling calculateLoanState...`);
    let calculated = null;
    try {
      calculated = calculateLoanState(dbLoan, payments, new Date());
      console.log(`✅ TEST-CALC: Calculation succeeded!`);
      console.log(`  Principal: $${calculated.principalRemaining.toFixed(2)}`);
      console.log(`  Interest: $${calculated.interestAccrued.toFixed(2)}`);
      console.log(`  Penalty: $${calculated.penaltyAccrued.toFixed(2)}`);
      console.log(`  TOTAL: $${calculated.totalBalance.toFixed(2)}`);
    } catch (calcErr) {
      console.error(`❌ TEST-CALC: Calculation FAILED:`, calcErr.message);
      console.error(`Stack:`, calcErr.stack);
      throw calcErr;
    }
    
    res.json({
      test_result: 'OK',
      loan_id: loanId,
      database_values: {
        id: dbLoan.id,
        transaction_number: dbLoan.transaction_number,
        loan_amount: dbLoan.loan_amount,
        interest_rate: dbLoan.interest_rate,
        db_remaining_balance: dbLoan.remaining_balance,
        db_interest_amount: dbLoan.interest_amount,
        db_due_date: dbLoan.due_date,
        created_at: dbLoan.created_at
      },
      calculated_values: {
        principal_remaining: calculated.principalRemaining,
        interest_accrued: calculated.interestAccrued,
        penalty_accrued: calculated.penaltyAccrued,
        total_balance: calculated.totalBalance,
        next_due_date: calculated.nextDueDate,
        is_overdue: calculated.isOverdue
      },
      difference: {
        remaining_balance_diff: (calculated.totalBalance - dbLoan.remaining_balance).toFixed(2),
        is_different: calculated.totalBalance !== dbLoan.remaining_balance
      },
      payments: payments.map(p => ({
        date: p.payment_date,
        amount: p.payment_amount
      }))
    });
  } catch (err) {
    console.error('❌ TEST-CALC: Error:', err.message);
    res.status(500).json({ 
      message: 'Test failed', 
      error: err.message 
    });
  }
});

// ===== FIX ENDPOINT - Correct Loan #8 data =====
// ======================== SIMPLIFIED LOAN STATE CALCULATION ========================
// Calculate remaining balance: Principal + (Principal × Interest Rate ÷ 100)
function getSimpleRemainingBalance(loan) {
  try {
    const principal = parseFloat(loan.loan_amount || loan.initial_loan_amount || 0);
    const rate = parseFloat(loan.interest_rate || 0);
    const monthlyInterest = (principal * rate) / 100;
    return principal + monthlyInterest;
  } catch (err) {
    console.error(`Error calculating balance for loan ${loan.id}:`, err);
    return parseFloat(loan.remaining_balance || 0);
  }
}

// ======================== END LOAN STATE CALCULATION ========================

// START SHIFT - User records opening cash balance
app.post('/start-shift', async (req, res) => {
  const { userId, openingBalance } = req.body;

  try {
    if (openingBalance === null || openingBalance === undefined || openingBalance < 0) {
      return res.status(400).json({ message: 'Invalid opening balance' });
    }

    // Check if there's an active shift for this user
    const activeShiftCheck = await pool.query(
      'SELECT * FROM shift_management WHERE user_id = $1 AND shift_end_time IS NULL',
      [userId]
    );

    if (activeShiftCheck.rows.length > 0) {
      return res.status(400).json({ message: 'User already has an active shift. Please close the previous shift first.' });
    }

    // Insert new shift record
    const result = await pool.query(
      `INSERT INTO shift_management (user_id, shift_start_time, opening_balance)
       VALUES ($1, CURRENT_TIMESTAMP, $2)
       RETURNING *`,
      [userId, parseFloat(openingBalance)]
    );

    res.status(201).json({
      message: 'Shift started successfully',
      shift: result.rows[0]
    });
  } catch (err) {
    console.error('Error starting shift:', err);
    res.status(500).json({ message: 'Error starting shift' });
  }
});


// GET CURRENT SHIFT - Get active shift for user (query parameter version)
app.get('/current-shift', async (req, res) => {
  let { userId } = req.query;

  try {
    if (!userId || userId === 'undefined') {
      return res.status(400).json({ message: 'User ID is required' });
    }

    // Convert to integer
    const userIdNum = parseInt(userId, 10);
    if (isNaN(userIdNum)) {
      return res.status(400).json({ message: 'Invalid User ID format' });
    }

    const result = await pool.query(
      'SELECT * FROM shift_management WHERE user_id = $1 AND shift_end_time IS NULL ORDER BY id DESC LIMIT 1',
      [userIdNum]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'No active shift found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error fetching current shift:', err);
    res.status(500).json({ message: 'Error fetching current shift' });
  }
});

// GET CURRENT SHIFT - Get active shift for user (path parameter version)
app.get('/current-shift/:userId', async (req, res) => {
  let { userId } = req.params;

  try {
    if (!userId || userId === 'undefined') {
      return res.status(400).json({ message: 'User ID is required' });
    }

    // Convert to integer
    const userIdNum = parseInt(userId, 10);
    if (isNaN(userIdNum)) {
      return res.status(400).json({ message: 'Invalid User ID format' });
    }

    const result = await pool.query(
      'SELECT * FROM shift_management WHERE user_id = $1 AND shift_end_time IS NULL ORDER BY id DESC LIMIT 1',
      [userIdNum]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'No active shift found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error fetching current shift:', err);
    res.status(500).json({ message: 'Error fetching current shift' });
  }
});


// END SHIFT - User records closing cash balance and system verifies
app.post('/end-shift', async (req, res) => {
  const { userId, closingBalance, notes } = req.body;

  try {
    if (closingBalance === null || closingBalance === undefined || closingBalance < 0) {
      return res.status(400).json({ message: 'Invalid closing balance' });
    }

    // Get active shift
    const shiftResult = await pool.query(
      'SELECT * FROM shift_management WHERE user_id = $1 AND shift_end_time IS NULL ORDER BY id DESC LIMIT 1',
      [userId]
    );

    if (shiftResult.rows.length === 0) {
      return res.status(404).json({ message: 'No active shift found' });
    }

    const shift = shiftResult.rows[0];

    // Get CASH payments received ONLY DURING THIS SHIFT
    // Only count payments AFTER shift starts AND BEFORE now (shift close time)
    const now = new Date();
    const shiftStartTime = shift.shift_start_time;
    
    const paymentsResult = await pool.query(
      `SELECT COALESCE(SUM(payment_amount), 0) AS total_payments 
       FROM payment_history 
       WHERE created_by = $1 AND payment_date >= $2 AND payment_date <= $3 AND LOWER(payment_method) = 'cash'`,
      [userId, shiftStartTime, now]
    );

    // Get all loans given ONLY DURING THIS SHIFT
    // Only count loans AFTER shift starts AND BEFORE now (shift close time)
    const loansGivenResult = await pool.query(
      `SELECT COALESCE(SUM(loan_amount), 0) AS total_loans_given 
       FROM loans 
       WHERE created_by = $1 AND loan_issued_date >= $2 AND loan_issued_date <= $3`,
      [userId, shiftStartTime, now]
    );

    // Get redemptions DURING THIS SHIFT
    // Redemptions represent cash received when customer redeems the loan
    const redemptionsResult = await pool.query(
      `SELECT COALESCE(SUM(l.total_payable_amount), 0) AS total_redemptions
       FROM loans l
       WHERE l.created_by = $1 AND l.status = 'redeemed'
       AND l.updated_at >= $2 AND l.updated_at <= $3`,
      [userId, shiftStartTime, now]
    );

    const totalCashPayments = parseFloat(paymentsResult.rows[0].total_payments || 0);
    const totalLoansGiven = parseFloat(loansGivenResult.rows[0].total_loans_given || 0);
    const totalRedemptions = parseFloat(redemptionsResult.rows[0].total_redemptions || 0);
    const openingBalance = parseFloat(shift.opening_balance);

    // Calculate expected balance: opening + cash payments + redemptions - loans given
    // All three (payments, redemptions, loans) affect the cash balance
    // Payments: cash received from loan payments
    // Redemptions: cash received when customers redeem and get collateral back
    // Loans: cash given out as new loans
    const expectedBalance = openingBalance + totalCashPayments + totalRedemptions - totalLoansGiven;
    const closingBalanceNum = parseFloat(closingBalance);
    const difference = closingBalanceNum - expectedBalance;
    const isBalanced = Math.abs(difference) < 0.01; // Allow for floating point errors

    // Update shift with closing details
    const updateResult = await pool.query(
      `UPDATE shift_management 
       SET shift_end_time = CURRENT_TIMESTAMP, 
           closing_balance = $1, 
           total_payments_received = $2, 
           total_loans_given = $3, 
           expected_balance = $4, 
           difference = $5, 
           is_balanced = $6,
           notes = $7
       WHERE id = $8
       RETURNING *`,
      [closingBalanceNum, totalCashPayments, totalLoansGiven, expectedBalance, difference, isBalanced, notes || null, shift.id]
    );

    res.status(200).json({
      message: isBalanced ? 'Shift closed successfully and cash is balanced!' : 'Shift closed but there is a discrepancy!',
      shift: updateResult.rows[0],
      summary: {
        openingBalance: openingBalance,
        closingBalance: closingBalanceNum,
        totalCashPaymentsReceived: totalCashPayments,
        totalLoansGiven: totalLoansGiven,
        expectedBalance: expectedBalance,
        actualDifference: difference,
        isBalanced: isBalanced,
        status: isBalanced ? 'BALANCED' : 'DISCREPANCY'
      }
    });
  } catch (err) {
    console.error('Error ending shift:', err);
    res.status(500).json({ message: 'Error ending shift' });
  }
});


// GET SHIFT REPORT - Get detailed summary of a shift
app.get('/shift-report/:shiftId', async (req, res) => {
  const { shiftId } = req.params;

  try {
    // Get shift details
    const shiftResult = await pool.query(
      'SELECT * FROM shift_management WHERE id = $1',
      [shiftId]
    );

    if (shiftResult.rows.length === 0) {
      return res.status(404).json({ message: 'Shift not found' });
    }

    const shift = shiftResult.rows[0];

    // Get all payments during this shift
    const paymentsResult = await pool.query(
      `SELECT ph.*, l.customer_name, l.transaction_number
       FROM payment_history ph
       JOIN loans l ON ph.loan_id = l.id
       WHERE ph.created_by = $1 AND ph.payment_date >= $2 AND ph.payment_date <= COALESCE($3, CURRENT_TIMESTAMP)
       ORDER BY ph.payment_date DESC`,
      [shift.user_id, shift.shift_start_time, shift.shift_end_time]
    );

    // Get all loans created during this shift
    const loansResult = await pool.query(
      `SELECT id, customer_name, loan_amount, transaction_number, loan_issued_date
       FROM loans
       WHERE created_by = $1 AND loan_issued_date >= DATE($2) AND loan_issued_date <= COALESCE(DATE($3), CURRENT_DATE)
       ORDER BY loan_issued_date DESC`,
      [shift.user_id, shift.shift_start_time, shift.shift_end_time]
    );

    res.json({
      shift: shift,
      payments: paymentsResult.rows,
      loansCreated: loansResult.rows,
      summary: {
        totalTransactions: paymentsResult.rows.length + loansResult.rows.length,
        totalPaymentTransactions: paymentsResult.rows.length,
        totalLoansCreated: loansResult.rows.length
      }
    });
  } catch (err) {
    console.error('Error fetching shift report:', err);
    res.status(500).json({ message: 'Error fetching shift report' });
  }
});


// GET SHIFT HISTORY - Get all shifts for a user (query parameter version)
app.get('/shift-history', async (req, res) => {
  const { userId } = req.query;

  try {
    if (!userId) {
      return res.status(400).json({ message: 'User ID is required' });
    }

    const result = await pool.query(
      'SELECT * FROM shift_management WHERE user_id = $1 ORDER BY shift_start_time DESC',
      [userId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching shift history:', err);
    res.status(500).json({ message: 'Error fetching shift history' });
  }
});

// GET SHIFT HISTORY - Get all shifts for a user (path parameter version)
app.get('/shift-history/:userId', async (req, res) => {
  const { userId } = req.params;

  try {
    if (!userId) {
      return res.status(400).json({ message: 'User ID is required' });
    }

    const result = await pool.query(
      'SELECT * FROM shift_management WHERE user_id = $1 ORDER BY shift_start_time DESC',
      [userId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching shift history:', err);
    res.status(500).json({ message: 'Error fetching shift history' });
  }
});


// GET TODAY SHIFT SUMMARY - Quick summary for today
app.get('/today-shift-summary/:userId', async (req, res) => {
  const { userId } = req.params;

  try {
    // Get active shift or today's last shift
    const shiftResult = await pool.query(
      `SELECT * FROM shift_management 
       WHERE user_id = $1 AND DATE(shift_start_time) = CURRENT_DATE
       ORDER BY shift_start_time DESC LIMIT 1`,
      [userId]
    );

    if (shiftResult.rows.length === 0) {
      return res.status(404).json({ message: 'No shift found for today' });
    }

    const shift = shiftResult.rows[0];

    // Calculate current stats if shift is active
    if (!shift.shift_end_time) {
      // Get CASH payments received (exclude card, check, and other non-cash methods)
      const paymentsResult = await pool.query(
        `SELECT COALESCE(SUM(payment_amount), 0) AS total_payments,
                COUNT(*) AS payment_count
         FROM payment_history 
         WHERE created_by = $1 AND payment_date >= $2 AND LOWER(payment_method) = 'cash'`,
        [userId, shift.shift_start_time]
      );

      // Get all loans given during shift
      const loansGivenResult = await pool.query(
        `SELECT COALESCE(SUM(loan_amount), 0) AS total_loans_given,
                COUNT(*) AS loan_count
         FROM loans 
         WHERE created_by = $1 AND loan_issued_date >= $2`,
        [userId, shift.shift_start_time]
      );

      // Get redemptions - total amount received when customers redeem loans
      // A redemption means the customer paid the full amount and retrieved collateral
      // This is cash received and should be counted in the balance
      const redemptionsResult = await pool.query(
        `SELECT COALESCE(SUM(l.total_payable_amount), 0) AS total_redemptions,
                COUNT(DISTINCT l.id) AS redemption_count
         FROM loans l
         WHERE l.created_by = $1 AND l.status = 'redeemed' 
         AND l.updated_at >= $2`,
        [userId, shift.shift_start_time]
      );

      const totalPayments = parseFloat(paymentsResult.rows[0].total_payments || 0);
      const totalLoansGiven = parseFloat(loansGivenResult.rows[0].total_loans_given || 0);
      const totalRedemptions = parseFloat(redemptionsResult.rows[0].total_redemptions || 0);
      const openingBalance = parseFloat(shift.opening_balance);
      
      // Expected balance:
      // = Opening Balance + Cash Payments + Redemptions - Loans Given
      // Payments and redemptions both represent cash received from customers
      // Loans represent cash given out as loans
      const expectedBalance = openingBalance + totalPayments + totalRedemptions - totalLoansGiven;

      return res.json({
        shift: shift,
        currentStats: {
          openingBalance: openingBalance,
          expectedBalance: expectedBalance,
          totalPaymentsReceived: totalPayments,
          totalRedemptionsReceived: totalRedemptions,
          totalLoansGiven: totalLoansGiven,
          paymentCount: paymentsResult.rows[0].payment_count,
          loanCount: loansGivenResult.rows[0].loan_count,
          redemptionCount: redemptionsResult.rows[0].redemption_count || 0,
          shiftActive: true
        }
      });
    }

    res.json({
      shift: shift,
      shiftClosed: true
    });
  } catch (err) {
    console.error('Error fetching today shift summary:', err);
    res.status(500).json({ message: 'Error fetching shift summary' });
  }
});




// ======================== BALANCING REPORT (FOR DAILY CASH REPORT - BALANCING TAB) ========================

// GET BALANCING REPORT - Active and Due loans within a custom date range
// Frontend calls: GET /balancing-report?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
app.get('/balancing-report', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    // Validate date parameters
    if (!startDate || !endDate) {
      return res.status(400).json({ 
        message: 'startDate and endDate query parameters are required (YYYY-MM-DD format)' 
      });
    }

    // Validate date format
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      return res.status(400).json({ 
        message: 'Invalid date format. Use YYYY-MM-DD' 
      });
    }

    // Parse dates
    const start = new Date(startDate);
    const end = new Date(endDate);

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return res.status(400).json({ 
        message: 'Invalid date values' 
      });
    }

    // Verify start date is before end date
    if (start > end) {
      return res.status(400).json({ 
        message: 'Start date must be before or equal to end date' 
      });
    }

    // Get ACTIVE loans (non-overdue) created or active within the date range
    // Active loans: status = 'active' AND due_date >= today (not yet due)
    const activeLoansResult = await pool.query(
      `SELECT 
        COUNT(*) as total_count,
        COALESCE(SUM(loan_amount), 0) as total_principal,
        COALESCE(SUM(interest_amount), 0) as total_interest,
        COALESCE(SUM(loan_amount + interest_amount), 0) as total_amount
      FROM loans 
      WHERE status = $1 
        AND DATE(loan_issued_date) >= $2 
        AND DATE(loan_issued_date) <= $3
        AND DATE(due_date) >= CURRENT_DATE`,
      ['active', startDate, endDate]
    );

    // Get DUE/OVERDUE loans (active loans with due date passed)
    // Due loans: status = 'active' AND due_date < today
    const dueLoansResult = await pool.query(
      `SELECT 
        COUNT(*) as total_count,
        COALESCE(SUM(loan_amount), 0) as total_principal,
        COALESCE(SUM(interest_amount), 0) as total_interest,
        COALESCE(SUM(loan_amount + interest_amount), 0) as total_amount
      FROM loans 
      WHERE status = $1 
        AND DATE(loan_issued_date) >= $2 
        AND DATE(loan_issued_date) <= $3
        AND DATE(due_date) < CURRENT_DATE`,
      ['active', startDate, endDate]
    );

    const activeLoans = activeLoansResult.rows[0];
    const dueLoans = dueLoansResult.rows[0];

    // Format response with proper decimal places
    const response = {
      startDate,
      endDate,
      totalActiveLoanCount: parseInt(activeLoans.total_count) || 0,
      totalActivePrincipal: parseFloat(activeLoans.total_principal) || 0.00,
      totalActiveInterest: parseFloat(activeLoans.total_interest) || 0.00,
      totalDueLoanCount: parseInt(dueLoans.total_count) || 0,
      totalDuePrincipal: parseFloat(dueLoans.total_principal) || 0.00,
      totalDueInterest: parseFloat(dueLoans.total_interest) || 0.00
    };

    console.log('📊 Balancing Report Generated:', response);
    res.json(response);
  } catch (err) {
    console.error('Error generating balancing report:', err);
    res.status(500).json({ 
      message: 'Error generating balancing report', 
      error: err.message 
    });
  }
});

// ======================== END BALANCING REPORT ========================

// ======================== DETAILED LOANS BREAKDOWN (Active/Overdue with Payment Status) ========================

// GET DETAILED LOANS BREAKDOWN - Active & Overdue loans with due dates, payment status, sorted by customer
// Frontend calls: GET /detailed-loans-breakdown?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&status=active|overdue|all
app.get('/detailed-loans-breakdown', authenticateToken, async (req, res) => {
  try {
    const { startDate, endDate, status = 'all' } = req.query;

    console.log('🔍 /detailed-loans-breakdown called with:', { startDate, endDate, status });

    // Validate date parameters (optional for flexibility)
    let dateFilter = '';
    const params = [];

    if (startDate && endDate) {
      // Validate date format
      if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
        return res.status(400).json({ 
          message: 'Invalid date format. Use YYYY-MM-DD' 
        });
      }
      dateFilter = 'AND DATE(l.loan_issued_date) >= $1 AND DATE(l.loan_issued_date) <= $2';
      params.push(startDate, endDate);
    }

    // Build status filter
    let statusFilter = '';
    
    if (status === 'active') {
      statusFilter = `AND l.status = 'active'`;
    } else if (status === 'overdue') {
      // For overdue: include 'overdue' status OR 'active' loans past due date
      statusFilter = `AND (l.status = 'overdue' OR (l.status = 'active' AND l.due_date < CURRENT_DATE))`;
    }
    // If status === 'all', no filter applied

    console.log('📝 Building query with filters:', { statusFilter, dateFilter, params });

    // Get all loans with customer info and payment status using subqueries to avoid GROUP BY issues
    const simplifiedQuery = `
      SELECT 
        l.id,
        l.transaction_number,
        l.customer_name,
        c.id as customer_id,
        c.first_name,
        c.last_name,
        l.loan_amount,
        l.interest_amount,
        l.due_date,
        l.loan_issued_date,
        l.status,
        l.remaining_balance,
        l.total_payable_amount,
        COALESCE((SELECT SUM(payment_amount) FROM payment_history WHERE loan_id = l.id), 0) as total_paid,
        CASE WHEN COALESCE((SELECT SUM(payment_amount) FROM payment_history WHERE loan_id = l.id), 0) > 0 THEN true ELSE false END as has_payment,
        COALESCE((SELECT COUNT(DISTINCT id) FROM payment_history WHERE loan_id = l.id), 0) as payment_count,
        CASE 
          WHEN l.due_date < CURRENT_DATE AND l.status = 'active' THEN 'overdue'
          WHEN l.due_date = CURRENT_DATE THEN 'due-today'
          ELSE 'active'
        END as loan_status_detail,
        CASE 
          WHEN l.due_date < CURRENT_DATE THEN (CURRENT_DATE - l.due_date)::INTEGER
          ELSE 0
        END as days_overdue
      FROM loans l
      LEFT JOIN customers c ON l.customer_id = c.id
      WHERE 1=1 ${statusFilter} ${dateFilter}
      ORDER BY l.customer_name ASC, l.loan_issued_date ASC
    `;

    console.log('🔧 Executing simplified query...');

    // Execute the query
    const result = await pool.query(simplifiedQuery, params);

    if (result.rows.length === 0) {
      return res.json({
        message: 'No loans found for the specified criteria',
        customerGroups: [],
        summary: {
          totalCustomers: 0,
          totalLoans: 0,
          totalLoanAmount: 0,
          totalInterest: 0,
          totalPaid: 0,
          loansWithPayments: 0,
          activeLoans: 0,
          overdueLoans: 0
        }
      });
    }

    // Group loans by customer
    const customerGroups = {};
    let activeLoansCount = 0;
    let overdueLoansCount = 0;
    let totalPaidSum = 0;
    let loansWithPaymentsCount = 0;

    result.rows.forEach(loan => {
      const customerName = loan.customer_name || `${loan.first_name || ''} ${loan.last_name || ''}`.trim() || 'Unknown';
      
      if (!customerGroups[customerName]) {
        customerGroups[customerName] = {
          customerName,
          customerId: loan.customer_id,
          loans: []
        };
      }

      const loanData = {
        loanId: loan.id,
        transactionNumber: loan.transaction_number,
        loanAmount: parseFloat(loan.loan_amount),
        interestAmount: parseFloat(loan.interest_amount),
        totalPayable: parseFloat(loan.total_payable_amount),
        dueDate: loan.due_date,
        issuedDate: loan.loan_issued_date,
        status: loan.status,
        statusDetail: loan.loan_status_detail,
        remainingBalance: parseFloat(loan.remaining_balance),
        totalPaid: parseFloat(loan.total_paid),
        hasPayment: loan.has_payment,
        paymentCount: parseInt(loan.payment_count),
        daysOverdue: parseInt(loan.days_overdue)
      };

      customerGroups[customerName].loans.push(loanData);

      // Update counters
      if (loan.loan_status_detail === 'overdue') {
        overdueLoansCount++;
      } else {
        activeLoansCount++;
      }

      if (loan.has_payment) {
        loansWithPaymentsCount++;
      }

      totalPaidSum += parseFloat(loan.total_paid);
    });

    // Convert to array and sort by customer name
    const groupedData = Object.values(customerGroups).sort((a, b) => 
      a.customerName.localeCompare(b.customerName)
    );

    // Calculate summary
    const summary = {
      totalCustomers: groupedData.length,
      totalLoans: result.rows.length,
      totalLoanAmount: result.rows.reduce((sum, loan) => sum + parseFloat(loan.loan_amount), 0),
      totalInterest: result.rows.reduce((sum, loan) => sum + parseFloat(loan.interest_amount), 0),
      totalPaid: totalPaidSum,
      loansWithPayments: loansWithPaymentsCount,
      loansWithoutPayments: result.rows.length - loansWithPaymentsCount,
      activeLoans: activeLoansCount,
      overdueLoans: overdueLoansCount
    };

    res.json({
      message: 'Detailed loans breakdown retrieved successfully',
      customerGroups: groupedData,
      summary
    });

  } catch (err) {
    console.error('Error generating detailed loans breakdown:', {
      message: err.message,
      code: err.code,
      query: err.query,
      detail: err.detail
    });
    res.status(500).json({ 
      message: 'Error generating detailed loans breakdown', 
      error: err.message,
      detail: err.detail
    });
  }
});

// ======================== END DETAILED LOANS BREAKDOWN ========================

// ADD CASH TO SHIFT - Add additional cash to the shift (e.g., from bank withdrawal)
app.post('/shift/add-cash', async (req, res) => {
  const { userId, amount, notes } = req.body;

  try {
    if (!userId || !amount || amount <= 0) {
      return res.status(400).json({ message: 'User ID and positive amount are required' });
    }

    // Get active shift
    const shiftResult = await pool.query(
      'SELECT * FROM shift_management WHERE user_id = $1 AND shift_end_time IS NULL ORDER BY id DESC LIMIT 1',
      [userId]
    );

    if (shiftResult.rows.length === 0) {
      return res.status(404).json({ message: 'No active shift found' });
    }

    const shift = shiftResult.rows[0];
    const cashAddedAmount = parseFloat(amount);

    // Track additional cash separately from opening balance
    // Opening Balance stays fixed; cash added is tracked separately
    const updatedCashAdded = parseFloat(shift.cash_added || 0) + cashAddedAmount;

    const updateResult = await pool.query(
      `UPDATE shift_management 
       SET cash_added = $1,
           notes = CASE WHEN notes IS NULL OR notes = '' 
                   THEN $2
                   ELSE notes || '\n' || $2 END
       WHERE id = $3
       RETURNING *`,
      [updatedCashAdded, `[CASH ADDED] $${cashAddedAmount} added - ${notes || 'Bank withdrawal'}`, shift.id]
    );

    res.status(200).json({
      message: 'Cash added to shift successfully!',
      shift: updateResult.rows[0],
      amountAdded: cashAddedAmount,
      totalCashAdded: updatedCashAdded,
      openingBalance: shift.opening_balance
    });
  } catch (err) {
    console.error('Error adding cash to shift:', err);
    res.status(500).json({ message: 'Error adding cash to shift', error: err.message });
  }
});

// REMOVE/ADJUST CASH FROM SHIFT - Remove or adjust cash previously added to shift
app.post('/shift/remove-cash', async (req, res) => {
  const { userId, amount, notes } = req.body;

  try {
    if (!userId || !amount || amount <= 0) {
      return res.status(400).json({ message: 'User ID and positive amount are required' });
    }

    // Get active shift
    const shiftResult = await pool.query(
      'SELECT * FROM shift_management WHERE user_id = $1 AND shift_end_time IS NULL ORDER BY id DESC LIMIT 1',
      [userId]
    );

    if (shiftResult.rows.length === 0) {
      return res.status(404).json({ message: 'No active shift found' });
    }

    const shift = shiftResult.rows[0];
    const currentCashAdded = parseFloat(shift.cash_added || 0);
    const cashRemovedAmount = parseFloat(amount);

    // Ensure we don't remove more than what was added
    if (cashRemovedAmount > currentCashAdded) {
      return res.status(400).json({
        message: `Cannot remove $${cashRemovedAmount.toFixed(2)}. Only $${currentCashAdded.toFixed(2)} has been added.`,
        currentCashAdded: currentCashAdded,
        attemptedRemoval: cashRemovedAmount
      });
    }

    // Update cash_added
    const updatedCashAdded = currentCashAdded - cashRemovedAmount;

    const updateResult = await pool.query(
      `UPDATE shift_management 
       SET cash_added = $1,
           notes = CASE WHEN notes IS NULL OR notes = '' 
                   THEN $2
                   ELSE notes || '\n' || $2 END
       WHERE id = $3
       RETURNING *`,
      [updatedCashAdded, `[CASH REMOVED] $${cashRemovedAmount} removed - ${notes || 'Correction'}`, shift.id]
    );

    res.status(200).json({
      message: 'Cash removed from shift successfully!',
      shift: updateResult.rows[0],
      amountRemoved: cashRemovedAmount,
      totalCashAdded: updatedCashAdded,
      openingBalance: shift.opening_balance
    });
  } catch (err) {
    console.error('Error removing cash from shift:', err);
    res.status(500).json({ message: 'Error removing cash from shift', error: err.message });
  }
});

// GET STORE BALANCE - Get current store cash balance
app.get('/store-balance', authenticateToken, async (req, res) => {
  try {
    // Get today's date
    const today = new Date().toISOString().split('T')[0];
    console.log('📊 Fetching store balance for date:', today);

    // Get all shifts for today and their opening balances + cash added
    let totalAdded = 0;
    try {
      const shiftsResult = await pool.query(
        `SELECT opening_balance, COALESCE(cash_added, 0) as cash_added
        FROM shift_management
        WHERE DATE(shift_start_time) = $1`,
        [today]
      );
      console.log('✅ Shifts result:', shiftsResult.rows.length, 'shifts found');

      // Calculate total added cash today
      if (shiftsResult.rows && shiftsResult.rows.length > 0) {
        totalAdded = shiftsResult.rows.reduce((sum, row) => {
          const opening = parseFloat(row.opening_balance) || 0;
          const cashAdded = parseFloat(row.cash_added) || 0;
          return sum + opening + cashAdded;
        }, 0);
      }
    } catch (queryErr) {
      console.warn('⚠️ Error getting shifts:', queryErr.message);
      totalAdded = 0;
    }

    // Get all cash outflows today (payments, redemptions, etc.)
    let totalPaid = 0;
    try {
      const paymentsResult = await pool.query(
        `SELECT COALESCE(SUM(amount_paid), 0) as total_paid
        FROM loan_payments
        WHERE DATE(payment_date) = $1`,
        [today]
      );
      console.log('✅ Payments result:', paymentsResult.rows[0]);
      totalPaid = parseFloat(paymentsResult.rows[0]?.total_paid || 0);
    } catch (queryErr) {
      console.warn('⚠️ Error getting payments:', queryErr.message);
      totalPaid = 0;
    }

    // Get the last closed shift balance
    let lastClosingBalance = 0;
    try {
      const lastShiftResult = await pool.query(
        `SELECT closing_balance 
        FROM shift_management
        WHERE shift_end_time IS NOT NULL
        ORDER BY shift_end_time DESC
        LIMIT 1`
      );
      console.log('✅ Last shift result:', lastShiftResult.rows.length > 0 ? 'found' : 'not found');
      lastClosingBalance = lastShiftResult.rows.length > 0 
        ? parseFloat(lastShiftResult.rows[0].closing_balance) || 0
        : 0;
    } catch (queryErr) {
      console.warn('⚠️ Error getting last shift:', queryErr.message);
      lastClosingBalance = 0;
    }

    // Calculate estimated current balance
    const estimatedBalance = parseFloat((lastClosingBalance + totalAdded - totalPaid).toFixed(2));

    console.log('📈 Balance calculated:', { estimatedBalance, totalAdded, totalPaid, lastClosingBalance });

    res.json({
      estimatedBalance,
      totalAddedToday: parseFloat(totalAdded.toFixed(2)),
      totalPaidOut: parseFloat(totalPaid.toFixed(2)),
      lastClosingBalance: parseFloat(lastClosingBalance.toFixed(2)),
      date: today
    });
  } catch (err) {
    console.error('❌ Error getting store balance:', err);
    res.status(500).json({ 
      message: 'Error getting store balance', 
      error: err.message 
    });
  }
});

// ======================== END SHIFT MANAGEMENT ========================

// ======================== CASH REPORT ========================

// GET CASH REPORT - Generate daily cash report
app.get('/cash-report', authenticateToken, async (req, res) => {
  const { date } = req.query;

  console.log('📊 /cash-report endpoint called with date:', date);

  try {
    // Validate date format
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      console.log('❌ Invalid date format:', date);
      return res.status(400).json({ message: 'Invalid date format. Use YYYY-MM-DD' });
    }

    // Parse the date
    const reportDate = new Date(date);
    if (isNaN(reportDate.getTime())) {
      console.log('❌ Invalid date:', date);
      return res.status(400).json({ message: 'Invalid date format. Use YYYY-MM-DD' });
    }

    // Format date for queries (YYYY-MM-DD)
    const dateStr = date;

    // 1. Get Pawn Activity (New Loans, Buys, Buyouts)
    console.log('🔍 Fetching new loans for date:', dateStr);
    const newLoansResult = await pool.query(
      `SELECT COUNT(*) as qty, COALESCE(SUM(loan_amount), 0) as amount
       FROM loans
       WHERE DATE(loan_issued_date) = $1 AND status NOT IN ('forfeited', 'redeemed')`,
      [dateStr]
    );
    console.log('✅ New loans result:', newLoansResult.rows[0]);

    const newLoans = {
      qty: parseInt(newLoansResult.rows[0].qty) || 0,
      amount: parseFloat(newLoansResult.rows[0].amount) || 0
    };

    // For Buys and Buyouts - these would need specific transaction types if tracked separately
    // For now, we'll set them to 0 (can be enhanced if buy/buyout logic is implemented)
    const buys = { qty: 0, amount: 0.00 };
    const buyouts = { qty: 0, amount: 0.00 };

    const inStoreTotal = {
      qty: newLoans.qty + buys.qty + buyouts.qty,
      amount: parseFloat((newLoans.amount + buys.amount + buyouts.amount).toFixed(2))
    };

    // 2. Get In-Store Transactions (Renewals, Partial Payments, Extensions, Redemptions)

    // Renewals
    const renewalsResult = await pool.query(
      `SELECT COUNT(*) as qty,
              COALESCE(SUM(l.loan_amount), 0) as principal,
              COALESCE(SUM(l.interest_amount), 0) as interest,
              0 as fees
       FROM loans l
       WHERE DATE(due_date) = $1 AND status = 'active'`,
      [dateStr]
    );

    const renewals = {
      qty: parseInt(renewalsResult.rows[0].qty) || 0,
      principal: parseFloat(renewalsResult.rows[0].principal) || 0,
      interest: parseFloat(renewalsResult.rows[0].interest) || 0,
      fees: 0.00,
      total: 0
    };
    renewals.total = parseFloat((renewals.principal + renewals.interest + renewals.fees).toFixed(2));

    // Partial Payments
    const partialPaymentsResult = await pool.query(
      `SELECT COUNT(*) as qty,
              COALESCE(SUM(ph.payment_amount), 0) as total,
              COALESCE(SUM(l.loan_amount * (ph.payment_amount / l.total_payable_amount)), 0) as principal,
              COALESCE(SUM(l.interest_amount * (ph.payment_amount / l.total_payable_amount)), 0) as interest
       FROM payment_history ph
       JOIN loans l ON ph.loan_id = l.id
       WHERE DATE(ph.payment_date) = $1 AND ph.payment_amount < l.total_payable_amount`,
      [dateStr]
    );

    const partialPayments = {
      qty: parseInt(partialPaymentsResult.rows[0].qty) || 0,
      principal: parseFloat(partialPaymentsResult.rows[0].principal) || 0,
      interest: parseFloat(partialPaymentsResult.rows[0].interest) || 0,
      fees: 0.00,
      total: parseFloat(partialPaymentsResult.rows[0].total) || 0
    };

    // Extensions (loans renewed/extended, not new loans created today)
    const extensionsResult = await pool.query(
      `SELECT COUNT(*) as qty,
              COALESCE(SUM(l.loan_amount), 0) as principal,
              COALESCE(SUM(l.interest_amount), 0) as interest,
              0 as fees
       FROM loans l
       WHERE DATE(updated_at) = $1 AND status = 'active' AND DATE(loan_issued_date) != $1`,
      [dateStr]
    );

    const extensions = {
      qty: parseInt(extensionsResult.rows[0].qty) || 0,
      principal: parseFloat(extensionsResult.rows[0].principal) || 0,
      interest: parseFloat(extensionsResult.rows[0].interest) || 0,
      fees: 0.00,
      total: 0
    };
    extensions.total = parseFloat((extensions.principal + extensions.interest + extensions.fees).toFixed(2));

    // Redemptions
    const redemptionsResult = await pool.query(
      `SELECT COUNT(*) as qty,
              COALESCE(SUM(l.loan_amount), 0) as principal,
              COALESCE(SUM(l.interest_amount), 0) as interest,
              0 as fees
       FROM loans l
       WHERE DATE(loan_issued_date) = $1 AND status = 'redeemed'`,
      [dateStr]
    );

    const redemptions = {
      qty: parseInt(redemptionsResult.rows[0].qty) || 0,
      principal: parseFloat(redemptionsResult.rows[0].principal) || 0,
      interest: parseFloat(redemptionsResult.rows[0].interest) || 0,
      fees: 0.00,
      total: 0
    };
    redemptions.total = parseFloat((redemptions.principal + redemptions.interest + redemptions.fees).toFixed(2));

    // In-Store Transactions Subtotal
    const inStoreTxnsSubtotal = {
      qty: renewals.qty + partialPayments.qty + extensions.qty + redemptions.qty,
      principal: parseFloat((renewals.principal + partialPayments.principal + extensions.principal + redemptions.principal).toFixed(2)),
      interest: parseFloat((renewals.interest + partialPayments.interest + extensions.interest + redemptions.interest).toFixed(2)),
      fees: parseFloat((renewals.fees + partialPayments.fees + extensions.fees + redemptions.fees).toFixed(2)),
      total: 0
    };
    inStoreTxnsSubtotal.total = parseFloat((inStoreTxnsSubtotal.principal + inStoreTxnsSubtotal.interest + inStoreTxnsSubtotal.fees).toFixed(2));

    // 3. Get Store Reconciliation (Expected vs Actual)
    const shiftResult = await pool.query(
      `SELECT id, opening_balance, closing_balance, expected_balance, is_balanced
       FROM shift_management
       WHERE DATE(shift_start_time) = $1
       ORDER BY shift_start_time DESC`,
      [dateStr]
    );

    const openStore = {
      online: { expected: 0.00, actual: 0.00, difference: 0.00 },
      till01: { expected: 0.00, actual: 0.00, difference: 0.00 },
      till02: { expected: 0.00, actual: 0.00, difference: 0.00 },
      storeSale: { expected: 0.00, actual: 0.00, difference: 0.00 }
    };

    let todayOpeningTotal = 0;
    let todayClosingTotal = 0;

    if (shiftResult.rows.length > 0) {
      const shift = shiftResult.rows[0];
      
      // Map shift data to store locations
      // This assumes shifts represent different store locations
      // Adjust logic based on your actual store structure
      const expectedBalance = parseFloat(shift.expected_balance) || 0;
      const actualBalance = parseFloat(shift.closing_balance) || 0;
      
      openStore.till01.expected = expectedBalance;
      openStore.till01.actual = actualBalance;
      openStore.till01.difference = parseFloat((actualBalance - expectedBalance).toFixed(2));
      
      todayOpeningTotal = parseFloat(shift.opening_balance) || 0;
      todayClosingTotal = actualBalance;
    }

     // Get Active Loan Count
     const activeLoanResult = await pool.query(
       `SELECT COUNT(*) as count FROM loans WHERE status = 'active'`
     );
     const activeLoanCount = parseInt(activeLoanResult.rows[0].count) || 0;

     // Get Overdue Loan Count
     const overdueLoanResult = await pool.query(
       `SELECT COUNT(*) as count FROM loans WHERE status = 'overdue'`
     );
     const overdueLoanCount = parseInt(overdueLoanResult.rows[0].count) || 0;

     // Build and return the report (even if empty)
     const report = {
       pawnActivity: {
         newLoans,
         buys,
         buyouts,
         inStoreTotal
       },
       inStoreTxns: {
         renewals,
         partialPayments,
         extensions,
         redemptions,
         subtotal: inStoreTxnsSubtotal
       },
       openStore,
       todayOpeningTotal: parseFloat(todayOpeningTotal.toFixed(2)),
       todayClosingTotal: parseFloat(todayClosingTotal.toFixed(2)),
       activeLoanCount,
       overdueLoanCount
     };
     res.json(report);
  } catch (err) {
    console.error('Error generating cash report:', err);
    res.status(500).json({ message: 'Error generating cash report', error: err.message });
  }
});

// ======================== END CASH REPORT ========================

// ======================== REVENUE REPORT ========================

// Get Revenue Report for date range
app.get('/revenue-report', async (req, res) => {
  const { startDate, endDate } = req.query;

  try {
    // Validate date format
    if (!startDate || !endDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      return res.status(400).json({ message: 'Invalid date format. Use YYYY-MM-DD' });
    }

    // Get all payments within the date range
    const paymentsResult = await pool.query(
      `SELECT 
         ph.loan_id, 
         ph.payment_amount, 
         ph.payment_date,
         l.loan_amount,
         l.interest_amount,
         l.total_payable_amount,
          l.status,
          l.due_date
        FROM payment_history ph
       JOIN loans l ON ph.loan_id = l.id
       WHERE DATE(ph.payment_date) BETWEEN $1 AND $2
       ORDER BY ph.payment_date DESC`,
      [startDate, endDate]
    );

    // Calculate revenue breakdown
    let totalRevenue = 0;
    let interestRevenue = 0;
    let principalReceived = 0;
    let feesCollected = 0;
    const revenueByLoan = {};

     // Revenue tracking by loan status
     let activeLoansRevenue = 0;
     let dueLoansRevenue = 0;
     let redeemedLoansRevenue = 0;
     let activeLoansInterest = 0;
     let dueLoansInterest = 0;
     let redeemedLoansInterest = 0;

    // Process each payment to calculate interest and principal portions
    for (const payment of paymentsResult.rows) {
      const loanId = payment.loan_id;
      const paymentAmount = parseFloat(payment.payment_amount) || 0;
      const loanAmount = parseFloat(payment.loan_amount) || 0;
      const interestAmount = parseFloat(payment.interest_amount) || 0;
      const totalPayable = parseFloat(payment.total_payable_amount) || 0;
       const loanStatus = payment.status;
       const dueDate = payment.due_date;

      // Calculate the ratio of interest in this payment
      // Interest portion = (interest / total payable) * payment amount
      const interestPortion = totalPayable > 0 ? (interestAmount / totalPayable) * paymentAmount : 0;
      const principalPortion = paymentAmount - interestPortion;

      interestRevenue += interestPortion;
      principalReceived += principalPortion;
      totalRevenue += paymentAmount;
       
       // Track by loan status
       if (loanStatus === 'active') {
         activeLoansRevenue += paymentAmount;
         activeLoansInterest += interestPortion;
       } else if (loanStatus === 'overdue') {
         dueLoansRevenue += paymentAmount;
         dueLoansInterest += interestPortion;
       } else if (loanStatus === 'redeemed') {
         redeemedLoansRevenue += paymentAmount;
         redeemedLoansInterest += interestPortion;
       }

      if (!revenueByLoan[loanId]) {
        revenueByLoan[loanId] = {
          interest: 0,
          principal: 0,
          total: 0,
          count: 0
        };
      }
      revenueByLoan[loanId].interest += interestPortion;
      revenueByLoan[loanId].principal += principalPortion;
      revenueByLoan[loanId].total += paymentAmount;
      revenueByLoan[loanId].count += 1;
    }

    // Round all values to 2 decimal places
    totalRevenue = parseFloat(totalRevenue.toFixed(2));
    interestRevenue = parseFloat(interestRevenue.toFixed(2));
    principalReceived = parseFloat(principalReceived.toFixed(2));
    feesCollected = parseFloat(feesCollected.toFixed(2));

     // Get Active Loan Count
     const activeLoanResult = await pool.query(
       `SELECT COUNT(*) as count FROM loans WHERE status = 'active'`
     );
     const activeLoanCount = parseInt(activeLoanResult.rows[0].count) || 0;

     // Get Overdue Loan Count
     const overdueLoanResult = await pool.query(
       `SELECT COUNT(*) as count FROM loans WHERE status = 'overdue'`
     );
     const overdueLoanCount = parseInt(overdueLoanResult.rows[0].count) || 0;

     const report = {
       totalRevenue,
       interestRevenue,
       principalReceived,
       feesCollected,
       interestCount: paymentsResult.rows.length,
       principalCount: paymentsResult.rows.length,
       feeCount: 0,
       paymentCount: paymentsResult.rows.length,
       activeLoanCount,
       overdueLoanCount,
        activeLoansRevenue: parseFloat(activeLoansRevenue.toFixed(2)),
        dueLoansRevenue: parseFloat(dueLoansRevenue.toFixed(2)),
        redeemedLoansRevenue: parseFloat(redeemedLoansRevenue.toFixed(2)),
        activeLoansInterest: parseFloat(activeLoansInterest.toFixed(2)),
        dueLoansInterest: parseFloat(dueLoansInterest.toFixed(2)),
        redeemedLoansInterest: parseFloat(redeemedLoansInterest.toFixed(2)),
       revenueByLoan
     };
     res.json(report);
  } catch (err) {
    console.error('Error generating revenue report:', err);
    res.status(500).json({ message: 'Error generating revenue report', error: err.message });
  }
});

// ======================== END REVENUE REPORT ========================

// ======================== PDF INVOICE GENERATION ========================

// Get Loan as PDF Invoice
app.get('/loan-pdf/:loanId', async (req, res) => {
  try {
    const { loanId } = req.params;

    // Validate loanId
    if (!loanId || loanId === 'undefined' || isNaN(loanId)) {
      console.error('Invalid loanId received:', loanId);
      return res.status(400).json({ message: 'Invalid loan ID provided' });
    }

    console.log('📄 PDF Request - Fetching loan ID:', loanId);

    // Fetch loan details with customer information
    const result = await pool.query(
      `SELECT 
        l.*,
        c.first_name,
        c.last_name
       FROM loans l
       LEFT JOIN customers c ON l.customer_id = c.id
       WHERE l.id = $1`,
      [loanId]
    );

    if (result.rows.length === 0) {
      console.warn(`Loan not found for ID: ${loanId}`);
      return res.status(404).json({ message: 'Loan not found' });
    }

    const loan = result.rows[0];

    // Log the data being sent to PDF generator
    console.log('📊 Loan data to be used in PDF:', {
      id: loan.id,
      transaction_number: loan.transaction_number,
      first_name: loan.first_name,
      last_name: loan.last_name,
      customer_name: loan.customer_name,
      loan_amount: loan.loan_amount,
      interest_rate: loan.interest_rate,
      total_payable_amount: loan.total_payable_amount
    });

    // Generate PDF
    const pdfBuffer = await generateLoanPDF(loan);

    // Send PDF with appropriate headers
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="loan_${loan.id}_${loan.transaction_number}.pdf"`
    );
    res.setHeader('Content-Length', pdfBuffer.length);

    res.send(pdfBuffer);
  } catch (err) {
    console.error('Error generating PDF:', err);
    res.status(500).json({ message: 'Error generating PDF', error: err.message });
  }
});

// Get Search Results as PDF (multiple loans on one document)
app.post('/loans-pdf', async (req, res) => {
  try {
    const { loanIds } = req.body;

    if (!loanIds || !Array.isArray(loanIds) || loanIds.length === 0) {
      return res.status(400).json({ message: 'Provide loanIds array' });
    }

    // Fetch all loans
    const placeholders = loanIds.map((_, i) => `$${i + 1}`).join(',');
    const result = await pool.query(`SELECT * FROM loans WHERE id IN (${placeholders})`, loanIds);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'No loans found' });
    }

    // Generate PDF for first loan (or create a summary if needed)
    const pdfBuffer = await generateLoanPDF(result.rows[0]);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="pawnflow_loans_${Date.now()}.pdf"`);
    res.setHeader('Content-Length', pdfBuffer.length);

    res.send(pdfBuffer);
  } catch (err) {
    console.error('Error generating PDFs:', err);
    res.status(500).json({ message: 'Error generating PDFs', error: err.message });
  }
});

// ======================== END PDF GENERATION ========================

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
  console.error('Stack:', err.stack);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  pool.end(() => {
    console.log('Database pool closed');
    process.exit(0);
  });
});

// ----------------------- DAILY CASH REPORT - BALANCING TAB -----------------------
// Get active loans and due loans report within a date range
app.get('/reports/daily-cash-balancing', authenticateToken, authorizeRole('admin', 'manager'), async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    // Validate date parameters
    if (!startDate || !endDate) {
      return res.status(400).json({ 
        message: 'startDate and endDate query parameters are required (YYYY-MM-DD format)' 
      });
    }

    // Parse dates
    const start = new Date(startDate);
    const end = new Date(endDate);

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return res.status(400).json({ 
        message: 'Invalid date format. Use YYYY-MM-DD' 
      });
    }

    // Get active loans created within the date range
    const activeLoansResult = await pool.query(
      `SELECT 
        COUNT(*) as loan_count,
        SUM(loan_amount) as total_loan_amount,
        SUM(total_payable_amount) as total_payable_amount,
        SUM(interest_amount) as total_interest_amount
      FROM loans 
      WHERE status = $1 
        AND DATE(loan_issued_date) >= $2 
        AND DATE(loan_issued_date) <= $3`,
      ['active', startDate, endDate]
    );

    // Get due loans (active loans with due date within range)
    const dueLoansResult = await pool.query(
      `SELECT 
        COUNT(*) as loan_count,
        SUM(loan_amount) as total_loan_amount,
        SUM(total_payable_amount) as total_payable_amount,
        SUM(interest_amount) as total_interest_amount,
        SUM(remaining_balance) as total_remaining_balance
      FROM loans 
      WHERE status = $1 
        AND DATE(due_date) <= $2
        AND DATE(due_date) >= $3`,
      ['active', endDate, startDate]
    );

    // Get payment details for the period
    const paymentsResult = await pool.query(
      `SELECT 
        COUNT(*) as payment_count,
        SUM(payment_amount) as total_payments
      FROM payment_history 
      WHERE DATE(payment_date) >= $1 
        AND DATE(payment_date) <= $2`,
      [startDate, endDate]
    );

    const activeLoans = activeLoansResult.rows[0];
    const dueLoans = dueLoansResult.rows[0];
    const payments = paymentsResult.rows[0];

    res.json({
      date_range: {
        start_date: startDate,
        end_date: endDate
      },
      active_loans: {
        count: parseInt(activeLoans.loan_count) || 0,
        total_loaned_amount: parseFloat(activeLoans.total_loan_amount) || 0,
        total_payable_amount: parseFloat(activeLoans.total_payable_amount) || 0,
        total_interest_amount: parseFloat(activeLoans.total_interest_amount) || 0,
        average_loan_amount: parseInt(activeLoans.loan_count) > 0 
          ? (parseFloat(activeLoans.total_loan_amount) / parseInt(activeLoans.loan_count)).toFixed(2)
          : 0
      },
      due_loans: {
        count: parseInt(dueLoans.loan_count) || 0,
        total_loan_amount: parseFloat(dueLoans.total_loan_amount) || 0,
        total_payable_amount: parseFloat(dueLoans.total_payable_amount) || 0,
        total_interest_amount: parseFloat(dueLoans.total_interest_amount) || 0,
        total_remaining_balance: parseFloat(dueLoans.total_remaining_balance) || 0,
        average_remaining_balance: parseInt(dueLoans.loan_count) > 0
          ? (parseFloat(dueLoans.total_remaining_balance) / parseInt(dueLoans.loan_count)).toFixed(2)
          : 0
      },
      payments: {
        count: parseInt(payments.payment_count) || 0,
        total_amount: parseFloat(payments.total_payments) || 0
      }
    });
  } catch (err) {
    console.error('Error generating daily cash balancing report:', err);
    res.status(500).json({ 
      message: 'Error generating daily cash balancing report', 
      error: err.message 
    });
  }
});

// Get detailed breakdown of active loans by status
app.get('/reports/active-loans-breakdown', authenticateToken, authorizeRole('admin', 'manager'), async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ 
        message: 'startDate and endDate query parameters are required' 
      });
    }

    // Get detailed active loans data
    const result = await pool.query(
      `SELECT 
        id,
        first_name,
        last_name,
        transaction_number,
        loan_amount,
        interest_amount,
        total_payable_amount,
        remaining_balance,
        loan_issued_date,
        due_date,
        status
      FROM loans 
      WHERE status = $1 
        AND DATE(loan_issued_date) >= $2 
        AND DATE(loan_issued_date) <= $3
      ORDER BY loan_issued_date DESC`,
      ['active', startDate, endDate]
    );

    res.json({
      count: result.rows.length,
      loans: result.rows.map(loan => ({
        id: loan.id,
        customer_name: `${loan.first_name} ${loan.last_name}`,
        transaction_number: loan.transaction_number,
        loan_amount: parseFloat(loan.loan_amount),
        interest_amount: parseFloat(loan.interest_amount),
        total_payable: parseFloat(loan.total_payable_amount),
        remaining_balance: parseFloat(loan.remaining_balance),
        issued_date: loan.loan_issued_date,
        due_date: loan.due_date,
        status: loan.status
      }))
    });
  } catch (err) {
    console.error('Error fetching active loans breakdown:', err);
    res.status(500).json({ 
      message: 'Error fetching active loans breakdown', 
      error: err.message 
    });
  }
});

// Get detailed breakdown of due loans
app.get('/reports/due-loans-breakdown', authenticateToken, authorizeRole('admin', 'manager'), async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ 
        message: 'startDate and endDate query parameters are required' 
      });
    }

    // Get detailed due loans data
    const result = await pool.query(
      `SELECT 
        id,
        first_name,
        last_name,
        transaction_number,
        loan_amount,
        interest_amount,
        total_payable_amount,
        remaining_balance,
        loan_issued_date,
        due_date,
        status
      FROM loans 
      WHERE status = $1 
        AND DATE(due_date) <= $2
        AND DATE(due_date) >= $3
      ORDER BY due_date ASC`,
      ['active', endDate, startDate]
    );

    res.json({
      count: result.rows.length,
      loans: result.rows.map(loan => ({
        id: loan.id,
        customer_name: `${loan.first_name} ${loan.last_name}`,
        transaction_number: loan.transaction_number,
        loan_amount: parseFloat(loan.loan_amount),
        interest_amount: parseFloat(loan.interest_amount),
        total_payable: parseFloat(loan.total_payable_amount),
        remaining_balance: parseFloat(loan.remaining_balance),
        issued_date: loan.loan_issued_date,
        due_date: loan.due_date,
        days_overdue: Math.floor((new Date() - new Date(loan.due_date)) / (1000 * 60 * 60 * 24)),
        status: loan.status
      }))
    });
  } catch (err) {
    console.error('Error fetching due loans breakdown:', err);
    res.status(500).json({ 
      message: 'Error fetching due loans breakdown', 
      error: err.message 
    });
  }
});

// Get detailed breakdown of today's loans (or custom date range)
app.get('/reports/todays-loans-breakdown', authenticateToken, authorizeRole('admin', 'manager'), async (req, res) => {
  try {
    let startDate, endDate;
    const { startDate: queryStart, endDate: queryEnd } = req.query;

    // Use custom date range if provided, otherwise use today
    if (queryStart && queryEnd) {
      startDate = queryStart;
      endDate = queryEnd;
    } else {
      const today = new Date().toISOString().split('T')[0];
      startDate = today;
      endDate = today;
    }

    // Get detailed loans data with customer info from customers table
    const result = await pool.query(
      `SELECT 
        l.id,
        l.transaction_number,
        l.loan_amount,
        l.collateral_description,
        l.item_description,
        l.loan_issued_date,
        l.due_date,
        l.status,
        c.first_name,
        c.last_name,
        c.mobile_phone,
        c.home_phone,
        c.email
      FROM loans l
      LEFT JOIN customers c ON l.customer_id = c.id
      WHERE DATE(l.loan_issued_date) >= $1 
        AND DATE(l.loan_issued_date) <= $2
      ORDER BY l.loan_issued_date DESC`,
      [startDate, endDate]
    );

    console.log('📊 Loans breakdown query result:', {
      count: result.rows.length,
      firstLoan: result.rows[0] ? {
        first_name: result.rows[0].first_name,
        last_name: result.rows[0].last_name,
        mobile_phone: result.rows[0].mobile_phone,
        home_phone: result.rows[0].home_phone,
        collateral_description: result.rows[0].collateral_description,
        item_description: result.rows[0].item_description
      } : 'No loans found'
    });

    res.json({
      count: result.rows.length,
      startDate: startDate,
      endDate: endDate,
      loans: result.rows.map(loan => {
        // Build customer name from customer table
        const firstName = loan.first_name ? loan.first_name.trim() : '';
        const lastName = loan.last_name ? loan.last_name.trim() : '';
        const customerName = (firstName && lastName) ? `${firstName} ${lastName}` : 'Unknown Customer';

        // Use collateral_description, or fallback to item_description
        const collateralDescValue = loan.collateral_description ? loan.collateral_description.trim() : '';
        const itemDescValue = loan.item_description ? loan.item_description.trim() : '';
        const collateralDesc = collateralDescValue || itemDescValue || 'N/A';

        // Handle phone number - get from customer table
        const mobilePhone = loan.mobile_phone ? loan.mobile_phone.trim() : '';
        const homePhone = loan.home_phone ? loan.home_phone.trim() : '';
        const phoneNumber = mobilePhone || homePhone || 'N/A';

        return {
          id: loan.id,
          customer_name: customerName,
          transaction_number: loan.transaction_number,
          loan_amount: parseFloat(loan.loan_amount),
          collateral_description: collateralDesc,
          issued_date: loan.loan_issued_date,
          due_date: loan.due_date,
          phone_number: phoneNumber,
          status: loan.status
        };
      })
    });
  } catch (err) {
    console.error('Error fetching loans breakdown:', err);
    res.status(500).json({ 
      message: 'Error fetching loans breakdown', 
      error: err.message 
    });
  }
});

// ---------------------------- START SERVER ----------------------------

// Active Loans Report
app.get('/reports/active-loans', authenticateToken, authorizeRole('admin', 'manager'), async (req, res) => {
  try {
    // First, let's check what statuses exist
    const statusCheck = await pool.query(`
      SELECT DISTINCT status, COUNT(*) as count FROM loans GROUP BY status
    `);
    console.log('📌 Loan Statuses in DB:', statusCheck.rows);

    const query = `
      SELECT 
        l.id,
        l.transaction_number,
        l.loan_amount,
        l.collateral_description,
        l.item_description,
        l.loan_issued_date,
        l.due_date,
        l.status,
        c.first_name,
        c.last_name,
        c.mobile_phone,
        c.home_phone
      FROM loans l
      LEFT JOIN customers c ON l.customer_id = c.id
      WHERE LOWER(l.status) = 'active'
      ORDER BY l.loan_issued_date DESC
    `;

    const result = await pool.query(query);
    
    console.log('📊 Active Loans Query Result:', {
      count: result.rows.length,
      firstLoan: result.rows[0] ? {
        id: result.rows[0].id,
        transaction_number: result.rows[0].transaction_number,
        first_name: result.rows[0].first_name,
        last_name: result.rows[0].last_name,
        mobile_phone: result.rows[0].mobile_phone,
        home_phone: result.rows[0].home_phone,
        collateral_description: result.rows[0].collateral_description,
        item_description: result.rows[0].item_description,
        loan_amount: result.rows[0].loan_amount,
        loan_issued_date: result.rows[0].loan_issued_date
      } : 'No loans found'
    });
    
    res.json({
      count: result.rows.length,
      loans: result.rows.map(loan => {
        // Build customer name from customer table
        const firstName = loan.first_name ? loan.first_name.trim() : '';
        const lastName = loan.last_name ? loan.last_name.trim() : '';
        const customerName = (firstName && lastName) ? `${firstName} ${lastName}` : (firstName || lastName || 'Unknown Customer');

        // Use collateral_description, or fallback to item_description
        const collateralDescValue = loan.collateral_description ? loan.collateral_description.trim() : '';
        const itemDescValue = loan.item_description ? loan.item_description.trim() : '';
        const collateralDesc = collateralDescValue || itemDescValue || 'N/A';

        // Handle phone number - get from customer table
        const mobilePhone = loan.mobile_phone ? loan.mobile_phone.trim() : '';
        const homePhone = loan.home_phone ? loan.home_phone.trim() : '';
        const phoneNumber = mobilePhone || homePhone || 'N/A';

        return {
          id: loan.id,
          customer_name: customerName,
          transaction_number: loan.transaction_number || 'N/A',
          loan_amount: loan.loan_amount,
          collateral_description: collateralDesc,
          issued_date: loan.loan_issued_date,
          due_date: loan.due_date,
          phone_number: phoneNumber,
          status: loan.status
        };
      })
    });
  } catch (err) {
    console.error('❌ Error fetching active loans:', err);
    res.status(500).json({ message: 'Error fetching active loans' });
  }
});

// Overdue Loans Report
app.get('/reports/overdue-loans', authenticateToken, authorizeRole('admin', 'manager'), async (req, res) => {
  try {
    const query = `
      SELECT 
        l.id,
        l.transaction_number,
        l.loan_amount,
        l.collateral_description,
        l.item_description,
        l.loan_issued_date,
        l.due_date,
        l.status,
        c.first_name,
        c.last_name,
        c.mobile_phone,
        c.home_phone
      FROM loans l
      LEFT JOIN customers c ON l.customer_id = c.id
      WHERE LOWER(l.status) = 'overdue'
      ORDER BY l.due_date ASC
    `;

    const result = await pool.query(query);
    
    console.log('📊 Overdue Loans Query Result:', {
      count: result.rows.length,
      firstLoan: result.rows[0] ? {
        id: result.rows[0].id,
        transaction_number: result.rows[0].transaction_number,
        first_name: result.rows[0].first_name,
        last_name: result.rows[0].last_name,
        mobile_phone: result.rows[0].mobile_phone,
        home_phone: result.rows[0].home_phone,
        collateral_description: result.rows[0].collateral_description,
        item_description: result.rows[0].item_description,
        loan_amount: result.rows[0].loan_amount,
        loan_issued_date: result.rows[0].loan_issued_date,
        due_date: result.rows[0].due_date
      } : 'No loans found'
    });
    
    res.json({
      count: result.rows.length,
      loans: result.rows.map(loan => {
        // Build customer name from customer table
        const firstName = loan.first_name ? loan.first_name.trim() : '';
        const lastName = loan.last_name ? loan.last_name.trim() : '';
        const customerName = (firstName && lastName) ? `${firstName} ${lastName}` : (firstName || lastName || 'Unknown Customer');

        // Use collateral_description, or fallback to item_description
        const collateralDescValue = loan.collateral_description ? loan.collateral_description.trim() : '';
        const itemDescValue = loan.item_description ? loan.item_description.trim() : '';
        const collateralDesc = collateralDescValue || itemDescValue || 'N/A';

        // Handle phone number - get from customer table
        const mobilePhone = loan.mobile_phone ? loan.mobile_phone.trim() : '';
        const homePhone = loan.home_phone ? loan.home_phone.trim() : '';
        const phoneNumber = mobilePhone || homePhone || 'N/A';

        return {
          id: loan.id,
          customer_name: customerName,
          transaction_number: loan.transaction_number || 'N/A',
          loan_amount: loan.loan_amount,
          collateral_description: collateralDesc,
          issued_date: loan.loan_issued_date,
          due_date: loan.due_date,
          phone_number: phoneNumber,
          status: loan.status
        };
      })
    });
  } catch (err) {
    console.error('❌ Error fetching overdue loans:', err);
    res.status(500).json({ message: 'Error fetching overdue loans' });
  }
});

// Overdue Loans Report
app.get('/reports/overdue-loans', authenticateToken, authorizeRole('admin', 'manager'), async (req, res) => {
  try {
    // Select overdue loans: status explicitly 'overdue' OR due_date in the past and not closed
    const query = `
      SELECT
        l.id,
        l.transaction_number,
        l.loan_amount,
        l.collateral_description,
        l.item_description,
        l.loan_issued_date,
        l.due_date,
        l.status,
        c.first_name,
        c.last_name,
        c.mobile_phone,
        c.home_phone
      FROM loans l
      LEFT JOIN customers c ON l.customer_id = c.id
      WHERE LOWER(l.status) = 'overdue' OR (l.due_date < CURRENT_DATE AND LOWER(l.status) != 'closed')
      ORDER BY l.due_date ASC
    `;

    const result = await pool.query(query);

    console.log('📊 Overdue Loans Query Result:', {
      count: result.rows.length,
      firstLoan: result.rows[0] ? {
        id: result.rows[0].id,
        transaction_number: result.rows[0].transaction_number,
        first_name: result.rows[0].first_name,
        last_name: result.rows[0].last_name,
        mobile_phone: result.rows[0].mobile_phone,
        home_phone: result.rows[0].home_phone,
        collateral_description: result.rows[0].collateral_description,
        item_description: result.rows[0].item_description,
        loan_amount: result.rows[0].loan_amount,
        loan_issued_date: result.rows[0].loan_issued_date,
        due_date: result.rows[0].due_date
      } : 'No loans found'
    });

    res.json({
      count: result.rows.length,
      loans: result.rows.map(loan => {
        // Build customer name
        const firstName = loan.first_name ? loan.first_name.trim() : '';
        const lastName = loan.last_name ? loan.last_name.trim() : '';
        const customerName = (firstName && lastName) ? `${firstName} ${lastName}` : (firstName || lastName || 'Unknown Customer');

        // Collateral description fallback
        const collateralDescValue = loan.collateral_description ? loan.collateral_description.trim() : '';
        const itemDescValue = loan.item_description ? loan.item_description.trim() : '';
        const collateralDesc = collateralDescValue || itemDescValue || 'N/A';

        // Phone fallback
        const mobilePhone = loan.mobile_phone ? loan.mobile_phone.trim() : '';
        const homePhone = loan.home_phone ? loan.home_phone.trim() : '';
        const phoneNumber = mobilePhone || homePhone || 'N/A';

        return {
          id: loan.id,
          customer_name: customerName,
          transaction_number: loan.transaction_number || 'N/A',
          loan_amount: loan.loan_amount,
          collateral_description: collateralDesc,
          issued_date: loan.loan_issued_date,
          due_date: loan.due_date,
          phone_number: phoneNumber,
          status: loan.status
        };
      })
    });
  } catch (err) {
    console.error('❌ Error fetching overdue loans:', err);
    res.status(500).json({ message: 'Error fetching overdue loans' });
  }
});

// ========================= LOAN PDF RECEIPT DOWNLOAD =========================
// Endpoint to re-download loan receipt PDF
app.get('/api/loans/:loanId/receipt', authenticateToken, async (req, res) => {
  const { loanId } = req.params;

  try {
    // Validate loan ID
    const parsedLoanId = parseInt(loanId, 10);
    if (isNaN(parsedLoanId)) {
      return res.status(400).json({ message: 'Invalid loan ID format' });
    }

    // Fetch loan details from database with customer information
    const loanResult = await pool.query(
      `SELECT 
        l.*,
        c.first_name,
        c.last_name
       FROM loans l
       LEFT JOIN customers c ON l.customer_id = c.id
       WHERE l.id = $1`,
      [parsedLoanId]
    );

    if (loanResult.rows.length === 0) {
      return res.status(404).json({ message: 'Loan not found' });
    }

    let loan = loanResult.rows[0];

    // Check if interest has been paid and due date should be extended
    const paymentHistoryResult = await pool.query(
      'SELECT SUM(payment_amount) as total_paid FROM payment_history WHERE loan_id = $1',
      [parsedLoanId]
    );
    const totalPaid = parseFloat(paymentHistoryResult.rows[0].total_paid || 0);
    const interestAmount = parseFloat(loan.interest_amount || 0);

    // If interest is paid but due date hasn't been extended yet, extend it now
    if (totalPaid >= interestAmount && loan.due_date) {
      const dueDate = new Date(loan.due_date);
      const currentDueDate = new Date(dueDate);
      
      // Check if due date is still the original (hasn't been extended)
      // We do this by checking if extending it 30 days would be different
      const oneMonthFromNow = new Date(currentDueDate);
      oneMonthFromNow.setDate(oneMonthFromNow.getDate() + 30);
      
      // Get the original loan creation date to see if this might be first extension
      const loanCreatedDate = new Date(loan.created_at);
      const daysSinceCreated = Math.floor((currentDueDate - loanCreatedDate) / (1000 * 60 * 60 * 24));
      
      // If it appears this is the original due date (hasn't been extended), extend it
      if (daysSinceCreated < 45) { // Original loan term is typically 30 days, so less than 45 days suggests original date
        const extended = new Date(dueDate);
        extended.setDate(extended.getDate() + 30);
        // Format date as YYYY-MM-DD string for PostgreSQL
        const year = extended.getFullYear();
        const month = String(extended.getMonth() + 1).padStart(2, '0');
        const day = String(extended.getDate()).padStart(2, '0');
        const newDueDate = `${year}-${month}-${day}`;
        
        // Update the due date in database
        const updatedResult = await pool.query(
          'UPDATE loans SET due_date = $1 WHERE id = $2 RETURNING *',
          [newDueDate, parsedLoanId]
        );
        loan = updatedResult.rows[0];
        console.log('📅 Due date extended on receipt download. Old:', dueDate, 'New:', newDueDate);
      }
    }

    console.log('📄 Generating receipt PDF for loan:', {
      id: loan.id,
      transaction_number: loan.transaction_number,
      customer_name_field: loan.customer_name,
      first_name: loan.first_name,
      last_name: loan.last_name,
      loan_amount: loan.loan_amount,
      due_date: loan.due_date
    });

    // Generate PDF using existing PDF generator
    let pdfBuffer;
    try {
      pdfBuffer = await generateLoanPDF(loan);
    } catch (pdfError) {
      // Always log full error details to console for Railway debugging
      console.error('❌❌❌ PDF GENERATION FAILED ❌❌❌');
      console.error('Message:', pdfError.message);
      console.error('Type:', pdfError.name);
      console.error('Stack:', pdfError.stack);
      console.error('Loan:', { id: loan.id, amount: loan.loan_amount });
      console.error('Full error:', pdfError);
      
      return res.status(500).json({ 
        message: 'Failed to generate PDF',
        error: process.env.NODE_ENV === 'development' ? pdfError.message : 'PDF generation error',
        loanId: loan.id,
        env: process.env.NODE_ENV,
        errorMessage: pdfError.message // Always include message in response for debugging
      });
    }

    if (!pdfBuffer || pdfBuffer.length === 0) {
      console.error('❌ PDF buffer is empty');
      return res.status(500).json({ message: 'Failed to generate PDF - empty buffer' });
    }

    // Send PDF as download
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="loan_receipt_${loan.transaction_number || loan.id}.pdf"`
    );
    res.setHeader('Content-Length', pdfBuffer.length);
    res.send(pdfBuffer);

    console.log('✅ Receipt PDF sent successfully for loan:', loan.id, '(', pdfBuffer.length, 'bytes)');
  } catch (err) {
    console.error('❌ Error generating receipt PDF:', err.message);
    console.error('   Full error:', err);
    console.error('   Stack:', err.stack);
    res.status(500).json({ 
      message: 'Error generating receipt PDF',
      error: process.env.NODE_ENV === 'development' ? err.message : 'An error occurred'
    });
  }
});

// Add Express-level error handling middleware BEFORE server starts
app.use((err, req, res, next) => {
  console.error('💥 EXPRESS ERROR:', err.message);
  console.error('Stack:', err.stack);
  res.status(500).json({ 
    message: 'Internal server error', 
    error: process.env.NODE_ENV === 'development' ? err.message : 'An error occurred'
  });
});

// Catch 404 errors
app.use((req, res) => {
  console.warn('⚠️  404 Not Found:', req.method, req.path);
  res.status(404).json({ message: 'Endpoint not found', path: req.path });
});

// Add process-level error handling FIRST
process.on('uncaughtException', (err) => {
  console.error('💥 UNCAUGHT EXCEPTION:', err.message);
  console.error('Stack:', err.stack);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 UNHANDLED REJECTION at:', promise);
  console.error('Reason:', reason);
  process.exit(1);
});

// ======================== HELPER FUNCTION: SEND DUE DATE REMINDER EMAIL ========================

async function sendDueDateReminderEmail(loanId, pool, emailTransporter) {
  try {
    const loanResult = await pool.query(
      `SELECT l.*, c.first_name, c.last_name, c.email, c.mobile_phone
       FROM loans l
       JOIN customers c ON l.customer_id = c.id
       WHERE l.id = $1`,
      [loanId]
    );

    if (loanResult.rows.length === 0) {
      return { success: false, message: 'Loan not found' };
    }

    const loan = loanResult.rows[0];

    // Validate email
    if (!loan.email) {
      return { success: false, message: 'No email address on file for customer' };
    }

    // Get payment history to calculate amount paid
    const paymentResult = await pool.query(
      'SELECT SUM(payment_amount) AS total_paid FROM payment_history WHERE loan_id = $1',
      [loanId]
    );
    const totalPaid = paymentResult.rows[0].total_paid || 0;

    // Calculate remaining balance and days until due
    const remainingBalance = loan.interest_amount - totalPaid;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dueDate = new Date(loan.due_date);
    const daysUntilDue = Math.ceil((dueDate - today) / (1000 * 60 * 60 * 24));

    // Prepare email content
    const customerName = `${loan.first_name} ${loan.last_name}`;
    const emailSubject = `⏰ Loan Due Date Reminder - Your Loan is Due in ${daysUntilDue} Day${daysUntilDue !== 1 ? 's' : ''}`;

    const emailHTML = `
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; color: #333; line-height: 1.6; }
            .container { max-width: 600px; margin: 0 auto; background-color: #f9f9f9; padding: 20px; border-radius: 8px; }
            .header { background-color: #1a1a1a; color: #fff; padding: 20px; border-radius: 8px 8px 0 0; text-align: center; }
            .content { background-color: #fff; padding: 20px; }
            .loan-details { background-color: #f0f0f0; padding: 15px; border-radius: 5px; margin: 15px 0; }
            .detail-row { display: flex; justify-content: space-between; margin: 8px 0; }
            .detail-label { font-weight: bold; }
            .footer { text-align: center; color: #666; font-size: 12px; margin-top: 20px; padding-top: 20px; border-top: 1px solid #ddd; }
            .warning { color: #d32f2f; font-weight: bold; }
            .important { background-color: #fff3cd; padding: 10px; border-radius: 5px; margin: 15px 0; border-left: 4px solid #ffc107; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>🔔 Loan Due Date Reminder</h1>
            </div>
            <div class="content">
              <p>Dear ${customerName},</p>
              
              <p>This is a friendly reminder that your loan payment is due in <span class="warning">${daysUntilDue} day${daysUntilDue !== 1 ? 's' : ''}</span>.</p>
              
              <h3>📋 Loan Details:</h3>
              <div class="loan-details">
                <div class="detail-row">
                  <span class="detail-label">Loan ID:</span>
                  <span>${loan.id}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">Item Pawned:</span>
                  <span>${loan.item_description || 'N/A'}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">Loan Amount:</span>
                  <span>$${parseFloat(loan.loan_amount).toFixed(2)}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">Interest Amount:</span>
                  <span>$${parseFloat(loan.interest_amount).toFixed(2)}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">Amount Paid:</span>
                  <span>$${parseFloat(totalPaid).toFixed(2)}</span>
                </div>
                <div class="detail-row" style="font-weight: bold; border-top: 1px solid #ddd; padding-top: 8px; margin-top: 8px;">
                  <span class="detail-label">Remaining Balance Due:</span>
                  <span>$${parseFloat(remainingBalance).toFixed(2)}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">Due Date:</span>
                  <span>${dueDate.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</span>
                </div>
              </div>
              
              <div class="important">
                <strong>⚠️ Important:</strong> Please ensure payment is made by the due date to avoid additional fees or penalties. Your loan will be marked as overdue if not paid by ${dueDate.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}.
              </div>
              
              <p>If you have any questions or need to make a payment, please contact us immediately at your earliest convenience.</p>
              
              <p>Thank you for your business!</p>
              
              <p style="color: #666; font-size: 14px;">Best regards,<br><strong>PawnFlow - Pawn Shop Management System</strong></p>
            </div>
            <div class="footer">
              <p>This is an automated reminder email. Please do not reply to this email. Contact the pawn shop directly for assistance.</p>
            </div>
          </div>
        </body>
      </html>
    `;

    // Send email
    const mailOptions = {
      from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
      to: loan.email,
      subject: emailSubject,
      html: emailHTML,
    };

    await emailTransporter.sendMail(mailOptions);
    return { success: true, message: `Email sent successfully to ${loan.email}` };
  } catch (err) {
    console.error('Error sending email:', err);
    return { success: false, message: err.message };
  }
}

// ======================== ENDPOINT: SEND DUE DATE REMINDER EMAIL (Manual) ========================

app.post('/send-due-date-reminder/:loanId', authenticateToken, async (req, res) => {
  try {
    const { loanId } = req.params;

    // Verify loan exists
    const loanResult = await pool.query('SELECT * FROM loans WHERE id = $1', [loanId]);
    if (loanResult.rows.length === 0) {
      return res.status(404).json({ message: 'Loan not found' });
    }

    // Send the reminder email
    const result = await sendDueDateReminderEmail(loanId, pool, emailTransporter);

    if (result.success) {
      return res.status(200).json({ message: result.message });
    } else {
      return res.status(400).json({ message: result.message });
    }
  } catch (err) {
    console.error('Error in send-due-date-reminder endpoint:', err);
    res.status(500).json({ message: 'Internal server error', error: err.message });
  }
});

// ======================== ENDPOINT: SEND REMINDERS FOR ALL UPCOMING LOANS ========================

app.post('/send-all-due-date-reminders', authenticateToken, async (req, res) => {
  try {
    console.log('🔔 Manual trigger: Sending all due date reminders...');

    // Calculate date range: today to 7 days from now
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const sevenDaysLater = new Date(today);
    sevenDaysLater.setDate(sevenDaysLater.getDate() + 7);
    sevenDaysLater.setHours(23, 59, 59, 999);

    // Query for active loans with due dates within next 7 days
    const result = await pool.query(
      `SELECT l.*, c.first_name, c.last_name, c.email
       FROM loans l
       JOIN customers c ON l.customer_id = c.id
       WHERE l.status = $1 
       AND l.due_date >= $2 
       AND l.due_date <= $3
       AND c.email IS NOT NULL
       AND c.email != ''`,
      ['active', today.toISOString().split('T')[0], sevenDaysLater.toISOString().split('T')[0]]
    );

    const loansUpcoming = result.rows;
    let successCount = 0;
    let failureCount = 0;

    // Send email for each loan
    for (let loan of loansUpcoming) {
      const emailResult = await sendDueDateReminderEmail(loan.id, pool, emailTransporter);
      if (emailResult.success) {
        successCount++;
      } else {
        failureCount++;
      }
    }

    res.status(200).json({
      message: 'Due date reminder emails processed',
      totalLoans: loansUpcoming.length,
      successCount,
      failureCount,
      details: `Successfully sent ${successCount} emails. Failed to send ${failureCount} emails.`
    });
  } catch (err) {
    console.error('Error in send-all-due-date-reminders endpoint:', err);
    res.status(500).json({ message: 'Internal server error', error: err.message });
  }
});

// Initialize database schema if needed
// Function to run all migrations
async function runMigrations() {
  const fs = require('fs');
  const path = require('path');
  
  try {
    console.log('🔄 Running automatic migrations on startup...\n');
    
    const migrationsDir = path.join(__dirname, 'migrations');
    
    if (!fs.existsSync(migrationsDir)) {
      console.log('⚠️  No migrations directory found');
      return;
    }
    
    // Create migrations tracking table if it doesn't exist
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS migrations (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL UNIQUE,
          executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);
    } catch (err) {
      console.warn('⚠️  Could not create migrations table:', err.message);
    }
    
    // Get all migration files (both SQL and JS)
    const sqlFiles = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();
    
    const jsFiles = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.js'))
      .sort();

    const allFiles = [...sqlFiles, ...jsFiles];
    console.log(`📁 Found ${allFiles.length} migration files (${sqlFiles.length} SQL, ${jsFiles.length} JS)\n`);

    if (allFiles.length === 0) {
      console.log('✨ No migrations to run');
      return;
    }

    // Get list of already executed migrations
    let executedMigrations = new Set();
    try {
      const result = await pool.query('SELECT name FROM migrations;');
      executedMigrations = new Set(result.rows.map(r => r.name));
    } catch (err) {
      console.warn('⚠️  Could not query migrations table:', err.message);
    }

    // Run SQL migrations
    for (const file of sqlFiles) {
      if (executedMigrations.has(file)) {
        console.log(`⏭️  Skipping ${file} (already executed)`);
        continue;
      }

      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, 'utf8');
      
      console.log(`⏳ Running: ${file}`);
      
      try {
        await pool.query(sql);
        // Record migration as executed
        await pool.query(
          'INSERT INTO migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING',
          [file]
        );
        console.log(`✅ Completed: ${file}\n`);
      } catch (err) {
        if (err.message.includes('already exists') || err.message.includes('duplicate key')) {
          console.log(`⚠️  ${file} (already applied): ${err.message.substring(0, 50)}\n`);
        } else {
          console.warn(`⚠️  Error in ${file}: ${err.message}\n`);
        }
      }
    }

    // Run JavaScript migrations
    for (const file of jsFiles) {
      if (executedMigrations.has(file)) {
        console.log(`⏭️  Skipping ${file} (already executed)`);
        continue;
      }

      const filePath = path.join(migrationsDir, file);
      console.log(`⏳ Running: ${file}`);
      
      try {
        const migration = require(filePath);
        
        if (typeof migration.runMigration === 'function') {
          await migration.runMigration();
        }
        
        // Record migration as executed
        await pool.query(
          'INSERT INTO migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING',
          [file]
        );
        console.log(`✅ Completed: ${file}\n`);
      } catch (err) {
        console.warn(`⚠️  Error in ${file}: ${err.message}\n`);
      }
    }
    
    console.log('✨ All migrations completed!');
  } catch (err) {
    console.error('❌ Migration error:', err);
    throw err;
  }
}







































