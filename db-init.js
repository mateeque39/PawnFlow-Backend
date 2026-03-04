/**
 * Database Initialization Module
 * Automatically creates all tables on first deployment to Railway
 * Run this during server startup to ensure database schema exists
 */

const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

// Database initialization schema
const DATABASE_SCHEMA = `
-- DO NOT DROP TABLES - Only create if they don't exist
-- This prevents data loss and allows incremental schema updates

-- Create user_roles table first (referenced by users)
CREATE TABLE IF NOT EXISTS user_roles (
    id SERIAL PRIMARY KEY,
    role_name VARCHAR(50) NOT NULL UNIQUE
);

-- Create users table (referenced by other tables)
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(100) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL,
    role_id INTEGER NOT NULL REFERENCES user_roles(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create loans table (referenced by most history tables)
CREATE TABLE IF NOT EXISTS loans (
    id SERIAL PRIMARY KEY,
    customer_id INTEGER,
    customer_name VARCHAR(100) NOT NULL,
    customer_number VARCHAR(50),
    loan_amount NUMERIC NOT NULL,
    initial_loan_amount NUMERIC NOT NULL,
    interest_rate NUMERIC NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    first_name VARCHAR(100),
    last_name VARCHAR(100),
    email VARCHAR(255),
    home_phone VARCHAR(20),
    mobile_phone VARCHAR(20),
    birthdate DATE,
    referral VARCHAR(255),
    identification_info TEXT,
    address TEXT,
    street_address TEXT,
    city VARCHAR(128),
    state VARCHAR(64),
    zipcode VARCHAR(32),
    interest_amount NUMERIC(10,2),
    total_payable_amount NUMERIC(10,2),
    recurring_fee NUMERIC(10,2) DEFAULT 0,
    collateral_description TEXT,
    collateral_image TEXT,
    customer_note TEXT,
    loan_issued_date DATE,
    loan_term INTEGER,
    remaining_balance NUMERIC(10,2),
    created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_by_username VARCHAR(100),
    transaction_number VARCHAR(100) UNIQUE,
    issued_date DATE,
    redeemed_date DATE,
    forfeited_date DATE,
    is_redeemed BOOLEAN DEFAULT FALSE,
    is_forfeited BOOLEAN DEFAULT FALSE,
    item_category VARCHAR(100),
    item_description TEXT,
    updated_at TIMESTAMP,
    due_date DATE,
    status VARCHAR(50) DEFAULT 'active',
    id_type VARCHAR(50),
    id_number VARCHAR(100)
);

-- Create loans_backup table
CREATE TABLE IF NOT EXISTS loans_backup (
    id INTEGER,
    customer_name VARCHAR(100),
    customer_number VARCHAR(50),
    loan_amount NUMERIC,
    interest_rate NUMERIC,
    created_at TIMESTAMP,
    created_by INTEGER,
    first_name VARCHAR(100),
    last_name VARCHAR(100),
    email VARCHAR(255),
    home_phone VARCHAR(20),
    mobile_phone VARCHAR(20),
    birthdate DATE,
    referral VARCHAR(255),
    identification_info TEXT,
    address TEXT,
    street_address TEXT,
    city VARCHAR(128),
    state VARCHAR(64),
    zipcode VARCHAR(32),
    interest_amount NUMERIC(10,2),
    total_payable_amount NUMERIC(10,2),
    collateral_description TEXT,
    customer_note TEXT,
    loan_issued_date DATE,
    loan_term INTEGER,
    remaining_balance NUMERIC(10,2),
    created_by_user_id INTEGER,
    created_by_username VARCHAR(100),
    transaction_number VARCHAR(100),
    issued_date DATE,
    redeemed_date DATE,
    forfeited_date DATE,
    is_redeemed BOOLEAN,
    is_forfeited BOOLEAN,
    item_category VARCHAR(100),
    item_description TEXT,
    updated_at TIMESTAMP,
    due_date DATE,
    status VARCHAR(50)
);

-- Create payment_history table
CREATE TABLE IF NOT EXISTS payment_history (
    id SERIAL PRIMARY KEY,
    loan_id INTEGER NOT NULL REFERENCES loans(id),
    payment_method VARCHAR(50) NOT NULL,
    payment_amount NUMERIC NOT NULL,
    payment_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

-- Create payments table
CREATE TABLE IF NOT EXISTS payments (
    id SERIAL PRIMARY KEY,
    loan_id INTEGER NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
    payment_amount NUMERIC(14,2) NOT NULL,
    payment_method VARCHAR(64),
    payment_date TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    processed_by_user_id INTEGER,
    processed_by_username VARCHAR(128),
    note TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create loan_payments table (for daily balance calculations)
CREATE TABLE IF NOT EXISTS loan_payments (
    id SERIAL PRIMARY KEY,
    loan_id INTEGER NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
    amount_paid NUMERIC(14,2) NOT NULL,
    payment_date TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    payment_method VARCHAR(64),
    processed_by_user_id INTEGER,
    processed_by_username VARCHAR(128),
    note TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create forfeiture_history table
CREATE TABLE IF NOT EXISTS forfeiture_history (
    id SERIAL PRIMARY KEY,
    loan_id INTEGER NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
    forfeited_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by INTEGER REFERENCES users(id),
    notes VARCHAR(500)
);

-- Create redeem_history table
CREATE TABLE IF NOT EXISTS redeem_history (
    id SERIAL PRIMARY KEY,
    loan_id INTEGER NOT NULL REFERENCES loans(id),
    redeemed_by INTEGER NOT NULL REFERENCES users(id),
    redeemed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create redemption_history table
CREATE TABLE IF NOT EXISTS redemption_history (
    id SERIAL PRIMARY KEY,
    loan_id INTEGER NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
    redeemed_amount NUMERIC(10,2),
    redeemed_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by INTEGER REFERENCES users(id),
    notes VARCHAR(500)
);

-- Create shift_management table
CREATE TABLE IF NOT EXISTS shift_management (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    shift_start_time TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    shift_end_time TIMESTAMP,
    opening_balance NUMERIC(12,2) NOT NULL,
    cash_added NUMERIC(12,2) DEFAULT 0,
    closing_balance NUMERIC(12,2),
    total_payments_received NUMERIC(12,2) DEFAULT 0,
    total_loans_given NUMERIC(12,2) DEFAULT 0,
    expected_balance NUMERIC(12,2),
    difference NUMERIC(12,2),
    is_balanced BOOLEAN DEFAULT FALSE,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create shifts table
CREATE TABLE IF NOT EXISTS shifts (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    start_time TIMESTAMP NOT NULL,
    end_time TIMESTAMP,
    opening_cash NUMERIC(10,2),
    closing_cash NUMERIC(10,2),
    cash_difference NUMERIC(10,2),
    notes VARCHAR(500),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create admin_settings table for admin panel authentication
CREATE TABLE IF NOT EXISTS admin_settings (
    id SERIAL PRIMARY KEY,
    admin_password VARCHAR(255) NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_loans_created_by ON loans(created_by);
CREATE INDEX IF NOT EXISTS idx_loans_customer_name ON loans(customer_name);
CREATE INDEX IF NOT EXISTS idx_loans_email ON loans(email);
CREATE INDEX IF NOT EXISTS idx_loans_first_name ON loans(first_name);
CREATE INDEX IF NOT EXISTS idx_loans_last_name ON loans(last_name);
CREATE INDEX IF NOT EXISTS idx_loans_mobile_phone ON loans(mobile_phone);
CREATE INDEX IF NOT EXISTS idx_loans_transaction_number ON loans(transaction_number);
CREATE INDEX IF NOT EXISTS idx_payment_created_by ON payment_history(created_by);
CREATE INDEX IF NOT EXISTS idx_payment_history_loan_id ON payment_history(loan_id);
CREATE INDEX IF NOT EXISTS idx_loan_payments_date ON loan_payments(payment_date);
CREATE INDEX IF NOT EXISTS idx_loan_payments_loan_id ON loan_payments(loan_id);
CREATE INDEX IF NOT EXISTS idx_shift_active ON shift_management(user_id, shift_end_time);
CREATE INDEX IF NOT EXISTS idx_shift_date ON shift_management(shift_start_time);
CREATE INDEX IF NOT EXISTS idx_shift_user_id ON shift_management(user_id);
CREATE INDEX IF NOT EXISTS idx_shifts_user_id ON shifts(user_id);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

-- Add missing columns to existing tables (for schema migrations)
ALTER TABLE shift_management ADD COLUMN IF NOT EXISTS cash_added NUMERIC(12,2) DEFAULT 0;

-- Add auto-extend fields for interest-only payment cycle tracking
ALTER TABLE loans ADD COLUMN IF NOT EXISTS interest_paid_this_cycle NUMERIC(10,2) DEFAULT 0;
ALTER TABLE loans ADD COLUMN IF NOT EXISTS extended_this_cycle BOOLEAN DEFAULT FALSE;
ALTER TABLE loans ADD COLUMN IF NOT EXISTS cycle_start_date DATE;
ALTER TABLE loans ADD COLUMN IF NOT EXISTS last_extended_at TIMESTAMP;

-- Add comments to loans table columns for documentation
COMMENT ON COLUMN loans.first_name IS 'Customer first name (migrated from customer_name or entered directly)';
COMMENT ON COLUMN loans.last_name IS 'Customer last name (migrated from customer_name or entered directly)';
COMMENT ON COLUMN loans.email IS 'Customer email address';
COMMENT ON COLUMN loans.home_phone IS 'Customer home phone number';
COMMENT ON COLUMN loans.mobile_phone IS 'Customer mobile phone number';
COMMENT ON COLUMN loans.birthdate IS 'Customer date of birth';
COMMENT ON COLUMN loans.referral IS 'How customer was referred';
COMMENT ON COLUMN loans.identification_info IS 'Customer identification details';
COMMENT ON COLUMN loans.street_address IS 'Customer street address';
COMMENT ON COLUMN loans.city IS 'Customer city';
COMMENT ON COLUMN loans.state IS 'Customer state/province';
COMMENT ON COLUMN loans.zipcode IS 'Customer postal/zip code';
`;

