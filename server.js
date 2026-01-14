const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const { Pool } = require('pg');
const validators = require('./validators');
// const { generateLoanPDF } = require('./pdf-invoice-generator'); // PDF generation moved to frontend
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cors({
  origin: ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:5000'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: '*'
}));

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:1234@localhost:5432/pawn_shop',
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

const cron = require('node-cron');

// This cron job will run every day at midnight (00:00)
cron.schedule('0 0 * * *', async () => {  
  try {
    const result = await pool.query(
      'SELECT * FROM loans WHERE due_date <= CURRENT_DATE AND status = $1',
      ['active']
    );

    const loansDue = result.rows;

    for (let loan of loansDue) {
      const paymentResult = await pool.query(
        'SELECT SUM(payment_amount) AS total_paid FROM payment_history WHERE loan_id = $1',
        [loan.id]
      );
      const totalPaid = paymentResult.rows[0].total_paid || 0;

      if (totalPaid >= loan.interest_amount) {
        // Extend the due date by 30 days if interest is paid
        const extendedDueDate = new Date(loan.due_date);
        extendedDueDate.setDate(extendedDueDate.getDate() + 30);  // Extend by 30 days

        await pool.query(
          'UPDATE loans SET due_date = $1 WHERE id = $2 RETURNING *',
          [extendedDueDate.toISOString().slice(0, 10), loan.id]
        );
      } else {
        // If interest is not paid, mark the loan as overdue
        await pool.query(
          'UPDATE loans SET status = $1 WHERE id = $2 RETURNING *',
          ['overdue', loan.id]
        );
      }
    }
  } catch (err) {
    console.error('Error checking due date:', err);
  }
});




// ---------------------------- REGISTER ----------------------------
app.post('/register', async (req, res) => {
  const { username, password, role } = req.body;

  try {
    const hashedPassword = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO users (username, password, role_id) 
       VALUES ($1, $2, (SELECT id FROM user_roles WHERE role_name = $3))
       RETURNING *`,
      [username, hashedPassword, role]
    );

    res.status(201).json({ message: 'User created successfully', user: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error creating user' });
  }
});

// ---------------------------- LOGIN ----------------------------
app.post('/login', async (req, res) => {
  const { username, password } = req.body;

  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);

    const user = result.rows[0];
    if (!user) return res.status(400).json({ message: 'Invalid credentials' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ message: 'Invalid credentials' });

    const token = jwt.sign({ id: user.id, role: user.role_id }, 'jwt_secret', { expiresIn: '1h' });

    res.json({ token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error logging in' });
  }
});

// ---------------------------- EXTEND LOAN DUE DATE ----------------------------
app.post('/extend-loan', async (req, res) => {
  const { loanId } = req.body;

  try {
    // Fetch the loan details
    const loanResult = await pool.query('SELECT * FROM loans WHERE id = $1', [loanId]);
    const loan = loanResult.rows[0];

    if (!loan) {
      return res.status(404).json({ message: 'Loan not found' });
    }

    const currentDate = new Date();
    const dueDate = new Date(loan.due_date);

    // Check if due date has passed
    if (currentDate > dueDate) {
      // Check if at least interest amount has been paid
      const paymentResult = await pool.query(
        'SELECT SUM(payment_amount) AS total_paid FROM payment_history WHERE loan_id = $1',
        [loanId]
      );
      const totalPaid = paymentResult.rows[0].total_paid || 0;

      if (totalPaid >= loan.interest_amount) {
        // Extend the due date by 30 days and add new interest
        dueDate.setDate(dueDate.getDate() + 30);

        // Update the loan with the new due date
        const updateQuery = `
          UPDATE loans
          SET due_date = $1
          WHERE id = $2
          RETURNING *;
        `;
        const updatedLoan = await pool.query(updateQuery, [dueDate, loanId]);

        res.status(200).json({
          message: 'Loan extended by 30 days!',
          loan: updatedLoan.rows[0],
        });
      } else {
        res.status(400).json({ message: 'Interest not paid, cannot extend loan.' });
      }
    } else {
      res.status(400).json({ message: 'Due date has not passed, no need to extend.' });
    }
  } catch (err) {
    console.error('Error extending loan:', err);
    res.status(500).json({ message: 'Error extending loan' });
  }
});



// ---------------------------- ADD MONEY TO LOAN ----------------------------
app.post('/add-money', async (req, res) => {
  const { loanId, amount } = req.body;

  try {
    // Get current loan details
    const loanResult = await pool.query('SELECT * FROM loans WHERE id = $1', [loanId]);
    const loan = loanResult.rows[0];

    if (!loan) {
      return res.status(404).json({ message: 'Loan not found' });
    }

    // Get total payments made so far
    const paymentsResult = await pool.query(
      'SELECT SUM(payment_amount) AS total_paid FROM payment_history WHERE loan_id = $1',
      [loanId]
    );
    const totalPaid = paymentsResult.rows[0].total_paid || 0;

    // Update loan amount, recalculate interest, and total payable amount
    const newLoanAmount = parseFloat(loan.loan_amount) + parseFloat(amount);
    const newInterestAmount = (newLoanAmount * parseFloat(loan.interest_rate)) / 100;
    const newTotalPayableAmount = newLoanAmount + newInterestAmount;
    const newRemainingBalance = newTotalPayableAmount - totalPaid;

    // Update loan details in the database
    const updateLoanResult = await pool.query(
      'UPDATE loans SET loan_amount = $1, interest_amount = $2, total_payable_amount = $3, remaining_balance = $4 WHERE id = $5 RETURNING *',
      [
        newLoanAmount,
        newInterestAmount,
        newTotalPayableAmount,
        newRemainingBalance,
        loanId
      ]
    );

    res.status(200).json({
      message: 'Money added successfully and loan recalculated',
      loan: updateLoanResult.rows[0],
    });
  } catch (err) {
    console.error('Error adding money:', err);
    res.status(500).json({ message: 'Error adding money to the loan' });
  }
});



// ---------------------------- CHECK DUE DATE ----------------------------

app.post('/check-due-date', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM loans WHERE due_date <= CURRENT_DATE AND status = $1',
      ['active']
    );

    const loansDue = result.rows;

    for (let loan of loansDue) {
      const paymentResult = await pool.query(
        'SELECT SUM(payment_amount) AS total_paid FROM payment_history WHERE loan_id = $1',
        [loan.id]
      );
      const totalPaid = paymentResult.rows[0].total_paid || 0;

      if (totalPaid >= loan.interest_amount) {
        // If interest is paid, extend due date by 30 days
        const extendedDueDate = new Date(loan.due_date);
        extendedDueDate.setDate(extendedDueDate.getDate() + 30);

        await pool.query(
          'UPDATE loans SET due_date = $1 WHERE id = $2 RETURNING *',
          [extendedDueDate.toISOString().slice(0, 10), loan.id]
        );
      } else {
        // If interest is not paid, mark the loan as overdue
        await pool.query(
          'UPDATE loans SET status = $1 WHERE id = $2 RETURNING *',
          ['overdue', loan.id]
        );
      }
    }

    res.status(200).json({ message: 'Due date check completed successfully' });
  } catch (err) {
    console.error('Error checking due date:', err);
    res.status(500).json({ message: 'Error checking due date' });
  }
});

// ---------------------------- PAYMENT HISTORY ----------------------------

// ---------------------------- PAYMENT HISTORY ----------------------------
// ---------------------------- PAYMENT HISTORY ----------------------------
app.get('/payment-history', async (req, res) => {
  const { loanId } = req.query;  // Expect loanId as a query parameter

  try {
    // Check if loanId is provided
    if (!loanId || loanId.trim() === '') {
      return res.status(400).json({ message: 'Loan ID is required' });
    }

    // Validate that loanId is a valid number
    const parsedLoanId = parseInt(loanId, 10);
    if (isNaN(parsedLoanId)) {
      return res.status(400).json({ message: 'Loan ID must be a valid number' });
    }

    // Query the payment history for the specified loan
    const result = await pool.query(
      'SELECT * FROM payment_history WHERE loan_id = $1 ORDER BY payment_date DESC',
      [parsedLoanId]
    );

    // If no payments found, return an empty array instead of throwing a 404 error
    if (result.rows.length === 0) {
      return res.json([]);  // Return an empty array
    }

    // Return the payment history
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching payment history:', err);
    res.status(500).json({ message: 'Error fetching payment history', error: err.message });
  }
});








// ---------------------------- CREATE LOAN ----------------------------
app.post('/create-loan', async (req, res) => {
  try {
    // Map request body (handles both camelCase and snake_case)
    const mapped = validators.mapRequestToDb(req.body);

    // Extract all customer and loan fields
    const {
      first_name,
      last_name,
      email,
      home_phone,
      mobile_phone,
      birthdate,
      id_type,
      id_number,
      referral,
      identification_info,
      street_address,
      city,
      state,
      zipcode,
      customer_number,
      loan_amount: loanAmount,
      interest_rate: interestRate,
      interest_amount: inputInterestAmount,
      total_payable_amount: inputTotalPayableAmount,
      item_category,
      item_description,
      collateral_description,
      collateral_image,
      customer_note,
      loan_issued_date: loanIssuedDate,
      due_date: inputDueDate,
      loan_term: loanTerm,
      transaction_number: inputTransactionNumber,
      previous_loan_amount: previousLoanAmount,
      user_id: userId,
      created_by_user_id: createdByUserId,
      created_by_username: createdByUsername,
    } = mapped;

    // Validate required customer fields
    const nameValidation = validators.validateNames(first_name, last_name);
    if (!nameValidation.valid) {
      return res.status(400).json({ message: nameValidation.error });
    }

    // Validate loan amounts
    const amountValidation = validators.validateLoanAmounts(loanAmount, interestRate, loanTerm);
    if (!amountValidation.valid) {
      return res.status(400).json({ message: amountValidation.error });
    }

    // Validate optional customer fields
    const customerFieldsValidation = validators.validateCustomerFields({
      email,
      home_phone,
      mobile_phone,
      birthdate,
      loan_issued_date: loanIssuedDate,
      due_date: inputDueDate,
    });

    if (!customerFieldsValidation.valid) {
      return res.status(400).json({ 
        message: 'Validation failed', 
        errors: customerFieldsValidation.errors 
      });
    }

    // Calculate loan totals
    const totalLoanAmount = parseFloat(previousLoanAmount || 0) + parseFloat(loanAmount);
    const calculatedInterestAmount = parseFloat(inputInterestAmount) || 
      (totalLoanAmount * parseFloat(interestRate)) / 100;
    const calculatedTotalPayableAmount = parseFloat(inputTotalPayableAmount) || 
      (totalLoanAmount + calculatedInterestAmount);

    // Calculate or use provided due date
    let dueDate;
    if (inputDueDate) {
      dueDate = inputDueDate;
    } else {
      const issued = new Date(loanIssuedDate || new Date());
      const due = new Date(issued);
      due.setDate(due.getDate() + parseInt(loanTerm));
      dueDate = due.toISOString().slice(0, 10);
    }

    // Generate or use provided transaction number
    const transactionNumber = inputTransactionNumber || Math.floor(Math.random() * 1000000000).toString();

    // Insert loan with all new customer fields
    const result = await pool.query(
      `INSERT INTO loans (
        first_name, last_name, email, home_phone, mobile_phone, birthdate,
        id_type, id_number, referral, identification_info, street_address, city, state, zipcode,
        customer_number, loan_amount, interest_rate, interest_amount, total_payable_amount, recurring_fee,
        item_category, item_description, collateral_description, collateral_image, customer_note, transaction_number,
        loan_issued_date, loan_term, due_date,
        status, remaining_balance, created_by, created_by_user_id, created_by_username, customer_name
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35)
      RETURNING *`,
      [
        first_name,
        last_name,
        email || null,
        home_phone || null,
        mobile_phone || null,
        birthdate || null,
        id_type || null,
        id_number || null,
        referral || null,
        identification_info || null,
        street_address || null,
        city || null,
        state || null,
        zipcode || null,
        customer_number || null,
        totalLoanAmount,
        interestRate,
        calculatedInterestAmount,
        calculatedTotalPayableAmount,
        calculatedRecurringFee,
        item_category || null,
        item_description || null,
        collateral_description || null,
        collateral_image || null,
        customer_note || null,
        transactionNumber,
        loanIssuedDate || new Date().toISOString().slice(0, 10),
        loanTerm,
        dueDate,
        'active',
        calculatedTotalPayableAmount,
        userId || createdByUserId || null,
        createdByUserId || userId || null,
        createdByUsername || null,
        `${first_name} ${last_name}` // Backward compatibility
      ]
    );

    const loan = validators.formatLoanResponse(result.rows[0]);

    res.status(201).json({ 
      loan,
      pdf_url: `/loan-pdf/${result.rows[0].id}`
    });
  } catch (err) {
    console.error('Error creating loan:', err);
    res.status(500).json({ message: 'Error creating loan', error: err.message });
  }
});



// ---------------------------- SEARCH LOAN ----------------------------
app.get('/search-loan', async (req, res) => {
  try {
    // Accept both camelCase and snake_case query parameters
    const firstName = req.query.firstName || req.query.first_name;
    const lastName = req.query.lastName || req.query.last_name;
    const customerNumber = req.query.customerNumber || req.query.customer_number;
    const email = req.query.email;
    const transactionNumber = req.query.transactionNumber || req.query.transaction_number;
    const mobilePhone = req.query.mobilePhone || req.query.mobile_phone;
    const homePhone = req.query.homePhone || req.query.home_phone;
    const customerName = req.query.customerName || req.query.customer_name;
    const city = req.query.city;
    const state = req.query.state;
    const zipcode = req.query.zipcode;

    // Build dynamic query
    let query = 'SELECT * FROM loans WHERE 1=1';
    const params = [];
    let paramIndex = 1;

    // Search by first name
    if (firstName) {
      params.push(`%${firstName}%`);
      query += ` AND first_name ILIKE $${paramIndex}`;
      paramIndex++;
    }

    // Search by last name
    if (lastName) {
      params.push(`%${lastName}%`);
      query += ` AND last_name ILIKE $${paramIndex}`;
      paramIndex++;
    }

    // Search by customer number
    if (customerNumber) {
      params.push(`%${customerNumber}%`);
      query += ` AND customer_number ILIKE $${paramIndex}`;
      paramIndex++;
    }

    // Search by email
    if (email) {
      params.push(`%${email}%`);
      query += ` AND email ILIKE $${paramIndex}`;
      paramIndex++;
    }

    // Search by transaction number (exact match)
    if (transactionNumber) {
      params.push(transactionNumber);
      query += ` AND transaction_number = $${paramIndex}`;
      paramIndex++;
    }

    // Search by mobile phone
    if (mobilePhone) {
      params.push(`%${mobilePhone}%`);
      query += ` AND mobile_phone ILIKE $${paramIndex}`;
      paramIndex++;
    }

    // Search by home phone
    if (homePhone) {
      params.push(`%${homePhone}%`);
      query += ` AND home_phone ILIKE $${paramIndex}`;
      paramIndex++;
    }

    // Search by city
    if (city) {
      params.push(`%${city}%`);
      query += ` AND city ILIKE $${paramIndex}`;
      paramIndex++;
    }

    // Search by state
    if (state) {
      params.push(`%${state}%`);
      query += ` AND state ILIKE $${paramIndex}`;
      paramIndex++;
    }

    // Search by zipcode
    if (zipcode) {
      params.push(`%${zipcode}%`);
      query += ` AND zipcode ILIKE $${paramIndex}`;
      paramIndex++;
    }

    // Fallback: search by full customer_name (backward compatibility)
    if (customerName && !firstName && !lastName) {
      params.push(`%${customerName}%`);
      query += ` AND customer_name ILIKE $${paramIndex}`;
      paramIndex++;
    }

    // If no search criteria provided, return error
    if (params.length === 0) {
      return res.status(400).json({ message: 'At least one search criteria is required' });
    }

    // Execute query
    const result = await pool.query(query, params);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'No loans found' });
    }

    // Format response with snake_case fields and add PDF links
    const formattedLoans = result.rows.map(loan => ({
      ...validators.formatLoanResponse(loan),
      pdf_url: `/loan-pdf/${loan.id}`
    }));

    res.json(formattedLoans);
  } catch (err) {
    console.error('Error searching loans:', err);
    res.status(500).json({ message: 'Error searching loans', error: err.message });
  }
});


// ---------------------------- MAKE PAYMENT ----------------------------
app.post('/make-payment', async (req, res) => {
  const { loanId, paymentMethod, paymentAmount, userId } = req.body;

  try {
    // Fetch the loan details
    const loanResult = await pool.query('SELECT * FROM loans WHERE id = $1', [loanId]);
    const loan = loanResult.rows[0];

    if (!loan) {
      return res.status(404).json({ message: 'Loan not found' });
    }

    // Update remaining balance after payment
    const newRemainingBalance = parseFloat(loan.remaining_balance) - parseFloat(paymentAmount);

    // Update the loan details with the new remaining balance
    const updatedLoanResult = await pool.query(
      'UPDATE loans SET remaining_balance = $1 WHERE id = $2 RETURNING *',
      [Math.max(newRemainingBalance, 0), loanId]  // Ensure it doesn't go negative
    );

    // Insert payment history
    const paymentResult = await pool.query(
      'INSERT INTO payment_history (loan_id, payment_method, payment_amount, payment_date, created_by) VALUES ($1, $2, $3, CURRENT_TIMESTAMP, $4) RETURNING *',
      [loanId, paymentMethod, paymentAmount, userId || null]
    );

    // Recalculate total payable amount (loan amount + interest)
    const newTotalPayableAmount = parseFloat(loan.loan_amount) + (parseFloat(loan.loan_amount) * parseFloat(loan.interest_rate) / 100);

    // Update total payable amount in the loan record
    await pool.query(
      'UPDATE loans SET total_payable_amount = $1 WHERE id = $2',
      [newTotalPayableAmount, loanId]
    );

    // Check if the loan is fully paid
    if (newRemainingBalance === 0) {
      res.status(200).json({
        message: 'Loan fully paid off! Ready for redemption.',
        loan: updatedLoanResult.rows[0],
        paymentHistory: paymentResult.rows[0],
      });
    } else {
      // If not fully paid, return the updated loan and payment details
      res.status(200).json({
        message: 'Payment successfully processed!',
        loan: updatedLoanResult.rows[0],
        paymentHistory: paymentResult.rows[0],
      });
    }
  } catch (err) {
    console.error('Error making payment:', err);
    res.status(500).json({ message: 'Error making payment' });
  }
});






// ---------------------------- REDEEM LOAN ----------------------------


app.post('/redeem-loan', async (req, res) => {
  const { loanId, userId } = req.body;

  try {
    // Get the loan details
    const loanResult = await pool.query('SELECT * FROM loans WHERE id = $1', [loanId]);
    const loan = loanResult.rows[0];

    if (!loan) {
      return res.status(404).json({ message: 'Loan not found' });
    }

    // Log loan details for debugging
    console.log('Loan found:', loan);

    // Use the remaining balance that's maintained with each payment
    const remainingBalance = parseFloat(loan.remaining_balance || 0);

    // Log remaining balance calculation for debugging
    console.log(`Remaining Balance: ${remainingBalance}`);

    // If the remaining balance is greater than 0, return an error
    if (remainingBalance > 0) {
      return res.status(400).json({ message: 'Loan is not fully paid, cannot redeem.' });
    }

    // Ensure the loan is not already redeemed
    if (loan.status === 'redeemed') {
      return res.status(400).json({ message: 'Loan has already been redeemed.' });
    }

    // Redeem the loan (update status to 'redeemed')
    const updatedLoan = await pool.query(
      'UPDATE loans SET status = $1 WHERE id = $2 RETURNING *',
      ['redeemed', loanId]
    );

    // Add to redeem history (if table exists)
    try {
      await pool.query(
        'INSERT INTO redeem_history (loan_id, redeemed_by) VALUES ($1, $2) RETURNING *',
        [loanId, userId]
      );
    } catch (historyErr) {
      console.warn('Warning: Could not insert redeem history:', historyErr.message);
      // Continue even if history insert fails - the main redeem is successful
    }

    res.status(200).json({
      message: 'Loan redeemed successfully!',
      loan: updatedLoan.rows[0],
    });
  } catch (err) {
    console.error('Error redeeming loan:', err);
    res.status(500).json({ message: 'Error redeeming loan.' });
  }
});








// ---------------------------- FORFEIT LOAN ----------------------------


// Forfeit Loan route
app.post('/forfeit-loan', async (req, res) => {
  const { loanId, userId } = req.body;

  try {
    // Check if the loan exists and if it is active
    const loanQuery = 'SELECT * FROM loans WHERE id = $1';
    const loanResult = await pool.query(loanQuery, [loanId]);
    const loan = loanResult.rows[0];

    if (!loan) {
      return res.status(404).json({ message: 'Loan not found.' });
    }

    if (loan.status === 'redeemed' || loan.status === 'forfeited') {
      return res.status(400).json({ message: 'Loan is already redeemed or forfeited.' });
    }

    // Check forfeit conditions:
    // 1. Due date must be passed (past today)
    // 2. Remaining balance must be less than interest amount OR equal to 0
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const dueDate = new Date(loan.due_date);
    dueDate.setHours(0, 0, 0, 0);
    
    const isDueDatePassed = dueDate < today;
    const remainingBalance = parseFloat(loan.remaining_balance || 0);
    const interestAmount = parseFloat(loan.interest_amount || 0);
    const isBalanceLessThanInterest = remainingBalance < interestAmount || remainingBalance === 0;
    
    if (!isDueDatePassed) {
      return res.status(400).json({ message: 'Cannot forfeit: Loan due date has not passed yet.' });
    }
    
    if (!isBalanceLessThanInterest) {
      return res.status(400).json({ message: 'Cannot forfeit: Remaining balance must be less than interest amount or zero.' });
    }

    // Update loan status to 'forfeited'
    const updateQuery = 'UPDATE loans SET status = $1 WHERE id = $2 RETURNING *';
    const updatedLoan = await pool.query(updateQuery, ['forfeited', loanId]);

    // Add to forfeit history (similar to redeem history)
    const forfeitHistoryQuery = 'INSERT INTO redeem_history (loan_id, redeemed_by) VALUES ($1, $2) RETURNING *';
    const forfeitHistory = await pool.query(forfeitHistoryQuery, [loanId, userId]);

    return res.status(200).json({
      message: 'Loan forfeited successfully!',
      loan: updatedLoan.rows[0],
      forfeitHistory: forfeitHistory.rows[0],
    });
  } catch (error) {
    console.error('Error forfeiting loan:', error);
    return res.status(500).json({ message: 'Error forfeiting loan.' });
  }
});


// ======================== LOAN REACTIVATION ========================

// REACTIVATE FORFEITED LOAN - Reactivate a forfeited loan back to active status
app.post('/loans/:loanId/reactivate', async (req, res) => {
  const { loanId } = req.params;
  const { reactivatedByUserId, reactivatedByUsername, reactivationDate } = req.body;

  try {
    // Validate loanId
    const loanIdNum = parseInt(loanId, 10);
    if (isNaN(loanIdNum)) {
      return res.status(400).json({ message: 'Invalid loan ID' });
    }

    // Fetch the loan
    const loanResult = await pool.query('SELECT * FROM loans WHERE id = $1', [loanIdNum]);
    
    if (loanResult.rows.length === 0) {
      return res.status(404).json({ message: 'Loan not found' });
    }

    const loan = loanResult.rows[0];

    // Check if loan is forfeited
    if (loan.status !== 'forfeited' && loan.status !== 'FORFEITED') {
      return res.status(400).json({ message: 'Loan is not forfeited and cannot be reactivated' });
    }

    // Update loan status to active and record reactivation metadata
    const reactivationTime = reactivationDate || new Date().toISOString();
    const updateQuery = `
      UPDATE loans 
      SET status = 'active',
          reactivated_at = $1,
          reactivated_by_user_id = $2,
          reactivated_by_username = $3
      WHERE id = $4
      RETURNING *
    `;

    const updatedLoanResult = await pool.query(updateQuery, [
      reactivationTime,
      reactivatedByUserId || null,
      reactivatedByUsername || null,
      loanIdNum
    ]);

    const updatedLoan = updatedLoanResult.rows[0];

    // Create audit log entry
    try {
      await pool.query(
        `INSERT INTO audit_log (action_type, user_id, username, loan_id, timestamp, old_values, new_values)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          'REACTIVATE_LOAN',
          reactivatedByUserId || null,
          reactivatedByUsername || null,
          loanIdNum,
          reactivationTime,
          JSON.stringify({ status: loan.status }),
          JSON.stringify({ status: 'active' })
        ]
      );
    } catch (auditErr) {
      console.warn('Failed to create audit log entry:', auditErr);
      // Don't fail the request if audit log fails
    }

    res.status(200).json({
      message: 'Loan reactivated successfully!',
      loan: validators.formatLoanResponse(updatedLoan),
      reactivationMetadata: {
        reactivatedAt: reactivationTime,
        reactivatedByUserId: reactivatedByUserId,
        reactivatedByUsername: reactivatedByUsername
      }
    });
  } catch (err) {
    console.error('Error reactivating loan:', err);
    res.status(500).json({ message: 'Error reactivating loan', error: err.message });
  }
});

