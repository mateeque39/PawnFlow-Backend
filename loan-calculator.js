/**
 * Loan Calculation Engine
 * 
 * Pure function that calculates loan state dynamically based on:
 * - Original loan data
 * - Payment history
 * - Current date
 * 
 * This function is idempotent and deterministic - it always produces
 * the same result given the same inputs.
 * 
 * NO stored balances are used - everything is recalculated from scratch.
 */

/**
 * Calculate the number of days between two dates
 * @param {Date|string} startDate 
 * @param {Date|string} endDate 
 * @returns {number} Number of days
 */
function daysBetween(startDate, endDate) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const diffTime = Math.abs(end - start);
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  return diffDays;
}

/**
 * Add days to a date
 * @param {Date|string} date 
 * @param {number} days 
 * @returns {Date}
 */
function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

/**
 * Add months to a date, handling edge cases (e.g., Jan 31 + 1 month = Feb 28/29)
 * @param {Date|string} date 
 * @param {number} months 
 * @returns {Date}
 */
function addMonths(date, months) {
  const d = new Date(date);
  const currentDay = d.getDate();
  const currentMonth = d.getMonth();
  
  // Add months
  d.setMonth(d.getMonth() + months);
  
  // Handle case where day doesn't exist in target month (e.g., Jan 31 -> Feb 31)
  if (d.getDate() !== currentDay) {
    d.setDate(0); // Set to last day of previous month
  }
  
  return d;
}

/**
 * Format date to YYYY-MM-DD string
 * @param {Date|string} date 
 * @returns {string}
 */
