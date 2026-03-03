/**
 * Fix Loan #8 Data Issue
 * 
 * Problems:
 * 1. loan_amount stored as $20,600 (should be $20,000)
 * 2. Payment of $600 on 06/02/2026 23:46:01 is NOT in payments table
 * 
 * This script fixes both issues
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function fixLoan8() {
  try {
    console.log('🔧 Starting Loan #8 fix...\n');
    
    // Step 1: Fix loan_amount and initial_loan_amount
    console.log('Step 1: Correcting loan_amount from $20,600 to $20,000');
    const updateLoanResult = await pool.query(
      `UPDATE loans 
       SET loan_amount = 20000, 
           initial_loan_amount = COALESCE(initial_loan_amount, 20000),
           remaining_balance = 20000,
           interest_amount = 600
       WHERE id = 8`,
    );
    console.log(`✅ Updated loan record: ${updateLoanResult.rowCount} row(s) affected\n`);
    
    // Step 2: Check if payment already exists
    console.log('Step 2: Checking for existing payment record...');
    const existingPayment = await pool.query(
      `SELECT * FROM payments WHERE loan_id = 8 AND payment_date = '2026-06-02 23:46:01'`
    );
    
    if (existingPayment.rows.length > 0) {
      console.log('⚠️  Payment record already exists');
      console.log('   Existing payment:', existingPayment.rows[0]);
    } else {
      console.log('❌ Payment record missing, adding it...\n');
      
      // Insert the payment
      const insertPaymentResult = await pool.query(
        `INSERT INTO payments (loan_id, payment_amount, payment_date, payment_method, created_at)
         VALUES (8, 600, '2026-06-02 23:46:01', 'cash', NOW())
         RETURNING *`,
      );
      console.log(`✅ Added payment record:`);
      console.log(`   Amount: $${insertPaymentResult.rows[0].payment_amount}`);
      console.log(`   Date: ${insertPaymentResult.rows[0].payment_date}`);
      console.log(`   Method: ${insertPaymentResult.rows[0].payment_method}\n`);
    }
    
    // Step 3: Verify the fix
    console.log('Step 3: Verifying the fix...\n');
    const verifyLoan = await pool.query(
      `SELECT id, loan_amount, initial_loan_amount, remaining_balance, interest_amount, due_date 
       FROM loans WHERE id = 8`
    );
    const verifyPayments = await pool.query(
      `SELECT * FROM payments WHERE loan_id = 8 ORDER BY payment_date ASC`
    );
    
    console.log('Loan Record:');
    const loan = verifyLoan.rows[0];
    console.log(`  loan_amount: $${loan.loan_amount}`);
    console.log(`  initial_loan_amount: $${loan.initial_loan_amount}`);
    console.log(`  remaining_balance: $${loan.remaining_balance}`);
    console.log(`  interest_amount: $${loan.interest_amount}`);
    console.log(`  due_date: ${loan.due_date}\n`);
    
    console.log(`Payments (${verifyPayments.rows.length} total):`);
    verifyPayments.rows.forEach((p, i) => {
      console.log(`  ${i+1}. ${p.payment_date}: $${p.payment_amount} (${p.payment_method})`);
    });
    
    console.log('\n✅ Loan #8 fixed successfully!');
    console.log('   - Principal corrected to $20,000');
    console.log('   - Payment of $600 recorded');
    console.log('   - Calculation should now show correct balance of $20,000');
    
  } catch (err) {
    console.error('❌ Error fixing loan:', err.message);
    console.error(err);
  } finally {
    await pool.end();
  }
}

fixLoan8();
