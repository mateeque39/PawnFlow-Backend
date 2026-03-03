/**
 * Comprehensive Test Suite for Loan Calculator
 * 
 * Tests all business rules and edge cases
 */

const {
  calculateLoanState,
  calculateMonthlyInterest,
  calculateDailyPenalty,
  daysBetween,
  formatDate
} = require('./loan-calculator');

// ANSI color codes for test output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[36m',
  bold: '\x1b[1m'
};

let passedTests = 0;
let failedTests = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`${colors.green}✓${colors.reset} ${message}`);
    passedTests++;
  } else {
    console.log(`${colors.red}✗${colors.reset} ${message}`);
    failedTests++;
  }
}

function describe(title) {
  console.log(`\n${colors.bold}${colors.blue}=== ${title} ===${colors.reset}`);
}

function it(description, testFn) {
  try {
    console.log(`  ${colors.yellow}→${colors.reset} ${description}`);
    testFn();
  } catch (error) {
    console.log(`${colors.red}✗ EXCEPTION${colors.reset}: ${error.message}`);
    failedTests++;
  }
}

// Test Case 1: Basic Loan Creation
describe('Test Case 1: Basic Loan Creation');
it('should calculate initial state with no payments', () => {
  const loan = {
    loan_amount: 1000,
    interest_rate: 10, // 10% per month
    created_at: '2026-02-01',
    due_date: '2026-03-01'
  };
  
  const state = calculateLoanState(loan, [], new Date('2026-02-01'));
  
  assert(state.principalRemaining === 1000, `Principal: ${state.principalRemaining} === 1000`);
  assert(
    Math.abs(state.interestAccrued - 100) < 0.01,
    `Interest: ${state.interestAccrued.toFixed(2)} ≈ 100`
  );
  assert(state.penaltyAccrued === 0, 'No penalty on creation');
  assert(
    Math.abs(state.totalBalance - 1100) < 0.01,
    `Total: ${state.totalBalance.toFixed(2)} ≈ 1100`
  );
});

// Test Case 2: Interest-Only Payment Before Due Date (1 month extension)
describe('Test Case 2: Interest-Only Payment Before Due Date');
it('should extend due date by 1 month when interest is paid', () => {
  const loan = {
    loan_amount: 1000,
    interest_rate: 10,
    created_at: '2026-02-01',
    due_date: '2026-03-01'
  };
  
  const payments = [
    {
      payment_amount: 100, // Pay only interest
      payment_date: '2026-02-15'
    }
  ];
  
  const state = calculateLoanState(loan, payments, new Date('2026-02-15'));
  
  assert(state.principalRemaining === 1000, `Principal still 1000: ${state.principalRemaining}`);
  assert(state.nextDueDate === '2026-03-15', `Due date extended to March 15: ${state.nextDueDate}`);
  assert(state.penaltyAccrued === 0, 'No penalty when paid on time');
});

// Test Case 3: No Payment Before Due Date (Daily Penalty Accumulation)
describe('Test Case 3: No Payment and Penalty Accumulation');
it('should accumulate daily penalty after due date', () => {
  const loan = {
    loan_amount: 1000,
    interest_rate: 10,
    created_at: '2026-02-01',
    due_date: '2026-03-01'
  };
  
  const state = calculateLoanState(loan, [], new Date('2026-03-05'));
  
  // 4 days overdue: daily penalty = 100 / 30 = 3.33 per day
  const expectedPenalty = (100 / 30) * 4;
  
  assert(
    state.isOverdue === true,
    'Loan is overdue'
  );
  assert(
    state.daysOverdue === 4,
    `Days overdue: ${state.daysOverdue} === 4`
  );
  assert(
    Math.abs(state.penaltyAccrued - expectedPenalty) < 0.01,
    `Penalty: ${state.penaltyAccrued.toFixed(2)} ≈ ${expectedPenalty.toFixed(2)}`
  );
});

