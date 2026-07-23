-- Fix Total Payable Amount and Remaining Balance for All Existing Loans
-- This migration recalculates total_payable_amount to include recurring fees
-- and updates remaining_balance based on actual payments made

BEGIN;

-- Step 1: Create a temporary column to hold new total payable amounts
ALTER TABLE loans 
ADD COLUMN IF NOT EXISTS total_payable_amount_new DECIMAL(10, 2);

-- Step 2: Calculate the correct total_payable_amount for all loans
-- Formula: loan_amount + interest_amount + COALESCE(recurring_fee, 0)
UPDATE loans
SET total_payable_amount_new = 
  loan_amount + 
  COALESCE(interest_amount, 0) + 
  COALESCE(recurring_fee, 0)
WHERE total_payable_amount_new IS NULL;

-- Step 3: Create a temporary table to hold total payments per loan
CREATE TEMPORARY TABLE temp_payments AS
SELECT 
  loan_id,
  COALESCE(SUM(payment_amount), 0) as total_paid
FROM payment_history
GROUP BY loan_id;

-- Step 4: Update remaining_balance based on correct total_payable and actual payments
UPDATE loans l
SET remaining_balance = 
  GREATEST(
    0,
    COALESCE(l.total_payable_amount_new, 0) - 
    COALESCE((SELECT total_paid FROM temp_payments WHERE loan_id = l.id), 0)
  )
WHERE status != 'redeemed';

-- Step 5: For redeemed loans, set remaining balance to 0
UPDATE loans
SET remaining_balance = 0
WHERE status = 'redeemed';

-- Step 6: Replace old total_payable_amount with the new calculated one
UPDATE loans
SET total_payable_amount = total_payable_amount_new
WHERE total_payable_amount_new IS NOT NULL;

-- Step 7: Drop the temporary column
ALTER TABLE loans
DROP COLUMN IF EXISTS total_payable_amount_new;

-- Step 8: Verify the updates with a sample report
-- SELECT 
--   id,
--   customer_name,
--   loan_amount,
--   interest_amount,
--   recurring_fee,
--   total_payable_amount,
--   remaining_balance,
--   status
-- FROM loans
-- LIMIT 10;

COMMIT;

-- Log the migration completion
INSERT INTO audit_logs (action, description, performed_at)
VALUES (
  'MIGRATION',
  'Fixed total_payable_amount and remaining_balance for all loans - included recurring fees',
  CURRENT_TIMESTAMP
)
ON CONFLICT DO NOTHING;
