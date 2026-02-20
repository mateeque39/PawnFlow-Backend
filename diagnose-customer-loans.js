const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:JRBSJwVnsLaJGxzSFpgrCRlkFsAXmuxQ@switchyard.proxy.rlwy.net:15201/railway'
});

async function diagnose() {
  try {
    console.log('\n=== DIAGNOSTIC REPORT FOR CUSTOMER ID 6 ===\n');

    // Check if customer exists
    const customerResult = await pool.query(
      'SELECT * FROM customers WHERE id = 6'
    );

    if (customerResult.rows.length === 0) {
      console.log('❌ Customer ID 6 NOT found in database');
    } else {
      console.log('✅ Customer ID 6 found:');
      console.log(`   Name: ${customerResult.rows[0].first_name} ${customerResult.rows[0].last_name}`);
      console.log(`   Email: ${customerResult.rows[0].email}`);
      console.log(`   Phone: ${customerResult.rows[0].mobile_phone}`);
    }

    // Check ALL loans for customer 6
    const allLoans = await pool.query(
      'SELECT id, customer_id, customer_name, status, loan_amount, due_date, loan_issued_date FROM loans WHERE customer_id = 6 ORDER BY loan_issued_date DESC LIMIT 10'
    );

    console.log(`\n📊 Total loans for customer 6: ${allLoans.rows.length}`);
    if (allLoans.rows.length === 0) {
      console.log('   ⚠️  NO LOANS FOUND!');
    } else {
      console.log('\n   Recent loans:');
      allLoans.rows.forEach(loan => {
        console.log(`   - Loan ${loan.id}: $${loan.loan_amount} | Status: ${loan.status} | Due: ${loan.due_date} | Issued: ${loan.loan_issued_date}`);
      });
    }

    // Count by status
    const byStatus = await pool.query(
      `SELECT status, COUNT(*) as count FROM loans WHERE customer_id = 6 GROUP BY status`
    );

    console.log('\n📈 Loans by status:');
    byStatus.rows.forEach(row => {
      console.log(`   - ${row.status}: ${row.count}`);
    });

    // Check for active loans PAST due date
    const pastDueActive = await pool.query(
      `SELECT id, customer_name, loan_amount, status, due_date FROM loans WHERE customer_id = 6 AND status = 'active' AND due_date < CURRENT_DATE`
    );

    console.log(`\n⏰ Active loans PAST due date: ${pastDueActive.rows.length}`);
    if (pastDueActive.rows.length > 0) {
      pastDueActive.rows.forEach(loan => {
        console.log(`   - Loan ${loan.id}: Due ${loan.due_date} (${loan.status})`);
      });
    }

    // Check total loans in database for reference
    const totalLoans = await pool.query(
      `SELECT COUNT(*) as count FROM loans`
    );

    console.log(`\n📊 Total loans in database: ${totalLoans.rows[0].count}`);

    // Show today's date for reference
    const dateResult = await pool.query('SELECT CURRENT_DATE as today');
    console.log(`📅 Today's date (server): ${dateResult.rows[0].today}`);

    console.log('\n=== END DIAGNOSTIC REPORT ===\n');

  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await pool.end();
  }
}

diagnose();