// ======================== END LOAN REACTIVATION ========================

// ======================== LOAN VOID/DELETE ========================

// VOID LOAN - Delete a loan (for correcting mistakes during creation)
app.delete('/customers/:customerId/loans/:loanId/void', async (req, res) => {
  const { customerId, loanId } = req.params;
  const { voidedByUserId, voidedByUsername, voidDate } = req.body;

  try {
    // Validate IDs
    const customerIdNum = parseInt(customerId, 10);
    const loanIdNum = parseInt(loanId, 10);
    if (isNaN(customerIdNum) || isNaN(loanIdNum)) {
      return res.status(400).json({ message: 'Invalid customer ID or loan ID' });
    }

    // Verify customer exists
    const customerCheck = await pool.query(
      'SELECT * FROM customers WHERE id = $1',
      [customerIdNum]
    );
    if (customerCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Customer not found' });
    }

    // Fetch the loan
    const loanResult = await pool.query(
      'SELECT * FROM loans WHERE id = $1 AND customer_id = $2',
      [loanIdNum, customerIdNum]
    );

    if (loanResult.rows.length === 0) {
      return res.status(404).json({ message: 'Loan not found for this customer' });
    }

    const loan = loanResult.rows[0];

    // Create audit log entry before deletion
    try {
      await pool.query(
        `INSERT INTO audit_log (action_type, user_id, username, loan_id, timestamp, old_values)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          'VOID_LOAN',
          voidedByUserId || null,
          voidedByUsername || null,
          loanIdNum,
          voidDate || new Date().toISOString(),
          JSON.stringify({
            id: loan.id,
            transaction_number: loan.transaction_number,
            customer_id: loan.customer_id,
            loan_amount: loan.loan_amount,
            status: loan.status,
            created_at: loan.created_at
          })
        ]
      );
    } catch (auditErr) {
      console.warn('Failed to create audit log entry for void:', auditErr);
      // Don't fail the void operation if audit log fails
    }

    // Delete payment history for this loan first (if foreign key constraint exists)
    try {
      await pool.query(
        'DELETE FROM payment_history WHERE loan_id = $1',
        [loanIdNum]
      );
    } catch (deletePaymentErr) {
      console.warn('Warning: Could not delete payment history:', deletePaymentErr.message);
    }

    // Delete the loan
    const deleteResult = await pool.query(
      'DELETE FROM loans WHERE id = $1 AND customer_id = $2 RETURNING *',
      [loanIdNum, customerIdNum]
    );

    if (deleteResult.rows.length === 0) {
      return res.status(500).json({ message: 'Failed to delete loan' });
    }

    res.status(200).json({
      message: 'Loan voided and permanently deleted!',
      voidedLoan: {
        id: deleteResult.rows[0].id,
        transactionNumber: deleteResult.rows[0].transaction_number,
        loanAmount: deleteResult.rows[0].loan_amount,
        status: deleteResult.rows[0].status
      },
      voidMetadata: {
        voidedAt: voidDate || new Date().toISOString(),
        voidedByUserId: voidedByUserId,
        voidedByUsername: voidedByUsername
      }
    });
  } catch (err) {
    console.error('Error voiding loan:', err);
    res.status(500).json({ message: 'Error voiding loan', error: err.message });
  }
});

// ======================== END LOAN VOID/DELETE ========================

// GET CUSTOMER INFO - Retrieve customer information by transaction number
app.get('/loans/transaction/:transactionNumber', async (req, res) => {
  const { transactionNumber } = req.params;

  try {
    // Validate transactionNumber
    if (!transactionNumber || transactionNumber.trim() === '') {
      return res.status(400).json({ message: 'Transaction number is required' });
    }

    // Fetch the loan by transaction number
    const loanResult = await pool.query('SELECT * FROM loans WHERE transaction_number = $1', [transactionNumber]);

    if (loanResult.rows.length === 0) {
      return res.status(404).json({ message: 'Loan not found' });
    }

    const loan = loanResult.rows[0];

    res.json({
      id: loan.id,
      transactionNumber: loan.transaction_number,
      customerInfo: {
        firstName: loan.first_name || '',
        lastName: loan.last_name || '',
        homePhone: loan.home_phone || '',
        mobilePhone: loan.mobile_phone || '',
        email: loan.email || '',
        birthdate: loan.birthdate || '',
        referral: loan.referral || '',
        streetAddress: loan.street_address || '',
        city: loan.city || '',
        state: loan.state || '',
        zipcode: loan.zipcode || ''
      },
      loanDetails: {
        loanAmount: loan.loan_amount,
        interestRate: loan.interest_rate,
        interestAmount: loan.interest_amount,
        totalPayableAmount: loan.total_payable_amount,
        remainingBalance: loan.remaining_balance,
        status: loan.status,
        dueDate: loan.due_date,
        loanIssuedDate: loan.loan_issued_date
      }
    });
  } catch (err) {
    console.error('Error retrieving customer data:', err);
    res.status(500).json({ message: 'Error retrieving customer data', error: err.message });
  }
});

// UPDATE CUSTOMER INFO - Update customer information for a loan by transaction number
app.put('/loans/:transactionNumber/customer-info', async (req, res) => {
  const { transactionNumber } = req.params;
  const {
    firstName,
    lastName,
    homePhone,
    mobilePhone,
    email,
    birthdate,
    referral,
    streetAddress,
    city,
    state,
    zipcode,
    updatedByUserId,
    updatedByUsername,
    updatedAt
  } = req.body;

  try {
    // Validate transactionNumber
    if (!transactionNumber || transactionNumber.trim() === '') {
      return res.status(400).json({ message: 'Transaction number is required' });
    }

    // Fetch the loan by transaction number
    const loanResult = await pool.query('SELECT * FROM loans WHERE transaction_number = $1', [transactionNumber]);
    
    if (loanResult.rows.length === 0) {
      return res.status(404).json({ message: 'Loan not found' });
    }

    const loan = loanResult.rows[0];

    // Validate required fields
    if (!firstName || !lastName) {
      return res.status(400).json({ message: 'First name and last name are required' });
    }

    // Validate email format if provided
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ message: 'Invalid email format' });
    }

    // Validate birthdate format if provided
    if (birthdate && !/^\d{4}-\d{2}-\d{2}$/.test(birthdate)) {
      return res.status(400).json({ message: 'Birthdate must be in YYYY-MM-DD format' });
    }

    // Validate state format if provided (2-letter code)
    if (state && !/^[A-Z]{2}$/.test(state)) {
      return res.status(400).json({ message: 'State must be a 2-letter code' });
    }

    const updateTime = updatedAt || new Date().toISOString();

    // Build update query dynamically
    const updateQuery = `
      UPDATE loans 
      SET first_name = $1,
          last_name = $2,
          home_phone = $3,
          mobile_phone = $4,
          email = $5,
          birthdate = $6,
          referral = $7,
          street_address = $8,
          city = $9,
          state = $10,
          zipcode = $11,
          customer_name = $12,
          updated_at = $13,
          updated_by_user_id = $14,
          updated_by_username = $15
      WHERE transaction_number = $16
      RETURNING *
    `;

    const updatedCustomerName = `${firstName} ${lastName}`;

    const updatedLoanResult = await pool.query(updateQuery, [
      firstName,
      lastName,
      homePhone || null,
      mobilePhone || null,
      email || null,
      birthdate || null,
      referral || null,
      streetAddress || null,
      city || null,
      state || null,
      zipcode || null,
      updatedCustomerName,
      updateTime,
      updatedByUserId || null,
      updatedByUsername || null,
      transactionNumber
    ]);

    const updatedLoan = updatedLoanResult.rows[0];

    // Create audit log entry
    try {
      const oldValues = {
        firstName: loan.first_name,
        lastName: loan.last_name,
        homePhone: loan.home_phone,
        mobilePhone: loan.mobile_phone,
        email: loan.email,
        birthdate: loan.birthdate,
        referral: loan.referral,
        streetAddress: loan.street_address,
        city: loan.city,
        state: loan.state,
        zipcode: loan.zipcode
      };

      const newValues = {
        firstName,
        lastName,
        homePhone: homePhone || null,
        mobilePhone: mobilePhone || null,
        email: email || null,
        birthdate: birthdate || null,
        referral: referral || null,
        streetAddress: streetAddress || null,
        city: city || null,
        state: state || null,
        zipcode: zipcode || null
      };

      await pool.query(
        `INSERT INTO audit_log (action_type, user_id, username, loan_id, timestamp, old_values, new_values)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          'UPDATE_CUSTOMER_INFO',
          updatedByUserId || null,
          updatedByUsername || null,
          loan.id,
          updateTime,
          JSON.stringify(oldValues),
          JSON.stringify(newValues)
        ]
      );
    } catch (auditErr) {
      console.warn('Failed to create audit log entry:', auditErr);
      // Don't fail the request if audit log fails
    }

    res.status(200).json({
      message: 'Customer information updated successfully!',
      customerInfo: {
        firstName: updatedLoan.first_name,
        lastName: updatedLoan.last_name,
        homePhone: updatedLoan.home_phone,
        mobilePhone: updatedLoan.mobile_phone,
        email: updatedLoan.email,
        birthdate: updatedLoan.birthdate,
        referral: updatedLoan.referral,
        streetAddress: updatedLoan.street_address,
        city: updatedLoan.city,
        state: updatedLoan.state,
        zipcode: updatedLoan.zipcode
      },
      updateMetadata: {
        updatedAt: updateTime,
        updatedByUserId: updatedByUserId,
        updatedByUsername: updatedByUsername
      }
    });
  } catch (err) {
    console.error('Error updating customer information:', err);
    res.status(500).json({ message: 'Error updating customer information', error: err.message });
  }
});

