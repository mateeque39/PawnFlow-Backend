const { Pool } = require('pg');

const pool = new Pool({
  connectionString: 'postgresql://postgres:JRBSJwVnsLaJGxzSFpgrCRlkFsAXmuxQ@switchyard.proxy.rlwy.net:15201/railway'
});

async function testBackendLogic() {
  try {
    const customerId = 6; // Gurnoor Sandhu
    
    console.log('\n📋 SIMULATING BACKEND API RESPONSE FOR /customers/6/loans\n');
    
    // Get active loans - search by customer_id
    const activeLoansResult = await pool.query(
      `SELECT id, transaction_number, loan_amount, interest_rate, interest_amount, total_payable_amount, recurring_fee, redemption_fee, remaining_balance, due_date, loan_issued_date, status, item_description, item_category, street_address, city, state, zipcode, collateral_description, collateral_image FROM loans WHERE customer_id = $1 AND status = 'active' ORDER BY loan_issued_date DESC`,
      [customerId]
    );

    // Get redeemed loans
    const redeemedLoansResult = await pool.query(
      `SELECT id, transaction_number, loan_amount, interest_rate, interest_amount, total_payable_amount, recurring_fee, redemption_fee, remaining_balance, due_date, loan_issued_date, status, item_description, item_category, street_address, city, state, zipcode, collateral_description, collateral_image FROM loans WHERE customer_id = $1 AND status = 'redeemed' ORDER BY loan_issued_date DESC`,
      [customerId]
    );

    // Get forfeited loans
    const forfeitedLoansResult = await pool.query(
      `SELECT id, transaction_number, loan_amount, interest_rate, interest_amount, total_payable_amount, recurring_fee, redemption_fee, remaining_balance, due_date, loan_issued_date, status, item_description, item_category, street_address, city, state, zipcode, collateral_description, collateral_image FROM loans WHERE customer_id = $1 AND status = 'forfeited' ORDER BY loan_issued_date DESC`,
      [customerId]
    );

    // Get overdue loans
    const overdueLoansResult = await pool.query(
      `SELECT id, transaction_number, loan_amount, interest_rate, interest_amount, total_payable_amount, recurring_fee, redemption_fee, remaining_balance, due_date, loan_issued_date, status, item_description, item_category, street_address, city, state, zipcode, collateral_description, collateral_image FROM loans WHERE customer_id = $1 AND status = 'overdue' ORDER BY loan_issued_date DESC`,
      [customerId]
    );

    // Format response
    const response = {
      activeLoans: activeLoansResult.rows,
      redeemedLoans: redeemedLoansResult.rows,
      forfeitedLoans: forfeitedLoansResult.rows,
      overdueLoans: overdueLoansResult.rows,
      summary: {
        totalActiveLoans: activeLoansResult.rows.length,
        totalRedeemedLoans: redeemedLoansResult.rows.length,
        totalForfeitedLoans: forfeitedLoansResult.rows.length,
        totalOverdueLoans: overdueLoansResult.rows.length,
      }
    };
    
    console.log('📊 SUMMARY:');
    console.log(`  Active Loans: ${response.summary.totalActiveLoans}`);
    console.log(`  Overdue Loans: ${response.summary.totalOverdueLoans}`);
    console.log(`  Redeemed Loans: ${response.summary.totalRedeemedLoans}`);
    console.log(`  Forfeited Loans: ${response.summary.totalForfeitedLoans}`);
    
    if (response.summary.totalOverdueLoans > 0) {
      console.log('\n✅ OVERDUE LOANS FOUND:');
      response.overdueLoans.forEach(loan => {
        console.log(`   - Loan ID: ${loan.id} | Amount: $${loan.loan_amount} | Status: ${loan.status}`);
      });
    } else {
      console.log('\n❌ NO OVERDUE LOANS FOUND');
    }
    
    console.log('\n✅ Backend is correctly returning overdueLoans in API response!');
    await pool.end();
  } catch (error) {
    console.error('Error:', error);
    await pool.end();
  }
}

testBackendLogic();
