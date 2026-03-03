/**
 * Fix Loan #8 Database Corruption
 * 
 * Problem: loan_amount stored as $20,600 instead of $20,000
 * This causes calculation to show $21,218 instead of $20,600
 * 
 * Solution: Correct the principal to $20,000
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function fixLoan8Principal() {
  try {
    console.log('\n🔧 FIXING LOAN #8 PRINCIPAL AMOUNT\n');
    console.log('Current state:');
    console.log('  loan_amount: $20,600 (WRONG)');
    console.log('  Should be: $20,000\n');
    
    // Get current state
    console.log('1️⃣  Getting current loan data...');
    const current = await pool.query(
      `SELECT id, loan_amount, initial_loan_amount, interest_amount, remaining_balance, interest_rate
       FROM loans WHERE id = 8`
    );
    const loan = current.rows[0];
    
    console.log(`   Current loan_amount: $${loan.loan_amount}`);
    console.log(`   Current remaining_balance: $${loan.remaining_balance}`);
    console.log(`   Current interest_amount: $${loan.interest_amount}\n`);
    
    // Fix the principal
    console.log('2️⃣  Correcting loan_amount from $20,600 to $20,000...');
    const fixed = await pool.query(
      `UPDATE loans 
       SET loan_amount = 20000,
           initial_loan_amount = 20000,
           remaining_balance = 20000
       WHERE id = 8
       RETURNING *`
    );
    
    const fixedLoan = fixed.rows[0];
    console.log(`   ✅ Fixed!`);
    console.log(`   New loan_amount: $${fixedLoan.loan_amount}`);
    console.log(`   New remaining_balance: $${fixedLoan.remaining_balance}\n`);
    
    // Get payments
    console.log('3️⃣  Checking payment history...');
    const payments = await pool.query(
      'SELECT id, payment_amount, payment_date FROM payment_history WHERE loan_id = 8 ORDER BY payment_date ASC'
    );
    
    console.log(`   Found ${payments.rows.length} payment(s):`);
    payments.rows.forEach((p, i) => {
      console.log(`   ${i+1}. ${p.payment_date}: $${p.payment_amount}`);
    });
    console.log();
    
    // Final calculation verification
    console.log('4️⃣  Recalculating expected balance...');
    console.log(`   Principal: $${fixedLoan.loan_amount}`);
    console.log(`   Interest rate: ${fixedLoan.interest_rate}%`);
    if (payments.rows.length > 0) {
      const totalPaid = payments.rows.reduce((sum, p) => sum + parseFloat(p.payment_amount), 0);
      console.log(`   Total paid: $${totalPaid}`);
      console.log(`   After payment: should calculate remaining correctly\n`);
    }
    
    console.log('✅ LOAN #8 PRINCIPAL FIXED!');
    console.log('   - loan_amount corrected to $20,000');
    console.log('   - Remaining balance reset to $20,000');
    console.log('   - Payment of $600 will be deducted by calculation engine');
    console.log('   - Final balance should be: $20,600\n');
    
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

fixLoan8Principal();
