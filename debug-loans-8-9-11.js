require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function debugLoans() {
  try {
    console.log('\n========== DETAILED LOAN ANALYSIS ==========\n');

    // Get loans data
    const loansRes = await pool.query(
      `SELECT id, created_at, due_date, loan_amount, interest_amount, 
              remaining_balance, extended_this_cycle, interest_paid_this_cycle,
              interest_rate, status FROM loans WHERE id IN (8,9,11) ORDER BY id`
    );

    for (const loan of loansRes.rows) {
      console.log(`\n📋 LOAN ${loan.id}`);
      console.log('  Created:'.padEnd(25), new Date(loan.created_at).toISOString().split('T')[0]);
      console.log('  Original Due Date:'.padEnd(25), new Date(loan.due_date).toISOString().split('T')[0]);
      console.log('  Principal (loan_amount):'.padEnd(25), loan.loan_amount);
      console.log('  Interest Rate:'.padEnd(25), loan.interest_rate + '%');
      console.log('  Interest Amount:'.padEnd(25), loan.interest_amount);
      console.log('  Remaining Balance:'.padEnd(25), loan.remaining_balance);
      console.log('  Expected Remaining:'.padEnd(25), parseFloat(loan.loan_amount) + parseFloat(loan.interest_amount));
      console.log('  Extended This Cycle:'.padEnd(25), loan.extended_this_cycle);
      console.log('  Interest Paid This Cycle:'.padEnd(25), loan.interest_paid_this_cycle);
      console.log('  Status:'.padEnd(25), loan.status);
    }

    // Get payment history
    console.log('\n========== PAYMENT HISTORY ==========\n');
    const paymentsRes = await pool.query(
      `SELECT loan_id, payment_amount, payment_date, payment_method 
       FROM payment_history WHERE loan_id IN (8,9,11) ORDER BY loan_id, payment_date`
    );

    for (const payment of paymentsRes.rows) {
      console.log(`Loan ${payment.loan_id}: Payment $${payment.payment_amount} on ${new Date(payment.payment_date).toISOString().split('T')[0]} (${payment.payment_method})`);
    }

    // Analysis
    console.log('\n========== ANALYSIS ==========\n');
    for (const loan of loansRes.rows) {
      const expectedRemaining = parseFloat(loan.loan_amount) + parseFloat(loan.interest_amount);
      const actualRemaining = parseFloat(loan.remaining_balance);
      const difference = expectedRemaining - actualRemaining;
      
      console.log(`Loan ${loan.id}:`);
      console.log(`  Expected Remaining = ${loan.loan_amount} + ${loan.interest_amount} = ${expectedRemaining}`);
      console.log(`  Actual Remaining = ${actualRemaining}`);
      console.log(`  MISMATCH: ${difference !== 0 ? 'YES (Difference: ' + difference + ')' : 'NO'}`);
      console.log('');
    }

  } catch (err) {
    console.error('Error:', err);
  } finally {
    await pool.end();
  }
}

debugLoans();
