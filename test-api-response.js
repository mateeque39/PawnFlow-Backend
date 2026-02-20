const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:JRBSJwVnsLaJGxzSFpgrCRlkFsAXmuxQ@switchyard.proxy.rlwy.net:15201/railway'
});

async function testAPIResponse() {
  try {
    console.log('\n=== TESTING API RESPONSE FOR /customers/6/loans ===\n');

    const customerIdNum = 6;

    // Get active loans - search by customer_id
    const activeLoansResult = await pool.query(
      `SELECT id, transaction_number, loan_amount, interest_rate, interest_amount, total_payable_amount, recurring_fee, redemption_fee, remaining_balance, due_date, loan_issued_date, status, item_description, item_category, street_address, city, state, zipcode, collateral_description, collateral_image FROM loans WHERE customer_id = $1 AND status = 'active' ORDER BY loan_issued_date DESC`,
      [customerIdNum]
    );

    // Get overdue loans (include both explicitly marked overdue AND active loans past due date)
    const overdueLoansResult = await pool.query(
      `SELECT id, transaction_number, loan_amount, interest_rate, interest_amount, total_payable_amount, recurring_fee, redemption_fee, remaining_balance, due_date, loan_issued_date, status, item_description, item_category, street_address, city, state, zipcode, collateral_description, collateral_image FROM loans WHERE customer_id = $1 AND (status = 'overdue' OR (status = 'active' AND due_date < CURRENT_DATE)) ORDER BY loan_issued_date DESC`,
      [customerIdNum]
    );

    console.log('📤 API RESPONSE WOULD BE:\n');
    console.log({
      activeLoans: activeLoansResult.rows,
      overdueLoans: overdueLoansResult.rows
    });

    console.log('\n📊 COUNTS:');
    console.log(`- Active loans: ${activeLoansResult.rows.length}`);
    console.log(`- Overdue loans: ${overdueLoansResult.rows.length}`);

    if (overdueLoansResult.rows.length > 0) {
      console.log('\n✅ OVERDUE LOANS FOUND:');
      overdueLoansResult.rows.forEach(loan => {
        console.log(`  - Loan ID: ${loan.id}`);
        console.log(`    Status: ${loan.status}`);
        console.log(`    Amount: ${loan.loan_amount}`);
        console.log(`    Due Date: ${loan.due_date}`);
      });
    } else {
      console.log('\n⚠️  NO OVERDUE LOANS IN API RESPONSE!');
    }

    await pool.end();
  } catch (error) {
    console.error('❌ Error:', error.message);
    await pool.end();
  }
}

testAPIResponse();
