import React, { useState } from "react";
import { http } from "./services/httpClient";
import logger from "./services/logger";
import { getErrorMessage } from "./services/errorHandler";
import LoanStateDisplay from "./LoanStateDisplay";

const SearchLoanForm = ({ loggedInUser }) => {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [homePhone, setHomePhone] = useState("");
  const [mobilePhone, setMobilePhone] = useState("");
  const [email, setEmail] = useState("");
  const [transactionNumber, setTransactionNumber] = useState("");
  const [loans, setLoans] = useState([]);
  const [message, setMessage] = useState("");
  const [paymentHistory, setPaymentHistory] = useState([]);
  const [paymentHistoryByLoan, setPaymentHistoryByLoan] = useState({}); // Track per-loan history
  const [amountToAdd, setAmountToAdd] = useState("");
  const [selectedLoanId, setSelectedLoanId] = useState(null);

  // Handle loan search
  const handleSearch = async (e) => {
    e.preventDefault();

    try {
      const response = await http.get("/search-loan", {
        params: {
          firstName,
          lastName,
          homePhone,
          mobilePhone,
          email,
          transactionNumber,
          _ts: Date.now(),
        },
      });

      if (response.data.length === 0) {
        setMessage("No loans found");
        setLoans([]);
        setPaymentHistory([]);
        return;
      }

      setLoans(response.data);
      setMessage("");
      logger.info(`Search found ${response.data.length} loan(s)`);
      console.log('Search results:', JSON.stringify(response.data, null, 2));
      
      // Debug: Log first loan's full object to see all available fields
      if (response.data.length > 0) {
        console.log('FIRST LOAN FULL OBJECT:', response.data[0]);
        console.log('FIRST LOAN KEYS:', Object.keys(response.data[0]));
      }
      
      // Enhance loans with creator info from localStorage if backend didn't return it
      const createdLoans = JSON.parse(localStorage.getItem('createdLoans') || '{}');
      response.data.forEach(loan => {
        const transactionId = loan.transaction_number || loan.id;
        if (!loan.created_by_username && createdLoans[transactionId]) {
          loan.created_by_username = createdLoans[transactionId].created_by_username;
          loan.created_by_user_id = createdLoans[transactionId].created_by_user_id;
          logger.debug('Enhanced loan with localStorage creator info:', transactionId);
        }
      });

      // Fetch payment history for ALL loans
      const historyMap = {};
      for (const loan of response.data) {
        if (loan.id) {
          try {
            const paymentRes = await http.get("/payment-history", {
              params: { loanId: loan.id, _ts: Date.now() },
            });
            historyMap[loan.id] = paymentRes.data || [];
            logger.info(`Fetched ${historyMap[loan.id].length} payments for loan ${loan.id}`);
          } catch (histErr) {
            logger.warn(`Could not fetch payment history for loan ${loan.id}:`, histErr?.parsedError || histErr);
            historyMap[loan.id] = [];
          }
        }
      }
      
      setPaymentHistoryByLoan(historyMap);
      
      // Also set first loan history for backward compatibility
      const firstLoan = response.data[0];
      if (firstLoan && historyMap[firstLoan.id]) {
        setPaymentHistory(historyMap[firstLoan.id]);
      } else {
        setPaymentHistory([]);
      }
    } catch (error) {
      const userMessage = error.userMessage || getErrorMessage(error.parsedError || {});
      setMessage(`Error searching for loans: ${userMessage}`);
      logger.error('Search failed', error.parsedError || error);
      setLoans([]);
      setPaymentHistory([]);
    }
  };

  // Add money to loan (unconditional as long as loan is active)
  const handleAddMoney = async () => {
    if (!amountToAdd || isNaN(amountToAdd) || parseFloat(amountToAdd) <= 0) {
      alert("Please enter a valid amount");
      return;
    }

    try {
      const loanToUpdate = loans.find((loan) => loan.id === selectedLoanId);
      if (!loanToUpdate) return;

      const currentLoanAmount = parseFloat(loanToUpdate.loan_amount);
      const amountToAddNum = parseFloat(amountToAdd);

      const newLoanAmount = currentLoanAmount + amountToAddNum;
      const newInterestAmount = (newLoanAmount * loanToUpdate.interest_rate) / 100;
      const newTotalPayableAmount = newLoanAmount + newInterestAmount;
      const newRemainingBalance = newTotalPayableAmount;

      await http.post("/add-money", {
        loanId: selectedLoanId,
        amount: amountToAddNum,
        newLoanAmount,
        newInterestAmount,
        newTotalPayableAmount,
        addedByUserId: loggedInUser?.id,
        addedByUsername: loggedInUser?.username
      });

      alert("Money added successfully!");
      logger.info('Money added to loan', { loanId: selectedLoanId, amount: amountToAddNum });

      setLoans(
        loans.map((loan) =>
          loan.id === selectedLoanId
            ? {
                ...loan,
                loan_amount: newLoanAmount,
                interest_amount: newInterestAmount,
                total_payable_amount: newTotalPayableAmount,
                remaining_balance: newRemainingBalance,
              }
            : loan
        )
      );

      setAmountToAdd("");
      setSelectedLoanId(null);
    } catch (error) {
      const userMessage = error.userMessage || getErrorMessage(error.parsedError || {});
      alert(`Error adding money: ${userMessage}`);
      logger.error('Failed to add money', error.parsedError || error);
    }
  };

  // Redeem loan if fully paid
  const handleRedeemLoan = async (loanId) => {
    try {
      await http.post("/redeem-loan", {
        loanId,
        redeemedByUserId: loggedInUser?.id,
        redeemedByUsername: loggedInUser?.username
      });

      alert("Loan redeemed successfully!");
      logger.info('Loan redeemed', { loanId });

      setLoans(loans.map((loan) => (loan.id === loanId ? { ...loan, status: "redeemed" } : loan)));
    } catch (error) {
      const userMessage = error.userMessage || getErrorMessage(error.parsedError || {});
      alert(`Error redeeming loan: ${userMessage}`);
      logger.error('Failed to redeem loan', error.parsedError || error);
    }
  };

  return (
    <div className="form-container">
      <h3>Search Loan</h3>

      <form onSubmit={handleSearch}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
          <div className="form-group">
            <label>First Name</label>
            <input
              type="text"
              placeholder="Search by first name"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label>Last Name</label>
            <input
              type="text"
              placeholder="Search by last name"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label>Home Phone</label>
            <input
              type="text"
              placeholder="Search by home phone"
              value={homePhone}
              onChange={(e) => setHomePhone(e.target.value)}
            />
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
          <div className="form-group">
            <label>Mobile Phone</label>
            <input
              type="text"
              placeholder="Search by mobile phone"
              value={mobilePhone}
              onChange={(e) => setMobilePhone(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label>Email Address</label>
            <input
              type="email"
              placeholder="Search by email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
          <div className="form-group">
            <label>Transaction Number</label>
            <input
              type="text"
              placeholder="Search by transaction"
              value={transactionNumber}
              onChange={(e) => setTransactionNumber(e.target.value)}
            />
          </div>
        </div>

        <button type="submit" className="btn-primary" style={{ width: '100%' }}>Search Loans</button>
      </form>

      {/* Message Area */}
      {message && (
        <div className={`alert alert-${message.includes('found') ? 'error' : 'info'}`} style={{ marginTop: '20px' }}>
          {message}
        </div>
      )}

      {/* Display Multiple Loans */}
      {loans.length > 0 && (
        <div style={{ marginTop: '30px' }}>
          <h4 style={{ borderBottom: '2px solid #667eea', paddingBottom: '10px', marginBottom: '20px' }}>Loan Details ({loans.length})</h4>

          {loans.map((loan, idx) => (
            <div key={loan.id || loan.transaction_number || idx} className="card">
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginBottom: '15px' }}>
                <div>
                  <p><strong>First Name:</strong> {loan.first_name || loan.firstName || (loan.customer_name ? (loan.customer_name.split(' ')[0]) : '')}</p>
                  <p><strong>Last Name:</strong> {loan.last_name || loan.lastName || (loan.customer_name ? loan.customer_name.split(' ').slice(1).join(' ') : '')}</p>
                  <p><strong>Home Phone:</strong> {loan.home_phone || loan.homePhone || ''}</p>
                  <p><strong>Mobile Phone:</strong> {loan.mobile_phone || loan.mobilePhone || loan.customer_number}</p>
                  <p><strong>Email:</strong> {loan.email || loan.customer_email || loan.customerEmail || ''}</p>
                  <p><strong>Birthdate:</strong> {loan.birthdate || loan.birth_date || ''}</p>
                  <p><strong>Referral:</strong> {loan.referral || ''}</p>
                  <p><strong>ID Type:</strong> {loan.id_type || loan.idType || loan.identification_type || loan.identificationType || (loan.identification && (loan.identification.type || loan.identification.id_type || loan.identification.name)) || ''}</p>
                  <p><strong>ID Number:</strong> {loan.id_number || loan.idNumber || loan.identification_number || loan.identificationNumber || loan.id_no || loan.idNo || (loan.identification && (loan.identification.number || loan.identification.id_number || loan.identification.idNo)) || ''}</p>
                  <p><strong>ID Details:</strong> {loan.identification_info || loan.identificationInfo || ''}</p>
                  <p><strong>Street:</strong> {loan.street_address || loan.streetAddress || loan.address || ''}</p>
                  <p><strong>City:</strong> {loan.city || ''}</p>
                  <p><strong>State:</strong> {loan.state || loan.stateValue || ''}</p>
                  <p><strong>Zipcode:</strong> {loan.zipcode || loan.postal_code || ''}</p>
                </div>
                <div>
                  <p><strong>Transaction Number:</strong> {loan.transaction_number || loan.transactionNumber || loan.transaction_id || loan.transactionId || ''}</p>
                  <p><strong>Loan Issued Date:</strong> {loan.loan_issued_date?.substring(0, 10)}</p>
                  <p><strong>Due Date:</strong> {loan.due_date?.substring(0, 10)}</p>
                </div>
              </div>

              <div style={{ backgroundColor: '#e8f4f8', padding: '12px', borderRadius: '6px', marginBottom: '15px', borderLeft: '4px solid #5dd9ff' }}>
                <p>
                  <strong>Created by:</strong>
                  {
                    ' ' + (
                      loan.created_by_username || 
                      loan.createdByUsername ||
                      (loan.created_by && (loan.created_by.username || loan.created_by.name)) ||
                      loan.created_by || 
                      loan.createdBy || 
                      'Unknown'
                    )
                  }
                  {' '}
                  (ID: {
                    loan.created_by_user_id || 
                    loan.createdByUserId ||
                    (loan.created_by && (loan.created_by.id || loan.created_by.user_id)) ||
                    loan.created_by_user || 
                    loan.creator_id || 
                    'N/A'
                  })
                </p>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginBottom: '15px' }}>
                <div>
                  <p><strong>Loan Amount:</strong> $ {loan.loan_amount}</p>
                  <p><strong>Interest Rate:</strong> {loan.interest_rate}%</p>
                </div>
                <div>
                  <p><strong>Loan Issued Date:</strong> {loan.loan_issued_date?.substring(0, 10)}</p>
                  <p><strong>Original Due Date:</strong> {loan.due_date?.substring(0, 10)}</p>
                </div>
              </div>

              {/* Dynamic Loan State Calculation */}
              <div style={{ marginBottom: '15px' }}>
                <LoanStateDisplay 
                  loan={{
                    loan_amount: parseFloat(loan.loan_amount),
                    interest_rate: parseFloat(loan.interest_rate),
                    created_at: loan.created_at || loan.loan_issued_date,
                    due_date: loan.due_date
                  }}
                  payments={(paymentHistoryByLoan[loan.id] || []).map(p => ({
                    payment_amount: parseFloat(p.payment_amount),
                    payment_date: p.payment_date
                  }))}
                  autoRefresh={30000}
                />
              </div>

              <div style={{ marginBottom: '15px' }}>
                <p><strong>Status:</strong> <span className={`badge badge-${loan.status === 'active' ? 'success' : loan.status === 'overdue' ? 'danger' : 'info'}`}>{loan.status}</span></p>
              </div>

              {/* Collateral Details */}
              <div style={{ backgroundColor: '#fff3cd', padding: '15px', borderRadius: '8px', marginBottom: '15px', borderLeft: '4px solid #ffc107' }}>
                <h5 style={{ marginTop: 0, marginBottom: '10px', color: '#856404' }}>📦 Collateral Information</h5>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
                  <div>
                    <p><strong>Item:</strong> {loan.item_description || loan.itemDescription || loan.collateral_description || loan.collateralDescription || 'N/A'}</p>
                    <p><strong>Category:</strong> {loan.item_category || loan.itemCategory || 'N/A'}</p>
                  </div>
                  <div>
                    {(loan.collateral_image || loan.collateralImage) && (
                      <div style={{ textAlign: 'center' }}>
                        <img 
                          src={loan.collateral_image || loan.collateralImage} 
                          alt="Collateral Item" 
                          style={{ maxWidth: '100%', maxHeight: '250px', borderRadius: '6px', border: '2px solid #ffc107' }} 
                        />
                      </div>
                    )}
                    {!(loan.collateral_image || loan.collateralImage) && (
                      <p style={{ color: '#999', fontStyle: 'italic' }}>No image provided</p>
                    )}
                  </div>
                </div>
              </div>

              {/* Redeem or Add Money buttons */}
              {loan.status === "active" && (
                <div style={{ display: 'flex', gap: '10px', marginBottom: '10px' }}>
                  <button onClick={() => handleRedeemLoan(loan.id)} className="btn-success">Redeem Loan</button>
                  <button onClick={() => setSelectedLoanId(loan.id)} className="btn-info">Add Money</button>
                </div>
              )}

              {/* Show Add Money field when button is clicked */}
              {selectedLoanId === loan.id && (
                <div style={{ display: 'flex', gap: '10px', padding: '15px', backgroundColor: '#f8f9fb', borderRadius: '8px' }}>
                  <input
                    type="number"
                    value={amountToAdd}
                    onChange={(e) => setAmountToAdd(e.target.value)}
                    placeholder="Enter amount to add"
                    style={{ flex: 1 }}
                  />
                  <button onClick={handleAddMoney} className="btn-success">Submit</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Show Payment History */}
      {paymentHistory.length > 0 && (
        <div style={{ marginTop: '30px' }}>
          <h4 style={{ borderBottom: '2px solid #667eea', paddingBottom: '10px', marginBottom: '20px' }}>Payment History</h4>
          {paymentHistory.map((payment, pidx) => (
            <div key={payment.id || pidx} className="card">
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '20px', marginBottom: '10px' }}>
                <p><strong>Amount Paid:</strong> $ {payment.payment_amount}</p>
                <p><strong>Method:</strong> {payment.payment_method}</p>
                <p><strong>Date:</strong> {new Date(payment.payment_date).toLocaleString()}</p>
              </div>
              <div style={{ backgroundColor: '#f0e8f8', padding: '10px', borderRadius: '6px', borderLeft: '4px solid #5dd9ff' }}>
                <p><strong>Payment processed by:</strong> {payment.processed_by_username} (ID: {payment.processed_by_user_id})</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default SearchLoanForm;
