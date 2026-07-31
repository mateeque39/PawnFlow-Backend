/**
 * Payment Processing Utilities
 * Handles interest capitalization and payment logic for loans
 */

/**
 * Extends date by 1 month, handling edge cases properly
 * @param {Date|string} date - Date to extend
 * @returns {string} - Extended date in YYYY-MM-DD format
 */
function extendDateByOneMonth(date) {
  const d = new Date(date);
  const currentDay = d.getDate();
  const currentMonth = d.getMonth();
  
  // Add one month
  d.setMonth(d.getMonth() + 1, 1); // Set to first of next month
  
  // Set to the same day, but cap at the last day of the month
  const lastDayOfMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(currentDay, lastDayOfMonth));
  
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Capitalizes interest by adding it to principal
 * @param {Object} loan - Loan object with loan_amount, interest_amount, interest_rate
 * @returns {Object} - Object with new principal and interest amounts
 */
function capitalizeInterest(loan) {
  const currentPrincipal = parseFloat(loan.loan_amount || 0);
  const interestToCapitalize = parseFloat(loan.interest_amount || 0);
  const interestRate = parseFloat(loan.interest_rate || 0);
  
  // New principal = old principal + interest_amount
  const newPrincipal = currentPrincipal + interestToCapitalize;
  
  // New interest calculated on new principal
  const newInterestAmount = Math.round((newPrincipal * interestRate / 100) * 100) / 100;
  
  return {
    newPrincipal,
    newInterestAmount,
    capitalizedInterestAmount: interestToCapitalize,
    totalRemainingBalance: newPrincipal + newInterestAmount
  };
}

/**
 * Processes a payment with interest capitalization logic
 * @param {Object} loan - Current loan record
 * @param {number} paymentAmount - Amount being paid
 * @param {number} totalPaymentsAfter - Total payments after this one
 * @returns {Object} - Object with new loan values and flags
 */
