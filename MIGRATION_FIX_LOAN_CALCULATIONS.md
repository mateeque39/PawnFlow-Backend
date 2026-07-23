# Loan Calculations Fix - Migration Guide

## Overview
This migration fixes the total payable amount and remaining balance calculations for all existing loans in your system. The issue was that the calculation wasn't including the `recurring_fee` component.

## What Gets Fixed

### Before Migration ???
```
Total Payable = Loan Amount + Interest Amount
```

### After Migration ???
```
Total Payable = Loan Amount + Interest Amount + Recurring Fee
Remaining Balance = Total Payable - Total Payments Made
```

## Files Included

1. **migrations/002_fix_loan_calculations.sql** - SQL migration file
2. **fix_loan_calculations_migration.js** - Node.js script to run the migration

## How to Run the Migration

### Option 1: Using Node.js Script (Recommended)

```bash
# Run the migration script
node fix_loan_calculations_migration.js
```

**Advantages:**
- Shows real-time progress
- Displays sample of updated loans
- Shows statistics before/after
- Automatic transaction handling with rollback on error
- Creates detailed audit trail

### Option 2: Using psql (Direct SQL)

```bash
# Connect to your database and run the SQL migration
psql -d your_database_name < migrations/002_fix_loan_calculations.sql
```

### Option 3: Using pgAdmin or Database Client

1. Open your database connection tool
2. Copy the SQL from `migrations/002_fix_loan_calculations.sql`
3. Execute the entire script

## What the Migration Does

1. **Creates temporary column** for new calculations
2. **Recalculates total_payable_amount** for all loans:
   ```
   new_total = loan_amount + interest_amount + recurring_fee
   ```
3. **Recalculates remaining_balance** based on:
   - Total payable amount (newly calculated)
   - Minus total payments received
   - Ensures balance never goes negative
   - Sets redeemed loans to $0
4. **Cleans up** temporary columns
5. **Maintains data integrity** with transactions

## Safety Features

??? **Transaction-based**: Uses BEGIN/COMMIT/ROLLBACK  
??? **Automatic rollback**: If any error occurs, all changes are rolled back  
??? **Non-destructive**: Only updates calculations, doesn't delete data  
??? **Idempotent**: Can be run multiple times safely  
??? **Audit logging**: Records migration in audit_logs table (if exists)

## Expected Results

### Sample Output:
```
??? Transaction started
??? Created temporary column: total_payable_amount_new
??? Calculated new total_payable_amount for 45 loans
??? Calculated payment totals for 45 loans
??? Updated remaining_balance for 42 active loans
??? Set remaining_balance to 0 for 3 redeemed loans
??? Updated total_payable_amount for 45 loans
??? Cleaned up temporary column

???? Migration Statistics:
   Total loans: 45
   Active: 42 | Redeemed: 3 | Overdue: 0 | Forfeited: 0
   Total payable amount across all loans: $125,450.00
   Total remaining balance: $98,200.00

??? Migration completed successfully!
```

## Verification After Migration

To verify the fix worked correctly, run this query:

```sql
-- Check if calculations are correct
SELECT 
  id,
  customer_name,
  loan_amount,
  interest_amount,
  recurring_fee,
  (loan_amount + COALESCE(interest_amount, 0) + COALESCE(recurring_fee, 0)) as expected_total,
  total_payable_amount,
  CASE 
    WHEN (loan_amount + COALESCE(interest_amount, 0) + COALESCE(recurring_fee, 0)) = total_payable_amount 
    THEN '??? Correct'
    ELSE '??? MISMATCH!'
  END as status
FROM loans
ORDER BY id DESC
LIMIT 20;
```

All rows should show "??? Correct" in the status column.

## Rollback Instructions

If you need to undo the migration, restore from your most recent backup:

```bash
# Restore from backup (adjust path as needed)
psql -d your_database_name < backup_file.sql
```

## Support

- Check for errors in the migration output
- Verify calculations using the SQL query above
- Compare a few loans to ensure math is correct
- Check remaining balances match: `total_payable - payments_received`

## Next Steps

After running the migration:

1. ??? All new loans will use the correct calculation automatically
2. ??? Existing loans now have correct values
3. ??? Payment receipts will display accurate totals
4. ??? Reports will show correct financial data

---

**Status**: Ready to deploy  
**Impact**: Updates all existing loans  
**Safety**: Transaction-based with automatic rollback  
**Data Loss**: None - only recalculates existing values
