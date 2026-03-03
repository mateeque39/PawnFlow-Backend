const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function cleanupLoan8() {
  try {
    console.log('🧹 Cleaning up Loan #8...\n');

    // 1. Check current payment history
    console.log('📋 Current Payment History for Loan 8:');
    const paymentsResult = await pool.query(
      'SELECT * FROM payment_history WHERE loan_id = 8 ORDER BY payment_date ASC'
    );
    
    if (paymentsResult.rows.length === 0) {
      console.log('   No payments found (already clean)\n');
    } else {
      console.log(`   Found ${paymentsResult.rows.length} payment(s):`);
      paymentsResult.rows.forEach((p, i) => {
        console.log(`   ${i+1}. ID: ${p.id}, Amount: $${p.payment_amount}, Date: ${p.payment_date}`);
      });
    }

    // 2. Check loan details
    console.log('\n📊 Loan #8 Details:');
    const loanResult = await pool.query('SELECT * FROM loans WHERE id = 8');
    const loan = loanResult.rows[0];
    
    if (!loan) {
      console.log('   Loan not found');
      return;
    }

    console.log(`   Principal (loan_amount): $${loan.loan_amount}`);
    console.log(`   Interest Rate: ${loan.interest_rate}%`);
    console.log(`   DB Remaining Balance: $${loan.remaining_balance}`);

    // 3. If there are 2+ payments of the same amount created on same day, remove the duplicate
    if (paymentsResult.rows.length >= 2) {
      // Group by payment_date and amount
      const grouped = {};
      paymentsResult.rows.forEach(p => {
        const key = `${p.payment_date}_${p.payment_amount}`;
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(p);
      });

      // Find duplicates
      const duplicates = [];
      for (const [key, payments] of Object.entries(grouped)) {
        if (payments.length > 1) {
          console.log(`\n⚠️  Found ${payments.length} identical payments for: ${key}`);
          // Keep first, mark others for deletion
          payments.slice(1).forEach(p => duplicates.push(p.id));
        }
      }

      if (duplicates.length > 0) {
        console.log(`\n🗑️  Deleting ${duplicates.length} duplicate payment(s)...`);
        
        for (const paymentId of duplicates) {
          const deleteResult = await pool.query(
            'DELETE FROM payment_history WHERE id = $1 RETURNING *',
            [paymentId]
          );
          console.log(`   ✅ Deleted payment ID ${paymentId}: $${deleteResult.rows[0].payment_amount} on ${deleteResult.rows[0].payment_date}`);
        }
      }
    }

    // 4. Verify fix
    console.log('\n✅ Final Payment History:');
    const finalResult = await pool.query(
      'SELECT * FROM payment_history WHERE loan_id = 8 ORDER BY payment_date ASC'
    );
    
    console.log(`   Total payments: ${finalResult.rows.length}`);
    finalResult.rows.forEach((p, i) => {
      console.log(`   ${i+1}. ID: ${p.id}, Amount: $${p.payment_amount}, Date: ${p.payment_date}`);
    });

    console.log('\n✨ Cleanup complete!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

cleanupLoan8();
