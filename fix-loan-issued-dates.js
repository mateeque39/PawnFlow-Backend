/**
 * Fix Loan Issued Dates
 * ==================
 * The AUTO-FIX uses loan_issued_date to recalculate due dates
 * These dates are off by 1 day, causing recalculations to be wrong
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function fixIssuedDates() {
  try {
    console.log('\n========== FIX ISSUED DATES ==========\n');

    // Get the loans
    const loansRes = await pool.query(`
      SELECT id, created_at, loan_issued_date
      FROM loans WHERE id IN (8,9,11) ORDER BY id
    `);

    for (const loan of loansRes.rows) {
      const created = new Date(loan.created_at).toISOString().split('T')[0];
      const issued = new Date(loan.loan_issued_date).toISOString().split('T')[0];
      
      console.log(`Loan ${loan.id}:`);
      console.log(`  created_at: ${created}`);
      console.log(`  loan_issued_date: ${issued}`);
      
      if (created !== issued) {
        console.log(`  ⚠️  MISMATCH! Fixing...`);
        
        // Update loan_issued_date to match created_at
        const updateRes = await pool.query(
          `UPDATE loans 
           SET loan_issued_date = $1
           WHERE id = $2
           RETURNING id, loan_issued_date`,
          [new Date(loan.created_at).toISOString().split('T')[0], loan.id]
        );
        
        console.log(`  ✅ Fixed to: ${new Date(updateRes.rows[0].loan_issued_date).toISOString().split('T')[0]}`);
      } else {
        console.log(`  ✓ Already correct`);
      }
      console.log('');
    }

    console.log('========== COMPLETE ==========\n');

  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await pool.end();
  }
}

fixIssuedDates();