// ======================== END CUSTOMER INFORMATION UPDATE ========================


// ======================== LOAN DETAILS UPDATE ========================

// UPDATE LOAN DETAILS - Update loan amount, interest rate, term, collateral, notes
app.put('/loans/:loanId', async (req, res) => {
  const { loanId } = req.params;
  const {
    loanAmount,
    interestRate,
    loanTerm,
    collateralDescription,
    customerNote,
    updatedByUserId,
    updatedByUsername
  } = req.body;

  try {
    // Validate loanId
    if (!loanId || isNaN(loanId)) {
      return res.status(400).json({ message: 'Valid loan ID is required' });
    }

    // Fetch the loan
    const loanResult = await pool.query('SELECT * FROM loans WHERE id = $1', [loanId]);
    
    if (loanResult.rows.length === 0) {
      return res.status(404).json({ message: 'Loan not found' });
    }

    const loan = loanResult.rows[0];

    // Validate required fields
    if (loanAmount === undefined || loanAmount === null || loanAmount < 0) {
      return res.status(400).json({ message: 'Valid loan amount is required' });
    }

    if (interestRate === undefined || interestRate === null || interestRate < 0) {
      return res.status(400).json({ message: 'Valid interest rate is required' });
    }

    // Calculate new interest amount and total payable
    const newLoanAmount = parseFloat(loanAmount);
    const newInterestRate = parseFloat(interestRate);
    const newInterestAmount = (newLoanAmount * newInterestRate) / 100;
    const newTotalPayableAmount = newLoanAmount + newInterestAmount;

    // Calculate new due date if loanTerm is provided
    let newDueDate = loan.due_date;
    if (loanTerm && !isNaN(loanTerm) && loanTerm > 0) {
      const issuedDate = new Date(loan.loan_issued_date);
      newDueDate = new Date(issuedDate.getTime() + parseInt(loanTerm) * 24 * 60 * 60 * 1000);
      newDueDate = newDueDate.toISOString().split('T')[0];
    }

    const updateTime = new Date().toISOString();

    // Build update query
    const updateQuery = `
      UPDATE loans 
      SET loan_amount = $1,
          interest_rate = $2,
          interest_amount = $3,
          total_payable_amount = $4,
          remaining_balance = $5,
          loan_term = $6,
          due_date = $7,
          collateral_description = $8,
          customer_note = $9,
          updated_at = $10,
          updated_by_user_id = $11,
          updated_by_username = $12
      WHERE id = $13
      RETURNING *
    `;

    const updatedLoanResult = await pool.query(updateQuery, [
      newLoanAmount,
      newInterestRate,
      newInterestAmount,
      newTotalPayableAmount,
      newTotalPayableAmount,
      loanTerm || loan.loan_term,
      newDueDate,
      collateralDescription !== undefined ? collateralDescription : loan.collateral_description,
      customerNote !== undefined ? customerNote : loan.customer_note,
      updateTime,
      updatedByUserId || null,
      updatedByUsername || null,
      loanId
    ]);

    const updatedLoan = updatedLoanResult.rows[0];

    // Create audit log entry
    try {
      const oldValues = {
        loanAmount: loan.loan_amount,
        interestRate: loan.interest_rate,
        interestAmount: loan.interest_amount,
        totalPayableAmount: loan.total_payable_amount,
        loanTerm: loan.loan_term,
        dueDate: loan.due_date,
        collateralDescription: loan.collateral_description,
        customerNote: loan.customer_note
      };

      const newValues = {
        loanAmount: newLoanAmount,
        interestRate: newInterestRate,
        interestAmount: newInterestAmount,
        totalPayableAmount: newTotalPayableAmount,
        loanTerm: loanTerm || loan.loan_term,
        dueDate: newDueDate,
        collateralDescription: collateralDescription !== undefined ? collateralDescription : loan.collateral_description,
        customerNote: customerNote !== undefined ? customerNote : loan.customer_note
      };

      await pool.query(
        `INSERT INTO audit_log (action_type, user_id, username, loan_id, timestamp, old_values, new_values)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          'UPDATE_LOAN_DETAILS',
          updatedByUserId || null,
          updatedByUsername || null,
          loanId,
          updateTime,
          JSON.stringify(oldValues),
          JSON.stringify(newValues)
        ]
      );
    } catch (auditErr) {
      console.warn('Failed to create audit log entry:', auditErr);
    }

    res.status(200).json({
      message: 'Loan details updated successfully!',
      loan: {
        id: updatedLoan.id,
        transactionNumber: updatedLoan.transaction_number,
        loanAmount: updatedLoan.loan_amount,
        interestRate: updatedLoan.interest_rate,
        interestAmount: updatedLoan.interest_amount,
        totalPayableAmount: updatedLoan.total_payable_amount,
        remainingBalance: updatedLoan.remaining_balance,
        loanTerm: updatedLoan.loan_term,
        dueDate: updatedLoan.due_date,
        collateralDescription: updatedLoan.collateral_description,
        customerNote: updatedLoan.customer_note,
        status: updatedLoan.status
      },
      updateMetadata: {
        updatedAt: updateTime,
        updatedByUserId: updatedByUserId,
        updatedByUsername: updatedByUsername
      }
    });
  } catch (err) {
    console.error('Error updating loan details:', err);
    res.status(500).json({ message: 'Error updating loan details', error: err.message });
  }
});

// ======================== END LOAN DETAILS UPDATE ========================


// ======================== CUSTOMER PROFILE MANAGEMENT ========================

// CREATE CUSTOMER PROFILE - Create a new customer profile
app.post('/customers', async (req, res) => {
  try {
    const mapped = validators.mapRequestToDb(req.body);
    
    const {
      first_name,
      last_name,
      email,
      home_phone,
      mobile_phone,
      birthdate,
      id_type,
      id_number,
      referral,
      identification_info,
      street_address,
      city,
      state,
      zipcode,
      customer_number,
      created_by_user_id,
      created_by_username
    } = mapped;

    // Validate required fields
    const nameValidation = validators.validateNames(first_name, last_name);
    if (!nameValidation.valid) {
      return res.status(400).json({ message: nameValidation.error });
    }

    // Validate optional customer fields
    const customerFieldsValidation = validators.validateCustomerFields({
      email,
      home_phone,
      mobile_phone,
      birthdate
    });

    if (!customerFieldsValidation.valid) {
      return res.status(400).json({ 
        message: 'Validation failed', 
        errors: customerFieldsValidation.errors 
      });
    }

    // Insert customer profile
    const result = await pool.query(
      `INSERT INTO customers (
        first_name, last_name, email, home_phone, mobile_phone, birthdate,
        id_type, id_number, referral, identification_info, street_address, 
        city, state, zipcode, customer_number, created_by_user_id, created_by_username
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      RETURNING *`,
      [
        first_name,
        last_name,
        email || null,
        home_phone || null,
        mobile_phone || null,
        birthdate || null,
        id_type || null,
        id_number || null,
        referral || null,
        identification_info || null,
        street_address || null,
        city || null,
        state || null,
        zipcode || null,
        customer_number || null,
        created_by_user_id || null,
        created_by_username || null
      ]
    );

    res.status(201).json({
      message: 'Customer profile created successfully',
      customer: result.rows[0]
    });
  } catch (err) {
    console.error('Error creating customer profile:', err);
    res.status(500).json({ message: 'Error creating customer profile', error: err.message });
  }
});

// GET CUSTOMER PROFILE - Search customer by phone, first name, or last name
app.get('/customers/search-phone', async (req, res) => {
  try {
    const { phone } = req.query;

    if (!phone || phone.trim() === '') {
      return res.status(400).json({ message: 'Phone number is required' });
    }

    // Remove non-numeric characters for comparison
    const cleanPhone = phone.replace(/\D/g, '');

    let query = `SELECT * FROM customers WHERE 
                 REPLACE(REPLACE(REPLACE(mobile_phone, '-', ''), '(', ''), ')', '') ILIKE $1
                 OR REPLACE(REPLACE(REPLACE(home_phone, '-', ''), '(', ''), ')', '') ILIKE $2
                 ORDER BY created_at DESC`;

    const result = await pool.query(query, [`%${cleanPhone}%`, `%${cleanPhone}%`]);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'No customers found with that phone number' });
    }

    res.json(result.rows);
  } catch (err) {
    console.error('Error searching customers by phone:', err);
    res.status(500).json({ message: 'Error searching customers', error: err.message });
  }
});

// GET CUSTOMER PROFILE - Search customer by name
app.get('/customers/search-name', async (req, res) => {
  try {
    const { firstName, lastName } = req.query;

    if (!firstName && !lastName) {
      return res.status(400).json({ message: 'At least first name or last name is required' });
    }

    let query = 'SELECT * FROM customers WHERE 1=1';
    const params = [];
    let paramIndex = 1;

    if (firstName) {
      params.push(`%${firstName}%`);
      query += ` AND first_name ILIKE $${paramIndex}`;
      paramIndex++;
    }

    if (lastName) {
      params.push(`%${lastName}%`);
      query += ` AND last_name ILIKE $${paramIndex}`;
      paramIndex++;
    }

    query += ' ORDER BY created_at DESC';

    const result = await pool.query(query, params);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'No customers found with that name' });
    }

    res.json(result.rows);
  } catch (err) {
    console.error('Error searching customers by name:', err);
    res.status(500).json({ message: 'Error searching customers', error: err.message });
  }
});

// GET CUSTOMER - Get customer by ID
app.get('/customers/:customerId', async (req, res) => {
  try {
    const { customerId } = req.params;

    const customerIdNum = parseInt(customerId, 10);
    if (isNaN(customerIdNum)) {
      return res.status(400).json({ message: 'Invalid customer ID' });
    }

    const result = await pool.query('SELECT * FROM customers WHERE id = $1', [customerIdNum]);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Customer not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error fetching customer:', err);
    res.status(500).json({ message: 'Error fetching customer', error: err.message });
  }
});

// GET CUSTOMER LOANS - Get all loans for a customer
app.get('/customers/:customerId/loans', async (req, res) => {
  try {
    const { customerId } = req.params;

    const customerIdNum = parseInt(customerId, 10);
    if (isNaN(customerIdNum)) {
      return res.status(400).json({ message: 'Invalid customer ID' });
    }

    // Verify customer exists
    const customerCheck = await pool.query('SELECT * FROM customers WHERE id = $1', [customerIdNum]);
    if (customerCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Customer not found' });
    }

    // Get active loans
    const activeLoansResult = await pool.query(
      `SELECT id, transaction_number, loan_amount, interest_rate, total_payable_amount,
              remaining_balance, due_date, loan_issued_date, status
       FROM loans
       WHERE customer_id = $1 AND status = 'active'
       ORDER BY loan_issued_date DESC`,
      [customerIdNum]
    );

    // Get redeemed loans
    const redeemedLoansResult = await pool.query(
      `SELECT id, transaction_number, loan_amount, interest_rate, interest_amount, total_payable_amount,
              remaining_balance, due_date, loan_issued_date, status
       FROM loans
       WHERE customer_id = $1 AND status = 'redeemed'
       ORDER BY loan_issued_date DESC`,
      [customerIdNum]
    );

    // Get forfeited loans
    const forfeitedLoansResult = await pool.query(
      `SELECT id, transaction_number, loan_amount, interest_rate, interest_amount, total_payable_amount,
              remaining_balance, due_date, loan_issued_date, status
       FROM loans
       WHERE customer_id = $1 AND status = 'forfeited'
       ORDER BY loan_issued_date DESC`,
      [customerIdNum]
    );

    // Get payment history
    const paymentHistoryResult = await pool.query(
      `SELECT ph.*, l.transaction_number, l.loan_amount
       FROM payment_history ph
       JOIN loans l ON ph.loan_id = l.id
       WHERE l.customer_id = $1
       ORDER BY ph.payment_date DESC`,
      [customerIdNum]
    );

    res.json({
      activeLoans: activeLoansResult.rows,
      redeemedLoans: redeemedLoansResult.rows,
      forfeitedLoans: forfeitedLoansResult.rows,
      paymentHistory: paymentHistoryResult.rows,
      summary: {
        totalActiveLoans: activeLoansResult.rows.length,
        totalRedeemedLoans: redeemedLoansResult.rows.length,
        totalForfeitedLoans: forfeitedLoansResult.rows.length,
        totalPayments: paymentHistoryResult.rows.length,
        totalOutstanding: activeLoansResult.rows.reduce((sum, loan) => sum + parseFloat(loan.remaining_balance || 0), 0)
      }
    });
  } catch (err) {
    console.error('Error fetching customer loans:', err);
    res.status(500).json({ message: 'Error fetching customer loans', error: err.message });
  }
});

// GET CUSTOMER PROFILE - Search customer by phone, first name, or last name (OLD - DEPRECATED)
app.get('/customers/search', async (req, res) => {
  try {
    const { firstName, lastName, mobilePhone, homePhone, email, customerId } = req.query;

    let query = 'SELECT * FROM customers WHERE 1=1';
    const params = [];
    let paramIndex = 1;

    if (customerId) {
      params.push(parseInt(customerId, 10));
      query += ` AND id = $${paramIndex}`;
      paramIndex++;
    }

    if (firstName) {
      params.push(`%${firstName}%`);
      query += ` AND first_name ILIKE $${paramIndex}`;
      paramIndex++;
    }

    if (lastName) {
      params.push(`%${lastName}%`);
      query += ` AND last_name ILIKE $${paramIndex}`;
      paramIndex++;
    }

    if (mobilePhone) {
      params.push(`%${mobilePhone.replace(/\D/g, '')}%`);
      query += ` AND REPLACE(REPLACE(REPLACE(mobile_phone, '-', ''), '(', ''), ')', '') ILIKE $${paramIndex}`;
      paramIndex++;
    }

    if (homePhone) {
      params.push(`%${homePhone.replace(/\D/g, '')}%`);
      query += ` AND REPLACE(REPLACE(REPLACE(home_phone, '-', ''), '(', ''), ')', '') ILIKE $${paramIndex}`;
      paramIndex++;
    }

    if (email) {
      params.push(`%${email}%`);
      query += ` AND email ILIKE $${paramIndex}`;
      paramIndex++;
    }

    if (params.length === 0) {
      return res.status(400).json({ message: 'At least one search criteria is required' });
    }

    query += ' ORDER BY created_at DESC';

    const result = await pool.query(query, params);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'No customers found' });
    }

    res.json(result.rows);
  } catch (err) {
    console.error('Error searching customers:', err);
    res.status(500).json({ message: 'Error searching customers', error: err.message });
  }
});

// GET CUSTOMER PROFILE WITH LOANS - Get customer profile and all associated loans (OLD - USE /customers/:customerId/loans instead)
app.get('/customers/:customerId/profile', async (req, res) => {
  try {
    const { customerId } = req.params;

    const customerIdNum = parseInt(customerId, 10);
    if (isNaN(customerIdNum)) {
      return res.status(400).json({ message: 'Invalid customer ID' });
    }

    // Get customer profile
    const customerResult = await pool.query(
      'SELECT * FROM customers WHERE id = $1',
      [customerIdNum]
    );

    if (customerResult.rows.length === 0) {
      return res.status(404).json({ message: 'Customer not found' });
    }

    const customer = customerResult.rows[0];

    // Get active loans
    const activeLoansResult = await pool.query(
      `SELECT id, transaction_number, loan_amount, interest_rate, total_payable_amount,
              remaining_balance, due_date, loan_issued_date, status
       FROM loans
       WHERE customer_id = $1 AND status = 'active'
       ORDER BY loan_issued_date DESC`,
      [customerIdNum]
    );

    // Get redeemed loans
    const redeemedLoansResult = await pool.query(
      `SELECT id, transaction_number, loan_amount, interest_rate, interest_amount, total_payable_amount,
              remaining_balance, due_date, loan_issued_date, status
       FROM loans
       WHERE customer_id = $1 AND status = 'redeemed'
       ORDER BY loan_issued_date DESC`,
      [customerIdNum]
    );

    // Get forfeited loans
    const forfeitedLoansResult = await pool.query(
      `SELECT id, transaction_number, loan_amount, interest_rate, interest_amount, total_payable_amount,
              remaining_balance, due_date, loan_issued_date, status
       FROM loans
       WHERE customer_id = $1 AND status = 'forfeited'
       ORDER BY loan_issued_date DESC`,
      [customerIdNum]
    );

    // Get payment history
    const paymentHistoryResult = await pool.query(
      `SELECT ph.*, l.transaction_number, l.loan_amount
       FROM payment_history ph
       JOIN loans l ON ph.loan_id = l.id
       WHERE l.customer_id = $1
       ORDER BY ph.payment_date DESC`,
      [customerIdNum]
    );

    res.json({
      customer: customer,
      activeLoans: activeLoansResult.rows,
      redeemedLoans: redeemedLoansResult.rows,
      forfeitedLoans: forfeitedLoansResult.rows,
      paymentHistory: paymentHistoryResult.rows,
      summary: {
        totalActiveLoans: activeLoansResult.rows.length,
        totalRedeemedLoans: redeemedLoansResult.rows.length,
        totalForfeitedLoans: forfeitedLoansResult.rows.length,
        totalPayments: paymentHistoryResult.rows.length,
        totalOutstanding: activeLoansResult.rows.reduce((sum, loan) => sum + parseFloat(loan.remaining_balance || 0), 0)
      }
    });
  } catch (err) {
    console.error('Error fetching customer profile:', err);
    res.status(500).json({ message: 'Error fetching customer profile', error: err.message });
  }
});

// UPDATE CUSTOMER PROFILE - Update customer information
app.put('/customers/:customerId', async (req, res) => {
  try {
    const { customerId } = req.params;
    const mapped = validators.mapRequestToDb(req.body);

    const {
      first_name,
      last_name,
      email,
      home_phone,
      mobile_phone,
      birthdate,
      id_type,
      id_number,
      referral,
      identification_info,
      street_address,
      city,
      state,
      zipcode,
      customer_number,
      profile_image,
      updated_by_user_id,
      updated_by_username
    } = mapped;

    const customerIdNum = parseInt(customerId, 10);
    if (isNaN(customerIdNum)) {
      return res.status(400).json({ message: 'Invalid customer ID' });
    }

    // Check if customer exists
    const customerCheck = await pool.query(
      'SELECT * FROM customers WHERE id = $1',
      [customerIdNum]
    );

    if (customerCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Customer not found' });
    }

    // Validate email format if provided
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ message: 'Invalid email format' });
    }

    // Validate birthdate format if provided
    if (birthdate && !/^\d{4}-\d{2}-\d{2}$/.test(birthdate)) {
      return res.status(400).json({ message: 'Birthdate must be in YYYY-MM-DD format' });
    }

    // Update customer profile
    const result = await pool.query(
      `UPDATE customers
       SET first_name = $1, last_name = $2, email = $3, home_phone = $4,
           mobile_phone = $5, birthdate = $6, id_type = $7, id_number = $8,
           referral = $9, identification_info = $10, street_address = $11,
           city = $12, state = $13, zipcode = $14, customer_number = $15,
           profile_image = $16, updated_by_user_id = $17, updated_by_username = $18, updated_at = CURRENT_TIMESTAMP
       WHERE id = $19
       RETURNING *`,
      [
        first_name || null,
        last_name || null,
        email || null,
        home_phone || null,
        mobile_phone || null,
        birthdate || null,
        id_type || null,
        id_number || null,
        referral || null,
        identification_info || null,
        street_address || null,
        city || null,
        state || null,
        zipcode || null,
        customer_number || null,
        profile_image || null,
        updated_by_user_id || null,
        updated_by_username || null,
        customerIdNum
      ]
    );

    res.json({
      message: 'Customer profile updated successfully',
      customer: result.rows[0]
    });
  } catch (err) {
    console.error('Error updating customer profile:', err);
    res.status(500).json({ message: 'Error updating customer profile', error: err.message });
  }
});

// ======================== END CUSTOMER PROFILE MANAGEMENT ========================

// ======================== HELPER FUNCTIONS ========================

// Ensure interest_amount is always a valid number
const ensureInterestAmount = (loan) => {
  if (!loan) return 0;
  const amount = parseFloat(loan.interest_amount);
  if (!isNaN(amount) && amount > 0) return amount;
  // Fallback: calculate from loan_amount and interest_rate
  const loanAmount = parseFloat(loan.loan_amount) || 0;
  const interestRate = parseFloat(loan.interest_rate) || 0;
  return (loanAmount * interestRate) / 100;
};

// ======================== CUSTOMER-CENTRIC LOAN MANAGEMENT ========================

// CREATE LOAN FOR CUSTOMER - POST /customers/:customerId/loans
app.post('/customers/:customerId/loans', async (req, res) => {
  try {
    const { customerId } = req.params;
    const mapped = validators.mapRequestToDb(req.body);

    const {
      loan_amount: loanAmount,
      interest_rate: interestRate,
      interest_amount: inputInterestAmount,
      total_payable_amount: inputTotalPayableAmount,
      item_category,
      item_description,
      collateral_description,
      collateral_image,
      customer_note,
      loan_issued_date: loanIssuedDate,
      due_date: inputDueDate,
      loan_term: loanTerm,
      transaction_number: inputTransactionNumber,
      previous_loan_amount: previousLoanAmount,
      user_id: userId,
      created_by_user_id: createdByUserId,
      created_by_username: createdByUsername
    } = mapped;

    const customerIdNum = parseInt(customerId, 10);
    if (isNaN(customerIdNum)) {
      return res.status(400).json({ message: 'Invalid customer ID' });
    }

    // Verify customer exists
    const customerResult = await pool.query(
      'SELECT * FROM customers WHERE id = $1',
      [customerIdNum]
    );

    if (customerResult.rows.length === 0) {
      return res.status(404).json({ message: 'Customer not found' });
    }

    const customer = customerResult.rows[0];

    // Validate loan amounts
    const amountValidation = validators.validateLoanAmounts(loanAmount, interestRate, loanTerm);
    if (!amountValidation.valid) {
      return res.status(400).json({ message: amountValidation.error });
    }

    // Calculate loan totals
    const totalLoanAmount = parseFloat(previousLoanAmount || 0) + parseFloat(loanAmount);
    const calculatedInterestAmount = parseFloat(inputInterestAmount) || 
      (totalLoanAmount * parseFloat(interestRate)) / 100;
    const calculatedTotalPayableAmount = parseFloat(inputTotalPayableAmount) || 
      (totalLoanAmount + calculatedInterestAmount);

    // Calculate or use provided due date
    let dueDate;
    if (inputDueDate) {
      dueDate = inputDueDate;
    } else {
      const issued = new Date(loanIssuedDate || new Date());
      const due = new Date(issued);
      due.setDate(due.getDate() + parseInt(loanTerm));
      dueDate = due.toISOString().slice(0, 10);
    }

    // Generate or use provided transaction number
    const transactionNumber = inputTransactionNumber || Math.floor(Math.random() * 1000000000).toString();

    // ===== CHECK AVAILABLE CASH IN STORE BEFORE CREATING LOAN =====
    // Get current active shift for this user
    const currentShiftResult = await pool.query(
      'SELECT * FROM shift_management WHERE user_id = $1 AND shift_end_time IS NULL ORDER BY id DESC LIMIT 1',
      [createdByUserId || userId]
    );

    if (currentShiftResult.rows.length > 0) {
      const shift = currentShiftResult.rows[0];
      const openingBalance = parseFloat(shift.opening_balance) || 0;
      
      // Get all loans created in this shift (money gone OUT of store)
      const loansInShiftResult = await pool.query(
        `SELECT COALESCE(SUM(loan_amount), 0) as total_loans_out 
         FROM loans 
         WHERE created_by_user_id = $1 
         AND DATE(created_at) = DATE($2)`,
        [createdByUserId || userId, new Date()]
      );
      const loansOut = parseFloat(loansInShiftResult.rows[0]?.total_loans_out || 0);

      // Get all payments made in this shift (money coming IN to store)
      const paymentsInShiftResult = await pool.query(
        `SELECT COALESCE(SUM(payment_amount), 0) as total_payments_in 
         FROM payment_history 
         WHERE created_by_user_id = $1 
         AND DATE(created_at) = DATE($2)`,
        [createdByUserId || userId, new Date()]
      );
      const paymentsIn = parseFloat(paymentsInShiftResult.rows[0]?.total_payments_in || 0);

      // Calculate available balance
      const currentBalance = openingBalance + paymentsIn - loansOut;
      
      // Check if there's enough cash to give this loan
      if (totalLoanAmount > currentBalance) {
        return res.status(400).json({
          message: `❌ Insufficient store cash! Available: $${currentBalance.toFixed(2)}, Requested: $${totalLoanAmount.toFixed(2)}`,
          details: {
            openingBalance: openingBalance,
            paymentsIn: paymentsIn,
            loansOut: loansOut,
            availableBalance: currentBalance,
            requestedAmount: totalLoanAmount,
            shortfallAmount: (totalLoanAmount - currentBalance).toFixed(2)
          }
        });
      }
    }
    // ===== END CASH CHECK =====

    // Insert loan linked to customer profile
    const result = await pool.query(
      `INSERT INTO loans (
        customer_id, first_name, last_name, email, home_phone, mobile_phone, birthdate,
        id_type, id_number, referral, identification_info, street_address, city, state, zipcode,
        customer_number, loan_amount, interest_rate, interest_amount, total_payable_amount, recurring_fee,
        item_category, item_description, collateral_description, collateral_image, customer_note, transaction_number,
        loan_issued_date, loan_term, due_date,
        status, remaining_balance, created_by, created_by_user_id, created_by_username, customer_name
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36)
      RETURNING *`,
      [
        customerIdNum,
        customer.first_name,
        customer.last_name,
        customer.email || null,
        customer.home_phone || null,
        customer.mobile_phone || null,
        customer.birthdate || null,
        customer.id_type || null,
        customer.id_number || null,
        customer.referral || null,
        customer.identification_info || null,
        customer.street_address || null,
        customer.city || null,
        customer.state || null,
        customer.zipcode || null,
        customer.customer_number || null,
        totalLoanAmount,
        interestRate,
        calculatedInterestAmount,
        calculatedTotalPayableAmount,
        calculatedRecurringFee,
        item_category || null,
        item_description || null,
        collateral_description || null,
        collateral_image || null,
        customer_note || null,
        transactionNumber,
        loanIssuedDate || new Date().toISOString().slice(0, 10),
        loanTerm,
        dueDate,
        'active',
        calculatedTotalPayableAmount,
        userId || createdByUserId || null,
        createdByUserId || userId || null,
        createdByUsername || null,
        `${customer.first_name} ${customer.last_name}`
      ]
    );

    const loan = validators.formatLoanResponse(result.rows[0]);

    res.status(201).json({
      message: 'Loan created successfully for customer',
      loan,
      pdf_url: `/loan-pdf/${result.rows[0].id}`
    });
  } catch (err) {
    console.error('Error creating loan with customer:', err);
    res.status(500).json({ message: 'Error creating loan', error: err.message });
  }
});

// SEARCH LOANS FOR CUSTOMER - GET /customers/:customerId/loans/search?query=...
app.get('/customers/:customerId/loans/search', async (req, res) => {
  try {
    const { customerId } = req.params;
    const { status, transactionNumber, minAmount, maxAmount } = req.query;

    const customerIdNum = parseInt(customerId, 10);
    if (isNaN(customerIdNum)) {
      return res.status(400).json({ message: 'Invalid customer ID' });
    }

    // Verify customer exists
    const customerCheck = await pool.query('SELECT * FROM customers WHERE id = $1', [customerIdNum]);
    if (customerCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Customer not found' });
    }

    // Build dynamic search query
    let query = 'SELECT * FROM loans WHERE customer_id = $1';
    const params = [customerIdNum];
    let paramIndex = 2;

    if (status) {
      params.push(status);
      query += ` AND status = $${paramIndex}`;
      paramIndex++;
    }

    if (transactionNumber) {
      params.push(transactionNumber);
      query += ` AND transaction_number = $${paramIndex}`;
      paramIndex++;
    }

    if (minAmount) {
      params.push(parseFloat(minAmount));
      query += ` AND loan_amount >= $${paramIndex}`;
      paramIndex++;
    }

    if (maxAmount) {
      params.push(parseFloat(maxAmount));
      query += ` AND loan_amount <= $${paramIndex}`;
      paramIndex++;
    }

    query += ' ORDER BY loan_issued_date DESC';

    const result = await pool.query(query, params);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'No loans found for this customer matching criteria' });
    }

    const loans = result.rows.map(loan => ({
      ...validators.formatLoanResponse(loan),
      pdf_url: `/loan-pdf/${loan.id}`
    }));

    res.json(loans);
  } catch (err) {
    console.error('Error searching customer loans:', err);
    res.status(500).json({ message: 'Error searching loans', error: err.message });
  }
});

// MAKE PAYMENT FOR CUSTOMER LOAN - POST /customers/:customerId/loans/:loanId/payment
app.post('/customers/:customerId/loans/:loanId/payment', async (req, res) => {
  const { customerId, loanId } = req.params;
  const { paymentMethod, paymentAmount, userId, redemptionFee } = req.body;

  try {
    const customerIdNum = parseInt(customerId, 10);
    const loanIdNum = parseInt(loanId, 10);

    if (isNaN(customerIdNum) || isNaN(loanIdNum)) {
      return res.status(400).json({ message: 'Invalid customer or loan ID' });
    }

    // Validate paymentAmount
    if (!paymentAmount || parseFloat(paymentAmount) <= 0) {
      return res.status(400).json({ message: 'Valid payment amount is required' });
    }

    // Verify customer exists
    const customerCheck = await pool.query('SELECT * FROM customers WHERE id = $1', [customerIdNum]);
    if (customerCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Customer not found' });
    }

    // Fetch the loan and verify it belongs to the customer
    const loanResult = await pool.query('SELECT * FROM loans WHERE id = $1 AND customer_id = $2', [loanIdNum, customerIdNum]);
    const loan = loanResult.rows[0];

    if (!loan) {
      return res.status(404).json({ message: 'Loan not found for this customer' });
    }

    // Update remaining balance after payment
    const newRemainingBalance = parseFloat(loan.remaining_balance) - parseFloat(paymentAmount);
    const finalBalance = Math.max(newRemainingBalance, 0);

    // If balance reaches 0, automatically redeem the loan
    const newStatus = finalBalance === 0 ? 'redeemed' : loan.status;

    // Calculate redemption fee if provided and auto-redeeming
    const calculatedRedemptionFee = (newStatus === 'redeemed' && redemptionFee) ? parseFloat(redemptionFee) || 0 : 0;

    // Update the loan details with the new remaining balance and status if needed
    const updatedLoanResult = await pool.query(
      'UPDATE loans SET remaining_balance = $1, status = $2, redemption_fee = $3 WHERE id = $4 RETURNING *',
      [finalBalance, newStatus, calculatedRedemptionFee, loanIdNum]
    );

    // Insert payment history with default payment method if not provided
    const method = paymentMethod || 'cash';
    const paymentResult = await pool.query(
      'INSERT INTO payment_history (loan_id, payment_method, payment_amount, payment_date, created_by) VALUES ($1, $2, $3, CURRENT_TIMESTAMP, $4) RETURNING *',
      [loanIdNum, method, paymentAmount, userId || null]
    );

    // Check if the loan was just fully paid (and auto-redeemed)
    if (finalBalance <= 0) {
      const loanWithInterest = {
        ...updatedLoanResult.rows[0],
        interest_amount: ensureInterestAmount(updatedLoanResult.rows[0])
      };
      res.status(200).json({
        message: '🎉 Loan fully paid and automatically redeemed!',
        loan: validators.formatLoanResponse(loanWithInterest),
        paymentHistory: paymentResult.rows[0],
      });
    } else {
      const loanWithInterest = {
        ...updatedLoanResult.rows[0],
        interest_amount: ensureInterestAmount(updatedLoanResult.rows[0])
      };
      res.status(200).json({
        message: 'Payment successfully processed!',
        loan: validators.formatLoanResponse(loanWithInterest),
        paymentHistory: paymentResult.rows[0],
      });
    }
  } catch (err) {
    console.error('Error making payment:', err);
    res.status(500).json({ message: 'Error making payment' });
  }
});

// REDEEM LOAN FOR CUSTOMER - POST /customers/:customerId/loans/:loanId/redeem
app.post('/customers/:customerId/loans/:loanId/redeem', async (req, res) => {
  const { customerId, loanId } = req.params;
  const { userId } = req.body;

  try {
    const customerIdNum = parseInt(customerId, 10);
    const loanIdNum = parseInt(loanId, 10);

    if (isNaN(customerIdNum) || isNaN(loanIdNum)) {
      return res.status(400).json({ message: 'Invalid customer or loan ID' });
    }

    // Verify customer exists
    const customerCheck = await pool.query('SELECT * FROM customers WHERE id = $1', [customerIdNum]);
    if (customerCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Customer not found' });
    }

    // Fetch the loan and verify it belongs to the customer
    const loanResult = await pool.query('SELECT * FROM loans WHERE id = $1 AND customer_id = $2', [loanIdNum, customerIdNum]);
    const loan = loanResult.rows[0];

    if (!loan) {
      return res.status(404).json({ message: 'Loan not found for this customer' });
    }

    // Use the remaining balance that's maintained with each payment
    const remainingBalance = parseFloat(loan.remaining_balance || 0);

    // If the remaining balance is greater than 0, return an error
    if (remainingBalance > 0) {
      return res.status(400).json({ message: 'Loan is not fully paid, cannot redeem.' });
    }

    // Ensure the loan is not already redeemed
    if (loan.status === 'redeemed') {
      return res.status(400).json({ message: 'Loan has already been redeemed.' });
    }

    // Redeem the loan
    const updatedLoan = await pool.query(
      'UPDATE loans SET status = $1 WHERE id = $2 RETURNING *',
      ['redeemed', loanIdNum]
    );

    // Add to redeem history (if table exists)
    try {
      await pool.query(
        'INSERT INTO redeem_history (loan_id, redeemed_by) VALUES ($1, $2) RETURNING *',
        [loanIdNum, userId]
      );
    } catch (historyErr) {
      console.warn('Warning: Could not insert redeem history:', historyErr.message);
      // Continue even if history insert fails - the main redeem is successful
    }

    res.status(200).json({
      message: 'Loan redeemed successfully!',
      loan: updatedLoan.rows[0],
    });
  } catch (err) {
    console.error('Error redeeming loan:', err.message, err.detail);
    res.status(500).json({ message: 'Error redeeming loan.', error: err.message });
  }
});

// FORFEIT LOAN FOR CUSTOMER - POST /customers/:customerId/loans/:loanId/forfeit
app.post('/customers/:customerId/loans/:loanId/forfeit', async (req, res) => {
  const { customerId, loanId } = req.params;
  const { userId } = req.body;

  try {
    const customerIdNum = parseInt(customerId, 10);
    const loanIdNum = parseInt(loanId, 10);

    if (isNaN(customerIdNum) || isNaN(loanIdNum)) {
      return res.status(400).json({ message: 'Invalid customer or loan ID' });
    }

    // Verify customer exists
    const customerCheck = await pool.query('SELECT * FROM customers WHERE id = $1', [customerIdNum]);
    if (customerCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Customer not found' });
    }

    // Fetch the loan and verify it belongs to the customer
    const loanResult = await pool.query('SELECT * FROM loans WHERE id = $1 AND customer_id = $2', [loanIdNum, customerIdNum]);
    const loan = loanResult.rows[0];

    if (!loan) {
      return res.status(404).json({ message: 'Loan not found for this customer' });
    }

    if (loan.status === 'redeemed' || loan.status === 'forfeited') {
      return res.status(400).json({ message: 'Loan is already redeemed or forfeited.' });
    }

    // Check forfeit conditions:
    // 1. Due date must be passed (past today)
    // 2. Remaining balance must be less than interest amount OR equal to 0
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const dueDate = new Date(loan.due_date);
    dueDate.setHours(0, 0, 0, 0);
    
    const isDueDatePassed = dueDate < today;
    const remainingBalance = parseFloat(loan.remaining_balance || 0);
    const interestAmount = parseFloat(loan.interest_amount || 0);
    const isBalanceLessThanInterest = remainingBalance < interestAmount || remainingBalance === 0;
    
    if (!isDueDatePassed) {
      return res.status(400).json({ message: 'Cannot forfeit: Loan due date has not passed yet.' });
    }
    
    if (!isBalanceLessThanInterest) {
      return res.status(400).json({ message: 'Cannot forfeit: Remaining balance must be less than interest amount or zero.' });
    }

    // Update loan status to 'forfeited'
    const updatedLoan = await pool.query('UPDATE loans SET status = $1 WHERE id = $2 RETURNING *', ['forfeited', loanIdNum]);

    // Add to forfeit history (if table exists)
    try {
      await pool.query(
        'INSERT INTO redeem_history (loan_id, redeemed_by) VALUES ($1, $2) RETURNING *',
        [loanIdNum, userId]
      );
    } catch (historyErr) {
      console.warn('Warning: Could not insert forfeit history:', historyErr.message);
      // Continue even if history insert fails - the main forfeit is successful
    }

    res.status(200).json({
      message: 'Loan forfeited successfully!',
      loan: updatedLoan.rows[0],
    });
  } catch (err) {
    console.error('Error forfeiting loan:', err);
    res.status(500).json({ message: 'Error forfeiting loan.' });
  }
});

// REACTIVATE FORFEITED LOAN FOR CUSTOMER - POST /customers/:customerId/loans/:loanId/reactivate
app.post('/customers/:customerId/loans/:loanId/reactivate', async (req, res) => {
  const { customerId, loanId } = req.params;
  const { reactivatedByUserId, reactivatedByUsername, reactivationDate } = req.body;

  try {
    const customerIdNum = parseInt(customerId, 10);
    const loanIdNum = parseInt(loanId, 10);

    if (isNaN(customerIdNum) || isNaN(loanIdNum)) {
      return res.status(400).json({ message: 'Invalid customer or loan ID' });
    }

    // Verify customer exists
    const customerCheck = await pool.query('SELECT * FROM customers WHERE id = $1', [customerIdNum]);
    if (customerCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Customer not found' });
    }

    // Fetch the loan and verify it belongs to the customer
    const loanResult = await pool.query('SELECT * FROM loans WHERE id = $1 AND customer_id = $2', [loanIdNum, customerIdNum]);
    const loan = loanResult.rows[0];

    if (!loan) {
      return res.status(404).json({ message: 'Loan not found for this customer' });
    }

    // Check if loan is forfeited
    if (loan.status !== 'forfeited' && loan.status !== 'FORFEITED') {
      return res.status(400).json({ message: 'Loan is not forfeited and cannot be reactivated' });
    }

    // Update loan status to active
    const reactivationTime = reactivationDate || new Date().toISOString();
    const updateQuery = `
      UPDATE loans 
      SET status = 'active',
          reactivated_at = $1,
          reactivated_by_user_id = $2,
          reactivated_by_username = $3
      WHERE id = $4
      RETURNING *
    `;

    const updatedLoanResult = await pool.query(updateQuery, [
      reactivationTime,
      reactivatedByUserId || null,
      reactivatedByUsername || null,
      loanIdNum
    ]);

    const updatedLoan = updatedLoanResult.rows[0];

    // Create audit log entry
    try {
      await pool.query(
        `INSERT INTO audit_log (action_type, user_id, username, loan_id, timestamp, old_values, new_values)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          'REACTIVATE_LOAN',
          reactivatedByUserId || null,
          reactivatedByUsername || null,
          loanIdNum,
          reactivationTime,
          JSON.stringify({ status: loan.status }),
          JSON.stringify({ status: 'active' })
        ]
      );
    } catch (auditErr) {
      console.warn('Failed to create audit log entry:', auditErr);
    }

    res.status(200).json({
      message: 'Loan reactivated successfully!',
      loan: validators.formatLoanResponse(updatedLoan),
      reactivationMetadata: {
        reactivatedAt: reactivationTime,
        reactivatedByUserId: reactivatedByUserId,
        reactivatedByUsername: reactivatedByUsername
      }
    });
  } catch (err) {
    console.error('Error reactivating loan:', err);
    res.status(500).json({ message: 'Error reactivating loan', error: err.message });
  }
});

