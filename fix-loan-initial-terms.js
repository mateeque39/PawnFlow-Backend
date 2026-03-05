/**
 * Fix Loan Initial Term
 * ==================
 * Corrects loans that have wrong initial due dates
 * 
 * Rule: Loans should have 30-day (1 month) initial term
 * Then 1-month extension when interest-only payment is made
 * 
 * So: Created Jan 9 → Due Feb 9 (30 days)
 *     After extension → Due Mar 9 (another 30 days)
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function fixLoanTerms() {
  try {
    console.log('\n========== FIX LOAN INITIAL TERMS ==========\n');
    console.log('Rule: Initial term should be 30 days (1 month)');
    console.log('After payment = interest: +30 days (1 month extension)\n');

    // Get all extended loans
    const loansRes = await pool.query(`
      SELECT id, created_at, due_date, extended_this_cycle, loan_amount, 
             interest_amount, status
      FROM loans WHERE extended_this_cycle = true ORDER BY id
    `);

    console.log(`Found ${loansRes.rows.length} extended loans\n`);

    for (const loan of loansRes.rows) {
      const created = new Date(loan.created_at);
      const current_due = new Date(loan.due_date);
      const days_diff = Math.floor((current_due - created) / (1000 * 60 * 60 * 24));

      console.log(`Loan ${loan.id}:`);
      console.log(`  Created: ${created.toISOString().split('T')[0]}`);
      console.log(`  Current Due: ${current_due.toISOString().split('T')[0]}`);
      console.log(`  Days Difference: ${days_diff}`);

      // Calculate what it SHOULD be
      // Initial term: 30 days
      const should_be_original = new Date(created);
      should_be_original.setDate(should_be_original.getDate() + 30);
      
      // After extension: +30 more days
      const should_be_extended = new Date(should_be_original);
      should_be_extended.setDate(should_be_extended.getDate() + 30);

      const should_be_original_str = should_be_original.toISOString().split('T')[0];
      const should_be_extended_str = should_be_extended.toISOString().split('T')[0];

      console.log(`  Should be ORIGINAL: ${should_be_original_str} (30 days from creation)`);
      console.log(`  Should be EXTENDED: ${should_be_extended_str} (30 more days after extension)`);

      const is_correct = current_due.toISOString().split('T')[0] === should_be_extended_str;
      console.log(`  Status: ${is_correct ? '✓ CORRECT' : '❌ WRONG (needs fix)'}`);

      if (!is_correct) {
        console.log(`  Fixing...`);
        // Update to correct extended due date
        const updateRes = await pool.query(
          `UPDATE loans 
           SET due_date = $1, updated_at = CURRENT_TIMESTAMP
           WHERE id = $2
           RETURNING id, due_date`,
          [should_be_extended_str, loan.id]
        );
        console.log(`  ✅ Fixed! New due date: ${updateRes.rows[0].due_date.toISOString().split('T')[0]}`);
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

fixLoanTerms();