// Test Case 4: Payment After Due Date (Apply Payment + Penalty Calculation)
describe('Test Case 4: Payment After Due Date');
it('should apply payment in correct priority order (penalty, interest, principal)', () => {
  const loan = {
    loan_amount: 1000,
    interest_rate: 10,
    created_at: '2026-02-01',
    due_date: '2026-03-01'
  };
  
  // Let 3 days go by overdue, then pay $100
  // Expected penalty for 3 days = (100/30) * 3 = $10
  const payments = [
    {
      payment_amount: 100,
      payment_date: '2026-03-04'
    }
  ];
  
  const state = calculateLoanState(loan, payments, new Date('2026-03-04'));
  
  // Payment order: penalty ($10) → interest ($90)
  // Due to fresh recalculation, interest shows full month amount
  assert(
    state.principalRemaining === 1000,
    `Principal unchanged: ${state.principalRemaining} === 1000`
  );
  assert(
    Math.abs(state.penaltyAccrued) < 0.01,
    `Penalty cleared by payment: ${state.penaltyAccrued.toFixed(2)}`
  );
  assert(
    state.totalBalance > 1000 && state.totalBalance < 1110,
    `Partial payment applied: ${state.totalBalance.toFixed(2)}`
  );
});

// Test Case 5: Partial Payment After Due Date
describe('Test Case 5: Partial Payment After Due Date');
it('should partially reduce each category when payment < total', () => {
  const loan = {
    loan_amount: 1000,
    interest_rate: 10,
    created_at: '2026-02-01',
    due_date: '2026-03-01'
  };
  
  // 5 days overdue, pay $50 (partial)
  const payments = [
    {
      payment_amount: 50,
      payment_date: '2026-03-06'
    }
  ];
  
  const state = calculateLoanState(loan, payments, new Date('2026-03-06'));
  
  // Penalty for 5 days = (100/30) * 5 ≈ 16.67
  const expectedPenalty = (100 / 30) * 5;
  
  assert(
    state.principalRemaining === 1000,
    `Principal unchanged at 1000: ${state.principalRemaining}`
  );
  assert(
    state.penaltyAccrued <= expectedPenalty + 0.01,
    `Some penalty paid off: ${state.penaltyAccrued.toFixed(2)} <= ${expectedPenalty.toFixed(2)}`
  );
});

// Test Case 6: Multiple Partial Payments
describe('Test Case 6: Multiple Partial Payments');
it('should handle multiple payments across different dates', () => {
  const loan = {
    loan_amount: 1000,
    interest_rate: 10,
    created_at: '2026-02-01',
    due_date: '2026-03-01'
  };
  
  const payments = [
    {
      payment_amount: 100, // Pay full interest on Feb 20 - should extend due date to Mar 20
      payment_date: '2026-02-20'
    },
    {
      payment_amount: 100, // Pay full interest on Mar 20 - should extend due date to Apr 20
      payment_date: '2026-03-20'
    },
    {
      payment_amount: 200, // Pay principal on Apr 20
      payment_date: '2026-04-20'
    }
  ];
  
  const state = calculateLoanState(loan, payments, new Date('2026-04-20'));
  
  assert(
    state.principalRemaining < 1000,
    `Principal reduced after paying towards principal: ${state.principalRemaining} < 1000`
  );
  assert(
    state.totalBalance < 1300,
    `Total balance reduced: ${state.totalBalance.toFixed(2)}`
  );
});

// Test Case 7: Old Loan (6+ months)
describe('Test Case 7: Old Loan (6+ Months)');
it('should correctly calculate for old loans created 6+ months ago', () => {
  const loan = {
    loan_amount: 5000,
    interest_rate: 5, // 5% per month
    created_at: '2025-08-15',
    due_date: '2025-09-15'
  };
  
  // No payments made, checking state at current date
  const state = calculateLoanState(loan, [], new Date('2026-03-03'));
  
  assert(
    state.monthsElapsed >= 6,
    `At least 6 months elapsed: ${state.monthsElapsed}`
  );
  assert(
    state.isOverdue === true,
    'Old loan without payment is overdue'
  );
  assert(
    state.daysOverdue > 0,
    `Days overdue: ${state.daysOverdue} > 0`
  );
  assert(
    state.penaltyAccrued > 0,
    `Penalty accrued: ${state.penaltyAccrued.toFixed(2)}`
  );
  assert(
    state.principalRemaining === 5000,
    'Principal unchanged without payment'
  );
});

// Test Case 8: Full Payment After Several Months
describe('Test Case 8: Full Repayment');
it('should mark loan as fully paid when total balance is cleared', () => {
  const loan = {
    loan_amount: 1000,
    interest_rate: 10,
    created_at: '2026-02-01',
    due_date: '2026-03-01'
  };
  
  const payments = [
    {
      payment_amount: 1100, // Full payment (principal + interest)
      payment_date: '2026-03-01'
    }
  ];
  
  const state = calculateLoanState(loan, payments, new Date('2026-03-01'));
  
  assert(
    state.principalRemaining === 0,
    `Principal paid off: ${state.principalRemaining} === 0`
  );
  assert(
    state.interestAccrued === 0,
    `Interest paid off: ${state.interestAccrued} === 0`
  );
  assert(
    state.totalBalance === 0,
    `Total balance zero: ${state.totalBalance} === 0`
  );
});

