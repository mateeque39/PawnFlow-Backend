const { Pool } = require('pg');
require('dotenv').config();

const getDatabaseUrl = () => {
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }

  if (process.env.PGHOST) {
    return `postgresql://${process.env.PGUSER || 'postgres'}:${process.env.PGPASSWORD || ''}@${process.env.PGHOST}:${process.env.PGPORT || 5432}/${process.env.PGDATABASE || 'railway'}`;
  }

  return process.env.LOCAL_DATABASE_URL || 'postgresql://postgres:1234@localhost:5432/pawn_shop';
};

const pool = new Pool({
  connectionString: getDatabaseUrl(),
  ssl: process.env.NODE_ENV === 'production' || process.env.DATABASE_URL?.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
});

async function updateLoanDueDate() {
  const lookupArg = process.argv[2];
  const newDueDateArg = process.argv[3];

  if (!lookupArg || !newDueDateArg) {
    console.log('Usage: node fix-due-date.js <loan_id|transaction_number> <YYYY-MM-DD>');
    console.log('Example by loan id: node fix-due-date.js 11 2026-04-09');
    console.log('Example by transaction number: node fix-due-date.js 883239953 2026-04-09');
    process.exit(1);
  }

  const newDueDate = newDueDateArg.trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(newDueDate)) {
    console.error('Due date must be in YYYY-MM-DD format.');
    process.exit(1);
  }

  const loanId = parseInt(lookupArg, 10);
  const isNumericId = Number.isInteger(loanId) && loanId > 0;
  const lookupField = isNumericId ? 'id' : 'transaction_number';
  const lookupValue = isNumericId ? loanId : lookupArg.trim();

  try {
    const result = await pool.query(
      `UPDATE loans
       SET due_date = $1
       WHERE ${lookupField} = $2
       RETURNING id, transaction_number, due_date, status, remaining_balance, interest_amount, total_payable_amount`,
      [newDueDate, lookupValue]
    );

    if (result.rowCount === 0) {
      console.log(`No loan found with ${lookupField} = ${lookupValue}`);
      process.exit(1);
    }

    console.log(`✅ Updated Loan #${result.rows[0].id}`);
    if (result.rows[0].transaction_number) {
      console.log(`Transaction Number: ${result.rows[0].transaction_number}`);
    }
    console.log(`New Due Date: ${result.rows[0].due_date}`);
    console.log(`Status: ${result.rows[0].status}`);
    console.log(`Remaining Balance: ${result.rows[0].remaining_balance}`);
  } catch (err) {
    console.error('ERROR:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

updateLoanDueDate();