function processPaymentWithCapitalization(loan, paymentAmount, totalPaymentsAfter) {
  const currentRemaining = parseFloat(loan.remaining_balance || 0);
  const currentInterest = parseFloat(loan.interest_amount || 0);
  const loanPrincipal = parseFloat(loan.loan_amount || 0);
  const interestRate = parseFloat(loan.interest_rate || 0);
  const currentStatus = loan.status?.toLowerCase() || 'active';
  
  let newStatus = currentStatus;
  let newPrincipal = loanPrincipal;
  let newInterestAmount = currentInterest;
  let newDueDate = loan.due_date;
  let dueDateExtended = false;
  let interestCapitalized = false;
  
  // Calculate remaining after this payment
  const remainingAfterPayment = Math.max(currentRemaining - paymentAmount, 0);
  const isFullPayment = remainingAfterPayment === 0;
  const isOverdue = currentStatus === 'overdue';
  
  // Key condition: If payment >= interest_amount for current month
  const paymentCoversInterest = paymentAmount >= currentInterest;
  
  console.log(`\n💳 PAYMENT PROCESSING ANALYSIS - Loan ${loan.id}`);
  console.log(`   Current interest: $${currentInterest.toFixed(2)}`);
  console.log(`   Payment amount: $${paymentAmount.toFixed(2)}`);
  console.log(`   Payment covers interest: ${paymentCoversInterest}`);
  console.log(`   Current status: ${currentStatus}`);
  console.log(`   Is overdue: ${isOverdue}`);
  console.log(`   Is full payment: ${isFullPayment}`);
  
  // If full payment, loan is complete
  if (isFullPayment) {
    newStatus = 'redeemed';
    console.log(`   ✓ Full payment made - loan will be marked as redeemed`);
    return {
      newStatus,
      newPrincipal,
      newInterestAmount,
      newDueDate,
      dueDateExtended,
      interestCapitalized,
      finalRemainingBalance: 0
    };
  }
  
  // CASE 1: OVERDUE LOAN WITH INTEREST PAYMENT
  if (isOverdue && paymentCoversInterest) {
    console.log(`\n🔴 OVERDUE LOAN - INTEREST CAPITALIZATION APPLIES`);
    
    // Move from overdue to active
    newStatus = 'active';
    
    // Capitalize interest (add to principal)
    const { newPrincipal: capitalizedPrincipal, newInterestAmount: newInterest } = capitalizeInterest(loan);
    newPrincipal = capitalizedPrincipal;
    newInterestAmount = newInterest;
    interestCapitalized = true;
    
    // When capitalizing interest on overdue loan, the payment settles the interest owed
    // The new remaining = newPrincipal + newInterestAmount
    
    // Extend due date by 1 month
    newDueDate = extendDateByOneMonth(loan.due_date);
    dueDateExtended = true;
    
    // Final remaining balance includes the capitalized principal and new interest
    const finalRemainingBalance = newPrincipal + newInterestAmount;
    
    console.log(`   Before: Principal=$${loanPrincipal.toFixed(2)}, Interest=$${currentInterest.toFixed(2)}`);
    console.log(`   ✓ Interest capitalized - Adding $${currentInterest.toFixed(2)} to principal`);
    console.log(`   After: Principal=$${newPrincipal.toFixed(2)}, Interest=$${newInterestAmount.toFixed(2)}`);
    console.log(`   Status: overdue → active`);
    console.log(`   Due date extended: ${loan.due_date} → ${newDueDate}`);
    console.log(`   Final remaining: $${finalRemainingBalance.toFixed(2)}`);
    
    return {
      newStatus,
      newPrincipal,
      newInterestAmount,
      newDueDate,
      dueDateExtended,
      interestCapitalized,
      finalRemainingBalance
    };
  }
  
  // CASE 2: OVERDUE LOAN WITHOUT INTEREST PAYMENT (payment < interest)
  if (isOverdue && !paymentCoversInterest) {
    console.log(`\n🔴 OVERDUE LOAN - PARTIAL PAYMENT (Interest NOT covered)`);
    console.log(`   Payment $${paymentAmount.toFixed(2)} < Interest $${currentInterest.toFixed(2)}`);
    console.log(`   Status remains: overdue`);
    console.log(`   Due date remains: ${loan.due_date}`);
    
    // Remaining balance is reduced by payment, but interest and principal are recalculated
    const remainingBalance = Math.max(currentRemaining - paymentAmount, 0);
    
    // Recalculate interest on remaining balance
    const recalculatedInterest = Math.round((remainingBalance * interestRate / 100) * 100) / 100;
    
    return {
      newStatus: 'overdue', // Stays overdue
      newPrincipal: remainingBalance,
      newInterestAmount: recalculatedInterest,
      newDueDate,
      dueDateExtended: false,
      interestCapitalized: false,
      finalRemainingBalance: remainingBalance + recalculatedInterest
    };
  }
  
  // CASE 3: ACTIVE LOAN WITH INTEREST PAYMENT
  if (!isOverdue && paymentCoversInterest) {
    console.log(`\n✅ ACTIVE LOAN - INTEREST CAPITALIZATION APPLIES`);
    
    // Capitalize interest (add to principal)
    const { newPrincipal: capitalizedPrincipal, newInterestAmount: newInterest } = capitalizeInterest(loan);
    newPrincipal = capitalizedPrincipal;
    newInterestAmount = newInterest;
    interestCapitalized = true;
    
    // When capitalizing interest, the payment settles the interest owed
    // The remaining balance becomes: newPrincipal + newInterestAmount (with payment applied to settle old interest)
    // So the new remaining = new principal + new interest (the payment is NOT subtracted again)
    
    // Extend due date by 1 month
    newDueDate = extendDateByOneMonth(loan.due_date);
    dueDateExtended = true;
    
    // Final remaining balance after interest capitalization
    const finalRemainingBalance = newPrincipal + newInterestAmount;
    
    console.log(`   Before: Principal=$${loanPrincipal.toFixed(2)}, Interest=$${currentInterest.toFixed(2)}`);
    console.log(`   ✓ Interest capitalized - Adding $${currentInterest.toFixed(2)} to principal`);
    console.log(`   After: Principal=$${newPrincipal.toFixed(2)}, Interest=$${newInterestAmount.toFixed(2)}`);
    console.log(`   Status: active (unchanged)`);
    console.log(`   Due date extended: ${loan.due_date} → ${newDueDate}`);
    console.log(`   Final remaining: $${finalRemainingBalance.toFixed(2)}`);
    
    return {
      newStatus: 'active',
      newPrincipal,
      newInterestAmount,
      newDueDate,
      dueDateExtended,
      interestCapitalized,
      finalRemainingBalance
    };
  }
  
  // CASE 4: ACTIVE LOAN WITHOUT INTEREST PAYMENT
  console.log(`\n⚪ ACTIVE LOAN - PARTIAL PAYMENT (Interest NOT covered)`);
  console.log(`   Payment $${paymentAmount.toFixed(2)} < Interest $${currentInterest.toFixed(2)}`);
  console.log(`   Status remains: active`);
  console.log(`   Due date remains: ${loan.due_date}`);
  
  // Remaining balance is reduced by payment, but interest recalculation depends on logic
  const remainingBalance = Math.max(currentRemaining - paymentAmount, 0);
  
  // Keep interest and principal as-is (or could recalculate interest on remaining balance)
  // For now, we keep them as the current values - payment goes against the total remaining
  
  return {
    newStatus: 'active', // Stays active
    newPrincipal,
    newInterestAmount,
    newDueDate,
    dueDateExtended: false,
    interestCapitalized: false,
    finalRemainingBalance: remainingBalance
  };
}

