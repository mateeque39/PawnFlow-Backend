/**
 * Loan State Display Component
 * 
 * Displays a comprehensive loan breakdown with:
 * - Principal, interest, penalty breakdown
 * - Live recalculated balance
 * - Overdue status and penalty details
 * - Next due date
 * - Payment history
 */

import React, { useState, useEffect } from 'react';
import './LoanStateDisplay.css';

/**
 * Formats currency with $ symbol
 */
const formatCurrency = (amount) => {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(Math.abs(amount));
};

/**
 * Formats date to readable format
 */
const formatDate = (dateString) => {
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
};

/**
 * LoanStateDisplay Component
 * 
 * Props:
 *  - loan: Loan object {loan_amount, interest_rate, created_at, due_date}
 *  - payments: Array of payments [{payment_amount, payment_date}, ...]
 *  - currentDate: Reference date for calculations (default: today)
 *  - onChange: Callback when loan state is calculated
 *  - autoRefresh: Auto-refresh interval in ms (default: 60000)
 */
export const LoanStateDisplay = ({ 
  loan, 
  payments = [], 
  currentDate = new Date(),
  onChange,
  autoRefresh = 60000
}) => {
  const [loanState, setLoanState] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  /**
   * Fetch calculated loan state from API or local calculation
   */
  const calculateLoanState = async () => {
    try {
      setLoading(true);
      setError(null);

      // Try to use API endpoint if available
      const response = await fetch('/api/loans/calculate-state', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          loan,
          payments,
          currentDate
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const state = await response.json();
      setLoanState(state);
      
      if (onChange) {
        onChange(state);
      }
    } catch (err) {
      console.error('Error calculating loan state:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // Calculate on mount and when inputs change
  useEffect(() => {
    if (loan) {
      calculateLoanState();
    }
  }, [loan, payments, currentDate]);

  // Set up auto-refresh interval
  useEffect(() => {
    if (!autoRefresh || autoRefresh <= 0) return;

    const interval = setInterval(() => {
      calculateLoanState();
    }, autoRefresh);

    return () => clearInterval(interval);
  }, [loan, payments, autoRefresh]);

  if (loading && !loanState) {
    return (
      <div className="loan-state-display loading">
        <div className="spinner"></div>
        <p>Calculating loan state...</p>
      </div>
    );
  }

  if (error && !loanState) {
    return (
      <div className="loan-state-display error">
        <div className="error-message">
          <strong>Error:</strong> {error}
        </div>
      </div>
    );
  }

  if (!loanState) {
    return (
      <div className="loan-state-display">
        <p>No loan data available</p>
      </div>
    );
  }

  const statusClass = loanState.isOverdue ? 'status-overdue' : 'status-active';
  const statusText = loanState.isOverdue 
    ? `Overdue by ${loanState.daysOverdue} day${loanState.daysOverdue !== 1 ? 's' : ''}`
    : 'Current';

  return (
    <div className="loan-state-display">
      <div className="loan-header">
        <h2>Loan Status</h2>
        <div className={`status-badge ${statusClass}`}>
          {statusText}
        </div>
      </div>

      {/* Total Balance Card */}
      <div className="balance-card">
        <div className="balance-amount">
          {formatCurrency(loanState.totalBalance)}
        </div>
        <div className="balance-label">Total Balance Due</div>
        {loanState.isOverdue && (
          <div className="penalty-alert">
            ⚠️ {loanState.daysOverdue} days overdue
          </div>
        )}
      </div>

      {/* Next Due Date */}
      <div className="due-date-section">
        <div className="section-label">Next Payment Due</div>
        <div className="due-date-value">
          {formatDate(loanState.nextDueDate)}
        </div>
      </div>

      {/* Breakdown Grid */}
      <div className="breakdown-grid">
        <div className="breakdown-item">
          <div className="breakdown-label">Principal</div>
          <div className="breakdown-amount">
            {formatCurrency(loanState.principalRemaining)}
          </div>
          <div className="breakdown-percent">
            ({((loanState.principalRemaining / loanState.totalBalance) * 100).toFixed(1)}%)
          </div>
        </div>

        <div className="breakdown-item">
          <div className="breakdown-label">Interest</div>
          <div className="breakdown-amount">
            {formatCurrency(loanState.interestAccrued)}
          </div>
          <div className="breakdown-percent">
            ({((loanState.interestAccrued / loanState.totalBalance) * 100).toFixed(1)}%)
          </div>
        </div>

        <div className={`breakdown-item ${loanState.penaltyAccrued > 0 ? 'has-penalty' : ''}`}>
          <div className="breakdown-label">
            Penalty Interest
            {loanState.penaltyAccrued > 0 && <span className="penalty-badge">!</span>}
          </div>
          <div className="breakdown-amount">
            {formatCurrency(loanState.penaltyAccrued)}
          </div>
          <div className="breakdown-percent">
            ({loanState.penaltyAccrued > 0 ? ((loanState.penaltyAccrued / loanState.totalBalance) * 100).toFixed(1) : 0}%)
          </div>
        </div>
      </div>

      {/* Loan Details */}
      <div className="loan-details">
        <div className="detail-row">
          <span className="detail-label">Original Principal:</span>
          <span className="detail-value">{formatCurrency(loan.loan_amount)}</span>
        </div>
        <div className="detail-row">
          <span className="detail-label">Interest Rate:</span>
          <span className="detail-value">{loan.interest_rate}% per month</span>
        </div>
        <div className="detail-row">
          <span className="detail-label">Loan Created:</span>
          <span className="detail-value">{formatDate(loan.created_at || loan.issued_date)}</span>
        </div>
        <div className="detail-row">
          <span className="detail-label">Time Elapsed:</span>
          <span className="detail-value">{loanState.monthsElapsed} month{loanState.monthsElapsed !== 1 ? 's' : ''}</span>
        </div>
      </div>

      {/* Payment Priority Explanation */}
      <div className="payment-info">
        <div className="info-title">💳 Payment Priority Order</div>
        <div className="priority-list">
          <div className="priority-item">
            <span className="priority-number">1</span>
            <span className="priority-text">Penalty Interest (if any)</span>
          </div>
          <div className="priority-item">
            <span className="priority-number">2</span>
            <span className="priority-text">Regular Interest</span>
          </div>
          <div className="priority-item">
            <span className="priority-number">3</span>
            <span className="priority-text">Principal</span>
          </div>
        </div>
      </div>

      {/* Penalty Explanation */}
      {loanState.penaltyAccrued > 0 && (
        <div className="penalty-info">
          <div className="info-title">⚠️ Overdue Penalty</div>
          <p>
            Your loan is <strong>{loanState.daysOverdue} days overdue</strong>. 
            A daily penalty of <strong>{formatCurrency(loanState.interestAccrued / 30)}</strong> 
            per day is being applied.
          </p>
          <p className="info-text">
            Current penalty accumulated: <strong>{formatCurrency(loanState.penaltyAccrued)}</strong>
          </p>
          <p className="info-text small">
            Penalties will continue to accumulate daily until payment is made.
          </p>
        </div>
      )}

      {/* Payment History */}
      {loanState.paymentHistory && loanState.paymentHistory.length > 0 && (
        <div className="payment-history">
          <div className="history-title">📋 Payment History</div>
          <div className="history-table">
            <div className="table-header">
              <div className="col-date">Date</div>
              <div className="col-amount">Amount</div>
            </div>
            {loanState.paymentHistory.map((payment, idx) => (
              <div key={idx} className="table-row">
                <div className="col-date">{formatDate(payment.paymentDate)}</div>
                <div className="col-amount">{formatCurrency(payment.paymentAmount)}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Last Updated */}
      <div className="last-updated">
        Updated: {new Date().toLocaleTimeString()}
      </div>
    </div>
  );
};

export default LoanStateDisplay;
