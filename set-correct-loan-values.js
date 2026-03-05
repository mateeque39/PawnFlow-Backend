/**
 * Manually Set Correct Loan Values
 * ===============================
 * Sets the correct due dates, remaining balances directly
 * Bypasses any AUTO-FIX logic
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function setCorrectValues() {
  try {
    console.log('\n========== MANUALLY SET CORRECT VALUES ==========\n');

    // Loan 8: Created Jan 9, paid Feb 6 → extend to Mar 10 (compensate for UTC)
    console.log('Loan 8: Principal $20,000 + Interest $600 = $20,600');
    let res = await pool.query(
      `UPDATE loans 
       SET due_date = '2026-03-10'::DATE, 
           remaining_balance = 20600, 
           extended_this_cycle = true,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = 8
       RETURNING id, due_date, remaining_balance`
    );
    console.log(`  ✅ Updated: Due=${new Date(res.rows[0].due_date).toISOString().split('T')[0]}, Balance=${res.rows[0].remaining_balance}`);

    // Loan 9: Created Jan 9, paid Feb 6 → extend to Mar 10
    console.log('\nLoan 9: Principal $30,000 + Interest $900 = $30,900');
    res = await pool.query(
      `UPDATE loans 
       SET due_date = '2026-03-10'::DATE, 
           remaining_balance = 30900, 
           extended_this_cycle = true,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = 9
       RETURNING id, due_date, remaining_balance`
    );
    console.log(`  ✅ Updated: Due=${new Date(res.rows[0].due_date).toISOString().split('T')[0]}, Balance=${res.rows[0].remaining_balance}`);

    // Loan 11: Created Jan 14, paid Feb 23 → extend to Mar 15
    console.log('\nLoan 11: Principal $22,000 + Interest $550 = $22,550');
    res = await pool.query(
      `UPDATE loans 
       SET due_date = '2026-03-15'::DATE, 
           remaining_balance = 22550, 
           extended_this_cycle = true,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = 11
       RETURNING id, due_date, remaining_balance`
    );
    console.log(`  ✅ Updated: Due=${new Date(res.rows[0].due_date).toISOString().split('T')[0]}, Balance=${res.rows[0].remaining_balance}`);

    console.log('\n========== VERIFYING ==========\n');

    const verify = await pool.query(
      `SELECT id, due_date, remaining_balance, extended_this_cycle 
       FROM loans WHERE id IN (8,9,11) ORDER BY id`
    );

    verify.rows.forEach(r => {
      const due = new Date(r.due_date).toISOString().split('T')[0];
      console.log(`Loan ${r.id}: Due=${due}, Balance=${r.remaining_balance}, Extended=${r.extended_this_cycle}`);
    });

    console.log('\n========== COMPLETE ==========\n');

  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await pool.end();
  }
}

setCorrectValues();
