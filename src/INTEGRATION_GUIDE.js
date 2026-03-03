/**
 * INTEGRATION GUIDE: Adding Live Loan Calculations to Existing UI
 * 
 * This guide shows how to integrate the LoanStateDisplay component
 * into your existing loan detail views to always show recalculated values.
 */

// ============================================
// OPTION 1: Add to Existing SearchLoanForm or ViewLoanForm
// ============================================
// In your existing loan detail component (e.g., SearchLoanForm.js or similar):

import React, { useState, useEffect } from 'react';
import LoanStateDisplay from './LoanStateDisplay';

export const ViewLoanDetails = ({ loan }) => {
  const [payments, setPayments] = useState([]);
  const [loanState, setLoanState] = useState(null);

  // Fetch payment history when loan loads
  useEffect(() => {
    if (loan?.id) {
      fetchPaymentHistory(loan.id);
    }
  }, [loan]);

  const fetchPaymentHistory = async (loanId) => {
    try {
      const response = await fetch(`/payment-history?loanId=${loanId}`);
      if (response.ok) {
        const data = await response.json();
        setPayments(data);
      }
    } catch (err) {
      console.error('Error fetching payment history:', err);
    }
  };

  if (!loan) return <div>No loan selected</div>;

  return (
    <div className="loan-details-container">
      {/* EXISTING LOAN INFO - Can keep or remove */}
      <div className="loan-header-info">
        <h2>Loan #{loan.id} - {loan.customer_name}</h2>
        <p>Transaction: {loan.transaction_number}</p>
      </div>

      {/* NEW: Replace static loan info with dynamic calculations */}
      <LoanStateDisplay 
        loan={{
          loan_amount: parseFloat(loan.loan_amount),
          interest_rate: parseFloat(loan.interest_rate),
          created_at: loan.created_at || loan.loan_issued_date,
          due_date: loan.due_date
        }}
        payments={payments.map(p => ({
          payment_amount: parseFloat(p.payment_amount),
          payment_date: p.payment_date
        }))}
        onChange={(state) => setLoanState(state)}
        autoRefresh={30000} // Refresh every 30 seconds
      />

      {/* Your existing action buttons */}
      <div className="loan-actions">
        <button onClick={() => handleAddMoney(loan.id)}>Add Money</button>
        <button onClick={() => handleMakePayment(loan.id)}>Make Payment</button>
        <button onClick={() => handleExtendLoan(loan.id)}>Extend Loan</button>
        {/* ... etc */}
      </div>
    </div>
  );
};

// ============================================
// OPTION 2: Display in Loan List/Search Results
// ============================================
// Show quick state preview in each loan row:

export const LoanListItem = ({ loan }) => {
  const [state, setState] = useState(null);

  useEffect(() => {
    // Fetch loan state from API
    fetch(`/api/loans/${loan.id}/calculate-state`)
      .then(r => r.json())
      .then(data => setState(data.state))
      .catch(err => console.error('Error fetching state:', err));
  }, [loan.id]);

  if (!state) return null;

  return (
    <div className="loan-list-item">
      <div className="loan-id">#{loan.id}</div>
      <div className="customer-name">{loan.customer_name}</div>
      
      <div className="loan-amounts">
        <span className="balance" style={{color: state.isOverdue ? 'red' : 'green'}}>
          ${state.totalBalance.toFixed(2)}
        </span>
      </div>
      
      <div className="loan-status">
        {state.isOverdue ? (
          <span className="overdue">🔴 {state.daysOverdue} days overdue</span>
        ) : (
          <span className="current">✅ Current</span>
        )}
      </div>
      
      <div className="due-date">
        Due: {new Date(state.nextDueDate).toLocaleDateString()}
      </div>
    </div>
  );
};

// ============================================
// OPTION 3: Replace the Static Balance Display
// ============================================
// In your existing loan card/summary component, replace this:

// BEFORE (Static):
// const remainingBalance = loan.remaining_balance;
// <div>Remaining: ${remainingBalance}</div>

// AFTER (Dynamic):
import { useEffect, useState } from 'react';

const LoanSummaryCard = ({ loan }) => {
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const calculateState = async () => {
      try {
        const response = await fetch('/api/loans/calculate-state', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            loan: {
              loan_amount: loan.loan_amount,
              interest_rate: loan.interest_rate,
              created_at: loan.created_at,
              due_date: loan.due_date
            },
            payments: [] // In real scenario, include actual payments
          })
        });
        const data = await response.json();
        setState(data);
      } catch (err) {
        console.error('Error:', err);
      } finally {
        setLoading(false);
      }
    };

    calculateState();
  }, [loan]);

  if (loading) return <div>Loading...</div>;
  if (!state) return <div>Error loading loan state</div>;

  return (
    <div className="loan-card">
      <h3>Loan #{loan.id}</h3>
      
      {/* Show dynamic values instead of static database values */}
      <div className="amount-row">
        <span>Principal:</span>
        <strong>${state.principalRemaining.toFixed(2)}</strong>
      </div>
      
      <div className="amount-row">
        <span>Interest:</span>
        <strong>${state.interestAccrued.toFixed(2)}</strong>
      </div>
      
      {state.penaltyAccrued > 0 && (
        <div className="amount-row penalty">
          <span>Penalty:</span>
          <strong style={{color: 'red'}}>
            ${state.penaltyAccrued.toFixed(2)}
          </strong>
        </div>
      )}
      
      <div className="amount-row total">
        <span>Total Due:</span>
        <strong>${state.totalBalance.toFixed(2)}</strong>
      </div>
      
      <div className="due-date">
        Due: {state.nextDueDate}
        {state.isOverdue && (
          <span className="overdue">
            ({state.daysOverdue} days overdue)
          </span>
        )}
      </div>
    </div>
  );
};

// ============================================
// USAGE IN YOUR EXISTING CODE
// ============================================
/*
Replace in your SearchLoanForm.js or ViewCustomerLoansForm.js:

Instead of:
  <div>
    <p>Remaining Balance: ${loan.remaining_balance}</p>
    <p>Interest: ${loan.interest_amount}</p>
    <p>Due Date: {loan.due_date}</p>
  </div>

Use:
  <LoanStateDisplay 
    loan={loan}
    payments={paymentHistory}
  />

This will automatically calculate and display the correct values!
*/

// ============================================
// TESTING THE INTEGRATION
// ============================================
/*
Test with Loan #8 data from your screenshot:

const testLoan = {
  id: 8,
  loan_amount: 20000,
  interest_rate: 3,
  created_at: '2026-09-01',
  due_date: '2026-10-04'
};

const testPayments = [
  {
    payment_amount: 600,
    payment_date: '2026-06-02'
  }
];

Expected Results:
✅ Principal: $20,000.00
✅ Interest: $600.00 (3% on $20,000)
✅ Total Balance: $20,600.00
✅ Next Due Date: 2026-07-02
✅ Is Overdue: false

This matches your requirement!
*/

export default {
  ViewLoanDetails,
  LoanListItem,
  LoanSummaryCard
};
