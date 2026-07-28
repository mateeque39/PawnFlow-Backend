/**
 * Auto-Extend Payment Tests
 * Tests for the business rule: Auto-extend due date by 1 month when interest-only is paid before due date
 */

const { processPaymentWithAutoExtend } = require('./payment-utils');

console.log('🧪 Starting Auto-Extend Payment Tests...\n');

// Test utilities
let testsPassed = 0;
let testsFailed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`   ✅ ${message}`);
    testsPassed++;
  } else {
    console.log(`   ❌ ${message}`);
    testsFailed++;
  }
}

function createTestLoan(overrides = {}) {
  return {
    id: 1,
    loan_amount: 20000,
    interest_rate: 3,
    interest_amount: 600, // 3% of 20000
    remaining_balance: 20600,
    due_date: '2024-03-15',
    status: 'active',
    interest_paid_this_cycle: 0,
    extended_this_cycle: false,
    ...overrides
  };
}

// ===== TEST 1: Single payment == interestAmount triggers extension =====
console.log('TEST 1: Single payment == interest amount triggers extension');
{
  const loan = createTestLoan();
  const paymentDate = new Date('2024-03-10'); // Before due date
  const paymentAmount = 600; // Equals interest amount

  const result = processPaymentWithAutoExtend(loan, paymentAmount, paymentDate);

  assert(result.autoExtendTriggered === true, 'Auto-extend triggered');
  assert(result.newExtendedThisCycle === true, 'Extended this cycle flag set');
  assert(result.newDueDate === '2024-04-15', 'Due date extended by 1 month');
  assert(result.newPrincipal === 20000, 'Principal unchanged');
  assert(result.newInterestAmount === 600, 'Next cycle interest calculated correctly');
  assert(result.finalRemainingBalance === 20600, 'Remaining balance: principal + next cycle interest');
  assert(result.newInterestPaidThisCycle === 0, 'Interest paid this cycle reset');
  console.log('');
}

// ===== TEST 2: Multiple partial payments sum to interestAmount triggers extension =====
console.log('TEST 2: Multiple partial payments sum to interest amount triggers extension');
{
  const loan = createTestLoan({
    interest_paid_this_cycle: 300 // Previous payment of 300
  });
  const paymentDate = new Date('2024-03-12'); // Before due date
  const paymentAmount = 300; // New payment (total 300 + 300 = 600)

  const result = processPaymentWithAutoExtend(loan, paymentAmount, paymentDate);

  assert(result.autoExtendTriggered === true, 'Auto-extend triggered with accumulated payments');
  assert(result.newExtendedThisCycle === true, 'Extended this cycle flag set');
  assert(result.newDueDate === '2024-04-15', 'Due date extended by 1 month');
  assert(result.newInterestPaidThisCycle === 0, 'Interest paid this cycle reset');
  console.log('');
}

// ===== TEST 3: Payment after due date should still trigger extension if interest covered
console.log('TEST 3: Payment after due date should still trigger extension if interest covered');
{
  const loan = createTestLoan();
  const paymentDate = new Date('2024-03-20'); // After due date (2024-03-15)
  const paymentAmount = 600; // Equals interest amount

  const result = processPaymentWithAutoExtend(loan, paymentAmount, paymentDate);

  assert(result.autoExtendTriggered === true, 'Auto-extend triggered after due date when interest covered');
  assert(result.newDueDate === '2024-04-15', 'Due date extended by 1 month');
  assert(result.finalRemainingBalance === 20600, 'Remaining balance updated to principal + next cycle interest');
  console.log('');
}

// ===== TEST 4: Cannot extend twice in same cycle =====
console.log('TEST 4: Cannot extend twice in same cycle');
{
  const loan = createTestLoan({
    extended_this_cycle: true // Already extended
  });
  const paymentDate = new Date('2024-03-12'); // Before due date
  const paymentAmount = 600;

  const result = processPaymentWithAutoExtend(loan, paymentAmount, paymentDate);

  assert(result.autoExtendTriggered === false, 'Auto-extend NOT triggered (already extended)');
  assert(result.newExtendedThisCycle === true, 'Still marked as extended this cycle');
  assert(result.newDueDate === '2024-03-15', 'Due date unchanged');
  console.log('');
}

// ===== TEST 5: Payment less than interestAmount doesn't trigger extension =====
console.log('TEST 5: Payment less than interest amount does NOT trigger extension');
{
  const loan = createTestLoan();
  const paymentDate = new Date('2024-03-10'); // Before due date
  const paymentAmount = 300; // Less than 600

  const result = processPaymentWithAutoExtend(loan, paymentAmount, paymentDate);

  assert(result.autoExtendTriggered === false, 'Auto-extend NOT triggered (insufficient payment)');
  assert(result.newInterestPaidThisCycle === 300, 'Interest payment accumulated');
  assert(result.newDueDate === '2024-03-15', 'Due date unchanged');
  console.log('');
}

