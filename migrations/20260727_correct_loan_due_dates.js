/**
 * Migration: Correct loan due dates one time on deploy
 *
 * This migration reconciles loan due dates using loan_issued_date (or created_at)
 * and loan_term. It preserves already-extended loans and corrects only the
 * due_date field based on the extended_this_cycle flag.
 *
 * Rules:
 * - If extended_this_cycle = false:
 *     due_date should equal loan_issued_date + loan_term days.
 * - If extended_this_cycle = true:
 *     due_date should be at least loan_issued_date + loan_term * 2 days.
 *     If the stored due_date is already later than the expected extended date,
 *     it is preserved.
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

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function runMigration() {
  console.log('🔧 Starting one-time due date correction migration...');

  const result = await pool.query(
    `SELECT id, loan_issued_date, created_at, loan_term, due_date, extended_this_cycle
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

    const termDays = Number.isInteger(parseInt(loan.loan_term, 10))
      ? parseInt(loan.loan_term, 10)
      : 30;

    const originalDueDate = formatDate(addDays(issuedDate, termDays));
    const expectedDueDate = loan.extended_this_cycle
      ? formatDate(addDays(originalDueDate, termDays))
      : originalDueDate;

    const currentDueDate = loan.due_date ? formatDate(loan.due_date) : null;

    const shouldUpdate = loan.extended_this_cycle
      ? currentDueDate === null || currentDueDate < expectedDueDate
      : currentDueDate !== expectedDueDate;

    if (!shouldUpdate) {
      skippedCount += 1;
      console.log(`   ✅ Loan ${loan.id}: due_date is already correct (${currentDueDate || 'null'})`);
      continue;
    }

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

module.exports = { runMigration };