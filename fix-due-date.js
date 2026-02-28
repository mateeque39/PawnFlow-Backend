const { Pool } = require('pg');

const pool = new Pool({
  connectionString: 'postgresql://postgres:JRBSJwVnsLaJGxzSFpgrCRlkFsAXmuxQ@switchyard.proxy.rlwy.net:15201/railway'
});

async function fixLoan() {
  try {
    // Original due date was 14/02/2026
    // Add 30 days: 14/03/2026
    const newDueDate = '2026-03-14';
    
    console.log('Correcting due date...');
    console.log('Original created: 14/01/2026');
    console.log('Original due: 14/02/2026');
    console.log('New due (after 30 days): 14/03/2026');
    
    const result = await pool.query(
      `UPDATE loans 
       SET due_date = $1
       WHERE id = $2 
       RETURNING id, remaining_balance, interest_amount, total_payable_amount, due_date, status`,
      [newDueDate, 11]
    );

    console.log('\n✅ Fixed Loan #11:');
    console.log(`Due Date: ${result.rows[0].due_date}`);
    console.log(`Remaining Balance: $${result.rows[0].remaining_balance}`);
    console.log(`Status: ${result.rows[0].status}`);
    
    await pool.end();
  } catch (err) {
    console.error('ERROR:', err);
    await pool.end();
  }
}

fixLoan();
