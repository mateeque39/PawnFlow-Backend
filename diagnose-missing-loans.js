/**
 * Diagnostic Script: Check for missing loans in Railways database
 * This script connects to the production database and searches for loans
 * that appear on the receipts but may be missing from the system
 */

const { Pool } = require('pg');
require('dotenv').config();

// Build database connection string (same logic as server.js)
const getDatabaseUrl = () => {
  if (process.env.DATABASE_URL) {
    console.log('📍 Using DATABASE_URL from environment');
    return process.env.DATABASE_URL;
  }
  
  if (process.env.PGHOST) {
    const connectionString = `postgresql://${process.env.PGUSER || 'postgres'}:${process.env.PGPASSWORD || ''}@${process.env.PGHOST}:${process.env.PGPORT || 5432}/${process.env.PGDATABASE || 'railway'}`;
    console.log('📍 Using Railway PostgreSQL environment variables');
    return connectionString;
  }
  
  const localUrl = `postgresql://${process.env.DB_USER || 'postgres'}:${process.env.DB_PASSWORD || '1234'}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432}/${process.env.DB_NAME || 'pawn_shop'}`;
  console.log('📍 Using local development database configuration');
  return localUrl;
};

const DATABASE_URL = getDatabaseUrl();
const loggingUrl = DATABASE_URL.replace(/:[^:@]+@/, ':****@').replace(/@.*/, '@****');
console.log('🔌 Connecting to:', loggingUrl);

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// Loans from the receipts (based on the images)
const loansToCheck = [
  { customerName: 'Gurnoor Sandhu', transactionNo: '12', loanId: 4542054, amount: 17000 },
  { customerName: 'Bikash Maharjan', transactionNo: '11', amount: 22000 },
  { customerName: 'Syed Ali', transactionNo: '4', loanId: 860232214, amount: 17000 },
  { customerName: 'Syed Ali', transactionNo: '7', amount: 6000 },
  { customerName: 'Syed Ali', transactionNo: '5', amount: 17000 },
];

async function diagnoseLoans() {
  try {
    // Test connection
    const connTest = await pool.query('SELECT NOW()');
    console.log('\n✅ Database connection successful');
    console.log(`📅 Server time: ${connTest.rows[0].now}\n`);

    // Check database schema
    console.log('📋 Checking loans table schema...');
    const tableInfo = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'loans' 
      ORDER BY ordinal_position
    `);
    console.log(`✅ Loans table has ${tableInfo.rows.length} columns\n`);

    // Get total loan count
    const totalLoans = await pool.query('SELECT COUNT(*) FROM loans');
    console.log(`📊 Total loans in database: ${totalLoans.rows[0].count}\n`);

    // Search for each loan
    console.log('🔍 Searching for receipted loans in database...\n');
    
    for (const loan of loansToCheck) {
      console.log(`\n--- Searching for: ${loan.customerName} (Txn: ${loan.transactionNo}) ---`);
      
      // Search by customer name and transaction number
      const search1 = await pool.query(
        'SELECT id, customer_name, transaction_number, loan_amount, created_at, status FROM loans WHERE customer_name ILIKE $1 AND transaction_number = $2',
        [loan.customerName, loan.transactionNo]
      );
      
      if (search1.rows.length > 0) {
        console.log(`✅ FOUND - By customer name + transaction number:`);
        search1.rows.forEach(row => {
          console.log(`   ID: ${row.id}, Amount: $${row.loan_amount}, Created: ${row.created_at}, Status: ${row.status}`);
        });
        continue;
      }
      
      // Search by customer name only
      const search2 = await pool.query(
        'SELECT id, customer_name, transaction_number, loan_amount, created_at, status FROM loans WHERE customer_name ILIKE $1 ORDER BY created_at DESC LIMIT 5',
        [loan.customerName]
      );
      
      if (search2.rows.length > 0) {
        console.log(`⚠️  Found loans for ${loan.customerName}, but transaction numbers don't match:`);
        search2.rows.forEach(row => {
          console.log(`   ID: ${row.id}, Txn: ${row.transaction_number}, Amount: $${row.loan_amount}, Created: ${row.created_at}`);
        });
      } else {
        console.log(`❌ NOT FOUND - No loans for ${loan.customerName}`);
      }
      
      // Also search by transaction number
      const search3 = await pool.query(
        'SELECT id, customer_name, transaction_number, loan_amount, created_at, status FROM loans WHERE transaction_number = $1',
        [loan.transactionNo]
      );
      
      if (search3.rows.length > 0) {
        console.log(`Found transaction ${loan.transactionNo} but for different customer:`);
        search3.rows.forEach(row => {
          console.log(`   Customer: ${row.customer_name}, ID: ${row.id}`);
        });
      }
    }

    // Check for recent loan creation (last 24 hours)
    console.log('\n\n📅 Loans created in the last 24 hours:');
    const recentLoans = await pool.query(`
      SELECT id, customer_name, transaction_number, loan_amount, created_at 
      FROM loans 
      WHERE created_at >= CURRENT_TIMESTAMP - INTERVAL '24 hours'
      ORDER BY created_at DESC
    `);
    
    if (recentLoans.rows.length > 0) {
      console.log(`Found ${recentLoans.rows.length} recent loans:`);
      recentLoans.rows.forEach(row => {
        console.log(`   ${row.customer_name} (Txn: ${row.transaction_number}) - $${row.loan_amount} - ${row.created_at}`);
      });
    } else {
      console.log('❌ No loans created in the last 24 hours');
    }

    // Check for any error logs
    console.log('\n\n🔴 Checking for audit logs (if available):');
    try {
      const auditCheck = await pool.query(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_name = 'audit_log'
      `);
      
      if (auditCheck.rows.length > 0) {
        const recentErrors = await pool.query(`
          SELECT * FROM audit_log 
          WHERE action_type LIKE '%error%' OR action_type LIKE '%fail%'
          ORDER BY timestamp DESC 
          LIMIT 10
        `);
        
        if (recentErrors.rows.length > 0) {
          console.log(`⚠️  Found ${recentErrors.rows.length} error logs`);
        } else {
          console.log('✅ No error logs found');
        }
      }
    } catch (e) {
      console.log('ℹ️  Audit log table not available');
    }

    console.log('\n\n📊 Summary:');
    console.log('- Check if transaction numbers are correct (they might be different on the receipt vs system)');
    console.log('- Check customer name spelling - the system is case-insensitive but exact match is used');
    console.log('- If loans are not found at all, they may not have been created in the system');
    console.log('- If found but not displaying, it might be a frontend sync issue\n');

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error('Full error:', error);
  } finally {
    await pool.end();
  }
}

diagnoseLoans();
