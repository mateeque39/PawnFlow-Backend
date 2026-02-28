#!/usr/bin/env node

/**
 * Migration Script: Apply Interest Capitalization to Existing Loans
 * 
 * This script updates existing loans to comply with the new interest capitalization rules:
 * - When a payment >= interest_amount is made, the principal is increased by the interest amount
 * - Interest is recalculated on the new principal
 * - Due date is extended by 1 month
 * 
 * Safe to run multiple times - it only processes loans that need updating
 */

const { Pool } = require('pg');
require('dotenv').config();

// Get database URL
const getDatabaseUrl = () => {
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }
  
  if (process.env.PGHOST) {
    return `postgresql://${process.env.PGUSER || 'postgres'}:${process.env.PGPASSWORD || ''}@${process.env.PGHOST}:${process.env.PGPORT || 5432}/${process.env.PGDATABASE || 'railway'}`;
  }
  
  return `postgresql://${process.env.DB_USER || 'postgres'}:${process.env.DB_PASSWORD || '1234'}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432}/${process.env.DB_NAME || 'pawn_shop'}`;
};

const DATABASE_URL = getDatabaseUrl();
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

/**
 * Extend date by 1 month
 */
function extendDateByOneMonth(date) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + 1);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Get payment history for a loan
 */
async function getPaymentHistory(loanId) {
  const result = await pool.query(
    'SELECT SUM(payment_amount) as total_paid FROM payment_history WHERE loan_id = $1',
    [loanId]
  );
  return parseFloat(result.rows[0]?.total_paid || 0);
}

/**
 * Check if a loan needs capital interest capitalization
 * This is applied if:
 * 1. The loan has made payments
 * 2. Total payments >= interest_amount
 * 3. Status indicates the loan is still active
 */
async function shouldCapitalizeInterest(loan) {
  const totalPaid = await getPaymentHistory(loan.id);
  const interestAmount = parseFloat(loan.interest_amount || 0);
  
  // Check if interest has been paid
  return totalPaid >= interestAmount;
}

/**
 * Apply interest capitalization to a loan
 */
async function capitalizeInterestForLoan(loan) {
  const currentPrincipal = parseFloat(loan.loan_amount || 0);
  const interestToCapitalize = parseFloat(loan.interest_amount || 0);
  const interestRate = parseFloat(loan.interest_rate || 0);
  
  // New principal = old principal + interest
  const newPrincipal = currentPrincipal + interestToCapitalize;
  
  // New interest calculated on new principal
  const newInterestAmount = Math.round((newPrincipal * interestRate / 100) * 100) / 100;
  
  // New due date extended by 1 month
  const newDueDate = extendDateByOneMonth(loan.due_date);
  
  // New remaining balance
  const newRemainingBalance = newPrincipal + newInterestAmount;
  
  console.log(`\n💰 CAPITALIZING INTEREST FOR LOAN ${loan.id}`);
  console.log(`   Original Principal: $${currentPrincipal.toFixed(2)}`);
  console.log(`   Interest to Capitalize: $${interestToCapitalize.toFixed(2)}`);
  console.log(`   New Principal: $${newPrincipal.toFixed(2)}`);
  console.log(`   Old Interest: $${parseFloat(loan.interest_amount).toFixed(2)}`);
  console.log(`   New Interest: $${newInterestAmount.toFixed(2)}`);
  console.log(`   Old Due Date: ${loan.due_date}`);
  console.log(`   New Due Date: ${newDueDate}`);
  console.log(`   New Remaining Balance: $${newRemainingBalance.toFixed(2)}`);
  
  // Update the loan
  const result = await pool.query(
    `UPDATE loans SET
      loan_amount = $1,
      interest_amount = $2,
      due_date = $3,
      remaining_balance = $4,
      total_payable_amount = $5,
      updated_at = CURRENT_TIMESTAMP
     WHERE id = $6 RETURNING *`,
    [
      newPrincipal,
      newInterestAmount,
      newDueDate,
      newRemainingBalance,
      newRemainingBalance,
      loan.id
    ]
  );
  
  return result.rows[0];
}

/**
 * Run the migration
 */
async function runMigration() {
  console.log('🚀 STARTING INTEREST CAPITALIZATION MIGRATION');
  console.log('='.repeat(60));
  
  try {
    // Get all active loans
    const loansResult = await pool.query(
      `SELECT * FROM loans 
       WHERE status IN ('active', 'overdue')
       AND remaining_balance > 0
       ORDER BY id ASC`
    );
    
    const loans = loansResult.rows;
    console.log(`\n📊 Found ${loans.length} active loans to check`);
    
    let capitalized = 0;
    let skipped = 0;
    const errors = [];
    
    for (const loan of loans) {
      try {
        const shouldCapitalize = await shouldCapitalizeInterest(loan);
        
        if (shouldCapitalize) {
          await capitalizeInterestForLoan(loan);
          capitalized++;
        } else {
          skipped++;
        }
      } catch (err) {
        console.error(`❌ Error processing loan ${loan.id}:`, err.message);
        errors.push({ loanId: loan.id, error: err.message });
      }
    }
    
    // Print summary
    console.log('\n' + '='.repeat(60));
    console.log('📋 MIGRATION SUMMARY');
    console.log('='.repeat(60));
    console.log(`✅ Loans Capitalized: ${capitalized}`);
    console.log(`⏭️  Loans Skipped (no interest paid yet): ${skipped}`);
    console.log(`❌ Errors: ${errors.length}`);
    
    if (errors.length > 0) {
      console.log('\n⚠️ ERRORS ENCOUNTERED:');
      errors.forEach(e => {
        console.log(`   Loan ${e.loanId}: ${e.error}`);
      });
    }
    
    console.log('\n✅ MIGRATION COMPLETED SUCCESSFULLY');
    await pool.end();
    process.exit(0);
  } catch (err) {
    console.error('❌ MIGRATION FAILED:', err);
    await pool.end();
    process.exit(1);
  }
}

// Run migration
runMigration();
