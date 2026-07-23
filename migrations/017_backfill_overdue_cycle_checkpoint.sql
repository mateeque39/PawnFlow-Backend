BEGIN;

ALTER TABLE loans
  ADD COLUMN IF NOT EXISTS last_extended_at TIMESTAMP WITHOUT TIME ZONE;

-- Existing overdue rows start a fresh 30-day checkpoint from their last known update.
-- Do not rewrite due_date because the original pre-extension date is not stored separately.
UPDATE loans
SET last_extended_at = COALESCE(last_extended_at, updated_at, CURRENT_TIMESTAMP)
WHERE status = 'overdue'
  AND last_extended_at IS NULL;

COMMIT;