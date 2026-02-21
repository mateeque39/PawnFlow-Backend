import React, { useState, useEffect } from 'react';
import { http } from './services/httpClient';
import logger from './services/logger';
import './LoansOverview.css';

const LoansOverview = ({ loggedInUser }) => {
  const [allLoans, setAllLoans] = useState([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [messageType, setMessageType] = useState('');
  const [overdueLoans, setOverdueLoans] = useState([]);
  const [activeLoans, setActiveLoans] = useState([]);
  const [selectedTab, setSelectedTab] = useState('overdue');

  // Fetch all loans from the API
  const fetchAllLoans = async () => {
    setLoading(true);
    setMessage('');

    try {
      logger.info('Fetching all loans from /api/loans...');
      const response = await http.get('/api/loans');

      logger.info('Loans fetched successfully', {
        totalLoans: response.data?.loans?.length,
        overdueCount: response.data?.overdueCount
      });

      const loans = response.data?.loans || [];
      setAllLoans(loans);

      // Split into overdue and active
      const overdue = loans.filter(l => l.isOverdue).sort((a, b) => {
        // Sort by due date, oldest first
        const dateA = new Date(a.due_date).getTime();
        const dateB = new Date(b.due_date).getTime();
        return dateA - dateB;
      });

      const active = loans.filter(l => !l.isOverdue).sort((a, b) => {
        // Sort by due date, soonest first
        const dateA = a.due_date ? new Date(a.due_date).getTime() : Infinity;
        const dateB = b.due_date ? new Date(b.due_date).getTime() : Infinity;
        return dateA - dateB;
      });

      setOverdueLoans(overdue);
      setActiveLoans(active);

      setMessage(`✅ Loaded ${loans.length} total loans (${overdue.length} overdue)`);
      setMessageType('success');

      // Auto-switch to overdue tab if there are overdue loans
      if (overdue.length > 0) {
        setSelectedTab('overdue');
      }
    } catch (error) {
      logger.error('Error fetching loans:', error);
      const errorMsg = error?.userMessage || error?.message || 'Error loading loans';
      setMessage(`❌ ${errorMsg}`);
      setMessageType('error');
    } finally {
      setLoading(false);
    }
  };

  // Fetch on component mount
  useEffect(() => {
    fetchAllLoans();
  }, []);

  // Format date for display
  const formatDate = (dateString) => {
    if (!dateString) return 'N/A';
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  };

  // Format currency
  const formatCurrency = (amount) => {
    if (!amount) return '$0.00';
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD'
    }).format(amount);
  };

  // Render a loan card
  const renderLoanCard = (loan, isOverdue = false) => {
    const customerName = loan.first_name || loan.last_name 
      ? `${loan.first_name || ''} ${loan.last_name || ''}`.trim()
      : loan.customer_name || 'Unknown Customer';

    const collateral = loan.collateral_description || loan.item_description || 'N/A';

    return (
      <div key={loan.id} className="loan-card">
        <div className="loan-card-header">
          <div className="loan-title">
            <h4>{customerName}</h4>
            {isOverdue && (
              <span className="overdue-badge">
                ⚠️ {loan.daysOverdue} days overdue
              </span>
            )}
          </div>
          <span className="transaction-number">#{loan.transaction_number || loan.id}</span>
        </div>

        <div className="loan-card-body">
          <div className="loan-row">
            <span className="label">Loan Amount:</span>
            <span className="value">{formatCurrency(loan.loan_amount)}</span>
          </div>

          {loan.remaining_balance !== null && loan.remaining_balance !== undefined && (
            <div className="loan-row">
              <span className="label">Remaining Balance:</span>
              <span className="value">{formatCurrency(loan.remaining_balance)}</span>
            </div>
          )}

          <div className="loan-row">
            <span className="label">Issued Date:</span>
            <span className="value">{formatDate(loan.loan_issued_date)}</span>
          </div>

          {loan.due_date && (
            <div className="loan-row">
              <span className="label">Due Date:</span>
              <span className={`value ${isOverdue ? 'overdue-date' : ''}`}>
                {formatDate(loan.due_date)}
              </span>
            </div>
          )}

          <div className="loan-row">
            <span className="label">Collateral:</span>
            <span className="value">{collateral}</span>
          </div>

          <div className="loan-row">
            <span className="label">Status:</span>
            <span className={`value status-badge status-${loan.status?.toLowerCase()}`}>
              {loan.status?.toUpperCase() || 'ACTIVE'}
            </span>
          </div>

          {loan.email && (
            <div className="loan-row">
              <span className="label">Email:</span>
              <span className="value">{loan.email}</span>
            </div>
          )}

          {loan.mobile_phone && (
            <div className="loan-row">
              <span className="label">Mobile:</span>
              <span className="value">{loan.mobile_phone}</span>
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="loans-overview">
      <div className="overview-header">
        <h3>📊 Loans Overview</h3>
        <button 
          className="btn-refresh" 
          onClick={fetchAllLoans}
          disabled={loading}
        >
          {loading ? '⏳ Loading...' : '🔄 Refresh'}
        </button>
      </div>

      {message && (
        <div className={`message message-${messageType}`}>
          {message}
        </div>
      )}

      {!loading && (overdueLoans.length > 0 || activeLoans.length > 0) && (
        <>
          <div className="tabs">
            <button
              className={`tab-button ${selectedTab === 'overdue' ? 'active' : ''}`}
              onClick={() => setSelectedTab('overdue')}
            >
              🔴 Overdue ({overdueLoans.length})
            </button>
            <button
              className={`tab-button ${selectedTab === 'active' ? 'active' : ''}`}
              onClick={() => setSelectedTab('active')}
            >
              ✅ Active ({activeLoans.length})
            </button>
          </div>

          <div className="loans-container">
            {selectedTab === 'overdue' ? (
              <>
                {overdueLoans.length > 0 ? (
                  <div className="loans-section">
                    <h4 className="section-title">⚠️ Overdue Loans</h4>
                    <p className="section-subtitle">
                      {overdueLoans.length} loan{overdueLoans.length !== 1 ? 's' : ''} past due date
                    </p>
                    <div className="loans-grid">
                      {overdueLoans.map(loan => renderLoanCard(loan, true))}
                    </div>
                  </div>
                ) : (
                  <div className="no-loans">
                    <p>✅ No overdue loans!</p>
                  </div>
                )}
              </>
            ) : (
              <>
                {activeLoans.length > 0 ? (
                  <div className="loans-section">
                    <h4 className="section-title">✅ Active Loans</h4>
                    <p className="section-subtitle">
                      {activeLoans.length} active loan{activeLoans.length !== 1 ? 's' : ''}
                    </p>
                    <div className="loans-grid">
                      {activeLoans.map(loan => renderLoanCard(loan, false))}
                    </div>
                  </div>
                ) : (
                  <div className="no-loans">
                    <p>No active loans.</p>
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}

      {!loading && allLoans.length === 0 && (
        <div className="no-loans">
          <p>No loans found in the database.</p>
        </div>
      )}

      {loading && (
        <div className="loading">
          <p>Loading loans...</p>
        </div>
      )}
    </div>
  );
};

export default LoansOverview;
