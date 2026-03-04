# Database Update Persistence Analysis - Detailed Investigation Report

**Date:** March 4, 2026  
**Investigator:** GitHub Copilot  
**Focus:** Why database updates from auto-fix aren't persisting

---

## 1. SERVER STARTUP SEQUENCE (CRITICAL EXECUTION ORDER)

### Execution Order on Server Boot:
```
1. Database connection test (line 113-119)
   └─ SELECT NOW() - verify connection

2. initializeDatabase(pool) (line 126-127)
   └─ Creates tables with CREATE TABLE IF NOT EXISTS
   └─ Initializes default roles and admin user
   └─ Status: ✓ RUNS BEFORE AUTO-FIX

3. runMigrations() (line 129)
   └─ Executes SQL migration files from migrations/ directory
   └─ Executes .js migration files from migrations/ directory
   └─ Example: 20260127_add_initial_loan_amount.js
   └─ Status: ✓ RUNS BEFORE AUTO-FIX

4. AUTO-FIX (lines 131-220) ⭐ CRITICAL
   ├─ Fetches ALL loans from database
   ├─ For each loan:
   │  ├─ Gets payment_history to calculate totalPaid
   │  ├─ Calculates correct values:
   │  │  ├─ principal = initial_loan_amount or loan_amount
   │  │  ├─ correctInterestAmount = (principal * rate) / 100
   │  │  ├─ correctTotalPayable = principal + interestAmount
   │  │  ├─ correctRemainingBalance = totalPayable - totalPaid
   │  │  └─ correctDueDate = issued_date + loan_term
   │  ├─ UPDATE loans with corrected values
   │  └─ DELETE duplicate payments
   └─ Status: ✓ UPDATES DATABASE WITH CORRECT VALUES

5. runMigrationOnStartup(pool) (line 223-224) ⚠️ RUNS AFTER AUTO-FIX
   ├─ SELECT loans WHERE status IN ('active', 'overdue')
   ├─ AND remaining_balance > 0
   ├─ HAVING SUM(payments) >= interest_amount
   ├─ For EACH loan found:
   │  ├─ newPrincipal = principal + interestToCapitalize
   │  ├─ newInterestAmount = (newPrincipal * rate / 100)
   │  ├─ newDueDate = due_date + 1 month
   │  ├─ newRemainingBalance = newPrincipal + newInterestAmount
   │  └─ UPDATE loans with new capitalized values
   └─ Status: ⚠️ OVERWRITES AUTO-FIX VALUES IF CONDITIONS ARE MET!

6. Server starts listening on PORT
```

---

## 2. KEY FINDING: RACE CONDITION / SEQUENTIAL OVERWRITE

### The Problem:
- **AUTO-FIX runs FIRST** → Sets all loan values to correct calculated amounts
- **IMMEDIATELY AFTER**, **runMigrationOnStartup() runs** → Can OVERWRITE those values

### Detailed Capitalization Logic (from migrate-on-startup.js lines 25-40):

```javascript
// Gets all ACTIVE and OVERDUE loans where:
const loansResult = await pool.query(
  `SELECT l.id, l.loan_amount, l.interest_rate, l.interest_amount, l.due_date,
          l.status, l.remaining_balance,
          COALESCE(SUM(ph.payment_amount), 0) as total_paid
   FROM loans l
   LEFT JOIN payment_history ph ON l.id = ph.loan_id
   WHERE l.status IN ('active', 'overdue')
   AND l.remaining_balance > 0
   GROUP BY l.id
   HAVING COALESCE(SUM(ph.payment_amount), 0) >= l.interest_amount  // KEY CONDITION
   ORDER BY l.id ASC`
);
```

### The CAPITALIZATION Overwrites:
```javascript
// For each loan matching conditions above:
await pool.query(
  `UPDATE loans SET
    loan_amount = $1,              // Changes to newPrincipal (old + interest)
    interest_amount = $2,          // Recalculated on new principal
    due_date = $3,                 // Extended by 1 month
    remaining_balance = $4,        // Reset to newPrincipal + newInterest
    total_payable_amount = $5,     // Set to newRemainingBalance
    updated_at = CURRENT_TIMESTAMP
   WHERE id = $6`,
  [newPrincipal, newInterestAmount, newDueDate, 
   newRemainingBalance, newRemainingBalance, loan.id]
);
```

