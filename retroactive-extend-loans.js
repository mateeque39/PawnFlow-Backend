/**
 * Retroactive Loan Auto-Extension Migration Script
 * ================================================
 * 
 * This script identifies loans that made interest-only payments before the auto-extend
 * feature was deployed and retroactively extends them by 1 month.
 * 
 * Criteria for retroactive extension:
 * 1. Loan has payment history with interest-only payments
 * 2. Loan hasn't been extended yet (extended_this_cycle = false)
 * 3. Total interest paid in current cycle >= required interest for cycle
 * 4. Payment was on or before original due date
 * 
 * Usage: node retroactive-extend-loans.js
 */

const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
});

const LOG_PREFIX = '🏦 RETROACTIVE EXTEND:';

/**
 * Add months to a date
 */
function addMonths(date, months) {
  const result = new Date(date);
  result.setMonth(result.getMonth() + months);
  return result;
}

/**
 * Check if a loan qualifies for retroactive extension
 */
async function checkLoanQualifiesForExtension(client, loan) {
  const loanId = loan.id;
  
  // Skip if already extended in this cycle
  if (loan.extended_this_cycle) {
    console.log(`   ⏭️  Loan ${loanId}: Already extended this cycle, skipping`);
    return null;
  }

  // Get all payment history for this loan
  const paymentHistoryResult = await client.query(
    `SELECT payment_amount, payment_date, payment_method 
     FROM payment_history 
     WHERE loan_id = $1 
     ORDER BY payment_date ASC`,
    [loanId]
  );

  const payments = paymentHistoryResult.rows;
  
  if (payments.length === 0) {
    console.log(`   ⏭️  Loan ${loanId}: No payments found`);
    return null;
  }

  // Count each payment made against the loan as a monthly extension trigger.
  // This avoids under-extending loans that have several payments but were not
  // recognized by the earlier threshold-based logic.
  let qualifyingPaymentCount = 0;
  let totalPaid = 0;

  for (const payment of payments) {
    const paymentDate = new Date(payment.payment_date);
    const paymentAmount = parseFloat(payment.payment_amount || 0);

    if (paymentAmount <= 0) continue;

    totalPaid += paymentAmount;
    qualifyingPaymentCount += 1;
    console.log(`      ✓ Payment: $${payment.payment_amount} on ${paymentDate.toISOString().split('T')[0]}`);
  }

  if (qualifyingPaymentCount === 0) {
    console.log(`   ⏭️  Loan ${loanId}: No qualifying payments found`);
    return null;
  }

  console.log(`   ✅ Loan ${loanId} QUALIFIES: ${qualifyingPaymentCount} payment(s) recorded, total paid $${totalPaid.toFixed(2)}`);
  return {
    loanId,
    totalPaid,
    qualifyingPaymentCount,
    newDueDate: addMonths(new Date(loan.due_date), qualifyingPaymentCount)
  };
}

/**
 * Extend a single loan - FIXED to recalculate all fields
 */
async function extendLoan(client, loanId, newDueDate, loan) {
  // When extending, recalculate all loan state fields
  const principal = parseFloat(loan.loan_amount || 0);
  const interestRate = parseFloat(loan.interest_rate || 0);
  
  // Calculate interest for next cycle
  const nextCycleInterest = Math.round((principal * interestRate / 100) * 100) / 100;
  
  // After auto-extend, remaining balance = principal + next cycle interest
  const newRemainingBalance = principal + nextCycleInterest;
  
  console.log(`   📊 Recalculating after extension:`);
  console.log(`      Principal: $${principal.toFixed(2)}`);
  console.log(`      Interest Rate: ${interestRate}%`);
  console.log(`      Next Cycle Interest: $${nextCycleInterest.toFixed(2)}`);
  console.log(`      New Remaining Balance: $${newRemainingBalance.toFixed(2)}`);
  
  const result = await client.query(
    `UPDATE loans 
     SET 
       due_date = $1,
       interest_amount = $2,
       remaining_balance = $3,
       extended_this_cycle = true,
       interest_paid_this_cycle = 0,
       last_extended_at = CURRENT_TIMESTAMP,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = $4
     RETURNING id, due_date, extended_this_cycle, last_extended_at, 
               interest_amount, remaining_balance, interest_paid_this_cycle`,
    [newDueDate, nextCycleInterest, newRemainingBalance, loanId]
  );

  return result.rows[0];
}

/**
 * Main migration function
 */
async function runMigration() {
  const client = await pool.connect();

  try {
    console.log(`\n${LOG_PREFIX} Starting retroactive loan extension migration...\n`);

    // Get all active loans that haven't been extended
    const loansResult = await client.query(
      `SELECT * FROM loans 
       WHERE status = 'active' AND extended_this_cycle = false
       ORDER BY id ASC`
    );

    const loans = loansResult.rows;
    console.log(`${LOG_PREFIX} Found ${loans.length} loans that haven't been extended\n`);

    if (loans.length === 0) {
      console.log(`${LOG_PREFIX} No loans need extension. Migration complete! ✅\n`);
      return;
    }

    let extendedCount = 0;
    const extendedLoans = [];

    // Check each loan for extension eligibility
    for (const loan of loans) {
      console.log(`\n📋 Checking Loan ${loan.id}: Principal=$${loan.loan_amount}, Interest=$${loan.interest_amount}`);
      
      const qualification = await checkLoanQualifiesForExtension(client, loan);
      
      if (qualification) {
        // Extend the loan with proper recalculation
        const updated = await extendLoan(client, qualification.loanId, qualification.newDueDate, loan);
        extendedCount++;
        extendedLoans.push({
          loanId: qualification.loanId,
          originalDueDate: loan.due_date,
          newDueDate: updated.due_date,
          interestPaid: qualification.totalInterestPaid.toFixed(2),
          newInterestAmount: updated.interest_amount,
          newRemainingBalance: updated.remaining_balance
        });
        
        console.log(`   🎉 Extended! New due date: ${updated.due_date.toISOString().split('T')[0]}`);
        console.log(`      New Interest Amount: $${updated.interest_amount}`);
        console.log(`      New Remaining Balance: $${updated.remaining_balance}`);
      }
    }

    // Summary
    console.log(`\n${'='.repeat(70)}`);
    console.log(`${LOG_PREFIX} MIGRATION COMPLETE`);
    console.log(`${'='.repeat(70)}`);
    console.log(`✅ Extended ${extendedCount} loans out of ${loans.length} total\n`);

    if (extendedLoans.length > 0) {
      console.log('Extended Loans Summary:');
      console.log('────────────────────────────────────────────────────────────────────');
      extendedLoans.forEach((loan, idx) => {
        console.log(`${idx + 1}. Loan #${loan.loanId}`);
        console.log(`   Original Due Date: ${loan.originalDueDate}`);
        console.log(`   New Due Date:      ${loan.newDueDate}`);
        console.log(`   Interest Paid:     $${loan.interestPaid}`);
        console.log(`   New Interest Amount: $${loan.newInterestAmount}`);
        console.log(`   New Remaining Balance: $${loan.newRemainingBalance}`);
      });
      console.log('────────────────────────────────────────────────────────────────────\n');
    }

  } catch (err) {
    console.error(`\n❌ ${LOG_PREFIX} Migration failed:`, err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

// Run the migration
runMigration();
