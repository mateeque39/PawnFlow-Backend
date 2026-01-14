import React, { useState, useEffect } from 'react';
import { http } from './services/httpClient';
import { parseError, getErrorMessage } from './services/errorHandler';
import logger from './services/logger';

const ShiftManagement = ({ userId = 1 }) => {
  const [activeTab, setActiveTab] = useState('start-shift'); // 'start-shift', 'end-shift', 'history', 'today-summary', 'shift-report'
  const [openingBalance, setOpeningBalance] = useState('');
  const [closingBalance, setClosingBalance] = useState('');
  const [notes, setNotes] = useState('');
  const [cashToAdd, setCashToAdd] = useState('');
  const [cashAddNotes, setCashAddNotes] = useState('');
  const [currentShift, setCurrentShift] = useState(null);
  const [shiftHistory, setShiftHistory] = useState([]);
  const [todaySummary, setTodaySummary] = useState(null);
  const [shiftReport, setShiftReport] = useState(null);
  const [message, setMessage] = useState('');
  const [messageType, setMessageType] = useState(''); // 'success' or 'error'
  const [selectedShiftId, setSelectedShiftId] = useState('');

  // Fetch current shift on component mount
  useEffect(() => {
    fetchCurrentShift();
    fetchShiftHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const fetchCurrentShift = async () => {
    try {
      const response = await http.get(`/current-shift/${userId}`);
      // Get data from axios response
      const shiftData = response?.data;
      setCurrentShift(shiftData || null);
      if (shiftData) {
        logger.debug('Current shift fetched', { userId, shiftId: shiftData.id });
      } else {
        logger.debug('No active shift found', { userId });
      }
    } catch (error) {
      setCurrentShift(null);
      const parsedError = error.parsedError || parseError(error);
      if (parsedError.status === 404 || parsedError.status === 0) {
        // 404 or no response is expected when there's no active shift
        logger.debug('No active shift found', { userId });
      } else {
        logger.warn('Error fetching current shift', { status: parsedError.status, message: parsedError.message });
      }
    }
  };

  const fetchShiftHistory = async () => {
    try {
      const response = await http.get(`/shift-history/${userId}`);
      // Get data from axios response - should be an array
      const historyData = Array.isArray(response?.data) ? response.data : [];
      setShiftHistory(historyData);
      logger.debug('Shift history fetched', { userId, count: historyData.length });
    } catch (error) {
      const parsedError = error.parsedError || parseError(error);
      logger.error('Error fetching shift history - ' + parsedError.message, parsedError);
      setShiftHistory([]);
    }
  };

  const fetchTodaySummary = async () => {
    try {
      const response = await http.get(`/today-shift-summary/${userId}`);
      // Get data from axios response
      const summaryData = response?.data;
      setTodaySummary(summaryData);
      setMessage('');
      setMessageType('');
      logger.debug('Today summary fetched', { userId });
    } catch (error) {
      const parsedError = error.parsedError || parseError(error);
      const userMessage = error.userMessage || getErrorMessage(parsedError);
      
      // 404 is ok - just means no summary for today
      if (parsedError.status === 404) {
        logger.debug('No shift summary available for today', { userId });
        setTodaySummary(null);
      } else {
        setMessage(userMessage);
        setMessageType('error');
        setTodaySummary(null);
        logger.error('Error fetching today summary - ' + parsedError.message, parsedError);
      }
    }
  };

  const fetchShiftReport = async (shiftId) => {
    if (!shiftId) {
      setMessage('Please select a shift');
      setMessageType('error');
      return;
    }

    try {
      const response = await http.get(`/shift-report/${shiftId}`);
      // Get data from axios response
      const reportData = response?.data;
      setShiftReport(reportData);
      setMessage('');
      setMessageType('');
      logger.debug('Shift report fetched', { shiftId });
    } catch (error) {
      const parsedError = error.parsedError || parseError(error);
      const userMessage = error.userMessage || getErrorMessage(parsedError);
      setMessage(userMessage);
      setMessageType('error');
      setShiftReport(null);
      logger.error('Error fetching shift report - ' + parsedError.message, parsedError);
    }
  };

  const handleStartShift = async () => {
    if (openingBalance === '' || openingBalance === null || openingBalance === undefined || parseFloat(openingBalance) < 0) {
      setMessage('Please enter a valid opening balance');
      setMessageType('error');
      return;
    }

    try {
      const payload = {
        userId,
        openingBalance: parseFloat(openingBalance),
      };
      logger.debug('Starting shift with payload:', payload);
      
      const response = await http.post('/start-shift', payload);
      const responseData = response?.data || {};

      // Handle both direct response and response.data
      const shiftData = responseData?.shift || responseData;
      const message = responseData?.message || 'Shift started successfully!';
      
      setMessage(message);
      setMessageType('success');
      setOpeningBalance('');
      setCurrentShift(shiftData);
      fetchShiftHistory();
      logger.info('Shift started', { userId, openingBalance, shiftId: shiftData?.id });
    } catch (error) {
      const parsedError = error.parsedError || parseError(error);
      const userMessage = error.userMessage || getErrorMessage(parsedError);
      
      // If the error says "already has an active shift", create a placeholder shift state
      if (parsedError.message && parsedError.message.includes('already has an active shift')) {
        logger.warn('Active shift exists but not fetched, setting placeholder shift');
        // Set a placeholder shift so user can see the End Shift tab
        setCurrentShift({
          id: 'active',
          user_id: userId,
          is_active: true,
          opening_balance: openingBalance,
          shift_start_time: new Date().toISOString(),
          shift_end_time: null
        });
        setMessage('An active shift was found. You can now end it.');
        setMessageType('info');
      } else {
        setMessage(userMessage);
        setMessageType('error');
      }
      
      logger.error('Error starting shift - Status: ' + parsedError.status + ', Message: ' + parsedError.message, parsedError);
      // Refresh current shift state to sync with backend
      fetchCurrentShift();
    }
  };

  const handleEndShift = async () => {
    if (closingBalance === '' || closingBalance === null || closingBalance === undefined || parseFloat(closingBalance) < 0) {
      setMessage('Please enter a valid closing balance');
      setMessageType('error');
      return;
    }

    if (!currentShift) {
      setMessage('No active shift to end. Please start a shift first.');
      setMessageType('error');
      logger.warn('Attempted to end shift but no currentShift in state');
      return;
    }

    try {
      const payload = {
        userId,
        closingBalance: parseFloat(closingBalance),
        notes: notes || null,
        shiftId: currentShift?.id // Include shift ID if available
      };
      logger.debug('Ending shift with payload:', payload);
      
      const response = await http.post('/end-shift', payload);
      const responseData = response?.data || {};

      // Handle both direct response and response.data
      const message = responseData?.message || 'Shift ended successfully!';
      
      setMessage(message);
      setMessageType('success');
      setClosingBalance('');
      setNotes('');
      setCurrentShift(null);
      setOpeningBalance(''); // Also clear opening balance
      fetchShiftHistory();
      fetchTodaySummary();
      logger.info('Shift ended', { userId, closingBalance });
    } catch (error) {
      const parsedError = error.parsedError || parseError(error);
      const userMessage = error.userMessage || getErrorMessage(parsedError);
      setMessage(userMessage);
      setMessageType('error');
      logger.error('Error ending shift - Status: ' + parsedError.status + ', Message: ' + parsedError.message, parsedError);
      // Refresh current shift state to sync with backend
      fetchCurrentShift();
    }
  };

  const handleAddCash = async () => {
    if (!cashToAdd || parseFloat(cashToAdd) <= 0) {
      setMessage('Please enter a valid amount to add');
      setMessageType('error');
      return;
    }

    if (!currentShift) {
      setMessage('No active shift found. Please start a shift first.');
      setMessageType('error');
      return;
    }

    try {
      const payload = {
        userId,
        amount: parseFloat(cashToAdd),
        notes: cashAddNotes || 'Bank withdrawal'
      };
      logger.debug('Adding cash to shift with payload:', payload);
      
      const response = await http.post('/shift/add-cash', payload);
      const responseData = response?.data || {};

      setMessage(`✅ ${responseData.message || 'Cash added successfully!'} 
        Amount Added: $${responseData.amountAdded?.toFixed(2)} | 
        Total Cash Added This Shift: $${responseData.totalCashAdded?.toFixed(2)} | 
        Opening Balance: $${responseData.openingBalance?.toFixed(2)}`);
      setMessageType('success');
      setCashToAdd('');
      setCashAddNotes('');
      
      // Refresh shift data
      fetchCurrentShift();
      fetchTodaySummary();
      
      logger.info('Cash added to shift', { userId, amount: cashToAdd });
    } catch (error) {
      const parsedError = error.parsedError || parseError(error);
      const userMessage = error.userMessage || getErrorMessage(parsedError);
      setMessage(userMessage);
      setMessageType('error');
      logger.error('Error adding cash - Status: ' + parsedError.status + ', Message: ' + parsedError.message, parsedError);
    }
  };

  return (
    <div style={{ padding: '20px' }}>
      <h3>Shift Management</h3>

      {/* Tabs */}
      <div style={{ marginBottom: '20px', borderBottom: '2px solid #007bff' }}>
        <button
          onClick={() => setActiveTab('start-shift')}
          style={{
            padding: '10px 20px',
            marginRight: '5px',
            backgroundColor: activeTab === 'start-shift' ? '#007bff' : '#e9ecef',
            color: activeTab === 'start-shift' ? 'white' : 'black',
            border: 'none',
            cursor: 'pointer',
            borderRadius: '4px 4px 0 0',
          }}
        >
          Start Shift
        </button>
        <button
          onClick={() => setActiveTab('end-shift')}
          style={{
            padding: '10px 20px',
            marginRight: '5px',
            backgroundColor: activeTab === 'end-shift' ? '#007bff' : '#e9ecef',
            color: activeTab === 'end-shift' ? 'white' : 'black',
            border: 'none',
            cursor: 'pointer',
            borderRadius: '4px 4px 0 0',
          }}
        >
          End Shift
        </button>
        <button
          onClick={() => {
            setActiveTab('today-summary');
            fetchTodaySummary();
          }}
          style={{
            padding: '10px 20px',
            marginRight: '5px',
            backgroundColor: activeTab === 'today-summary' ? '#007bff' : '#e9ecef',
            color: activeTab === 'today-summary' ? 'white' : 'black',
            border: 'none',
            cursor: 'pointer',
            borderRadius: '4px 4px 0 0',
          }}
        >
          Today Summary
        </button>
        <button
          onClick={() => setActiveTab('history')}
          style={{
            padding: '10px 20px',
            marginRight: '5px',
            backgroundColor: activeTab === 'history' ? '#007bff' : '#e9ecef',
            color: activeTab === 'history' ? 'white' : 'black',
            border: 'none',
            cursor: 'pointer',
            borderRadius: '4px 4px 0 0',
          }}
        >
          Shift History
        </button>
        <button
          onClick={() => setActiveTab('shift-report')}
          style={{
            padding: '10px 20px',
            marginRight: '5px',
            backgroundColor: activeTab === 'shift-report' ? '#007bff' : '#e9ecef',
            color: activeTab === 'shift-report' ? 'white' : 'black',
            border: 'none',
            cursor: 'pointer',
            borderRadius: '4px 4px 0 0',
          }}
        >
          Shift Report
        </button>
        <button
          onClick={() => setActiveTab('add-cash')}
          style={{
            padding: '10px 20px',
            backgroundColor: activeTab === 'add-cash' ? '#007bff' : '#e9ecef',
            color: activeTab === 'add-cash' ? 'white' : 'black',
            border: 'none',
            cursor: 'pointer',
            borderRadius: '4px 4px 0 0',
          }}
        >
          Add Cash
        </button>
      </div>

      {/* Message Area */}
      {message && (
        <p
          style={{
            color: messageType === 'success' ? 'green' : 'red',
            padding: '10px',
            backgroundColor: messageType === 'success' ? '#d4edda' : '#f8d7da',
            borderRadius: '4px',
            marginBottom: '15px',
          }}
        >
          {message}
        </p>
      )}

      {/* START SHIFT TAB */}
      {activeTab === 'start-shift' && (
        <div style={{ border: '1px solid #ddd', padding: '15px', borderRadius: '4px' }}>
          <h4>Start New Shift</h4>

          {currentShift && (
            <p style={{ color: 'orange', marginBottom: '15px' }}>
              ⚠️ You already have an active shift. Please end the current shift first.
            </p>
          )}

          {!currentShift && (
            <div>
              <div style={{ marginBottom: '15px' }}>
                <label style={{ display: 'block', marginBottom: '5px' }}>
                  <strong>Opening Balance ($):</strong>
                </label>
                <input
                  type="number"
                  placeholder="Enter opening balance"
                  value={openingBalance}
                  onChange={(e) => setOpeningBalance(e.target.value)}
                  style={{
                    padding: '8px',
                    width: '100%',
                    maxWidth: '300px',
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              <button
                onClick={handleStartShift}
                style={{
                  padding: '10px 20px',
                  backgroundColor: '#28a745',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontSize: '14px',
                }}
              >
                Start Shift
              </button>
            </div>
          )}
        </div>
      )}

      {/* END SHIFT TAB */}
      {activeTab === 'end-shift' && (
        <div style={{ border: '1px solid #ddd', padding: '15px', borderRadius: '4px' }}>
          <h4>End Shift</h4>

          {!currentShift && (
            <p style={{ color: 'orange' }}>
              ⚠️ No active shift found. Please start a shift first.
            </p>
          )}

          {currentShift && (
            <div>
              <div style={{ marginBottom: '10px', backgroundColor: '#f0f0f0', padding: '10px', borderRadius: '4px' }}>
                <p>
                  <strong>Shift Started:</strong>{' '}
                  {new Date(currentShift.shift_start_time).toLocaleString()}
                </p>
                <p>
                  <strong>Opening Balance:</strong> ${' '}
                  {parseFloat(currentShift.opening_balance).toFixed(2)}
                </p>
              </div>

              <div style={{ marginBottom: '15px' }}>
                <label style={{ display: 'block', marginBottom: '5px' }}>
                  <strong>Closing Balance ($):</strong>
                </label>
                <input
                  type="number"
                  placeholder="Enter closing balance"
                  value={closingBalance}
                  onChange={(e) => setClosingBalance(e.target.value)}
                  style={{
                    padding: '8px',
                    width: '100%',
                    maxWidth: '300px',
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              <div style={{ marginBottom: '15px' }}>
                <label style={{ display: 'block', marginBottom: '5px' }}>
                  <strong>Notes (Optional):</strong>
                </label>
                <textarea
                  placeholder="Add any notes about the shift"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  style={{
                    padding: '8px',
                    width: '100%',
                    maxWidth: '300px',
                    boxSizing: 'border-box',
                    minHeight: '80px',
                  }}
                />
              </div>

              <button
                onClick={handleEndShift}
                style={{
                  padding: '10px 20px',
                  backgroundColor: '#dc3545',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontSize: '14px',
                }}
              >
                End Shift
              </button>
            </div>
          )}
        </div>
      )}

      {/* TODAY SUMMARY TAB */}
      {activeTab === 'today-summary' && (
        <div style={{ border: '1px solid #ddd', padding: '15px', borderRadius: '4px' }}>
          <h4>Today's Shift Summary</h4>

          {todaySummary && (
            <div>
              <div style={{ marginBottom: '20px', backgroundColor: '#2c3e50', padding: '15px', borderRadius: '4px', color: '#fff' }}>
                <h5 style={{ color: '#fff', marginTop: 0 }}>Shift Details</h5>
                <p>
                  <strong>Shift Started:</strong>{' '}
                  {new Date(todaySummary.shift.shift_start_time).toLocaleString()}
                </p>
                <p>
                  <strong>Status:</strong>{' '}
                  {todaySummary.shiftClosed ? 'Closed' : 'Active'}
                </p>
              </div>

              {todaySummary.currentStats && (
                <div style={{ marginBottom: '20px', backgroundColor: '#2c3e50', padding: '15px', borderRadius: '4px', color: '#fff' }}>
                  <h5 style={{ color: '#fff', marginTop: 0 }}>Current Statistics</h5>
                  <p>
                    <strong>Opening Balance:</strong> ${' '}
                    {parseFloat(todaySummary.currentStats.openingBalance).toFixed(2)}
                  </p>
                  <p>
                    <strong>Total Payments Received:</strong> ${' '}
                    {parseFloat(todaySummary.currentStats.totalPaymentsReceived).toFixed(2)}
                  </p>
                  <p>
                    <strong>Total Loans Given:</strong> ${' '}
                    {parseFloat(todaySummary.currentStats.totalLoansGiven).toFixed(2)}
                  </p>
                  <p>
                    <strong>Expected Balance:</strong> ${' '}
                    {parseFloat(todaySummary.currentStats.expectedBalance).toFixed(2)}
                  </p>
                  <p>
                    <strong>Payment Count:</strong> {todaySummary.currentStats.paymentCount}
                  </p>
                  <p>
                    <strong>Loan Count:</strong> {todaySummary.currentStats.loanCount}
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* SHIFT HISTORY TAB */}
      {activeTab === 'history' && (
        <div style={{ border: '1px solid #ddd', padding: '15px', borderRadius: '4px' }}>
          <h4>Shift History</h4>

          {shiftHistory.length > 0 ? (
            <div>
              {shiftHistory.map((shift) => (
                <div
                  key={shift.id}
                  style={{
                    marginBottom: '15px',
                    backgroundColor: '#2c3e50',
                    padding: '12px',
                    borderRadius: '4px',
                    border: '1px solid #444',
                    color: '#fff'
                  }}
                >
                  <p>
                    <strong>Shift ID:</strong> {shift.id}
                  </p>
                  <p>
                    <strong>Started:</strong> {new Date(shift.shift_start_time).toLocaleString()}
                  </p>
                  <p>
                    <strong>Ended:</strong>{' '}
                    {shift.shift_end_time
                      ? new Date(shift.shift_end_time).toLocaleString()
                      : 'Active'}
                  </p>
                  <p>
                    <strong>Opening Balance:</strong> ${' '}
                    {parseFloat(shift.opening_balance).toFixed(2)}
                  </p>
                  {shift.closing_balance !== null && (
                    <>
                      <p>
                        <strong>Closing Balance:</strong> ${' '}
                        {parseFloat(shift.closing_balance).toFixed(2)}
                      </p>
                      <p>
                        <strong>Total Payments:</strong> ${' '}
                        {parseFloat(shift.total_payments_received || 0).toFixed(2)}
                      </p>
                      <p>
                        <strong>Total Loans:</strong> ${' '}
                        {parseFloat(shift.total_loans_given || 0).toFixed(2)}
                      </p>
                      <p>
                        <strong>Status:</strong>{' '}
                        <span
                          style={{
                            color: shift.is_balanced ? 'green' : 'red',
                            fontWeight: 'bold',
                          }}
                        >
                          {shift.is_balanced ? 'BALANCED' : 'DISCREPANCY'}
                        </span>
                      </p>
                      {!shift.is_balanced && (
                        <p>
                          <strong>Difference:</strong> ${' '}
                          {parseFloat(shift.difference).toFixed(2)}
                        </p>
                      )}
                    </>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p>No shift history found.</p>
          )}
        </div>
      )}

      {/* SHIFT REPORT TAB */}
      {activeTab === 'shift-report' && (
        <div style={{ border: '1px solid #ddd', padding: '15px', borderRadius: '4px' }}>
          <h4>Shift Report</h4>

          <div style={{ marginBottom: '15px' }}>
            <label style={{ display: 'block', marginBottom: '5px' }}>
              <strong>Select Shift:</strong>
            </label>
            <select
              value={selectedShiftId}
              onChange={(e) => setSelectedShiftId(e.target.value)}
              style={{
                padding: '8px',
                width: '100%',
                maxWidth: '300px',
                boxSizing: 'border-box',
              }}
            >
              <option value="">Choose a shift...</option>
              {shiftHistory.map((shift) => (
                <option key={shift.id} value={shift.id}>
                  Shift {shift.id} -{' '}
                  {new Date(shift.shift_start_time).toLocaleDateString()}
                </option>
              ))}
            </select>
          </div>

          <button
            onClick={() => fetchShiftReport(selectedShiftId)}
            style={{
              padding: '10px 20px',
              backgroundColor: '#007bff',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '14px',
              marginBottom: '15px',
            }}
          >
            Generate Report
          </button>

          {shiftReport && (
            <div>
              <div style={{ marginBottom: '20px', backgroundColor: '#2c3e50', padding: '15px', borderRadius: '4px', color: '#fff' }}>
                <h5 style={{ color: '#fff', marginTop: 0 }}>Shift Summary</h5>
                <p style={{ color: '#fff', margin: '8px 0' }}>
                  <strong>Total Transactions:</strong> {shiftReport.summary.totalTransactions}
                </p>
                <p style={{ color: '#fff', margin: '8px 0' }}>
                  <strong>Payment Transactions:</strong>{' '}
                  {shiftReport.summary.totalPaymentTransactions}
                </p>
                <p style={{ color: '#fff', margin: '8px 0' }}>
                  <strong>Loans Created:</strong> {shiftReport.summary.totalLoansCreated}
                </p>
              </div>

              {shiftReport.payments.length > 0 && (
                <div className="shift-report-section" style={{ marginBottom: '20px', backgroundColor: '#2c3e50', padding: '15px', borderRadius: '4px', color: '#fff' }}>
                  <h5 style={{ color: '#fff', marginTop: 0 }}>Payments During Shift</h5>
                  <ul style={{ listStyle: 'none', padding: 0 }}>
                    {shiftReport.payments.map((payment) => (
                      <li
                        key={payment.id}
                        style={{
                          padding: '8px',
                          marginBottom: '5px',
                          color: '#000',
                          backgroundColor: 'transparent',
                          borderBottom: '1px solid #444'
                        }}
                      >
                        <strong>{payment.customer_name}</strong> - ${' '}
                        {parseFloat(payment.payment_amount).toFixed(2)} (
                        {payment.payment_method}) - Txn:{' '}
                        {payment.transaction_number}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {shiftReport.loansCreated.length > 0 && (
                <div className="shift-report-section" style={{ backgroundColor: '#2c3e50', padding: '15px', borderRadius: '4px', color: '#fff' }}>
                  <h5 style={{ color: '#fff', marginTop: 0 }}>Loans Created During Shift</h5>
                  <ul style={{ listStyle: 'none', padding: 0 }}>
                    {shiftReport.loansCreated.map((loan) => (
                      <li
                        key={loan.id}
                        style={{
                          padding: '8px',
                          marginBottom: '5px',
                          color: '#000',
                          backgroundColor: 'transparent',
                          borderBottom: '1px solid #444'
                        }}
                      >
                        <strong>{loan.customer_name}</strong> - ${' '}
                        {parseFloat(loan.loan_amount).toFixed(2)} - Txn:{' '}
                        {loan.transaction_number}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ADD CASH TAB */}
      {activeTab === 'add-cash' && (
        <div style={{ border: '1px solid #ddd', padding: '15px', borderRadius: '4px' }}>
          <h4>Add Cash to Shift</h4>

          {!currentShift && (
            <p style={{ color: 'orange' }}>
              ⚠️ No active shift found. Please start a shift first.
            </p>
          )}

          {currentShift && (
            <div>
              <div style={{ marginBottom: '10px', backgroundColor: '#f0f0f0', padding: '10px', borderRadius: '4px' }}>
                <p>
                  <strong>Shift Started:</strong>{' '}
                  {new Date(currentShift.shift_start_time).toLocaleString()}
                </p>
                <p>
                  <strong>Opening Balance:</strong> ${' '}
                  {parseFloat(currentShift.opening_balance).toFixed(2)}
                </p>
              </div>

              <div style={{ marginBottom: '15px' }}>
                <label style={{ display: 'block', marginBottom: '5px' }}>
                  <strong>Cash Amount to Add ($):</strong>
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder="Enter amount"
                  value={cashToAdd}
                  onChange={(e) => setCashToAdd(e.target.value)}
                  style={{
                    padding: '8px',
                    width: '100%',
                    maxWidth: '300px',
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              <div style={{ marginBottom: '15px' }}>
                <label style={{ display: 'block', marginBottom: '5px' }}>
                  <strong>Notes (Optional):</strong>
                </label>
                <textarea
                  placeholder="e.g., Bank withdrawal, cash deposit, etc."
                  value={cashAddNotes}
                  onChange={(e) => setCashAddNotes(e.target.value)}
                  style={{
                    padding: '8px',
                    width: '100%',
                    maxWidth: '300px',
                    boxSizing: 'border-box',
                    minHeight: '80px',
                  }}
                />
              </div>

              <button
                onClick={handleAddCash}
                style={{
                  padding: '10px 20px',
                  backgroundColor: '#28a745',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontSize: '14px',
                }}
              >
                Add Cash
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ShiftManagement;