/**
 * Retroactively extend loans that have paid interest-only payments
 * This function identifies qualifying loans and extends their due dates automatically
 * 
 * @param {Pool} pool - PostgreSQL connection pool
 * @returns {Promise<number>} - Number of loans extended
 */
async function retroactiveExtendLoans(pool) {
  let extendedCount = 0;

  try {
    console.log('\n🔄 Checking for loans to retroactively extend...');

    // Get all active loans that need extension (don't reset flag - only extend unflag ones)
    const loansResult = await pool.query(
      `SELECT * FROM loans 
       WHERE status = 'active' AND extended_this_cycle = false
       ORDER BY id ASC`
    );

    const loans = loansResult.rows;
    
    if (loans.length === 0) {
      console.log('⏭️  No loans need retroactive extension');
      return 0;
    }

    console.log(`📋 Found ${loans.length} loans to check for extension`);
    loans.forEach(l => console.log(`   - Loan #${l.id}: $${l.loan_amount} (Interest: $${l.interest_amount}, Status: ${l.status}, Extended: ${l.extended_this_cycle})`));
    console.log('');

    // Check each loan for extension eligibility
    for (const loan of loans) {
      try {
        console.log(`  📍 Checking Loan #${loan.id}: Principal $${loan.loan_amount}, Interest $${loan.interest_amount}`);
        
        // Check ALL THREE payment tables using pool
        const paymentHistoryResult = await pool.query(
          `SELECT SUM(CAST(payment_amount AS NUMERIC)) as total_paid_ph, COUNT(*) as payment_count_ph
           FROM payment_history 
           WHERE loan_id = $1`,
          [loan.id]
        );
        
        const paymentsResult = await pool.query(
          `SELECT SUM(CAST(payment_amount AS NUMERIC)) as total_paid_p, COUNT(*) as payment_count_p
           FROM payments 
           WHERE loan_id = $1`,
          [loan.id]
        );
        
        const loanPaymentsResult = await pool.query(
          `SELECT SUM(CAST(amount_paid AS NUMERIC)) as total_paid_lp, COUNT(*) as payment_count_lp
           FROM loan_payments 
           WHERE loan_id = $1`,
          [loan.id]
        );

        const totalFromHistory = parseFloat(paymentHistoryResult.rows[0]?.total_paid_ph || 0);
        const countFromHistory = parseInt(paymentHistoryResult.rows[0]?.payment_count_ph || 0);
        
        const totalFromPayments = parseFloat(paymentsResult.rows[0]?.total_paid_p || 0);
        const countFromPayments = parseInt(paymentsResult.rows[0]?.payment_count_p || 0);
        
        const totalFromLoanPayments = parseFloat(loanPaymentsResult.rows[0]?.total_paid_lp || 0);
        const countFromLoanPayments = parseInt(loanPaymentsResult.rows[0]?.payment_count_lp || 0);
        
        const totalPaid = totalFromHistory + totalFromPayments + totalFromLoanPayments;
        const hasPayments = countFromHistory > 0 || countFromPayments > 0 || countFromLoanPayments > 0;
        
        console.log(`      payment_history: ${countFromHistory} records, $${totalFromHistory.toFixed(2)}`);
        console.log(`      payments table: ${countFromPayments} records, $${totalFromPayments.toFixed(2)}`);
        console.log(`      loan_payments: ${countFromLoanPayments} records, $${totalFromLoanPayments.toFixed(2)}`);
        
        // Get sample records for debugging
        if (countFromHistory > 0) {
          const samplePH = await pool.query(
            `SELECT payment_amount, payment_date FROM payment_history WHERE loan_id = $1 LIMIT 1`,
            [loan.id]
          );
          samplePH.rows.forEach(p => {
            console.log(`        [history] - $${p.payment_amount} on ${p.payment_date}`);
          });
        }
        
        if (countFromPayments > 0) {
          const sampleP = await pool.query(
            `SELECT payment_amount, payment_date FROM payments WHERE loan_id = $1 LIMIT 1`,
            [loan.id]
          );
          sampleP.rows.forEach(p => {
            console.log(`        [payments] - $${p.payment_amount} on ${p.payment_date}`);
          });
        }
        
        if (countFromLoanPayments > 0) {
          const sampleLP = await pool.query(
            `SELECT amount_paid, payment_date FROM loan_payments WHERE loan_id = $1 LIMIT 1`,
            [loan.id]
          );
          sampleLP.rows.forEach(p => {
            console.log(`        [loan_payments] - $${p.amount_paid} on ${p.payment_date}`);
          });
        }

        // Check if total paid >= required interest amount
        const requiredInterest = parseFloat(loan.interest_amount || 0);
        
        console.log(`      Total Paid (all tables): $${totalPaid.toFixed(2)}, Required: $${requiredInterest.toFixed(2)}`);
        
        if (hasPayments && totalPaid >= requiredInterest) {
          console.log(`      ✓ Qualifies for extension`);
          
          // Calculate new due date (add 1 month)
          const currentDueDate = new Date(loan.due_date);
          const newDueDate = new Date(currentDueDate);
          newDueDate.setMonth(newDueDate.getMonth() + 1);
          
          // Format date as YYYY-MM-DD for PostgreSQL
          const formattedNewDueDate = newDueDate.toISOString().split('T')[0];

          // Update the loan with properly formatted date using POOL
          const updateResult = await pool.query(
            `UPDATE loans 
             SET 
               due_date = $1::DATE,
               extended_this_cycle = true,
               last_extended_at = CURRENT_TIMESTAMP,
               updated_at = CURRENT_TIMESTAMP
             WHERE id = $2
             RETURNING id, due_date, extended_this_cycle`,
            [formattedNewDueDate, loan.id]
          );

          console.log(`      [UPDATE] Query returned ${updateResult.rows.length} rows`);
          
          if (updateResult.rows.length > 0) {
            extendedCount++;
            const updatedLoan = updateResult.rows[0];
            
            // Verify the update actually persisted by reading it back
            const verifyResult = await pool.query(
              'SELECT due_date, extended_this_cycle FROM loans WHERE id = $1',
              [loan.id]
            );
            
            if (verifyResult.rows.length > 0) {
              const verified = verifyResult.rows[0];
              console.log(`  ✅ Loan #${loan.id}: Extended from ${loan.due_date} to ${updatedLoan.due_date}`);
              console.log(`      ✓ Setting: due_date=${formattedNewDueDate}, extended=true, updated_at=NOW()`);
              console.log(`      ✓ Verified in DB: due_date=${verified.due_date}, extended=${verified.extended_this_cycle}`);
              console.log(`      (Paid: $${totalPaid.toFixed(2)} interest, Required: $${requiredInterest.toFixed(2)})`);
            }
          } else {
            console.log(`  ❌ Loan #${loan.id}: UPDATE returned 0 rows - possibly already updated`);
          }
        } else {
          console.log(`      ⏭️  Skipped: hasPayments=${hasPayments}, totalPaid >= required=${totalPaid >= requiredInterest}`);
        }
      } catch (loanErr) {
        console.error(`  ❌ Error processing Loan #${loan.id}:`, loanErr.message);
      }
    }

    if (extendedCount > 0) {
      console.log(`\n✅ Retroactively extended ${extendedCount} loans`);
    }

    console.log('✅ Retroactive extension complete');
    return extendedCount;
  } catch (error) {
    console.error('❌ Retroactive extension check failed:', error.message);
    console.error('Error details:', error);
    return 0;
  }
}

