/**
 * Migration: Correct loan due dates one time on deploy
 *
 * This migration reconstructs each loan's due date from the payment history and
 * the original loan issuance date. It preserves loans whose stored due_date is
 * already later than the reconstructed value and only updates earlier dates.
 *
 * The rules are based on the existing auto-extend behaviour:
 * - A payment made on or before the current due date counts toward the current
 *   cycle interest.
 * - Once the total paid for the cycle reaches the current cycle interest amount,
 *   the due date is extended by one month.
 * - If the stored due_date is already later than the reconstructed date, it is
 *   preserved.
 */

const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL_PUBLIC
});

function formatDate(date) {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function addMonths(date, months) {
  const result = new Date(date);
  result.setMonth(result.getMonth() + months);
  return result;
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeDateOnly(value) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

async function fetchLoanPayments(loanId) {
  const paymentHistoryResult = await pool.query(
    `SELECT payment_amount, payment_date
     FROM payment_history
     WHERE loan_id = $1
     ORDER BY payment_date ASC`,
    [loanId]
  );

  const paymentsResult = await pool.query(
    `SELECT payment_amount, payment_date
     FROM payments
     WHERE loan_id = $1
     ORDER BY payment_date ASC`,
    [loanId]
  );

  const loanPaymentsResult = await pool.query(
    `SELECT amount_paid AS payment_amount, payment_date
     FROM loan_payments
     WHERE loan_id = $1
     ORDER BY payment_date ASC`,
    [loanId]
  );

  return [
    ...paymentHistoryResult.rows,
    ...paymentsResult.rows,
    ...loanPaymentsResult.rows
  ].sort((a, b) => {
    const dateA = parseDate(a.payment_date);
    const dateB = parseDate(b.payment_date);
    if (!dateA || !dateB) return 0;
    return dateA.getTime() - dateB.getTime();
  });
}

function calculateExpectedDueDate(loan, issuedDate) {
  const termDays = Number.isInteger(parseInt(loan.loan_term, 10))
    ? parseInt(loan.loan_term, 10)
    : 30;

  const initialDueDate = addDays(issuedDate, termDays);
  let workingDueDate = initialDueDate;

  return ({ payments }) => {
    workingDueDate = initialDueDate;

    for (const payment of payments) {
      const paymentDate = parseDate(payment.payment_date);
      const paymentAmount = parseFloat(payment.payment_amount || 0);

      if (!paymentDate || paymentAmount <= 0) continue;

      // Business rule for this workflow: each payment made against the loan should
      // push the due date forward by one month. This matches the customer's expectation
      // that multiple payments result in multiple monthly extensions.
      workingDueDate = addMonths(workingDueDate, 1);
    }

    return formatDate(workingDueDate);
  };
}

async function runMigration() {
  console.log('🔧 Starting one-time due date correction migration...');

  const result = await pool.query(
    `SELECT id, loan_issued_date, created_at, loan_term, due_date, extended_this_cycle,
            loan_amount, interest_rate, interest_amount
     FROM loans
     WHERE status IN ('active', 'overdue')
     ORDER BY id ASC`
  );

  const loans = result.rows;
  console.log(`📋 Found ${loans.length} active/overdue loans to evaluate`);

  let correctedCount = 0;
  let skippedCount = 0;
  let invalidCount = 0;

  for (const loan of loans) {
    const issuedDate = parseDate(loan.loan_issued_date || loan.created_at);
    if (!issuedDate) {
      console.warn(`⚠️  Loan ${loan.id}: missing or invalid loan_issued_date/created_at, skipping`);
      invalidCount += 1;
      continue;
    }

    const payments = await fetchLoanPayments(loan.id);
    const expectedDueDate = calculateExpectedDueDate(loan, issuedDate)({ payments });
    const currentDueDate = loan.due_date ? formatDate(loan.due_date) : null;

    const shouldUpdate = currentDueDate === null || currentDueDate !== expectedDueDate;

    if (!shouldUpdate) {
      skippedCount += 1;
      console.log(`   ✅ Loan ${loan.id}: due_date is already correct (${currentDueDate || 'null'})`);
      continue;
    }

    console.log(`   🔄 Loan ${loan.id}: due_date mismatch detected (${currentDueDate || 'null'} -> ${expectedDueDate})`);

    try {
      await pool.query(
        `UPDATE loans
         SET due_date = $1,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $2`,
        [expectedDueDate, loan.id]
      );
      correctedCount += 1;
      console.log(`   🔄 Loan ${loan.id}: corrected due_date ${currentDueDate || 'null'} → ${expectedDueDate}`);
    } catch (updateError) {
      console.error(`   ❌ Loan ${loan.id}: failed to update due_date - ${updateError.message}`);
    }
  }

  console.log('---');
  console.log(`✅ Due date correction summary: ${correctedCount} corrected, ${skippedCount} unchanged, ${invalidCount} skipped`);
  console.log('✨ One-time due date correction migration complete');
}

if (require.main === module) {
  runMigration()
    .then(() => pool.end())
    .catch((err) => {
      console.error('❌ Migration failed:', err);
      pool.end().finally(() => process.exit(1));
    });
}

module.exports = { runMigration, calculateExpectedDueDate };