const { Pool } = require('pg');
require('dotenv').config();

const getDatabaseUrl = () => {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  if (process.env.PGHOST) {
    return `postgresql://${process.env.PGUSER || 'postgres'}:${process.env.PGPASSWORD || ''}@${process.env.PGHOST}:${process.env.PGPORT || 5432}/${process.env.PGDATABASE || 'railway'}`;
  }
  return `postgresql://${process.env.DB_USER || 'postgres'}:${process.env.DB_PASSWORD || '1234'}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432}/${process.env.DB_NAME || 'pawn_shop'}`;
};

const DATABASE_URL = getDatabaseUrl();
const pool = new Pool({ connectionString: DATABASE_URL, ssl: false });

async function checkLoans() {
  try {
    console.log('\n🔍 DATABASE CONNECTION INFO:\n');
    console.log('DATABASE_URL:', process.env.DATABASE_URL ? '✅ Set' : '❌ Not set');
    
    const dbUrl = getDatabaseUrl().replace(/:[^:@]*@/, ':****@');
    console.log('Connecting to:', dbUrl);
    
    const currentDb = await pool.query('SELECT current_database() as db, current_user as user');
    console.log('\n✅ Connected to database:', currentDb.rows[0].db);
    console.log('✅ User:', currentDb.rows[0].user);
    
    // Check loans table count
    const loanCount = await pool.query('SELECT COUNT(*) FROM loans');
    console.log(`\n📊 Total loans in database: ${loanCount.rows[0].count}`);
    
    // Get all loans
    const loans = await pool.query(
      'SELECT id, customer_id, transaction_number, status, remaining_balance FROM loans ORDER BY id DESC LIMIT 20'
    );
    
    if (loans.rows.length > 0) {
      console.log('\n✅ LOANS LIST:');
      loans.rows.forEach(loan => {
        console.log(`   Loan #${loan.id} | Customer: ${loan.customer_id} | Status: ${loan.status} | Balance: $${loan.remaining_balance}`);
      });
    }
    
  } catch (err) {
    console.error('❌ Error:', err.message);
  } finally {
    pool.end();
  }
}

checkLoans();