/**
 * Initialize database schema
 * This function creates all necessary tables if they don't exist
 * 
 * @param {Pool} pool - PostgreSQL connection pool
 * @returns {Promise<void>}
 */
async function initializeDatabase(pool) {
  const client = await pool.connect();
  
  try {
    console.log('🔄 Starting database initialization...');
    
    // Execute the full schema creation script
    await client.query(DATABASE_SCHEMA);
    
    console.log('✅ Database schema initialized successfully!');
    
    // Initialize default roles
    console.log('🔧 Initializing default roles...');
    await client.query(`
      INSERT INTO user_roles (role_name) VALUES 
      ('admin'),
      ('staff'),
      ('manager'),
      ('user')
      ON CONFLICT (role_name) DO NOTHING;
    `);
    console.log('✅ Default roles initialized');
    
    // Initialize admin user if not exists
    console.log('🔧 Initializing admin user...');
    const adminUserCheck = await client.query('SELECT COUNT(*) as count FROM users WHERE username = $1', ['admin']);
    if (parseInt(adminUserCheck.rows[0].count) === 0) {
      // Default admin password (should be changed on first login)
      const defaultPassword = 'admin123'; // Default password - MUST be changed
      const hashedPassword = await bcrypt.hash(defaultPassword, 10);
      
      // Get admin role ID
      const roleResult = await client.query('SELECT id FROM user_roles WHERE role_name = $1', ['admin']);
      const adminRoleId = roleResult.rows[0] ? roleResult.rows[0].id : 1;
      
      // Create default admin user
      await client.query(
        'INSERT INTO users (username, password, role_id) VALUES ($1, $2, $3)',
        ['admin', hashedPassword, adminRoleId]
      );
      console.log('✅ Default admin user created (username: admin, password: admin123)');
    }
    
    // Initialize admin settings with default password (update or insert)
    console.log('🔧 Initializing admin settings...');
    const defaultPassword = 'qasim12345'; // Default password - MUST be changed
    const hashedPassword = await bcrypt.hash(defaultPassword, 10);
    
    // Check if admin_settings record exists
    const adminSettingsCheck = await client.query('SELECT COUNT(*) as count FROM admin_settings');
    const settingsExist = parseInt(adminSettingsCheck.rows[0].count) > 0;
    
    if (settingsExist) {
      // Update existing record
      await client.query(
        'UPDATE admin_settings SET admin_password = $1, updated_at = CURRENT_TIMESTAMP',
        [hashedPassword]
      );
      console.log('✅ Admin settings updated with default password: qasim12345');
    } else {
      // Insert new record
      await client.query(
        'INSERT INTO admin_settings (admin_password) VALUES ($1)',
        [hashedPassword]
      );
      console.log('✅ Admin settings initialized with default password: qasim12345');
    }
    
    // Verify all tables exist
    const result = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_type = 'BASE TABLE'
      ORDER BY table_name;
    `);
    
    console.log('📊 Created/Verified tables:');
    result.rows.forEach(row => {
      console.log(`   ✓ ${row.table_name}`);
    });

    // Release client before running retroactive extension (it needs its own connection)
    client.release();
    
    // Run retroactive extension check for existing loans
    await retroactiveExtendLoans(pool);
    
    return true;
  } catch (error) {
    console.error('❌ Database initialization failed:', error.message);
    console.error('Error code:', error.code);
    console.error('Error details:', error.detail);
    console.error('Full error:', error);
    throw error;
  } finally {
    if (client) {
      try {
        client.release();
      } catch (releaseErr) {
        // Client already released, ignore
      }
    }
  }
}

/**
 * Check if database is already initialized
 * @param {Pool} pool - PostgreSQL connection pool
 * @returns {Promise<boolean>}
 */
async function isDatabaseInitialized(pool) {
  try {
    const result = await pool.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'users'
      );
    `);
    return result.rows[0].exists;
  } catch (error) {
    console.error('Error checking database status:', error.message);
    return false;
  }
}

module.exports = {
  initializeDatabase,
  isDatabaseInitialized,
  retroactiveExtendLoans,
  DATABASE_SCHEMA
};