// EXTEND DUE DATE FOR CUSTOMER LOAN - POST /customers/:customerId/loans/:loanId/extend-due-date
app.post('/customers/:customerId/loans/:loanId/extend-due-date', async (req, res) => {
  const { customerId, loanId } = req.params;
  const { extendDays, extendedByUserId, extendedByUsername } = req.body;

  try {
    const customerIdNum = parseInt(customerId, 10);
    const loanIdNum = parseInt(loanId, 10);
    const extendDaysNum = parseInt(extendDays || 30, 10);

    if (isNaN(customerIdNum) || isNaN(loanIdNum)) {
      return res.status(400).json({ message: 'Invalid customer or loan ID' });
    }

    // Verify customer exists
    const customerCheck = await pool.query('SELECT * FROM customers WHERE id = $1', [customerIdNum]);
    if (customerCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Customer not found' });
    }

    // Fetch the loan and verify it belongs to the customer
    const loanResult = await pool.query('SELECT * FROM loans WHERE id = $1 AND customer_id = $2', [loanIdNum, customerIdNum]);
    const loan = loanResult.rows[0];

    if (!loan) {
      return res.status(404).json({ message: 'Loan not found for this customer' });
    }

    if (loan.status !== 'active') {
      return res.status(400).json({ message: 'Only active loans can be extended' });
    }

    // Check if at least interest amount has been paid
    const paymentResult = await pool.query(
      'SELECT SUM(payment_amount) AS total_paid FROM payment_history WHERE loan_id = $1',
      [loanIdNum]
    );
    const totalPaid = parseFloat(paymentResult.rows[0].total_paid) || 0;
    
    // Use helper function to ensure interest_amount is valid
    const requiredInterest = ensureInterestAmount(loan);

    if (totalPaid < requiredInterest) {
      return res.status(400).json({ 
        message: `Interest not paid. Paid: $${totalPaid.toFixed(2)}, Required: $${requiredInterest.toFixed(2)}, Cannot extend loan.`,
        details: {
          totalPaid: totalPaid.toFixed(2),
          requiredInterest: requiredInterest.toFixed(2)
        }
      });
    }

    // Extend the due date
    const currentDueDate = new Date(loan.due_date);
    currentDueDate.setDate(currentDueDate.getDate() + extendDaysNum);
    const newDueDate = currentDueDate.toISOString().slice(0, 10);

    const updateQuery = `
      UPDATE loans
      SET due_date = $1,
          extended_at = CURRENT_TIMESTAMP,
          extended_by_user_id = $2,
          extended_by_username = $3
      WHERE id = $4
      RETURNING *
    `;

    const updatedLoan = await pool.query(updateQuery, [newDueDate, extendedByUserId || null, extendedByUsername || null, loanIdNum]);

    res.status(200).json({
      message: `Loan extended by ${extendDaysNum} days!`,
      loan: validators.formatLoanResponse(updatedLoan.rows[0])
    });
  } catch (err) {
    console.error('Error extending loan due date:', err);
    res.status(500).json({ message: 'Error extending loan due date' });
  }
});