---

## 3. WHEN CAPITALIZATION CONDITIONS ARE MET

The auto-migration CAPITALIZES INTEREST (overwrites auto-fix) when:

1. **Loan status is 'active' OR 'overdue'** ✓ (usually true)
2. **remaining_balance > 0** ✓ (usually true)
3. **SUM(payment_history.payment_amount) >= loan.interest_amount** ⚠️ KEY CONDITION

### Example Scenario Where Auto-Fix Gets Overwritten:
```
Auto-Fix corrects the loan:
  - Principal: $10,000
  - Interest: $500 (5%)
  - Remaining Balance: $10,500
  - Payments in history: $500

Auto-migration checks:
  - Status = 'active' ✓
  - remaining_balance (10,500) > 0 ✓
  - total_paid (500) >= interest_amount (500) ✓ CONDITION MET!

AUTO-MIGRATION CAPITALIZES:
  - newPrincipal = 10,000 + 500 = 10,500
  - newInterestAmount = (10,500 * 5) / 100 = 525
  - newDueDate = original + 1 month
  - newRemainingBalance = 10,500 + 525 = 11,025

RESULT: Auto-fix values are OVERWRITTEN with new capitalized values!
```

---

## 4. DATABASE SCHEMA - NO TRIGGERS, NO DEFAULT RESETS

### Checked for Automatic Value Resets:
- ✓ No TRIGGER found that would reset loan_amount
- ✓ No TRIGGER found that would reset remaining_balance
- ✓ No TRIGGER found that would reset interest_amount
- ✓ Column DEFAULT values in loans table:
  ```sql
  -- From db-init.js schema definition:
  loan_amount NUMERIC NOT NULL              -- NO DEFAULT
  initial_loan_amount NUMERIC NOT NULL      -- NO DEFAULT
  interest_rate NUMERIC NOT NULL            -- NO DEFAULT
  interest_amount NUMERIC(10,2)             -- NO DEFAULT
  total_payable_amount NUMERIC(10,2)        -- NO DEFAULT
  remaining_balance NUMERIC(10,2)           -- NO DEFAULT
  due_date DATE                             -- NO DEFAULT
  status VARCHAR(50) DEFAULT 'active'       -- DEFAULT exists but NOT resetting loan values
  recurring_fee NUMERIC(10,2) DEFAULT 0     -- Only affects fees
  ```

### Conclusion: 
✅ Database schema itself does NOT reset values  
⚠️ Problem is in APPLICATION LOGIC, not database design

---

## 5. MIGRATION FILES THAT RUN ON STARTUP

### From `/migrations` directory:
```
001_initial_schema.sql                     - Creates base tables
004_add_customer_fields.sql                - Adds customer columns
005_add_extended_customer_fields.sql       - Adds more customer fields
006_complete_schema.sql                    - Adds is_redeemed, is_forfeited
007_create_customers_table.sql             - Creates customers table
008_add_loan_extension_columns.sql         - Adds extension columns
009_add_collateral_image_column.sql        - Adds collateral_image
010_add_recurring_fee_column.sql           - Adds recurring_fee
011_add_admin_settings_table.sql           - Creates admin_settings
012_seed_user_data.sql                     - Seeds default users
013_create_missing_tables.sql              - Creates missing tables
014_add_missing_loan_columns.sql           - Adds missing columns
015_add_missing_payment_history_columns.sql - Adds payment columns
016_add_missing_columns_comprehensive.sql  - Comprehensive column additions
20260127_add_initial_loan_amount.js        - ✓ Adds initial_loan_amount column
add_profile_image_column.sql               - Adds profile_image
```

### Potential Issue with `add_initial_loan_amount.js`:
```javascript
// This migration runs and could affect loan amounts!
UPDATE loans
SET initial_loan_amount = loan_amount
WHERE initial_loan_amount IS NULL OR initial_loan_amount = 0;
```

