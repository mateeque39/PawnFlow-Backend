/**
 * Fix Loan Remaining Balance After Extension
 * =========================================
 * 
 * This script fixes loans that were retroactively extended but have incorrect
 * remaining_balance. The problem: remaining_balance should be principal + interest,
 * but was set to just principal.
 * 
 * This script recalculates remaining_balance for all extended loans to include
 * the interest amount for the new cycle.
 * 
 * Usage: node fix-extended-loans-remaining-balance.js
 */

const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
});

const LOG_PREFIX = '🔧 FIX LOAN BALANCE:';

async function fixLoans() {
  const client = await pool.connect();

  try {
    console.log(`\n${LOG_PREFIX} Starting loan balance correction...\n`);

    // Get all active loans that are marked as extended
    const loansResult = await client.query(
      `SELECT id, loan_amount, interest_rate, interest_amount, remaining_balance, 
              extended_this_cycle, interest_paid_this_cycle, due_date, status
       FROM loans 
       WHERE extended_this_cycle = true AND status = 'active'
       ORDER BY id ASC`
    );

    const loans = loansResult.rows;
    console.log(`${LOG_PREFIX} Found ${loans.length} extended loans\n`);

    if (loans.length === 0) {
      console.log(`${LOG_PREFIX} No extended loans to fix. Done! ✅\n`);
      return;
    }

    let correctedCount = 0;
    const correctedLoans = [];

    // Check each loan for data inconsistencies
    for (const loan of loans) {
      const loanId = loan.id;
      const principal = parseFloat(loan.loan_amount || 0);
      const interestRate = parseFloat(loan.interest_rate || 0);
      const interestAmount = parseFloat(loan.interest_amount || 0);
      const currentRemaining = parseFloat(loan.remaining_balance || 0);

      // Calculate what remaining balance should be
      const nextCycleInterest = Math.round((principal * interestRate / 100) * 100) / 100;
      const expectedRemaining = principal + nextCycleInterest;

      console.log(`\n📋 Checking Loan ${loanId}:`);
      console.log(`   Principal: $${principal.toFixed(2)}`);
      console.log(`   Interest Rate: ${interestRate}%`);
      console.log(`   Current Interest Amount: $${interestAmount.toFixed(2)}`);
      console.log(`   Current Remaining Balance: $${currentRemaining.toFixed(2)}`);
      console.log(`   Expected Remaining Balance: $${expectedRemaining.toFixed(2)}`);
      console.log(`   Interest Paid This Cycle: ${loan.interest_paid_this_cycle}`);

      // Check if there's a mismatch
      if (Math.abs(currentRemaining - expectedRemaining) > 0.01) {
        console.log(`   ⚠️  MISMATCH DETECTED! Difference: $${(expectedRemaining - currentRemaining).toFixed(2)}`);

        // Fix the remaining balance
        const updateResult = await client.query(
          `UPDATE loans 
           SET 
             remaining_balance = $1,
             interest_amount = $2,
             updated_at = CURRENT_TIMESTAMP
           WHERE id = $3
           RETURNING id, remaining_balance, interest_amount`,
          [expectedRemaining, nextCycleInterest, loanId]
        );

        correctedCount++;
        const updated = updateResult.rows[0];
        correctedLoans.push({
          loanId,
          originalRemaining: currentRemaining,
          newRemaining: updated.remaining_balance,
          principalAmount: principal,
          newInterestAmount: updated.interest_amount,
          correctionAmount: (expectedRemaining - currentRemaining).toFixed(2)
        });

        console.log(`   ✅ FIXED!`);
        console.log(`      New Remaining Balance: $${updated.remaining_balance}`);
        console.log(`      New Interest Amount: $${updated.interest_amount}`);
      } else {
        console.log(`   ✓ Balance is correct`);
      }
    }

    // Summary
    console.log(`\n${'='.repeat(70)}`);
    console.log(`${LOG_PREFIX} CORRECTION COMPLETE`);
    console.log(`${'='.repeat(70)}`);
    console.log(`✅ Corrected ${correctedCount} loans out of ${loans.length} total\n`);

    if (correctedLoans.length > 0) {
      console.log('Fixed Loans Summary:');
      console.log('────────────────────────────────────────────────────────────────────');
      correctedLoans.forEach((loan, idx) => {
        console.log(`${idx + 1}. Loan #${loan.loanId}`);
        console.log(`   Principal: $${loan.principalAmount}`);
        console.log(`   Original Remaining Balance: $${loan.originalRemaining}`);
        console.log(`   New Remaining Balance: $${loan.newRemaining}`);
        console.log(`   New Interest Amount: $${loan.newInterestAmount}`);
        console.log(`   Correction Applied: +$${loan.correctionAmount}`);
      });
      console.log('────────────────────────────────────────────────────────────────────\n');
    }

  } catch (err) {
    console.error(`\n❌ ${LOG_PREFIX} Fix failed:`, err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

// Run the fix
fixLoans();
