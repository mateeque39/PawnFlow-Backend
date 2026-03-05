require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function checkLoanTerms() {
  try {
    const res = await pool.query(`
      SELECT id, created_at, due_date, loan_amount, interest_amount, interest_rate
      FROM loans WHERE id IN (8,9,11) ORDER BY id
    `);

    console.log('\n========== LOAN TERM ANALYSIS ==========\n');

    res.rows.forEach(r => {
      const created = new Date(r.created_at);
      const due = new Date(r.due_date);
      const daysFromCreation = Math.floor((due - created) / (1000 * 60 * 60 * 24));
      const monthsFromCreation = daysFromCreation / 30;
      const yearsFromCreation = daysFromCreation / 365;

      console.log(`Loan ${r.id}:`);
      console.log(`  Created: ${created.toISOString().split('T')[0]}`);
      console.log(`  Due: ${due.toISOString().split('T')[0]}`);
      console.log(`  Term: ${daysFromCreation} days (~${monthsFromCreation.toFixed(1)} months / ~${yearsFromCreation.toFixed(2)} years)`);
      console.log(`  Principal: $${r.loan_amount}`);
      console.log(`  Interest Rate: ${r.interest_rate}%`);
      console.log(`  Interest Amount: $${r.interest_amount}`);
      console.log('');
    });

  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await pool.end();
  }
}

checkLoanTerms();