**Risk:** If this runs during startup and sets initial_loan_amount BEFORE auto-fix,  
the auto-fix might use the wrong value as the "source of truth"

---

## 6. DUPLICATE PAYMENT HEURISTICS IN AUTO-FIX

The auto-fix tries to remove duplicate payments (lines 204-212):
```javascript
// Remove duplicate payments
const payments = await pool.query(
  'SELECT id FROM payment_history WHERE loan_id = $1 ORDER BY payment_date ASC',
  [loan.id]
);

if (payments.rows.length > 1) {
  for (let i = 1; i < payments.rows.length; i++) {
    await pool.query('DELETE FROM payment_history WHERE id = $1', [payments.rows[i].id]);
    deleteCount++;
  }
}
```

**Problem:** This DELETES ALL payments except the first one!  
This is incorrect if:
1. Multiple legitimate payments were made
2. Payment amounts differ
3. All payments should be kept, not deleted

---

## 7. CODE AFTER AUTO-FIX STARTUP SEQUENCE

### What Runs After Auto-Fix UPDATE Queries:
1. ✓ runMigrationOnStartup() - Can overwrite values
2. ✓ Server starts listening (HTTP server begins)
3. ✓ initializeAdminSettings() runs asynchronously
4. ✓ Email transporter verification runs asynchronously

### NO CODE UPDATES loans AFTER runMigrationOnStartup runs  
✓ Confirmed: Only endpoint handlers and migrations can update loans after startup

---

## 8. HELPER CLEANUP SCRIPTS (NOT AFFECTING PERSISTENCE)

### fix-*.js files found:
```
fix-loan-8-principal.js    - Manual fix for specific loan #8
fix-loan-8.js              - Manual fix attempt
fix-due-date.js            - Fix due dates
fix-loan-final.js          - Final fix attempt
```

**Status:** These are NOT called during startup. They're standalone scripts.  
**Note:** fix-loan-final.js has hardcoded connection string! (SECURITY ISSUE)

### update-*.js files:
```
update-loan.js             - Updates loan #11 with specific values
update-loan-11.js          - Updates loan #11
```

**Status:** Manual scripts, NOT called during startup

### cleanup-*.js files:
```
cleanup-loan-8.js          - Removes duplicate payments for loan #8
```

**Status:** Manual script, NOT called during startup

### check-*.js files:
```
check-loans.js             - Queries and displays all loans
```

**Status:** Diagnostic script, NOT called during startup

---

## 9. THE ROOT CAUSE: THREE FACTORS

### Factor 1: AUTO-FIX RUNS FIRST ✓
```javascript
// server.js lines 131-220
// ✓ Correctly calculates and updates all loans
```

### Factor 2: AUTO-MIGRATION RUNS IMMEDIATELY AFTER ⚠️
```javascript
// server.js line 223
const migrationResult = await runMigrationOnStartup(pool);
// This runs WITHOUT WAITING for auto-fix to complete!
```

### Factor 3: MIGRATION CONDITIONS ARE TOO BROAD ⚠️
```javascript
// migrate-on-startup.js line HAVING clause:
HAVING COALESCE(SUM(ph.payment_amount), 0) >= l.interest_amount
// This matches almost ALL loans that have ANY payments!
```

---

## 10. EVIDENCE OF THE PROBLEM

### Payment History Duplication:
The auto-fix assumes there are duplicate payments:
```javascript
// Lines 204-212 delete all but first payment
if (payments.rows.length > 1) {
  for (let i = 1; i < payments.rows.length; i++) {
    await pool.query('DELETE FROM payment_history WHERE id = $1', [payments.rows[i].id]);
  }
}
```

This suggests:
- ✓ Payment history IS being duplicated somehow
- ✓ Multiple identical payments exist
- ✓ But ALL payments except first are deleted (wrong!)

---

## 11. SEQUENCE OF DATABASE WRITES

