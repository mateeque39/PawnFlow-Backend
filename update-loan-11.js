const { Pool } = require('pg');

const pool = new Pool({
  connectionString: 'postgresql://postgres:JRBSJwVnsLaJGxzSFpgrCRlkFsAXmuxQ@switchyard.proxy.rlwy.net:15201/railway'
});

async function updateLoan() {
  try {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 30);
    const newDueDate = tomorrow.toISOString().split('T')[0];

    console.log('📅 New due date:', newDueDate);

    const result = await pool.query(
      `UPDATE loans SET status = $1, remaining_balance = $2, interest_amount = $3, due_date = $4, total_payable_amount = $5 WHERE id = $6 RETURNING *`,
      ['active', 22000, 550, newDueDate, 22550, 11]
    );

    console.log('✅ Updated!');
    console.log(result.rows[0]);
    await pool.end();
  } catch (err) {
    console.error('ERROR:', err);
    await pool.end();
  }
}

updateLoan();
