const { Pool } = require('pg');

const pool = new Pool({
  connectionString: 'postgresql://postgres:JRBSJwVnsLaJGxzSFpgrCRlkFsAXmuxQ@switchyard.proxy.rlwy.net:15201/railway'
});

async function fixLoan() {
  try {
    // Original due date was 15/03/2026, add 30 days from original, not from today
    const originalDueDate = new Date('2026-03-15');
    const newDueDate = new Date(originalDueDate);
    newDueDate.setDate(newDueDate.getDate() + 30);
    
    const dueDateStr = newDueDate.toISOString().split('T')[0];
    
    console.log('Original due date: 2026-03-15');
    console.log('New due date (+30 days):', dueDateStr);
    
    // Fix: remaining_balance should be principal + interest = 22000 + 550 = 22550
    const result = await pool.query(
      `UPDATE loans 
       SET remaining_balance = $1, 
           total_payable_amount = $2,
           due_date = $3
       WHERE id = $4 
       RETURNING id, remaining_balance, interest_amount, total_payable_amount, due_date, status`,
      [22550, 22550, dueDateStr, 11]
    );

    console.log('✅ Fixed Loan #11:');
    console.log(JSON.stringify(result.rows[0], null, 2));
    await pool.end();
  } catch (err) {
    console.error('ERROR:', err);
    await pool.end();
  }
}

fixLoan();
