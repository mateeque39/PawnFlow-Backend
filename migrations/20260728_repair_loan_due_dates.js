/**
 * Follow-up migration: repair loan due dates using the corrected comparison logic.
 *
 * This exists because the original one-time migration may already be recorded as
 * executed in the migrations table even though the comparison logic needed to be
 * corrected afterward. Running this follow-up migration is safe and idempotent.
 */

const { runMigration: runOriginalMigration } = require('./20260727_correct_loan_due_dates');

async function runMigration() {
  console.log('🔧 Starting follow-up due date repair migration...');
  await runOriginalMigration();
}

module.exports = { runMigration };
