// Usage:
//  Set environment variable DATABASE_URL to your Railway connection string
//  node scripts/fix_loan.js <transactionNumber> [--dry-run] [--extend]

const { Pool } = require('pg');

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: node scripts/fix_loan.js <transactionNumber> [--dry-run] [--extend]');
    process.exit(1);
  }

  const tx = args[0];
  const dryRun = args.includes('--dry-run');
  const extend = args.includes('--extend');

  // Allow overriding the DATABASE_URL via --dburl or env var
  let DATABASE_URL = process.env.DATABASE_URL;
  const dbUrlArg = args.find(a => a.startsWith('--dburl='));
  if (dbUrlArg) DATABASE_URL = dbUrlArg.split('=')[1];
  if (!DATABASE_URL) {
    console.error('Please set the DATABASE_URL environment variable to your Postgres connection string.');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: DATABASE_URL });
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const loanRes = await client.query('SELECT * FROM loans WHERE transaction_number = $1 FOR UPDATE', [tx]);
    if (loanRes.rows.length === 0) {
      console.error('Loan not found for transaction:', tx);
      await client.query('ROLLBACK');
      process.exit(1);
    }

    const loan = loanRes.rows[0];
    console.log('Current loan row:');
    console.log({ id: loan.id, transaction_number: loan.transaction_number, loan_amount: loan.loan_amount, interest_rate: loan.interest_rate, interest_amount: loan.interest_amount, total_payable_amount: loan.total_payable_amount, remaining_balance: loan.remaining_balance, due_date: loan.due_date });

    const principal = parseFloat(loan.loan_amount) || 0;
    const rate = parseFloat(loan.interest_rate) || 0;
    const nextInterest = Math.round((principal * rate / 100) * 100) / 100;
    let newTotalPayable = Math.round((principal + nextInterest) * 100) / 100;

    // Total payments made
    const paymentsRes = await client.query('SELECT COALESCE(SUM(payment_amount),0) AS total_paid FROM payment_history WHERE loan_id = $1', [loan.id]);
    const totalPaid = parseFloat(paymentsRes.rows[0].total_paid || 0);

    // Estimate principal paid proportionally (if total_payable_amount exists)
    let principalPaid = 0;
    const existingTotalPayable = parseFloat(loan.total_payable_amount) || 0;
    if (existingTotalPayable > 0) {
      const principalPaidRes = await client.query(
        `SELECT COALESCE(SUM(ph.payment_amount * ($1 / NULLIF(l.total_payable_amount,0))),0) AS principal_paid
         FROM payment_history ph
         JOIN loans l ON l.id = ph.loan_id
         WHERE ph.loan_id = $2`,
        [loan.loan_amount, loan.id]
      );
      principalPaid = parseFloat(principalPaidRes.rows[0].principal_paid || 0);
    }

    // Compute new remaining: unpaid principal + nextInterest
    const unpaidPrincipal = Math.max(0, Math.round((principal - principalPaid) * 100) / 100);
    let newRemaining = Math.round((unpaidPrincipal + nextInterest) * 100) / 100;

    // Allow specifying an exact due date via --due=YYYY-MM-DD, or extend by 30d with --extend
    let newDueDate = loan.due_date;
    const dueArg = args.find(a => a.startsWith('--due='));
    if (dueArg) {
      newDueDate = dueArg.split('=')[1];
    } else if (extend) {
      const d = loan.due_date ? new Date(loan.due_date) : new Date();
      d.setDate(d.getDate() + 30);
      newDueDate = d.toISOString().slice(0,10);
    }

    console.log('\nComputed values:');
    console.log({ nextInterest, newTotalPayable, principalPaid, totalPaid, unpaidPrincipal, newRemaining, newDueDate });

    // Allow overriding the computed total payable via --total=NUMBER
    const totalArg = args.find(a => a.startsWith('--total='));
    if (totalArg) {
      const forced = parseFloat(totalArg.split('=')[1]);
      if (!isNaN(forced)) {
        newTotalPayable = forced;
        // Recalculate remaining balance based on forced total and payments made
        const principalRemainingFromTotal = Math.max(0, newTotalPayable - nextInterest);
        // If payments have been made, subtract them proportionally from principal
        const principalPaidAdjusted = Math.min(principal, principalPaid || 0);
        const unpaidPrincipalAdjusted = Math.max(0, principalRemainingFromTotal - principalPaidAdjusted);
        newRemaining = Math.round((unpaidPrincipalAdjusted + nextInterest) * 100) / 100;
      }
    }

    if (dryRun) {
      console.log('\nDry run mode - no changes applied.');
      await client.query('ROLLBACK');
      process.exit(0);
    }

    // Apply update
    // Build update query depending on whether we should set due_date
    let updateQuery;
    let updateParams;
    if (dueArg || extend) {
      updateQuery = `UPDATE loans SET interest_amount = $1, total_payable_amount = $2, remaining_balance = $3, due_date = $4 WHERE id = $5 RETURNING *`;
      updateParams = [nextInterest, newTotalPayable, newRemaining, newDueDate, loan.id];
    } else {
      updateQuery = `UPDATE loans SET interest_amount = $1, total_payable_amount = $2, remaining_balance = $3 WHERE id = $4 RETURNING *`;
      updateParams = [nextInterest, newTotalPayable, newRemaining, loan.id];
    }

    const updated = await client.query(updateQuery, updateParams);

    await client.query('COMMIT');

    console.log('\nUpdated loan row:');
    console.log({ id: updated.rows[0].id, transaction_number: updated.rows[0].transaction_number, loan_amount: updated.rows[0].loan_amount, interest_rate: updated.rows[0].interest_rate, interest_amount: updated.rows[0].interest_amount, total_payable_amount: updated.rows[0].total_payable_amount, remaining_balance: updated.rows[0].remaining_balance, due_date: updated.rows[0].due_date });

    process.exit(0);
  } catch (err) {
    console.error('Error while fixing loan:', err.message || err);
    try { await client.query('ROLLBACK'); } catch (e) {}
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
