/**
 * API Endpoint for Loan State Calculation
 * 
 * Adds a new endpoint to the Express server:
 * POST /api/loans/calculate-state
 * 
 * This calculation engine endpoint should be integrated into server.js
 * after importing the loan-calculator at the top.
 */

const { calculateLoanState } = require('./loan-calculator');

/**
 * Calculate Loan State Endpoint
 * 
 * POST /api/loans/calculate-state
 * 
 * Request body:
 * {
 *   loan: { loan_amount, interest_rate, created_at, due_date, ... },
 *   payments: [ { payment_amount, payment_date }, ... ],
 *   currentDate: "2026-03-03" (optional, defaults to today)
 * }
 * 
 * Response:
 * {
 *   principalRemaining,
 *   interestAccrued,
 *   penaltyAccrued,
 *   totalBalance,
 *   nextDueDate,
 *   isOverdue,
 *   daysOverdue,
 *   monthsElapsed,
 *   paymentHistory: [ { paymentAmount, paymentDate }, ... ]
 * }
 */
function setupLoanCalculationEndpoint(app) {
  app.post('/api/loans/calculate-state', async (req, res) => {
    try {
      const { loan, payments = [], currentDate } = req.body;

      if (!loan) {
        return res.status(400).json({ 
          message: 'loan object is required in request body' 
        });
      }

      if (!loan.loan_amount || !loan.interest_rate) {
        return res.status(400).json({ 
          message: 'loan must contain loan_amount and interest_rate' 
        });
      }

      if (!loan.created_at && !loan.issued_date) {
        return res.status(400).json({ 
          message: 'loan must contain either created_at or issued_date' 
        });
      }

      if (!loan.due_date) {
        return res.status(400).json({ 
          message: 'loan must contain due_date' 
        });
      }

      // Calculate loan state
      const loanState = calculateLoanState(
        loan,
        payments,
        currentDate ? new Date(currentDate) : new Date()
      );

      res.json(loanState);
    } catch (err) {
      console.error('Error calculating loan state:', err);
      res.status(400).json({ 
        message: 'Error calculating loan state',
        error: err.message 
      });
    }
  });

  // GET endpoint for quick state lookup
  app.get('/api/loans/:loanId/calculate-state', async (req, res) => {
    try {
      const { loanId } = req.params;
      const { currentDate } = req.query;

      const loanIdNum = parseInt(loanId, 10);
      if (isNaN(loanIdNum)) {
        return res.status(400).json({ message: 'Invalid loan ID' });
      }

      // Fetch loan from database
      const loanResult = await pool.query(
        'SELECT * FROM loans WHERE id = $1',
        [loanIdNum]
      );

      if (loanResult.rows.length === 0) {
        return res.status(404).json({ message: 'Loan not found' });
      }

      const loan = loanResult.rows[0];

      // Fetch payment history for this loan
      const paymentsResult = await pool.query(
        'SELECT payment_amount, payment_date FROM payment_history WHERE loan_id = $1 ORDER BY payment_date ASC',
        [loanIdNum]
      );

      // Calculate loan state
      const loanState = calculateLoanState(
        loan,
        paymentsResult.rows,
        currentDate ? new Date(currentDate) : new Date()
      );

      res.json({
        loan: {
          id: loan.id,
          transaction_number: loan.transaction_number,
          customer_name: loan.customer_name,
          loan_amount: loan.loan_amount,
          interest_rate: loan.interest_rate,
          created_at: loan.created_at,
          due_date: loan.due_date,
          status: loan.status
        },
        state: loanState
      });
    } catch (err) {
      console.error('Error calculating loan state:', err);
      res.status(500).json({ 
        message: 'Error calculating loan state',
        error: err.message 
      });
    }
  });
}

module.exports = { setupLoanCalculationEndpoint };
