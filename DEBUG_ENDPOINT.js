/**
 * DEPLOY THIS ENDPOINT to diagnose Loan #8 issue
 * Add to server.js for temporary debugging (remove after fixing)
 */

// Add this route to server.js (before app.listen):

app.get('/debug/loan/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Get the loan directly from DB
    const loanResult = await pool.query('SELECT * FROM loans WHERE id = $1', [id]);
    if (loanResult.rows.length === 0) {
      return res.status(404).json({ message: 'Loan not found' });
    }
    
    const dbLoan = loanResult.rows[0];
    
    // Get payment history
    const paymentResult = await pool.query(
      'SELECT * FROM payments WHERE loan_id = $1 ORDER BY payment_date ASC',
      [id]
    );
    const payments = paymentResult.rows;
    
    // Calculate state
    const calculated = calculateLoanState(dbLoan, payments, new Date());
    
    // Show the difference
    res.json({
      database: {
        id: dbLoan.id,
        remaining_balance: dbLoan.remaining_balance,
        interest_amount: dbLoan.interest_amount,
        due_date: dbLoan.due_date,
        loan_issued_date: dbLoan.loan_issued_date
      },
      calculated: {
        principal_remaining: calculated.principalRemaining,
        interest_accrued: calculated.interestAccrued,
        penalty_accrued: calculated.penaltyAccrued,
        total_balance: calculated.totalBalance,
        next_due_date: calculated.nextDueDate,
        is_overdue: calculated.isOverdue,
        days_overdue: calculated.daysOverdue
      },
      payments: payments.map(p => ({
        date: p.payment_date,
        amount: p.payment_amount,
        method: p.payment_method
      })),
      difference: {
        remaining_balance_diff: calculated.totalBalance - dbLoan.remaining_balance,
        note: dbLoan.remaining_balance === 21218 && calculated.totalBalance === 20600 
          ? '✅ Calculation working! Backend needs deployment.' 
          : '❌ Something else is wrong'
      }
    });
  } catch (err) {
    res.status(500).json({ message: 'Error', error: err.message });
  }
});

// TEST IT:
// GET /debug/loan/8
// 
// Response should show:
// {
//   "database": {
//     "remaining_balance": 21218
//   },
//   "calculated": {
//     "total_balance": 20600
//   },
//   "difference": {
//     "remaining_balance_diff": -618,
//     "note": "✅ Calculation working! Backend needs deployment."
//   }
// }
