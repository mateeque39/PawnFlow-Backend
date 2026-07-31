#!/usr/bin/env node
/**
 * Repair script for loans that were incorrectly left without an extension
 * or had total_payable_amount / remaining_balance stored incorrectly.
 *
 * Safety rules:
 * 1) Never overwrite a real principal balance with a random payment amount.
 * 2) Reconcile contract totals before updating the live balance.
 * 3) Only apply the due-date extension when the loan is still in the same cycle.
 * 4) Default to dry-run unless --apply is supplied.
 *
 * Example usage:
 *   node fix-existing-loan-auto-extend.js --loan-id 25 --apply
 *   node fix-existing-loan-auto-extend.js --apply
 */

const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
});

function parseArgs(argv) {
  const args = { apply: false, loanId: null, dryRun: false };

  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--apply') args.apply = true;
    if (value === '--dry-run') args.dryRun = true;
    if (value === '--loan-id' && argv[i + 1]) {
      args.loanId = Number(argv[i + 1]);
      i += 1;
    }
  }

  if (args.dryRun) args.apply = false;
  return args;
}

function addMonths(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

function toISODate(date) {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

async function getPaymentHistory(client, loanId) {
  const result = await client.query(
    `SELECT payment_amount, payment_date
     FROM payment_history
     WHERE loan_id = $1
     ORDER BY payment_date ASC`,
    [loanId]
  );

  return result.rows;
}

async function repairLoan(client, loan, apply) {
  const loanId = Number(loan.id);
  const principal = roundMoney(loan.loan_amount || 0);
  const interestRate = roundMoney(loan.interest_rate || 0);
  const currentInterestAmount = roundMoney(loan.interest_amount || 0);
  const contractTotal = roundMoney(principal + currentInterestAmount);
  const currentDueDate = loan.due_date ? new Date(loan.due_date) : null;
  const wasExtendedThisCycle = loan.extended_this_cycle === true || loan.extended_this_cycle === 'true';

  const payments = await getPaymentHistory(client, loanId);
  let totalInterestPaidThisCycle = 0;

  for (const payment of payments) {
    const paymentAmount = roundMoney(payment.payment_amount || 0);
    const paymentDate = payment.payment_date ? new Date(payment.payment_date) : null;

    if (!paymentDate || paymentAmount <= 0) continue;

    if (currentDueDate && paymentDate <= currentDueDate) {
      totalInterestPaidThisCycle += paymentAmount;
    }
  }

  const monthlyInterestThreshold = Math.max(currentInterestAmount, roundMoney((principal * interestRate) / 100));
  const shouldExtendDueDate = !wasExtendedThisCycle && totalInterestPaidThisCycle >= monthlyInterestThreshold && currentDueDate;

  const correctedTotalPayable = contractTotal;
  const correctedRemainingBalance = shouldExtendDueDate ? correctedTotalPayable : Math.max(roundMoney(loan.remaining_balance || correctedTotalPayable), 0);

  const nextDueDate = shouldExtendDueDate ? toISODate(addMonths(currentDueDate, 1)) : toISODate(currentDueDate || new Date());

  const currentMismatch = Math.abs((Number(loan.total_payable_amount) || 0) - correctedTotalPayable) > 0.01;
  const remainingMismatch = Math.abs((Number(loan.remaining_balance) || 0) - correctedRemainingBalance) > 0.01;

  const needsRepair = shouldExtendDueDate || currentMismatch || remainingMismatch || loan.extended_this_cycle !== true && !loan.extended_this_cycle && totalInterestPaidThisCycle >= monthlyInterestThreshold;

  if (!needsRepair) {
    console.log(`Loan #${loanId}: already consistent; no repair needed.`);
    return { changed: false, loanId };
  }

  const updateValues = [
    correctedTotalPayable,
    correctedRemainingBalance,
    monthlyInterestThreshold,
    nextDueDate,
    shouldExtendDueDate ? 'active' : (loan.status || 'active'),
    shouldExtendDueDate ? true : Boolean(loan.extended_this_cycle),
    0,
    loanId,
  ];

  const updateQuery = `
    UPDATE loans
    SET
      total_payable_amount = $1,
      remaining_balance = $2,
      interest_amount = $3,
      due_date = $4,
      status = $5,
      extended_this_cycle = $6,
      interest_paid_this_cycle = $7,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = $8
    RETURNING id, due_date, total_payable_amount, remaining_balance, interest_amount, extended_this_cycle, status`;

  console.log(`Loan #${loanId}:`);
  console.log(`  total_payable_amount before = ${loan.total_payable_amount ?? 'NULL'} | after = ${correctedTotalPayable}`);
  console.log(`  remaining_balance before = ${loan.remaining_balance ?? 'NULL'} | after = ${correctedRemainingBalance}`);
  console.log(`  interest_amount before = ${loan.interest_amount ?? 'NULL'} | after = ${monthlyInterestThreshold}`);
  console.log(`  due_date before = ${loan.due_date ?? 'NULL'} | after = ${nextDueDate}`);
  console.log(`  shouldExtendDueDate = ${shouldExtendDueDate}`);
  console.log(`  totalInterestPaidThisCycle = ${totalInterestPaidThisCycle}`);

  if (!apply) {
    console.log('  [DRY RUN] would apply the repair above. Add --apply to persist it.');
    return { changed: true, loanId, dryRun: true, shouldExtendDueDate };
  }

  const result = await client.query(updateQuery, updateValues);

  console.log(`  ✅ Updated loan ${loanId} in database.`);

  return {
    changed: true,
    loanId,
    dryRun: false,
    updated: result.rows[0],
    shouldExtendDueDate,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Add it to your .env file first.');
    process.exit(1);
  }

  const client = await pool.connect();

  try {
    const whereClause = args.loanId ? 'WHERE id = $1' : 'WHERE status IN (\'active\', \'overdue\')';
    const baseQuery = `
      SELECT *
      FROM loans
      ${whereClause}
      ORDER BY id ASC`;

    const rows = args.loanId
      ? (await client.query(baseQuery, [args.loanId])).rows
      : (await client.query(baseQuery)).rows;

    if (rows.length === 0) {
      console.log('No loans matched the repair query.');
      return;
    }

    console.log(`Scanning ${rows.length} loan(s) in ${args.apply ? 'APPLY' : 'DRY RUN'} mode...\n`);

    let changedCount = 0;
    for (const loan of rows) {
      const result = await repairLoan(client, loan, args.apply);
      if (result.changed) changedCount += 1;
    }

    console.log(`\nFinished. Repaired/validated loans: ${changedCount}`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error('Repair script failed:', error);
  process.exit(1);
});
