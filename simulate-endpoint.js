const { Pool } = require('pg');

async function simulateEndpoint() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:JRBSJwVnsLaJGxzSFpgrCRlkFsAXmuxQ@switchyard.proxy.rlwy.net:15201/railway'
  });

  try {
    const customerId = 6;
    
    console.log('\n=== SIMULATING /customers/6/loans ENDPOINT ===\n');

    // Get active loans
    const activeResult = await pool.query(
      `SELECT id, loan_amount, status, due_date FROM loans WHERE customer_id = $1 AND status = 'active' ORDER BY loan_issued_date DESC`,
      [customerId]
    );

    // Get overdue loans (EXACT SAME QUERY AS BACKEND)
    const overdueResult = await pool.query(
      `SELECT id, loan_amount, status, due_date FROM loans WHERE customer_id = $1 AND (status = 'overdue' OR (status = 'active' AND due_date < CURRENT_DATE)) ORDER BY loan_issued_date DESC`,
      [customerId]
    );

    console.log('Endpoint Response:');
    console.log(JSON.stringify({
      activeLoans: activeResult.rows,
      overdueLoans: overdueResult.rows,
      redeemedLoans: [],
      forfeitedLoans: [],
      summary: {
        totalActiveLoans: activeResult.rows.length,
        totalOverdueLoans: overdueResult.rows.length
      }
    }, null, 2));

    console.log('\n📊 Summary:');
    console.log(`Active loans: ${activeResult.rows.length}`);
    console.log(`Overdue loans: ${overdueResult.rows.length}`);

    if (overdueResult.rows.length > 0) {
      console.log('\n✅ OVERDUE LOANS FOUND:');
      overdueResult.rows.forEach(loan => {
        console.log(`  - Loan ${loan.id}: $${loan.loan_amount} | Status: ${loan.status} | Due: ${loan.due_date}`);
      });
    }

    await pool.end();
  } catch (error) {
    console.error('Error:', error.message);
    await pool.end();
  }
}

simulateEndpoint();
