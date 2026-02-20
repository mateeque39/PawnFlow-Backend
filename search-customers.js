const { Pool } = require('pg');

const pool = new Pool({
  connectionString: 'postgresql://postgres:JRBSJwVnsLaJGxzSFpgrCRlkFsAXmuxQ@switchyard.proxy.rlwy.net:15201/railway'
});

async function searchLoans() {
  try {
    // Get detailed info on these specific loans
    const loanIds = [12, 11, 4, 5, 7]; // The IDs from the missing customers
    
    console.log('📋 DETAILED INFO FOR THESE LOANS:\n');
    
    for (const id of loanIds) {
      const result = await pool.query(
        'SELECT id, customer_id, customer_name, status, is_redeemed, is_forfeited, transaction_number, created_by_user_id, created_by_username, loan_amount FROM loans WHERE id = $1',
        [id]
      );
      
      if (result.rows.length > 0) {
        const loan = result.rows[0];
        console.log(`\n--- LOAN ID: ${id} ---`);
        console.log(`Customer ID: ${loan.customer_id}`);
        console.log(`Customer Name: ${loan.customer_name}`);
        console.log(`Status: ${loan.status}`);
        console.log(`Is Redeemed: ${loan.is_redeemed}`);
        console.log(`Is Forfeited: ${loan.is_forfeited}`);
        console.log(`Transaction Number: ${loan.transaction_number}`);
        console.log(`Created By User ID: ${loan.created_by_user_id}`);
        console.log(`Created By Username: ${loan.created_by_username}`);
        console.log(`Loan Amount: ${loan.loan_amount}`);
      }
    }
    
    // Also get count of all loans with different statuses
    console.log('\n\n📊 LOAN STATUS BREAKDOWN:\n');
    const statusResult = await pool.query(`
      SELECT status, COUNT(*) as count FROM loans GROUP BY status
    `);
    
    statusResult.rows.forEach(row => {
      console.log(`Status "${row.status}": ${row.count} loans`);
    });
    
    console.log('\n\n📊 REDEEMED/FORFEITED COUNT:\n');
    const redeemedResult = await pool.query(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN is_redeemed THEN 1 ELSE 0 END) as redeemed,
        SUM(CASE WHEN is_forfeited THEN 1 ELSE 0 END) as forfeited
      FROM loans
    `);
    
    console.log(redeemedResult.rows[0]);
    
    await pool.end();
  } catch (error) {
    console.error('Error:', error);
    await pool.end();
  }
}

searchLoans();
