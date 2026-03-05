-- Migration: Fix Loans 8, 9, 11 - Revert from May dates back to March dates
-- Date: 2026-03-06
-- Description: 
--   The retroactive extension logic was re-extending already-extended loans on each server restart.
--   Loans 8, 9, 11 were set to May 10 (extended twice). This migration fixes them back to March (one extension).
--   After this migration, deploy commit bb05ade which prevents re-extension.

-- Loan 8: Revert May 10 → March 10
UPDATE loans 
SET 
  due_date = TO_DATE('2026-03-10', 'YYYY-MM-DD'),
  remaining_balance = 20600,
  extended_this_cycle = true,
  interest_amount = 600,
  interest_paid_this_cycle = 0,
  updated_at = CURRENT_TIMESTAMP
WHERE id = 8;

-- Loan 9: Revert May 10 → March 10
UPDATE loans 
SET 
  due_date = TO_DATE('2026-03-10', 'YYYY-MM-DD'),
  remaining_balance = 30900,
  extended_this_cycle = true,
  interest_amount = 900,
  interest_paid_this_cycle = 0,
  updated_at = CURRENT_TIMESTAMP
WHERE id = 9;

-- Loan 11: Fix to March 15
UPDATE loans 
SET 
  due_date = TO_DATE('2026-03-15', 'YYYY-MM-DD'),
  remaining_balance = 22550,
  extended_this_cycle = true,
  interest_amount = 550,
  interest_paid_this_cycle = 0,
  updated_at = CURRENT_TIMESTAMP
WHERE id = 11;

-- Note: The extended_this_cycle flag is set to true here so that the new db-init.js
-- (commit bb05ade) will NOT re-extend these loans on startup.
-- The guard in db-init.js checks: if (loan.extended_this_cycle) then skip re-extension
