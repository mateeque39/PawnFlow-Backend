import React, { useState, useEffect } from 'react';
import { http } from './services/httpClient';
import { parseError, getErrorMessage } from './services/errorHandler';
import logger from './services/logger';
import SearchCustomerProfileForm from './SearchCustomerProfileForm';

const ViewCustomerLoansForm = ({ loggedInUser }) => {
  const [selectedProfile, setSelectedProfile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [messageType, setMessageType] = useState('');
  const [profileLoans, setProfileLoans] = useState({
    active: [],
    redeemed: [],
    forfeited: [],
    overdue: [],
    extended: []
  });
  const [activeTab, setActiveTab] = useState('active');
  const [editingAddress, setEditingAddress] = useState(false);
  const [addressForm, setAddressForm] = useState({
    streetAddress: '',
    city: '',
    state: '',
    zipcode: ''
  });

  // Helper function to get field value with fallbacks for different naming conventions
  const getFieldValue = (obj, ...keys) => {
    for (const key of keys) {
      if (obj && obj[key] !== undefined && obj[key] !== null && obj[key] !== '') {
        return obj[key];
      }
    }
    return null;
  };

  // Helper function to format date strings properly (handles YYYY-MM-DD format from backend)
  const formatDateString = (dateString) => {
    if (!dateString) return 'N/A';
    
    // If it's already in YYYY-MM-DD format, parse it directly without timezone conversion
    if (typeof dateString === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
      const [year, month, day] = dateString.split('-');
      return new Date(year, parseInt(month) - 1, day).toLocaleDateString();
    }
    
    // Otherwise use standard Date parsing
    return new Date(dateString).toLocaleDateString();
  };

  const handleProfileSelect = async (profile) => {
    // Normalize profile data to handle different field naming conventions from backend
    const normalizedProfile = {
      id: getFieldValue(profile, 'id', 'customerId', 'customer_id') || profile.id,
      firstName: getFieldValue(profile, 'firstName', 'first_name', 'firstname') || 'N/A',
      lastName: getFieldValue(profile, 'lastName', 'last_name', 'lastname') || 'N/A',
      homePhone: getFieldValue(profile, 'homePhone', 'home_phone', 'phone') || '',
      mobilePhone: getFieldValue(profile, 'mobilePhone', 'mobile_phone', 'mobile') || '',
      email: getFieldValue(profile, 'email', 'email_address') || '',
      streetAddress: getFieldValue(profile, 'streetAddress', 'street_address', 'address_street', 'street') || '',
      city: getFieldValue(profile, 'city', 'city_name') || '',
      state: getFieldValue(profile, 'state', 'state_code') || '',
      zipcode: getFieldValue(profile, 'zipcode', 'zip_code', 'postal_code') || '',
      birthdate: getFieldValue(profile, 'birthdate', 'birth_date', 'dateOfBirth', 'date_of_birth') || '',
      idType: getFieldValue(profile, 'idType', 'id_type', 'identificationType') || '',
      idNumber: getFieldValue(profile, 'idNumber', 'id_number', 'identification_number') || '',
      createdAt: getFieldValue(profile, 'createdAt', 'created_at') || new Date().toISOString()
    };

    setSelectedProfile(normalizedProfile);
    setLoading(true);
    try {
      logger.info(`Fetching loans for customer ${profile.id}...`);
      
      // Fetch all loans for this customer
      const response = await http.get(`/customers/${profile.id}/loans`, {
        params: { _ts: Date.now() }
      });

      console.log('DEBUG: Full API Response:', JSON.stringify(response.data, null, 2));
      
      logger.info('API response received', { 
        activeLoans: response.data?.activeLoans?.length, 
        redeemedLoans: response.data?.redeemedLoans?.length,
        forfeitedLoans: response.data?.forfeitedLoans?.length,
        overdueLoans: response.data?.overdueLoans?.length,
        hasData: !!response?.data
      });

      // Backend already returns categorized loans
      let categorized = {
        active: [],
        redeemed: [],
        forfeited: [],
        extended: []
      };

      // Helper to normalize loan field names
      const normalizeLoan = (loan) => {
        const amount = parseFloat(loan.loan_amount || loan.loanAmount || 0);
        const rate = parseFloat(loan.interest_rate || loan.interestRate || 0);
        let interest = parseFloat(loan.interest_amount || loan.interestAmount || 0);
        
        // If interest_amount is not provided by backend, calculate it
        if (interest === 0 && amount > 0 && rate > 0) {
          interest = (amount * rate) / 100;
        }
        
        const totalPayable = parseFloat(loan.total_payable_amount || loan.totalPayableAmount || 0);
        const balance = parseFloat(loan.remaining_balance || loan.remainingBalance || 0);
        
        return {
          id: loan.id,
          loanAmount: amount,
          interestRate: rate,
          interestAmount: interest,
          totalPayableAmount: totalPayable,
          remainingBalance: balance,
          createdAt: loan.loan_issued_date || loan.createdAt || loan.created_at,
          dueDate: loan.due_date || loan.dueDate,
          status: loan.status,
          transactionNumber: loan.transaction_number || loan.transactionNumber,
          itemDescription: loan.item_description || loan.itemDescription,
          ...loan
        };
      };

      if (response?.data) {
        // If backend returns grouped format (activeLoans, redeemedLoans, etc.)
        if (response.data.activeLoans || response.data.redeemedLoans) {
          categorized = {
            active: (response.data.activeLoans || []).map(normalizeLoan),
            redeemed: (response.data.redeemedLoans || []).map(normalizeLoan),
            forfeited: (response.data.forfeitedLoans || []).map(normalizeLoan),
            overdue: (response.data.overdueLoans || []).map(normalizeLoan),
            extended: [] // Backend doesn't have separate 'extended' status
          };
        } else {
          // Fallback: if response is flat array, categorize it
          const loans = Array.isArray(response.data) ? response.data : [];
          categorized = {
            active: loans.filter(l => l.status === 'active' || l.status === 'ACTIVE').map(normalizeLoan),
            redeemed: loans.filter(l => l.status === 'redeemed' || l.status === 'REDEEMED').map(normalizeLoan),
            forfeited: loans.filter(l => l.status === 'forfeited' || l.status === 'FORFEITED').map(normalizeLoan),
            overdue: loans.filter(l => l.status === 'overdue' || l.status === 'OVERDUE').map(normalizeLoan),
            extended: loans.filter(l => l.status === 'extended' || l.status === 'EXTENDED').map(normalizeLoan)
          };
        }
      }

      setProfileLoans(categorized);
      
      console.log('DEBUG: Categorized loans:', {
        active: categorized.active?.length || 0,
        redeemed: categorized.redeemed?.length || 0,
        forfeited: categorized.forfeited?.length || 0,
        overdue: categorized.overdue?.length || 0,
        extended: categorized.extended?.length || 0
      });
      
      logger.info('Loans categorized successfully', {
        active: categorized.active.length,
        redeemed: categorized.redeemed.length,
        forfeited: categorized.forfeited.length,
        overdue: categorized.overdue.length,
        extended: categorized.extended.length
      });
      
      // Extract address information from the first available loan
      const allLoans = [
        ...(categorized.active || []),
        ...(categorized.redeemed || []),
        ...(categorized.forfeited || []),
        ...(categorized.overdue || []),
        ...(categorized.extended || [])
      ];
      
      if (allLoans.length > 0) {
        const firstLoan = allLoans[0];
        // Update the profile with address info from the loan if not already present
        if (!normalizedProfile.streetAddress || normalizedProfile.streetAddress === '') {
          normalizedProfile.streetAddress = firstLoan.street_address || firstLoan.streetAddress || '';
        }
        if (!normalizedProfile.city || normalizedProfile.city === '') {
          normalizedProfile.city = firstLoan.city || '';
        }
        if (!normalizedProfile.state || normalizedProfile.state === '') {
          normalizedProfile.state = firstLoan.state || '';
        }
        if (!normalizedProfile.zipcode || normalizedProfile.zipcode === '') {
          normalizedProfile.zipcode = firstLoan.zipcode || '';
        }
        setSelectedProfile({ ...normalizedProfile });
      }
      
      setMessage('');
      setMessageType('');
      const totalLoans = (categorized.active?.length || 0) + (categorized.redeemed?.length || 0) + (categorized.forfeited?.length || 0) + (categorized.overdue?.length || 0);
      logger.info('Customer loans loaded', { customerId: profile.id, totalLoans });
    } catch (error) {
      const parsedError = error.parsedError || parseError(error);
      const userMessage = error.userMessage || getErrorMessage(parsedError);
      setMessage(userMessage);
      setMessageType('error');
      logger.error('Error loading customer loans', parsedError);
    } finally {
      setLoading(false);
    }
  };

  const handleEditAddressClick = () => {
    setAddressForm({
      streetAddress: selectedProfile.streetAddress || '',
      city: selectedProfile.city || '',
      state: selectedProfile.state || '',
      zipcode: selectedProfile.zipcode || ''
    });
    setEditingAddress(true);
  };

  const handleSaveAddress = async () => {
    try {
      await http.put(`/customers/${selectedProfile.id}`, addressForm);
      setSelectedProfile({
        ...selectedProfile,
        streetAddress: addressForm.streetAddress,
        city: addressForm.city,
        state: addressForm.state,
        zipcode: addressForm.zipcode
      });
      setEditingAddress(false);
      setMessage('Address updated successfully!');
      setMessageType('success');
      setTimeout(() => setMessage(''), 3000);
      logger.info('Customer address updated', { customerId: selectedProfile.id });
    } catch (error) {
      const parsedError = error.parsedError || parseError(error);
      const userMessage = error.userMessage || getErrorMessage(parsedError);
      setMessage(`Error updating address: ${userMessage}`);
      setMessageType('error');
      logger.error('Error updating address', parsedError);
    }
  };

  // Handler to download loan receipt PDF
  const handleDownloadReceipt = async (loan) => {
    try {
      logger.debug('Downloading receipt for loan:', { loanId: loan.id });
      
      // Make request to backend to get PDF
      const response = await http.get(`/api/loans/${loan.id}/receipt`, {
        responseType: 'blob'
      });

      // Create blob and download
      const blob = new Blob([response.data], { type: 'application/pdf' });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `loan_receipt_${loan.transactionNumber || loan.id}.pdf`;
      document.body.appendChild(link);
      link.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(link);

      setMessage('Receipt downloaded successfully!');
      setMessageType('success');
      setTimeout(() => setMessage(''), 3000);
      logger.info('Receipt downloaded successfully', { loanId: loan.id });
    } catch (error) {
      console.log('[RECEIPT_ERROR] Caught error:', { 
        hasBlobError: error.isBlobError,
        dataType: typeof error.response?.data,
        isBlob: error.response?.data instanceof Blob,
        status: error.response?.status
      });
      
      logger.error('Download receipt - caught error:', error);
      
      // If this is a blob error from the httpClient interceptor
      if (error.isBlobError && error.response?.data instanceof Blob) {
        console.log('[RECEIPT_ERROR] Processing blob error...');
        const blob = error.response.data;
        console.log('[RECEIPT_ERROR] Blob size:', blob.size, 'bytes');
        
        const reader = new FileReader();
        reader.onload = () => {
          try {
            const text = reader.result;
            console.log('[RECEIPT_ERROR] Blob text:', text);
            const errorData = JSON.parse(text);
            const msg = errorData.message || errorData.error || 'Unknown error';
            console.log('[RECEIPT_ERROR] Parsed message:', msg);
            setMessage(`Error downloading receipt: ${msg}`);
            setMessageType('error');
          } catch (parseErr) {
            console.log('[RECEIPT_ERROR] Parse failed:', parseErr);
            setMessage(`Error downloading receipt: ${reader.result || 'Unknown error'}`);
            setMessageType('error');
          }
        };
        reader.onerror = () => {
          console.log('[RECEIPT_ERROR] FileReader error');
          setMessage('Error downloading receipt: Unable to read response');
          setMessageType('error');
        };
        console.log('[RECEIPT_ERROR] Starting FileReader...');
        reader.readAsText(blob);
        return;
      }
      
      // Standard error handling
      const parsedError = error.parsedError || parseError(error);
      const userMessage = error.userMessage || getErrorMessage(parsedError);
      console.log('[RECEIPT_ERROR] Standard error - message:', userMessage);
      setMessage(`Error downloading receipt: ${userMessage}`);
      setMessageType('error');
      logger.error('Error downloading receipt', { status: parsedError.status, message: parsedError.message });
    }
  };

  if (!selectedProfile) {
    return <SearchCustomerProfileForm loggedInUser={loggedInUser} onProfileSelect={handleProfileSelect} />;
  }

  const loanCounts = {
    active: profileLoans.active.length,
    redeemed: profileLoans.redeemed.length,
    forfeited: profileLoans.forfeited.length,
    overdue: profileLoans.overdue.length,
    extended: profileLoans.extended.length
  };

  const getActiveLoans = () => {
    switch (activeTab) {
      case 'active':
        return profileLoans.active;
      case 'redeemed':
        return profileLoans.redeemed;
      case 'forfeited':
        return profileLoans.forfeited;
      case 'overdue':
        return profileLoans.overdue;
      case 'extended':
        return profileLoans.extended;
      default:
        return [];
    }
  };

  const getStatusColor = (status) => {
    switch (status?.toLowerCase()) {
      case 'active':
        return '#28a745';
      case 'redeemed':
        return '#6c757d';
      case 'forfeited':
        return '#dc3545';
      case 'overdue':
        return '#ff6b6b';
      case 'extended':
        return '#ffc107';
      default:
        return '#667eea';
    }
  };

  const getLoanSummaryStats = () => {
    const totalAmount = profileLoans.active.reduce((sum, loan) => sum + (loan.loanAmount || 0), 0);
    const totalInterest = profileLoans.active.reduce((sum, loan) => sum + (loan.interest || 0), 0);
    return { totalAmount, totalInterest };
  };

  const stats = getLoanSummaryStats();

  return (
    <div className="form-container">
      <div style={{ backgroundColor: '#ff0000', color: 'white', padding: '10px', marginBottom: '10px', fontWeight: 'bold', textAlign: 'center' }}>
        🔴 BUILD V4 - FIXED CACHING - If you see this, NEW CODE IS RUNNING
      </div>
      <h3>Customer Profile & Loan History</h3>

      {/* Message Area */}
      {message && (
        <div className={`alert alert-${messageType}`} style={{ marginBottom: '20px' }}>
          {message}
        </div>
      )}

      {/* Profile Card */}
      <div className="card" style={{ marginBottom: '20px' }}>
        <div className="card-header">Customer Profile</div>
        <div style={{ padding: '20px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginBottom: '20px' }}>
            <div>
              <p style={{ margin: '5px 0' }}>
                <strong>Name:</strong> {selectedProfile.firstName !== 'N/A' || selectedProfile.lastName !== 'N/A' ? `${selectedProfile.firstName} ${selectedProfile.lastName}` : 'N/A'}
              </p>
              <p style={{ margin: '5px 0' }}>
                <strong>Customer ID:</strong> {selectedProfile.id}
              </p>
              <p style={{ margin: '5px 0' }}>
                <strong>Home Phone:</strong> {selectedProfile.homePhone || 'N/A'}
              </p>
              <p style={{ margin: '5px 0' }}>
                <strong>Mobile Phone:</strong> {selectedProfile.mobilePhone || 'N/A'}
              </p>
              <p style={{ margin: '5px 0' }}>
                <strong>Email:</strong> {selectedProfile.email || 'N/A'}
              </p>
            </div>
            <div>
              <p style={{ margin: '5px 0' }}>
                <strong>Address:</strong>{' '}
                {selectedProfile.streetAddress && selectedProfile.streetAddress !== 'N/A'
                  ? `${selectedProfile.streetAddress}${selectedProfile.city ? ', ' + selectedProfile.city : ''}${selectedProfile.state ? ', ' + selectedProfile.state : ''}${selectedProfile.zipcode ? ' ' + selectedProfile.zipcode : ''}`
                  : 'N/A'}
                {' '}
                <button
                  onClick={handleEditAddressClick}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: '#0066cc',
                    cursor: 'pointer',
                    textDecoration: 'underline',
                    padding: '0',
                    fontSize: '12px',
                    marginLeft: '10px'
                  }}
                >
                  (Edit)
                </button>
              </p>
              <p style={{ margin: '5px 0' }}>
                <strong>Birthdate:</strong> {selectedProfile.birthdate || 'N/A'}
              </p>
              <p style={{ margin: '5px 0' }}>
                <strong>ID Type:</strong> {selectedProfile.idType || 'N/A'}
              </p>
              <p style={{ margin: '5px 0' }}>
                <strong>ID Number:</strong> {selectedProfile.idNumber || 'N/A'}
              </p>
              <p style={{ margin: '5px 0' }}>
                <strong>Joined:</strong> {formatDateString(selectedProfile.createdAt)}
              </p>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '10px', marginBottom: '20px' }}>
            <div style={{ backgroundColor: '#d1ecf1', padding: '12px', borderRadius: '8px', textAlign: 'center' }}>
              <p style={{ margin: '0', fontSize: '18px', fontWeight: 'bold', color: '#0c5460' }}>
                {loanCounts.active}
              </p>
              <p style={{ margin: '5px 0 0 0', fontSize: '12px', color: '#0c5460' }}>Active Loans</p>
            </div>
            <div style={{ backgroundColor: '#e2e3e5', padding: '12px', borderRadius: '8px', textAlign: 'center' }}>
              <p style={{ margin: '0', fontSize: '18px', fontWeight: 'bold', color: '#383d41' }}>
                {loanCounts.redeemed}
              </p>
              <p style={{ margin: '5px 0 0 0', fontSize: '12px', color: '#383d41' }}>Redeemed</p>
            </div>
            <div style={{ backgroundColor: '#f8d7da', padding: '12px', borderRadius: '8px', textAlign: 'center' }}>
              <p style={{ margin: '0', fontSize: '18px', fontWeight: 'bold', color: '#721c24' }}>
                {loanCounts.forfeited}
              </p>
              <p style={{ margin: '5px 0 0 0', fontSize: '12px', color: '#721c24' }}>Forfeited</p>
            </div>
            <div style={{ backgroundColor: '#fff3cd', padding: '12px', borderRadius: '8px', textAlign: 'center' }}>
              <p style={{ margin: '0', fontSize: '18px', fontWeight: 'bold', color: '#856404' }}>
                {loanCounts.extended}
              </p>
              <p style={{ margin: '5px 0 0 0', fontSize: '12px', color: '#856404' }}>Extended</p>
            </div>
          </div>

          {stats.totalAmount > 0 && (
            <div style={{ backgroundColor: '#f0f4ff', padding: '12px', borderRadius: '8px', marginBottom: '15px' }}>
              <p style={{ margin: '0', fontSize: '12px', color: '#667eea' }}>
                <strong>Active Loan Total:</strong> ${stats.totalAmount.toFixed(2)} | 
                <strong style={{ marginLeft: '10px' }}>Interest:</strong> ${stats.totalInterest.toFixed(2)}
              </p>
            </div>
          )}

          {editingAddress && (
            <div style={{
              backgroundColor: '#f8f9fa',
              padding: '20px',
              borderRadius: '8px',
              marginBottom: '20px',
              border: '1px solid #dee2e6'
            }}>
              <h5 style={{ marginTop: 0, marginBottom: '15px' }}>Edit Address</h5>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px', marginBottom: '15px' }}>
                <div>
                  <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>Street Address</label>
                  <input
                    type="text"
                    value={addressForm.streetAddress}
                    onChange={(e) => setAddressForm({ ...addressForm, streetAddress: e.target.value })}
                    style={{ width: '100%', padding: '8px', borderRadius: '4px', border: '1px solid #ccc' }}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>City</label>
                  <input
                    type="text"
                    value={addressForm.city}
                    onChange={(e) => setAddressForm({ ...addressForm, city: e.target.value })}
                    style={{ width: '100%', padding: '8px', borderRadius: '4px', border: '1px solid #ccc' }}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>State</label>
                  <input
                    type="text"
                    value={addressForm.state}
                    onChange={(e) => setAddressForm({ ...addressForm, state: e.target.value })}
                    style={{ width: '100%', padding: '8px', borderRadius: '4px', border: '1px solid #ccc' }}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>Zipcode</label>
                  <input
                    type="text"
                    value={addressForm.zipcode}
                    onChange={(e) => setAddressForm({ ...addressForm, zipcode: e.target.value })}
                    style={{ width: '100%', padding: '8px', borderRadius: '4px', border: '1px solid #ccc' }}
                  />
                </div>
              </div>
              <div style={{ display: 'flex', gap: '10px' }}>
                <button
                  onClick={handleSaveAddress}
                  className="btn-success"
                  style={{ padding: '8px 16px' }}
                >
                  Save Address
                </button>
                <button
                  onClick={() => setEditingAddress(false)}
                  className="btn-secondary"
                  style={{ padding: '8px 16px' }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          <button
            onClick={() => {
              setSelectedProfile(null);
              setProfileLoans({ active: [], redeemed: [], forfeited: [], overdue: [], extended: [] });
            }}
            className="btn-primary"
          >
            Search Another Customer
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="tabs" style={{ marginBottom: '20px' }}>
        {['active', 'overdue', 'redeemed', 'forfeited', 'extended'].map(tab => (
          <button
            key={tab}
            className={`tab-button ${activeTab === tab ? 'active' : ''}`}
            onClick={() => setActiveTab(tab)}
            disabled={loading}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)} ({loanCounts[tab]})
          </button>
        ))}
      </div>

      {/* Loans List */}
      {getActiveLoans().length > 0 ? (
        <div>
          {getActiveLoans().map((loan, idx) => (
            <div key={idx} className="card" style={{ marginBottom: '15px' }}>
              <div style={{ padding: '20px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: '12px' }}>
                  <div>
                    <p style={{ margin: '0 0 8px 0', fontSize: '16px', fontWeight: 'bold', color: '#222' }}>
                      Loan ID: {loan.id}
                    </p>
                    <p style={{ margin: '0', fontSize: '12px', color: '#333', fontWeight: '600' }}>
                      Transaction: {loan.transactionNumber || 'N/A'}
                    </p>
                  </div>
                  <span
                    style={{
                      backgroundColor: getStatusColor(loan.status),
                      color: 'white',
                      padding: '6px 12px',
                      borderRadius: '20px',
                      fontSize: '12px',
                      fontWeight: 'bold'
                    }}
                  >
                    {loan.status?.toUpperCase()}
                  </span>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '12px', marginTop: '15px' }}>
                  <div>
                    <p style={{ margin: '0', fontSize: '12px', color: '#333', fontWeight: '600' }}>Loan Amount</p>
                    <p style={{ margin: '5px 0 0 0', fontSize: '16px', fontWeight: 'bold', color: '#222' }}>
                      ${(loan.loanAmount || 0).toFixed(2)}
                    </p>
                  </div>
                  <div>
                    <p style={{ margin: '0', fontSize: '12px', color: '#333', fontWeight: '600' }}>Interest Rate</p>
                    <p style={{ margin: '5px 0 0 0', fontSize: '16px', fontWeight: 'bold', color: '#222' }}>
                      {(loan.interestRate || 0).toFixed(1)}%
                    </p>
                  </div>
                  <div>
                    <p style={{ margin: '0', fontSize: '12px', color: '#333', fontWeight: '600' }}>Interest Amount</p>
                    <p style={{ margin: '5px 0 0 0', fontSize: '16px', fontWeight: 'bold', color: '#222' }}>
                      ${(loan.interestAmount || 0).toFixed(2)}
                    </p>
                  </div>
                  <div>
                    <p style={{ margin: '0', fontSize: '12px', color: '#333', fontWeight: '600' }}>Total Payable</p>
                    <p style={{ margin: '5px 0 0 0', fontSize: '16px', fontWeight: 'bold', color: '#222' }}>
                      ${(loan.totalPayableAmount || 0).toFixed(2)}
                    </p>
                  </div>
                  <div>
                    <p style={{ margin: '0', fontSize: '12px', color: '#333', fontWeight: '600' }}>Remaining Balance</p>
                    <p style={{ margin: '5px 0 0 0', fontSize: '16px', fontWeight: 'bold', color: loan.remainingBalance > 0 ? '#d32f2f' : '#388e3c' }}>
                      ${(loan.remainingBalance || 0).toFixed(2)}
                    </p>
                  </div>
                  <div>
                    <p style={{ margin: '0', fontSize: '12px', color: '#333', fontWeight: '600' }}>Created</p>
                    <p style={{ margin: '5px 0 0 0', fontSize: '14px', color: '#222', fontWeight: '600' }}>
                      {formatDateString(loan.createdAt)}
                    </p>
                  </div>
                  <div>
                    <p style={{ margin: '0', fontSize: '12px', color: '#333', fontWeight: '600' }}>Due Date</p>
                    <p style={{ margin: '5px 0 0 0', fontSize: '14px', color: '#222', fontWeight: '600' }}>
                      {formatDateString(loan.dueDate)}
                    </p>
                  </div>
                </div>

                <p style={{ margin: '12px 0 0 0', fontSize: '13px', color: '#222', fontWeight: '600' }}>
                  <strong>Item:</strong> {loan.item_description || loan.itemDescription || loan.collateral_description || loan.collateralDescription || 'N/A'}
                </p>

                {/* Display Collateral Image if available */}
                {(loan.collateral_image || loan.collateralImage) && (
                  <div style={{ marginTop: '15px', textAlign: 'center' }}>
                    <p style={{ fontSize: '12px', color: '#666', marginBottom: '8px' }}>📷 Item Photo:</p>
                    {(loan.collateral_image || loan.collateralImage).startsWith('blob:') ? (
                      <div style={{
                        padding: '15px',
                        backgroundColor: '#fff3cd',
                        border: '1px solid #ffc107',
                        borderRadius: '6px',
                        color: '#856404',
                        fontSize: '12px'
                      }}>
                        ⚠️ Collateral image has expired. Please re-upload the image to save it permanently.
                      </div>
                    ) : (
                      <img 
                        src={
                          // If it starts with data:, it's already base64 from database
                          (loan.collateral_image || loan.collateralImage).startsWith('data:')
                            ? (loan.collateral_image || loan.collateralImage)
                            // Otherwise fetch from endpoint
                            : `/customers/${selectedProfile?.id}/${loan.id}/collateral-image`
                        }
                        alt="Collateral Item" 
                        style={{ 
                          maxWidth: '200px', 
                          maxHeight: '250px', 
                          borderRadius: '6px', 
                          border: '2px solid #ddd',
                          cursor: 'pointer'
                        }}
                        onError={(e) => {
                          e.target.style.display = 'none';
                          e.target.parentElement.innerHTML = '<div style="padding: 15px; backgroundColor: #f8d7da; border: 1px solid #f5c6cb; borderRadius: 6px; color: #721c24; fontSize: 12px;">⚠️ Could not load image. Please re-upload to save permanently.</div>';
                        }}
                        onClick={() => {
                          const imageData = (loan.collateral_image || loan.collateralImage);
                          if (imageData.startsWith('data:')) {
                            window.open(imageData, '_blank');
                          } else if (!imageData.startsWith('blob:')) {
                            window.open(`/customers/${selectedProfile?.id}/${loan.id}/collateral-image`, '_blank');
                          }
                        }}
                        title="Click to view full size"
                      />
                    )}
                  </div>
                )}

                <div style={{ display: 'flex', gap: '10px', marginTop: '15px' }}>
                  <button
                    onClick={() => handleDownloadReceipt(loan)}
                    className="btn-info"
                    style={{ padding: '8px 16px', fontSize: '13px' }}
                    title="Download receipt PDF for this loan"
                  >
                    📥 Re-download Receipt
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="alert alert-info">
          No {activeTab} loans found for this customer.
        </div>
      )}
    </div>
  );
};

export default ViewCustomerLoansForm;
