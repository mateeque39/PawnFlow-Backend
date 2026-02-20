const { Pool } = require('pg');

const pool = new Pool({
  connectionString: 'postgresql://postgres:JRBSJwVnsLaJGxzSFpgrCRlkFsAXmuxQ@switchyard.proxy.rlwy.net:15201/railway'
});

async function testEndpoint() {
  try {
    // Test for Gurnoor Sandhu (Customer ID: 6)
    const result = await pool.query(`
      SELECT 
        'active' as category, COUNT(*) as count 
      FROM loans 
      WHERE customer_id = 6 AND status = 'active'
      
      UNION ALL
      
      SELECT 
        'overdue' as category, COUNT(*) as count 
      FROM loans 
      WHERE customer_id = 6 AND status = 'overdue'
      
      UNION ALL
      
      SELECT 
        'redeemed' as category, COUNT(*) as count 
      FROM loans 
      WHERE customer_id = 6 AND status = 'redeemed'
      
      UNION ALL
      
      SELECT 
        'forfeited' as category, COUNT(*) as count 
      FROM loans 
      WHERE customer_id = 6 AND status = 'forfeited'
    `);
    
    console.log('\n✅ ENDPOINT TEST FOR GURNOOR SANDHU (Customer ID: 6)\n');
    result.rows.forEach(row => {
      console.log(`${row.category}: ${row.count} loans`);
    });
    
    // Show the actual overdue loans
    const overdueResult = await pool.query(`
      SELECT id, customer_name, loan_amount, status FROM loans 
      WHERE customer_id = 6 AND status = 'overdue'
    `);
    
    if (overdueResult.rows.length > 0) {
      console.log('\n📋 OVERDUE LOANS FOR GURNOOR SANDHU:');
      overdueResult.rows.forEach(loan => {
        console.log(`  Loan ID: ${loan.id} | Amount: ${loan.loan_amount} | Status: ${loan.status}`);
      });
    }
    
    await pool.end();
  } catch (error) {
    console.error('Error:', error);
    await pool.end();
  }
}

testEndpoint();
