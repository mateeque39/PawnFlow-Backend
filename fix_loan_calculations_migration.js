/**
 * Run Loan Calculation Fix Migration
 * This script applies the fix_loan_calculations migration to update all existing loans
 * 
 * Usage: node fix_loan_calculations_migration.js
 */

const { Pool } = require('pg');
require('dotenv').config();

// Create database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:1234@localhost:5432/pawn_shop',
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function runMigration() {
  const client = await pool.connect();
  
  try {
    console.log('???? Starting loan calculation fix migration...\n');
    
    // Start transaction
    await client.query('BEGIN');
    console.log('??? Transaction started');

    // Step 1: Create temporary column
    await client.query(`
      ALTER TABLE loans 
      ADD COLUMN IF NOT EXISTS total_payable_amount_new DECIMAL(10, 2);
    `);
    console.log('??? Created temporary column: total_payable_amount_new');

    // Step 2: Calculate correct total_payable_amount
    const updateResult = await client.query(`
      UPDATE loans
      SET total_payable_amount_new = 
        loan_amount + 
        COALESCE(interest_amount, 0) + 
        COALESCE(recurring_fee, 0)
      WHERE total_payable_amount_new IS NULL;
    `);
    console.log(`??? Calculated new total_payable_amount for ${updateResult.rowCount} loans`);

    // Step 3: Get payment totals for each loan
    const paymentTotals = await client.query(`
      SELECT 
        loan_id,
        COALESCE(SUM(payment_amount), 0) as total_paid
      FROM payment_history
      GROUP BY loan_id;
    `);
    console.log(`??? Calculated payment totals for ${paymentTotals.rowCount} loans`);

    // Step 4: Update remaining_balance for active loans
    const remainingUpdate = await client.query(`
      UPDATE loans l
      SET remaining_balance = 
        GREATEST(
          0,
          COALESCE(l.total_payable_amount_new, 0) - 
          COALESCE((
            SELECT COALESCE(SUM(payment_amount), 0) 
            FROM payment_history 
            WHERE loan_id = l.id
          ), 0)
        )
      WHERE status != 'redeemed';
    `);
    console.log(`??? Updated remaining_balance for ${remainingUpdate.rowCount} active loans`);

    // Step 5: Set remaining balance to 0 for redeemed loans
    const redeemedUpdate = await client.query(`
      UPDATE loans
      SET remaining_balance = 0
      WHERE status = 'redeemed';
    `);
    console.log(`??? Set remaining_balance to 0 for ${redeemedUpdate.rowCount} redeemed loans`);

    // Step 6: Replace old with new
    const swapResult = await client.query(`
      UPDATE loans
      SET total_payable_amount = total_payable_amount_new
      WHERE total_payable_amount_new IS NOT NULL;
    `);
    console.log(`??? Updated total_payable_amount for ${swapResult.rowCount} loans`);

    // Step 7: Drop temporary column
    await client.query(`
      ALTER TABLE loans
      DROP COLUMN IF EXISTS total_payable_amount_new;
    `);
    console.log('??? Cleaned up temporary column');

    // Step 8: Show sample results
    const sampleLoans = await client.query(`
      SELECT 
        id,
        customer_name,
        loan_amount,
        interest_amount,
        COALESCE(recurring_fee, 0) as recurring_fee,
        total_payable_amount,
        remaining_balance,
        status,
        (SELECT COALESCE(SUM(payment_amount), 0) FROM payment_history WHERE loan_id = loans.id) as total_paid
      FROM loans
      ORDER BY id DESC
      LIMIT 5;
    `);
    
    console.log('\n???? Sample of updated loans (last 5):');
    console.log('???'.repeat(120));
    console.log('ID  | Customer Name        | Loan Amount | Interest | Fee    | Total Payable | Remaining | Paid    | Status');
    console.log('???'.repeat(120));
    
    sampleLoans.rows.forEach(loan => {
      console.log(
        `${String(loan.id).padEnd(3)} | ${String(loan.customer_name || 'N/A').padEnd(20)} | ` +
        `$${String(loan.loan_amount).padEnd(10)} | $${String(loan.interest_amount || 0).padEnd(7)} | ` +
        `$${String(loan.recurring_fee).padEnd(5)} | $${String(loan.total_payable_amount).padEnd(12)} | ` +
        `$${String(loan.remaining_balance).padEnd(8)} | $${String(loan.total_paid).padEnd(6)} | ${loan.status}`
      );
    });
    console.log('???'.repeat(120));

    // Step 9: Get statistics
    const stats = await client.query(`
      SELECT 
        COUNT(*) as total_loans,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active_loans,
        SUM(CASE WHEN status = 'redeemed' THEN 1 ELSE 0 END) as redeemed_loans,
        SUM(CASE WHEN status = 'overdue' THEN 1 ELSE 0 END) as overdue_loans,
        SUM(CASE WHEN status = 'forfeited' THEN 1 ELSE 0 END) as forfeited_loans,
        SUM(total_payable_amount) as total_payable_sum,
        SUM(remaining_balance) as total_remaining_sum
      FROM loans;
    `);

    console.log('\n???? Migration Statistics:');
    const stat = stats.rows[0];
    console.log(`   Total loans: ${stat.total_loans}`);
    console.log(`   Active: ${stat.active_loans} | Redeemed: ${stat.redeemed_loans} | Overdue: ${stat.overdue_loans} | Forfeited: ${stat.forfeited_loans}`);
    console.log(`   Total payable amount across all loans: $${parseFloat(stat.total_payable_sum || 0).toFixed(2)}`);
    console.log(`   Total remaining balance: $${parseFloat(stat.total_remaining_sum || 0).toFixed(2)}`);

    // Commit transaction
    await client.query('COMMIT');
    console.log('\n??? Migration completed successfully!');

  } catch (error) {
    // Rollback on error
    await client.query('ROLLBACK');
    console.error('\n??? Migration failed! All changes rolled back.');
    console.error('Error:', error.message);
    console.error(error);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
    process.exit(0);
  }
}

// Run the migration
runMigration().catch(error => {
  console.error('Unexpected error:', error);
  process.exit(1);
});
