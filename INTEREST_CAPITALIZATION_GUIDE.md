# Interest Capitalization Implementation - Complete Documentation

## Overview

This document describes the interest capitalization system implemented for the pawn shop loan system. When a borrower makes a payment equal to or greater than the monthly interest amount, the interest is automatically capitalized (added to principal) and the loan terms are adjusted accordingly.

## What Changed

### New Files Created

1. **payment-utils.js** - Centralized payment processing logic with interest capitalization
2. **migrate-capitalize-interest.js** - Node.js migration script to handle existing loans
3. **migrate-capitalize-interest.sql** - SQL reference queries and backup scripts

### Modified Files

1. **server.js** - Updated payment endpoints to use new interest capitalization logic
   - Updated `/make-payment` endpoint (line ~1387)
   - Updated `/customers/:customerId/loans/:loanId/payment` endpoint (line ~3143)

## How Interest Capitalization Works

### The Logic

When a payment is made, the system checks:

1. **If payment amount >= current interest_amount for the month:**
   - ✅ **Interest Capitalized**: Interest amount is added to the principal (loan_amount)
   - ✅ **New Interest Calculated**: Interest is recalculated on the new principal
   - ✅ **Due Date Extended**: Due date is extended by 1 month
   - ✅ **Remaining Balance Updated**: Updated to reflect new principal + new interest

2. **If payment amount < current interest_amount for the month:**
   - ❌ **No Capitalization**: Payment is applied against remaining balance
   - ⏸️ **No due date extension** (unless full payment)
   - Remaining balance is simply reduced by payment amount

3. **If payment clears the full balance:**
   - 🎉 **Loan Marked as Redeemed**: Status automatically changes to 'redeemed'

### Example Scenario

```
Initial Loan:
  Principal: $1,000
  Monthly Interest Rate: 10%
  Monthly Interest: $100
  Due Date: 2025-03-01
  Remaining Balance: $1,100

Customer Payment: $100 (covers interest)

RESULT:
  New Principal: $1,100 (old $1,000 + capitalized $100 interest)
  New Monthly Interest: $110 (10% of $1,100)
  New Due Date: 2025-04-01 (extended 1 month)
  New Remaining Balance: $1,210 ($1,100 principal + $110 new interest)
```

## Technical Implementation

### Payment Processing Flow

```
Payment Received
    ↓
[processPaymentWithCapitalization() called]
    ↓
Check: Payment >= Interest Amount?
    ├─ YES → Capitalize Interest
    │   ├─ Add interest_amount to loan_amount
    │   ├─ Recalculate interest on new principal
    │   └─ Extend due_date by 1 month
    │
    └─ NO → Partial Payment Applied
        └─ Reduce remaining_balance only

Update Loan Record
    ↓
Record Payment History
    ↓
Generate Receipt
    ↓
Return Response
```

### Database Updates

When a payment is processed, the following columns are updated:

```sql
UPDATE loans SET
  loan_amount = new_principal,           -- Capitalized if interest paid
  interest_amount = new_interest,        -- Recalculated on new principal
  remaining_balance = final_balance,     -- Principal + new interest
  due_date = new_due_date,              -- Extended if interest paid
  status = new_status,                   -- May change to 'redeemed'
  total_payable_amount = final_balance,  -- Equals remaining_balance
  updated_at = CURRENT_TIMESTAMP
WHERE id = loan_id;
```

### Key Functions in payment-utils.js

#### 1. `capitalizeInterest(loan)`
- Takes current loan record
- Adds interest_amount to loan_amount
- Calculates new interest on new principal
- Returns: { newPrincipal, newInterestAmount, capitalizedInterestAmount, totalRemainingBalance }

#### 2. `extendDateByOneMonth(date)`
- Extends a date by exactly 1 month
- Maintains same day of month
- Returns date in YYYY-MM-DD format

#### 3. `processPaymentWithCapitalization(loan, paymentAmount, totalPaymentsAfter)`
- Main payment processing function
- Handles all payment scenarios (active/overdue/full/partial)
- Returns payment result object with all new values

## Migration for Existing Loans

### Running the Migration

```bash
# Using Node.js script
node migrate-capitalize-interest.js

# Output will show:
# - Number of loans processed
# - Number capitalized
# - Number skipped (no interest paid yet)
# - Any errors encountered
```

### What the Migration Does

The migration script (`migrate-capitalize-interest.js`):

1. Connects to the database
2. Retrieves all active/overdue loans
3. For each loan, checks if payments >= interest_amount
4. If yes, applies interest capitalization logic:
   - Updates principal (loan_amount)
   - Recalculates interest
   - Extends due date
   - Updates remaining_balance
5. Logs results and produces summary

### Safety Features

- ✅ **Safe to run multiple times** - Only processes loans that haven't been capitalized
- ✅ **Backup created** - `loans_capitalization_backup` table created
- ✅ **Error handling** - Individual loan errors don't stop migration
- ✅ **Detailed logging** - Shows exactly what's being changed

### SQL Reference Queries

Check which loans will be affected:

```sql
-- View loans that need capitalization
SELECT * FROM loans_needs_capitalization;

-- Count loans needing capitalization
SELECT COUNT(*) FROM loans_needs_capitalization;

-- See payment history for a specific loan
SELECT 
  ph.id,
  ph.payment_amount,
  ph.payment_date,
  SUM(ph.payment_amount) OVER (ORDER BY ph.payment_date) as running_total
FROM payment_history ph
WHERE ph.loan_id = ?;
```

## API Response Changes

### /make-payment Endpoint