module.exports = {
  extendDateByOneMonth,
  capitalizeInterest,
  processPaymentWithCapitalization,
  processPaymentWithAutoExtend
};

/**
 * NEW BUSINESS RULE: Auto-extend due date when interest-only payment is made before/on due date
 * 
 * Rule: If payment(s) BEFORE or ON loan.dueDate and total amount paid toward CURRENT CYCLE INTEREST >= loan.interestAmount:
 *   1) Extend loan.dueDate by exactly 1 month
 *   2) Do NOT reduce principal for "interest-only" portion
 *   3) Interest charged again for next cycle, so remainingBalance stays principal + nextCycleInterest
 *   4) Support multiple partial payments (e.g. 300+300 should trigger extension)
 *   5) Prevent multiple extensions within same cycle
 *
 * @param {Object} loan - Current loan record
 * @param {number} paymentAmount - Amount being paid NOW
 * @param {Date} paymentDate - Date of the payment (optional, defaults to today)
 * @returns {Object} - Object with new loan values and extension flags
 */
function parseDateOnly(value) {
  if (!value) return null;

  if (typeof value === 'string') {
    const datePart = value.split('T')[0];
    const parts = datePart.split('-');
    if (parts.length === 3) {
      return {
        year: parseInt(parts[0], 10),
        month: parseInt(parts[1], 10),
        day: parseInt(parts[2], 10)
      };
    }
    const parsed = new Date(value);
    return {
      year: parsed.getFullYear(),
      month: parsed.getMonth() + 1,
      day: parsed.getDate()
    };
  }

  if (value instanceof Date) {
    return {
      year: value.getFullYear(),
      month: value.getMonth() + 1,
      day: value.getDate()
    };
  }

  return null;
}

