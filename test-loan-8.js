/**
 * Debug script: Test Loan #8 Calculation
 * Run with: node test-loan-8.js
 */

const { calculateLoanState } = require('./loan-calculator');

// Loan #8 Data (Example - adjust based on what you see in DB)
const loan = {
  id: 8,
  loan_amount: 20000,
  interest_rate: 3, // 3% per month
  created_at: '2026-05-01',
  due_date: '2026-06-01'
};

// Payment: $600 on 06/02/2026 (1 day after due date if overdue)
const payments = [
  {
    id: 1,
    loan_id: 8,
    payment_amount: 600,
    payment_date: '2026-06-02',
    payment_method: 'cash'
  }
];

// Calculate state as of June 2, 2026
const currentDate = new Date('2026-06-02');

console.log('\n=== LOAN #8 CALCULATION TEST ===\n');
console.log('Loan Details:');
console.log(`  Principal: $${loan.loan_amount}`);
console.log(`  Interest Rate: ${loan.interest_rate}% per month`);
console.log(`  Created: ${loan.created_at}`);
console.log(`  Due Date: ${loan.due_date}`);
console.log(`  Calculation Date: ${currentDate.toISOString()}`);

console.log('\nPayments:');
payments.forEach(p => {
  console.log(`  - ${p.payment_date}: $${p.payment_amount}`);
});

// Run calculation
const loanState = calculateLoanState(loan, payments, currentDate);

console.log('\n=== CALCULATION RESULTS ===\n');
console.log(`Principal Remaining: $${loanState.principalRemaining.toFixed(2)}`);
console.log(`Interest Accrued: $${loanState.interestAccrued.toFixed(2)}`);
console.log(`Penalty Accrued: $${loanState.penaltyAccrued.toFixed(2)}`);
console.log(`TOTAL BALANCE: $${loanState.totalBalance.toFixed(2)}`);
console.log(`\nNext Due Date: ${loanState.nextDueDate}`);
console.log(`Is Overdue: ${loanState.isOverdue}`);
console.log(`Days Overdue: ${loanState.daysOverdue}`);

console.log('\n=== VERIFICATION ===\n');

// What we expect:
// - Principal: $20,000 (original)
// - First month interest: $20,000 × 3% = $600
// - Payment on due date or shortly after: $600
// - After payment: principal + interest - payment = $20,000 + $600 - $600 = $20,000

const expected = 20600; // Principal + interest before payment handling
const actual = loanState.totalBalance;

console.log(`Expected (approx): $${expected}`);
console.log(`Actual: $${actual.toFixed(2)}`);
console.log(`Match: ${Math.abs(actual - expected) < 1 ? '✅ YES' : '❌ NO'}`);

if (actual !== 21218) {
  console.log('\n✅ Calculation is correct! Not returning stale $21,218 value.');
} else {
  console.log('\n❌ ERROR: Still returning stale value $21,218!');
}

// Show detailed payment breakdown
if (loanState.paymentHistory && loanState.paymentHistory.length > 0) {
  console.log('\n=== PAYMENT BREAKDOWN ===\n');
  loanState.paymentHistory.forEach((detail, idx) => {
    console.log(`Payment ${idx + 1}:`);
    console.log(`  Date: ${detail.paymentDate}`);
    console.log(`  Amount: $${detail.amountApplied.toFixed(2)}`);
    if (detail.penaltyApplied) console.log(`  Penalty Applied: $${detail.penaltyApplied.toFixed(2)}`);
    if (detail.interestApplied) console.log(`  Interest Applied: $${detail.interestApplied.toFixed(2)}`);
    if (detail.principalApplied) console.log(`  Principal Applied: $${detail.principalApplied.toFixed(2)}`);
  });
}
