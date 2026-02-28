/**
 * Alternative SQL Migration Script
 * Run this directly in PostgreSQL if needed
 * 
 * This will update all active loans where interest has been paid
 * by capitalizing the interest and recalculating based on the new principal
 */

-- BACKUP: Create a backup of loans before migration (optional but recommended)
CREATE TABLE IF NOT EXISTS loans_capitalization_backup AS
SELECT * FROM loans WHERE status IN ('active', 'overdue');

-- Migration logic for each loan would need to be run in application
-- because the calculation depends on payment history

-- For reference, here's a SQL view that shows which loans would be affected:
CREATE OR REPLACE VIEW loans_needs_capitalization AS
SELECT 
  l.id,
  l.loan_amount,
  l.interest_rate,
  l.interest_amount,
  l.due_date,
  l.status,
  COALESCE(SUM(ph.payment_amount), 0) as total_paid,
  CASE 
    WHEN COALESCE(SUM(ph.payment_amount), 0) >= l.interest_amount THEN true
    ELSE false
  END as should_capitalize
FROM loans l
LEFT JOIN payment_history ph ON l.id = ph.loan_id
WHERE l.status IN ('active', 'overdue')
GROUP BY l.id, l.loan_amount, l.interest_rate, l.interest_amount, l.due_date, l.status
HAVING COALESCE(SUM(ph.payment_amount), 0) >= l.interest_amount
ORDER BY l.id;

-- Check which loans need capitalization
SELECT * FROM loans_needs_capitalization;

-- Count of loans needing capitalization
SELECT COUNT(*) as loans_needing_capitalization 
FROM loans_needs_capitalization;