// ADD MONEY TO CUSTOMER LOAN - POST /customers/:customerId/loans/:loanId/add-money
app.post('/customers/:customerId/loans/:loanId/add-money', async (req, res) => {
  const { customerId, loanId } = req.params;
  const { amount } = req.body;

  try {
    const customerIdNum = parseInt(customerId, 10);
    const loanIdNum = parseInt(loanId, 10);

    if (isNaN(customerIdNum) || isNaN(loanIdNum)) {
      return res.status(400).json({ message: 'Invalid customer or loan ID' });
    }

    // Verify customer exists
    const customerCheck = await pool.query('SELECT * FROM customers WHERE id = $1', [customerIdNum]);
    if (customerCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Customer not found' });
    }

    // Fetch the loan and verify it belongs to the customer
    const loanResult = await pool.query('SELECT * FROM loans WHERE id = $1 AND customer_id = $2', [loanIdNum, customerIdNum]);
    const loan = loanResult.rows[0];

    if (!loan) {
      return res.status(404).json({ message: 'Loan not found for this customer' });
    }

    // Get total payments made so far
    const paymentsResult = await pool.query(
      'SELECT SUM(payment_amount) AS total_paid FROM payment_history WHERE loan_id = $1',
      [loanIdNum]
    );
    const totalPaid = paymentsResult.rows[0].total_paid || 0;

    // Update loan amount, recalculate interest, and total payable amount
    const newLoanAmount = parseFloat(loan.loan_amount) + parseFloat(amount);
    const newInterestAmount = (newLoanAmount * parseFloat(loan.interest_rate)) / 100;
    const newTotalPayableAmount = newLoanAmount + newInterestAmount;
    const newRemainingBalance = newTotalPayableAmount - totalPaid;

    const updateLoanResult = await pool.query(
      'UPDATE loans SET loan_amount = $1, interest_amount = $2, total_payable_amount = $3, remaining_balance = $4 WHERE id = $5 RETURNING *',
      [newLoanAmount, newInterestAmount, newTotalPayableAmount, newRemainingBalance, loanIdNum]
    );

    res.status(200).json({
      message: 'Money added successfully and loan recalculated',
      loan: updateLoanResult.rows[0],
    });
  } catch (err) {
    console.error('Error adding money:', err);
    res.status(500).json({ message: 'Error adding money to the loan' });
  }
});