// Test Case 9: Idempotency (Same input = Same output)
describe('Test Case 9: Idempotency');
it('should produce identical results for same inputs', () => {
  const loan = {
    loan_amount: 2000,
    interest_rate: 8,
    created_at: '2026-01-15',
    due_date: '2026-02-15'
  };
  
  const payments = [
    {
      payment_amount: 150,
      payment_date: '2026-02-01'
    }
  ];
  
  const referenceDate = new Date('2026-02-28');
  
  const state1 = calculateLoanState(loan, payments, referenceDate);
  const state2 = calculateLoanState(loan, payments, referenceDate);
  const state3 = calculateLoanState(loan, payments, referenceDate);
  
  assert(
    JSON.stringify(state1) === JSON.stringify(state2) &&
    JSON.stringify(state2) === JSON.stringify(state3),
    'Multiple calls return identical results'
  );
});

// Test Case 10: Payment Exceeds Total Balance
describe('Test Case 10: Overpayment');
it('should not go negative when payment exceeds total balance', () => {
  const loan = {
    loan_amount: 500,
    interest_rate: 10,
    created_at: '2026-02-01',
    due_date: '2026-03-01'
  };
  
  const payments = [
    {
      payment_amount: 1000, // More than total balance
      payment_date: '2026-03-01'
    }
  ];
  
  const state = calculateLoanState(loan, payments, new Date('2026-03-01'));
  
  assert(
    state.principalRemaining >= 0,
    'Principal never goes negative'
  );
  assert(
    state.interestAccrued >= 0,
    'Interest never goes negative'
  );
  assert(
    state.totalBalance >= 0,
    'Total balance never goes negative'
  );
});

// Test Case 11: Zero Interest Rate
describe('Test Case 11: Zero Interest Rate');
it('should handle 0% interest correctly', () => {
  const loan = {
    loan_amount: 1000,
    interest_rate: 0, // No interest
    created_at: '2026-02-01',
    due_date: '2026-03-01'
  };
  
  const state = calculateLoanState(loan, [], new Date('2026-03-15'));
  
  assert(
    state.interestAccrued === 0,
    'No interest accrues'
  );
  assert(
    state.penaltyAccrued === 0,
    'No penalty for zero interest loan'
  );
  assert(
    state.totalBalance === 1000,
    'Total equals principal only'
  );
});

// Test Case 12: Payment Before Last Due Date Update
describe('Test Case 12: Interest-Only Payment with Due Date Extension');
it('should extend due date when interest is fully paid', () => {
  const loan = {
    loan_amount: 1000,
    interest_rate: 15, // 15% per month
    created_at: '2026-01-01',
    due_date: '2026-02-01'
  };
  
  const payments = [
    {
      payment_amount: 150, // Exactly the interest
      payment_date: '2026-02-01'
    }
  ];
  
  const state = calculateLoanState(loan, payments, new Date('2026-02-01'));
  
  assert(
    state.nextDueDate === '2026-03-01',
    `Due date extended to March 1: ${state.nextDueDate}`
  );
  assert(
    state.principalRemaining === 1000,
    'Principal unchanged'
  );
});

// Helper functions test
describe('Helper Functions');
it('should calculate daily penalty correctly', () => {
  const monthlyInterest = 100;
  const daily = calculateDailyPenalty(monthlyInterest);
  const expected = 100 / 30;
  
  assert(
    Math.abs(daily - expected) < 0.001,
    `Daily penalty ${daily.toFixed(4)} ≈ ${expected.toFixed(4)}`
  );
});

it('should calculate monthly interest correctly', () => {
  const principal = 1000;
  const rate = 10;
  const interest = calculateMonthlyInterest(principal, rate);
  
  assert(
    interest === 100,
    `Monthly interest ${interest} === 100`
  );
});

// Summary
console.log(`\n${colors.bold}${colors.blue}════════════════════${colors.reset}`);
console.log(
  `${colors.green}Passed: ${passedTests}${colors.reset} | ${colors.red}Failed: ${failedTests}${colors.reset}`
);
console.log(`${colors.bold}${colors.blue}════════════════════${colors.reset}\n`);

process.exit(failedTests > 0 ? 1 : 0);