### EXACT ORDER of SQL commands at startup:
```
1. Test connection: SELECT NOW()
2. Schema init: CREATE TABLE IF NOT EXISTS (all tables)
3. Insert default roles: INSERT INTO user_roles
4. Insert admin user: INSERT INTO users
5. Migrations execute: ALTER TABLE, etc.
6. Auto-fix:
   ├─ SELECT all loans
   ├─ For each loan:
   │  ├─ SELECT payment_history sum
   │  ├─ UPDATE loans SET (6 fields)
   │  ├─ SELECT payment_history all
   │  └─ DELETE from payment_history (duplicates)
7. Auto-migration:
   ├─ SELECT loans WHERE HAVING (payments >= interest)
   ├─ For each qualifying loan:
   │  └─ UPDATE loans SET (5 fields with new values)
8. App starts listening
```

**Critical:** Steps 6 and 7 are sequential asyncrones, not parallel.  
Auto-migration uses the UPDATED values from auto-fix as input.

---

## 12. WHY AUTO-FIX VALUES DON'T PERSIST

### Scenario A: Payment == Interest Amount
```
Auto-fix sets:    loan_amount=10000, interest=500, remaining=10500
Migration matches: total_paid(500) >= interest(500) ✓ TRUE
Migration updates: loan_amount=10500, interest=525, remaining=11025
Result: ❌ Auto-fix values are overwritten
```

### Scenario B: Payment > Interest Amount
```
Auto-fix sets:    loan_amount=10000, interest=500, remaining=10500
Migration matches: total_paid(750) >= interest(500) ✓ TRUE
Migration updates: loan_amount=10500, interest=525, remaining=11025
Result: ❌ Auto-fix values are overwritten
```

### Scenario C: Payment < Interest Amount
```
Auto-fix sets:    loan_amount=10000, interest=500, remaining=10500
Migration matches: total_paid(300) >= interest(500) ✗ FALSE
Migration skips: Loan NOT capitalized
Result: ✅ Auto-fix values PERSIST
```

---

## 13. SOLUTION OPTIONS

### Option 1: DISABLE auto-migration on startup ✓ SIMPLEST
```javascript
// server.js line 223 - COMMENT OUT
// const migrationResult = await runMigrationOnStartup(pool);
```
**Pros:** Auto-fix values will persist  
**Cons:** Interest capitalization won't happen automatically

### Option 2: RUN auto-migration BEFORE auto-fix
```javascript
// Move runMigrationOnStartup() before auto-fix block
// So auto-fix runs last and overwrites migration
```
**Pros:** Auto-fix has final say  
**Cons:** Still wastes processing doing work twice

### Option 3: ENHANCE auto-fix to not touch already-correct loans
```javascript
// Check if loan is already corrected
// Only update if values differ from expected
```
**Pros:** Smarter logic  
**Cons:** More complex code

### Option 4: REMOVE auto-migration, add manual trigger
```javascript
// Only capitalize interest when:
// - User explicitly requests it (manual endpoint)
// - OR run as scheduled job (not on startup)
```
**Pros:** Only capitalizes when intended  
**Cons:** Requires manual intervention or external job

---

## SUMMARY & RECOMMENDATIONS

### Root Cause:
The `runMigrationOnStartup()` function runs immediately after `AUTO-FIX` and overwrites all corrected loan values with capitalized interest values, when the condition `total_paid >= interest_amount` is met.

### Why It Happens:
1. Auto-fix corrects values (lines 131-220)
2. Auto-migration runs immediately after (line 223)
3. Most loans have payments >= their interest amount
4. Migration condition is satisfied, so all loans are capitalized
5. Auto-fix changes don't persist in database

### Immediate Fix:
Comment out line 223 in [server.js](server.js#L223) to disable auto-migration:
```javascript
// const migrationResult = await runMigrationOnStartup(pool);
```

### Long-term Fix:
1. Move all interest capitalization to a separate scheduled job (not startup)
2. Update the auto-fix to run AFTER any migrations that might affect data
3. OR make auto-fix idempotent and run it LAST in the startup sequence
4. Add logic to prevent running migrations that overwrite auto-fix corrections

### Files to Review:
- [server.js](server.js) - Lines 113-224 (startup sequence)
- [migrate-on-startup.js](migrate-on-startup.js) - Interest capitalization logic
- [migrations/](migrations/) - All migration files