// GET LOAN DETAILS FOR CUSTOMER - GET /customers/:customerId/loans/:loanId
app.get('/customers/:customerId/loans/:loanId', async (req, res) => {
  const { customerId, loanId } = req.params;

  try {
    const customerIdNum = parseInt(customerId, 10);
    const loanIdNum = parseInt(loanId, 10);

    if (isNaN(customerIdNum) || isNaN(loanIdNum)) {
      return res.status(400).json({ message: 'Invalid customer or loan ID' });
    }

    // Verify customer exists
    const customerCheck = await pool.query('SELECT * FROM customers WHERE id = $1', [customerIdNum]);
    if (customerCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Customer not found' });
    }

    // Fetch the loan and verify it belongs to the customer
    const loanResult = await pool.query('SELECT * FROM loans WHERE id = $1 AND customer_id = $2', [loanIdNum, customerIdNum]);
    const loan = loanResult.rows[0];

    if (!loan) {
      return res.status(404).json({ message: 'Loan not found for this customer' });
    }

    // Get payment history for this loan
    const paymentsResult = await pool.query(
      'SELECT * FROM payment_history WHERE loan_id = $1 ORDER BY payment_date DESC',
      [loanIdNum]
    );

    // Ensure interest_amount is always valid
    const loanWithInterest = {
      ...loan,
      interest_amount: ensureInterestAmount(loan)
    };

    res.json({
      loan: validators.formatLoanResponse(loanWithInterest),
      paymentHistory: paymentsResult.rows,
      pdf_url: `/loan-pdf/${loanIdNum}`
    });
  } catch (err) {
    console.error('Error fetching loan details:', err);
    res.status(500).json({ message: 'Error fetching loan details', error: err.message });
  }
});

// DISCOUNT INTEREST ON CUSTOMER LOAN - POST /customers/:customerId/loans/:loanId/discount
app.post('/customers/:customerId/loans/:loanId/discount', async (req, res) => {
  const { customerId, loanId } = req.params;
  const { discountAmount, userId, username } = req.body;

  try {
    const customerIdNum = parseInt(customerId, 10);
    const loanIdNum = parseInt(loanId, 10);
    const discountAmountNum = parseFloat(discountAmount);

    // Validation: Check for valid IDs
    if (isNaN(customerIdNum) || isNaN(loanIdNum)) {
      return res.status(400).json({ message: 'Invalid customer or loan ID' });
    }

    // Validation: Check discount amount
    if (!discountAmount || discountAmountNum <= 0) {
      return res.status(400).json({ message: 'Discount amount must be greater than 0' });
    }

    // Verify customer exists
    const customerCheck = await pool.query('SELECT * FROM customers WHERE id = $1', [customerIdNum]);
    if (customerCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Customer not found' });
    }

    // Fetch the loan and verify it belongs to the customer
    const loanResult = await pool.query('SELECT * FROM loans WHERE id = $1 AND customer_id = $2', [loanIdNum, customerIdNum]);
    const loan = loanResult.rows[0];

    if (!loan) {
      return res.status(404).json({ message: 'Loan not found for this customer' });
    }

    // Validation: Check loan status (must be active)
    if (loan.status !== 'active') {
      return res.status(409).json({ message: `Cannot discount ${loan.status} loans. Only active loans can be discounted.` });
    }

    // Get current interest amount
    const currentInterest = ensureInterestAmount(loan);

    // Validation: Discount cannot exceed interest amount
    if (discountAmountNum > currentInterest) {
      return res.status(400).json({ 
        message: `Discount amount ($${discountAmountNum.toFixed(2)}) cannot exceed current interest ($${currentInterest.toFixed(2)})`,
        details: {
          currentInterest: currentInterest.toFixed(2),
          maxDiscount: currentInterest.toFixed(2),
          requestedDiscount: discountAmountNum.toFixed(2)
        }
      });
    }

    // Calculate new values
    const previousInterest = currentInterest;
    const newInterestAmount = previousInterest - discountAmountNum;
    const newTotalPayableAmount = parseFloat(loan.loan_amount) + newInterestAmount;
    
    // Update remaining balance by reducing it by the discount amount
    const previousRemainingBalance = parseFloat(loan.remaining_balance);
    const newRemainingBalance = Math.max(0, previousRemainingBalance - discountAmountNum);

    // Update the loan with new interest and total payable amounts
    const updateQuery = `
      UPDATE loans
      SET interest_amount = $1,
          total_payable_amount = $2,
          remaining_balance = $3,
          last_discounted_at = CURRENT_TIMESTAMP,
          last_discounted_by = $4
      WHERE id = $5
      RETURNING *
    `;

    const updatedLoan = await pool.query(updateQuery, [
      newInterestAmount,
      newTotalPayableAmount,
      newRemainingBalance,
      userId || null,
      loanIdNum
    ]);

    // Create audit log entry for discount (optional but recommended)
    try {
      const discountLogQuery = `
        INSERT INTO discount_logs (
          loan_id, 
          customer_id, 
          discount_amount, 
          applied_by_user_id, 
          applied_by_username,
          previous_interest_amount,
          new_interest_amount,
          previous_total_payable,
          new_total_payable,
          created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP)
        RETURNING *
      `;
      
      await pool.query(discountLogQuery, [
        loanIdNum,
        customerIdNum,
        discountAmountNum,
        userId || null,
        username || null,
        previousInterest.toFixed(2),
        newInterestAmount.toFixed(2),
        (parseFloat(loan.loan_amount) + previousInterest).toFixed(2),
        newTotalPayableAmount.toFixed(2)
      ]);
    } catch (logErr) {
      // Log warning but don't fail the discount operation
      console.warn('Warning: Could not create discount log entry:', logErr.message);
    }

    res.status(200).json({
      success: true,
      message: `✅ Discount of $${discountAmountNum.toFixed(2)} applied successfully! Interest reduced from $${previousInterest.toFixed(2)} to $${newInterestAmount.toFixed(2)}`,
      loan: validators.formatLoanResponse(updatedLoan.rows[0]),
      discount: {
        amount: discountAmountNum.toFixed(2),
        previousInterest: previousInterest.toFixed(2),
        newInterest: newInterestAmount.toFixed(2),
        previousTotal: (parseFloat(loan.loan_amount) + previousInterest).toFixed(2),
        newTotal: newTotalPayableAmount.toFixed(2),
        appliedBy: username || null,
        appliedAt: new Date().toISOString()
      }
    });
  } catch (err) {
    console.error('Error applying discount:', err);
    res.status(500).json({ message: 'Error applying discount to loan', error: err.message });
  }
});

