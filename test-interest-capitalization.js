#!/usr/bin/env node

/**
 * Test Suite: Interest Capitalization System
 * Run individual tests to verify the implementation
 */

const { processPaymentWithCapitalization, capitalizeInterest, extendDateByOneMonth } = require('./payment-utils');

console.log('🧪 INTEREST CAPITALIZATION TEST SUITE\n');
console.log('='.repeat(70));

// Test 1: Date Extension
console.log('\nTest 1: Date Extension by One Month');
console.log('-'.repeat(70));

const tests1 = [
  { date: '2025-03-15', expected: '2025-04-15' },
  { date: '2025-01-31', expected: '2025-02-28' }, // Month with fewer days
  { date: '2025-12-31', expected: '2026-01-31' }, // Year boundary
];

tests1.forEach((test, i) => {
  const result = extendDateByOneMonth(test.date);
  const passed = result === test.expected;
  console.log(`  ${i + 1}. Input: ${test.date}`);
  console.log(`     Expected: ${test.expected}`);
  console.log(`     Result: ${result}`);
  console.log(`     Status: ${passed ? '✅ PASS' : '❌ FAIL'}\n`);
});

// Test 2: Interest Capitalization Calculation
console.log('\nTest 2: Interest Capitalization Calculation');
console.log('-'.repeat(70));

const mockLoan = {
  id: 1,
  loan_amount: 1000,
  interest_amount: 100,
  interest_rate: 10,
  due_date: '2025-03-15'
};

const capitalizedResult = capitalizeInterest(mockLoan);
console.log(`  Input Loan:`);
console.log(`    Principal: $${mockLoan.loan_amount}`);
console.log(`    Interest: $${mockLoan.interest_amount}`);
console.log(`    Rate: ${mockLoan.interest_rate}%`);
console.log(`\n  Results:`);
console.log(`    New Principal: $${capitalizedResult.newPrincipal} (should be $1100)`);
console.log(`    New Interest: $${capitalizedResult.newInterestAmount} (should be $110)`);
console.log(`    Capitalized: $${capitalizedResult.capitalizedInterestAmount}`);
console.log(`    Total Balance: $${capitalizedResult.totalRemainingBalance}`);

const test2Passed = 
  capitalizedResult.newPrincipal === 1100 &&
  capitalizedResult.newInterestAmount === 110 &&
  capitalizedResult.capitalizedInterestAmount === 100 &&
  capitalizedResult.totalRemainingBalance === 1210;

console.log(`\n  Status: ${test2Passed ? '✅ PASS' : '❌ FAIL'}\n`);

// Test 3: Payment Processing - Interest Payment
console.log('\nTest 3: Payment Processing - Payment >= Interest (Active Loan)');
console.log('-'.repeat(70));

const loan3 = {
  id: 1,
  loan_amount: 1000,
  interest_amount: 100,
  interest_rate: 10,
  remaining_balance: 1100,
  due_date: '2025-03-15',
  status: 'active'
};

const result3 = processPaymentWithCapitalization(loan3, 100, 100);
console.log(`  Payment Amount: $100 (= Monthly Interest)`);
console.log(`  Original Due Date: ${loan3.due_date}`);
console.log(`\n  Results:`);
console.log(`    New Principal: $${result3.newPrincipal} (should be $1100)`);
console.log(`    New Interest: $${result3.newInterestAmount} (should be $110)`);
console.log(`    Final Balance: $${result3.finalRemainingBalance} (should be $1210)`);
console.log(`    Interest Capitalized: ${result3.interestCapitalized} (should be true)`);
console.log(`    Due Date Extended: ${result3.dueDateExtended} (should be true)`);
console.log(`    New Due Date: ${result3.newDueDate} (should be 2025-04-15)`);

const test3Passed = 
  result3.newPrincipal === 1100 &&
  result3.newInterestAmount === 110 &&
  result3.finalRemainingBalance === 1210 &&
  result3.interestCapitalized === true &&
  result3.dueDateExtended === true &&
  result3.newDueDate === '2025-04-15';

console.log(`\n  Status: ${test3Passed ? '✅ PASS' : '❌ FAIL'}\n`);

// Test 4: Payment Processing - Partial Payment
console.log('\nTest 4: Payment Processing - Payment < Interest (Partial)');
console.log('-'.repeat(70));

const loan4 = {
  id: 2,
  loan_amount: 1000,
  interest_amount: 100,
  interest_rate: 10,
  remaining_balance: 1100,
  due_date: '2025-03-15',
  status: 'active'
};

const result4 = processPaymentWithCapitalization(loan4, 50, 50);
console.log(`  Payment Amount: $50 (< Monthly Interest of $100)`);
console.log(`\n  Results:`);
console.log(`    Principal: $${result4.newPrincipal} (should remain $1000)`);
console.log(`    Interest: $${result4.newInterestAmount} (should remain $100)`);
console.log(`    Final Balance: $${result4.finalRemainingBalance} (should be $1050)`);
console.log(`    Interest Capitalized: ${result4.interestCapitalized} (should be false)`);
console.log(`    Due Date Extended: ${result4.dueDateExtended} (should be false)`);

const test4Passed = 
  result4.newPrincipal === 1000 &&
  result4.newInterestAmount === 100 &&
  result4.finalRemainingBalance === 1050 &&
  result4.interestCapitalized === false &&
  result4.dueDateExtended === false;

console.log(`\n  Status: ${test4Passed ? '✅ PASS' : '❌ FAIL'}\n`);

