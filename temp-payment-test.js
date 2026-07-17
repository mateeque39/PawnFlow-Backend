const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });

(async () => {
  try {
    const loans = await pool.query(
      "SELECT id, customer_id, transaction_number, due_date, loan_amount, interest_amount, remaining_balance, status, interest_paid_this_cycle, extended_this_cycle FROM loans WHERE status = 'active' ORDER BY due_date LIMIT 5"
    );
    console.log('FOUND_LOANS', loans.rows.length);
    console.log(JSON.stringify(loans.rows, null, 2));

    if (loans.rows.length === 0) {
      console.log('NO_ACTIVE_LOANS_FOUND');
      return;
    }

    const loan = loans.rows[0];
    console.log('TEST_LOAN', JSON.stringify(loan, null, 2));

    const { processPaymentWithAutoExtend } = require('./payment-utils');
    const payment = 100;
    const result = processPaymentWithAutoExtend(loan, payment, new Date());
    console.log('AUTO_EXTEND_RESULT', JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('ERROR', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