// ======================== END CUSTOMER-CENTRIC LOAN MANAGEMENT ========================

// START SHIFT - User records opening cash balance
app.post('/start-shift', async (req, res) => {
  const { userId, openingBalance } = req.body;

  try {
    if (openingBalance === null || openingBalance === undefined || openingBalance < 0) {
      return res.status(400).json({ message: 'Invalid opening balance' });
    }

    // Check if there's an active shift for this user
    const activeShiftCheck = await pool.query(
      'SELECT * FROM shift_management WHERE user_id = $1 AND shift_end_time IS NULL',
      [userId]
    );

    if (activeShiftCheck.rows.length > 0) {
      return res.status(400).json({ message: 'User already has an active shift. Please close the previous shift first.' });
    }

    // Insert new shift record
    const result = await pool.query(
      `INSERT INTO shift_management (user_id, shift_start_time, opening_balance)
       VALUES ($1, CURRENT_TIMESTAMP, $2)
       RETURNING *`,
      [userId, parseFloat(openingBalance)]
    );

    res.status(201).json({
      message: 'Shift started successfully',
      shift: result.rows[0]
    });
  } catch (err) {
    console.error('Error starting shift:', err);
    res.status(500).json({ message: 'Error starting shift' });
  }
});


// GET CURRENT SHIFT - Get active shift for user (query parameter version)
app.get('/current-shift', async (req, res) => {
  const { userId } = req.query;

  try {
    if (!userId) {
      return res.status(400).json({ message: 'User ID is required' });
    }

    const result = await pool.query(
      'SELECT * FROM shift_management WHERE user_id = $1 AND shift_end_time IS NULL ORDER BY id DESC LIMIT 1',
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'No active shift found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error fetching current shift:', err);
    res.status(500).json({ message: 'Error fetching current shift' });
  }
});

// GET CURRENT SHIFT - Get active shift for user (path parameter version)
app.get('/current-shift/:userId', async (req, res) => {
  const { userId } = req.params;

  try {
    if (!userId) {
      return res.status(400).json({ message: 'User ID is required' });
    }

    const result = await pool.query(
      'SELECT * FROM shift_management WHERE user_id = $1 AND shift_end_time IS NULL ORDER BY id DESC LIMIT 1',
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'No active shift found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error fetching current shift:', err);
    res.status(500).json({ message: 'Error fetching current shift' });
  }
});


// END SHIFT - User records closing cash balance and system verifies
app.post('/end-shift', async (req, res) => {
  const { userId, closingBalance, notes } = req.body;

  try {
    if (closingBalance === null || closingBalance === undefined || closingBalance < 0) {
      return res.status(400).json({ message: 'Invalid closing balance' });
    }

    // Get active shift
    const shiftResult = await pool.query(
      'SELECT * FROM shift_management WHERE user_id = $1 AND shift_end_time IS NULL ORDER BY id DESC LIMIT 1',
      [userId]
    );

    if (shiftResult.rows.length === 0) {
      return res.status(404).json({ message: 'No active shift found' });
    }

    const shift = shiftResult.rows[0];

    // Get all transactions for this shift - payments received
    const paymentsResult = await pool.query(
      `SELECT COALESCE(SUM(payment_amount), 0) AS total_payments 
       FROM payment_history 
       WHERE created_by = $1 AND payment_date >= $2`,
      [userId, shift.shift_start_time]
    );

    // Get all loans given during this shift
    const loansGivenResult = await pool.query(
      `SELECT COALESCE(SUM(loan_amount), 0) AS total_loans_given 
       FROM loans 
       WHERE created_by = $1 AND loan_issued_date >= DATE($2)`,
      [userId, shift.shift_start_time]
    );

    const totalPayments = parseFloat(paymentsResult.rows[0].total_payments || 0);
    const totalLoansGiven = parseFloat(loansGivenResult.rows[0].total_loans_given || 0);
    const openingBalance = parseFloat(shift.opening_balance);

    // Calculate expected balance: opening + payments - loans
    const expectedBalance = openingBalance + totalPayments - totalLoansGiven;
    const closingBalanceNum = parseFloat(closingBalance);
    const difference = closingBalanceNum - expectedBalance;
    const isBalanced = Math.abs(difference) < 0.01; // Allow for floating point errors

    // Update shift with closing details
    const updateResult = await pool.query(
      `UPDATE shift_management 
       SET shift_end_time = CURRENT_TIMESTAMP, 
           closing_balance = $1, 
           total_payments_received = $2, 
           total_loans_given = $3, 
           expected_balance = $4, 
           difference = $5, 
           is_balanced = $6,
           notes = $7
       WHERE id = $8
       RETURNING *`,
      [closingBalanceNum, totalPayments, totalLoansGiven, expectedBalance, difference, isBalanced, notes || null, shift.id]
    );

    res.status(200).json({
      message: isBalanced ? 'Shift closed successfully and cash is balanced!' : 'Shift closed but there is a discrepancy!',
      shift: updateResult.rows[0],
      summary: {
        openingBalance: openingBalance,
        closingBalance: closingBalanceNum,
        totalPaymentsReceived: totalPayments,
        totalLoansGiven: totalLoansGiven,
        expectedBalance: expectedBalance,
        actualDifference: difference,
        isBalanced: isBalanced,
        status: isBalanced ? 'BALANCED' : 'DISCREPANCY'
      }
    });
  } catch (err) {
    console.error('Error ending shift:', err);
    res.status(500).json({ message: 'Error ending shift' });
  }
});


// GET SHIFT REPORT - Get detailed summary of a shift
app.get('/shift-report/:shiftId', async (req, res) => {
  const { shiftId } = req.params;

  try {
    // Get shift details
    const shiftResult = await pool.query(
      'SELECT * FROM shift_management WHERE id = $1',
      [shiftId]
    );

    if (shiftResult.rows.length === 0) {
      return res.status(404).json({ message: 'Shift not found' });
    }

    const shift = shiftResult.rows[0];

    // Get all payments during this shift
    const paymentsResult = await pool.query(
      `SELECT ph.*, l.customer_name, l.transaction_number
       FROM payment_history ph
       JOIN loans l ON ph.loan_id = l.id
       WHERE ph.created_by = $1 AND ph.payment_date >= $2 AND ph.payment_date <= COALESCE($3, CURRENT_TIMESTAMP)
       ORDER BY ph.payment_date DESC`,
      [shift.user_id, shift.shift_start_time, shift.shift_end_time]
    );

    // Get all loans created during this shift
    const loansResult = await pool.query(
      `SELECT id, customer_name, loan_amount, transaction_number, loan_issued_date
       FROM loans
       WHERE created_by = $1 AND loan_issued_date >= DATE($2) AND loan_issued_date <= COALESCE(DATE($3), CURRENT_DATE)
       ORDER BY loan_issued_date DESC`,
      [shift.user_id, shift.shift_start_time, shift.shift_end_time]
    );

    res.json({
      shift: shift,
      payments: paymentsResult.rows,
      loansCreated: loansResult.rows,
      summary: {
        totalTransactions: paymentsResult.rows.length + loansResult.rows.length,
        totalPaymentTransactions: paymentsResult.rows.length,
        totalLoansCreated: loansResult.rows.length
      }
    });
  } catch (err) {
    console.error('Error fetching shift report:', err);
    res.status(500).json({ message: 'Error fetching shift report' });
  }
});