function formatDate(date) {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Parse date string to Date object (handles YYYY-MM-DD format)
 * @param {string} dateStr 
 * @returns {Date}
 */
function parseDate(dateStr) {
  if (dateStr instanceof Date) return dateStr;
  return new Date(dateStr + 'T00:00:00Z');
}

/**
 * Core Loan Calculation Function
 * 
 * Calculates the complete loan state based on:
 * - Original loan data (principal, interest rate, created date)
 * - Payment history (list of payments with dates)
 * - Current date (reference point)
 * 
 * @param {Object} loan - Loan object
 * @param {number} loan.loan_amount - Original principal
 * @param {number} loan.interest_rate - Monthly interest rate (percentage)
 * @param {string|Date} loan.created_at - Loan creation date
 * @param {string|Date} loan.due_date - Initial due date
 * @param {string|Date} loan.issued_date - Alternative to created_at
 * @param {string} loan.status - Current loan status
 * 
 * @param {Array} payments - Array of payment objects
 * @param {number} payments[].payment_amount - Amount paid
 * @param {string|Date} payments[].payment_date - Date of payment
 * 
 * @param {Date|string} currentDate - Reference date for calculations
 * 
 * @returns {Object} Loan state object
 * {
 *   principalRemaining: number - Remaining principal
 *   interestAccrued: number - Current month's interest
 *   penaltyAccrued: number - Accumulated penalty interest
 *   totalBalance: number - principalRemaining + interestAccrued + penaltyAccrued
 *   nextDueDate: string - Next payment due date
 *   isOverdue: boolean - Whether loan is overdue
 *   daysOverdue: number - Number of days overdue (0 if not overdue)
 *   monthsElapsed: number - Number of full months since creation
 *   paymentHistory: Array - Applied payment history
 *   loanTimeline: Object - Detailed timeline of loan changes
 * }
 */
function calculateLoanState(loan, payments = [], currentDate = new Date()) {
  // Validate inputs
  if (!loan) {
    throw new Error('Loan object is required');
  }

  const loanAmount = parseFloat(loan.loan_amount || 0);
  const interestRate = parseFloat(loan.interest_rate || 0) / 100; // Convert percentage to decimal
  const loanCreatedDate = parseDate(loan.created_at || loan.issued_date);
  const initialDueDate = parseDate(loan.due_date);
  const currentDateObj = currentDate instanceof Date ? currentDate : parseDate(currentDate);

  // Input validation
  if (isNaN(loanAmount) || loanAmount <= 0) {
    throw new Error('Loan amount must be a positive number');
  }
  if (isNaN(interestRate) || interestRate < 0) {
    throw new Error('Interest rate must be a non-negative number');
  }
  if (isNaN(loanCreatedDate.getTime())) {
    throw new Error('Invalid loan creation date');
  }
  if (isNaN(initialDueDate.getTime())) {
    throw new Error('Invalid due date');
  }

  // Ensure payments array is sorted by date
  const sortedPayments = [...(payments || [])].sort((a, b) => 
    parseDate(a.payment_date).getTime() - parseDate(b.payment_date).getTime()
  );

  // Initialize loan state - track remaining balances after each payment
  let principalRemaining = loanAmount;
  let currentDueDate = new Date(initialDueDate);
  const paymentHistory = [];

  // Process each payment chronologically
  for (const payment of sortedPayments) {
    const paymentDate = parseDate(payment.payment_date);
    const paymentAmount = parseFloat(payment.payment_amount || 0);

    if (paymentAmount <= 0 || isNaN(paymentAmount)) continue;

    // Calculate state at payment date using current tracking values
    const stateAtPaymentDate = calculateStateAtDate(
      loanAmount,
      interestRate,
      loanCreatedDate,
      initialDueDate,
      paymentDate,
      principalRemaining,
      currentDueDate
    );

    // Store current interest for extension check
    const currentMonthInterest = stateAtPaymentDate.interestAccrued;
    
    // Apply payment: penalty → interest → principal
    let remainingPayment = paymentAmount;

    if (stateAtPaymentDate.penaltyAccrued > 0) {
      const penaltyPayment = Math.min(remainingPayment, stateAtPaymentDate.penaltyAccrued);
      remainingPayment -= penaltyPayment;
    }

    if (remainingPayment > 0 && currentMonthInterest > 0) {
      const interestPayment = Math.min(remainingPayment, currentMonthInterest);
      remainingPayment -= interestPayment;
    }

    if (remainingPayment > 0 && principalRemaining > 0) {
      const principalPayment = Math.min(remainingPayment, principalRemaining);
      principalRemaining -= principalPayment;
      remainingPayment -= principalPayment;
    }

    // If payment covered the current month's interest, extend due date by 1 month from payment date
    if (paymentAmount >= currentMonthInterest && currentMonthInterest > 0) {
      currentDueDate = addMonths(paymentDate, 1);
    }

    paymentHistory.push({
      paymentAmount,
      paymentDate: formatDate(paymentDate)
    });
  }

  // Final calculation as of current date
  const finalState = calculateStateAtDate(
    loanAmount,
    interestRate,
    loanCreatedDate,
    initialDueDate,
    currentDateObj,
    principalRemaining,
    currentDueDate
  );

  // Determine overdue status
  const isOverdue = currentDateObj > currentDueDate;
  const daysOverdue = isOverdue ? daysBetween(currentDueDate, currentDateObj) : 0;

  // Calculate months elapsed
  let tempDate = new Date(loanCreatedDate);
  let monthCount = 0;
  while (tempDate < currentDateObj) {
    tempDate = addMonths(tempDate, 1);
    if (tempDate <= currentDateObj) monthCount++;
  }

  // Calculate total balance
  const totalBalance = parseFloat(
    (finalState.principalRemaining + finalState.interestAccrued + finalState.penaltyAccrued).toFixed(2)
  );

  return {
    principalRemaining: parseFloat(finalState.principalRemaining.toFixed(2)),
    interestAccrued: parseFloat(finalState.interestAccrued.toFixed(2)),
    penaltyAccrued: parseFloat(finalState.penaltyAccrued.toFixed(2)),
    totalBalance,
    nextDueDate: formatDate(currentDueDate),
    isOverdue,
    daysOverdue,
    monthsElapsed: monthCount,
    paymentHistory
  };
}

/**
 * Calculate loan state at a specific date
 * Takes into account:
 * - Interest accrual for full months
 * - Penalty interest for days overdue
 * 
 * @private
 */
function calculateStateAtDate(
  originalPrincipal,
  monthlyInterestRate,
  loanCreatedDate,
  initialDueDate,
  targetDate,
  currentPrincipal,
  currentDueDate
) {
  let principalRemaining = currentPrincipal !== undefined ? currentPrincipal : originalPrincipal;
  let effectiveDueDate = currentDueDate instanceof Date ? currentDueDate : new Date(initialDueDate);
  let interestAccrued = 0;
  let penaltyAccrued = 0;

  // Interest is recalculated fresh for current month on remaining principal
  interestAccrued = principalRemaining * monthlyInterestRate;

  // Check if target date is after the current due date
  if (targetDate > effectiveDueDate) {
    // Days overdue
    const daysOverdue = daysBetween(effectiveDueDate, targetDate);
    
    // Daily penalty = monthly interest / 30
    const monthlyInterestAmount = principalRemaining * monthlyInterestRate;
    const dailyPenalty = monthlyInterestAmount / 30;
    
    // Add penalty for each day overdue
    penaltyAccrued = dailyPenalty * daysOverdue;
  }

  return {
    principalRemaining,
    interestAccrued,
    penaltyAccrued,
    currentDueDate: effectiveDueDate
  };
}

/**
 * Calculate interest payment amount for a given principal and rate
 * @param {number} principal 
 * @param {number} monthlyRatePercent 
 * @returns {number}
 */
function calculateMonthlyInterest(principal, monthlyRatePercent) {
  return parseFloat((principal * (monthlyRatePercent / 100)).toFixed(2));
}

/**
 * Calculate daily penalty based on monthly interest
 * @param {number} monthlyInterest 
 * @returns {number}
 */
function calculateDailyPenalty(monthlyInterest) {
  return parseFloat((monthlyInterest / 30).toFixed(4));
}

module.exports = {
  calculateLoanState,
  calculateMonthlyInterest,
  calculateDailyPenalty,
  daysBetween,
  addDays,
  addMonths,
  formatDate,
  parseDate
};
