# Interest Capitalization - Quick Reference Guide

## What Happened?

Your loan system now automatically capitalizes interest when payments are made. This means:

- **When a customer pays >= monthly interest:** The interest is added to the principal, and new interest is calculated on the larger principal.
- **Due dates automatically extend by 1 month** when interest is capitalized.
- **Works on all loans** - both new loans and existing ones.

## Key Changes

### 1. Files Added
- `payment-utils.js` - Payment processing logic
- `migrate-capitalize-interest.js` - Updates existing loans
- `INTEREST_CAPITALIZATION_GUIDE.md` - Full documentation

### 2. Files Modified
- `server.js` - Two payment endpoints updated:
  - `/make-payment`
  - `/customers/:customerId/loans/:loanId/payment`

## The Simple Example

```
Customer borrows: $1,000
Monthly interest: 10% = $100/month

SCENARIO 1: Customer pays $100 (covers interest)
  ✅ Principal becomes: $1,100
  ✅ New monthly interest: $110
  ✅ Due date: +1 month
  ✅ Total owed: $1,210

SCENARIO 2: Customer pays $50 (doesn't cover interest)
  ❌ No capitalization
  ⏸️ No due date change
  ↓ Remaining balance: just reduced by $50
```

## How to Deploy

```bash
# 1. Deploy the new files
# server.js, payment-utils.js already in place

# 2. If you want to update existing loans
node migrate-capitalize-interest.js

# 3. Run a test payment to verify it works
# Check the response shows interest_capitalized: true
```

## API Changes

Both payment endpoints now return:

```json
{
  "paymentDetails": {
    "interestCapitalized": true,      // ← NEW
    "capitalizedAmount": "100.00",    // ← NEW
    "newPrincipal": "1100.00",       // ← CHANGED
    "newInterestAmount": "110.00",   // ← CHANGED
    "newDueDate": "2025-04-01",      // ← CHANGED
    ...
  }
}
```

## Testing

```bash
# Test endpoint (if using postman or curl)
POST /make-payment
{
  "loanId": 1,
  "paymentMethod": "cash", 
  "paymentAmount": 100
}

# Response should show:
# - interestCapitalized: true
# - New principal increased
# - New due date extended
```

## Database Updates Required?

No additional migration needed UNLESS you want to update existing loans retroactively. To do so:

```bash
node migrate-capitalize-interest.js
```

This will check all active loans and capitalize any pending interest from previous payments.

## Customer Impact

✅ **Positive**: Interest paid immediately reduces what they owe (principal-wise)  
✅ **Positive**: Clear visibility on principal growth  
✅ **Positive**: Automatic due date extensions for staying current  
⚠️ **Note**: Total outstanding amount may increase due to interest recalculation on new principal

## Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| Interest not capitalizing | Payment < interest amount | Only capitalizes when payment >= monthly interest |
| Due date not extending | Same as above | Check payment meets interest threshold |
| Migration errors | DB connection issue | Verify DATABASE_URL is set |
| Payment stuck | Race condition (rare) | Check server logs, restart servers |

## Files Reference

### payment-utils.js Functions

```javascript
// Check if loan needs capital
capitalizeInterest(loan)
  → Returns: { newPrincipal, newInterestAmount, ... }

// Extend date by 1 month
extendDateByOneMonth(date)
  → Returns: "2025-04-01"

// Main payment processing
processPaymentWithCapitalization(loan, paymentAmount, totalPayments)
  → Returns: Complete payment result object
```

### Migration Script

```bash
node migrate-capitalize-interest.js
# Output:
# - Loans processed
# - Loans capitalized
# - Loans skipped
# - Any errors
```

## Before Going Live

- [ ] Backup database: `pg_dump $DATABASE_URL > backup.sql`
- [ ] Deploy payment-utils.js
- [ ] Deploy updated server.js
- [ ] Run migration (if updating existing loans): `node migrate-capitalize-interest.js`
- [ ] Test payment endpoints
- [ ] Verify receipts show capitalization details
- [ ] Check a few loan records in database
- [ ] Monitor server logs

## Rollback

If something goes wrong:

```bash
# Restore database from backup
psql $DATABASE_URL < backup.sql

# Redeploy old server.js (without payment-utils changes)
```

## Questions?

See: `INTEREST_CAPITALIZATION_GUIDE.md` for detailed info

---

**Implementation Date:** March 1, 2026  
**Status:** Ready for deployment  
**Backward Compatible:** Yes - works with existing code