// GET SHIFT HISTORY - Get all shifts for a user (query parameter version)
app.get('/shift-history', async (req, res) => {
  const { userId } = req.query;

  try {
    if (!userId) {
      return res.status(400).json({ message: 'User ID is required' });
    }

    const result = await pool.query(
      'SELECT * FROM shift_management WHERE user_id = $1 ORDER BY shift_start_time DESC',
      [userId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching shift history:', err);
    res.status(500).json({ message: 'Error fetching shift history' });
  }
});

// GET SHIFT HISTORY - Get all shifts for a user (path parameter version)
app.get('/shift-history/:userId', async (req, res) => {
  const { userId } = req.params;

  try {
    if (!userId) {
      return res.status(400).json({ message: 'User ID is required' });
    }

    const result = await pool.query(
      'SELECT * FROM shift_management WHERE user_id = $1 ORDER BY shift_start_time DESC',
      [userId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching shift history:', err);
    res.status(500).json({ message: 'Error fetching shift history' });
  }
});


// GET TODAY SHIFT SUMMARY - Quick summary for today
app.get('/today-shift-summary/:userId', async (req, res) => {
  const { userId } = req.params;

  try {
    // Get active shift or today's last shift
    const shiftResult = await pool.query(
      `SELECT * FROM shift_management 
       WHERE user_id = $1 AND DATE(shift_start_time) = CURRENT_DATE
       ORDER BY shift_start_time DESC LIMIT 1`,
      [userId]
    );

    if (shiftResult.rows.length === 0) {
      return res.status(404).json({ message: 'No shift found for today' });
    }

    const shift = shiftResult.rows[0];

    // Calculate current stats if shift is active
    if (!shift.shift_end_time) {
      const paymentsResult = await pool.query(
        `SELECT COALESCE(SUM(payment_amount), 0) AS total_payments,
                COUNT(*) AS payment_count
         FROM payment_history 
         WHERE created_by = $1 AND payment_date >= $2`,
        [userId, shift.shift_start_time]
      );

      const loansGivenResult = await pool.query(
        `SELECT COALESCE(SUM(loan_amount), 0) AS total_loans_given,
                COUNT(*) AS loan_count
         FROM loans 
         WHERE created_by = $1 AND loan_issued_date >= DATE($2)`,
        [userId, shift.shift_start_time]
      );

      const totalPayments = parseFloat(paymentsResult.rows[0].total_payments || 0);
      const totalLoansGiven = parseFloat(loansGivenResult.rows[0].total_loans_given || 0);
      const expectedBalance = parseFloat(shift.opening_balance) + totalPayments - totalLoansGiven;

      return res.json({
        shift: shift,
        currentStats: {
          openingBalance: shift.opening_balance,
          expectedBalance: expectedBalance,
          totalPaymentsReceived: totalPayments,
          totalLoansGiven: totalLoansGiven,
          paymentCount: paymentsResult.rows[0].payment_count,
          loanCount: loansGivenResult.rows[0].loan_count,
          shiftActive: true
        }
      });
    }

    res.json({
      shift: shift,
      shiftClosed: true
    });
  } catch (err) {
    console.error('Error fetching today shift summary:', err);
    res.status(500).json({ message: 'Error fetching shift summary' });
  }
});


// ======================== END SHIFT MANAGEMENT ========================

// ======================== CASH REPORT ========================

// GET CASH REPORT - Generate daily cash report
app.get('/cash-report', async (req, res) => {
  const { date } = req.query;

  try {
    // Validate date format
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ message: 'Invalid date format. Use YYYY-MM-DD' });
    }

    // Parse the date
    const reportDate = new Date(date);
    if (isNaN(reportDate.getTime())) {
      return res.status(400).json({ message: 'Invalid date format. Use YYYY-MM-DD' });
    }

    // Format date for queries (YYYY-MM-DD)
    const dateStr = date;

    // 1. Get Pawn Activity (New Loans, Buys, Buyouts)
    const newLoansResult = await pool.query(
      `SELECT COUNT(*) as qty, COALESCE(SUM(loan_amount), 0) as amount
       FROM loans
       WHERE DATE(loan_issued_date) = $1 AND status NOT IN ('forfeited', 'redeemed')`,
      [dateStr]
    );

    const newLoans = {
      qty: parseInt(newLoansResult.rows[0].qty) || 0,
      amount: parseFloat(newLoansResult.rows[0].amount) || 0
    };

    // For Buys and Buyouts - these would need specific transaction types if tracked separately
    // For now, we'll set them to 0 (can be enhanced if buy/buyout logic is implemented)
    const buys = { qty: 0, amount: 0.00 };
    const buyouts = { qty: 0, amount: 0.00 };

    const inStoreTotal = {
      qty: newLoans.qty + buys.qty + buyouts.qty,
      amount: parseFloat((newLoans.amount + buys.amount + buyouts.amount).toFixed(2))
    };

    // 2. Get In-Store Transactions (Renewals, Partial Payments, Extensions, Redemptions)

    // Renewals
    const renewalsResult = await pool.query(
      `SELECT COUNT(*) as qty,
              COALESCE(SUM(l.loan_amount), 0) as principal,
              COALESCE(SUM(l.interest_amount), 0) as interest,
              0 as fees
       FROM loans l
       WHERE DATE(l.due_date) = $1 AND l.status = 'active'`,
      [dateStr]
    );

    const renewals = {
      qty: parseInt(renewalsResult.rows[0].qty) || 0,
      principal: parseFloat(renewalsResult.rows[0].principal) || 0,
      interest: parseFloat(renewalsResult.rows[0].interest) || 0,
      fees: 0.00,
      total: 0
    };
    renewals.total = parseFloat((renewals.principal + renewals.interest + renewals.fees).toFixed(2));

    // Partial Payments
    const partialPaymentsResult = await pool.query(
      `SELECT COUNT(*) as qty,
              COALESCE(SUM(ph.payment_amount), 0) as total,
              COALESCE(SUM(l.loan_amount * (ph.payment_amount / l.total_payable_amount)), 0) as principal,
              COALESCE(SUM(l.interest_amount * (ph.payment_amount / l.total_payable_amount)), 0) as interest
       FROM payment_history ph
       JOIN loans l ON ph.loan_id = l.id
       WHERE DATE(ph.payment_date) = $1 AND ph.payment_amount < l.total_payable_amount`,
      [dateStr]
    );

    const partialPayments = {
      qty: parseInt(partialPaymentsResult.rows[0].qty) || 0,
      principal: parseFloat(partialPaymentsResult.rows[0].principal) || 0,
      interest: parseFloat(partialPaymentsResult.rows[0].interest) || 0,
      fees: 0.00,
      total: parseFloat(partialPaymentsResult.rows[0].total) || 0
    };

    // Extensions (loans renewed/extended, not new loans created today)
    const extensionsResult = await pool.query(
      `SELECT COUNT(*) as qty,
              COALESCE(SUM(l.loan_amount), 0) as principal,
              COALESCE(SUM(l.interest_amount), 0) as interest,
              0 as fees
       FROM loans l
       WHERE DATE(l.updated_at) = $1 AND l.status = 'active' AND DATE(l.loan_issued_date) != $1`,
      [dateStr]
    );

    const extensions = {
      qty: parseInt(extensionsResult.rows[0].qty) || 0,
      principal: parseFloat(extensionsResult.rows[0].principal) || 0,
      interest: parseFloat(extensionsResult.rows[0].interest) || 0,
      fees: 0.00,
      total: 0
    };
    extensions.total = parseFloat((extensions.principal + extensions.interest + extensions.fees).toFixed(2));

    // Redemptions
    const redemptionsResult = await pool.query(
      `SELECT COUNT(*) as qty,
              COALESCE(SUM(l.loan_amount), 0) as principal,
              COALESCE(SUM(l.interest_amount), 0) as interest,
              0 as fees
       FROM loans l
       WHERE DATE(l.loan_issued_date) = $1 AND l.status = 'redeemed'`,
      [dateStr]
    );

    const redemptions = {
      qty: parseInt(redemptionsResult.rows[0].qty) || 0,
      principal: parseFloat(redemptionsResult.rows[0].principal) || 0,
      interest: parseFloat(redemptionsResult.rows[0].interest) || 0,
      fees: 0.00,
      total: 0
    };
    redemptions.total = parseFloat((redemptions.principal + redemptions.interest + redemptions.fees).toFixed(2));

    // In-Store Transactions Subtotal
    const inStoreTxnsSubtotal = {
      qty: renewals.qty + partialPayments.qty + extensions.qty + redemptions.qty,
      principal: parseFloat((renewals.principal + partialPayments.principal + extensions.principal + redemptions.principal).toFixed(2)),
      interest: parseFloat((renewals.interest + partialPayments.interest + extensions.interest + redemptions.interest).toFixed(2)),
      fees: parseFloat((renewals.fees + partialPayments.fees + extensions.fees + redemptions.fees).toFixed(2)),
      total: 0
    };
    inStoreTxnsSubtotal.total = parseFloat((inStoreTxnsSubtotal.principal + inStoreTxnsSubtotal.interest + inStoreTxnsSubtotal.fees).toFixed(2));

    // 3. Get Store Reconciliation (Expected vs Actual)
    const shiftResult = await pool.query(
      `SELECT id, opening_balance, closing_balance, expected_balance, is_balanced
       FROM shift_management
       WHERE DATE(shift_start_time) = $1
       ORDER BY shift_start_time DESC`,
      [dateStr]
    );

    const openStore = {
      online: { expected: 0.00, actual: 0.00, difference: 0.00 },
      till01: { expected: 0.00, actual: 0.00, difference: 0.00 },
      till02: { expected: 0.00, actual: 0.00, difference: 0.00 },
      storeSale: { expected: 0.00, actual: 0.00, difference: 0.00 }
    };

    let todayOpeningTotal = 0;
    let todayClosingTotal = 0;

    if (shiftResult.rows.length > 0) {
      const shift = shiftResult.rows[0];
      
      // Map shift data to store locations
      // This assumes shifts represent different store locations
      // Adjust logic based on your actual store structure
      const expectedBalance = parseFloat(shift.expected_balance) || 0;
      const actualBalance = parseFloat(shift.closing_balance) || 0;
      
      openStore.till01.expected = expectedBalance;
      openStore.till01.actual = actualBalance;
      openStore.till01.difference = parseFloat((actualBalance - expectedBalance).toFixed(2));
      
      todayOpeningTotal = parseFloat(shift.opening_balance) || 0;
      todayClosingTotal = actualBalance;
    }

    // Check if we have data for the report
    const hasData = newLoans.qty > 0 || partialPayments.qty > 0 || redemptions.qty > 0 || shiftResult.rows.length > 0;

    if (!hasData) {
      return res.status(404).json({ message: 'No transaction data available for the provided date' });
    }

    // Get Active Loan Count (status = 'active' AND due_date >= today)
    const activeLoanResult = await pool.query(
      `SELECT COUNT(*) as count FROM loans WHERE status = 'active' AND DATE(due_date) >= CURRENT_DATE`
    );
    const activeLoanCount = parseInt(activeLoanResult.rows[0].count) || 0;

    // Get Overdue/Due Loan Balance (sum of remaining_balance for active loans past due)
    const overdueLoanResult = await pool.query(
      `SELECT COALESCE(SUM(remaining_balance), 0) as balance FROM loans WHERE status = 'active' AND DATE(due_date) < CURRENT_DATE`
    );
    const overdueLoanBalance = parseFloat(overdueLoanResult.rows[0].balance) || 0;

    // Build and return the report
    const report = {
      pawnActivity: {
        newLoans,
        buys,
        buyouts,
        inStoreTotal
      },
      inStoreTxns: {
        renewals,
        partialPayments,
        extensions,
        redemptions,
        subtotal: inStoreTxnsSubtotal
      },
      openStore,
      todayOpeningTotal: parseFloat(todayOpeningTotal.toFixed(2)),
      todayClosingTotal: parseFloat(todayClosingTotal.toFixed(2)),
      activeLoanCount,
      overdueLoanBalance: parseFloat(overdueLoanBalance.toFixed(2))
    };

    res.json(report);
  } catch (err) {
    console.error('Error generating cash report:', err);
    res.status(500).json({ message: 'Error generating cash report', error: err.message });
  }
});

// ======================== END CASH REPORT ========================

// ======================== REVENUE REPORT ========================

// Get Revenue Report for date range
app.get('/revenue-report', async (req, res) => {
  const { startDate, endDate } = req.query;

  try {
    // Validate date format
    if (!startDate || !endDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      return res.status(400).json({ message: 'Invalid date format. Use YYYY-MM-DD' });
    }

    // Get all payments within the date range with loan status info
    const paymentsResult = await pool.query(
      `SELECT 
         ph.loan_id, 
         ph.payment_amount, 
         ph.payment_date,
         l.loan_amount,
         l.interest_amount,
         l.total_payable_amount,
         l.status,
         l.due_date
       FROM payment_history ph
       JOIN loans l ON ph.loan_id = l.id
       WHERE DATE(ph.payment_date) BETWEEN $1 AND $2
       ORDER BY ph.payment_date DESC`,
      [startDate, endDate]
    );

    // Calculate revenue breakdown
    let totalRevenue = 0;
    let interestRevenue = 0;
    let principalReceived = 0;
    let feesCollected = 0;
    let activeLoansRevenue = 0;
    let activeLoansInterest = 0;
    let dueLoansRevenue = 0;
    let dueLoansInterest = 0;
    let redeemedLoansRevenue = 0;
    let redeemedLoansInterest = 0;
    const revenueByLoan = {};

    // Process each payment to calculate interest and principal portions
    for (const payment of paymentsResult.rows) {
      const loanId = payment.loan_id;
      const paymentAmount = parseFloat(payment.payment_amount) || 0;
      const loanAmount = parseFloat(payment.loan_amount) || 0;
      const interestAmount = parseFloat(payment.interest_amount) || 0;
      const totalPayable = parseFloat(payment.total_payable_amount) || 0;
      const loanStatus = payment.status;
      const dueDate = new Date(payment.due_date);
      const today = new Date();

      // Calculate the ratio of interest in this payment
      // Interest portion = (interest / total payable) * payment amount
      const interestPortion = totalPayable > 0 ? (interestAmount / totalPayable) * paymentAmount : 0;
      const principalPortion = paymentAmount - interestPortion;

      interestRevenue += interestPortion;
      principalReceived += principalPortion;
      totalRevenue += paymentAmount;

      // Categorize by loan status
      if (loanStatus === 'redeemed') {
        redeemedLoansRevenue += paymentAmount;
        redeemedLoansInterest += interestPortion;
      } else if (loanStatus === 'active' && dueDate < today) {
        // Due/overdue loan
        dueLoansRevenue += paymentAmount;
        dueLoansInterest += interestPortion;
      } else if (loanStatus === 'active') {
        // Active non-overdue loan
        activeLoansRevenue += paymentAmount;
        activeLoansInterest += interestPortion;
      }

      if (!revenueByLoan[loanId]) {
        revenueByLoan[loanId] = {
          interest: 0,
          principal: 0,
          total: 0,
          count: 0
        };
      }
      revenueByLoan[loanId].interest += interestPortion;
      revenueByLoan[loanId].principal += principalPortion;
      revenueByLoan[loanId].total += paymentAmount;
      revenueByLoan[loanId].count += 1;
    }

    // Round all values to 2 decimal places
    totalRevenue = parseFloat(totalRevenue.toFixed(2));
    interestRevenue = parseFloat(interestRevenue.toFixed(2));
    principalReceived = parseFloat(principalReceived.toFixed(2));
    feesCollected = parseFloat(feesCollected.toFixed(2));
    activeLoansRevenue = parseFloat(activeLoansRevenue.toFixed(2));
    activeLoansInterest = parseFloat(activeLoansInterest.toFixed(2));
    dueLoansRevenue = parseFloat(dueLoansRevenue.toFixed(2));
    dueLoansInterest = parseFloat(dueLoansInterest.toFixed(2));
    redeemedLoansRevenue = parseFloat(redeemedLoansRevenue.toFixed(2));
    redeemedLoansInterest = parseFloat(redeemedLoansInterest.toFixed(2));

    const report = {
      totalRevenue,
      interestRevenue,
      principalReceived,
      feesCollected,
      interestCount: paymentsResult.rows.length,
      principalCount: paymentsResult.rows.length,
      feeCount: 0,
      paymentCount: paymentsResult.rows.length,
      activeLoansRevenue,
      activeLoansInterest,
      dueLoansRevenue,
      dueLoansInterest,
      redeemedLoansRevenue,
      redeemedLoansInterest,
      revenueByLoan
    };

    res.json(report);
  } catch (err) {
    console.error('Error generating revenue report:', err);
    res.status(500).json({ message: 'Error generating revenue report', error: err.message });
  }
});

// ======================== END REVENUE REPORT ========================

// ======================== BALANCING REPORT (FOR DAILY CASH REPORT - BALANCING TAB) ========================

// GET BALANCING REPORT - Active and Due loans within a custom date range
// Frontend calls: GET /balancing-report?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
app.get('/balancing-report', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    // Validate date parameters
    if (!startDate || !endDate) {
      return res.status(400).json({ 
        message: 'startDate and endDate query parameters are required (YYYY-MM-DD format)' 
      });
    }

    // Validate date format
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      return res.status(400).json({ 
        message: 'Invalid date format. Use YYYY-MM-DD' 
      });
    }

    // Parse dates
    const start = new Date(startDate);
    const end = new Date(endDate);

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return res.status(400).json({ 
        message: 'Invalid date values' 
      });
    }

    // Verify start date is before end date
    if (start > end) {
      return res.status(400).json({ 
        message: 'Start date must be before or equal to end date' 
      });
    }

    // Get ACTIVE loans (non-overdue) created or active within the date range
    // Active loans: status = 'active' AND due_date >= today (not yet due)
    const activeLoansResult = await pool.query(
      `SELECT 
        COUNT(*) as total_count,
        COALESCE(SUM(loan_amount), 0) as total_principal,
        COALESCE(SUM(interest_amount), 0) as total_interest,
        COALESCE(SUM(loan_amount + interest_amount), 0) as total_amount
      FROM loans 
      WHERE status = $1 
        AND DATE(loan_issued_date) >= $2 
        AND DATE(loan_issued_date) <= $3
        AND DATE(due_date) >= CURRENT_DATE`,
      ['active', startDate, endDate]
    );

    // Get DUE/OVERDUE loans (active loans with due date passed)
    // Due loans: status = 'active' AND due_date < today
    const dueLoansResult = await pool.query(
      `SELECT 
        COUNT(*) as total_count,
        COALESCE(SUM(loan_amount), 0) as total_principal,
        COALESCE(SUM(interest_amount), 0) as total_interest,
        COALESCE(SUM(loan_amount + interest_amount), 0) as total_amount
      FROM loans 
      WHERE status = $1 
        AND DATE(loan_issued_date) >= $2 
        AND DATE(loan_issued_date) <= $3
        AND DATE(due_date) < CURRENT_DATE`,
      ['active', startDate, endDate]
    );

    const activeLoans = activeLoansResult.rows[0];
    const dueLoans = dueLoansResult.rows[0];

    // Format response with proper decimal places
    const response = {
      startDate,
      endDate,
      totalActiveLoanCount: parseInt(activeLoans.total_count) || 0,
      totalActivePrincipal: parseFloat(activeLoans.total_principal) || 0.00,
      totalActiveInterest: parseFloat(activeLoans.total_interest) || 0.00,
      totalDueLoanCount: parseInt(dueLoans.total_count) || 0,
      totalDuePrincipal: parseFloat(dueLoans.total_principal) || 0.00,
      totalDueInterest: parseFloat(dueLoans.total_interest) || 0.00
    };

    console.log('📊 Balancing Report Generated:', response);
    res.json(response);
  } catch (err) {
    console.error('Error generating balancing report:', err);
    res.status(500).json({ 
      message: 'Error generating balancing report', 
      error: err.message 
    });
  }
});

// ======================== END BALANCING REPORT ========================

// ======================== PDF INVOICE GENERATION ========================

// Get Loan as PDF Invoice
app.get('/loan-pdf/:loanId', async (req, res) => {
  try {
    // PDF generation moved to frontend (ManageCustomerProfileForm.js)
    res.status(501).json({ message: 'PDF generation is handled by the frontend application. Use the ManageCustomerProfileForm to generate PDFs.' });
  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ message: 'Error', error: err.message });
  }
});

// Get Search Results as PDF (multiple loans on one document)
app.post('/loans-pdf', async (req, res) => {
  try {
    // PDF generation moved to frontend
    res.status(501).json({ message: 'PDF generation is handled by the frontend application.' });
  } catch (err) {
    console.error('Error generating PDFs:', err);
    res.status(500).json({ message: 'Error generating PDFs', error: err.message });
  }
});

// ======================== END PDF GENERATION ========================

// ---------------------------- START SERVER ----------------------------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