// Test 5: Payment Processing - Full Payment
console.log('\nTest 5: Payment Processing - Full Payment');
console.log('-'.repeat(70));

const loan5 = {
  id: 3,
  loan_amount: 1000,
  interest_amount: 100,
  interest_rate: 10,
  remaining_balance: 1100,
  due_date: '2025-03-15',
  status: 'active'
};

const result5 = processPaymentWithCapitalization(loan5, 1100, 1100);
console.log(`  Payment Amount: $1100 (= Full Remaining Balance)`);
console.log(`\n  Results:`);
console.log(`    Final Balance: $${result5.finalRemainingBalance} (should be $0)`);
console.log(`    New Status: ${result5.newStatus} (should be 'redeemed')`);

const test5Passed = 
  result5.finalRemainingBalance === 0 &&
  result5.newStatus === 'redeemed';

console.log(`\n  Status: ${test5Passed ? '✅ PASS' : '❌ FAIL'}\n`);

// Test 6: Payment Processing - Overdue Loan with Interest Payment
console.log('\nTest 6: Payment Processing - Overdue Loan + Interest Payment');
console.log('-'.repeat(70));

const loan6 = {
  id: 4,
  loan_amount: 1000,
  interest_amount: 100,
  interest_rate: 10,
  remaining_balance: 1100,
  due_date: '2025-02-01', // Past due
  status: 'overdue'
};

const result6 = processPaymentWithCapitalization(loan6, 100, 100);
console.log(`  Loan Status: overdue`);
console.log(`  Payment Amount: $100 (= Monthly Interest)`);
console.log(`\n  Results:`);
console.log(`    New Status: ${result6.newStatus} (should be 'active')`);
console.log(`    Principal: $${result6.newPrincipal} (should be $1100)`);
console.log(`    Interest Capitalized: ${result6.interestCapitalized} (should be true)`);
console.log(`    Status Changed from overdue to active: ${result6.newStatus === 'active'} (should be true)`);

const test6Passed = 
  result6.newStatus === 'active' &&
  result6.newPrincipal === 1100 &&
  result6.interestCapitalized === true;

console.log(`\n  Status: ${test6Passed ? '✅ PASS' : '❌ FAIL'}\n`);

// Test 7: Multiple Payments Scenario
console.log('\nTest 7: Multiple Payments Scenario (Sequential)');
console.log('-'.repeat(70));

let loan7 = {
  id: 5,
  loan_amount: 1000,
  interest_amount: 100,
  interest_rate: 10,
  remaining_balance: 1100,
  due_date: '2025-03-15',
  status: 'active'
};

console.log(`  Month 1:`);
console.log(`    Starting: Principal=$${loan7.loan_amount}, Interest=$${loan7.interest_amount.toFixed(2)}`);

// Payment 1: Interest payment
const payment1 = processPaymentWithCapitalization(loan7, 100, 100);
loan7 = {
  ...loan7,
  loan_amount: payment1.newPrincipal,
  interest_amount: payment1.newInterestAmount,
  remaining_balance: payment1.finalRemainingBalance,
  due_date: payment1.newDueDate,
  status: payment1.newStatus
};

console.log(`    After $100 Payment: Principal=$${loan7.loan_amount.toFixed(2)}, Interest=$${loan7.interest_amount.toFixed(2)}, Due=${loan7.due_date}`);

// Payment 2: Interest payment on new principal
const payment2 = processPaymentWithCapitalization(loan7, 110, 210);
loan7 = {
  ...loan7,
  loan_amount: payment2.newPrincipal,
  interest_amount: payment2.newInterestAmount,
  remaining_balance: payment2.finalRemainingBalance,
  due_date: payment2.newDueDate
};

console.log(`  Month 2:`);
console.log(`    After $110 Payment: Principal=$${loan7.loan_amount.toFixed(2)}, Interest=$${loan7.interest_amount.toFixed(2)}, Due=${loan7.due_date}`);

const test7Passed = 
  payment1.newPrincipal === 1100 &&
  payment2.newPrincipal === 1210 &&
  payment1.newInterestAmount === 110 &&
  payment2.newInterestAmount === 121;

console.log(`\n  Status: ${test7Passed ? '✅ PASS' : '❌ FAIL'}\n`);

// Summary
console.log('\n' + '='.repeat(70));
console.log('📊 TEST SUMMARY');
console.log('='.repeat(70));

const allTests = [
  { name: 'Date Extension', passed: tests1.every(t => extendDateByOneMonth(t.date) === t.expected) },
  { name: 'Interest Capitalization', passed: test2Passed },
  { name: 'Payment >= Interest', passed: test3Passed },
  { name: 'Payment < Interest', passed: test4Passed },
  { name: 'Full Payment', passed: test5Passed },
  { name: 'Overdue + Interest', passed: test6Passed },
  { name: 'Multiple Payments', passed: test7Passed }
];

allTests.forEach((test, i) => {
  console.log(`${i + 1}. ${test.name}: ${test.passed ? '✅' : '❌'}`);
});

const totalPassed = allTests.filter(t => t.passed).length;
const totalTests = allTests.length;

console.log('\n' + '-'.repeat(70));
console.log(`\nTotal: ${totalPassed}/${totalTests} tests passed`);

if (totalPassed === totalTests) {
  console.log('\n🎉 ALL TESTS PASSED! System is ready for deployment.\n');
  process.exit(0);
} else {
  console.log('\n❌ Some tests failed. Please review the implementation.\n');
  process.exit(1);
}