function formatDateOnly(value) {
  const date = parseDateOnly(value);
  if (!date) return null;
  return `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}

function isSameOrBefore(dateA, dateB) {
  if (!dateA || !dateB) return false;
  if (dateA.year !== dateB.year) return dateA.year < dateB.year;
  if (dateA.month !== dateB.month) return dateA.month < dateB.month;
  return dateA.day <= dateB.day;
}

function processPaymentWithAutoExtend(loan, paymentAmount, paymentDate) {
  paymentDate = paymentDate || new Date();
  
  const loanId = loan.id;
  const principal = parseFloat(loan.loan_amount || 0);
  const interestRate = parseFloat(loan.interest_rate || 0);
  const currentInterestAmount = parseFloat(loan.interest_amount || 0);
  const dueDate = loan.due_date;
  const interestPaidThisCycle = parseFloat(loan.interest_paid_this_cycle || 0);
  const extendedThisCycle = loan.extended_this_cycle === true || loan.extended_this_cycle === 'true';
  const currentRemaining = parseFloat(loan.remaining_balance || 0);
  const status = loan.status?.toLowerCase() || 'active';
  
  const paymentDateOnly = parseDateOnly(paymentDate);
  const dueDateOnly = parseDateOnly(dueDate);
  const formattedDueDate = formatDateOnly(dueDate);
  const dueDateObj = new Date(dueDate);
  
  console.log(`\n💳 AUTO-EXTEND PAYMENT PROCESSING - Loan ${loanId}`);
  console.log(`   Payment Date: ${paymentDateOnly ? `${paymentDateOnly.year}-${String(paymentDateOnly.month).padStart(2, '0')}-${String(paymentDateOnly.day).padStart(2, '0')}` : 'invalid'}`);
  console.log(`   Due Date: ${formattedDueDate}`);
  console.log(`   Payment Amount: $${paymentAmount.toFixed(2)}`);
  console.log(`   Current Interest This Cycle: $${currentInterestAmount.toFixed(2)}`);
  console.log(`   Previously Paid This Cycle: $${interestPaidThisCycle.toFixed(2)}`);
  console.log(`   Already Extended This Cycle: ${extendedThisCycle}`);
  
  const isBeforeOrOnDueDate = isSameOrBefore(paymentDateOnly, dueDateOnly);
  console.log(`   Payment is before/on due date: ${isBeforeOrOnDueDate}`);
  
  const totalInterestPaidAfter = interestPaidThisCycle + paymentAmount;
  console.log(`   Total interest paid after this: $${totalInterestPaidAfter.toFixed(2)}`);
  
  const reachesInterest = totalInterestPaidAfter >= currentInterestAmount;
  console.log(`   Reaches interest amount ($${currentInterestAmount.toFixed(2)}): ${reachesInterest}`);
  
  if (extendedThisCycle) {
    console.log(`   ⏭️  ALREADY EXTENDED THIS CYCLE - No double extension`);
    const totalPayableAmount = principal + currentInterestAmount;
    const newRemaining = currentRemaining;
    return {
      autoExtendTriggered: false,
      newPrincipal: principal,
      newInterestAmount: currentInterestAmount,
      newDueDate: formattedDueDate,
      newInterestPaidThisCycle: totalInterestPaidAfter,
      newExtendedThisCycle: true,
      finalRemainingBalance: newRemaining,
      totalPayableAmount,
      newStatus: newRemaining === 0 ? 'redeemed' : status,
      message: 'Payment applied (already extended this cycle)'
    };
  }
  
  if (paymentAmount >= currentRemaining) {
    console.log(`   🎯 Full payoff detected - loan will be redeemed`);
    return {
      autoExtendTriggered: false,
      newPrincipal: 0,
      newInterestAmount: 0,
      newDueDate: formattedDueDate,
      newInterestPaidThisCycle: 0,
      newExtendedThisCycle: extendedThisCycle,
      finalRemainingBalance: 0,
      totalPayableAmount: 0,
      newStatus: 'redeemed',
      message: 'Payment completed full payoff and redeemed the loan'
    };
  }
  
  if (!reachesInterest) {
    console.log(`   ❌ Interest payment insufficient - no extension`);
    const newRemaining = Math.max(currentRemaining - paymentAmount, 0);
    const totalPayableAmount = principal + currentInterestAmount;
    return {
      autoExtendTriggered: false,
      newPrincipal: principal,
      newInterestAmount: currentInterestAmount,
      newDueDate: formattedDueDate,
      newInterestPaidThisCycle: totalInterestPaidAfter,
      newExtendedThisCycle: false,
      finalRemainingBalance: newRemaining,
      totalPayableAmount,
      newStatus: newRemaining === 0 ? 'redeemed' : status,
      message: `Payment applied. Interest accumulated: $${totalInterestPaidAfter.toFixed(2)} of $${currentInterestAmount.toFixed(2)}`
    };
  }
  
  console.log(`\n✅ AUTO-EXTEND TRIGGERED!`);
  const newStatus = status === 'overdue' ? 'active' : status;
  
  const newDueDate = extendDateByOneMonth(dueDate);
  console.log(`   Due date extended: ${formattedDueDate} → ${newDueDate}`);
  
  const newInterestPaidThisCycle = 0;
  const newExtendedThisCycle = true;
  const isOverdue = status === 'overdue';
  const newPrincipal = isOverdue
    ? Math.max(currentRemaining - paymentAmount, 0)
    : Math.max(principal - Math.max(totalInterestPaidAfter - currentInterestAmount, 0), 0);
  const nextCycleInterest = isOverdue
    ? currentInterestAmount
    : Math.round((newPrincipal * interestRate / 100) * 100) / 100;
  const finalRemainingBalance = newPrincipal + nextCycleInterest;
  const totalPayableAmount = newPrincipal + nextCycleInterest;
  
  console.log(`   Principal: $${principal.toFixed(2)} → $${newPrincipal.toFixed(2)}`);
  console.log(`   Payment applied before next-cycle interest: $${paymentAmount.toFixed(2)}`);
  console.log(`   Next cycle interest: $${nextCycleInterest.toFixed(2)}`);
  console.log(`   Final remaining balance: $${finalRemainingBalance.toFixed(2)}`);
  console.log(`   Contract total payable: $${totalPayableAmount.toFixed(2)}`);
  
  return {
    autoExtendTriggered: true,
    newPrincipal,
    newInterestAmount: nextCycleInterest,
    newDueDate,
    newInterestPaidThisCycle,
    newExtendedThisCycle,
    finalRemainingBalance,
    totalPayableAmount,
    newStatus,
    message: `✅ Auto-extended! Interest covered and due date moved to ${newDueDate}`
  };
}