// ===== TEST 6: Multiple extension attempts blocked (cycle 2) =====
console.log('TEST 6: Multiple extension attempts blocked (second attempt in same cycle)');
{
  // First payment extends the loan
  const loan = createTestLoan();
  const paymentDate1 = new Date('2024-03-10');
  const result1 = processPaymentWithAutoExtend(loan, 600, paymentDate1);

  // Update loan with result from first payment
  const loanAfterExtension = {
    ...loan,
    due_date: result1.newDueDate,
    interest_paid_this_cycle: result1.newInterestPaidThisCycle,
    extended_this_cycle: result1.newExtendedThisCycle,
    remaining_balance: result1.finalRemainingBalance
  };

  // Try to make another payment in same cycle
  const paymentDate2 = new Date('2024-03-12');
  const result2 = processPaymentWithAutoExtend(loanAfterExtension, 300, paymentDate2);

  assert(result1.autoExtendTriggered === true, 'First payment triggers extension');
  assert(result2.autoExtendTriggered === false, 'Second payment does NOT trigger extension');
  console.log('');
}

// ===== TEST 7: Payment on exact due date triggers extension =====
console.log('TEST 7: Payment on exact due date DOES trigger extension');
{
  const loan = createTestLoan();
  const paymentDate = new Date('2024-03-15'); // Exactly on due date
  const paymentAmount = 600;

  const result = processPaymentWithAutoExtend(loan, paymentAmount, paymentDate);

  assert(result.autoExtendTriggered === true, 'Auto-extend triggered on due date');
  assert(result.newDueDate === '2024-04-15', 'Due date extended by 1 month');
  console.log('');
}

// ===== TEST 8: Partial payment before due date accumulates properly =====
console.log('TEST 8: Partial payment before due date accumulates properly');
{
  const loan = createTestLoan();
  const paymentDate = new Date('2024-03-08'); // 7 days before due date
  const paymentAmount = 200; // Partial payment

  const result = processPaymentWithAutoExtend(loan, paymentAmount, paymentDate);

  assert(result.autoExtendTriggered === false, 'Auto-extend NOT triggered (insufficient)');
  assert(result.newInterestPaidThisCycle === 200, 'Interest paid accumulated');
  assert(result.finalRemainingBalance === 20400, 'Remaining balance reduced by payment amount');
  console.log('');
}

// ===== TEST 9: Full payment (remaining balance reached) marks loan as redeemed =====
console.log('TEST 9: Full payment marks loan as redeemed');
{
  const loan = createTestLoan({
    remaining_balance: 300 // Very low remaining balance
  });
  const paymentDate = new Date('2024-03-10');
  const paymentAmount = 300; // Pays off entire remaining balance

  const result = processPaymentWithAutoExtend(loan, paymentAmount, paymentDate);

  assert(result.autoExtendTriggered === false, 'Auto-extend NOT triggered (full payment)');
  assert(result.newStatus === 'redeemed', 'Status changed to redeemed');
  assert(result.finalRemainingBalance === 0, 'Remaining balance is zero');
  console.log('');
}

// ===== TEST 10: Month-end date handling (extending from 31st) =====
console.log('TEST 10: Month-end date handling (extending from Jan 31)');
{
  const loan = createTestLoan({
    due_date: '2024-01-31' // End of January
  });
  const paymentDate = new Date('2024-01-25');
  const paymentAmount = 600;

  const result = processPaymentWithAutoExtend(loan, paymentAmount, paymentDate);

  assert(result.autoExtendTriggered === true, 'Auto-extend triggered');
  // Feb 29 in 2024 (leap year) or Feb 28 otherwise
  assert(result.newDueDate === '2024-02-29', 'Due date correctly extended to Feb 29 (leap year)');
  console.log('');
}

// ===== SUMMARY =====
console.log('\n========================================');
console.log(`📊 Test Results:`);
console.log(`   ✅ Passed: ${testsPassed}`);
console.log(`   ❌ Failed: ${testsFailed}`);
console.log(`   Total: ${testsPassed + testsFailed}`);

if (testsFailed === 0) {
  console.log('\n🎉 All tests passed!');
  process.exit(0);
} else {
  console.log(`\n⚠️ ${testsFailed} test(s) failed!`);
  process.exit(1);
}
