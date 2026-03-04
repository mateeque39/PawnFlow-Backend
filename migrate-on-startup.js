/**
 * Automatic Migration on Startup
 * Runs interest capitalization migration when server starts
 * Safe to run multiple times - only processes loans that need updating
 */

const { Pool } = require('pg');

/**
 * Run migration on startup
 * @param {Pool} pool - Database connection pool
 * @returns {Promise<Object>} - Migration results
 */
async function runMigrationOnStartup(pool) {
  console.log('\n' + '='.repeat(70));
  console.log('🔄 CHECKING FOR LOANS NEEDING INTEREST CAPITALIZATION');
  console.log('='.repeat(70));

  try {
    // Get all active loans that might need capitalization
    // Check ALL payment tables, not just payment_history
    // EXCLUDE loans that already have extended_this_cycle = true (retroactively extended)
    const loansResult = await pool.query(
      `SELECT l.id, l.loan_amount, l.interest_rate, l.interest_amount, l.due_date,
              l.status, l.remaining_balance, l.extended_this_cycle,
              COALESCE(
                (SELECT SUM(CAST(payment_amount AS NUMERIC)) FROM payment_history WHERE loan_id = l.id) +
                (SELECT SUM(CAST(payment_amount AS NUMERIC)) FROM payments WHERE loan_id = l.id) +
                (SELECT SUM(CAST(amount_paid AS NUMERIC)) FROM loan_payments WHERE loan_id = l.id),
                0
              ) as total_paid
       FROM loans l
       WHERE l.status IN ('active', 'overdue')
       AND l.remaining_balance > 0
       AND l.extended_this_cycle = false
       ORDER BY l.id ASC`
    );

    const loansToCapitalize = loansResult.rows.filter(l => {
      const totalPaid = parseFloat(l.total_paid || 0);
      const interestAmount = parseFloat(l.interest_amount || 0);
      return totalPaid >= interestAmount;
    });

    if (loansToCapitalize.length === 0) {
      console.log('✅ No loans need capitalization. All loans are up to date!');
      console.log('='.repeat(70) + '\n');
      return {
        loansCapitalized: 0,
        loansProcessed: 0,
        success: true,
        message: 'No loans need capitalization'
      };
    }

    console.log(`📊 Found ${loansToCapitalize.length} loans needing capitalization`);
    console.log('Starting automated capitalization process...\n');

    // Debug: show which loans need capitalization
    loansToCapitalize.forEach(loan => {
      const totalPaid = parseFloat(loan.total_paid || 0);
      const interestAmount = parseFloat(loan.interest_amount || 0);
      console.log(`  📋 Loan #${loan.id}: Total Paid $${totalPaid} >= Required Interest $${interestAmount} ✓`);
    });
    console.log();

    let capitalized = 0;
    let errors = 0;

    // Process each loan
    for (const loan of loansToCapitalize) {
      try {
        const currentPrincipal = parseFloat(loan.loan_amount || 0);
        const interestToCapitalize = parseFloat(loan.interest_amount || 0);
        const interestRate = parseFloat(loan.interest_rate || 0);

        // New principal = old principal + interest
        const newPrincipal = currentPrincipal + interestToCapitalize;

        // New interest calculated on new principal
        const newInterestAmount = Math.round((newPrincipal * interestRate / 100) * 100) / 100;

        // Extend due date by 1 month
        const dueDate = new Date(loan.due_date);
        dueDate.setMonth(dueDate.getMonth() + 1);
        const year = dueDate.getFullYear();
        const month = String(dueDate.getMonth() + 1).padStart(2, '0');
        const day = String(dueDate.getDate()).padStart(2, '0');
        const newDueDate = `${year}-${month}-${day}`;

        // New remaining balance
        const newRemainingBalance = newPrincipal + newInterestAmount;

        // Update the loan
        await pool.query(
          `UPDATE loans SET
            loan_amount = $1,
            interest_amount = $2,
            due_date = $3,
            remaining_balance = $4,
            total_payable_amount = $5,
            updated_at = CURRENT_TIMESTAMP
           WHERE id = $6`,
          [
            newPrincipal,
            newInterestAmount,
            newDueDate,
            newRemainingBalance,
            newRemainingBalance,
            loan.id
          ]
        );

        capitalized++;
        
        // Format old due date for comparison
        const oldDueDateObj = new Date(loan.due_date);
        const oldDueDateStr = oldDueDateObj.toISOString().split('T')[0];
        
        console.log(`  ✅ Loan ${loan.id}: Principal $${currentPrincipal} → $${newPrincipal}`);
        console.log(`     Due date: ${oldDueDateStr} → ${newDueDate}`);
        
        // Verify the update persisted to DB
        const verifyResult = await pool.query('SELECT due_date, loan_amount FROM loans WHERE id = $1', [loan.id]);
        if (verifyResult.rows.length > 0) {
          const dbDueDate = verifyResult.rows[0].due_date.toISOString().split('T')[0];
          const dbPrincipal = verifyResult.rows[0].loan_amount;
          console.log(`     ✓ DB verified: due_date=${dbDueDate}, principal=$${dbPrincipal}`);
        }
      } catch (err) {
        errors++;
        console.error(`  ❌ Loan ${loan.id}: ${err.message}`);
      }
    }

    console.log('\n' + '='.repeat(70));
    console.log('📋 MIGRATION STARTUP SUMMARY');
    console.log('='.repeat(70));
    console.log(`✅ Loans Capitalized: ${capitalized}`);
    console.log(`❌ Errors: ${errors}`);
    console.log('='.repeat(70) + '\n');

    return {
      loansCapitalized: capitalized,
      loansProcessed: loansToCapitalize.length,
      errors: errors,
      success: errors === 0,
      message: `Capitalized ${capitalized}/${loansToCapitalize.length} loans`
    };
  } catch (err) {
    console.error('❌ MIGRATION STARTUP ERROR:', err.message);
    console.log('='.repeat(70) + '\n');
    return {
      loansCapitalized: 0,
      success: false,
      error: err.message,
      message: 'Migration failed - server continuing anyway'
    };
  }
}

module.exports = { runMigrationOnStartup };