**Request:**
```json
{
  "loanId": 123,
  "paymentMethod": "cash",
  "paymentAmount": 100,
  "userId": 1
}
```

**Response (When Interest Capitalized):**
```json
{
  "message": "✅ Payment applied! Interest capitalized and added to principal. Due date extended to 2025-04-01.",
  "loan": { ... },
  "paymentHistory": { ... },
  "receiptPDF": "base64...",
  "paymentDetails": {
    "paymentAmount": "100.00",
    "interestCapitalized": true,
    "capitalizedAmount": "100.00",
    "newPrincipal": "1100.00",
    "newInterestAmount": "110.00",
    "newRemainingBalance": "1210.00",
    "dueDateExtended": true,
    "newDueDate": "2025-04-01",
    "newStatus": "active"
  }
}
```

### /customers/:customerId/loans/:loanId/payment Endpoint

Same response structure as above, with detailed `paymentDetails` object showing all calculated values.

## Database Schema Considerations

### Current Columns Used

The implementation uses existing database columns:

- `loan_amount` - Principal (updated with capitalized interest)
- `interest_amount` - Interest for current month
- `remaining_balance` - Total amount owed (principal + interest)
- `due_date` - Loan payment due date
- `status` - Current loan status
- `interest_rate` - Interest rate percentage
- `payment_history` - Tracks all payments made

### Optional Enhancement: Track Capitalization

To track when interest was capitalized, you could add:

```sql
ALTER TABLE loans ADD COLUMN last_interest_capitalization_date TIMESTAMP;

-- Update when capitalizing:
UPDATE loans SET 
  last_interest_capitalization_date = CURRENT_TIMESTAMP 
WHERE id = ?;
```

## Testing the Implementation

### Test Case 1: Interest Payment on Active Loan

```bash
curl -X POST http://localhost:5000/make-payment \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "loanId": 1,
    "paymentMethod": "cash",
    "paymentAmount": 100,
    "userId": 1
  }'
```

Expected: Interest capitalized, due date extended

### Test Case 2: Partial Payment (Less than Interest)

```bash
curl -X POST http://localhost:5000/make-payment \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "loanId": 1,
    "paymentMethod": "cash",
    "paymentAmount": 50,
    "userId": 1
  }'
```

Expected: Remaining balance reduced, no date extension

### Test Case 3: Full Payment

```bash
# Assuming loan total balance is 1000
curl -X POST http://localhost:5000/make-payment \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "loanId": 1,
    "paymentMethod": "cash",
    "paymentAmount": 1000,
    "userId": 1
  }'
```

Expected: Loan marked as 'redeemed', full payment message

## Deployment Steps

1. **Backup Database** (Required)
   ```bash
   pg_dump $DATABASE_URL > backup-before-capitalization.sql
   ```

2. **Deploy Code Changes**
   - Deploy updated server.js with payment-utils.js
   - Ensure nodemailer and other dependencies are installed

3. **Apply Migration** (If updating existing loans)
   ```bash
   node migrate-capitalize-interest.js
   ```

4. **Verify Results**
   - Check migration logs
   - Test a few loans manually
   - Verify payment receipts show correct capitalization

5. **Monitor Post-Deployment**
   - Watch logs for any payment processing errors
   - Verify customers receive correct receipts
   - Check that due dates are extending correctly

## Troubleshooting

### Issue: Payment not capitalizing interest

**Cause:** Payment amount is less than interest_amount
**Solution:** Verify payment amount in request. Interest capitalization only happens when payment >= interest_amount

### Issue: Due date not extending

**Cause:** Expected - due dates only extend when interest capitalizes
**Solution:** Check if payment >= interest_amount. If not, date won't extend

### Issue: Migration stuck or timing out

**Cause:** Large number of loans or slow database connection
**Solution:** 
- Run migration during off-peak hours
- Check database connection timeout settings
- Can modify migration script to process in batches

### Issue: Negative remaining balance

**Cause:** Payment exceeds total balance
**Solution:** This is caught and maximum value is Math.max(remaining - payment, 0)
- Overpayment is prevented by the logic

## Rollback Plan

If you need to rollback the changes:

```sql
-- Restore loans from backup
TRUNCATE loans;
INSERT INTO loans SELECT * FROM loans_capitalization_backup;

-- Verify restoration
SELECT COUNT(*) FROM loans;
SELECT COUNT(*) FROM loans_capitalization_backup;
```

## Future Enhancements

Potential improvements to consider:

1. **Configure Capitalization Rules** - Allow monthly vs. yearly capitalization
2. **Capitalization History** - Track each capitalization event
3. **Advance Payment Credits** - Handle advance payments differently
4. **Partial Capitalization** - Option to capitalize only portion of interest
5. **Audit Trail** - Detailed audit log of all capital changes
6. **Customer Notifications** - Notify customers when interest is capitalized

## Support & Questions

For questions about this implementation:

1. Check payment_history table to verify all payments
2. Review server logs for payment processing details
3. Verify loan_amount, interest_amount, and due_date in database
4. Check that interest_rate is properly configured

## Summary

The interest capitalization system ensures that:

✅ When borrowers pay the monthly interest, they're credited immediately  
✅ The principal grows as interest is capitalized  
✅ Future interest is calculated on the new principal  
✅ Due dates automatically extend by 1 month per payment  
✅ System automatically updated for both new and existing loans  
✅ Payment receipts clearly show capitalization details  
✅ The logic is consistent across all payment endpoints  

This creates a more transparent and fair system for both the pawn shop and its customers.
