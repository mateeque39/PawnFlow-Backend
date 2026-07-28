const assert = require('assert');
const { shouldUpdateDueDate } = require('../migrations/20260727_correct_loan_due_dates');

function run() {
  assert.strictEqual(shouldUpdateDueDate('2026-02-08', '2026-05-08'), true,
    'an earlier stored due date should be updated');

  assert.strictEqual(shouldUpdateDueDate('2026-06-08', '2026-05-08'), false,
    'a later stored due date should be preserved');

  assert.strictEqual(shouldUpdateDueDate(null, '2026-05-08'), true,
    'a missing stored due date should be updated');

  assert.strictEqual(shouldUpdateDueDate('2026-05-08', '2026-05-08'), false,
    'an already matching due date should be skipped');

  console.log('✅ due date migration regression tests passed');
}

run();
