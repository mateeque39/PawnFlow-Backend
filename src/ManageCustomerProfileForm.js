import React, { useState } from 'react';
import { http } from './services/httpClient';
import apiConfig from './config/apiConfig';
import { parseError, getErrorMessage } from './services/errorHandler';
import logger from './services/logger';
import CollateralImageCapture from './CollateralImageCapture';

const ManageCustomerProfileForm = ({ loggedInUser }) => {
  const [searchType, setSearchType] = useState('phone');
  const [searchValue, setSearchValue] = useState('');
  const [loadingSearch, setLoadingSearch] = useState(false);
  const [searchResults, setSearchResults] = useState([]);
  const [selectedProfile, setSelectedProfile] = useState(null);
  const [profileLoans, setProfileLoans] = useState([]);
  const [message, setMessage] = useState('');
  const [messageType, setMessageType] = useState('');
  const [activeTab, setActiveTab] = useState('loans');
  const [expandedLoanId, setExpandedLoanId] = useState(null);
  const [loanPaymentHistory, setLoanPaymentHistory] = useState({});

  // Profile edit state
  const [showEditProfile, setShowEditProfile] = useState(false);
  const [editProfileData, setEditProfileData] = useState({});
  const [profileImage, setProfileImage] = useState(null);
  const [profileImagePreview, setProfileImagePreview] = useState(null);

  // Loan form state
  const [showLoanForm, setShowLoanForm] = useState(false);
  const [selectedLoan, setSelectedLoan] = useState(null);
  const [operationType, setOperationType] = useState('create'); // create, payment, extend, redeem, forfeit, reactivate, discount
  const [loanFormData, setLoanFormData] = useState({
    loanAmount: '',
    interestRate: '',
    collateralDescription: '',
    customerNote: '',
    paymentAmount: '',
    paymentMethod: 'cash',
    addMoneyAmount: '',
    daysToExtend: '',
    loanTerm: '',
    recurringFee: '',
    redemptionFee: '',
    discountAmount: '',
    collateralImage: null,
    collateralImagePreview: null
  });
  const [loadingSubmit, setLoadingSubmit] = useState(false);
  const [loansTab, setLoansTab] = useState('active'); // Tab filter: active, redeemed, forfeited
  const [showImageCapture, setShowImageCapture] = useState(false); // Show/hide image capture modal

  // Search for customer profile
  const handleSearch = async (e) => {
    e.preventDefault();
    setLoadingSearch(true);
    try {
      let endpoint = '';
      let params = { _ts: Date.now() };

      if (searchType === 'phone') {
        endpoint = '/customers/search-phone';
        params.phone = searchValue;
      } else if (searchType === 'name') {
        endpoint = '/customers/search-name';
        params.firstName = searchValue.split(' ')[0];
        params.lastName = searchValue.split(' ').slice(1).join(' ') || '';
      } else if (searchType === 'customerId') {
        endpoint = `/customers/${searchValue}`;
      }

      const response = await http.get(endpoint, { params });
      const results = Array.isArray(response?.data) ? response.data : [response?.data];

      // Debug: Log backend response structure
      if (results.length > 0) {
        logger.debug('Customer search response sample:', JSON.stringify(results[0], null, 2));
      }

      if (results.length === 0) {
        setMessage('No customer profiles found');
        setMessageType('warning');
        setSearchResults([]);
      } else {
        setSearchResults(results);
        setMessage('');
        setMessageType('');
      }
    } catch (error) {
      const parsedError = error.parsedError || parseError(error);
      const userMessage = error.userMessage || getErrorMessage(parsedError);
      setMessage(userMessage);
      setMessageType('error');
      setSearchResults([]);
    } finally {
      setLoadingSearch(false);
    }
  };

  // Helper function to get field value with multiple fallback keys
  const getFieldValue = (obj, ...keys) => {
    for (const key of keys) {
      if (obj && obj[key] !== undefined && obj[key] !== null && obj[key] !== '') {
        return obj[key];
      }
    }
    return null;
  };

  // Helper function to parse date strings (YYYY-MM-DD format) without timezone conversion
  // Backend sends dates as YYYY-MM-DD in local timezone, so we parse directly without UTC conversion
  const parseDateString = (dateString) => {
    if (!dateString) return null;
    
    // If it's already a Date object, return it
    if (dateString instanceof Date) return dateString;
    
    // If it's in YYYY-MM-DD format, parse it directly without timezone conversion
    if (typeof dateString === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
      const [year, month, day] = dateString.split('-');
      // Create date in local timezone by using new Date(year, month-1, day)
      return new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
    }
    
    // Otherwise, try standard parsing
    return new Date(dateString);
  };

  // Helper function to format date for display
  const formatDate = (dateString) => {
    if (!dateString) return 'N/A';
    const date = parseDateString(dateString);
    if (isNaN(date.getTime())) return 'N/A';
    return date.toLocaleDateString();
  };

  // Helper function to check if loan can be forfeited
  const canForfeitLoan = (loan) => {
    if (!loan || loan.status?.toLowerCase() !== 'active') {
      return false;
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const dueDate = parseDateString(loan.dueDate);
    dueDate.setHours(0, 0, 0, 0);
    
    const isDueDatePassed = dueDate < today;
    const remainingBalance = parseFloat(loan.remainingBalance || 0);
    const interestAmount = parseFloat(loan.interestAmount || 0);
    const isBalanceLessThanInterest = remainingBalance < interestAmount || remainingBalance === 0;
    
    return isDueDatePassed && isBalanceLessThanInterest;
  };

  // Helper function to get forfeit button tooltip
  const getForfeitButtonTooltip = (loan) => {
    if (loan.status?.toLowerCase() !== 'active') {
      return 'Loan is not active';
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const dueDate = parseDateString(loan.dueDate);
    dueDate.setHours(0, 0, 0, 0);
    
    const isDueDatePassed = dueDate < today;
    const remainingBalance = parseFloat(loan.remainingBalance || 0);
    const interestAmount = parseFloat(loan.interestAmount || 0);
    const isBalanceLessThanInterest = remainingBalance < interestAmount || remainingBalance === 0;
    
    if (!isDueDatePassed) {
      return 'Due date has not passed yet';
    }
    
    if (!isBalanceLessThanInterest) {
      return `Remaining balance (${remainingBalance.toFixed(2)}) must be less than interest amount (${interestAmount.toFixed(2)}) or zero`;
    }
    
    return 'Ready to forfeit';
  };

  // Helper function to check if loan can be redeemed

  // Select profile and load loans
  const handleSelectProfile = async (profile) => {
    // Normalize profile data with field fallbacks
    const normalizedProfile = {
      id: getFieldValue(profile, 'id', 'customer_id', 'customerId') || profile.id,
      firstName: getFieldValue(profile, 'firstName', 'first_name', 'firstname') || 'N/A',
      lastName: getFieldValue(profile, 'lastName', 'last_name', 'lastname') || 'N/A',
      homePhone: getFieldValue(profile, 'homePhone', 'home_phone', 'phone') || '',
      mobilePhone: getFieldValue(profile, 'mobilePhone', 'mobile_phone', 'mobile') || '',
      email: getFieldValue(profile, 'email') || '',
      birthdate: getFieldValue(profile, 'birthdate', 'date_of_birth', 'dob') || '',
      referral: getFieldValue(profile, 'referral', 'referred_by') || '',
      idType: getFieldValue(profile, 'idType', 'id_type') || '',
      idNumber: getFieldValue(profile, 'idNumber', 'id_number') || '',
      idDetails: getFieldValue(profile, 'idDetails', 'id_details') || '',
      streetAddress: getFieldValue(profile, 'streetAddress', 'street_address', 'address_street', 'street') || '',
      city: getFieldValue(profile, 'city', 'city_name') || '',
      state: getFieldValue(profile, 'state', 'state_code', 'state_name') || '',
      zipcode: getFieldValue(profile, 'zipcode', 'zip_code', 'postal_code', 'zip') || '',
      createdAt: getFieldValue(profile, 'createdAt', 'created_at', 'created_date') || new Date().toISOString(),
      profile_image: getFieldValue(profile, 'profile_image', 'profileImage', 'profilePicture', 'profile_picture') || null
    };

    setSelectedProfile(normalizedProfile);
    setLoadingSearch(true);
    try {
      const response = await http.get(`/customers/${normalizedProfile.id}/loans`, {
        params: { _ts: Date.now() }
      });

      // Backend returns grouped loans object: { activeLoans, redeemedLoans, forfeitedLoans, overdueLoans }
      // Flatten into single array for display
      let loans = [];
      if (response?.data) {
        const { activeLoans = [], redeemedLoans = [], forfeitedLoans = [], overdueLoans = [] } = response.data;
        
        // Normalize field names for each loan (backend uses snake_case, frontend expects camelCase)
        const normalizeLoan = (loan) => {
          const amount = parseFloat(loan.loan_amount || loan.loanAmount || 0);
          const rate = parseFloat(loan.interest_rate || loan.interestRate || 0);
          let interest = parseFloat(loan.interest_amount || loan.interestAmount || 0);
          const recurringFee = parseFloat(loan.recurring_fee || loan.recurringFee || 0);
          const redemptionFee = parseFloat(loan.redemption_fee || loan.redemptionFee || 0);
          
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
            recurringFee: recurringFee,
            redemptionFee: redemptionFee,
            totalPayableAmount: totalPayable,
            remainingBalance: balance,
            createdAt: loan.loan_issued_date || loan.createdAt || loan.created_at,
            dueDate: loan.due_date || loan.dueDate,
            status: loan.status,
            transactionNumber: loan.transaction_number || loan.transactionNumber,
            itemDescription: loan.item_description || loan.itemDescription,
            ...loan // Keep all original fields as fallback
          };
        };
        
        loans = [
          ...activeLoans.map(normalizeLoan),
          ...redeemedLoans.map(normalizeLoan),
          ...forfeitedLoans.map(normalizeLoan),
          ...overdueLoans.map(normalizeLoan)
        ];
        
        logger.debug('Received loans from backend', { 
          activeCount: activeLoans.length, 
          redeemedCount: redeemedLoans.length,
          forfeitedCount: forfeitedLoans.length,
          overdueCount: overdueLoans.length
        });
      }
      
      setProfileLoans(loans);
      setMessage('');
      setMessageType('');
      setSearchResults([]);
      logger.info('Profile selected and loans loaded', { customerId: normalizedProfile.id, loanCount: loans.length });
    } catch (error) {
      const parsedError = error.parsedError || parseError(error);
      const userMessage = error.userMessage || getErrorMessage(parsedError);
      setMessage(userMessage);
      setMessageType('error');
    } finally {
      setLoadingSearch(false);
    }
  };

  // Handle collateral image upload (not currently used)
  /* const handleCollateralImageUpload = (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setLoanFormData({
          ...loanFormData,
          collateralImage: reader.result, // Base64 string
          collateralImagePreview: reader.result
        });
      };
      reader.readAsDataURL(file);
    }
  }; */

  // Handle collateral image capture from webcam or file
  const handleImageCapture = (imageData) => {
    setLoanFormData({
      ...loanFormData,
      collateralImage: imageData,
      collateralImagePreview: imageData
    });
    setShowImageCapture(false);
  };

  // Handle profile image upload
  const handleProfileImageUpload = (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setProfileImage(reader.result); // Base64 string
        setProfileImagePreview(reader.result);
      };
      reader.readAsDataURL(file);
    }
  };

  // Toggle payment history expansion and fetch data
  const handleTogglePaymentHistory = async (loanId) => {
    if (expandedLoanId === loanId) {
      setExpandedLoanId(null);
      return;
    }

    // Fetch payment history if not already loaded
    // Check if we have data for this loan (even if it's empty, it means we fetched it)
    if (loanPaymentHistory[loanId] === undefined) {
      try {
        const response = await http.get(`/payment-history`, {
          params: { loanId, _ts: Date.now() }
        });
        // Backend returns array directly from /payment-history endpoint
        const payments = Array.isArray(response?.data) ? response.data : (Array.isArray(response) ? response : []);
        
        logger.debug('Fetched payment history', { loanId, count: payments.length });
        
        setLoanPaymentHistory({
          ...loanPaymentHistory,
          [loanId]: payments.filter(p => p !== undefined && p !== null)
        });
      } catch (error) {
        logger.error('Error fetching payment history', error);
        setLoanPaymentHistory({
          ...loanPaymentHistory,
          [loanId]: []
        });
      }
    }

    setExpandedLoanId(loanId);
  };

  // Download loan receipt PDF
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
      link.download = `loan_receipt_${loan.transaction_number || loan.transactionNumber || loan.id}.pdf`;
      link.style.display = 'none';
      document.body.appendChild(link);
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      setTimeout(() => {
        window.URL.revokeObjectURL(url);
        document.body.removeChild(link);
      }, 1000);

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

  // Handle loan operation submission
  const handleLoanOperation = async (e) => {
    e.preventDefault();
    setLoadingSubmit(true);

    try {
      let endpoint = '';
      let payload = {};
      let method = 'post';

      if (operationType === 'create') {
        endpoint = `/customers/${selectedProfile.id}/loans`;
        const loanIssuedDate = new Date().toISOString().split('T')[0];
        const dueDate = new Date();
        dueDate.setDate(dueDate.getDate() + parseInt(loanFormData.loanTerm));

        payload = {
          loanAmount: parseFloat(loanFormData.loanAmount),
          interestRate: parseFloat(loanFormData.interestRate),
          itemDescription: loanFormData.collateralDescription,
          customerNote: loanFormData.customerNote,
          loanTerm: parseInt(loanFormData.loanTerm),
          recurringFee: parseFloat(loanFormData.recurringFee || 0),
          loanIssuedDate,
          dueDate: dueDate.toISOString().split('T')[0],
          collateralImage: loanFormData.collateralImage,
          createdByUserId: loggedInUser?.id,
          createdByUsername: loggedInUser?.username
        };
      } else if (operationType === 'payment') {
        endpoint = `/customers/${selectedProfile.id}/loans/${selectedLoan.id}/payment`;
        payload = {
          paymentAmount: parseFloat(loanFormData.paymentAmount),
          paymentMethod: loanFormData.paymentMethod,
          paymentDate: new Date().toISOString(),
          userId: loggedInUser?.id,
          processedByUsername: loggedInUser?.username
        };
      } else if (operationType === 'addMoney') {
        endpoint = `/customers/${selectedProfile.id}/loans/${selectedLoan.id}/add-money`;
        payload = {
          amount: parseFloat(loanFormData.addMoneyAmount),
          userId: loggedInUser?.id
        };
      } else if (operationType === 'discount') {
        endpoint = `/customers/${selectedProfile.id}/loans/${selectedLoan.id}/discount`;
        payload = {
          discountAmount: parseFloat(loanFormData.discountAmount),
          userId: loggedInUser?.id,
          username: loggedInUser?.username
        };
      } else if (operationType === 'extend') {
        endpoint = `/customers/${selectedProfile.id}/loans/${selectedLoan.id}/extend-due-date`;
        payload = {
          extendDays: parseInt(loanFormData.daysToExtend || 30),
          extendedByUserId: loggedInUser?.id,
          extendedByUsername: loggedInUser?.username
        };
      } else if (operationType === 'redeem') {
        endpoint = `/customers/${selectedProfile.id}/loans/${selectedLoan.id}/redeem`;
        payload = {
          userId: loggedInUser?.id,
          redemptionFee: parseFloat(loanFormData.redemptionFee || 0)
        };
      } else if (operationType === 'forfeit') {
        endpoint = `/customers/${selectedProfile.id}/loans/${selectedLoan.id}/forfeit`;
        payload = {
          userId: loggedInUser?.id
        };
      } else if (operationType === 'reactivate') {
        endpoint = `/customers/${selectedProfile.id}/loans/${selectedLoan.id}/reactivate`;
        payload = {
          reactivatedByUserId: loggedInUser?.id,
          reactivatedByUsername: loggedInUser?.username,
          reactivationDate: new Date().toISOString()
        };
      } else if (operationType === 'edit') {
        endpoint = `/customers/${selectedProfile.id}/loans/${selectedLoan.id}`;
        method = 'put';
        payload = {
          loanAmount: parseFloat(loanFormData.loanAmount),
          interestRate: parseFloat(loanFormData.interestRate),
          itemDescription: loanFormData.collateralDescription,
          customerNote: loanFormData.customerNote,
          collateralImage: loanFormData.collateralImage,
          updatedByUserId: loggedInUser?.id,
          updatedByUsername: loggedInUser?.username
        };
      } else if (operationType === 'void') {
        endpoint = `/customers/${selectedProfile.id}/loans/${selectedLoan.id}/void`;
        method = 'delete';
        payload = {
          voidedByUserId: loggedInUser?.id,
          voidedByUsername: loggedInUser?.username,
          voidDate: new Date().toISOString()
        };
      }

      const response = await http[method](endpoint, payload);
      const result = response?.data || response;

      let successMessage = `✅ ${operationType.charAt(0).toUpperCase() + operationType.slice(1)} completed successfully!`;
      if (operationType === 'void') {
        successMessage = '✅ Loan has been voided and permanently deleted!';
      }
      setMessage(successMessage);
      setMessageType('success');

      // Reload loans
      const loansResponse = await http.get(`/customers/${selectedProfile.id}/loans`, {
        params: { _ts: Date.now() }
      });
      
      // Handle grouped loans response from backend
      let updatedLoans = [];
      if (loansResponse?.data) {
        const { activeLoans = [], redeemedLoans = [], forfeitedLoans = [], overdueLoans = [] } = loansResponse.data;
        
        // Normalize field names for each loan (convert strings to numbers)
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
        
        updatedLoans = [
          ...activeLoans.map(normalizeLoan),
          ...redeemedLoans.map(normalizeLoan),
          ...forfeitedLoans.map(normalizeLoan),
          ...overdueLoans.map(normalizeLoan)
        ];
      }
      setProfileLoans(updatedLoans);

      // Clear cached payment history to force refresh on next view
      setLoanPaymentHistory({});
      setExpandedLoanId(null);

      // Reset form
      setShowLoanForm(false);
      setSelectedLoan(null);
      setLoanFormData({
        loanAmount: '',
        interestRate: '',
        collateralDescription: '',
        customerNote: '',
        paymentAmount: '',
        paymentMethod: 'cash',
        addMoneyAmount: '',
        daysToExtend: '',
        loanTerm: '',
        discountAmount: '',
        collateralImage: null,
        collateralImagePreview: null
      });

      logger.info(`Loan ${operationType} completed`, { loanId: selectedLoan?.id || 'new' });

      // Download PDF if creating loan
      if (operationType === 'create' && result.pdf_url) {
        setTimeout(() => downloadLoanPDF(result.loan.id), 500);
      }

      // Auto-download receipt when a payment is completed successfully
      if (operationType === 'payment' && result?.receiptPDF) {
        console.log('[ManageCustomerProfileForm] Payment response has receiptPDF, auto-downloading');
        handleDownloadReceiptFromBase64(result.receiptPDF, selectedLoan || result.loan);
      }
    } catch (error) {
      const parsedError = error.parsedError || parseError(error);
      const userMessage = error.userMessage || getErrorMessage(parsedError);
      setMessage(userMessage);
      setMessageType('error');
      logger.error(`Error in loan ${operationType}`, parsedError);
    } finally {
      setLoadingSubmit(false);
    }
  };

  const downloadLoanPDF = async (loanId) => {
    try {
      console.log(`[PDF Download] Starting download for loan: ${loanId}`);
      const token = localStorage.getItem('token');
      const baseURL = apiConfig.getBaseURL();
      
      const response = await fetch(`${baseURL}/loan-pdf/${loanId}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (!response.ok) {
        throw new Error(`Failed to download PDF: ${response.statusText}`);
      }

      // Get blob from response
      const blob = await response.blob();
      console.log(`[PDF Download] Downloaded PDF size: ${blob.size} bytes`);

      // Create download link
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `loan_${loanId}.pdf`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
      
      console.log(`[PDF Download] PDF downloaded successfully for loan ${loanId}`);
    } catch (error) {
      console.error(`[PDF Download Error]`, error);
      setMessage(`Error downloading PDF: ${error.message}`);
      setMessageType('error');
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
      case 'extended':
        return '#ffc107';
      default:
        return '#667eea';
    }
  };

  const handleDownloadReceiptFromBase64 = (base64Pdf, loan) => {
    if (!base64Pdf) return;

    try {
      const byteCharacters = atob(base64Pdf);
      const byteNumbers = new Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i += 1) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
      }
      const byteArray = new Uint8Array(byteNumbers);
      const blob = new Blob([byteArray], { type: 'application/pdf' });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `loan_receipt_${loan?.transaction_number || loan?.transactionNumber || loan?.id || 'payment'}.pdf`;
      link.style.display = 'none';
      document.body.appendChild(link);
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      setTimeout(() => {
        window.URL.revokeObjectURL(url);
        document.body.removeChild(link);
      }, 1000);
      logger.info('Auto-downloaded receipt from base64 response', { loanId: loan?.id });
    } catch (error) {
      console.error('Error auto-downloading receipt from base64:', error);
      setMessage('Error downloading receipt PDF');
      setMessageType('error');
    }
  };

  // Search results view
  if (searchResults.length > 0 && !selectedProfile) {
    return (
      <div className="form-container">
        <h3>Select Customer Profile</h3>
        {searchResults.map((profile, idx) => {
          const firstName = getFieldValue(profile, 'firstName', 'first_name', 'firstname') || '';
          const lastName = getFieldValue(profile, 'lastName', 'last_name', 'lastname') || '';
          const homePhone = getFieldValue(profile, 'homePhone', 'home_phone') || '';
          const mobilePhone = getFieldValue(profile, 'mobilePhone', 'mobile_phone') || '';
          const displayName = firstName && lastName ? `${firstName} ${lastName}` : firstName || lastName || `Customer ${profile.id}`;
          const displayPhone = homePhone || mobilePhone || 'N/A';

          return (
            <div
              key={idx}
              className="card"
              style={{ marginBottom: '15px', cursor: 'pointer' }}
              onClick={() => handleSelectProfile(profile)}
            >
              <div style={{ padding: '20px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <p style={{ margin: '0 0 8px 0', fontSize: '16px', fontWeight: 'bold', color: '#222' }}>
                      {displayName}
                    </p>
                    <p style={{ margin: '5px 0', fontSize: '14px', color: '#222', fontWeight: '600' }}>
                      <strong>ID:</strong> {profile.id}
                    </p>
                    <p style={{ margin: '5px 0', fontSize: '14px', color: '#222', fontWeight: '600' }}>
                      <strong>Phone:</strong> {displayPhone}
                    </p>
                  </div>
                  <button className="btn-success" onClick={() => handleSelectProfile(profile)}>
                    Select Profile
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  // Profile management view
  if (selectedProfile) {
    return (
      <React.Fragment>
        <div className="form-container">
        <h3>Manage Customer Profile & Loans</h3>

        {message && (
          <div className={`alert alert-${messageType}`} style={{ marginBottom: '20px' }}>
            {message}
          </div>
        )}

        {/* Profile Card */}
        <div className="card" style={{ marginBottom: '20px' }}>
          <div className="card-header">Customer Profile</div>
          <div style={{ padding: '20px' }}>
            {!showEditProfile ? (
              <>
                <div style={{ display: 'flex', gap: '30px', marginBottom: '20px' }}>
                  <div style={{ flex: 1 }}>
                    {selectedProfile.profile_image || profileImagePreview ? (
                      <img
                        src={selectedProfile.profile_image || profileImagePreview}
                        alt="Profile"
                        style={{ width: '150px', height: '150px', borderRadius: '8px', objectFit: 'cover', border: '2px solid #ddd' }}
                      />
                    ) : (
                      <div style={{ width: '150px', height: '150px', borderRadius: '8px', backgroundColor: '#e0e0e0', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#555' }}>
                        No Photo
                      </div>
                    )}
                  </div>
                  <div style={{ flex: 3 }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
                      <div>
                        <p style={{ margin: '5px 0', color: '#222', fontWeight: '600' }}>
                          <strong>Name:</strong> {selectedProfile.firstName && selectedProfile.lastName ? `${selectedProfile.firstName} ${selectedProfile.lastName}` : `${selectedProfile.firstName || selectedProfile.lastName || 'N/A'}`}
                        </p>
                        <p style={{ margin: '5px 0', color: '#222', fontWeight: '600' }}>
                          <strong>Customer ID:</strong> {selectedProfile.id}
                        </p>
                        <p style={{ margin: '5px 0', color: '#222', fontWeight: '600' }}>
                          <strong>Phone:</strong> {selectedProfile.homePhone || selectedProfile.mobilePhone || 'N/A'}
                        </p>
                        <p style={{ margin: '5px 0', color: '#222', fontWeight: '600' }}>
                          <strong>Email:</strong> {selectedProfile.email || 'N/A'}
                        </p>
                      </div>
                      <div>
                        <p style={{ margin: '5px 0', color: '#222', fontWeight: '600' }}>
                          <strong>Address:</strong> {selectedProfile.streetAddress && selectedProfile.city ? `${selectedProfile.streetAddress}, ${selectedProfile.city}${selectedProfile.state ? ', ' + selectedProfile.state : ''}${selectedProfile.zipcode ? ' ' + selectedProfile.zipcode : ''}` : 'N/A'}
                        </p>
                        <p style={{ margin: '5px 0', color: '#222', fontWeight: '600' }}>
                          <strong>ID:</strong> {selectedProfile.idNumber || selectedProfile.idType || 'N/A'}
                        </p>
                        <p style={{ margin: '5px 0', color: '#222', fontWeight: '600' }}>
                          <strong>Joined:</strong> {selectedProfile.createdAt ? formatDate(selectedProfile.createdAt) : 'N/A'}
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '10px', marginTop: '15px' }}>
                  <button
                    onClick={() => {
                      setShowEditProfile(true);
                      setProfileImage(selectedProfile.profile_image || null);
                      setProfileImagePreview(selectedProfile.profile_image || null);
                      setEditProfileData({
                        firstName: selectedProfile.firstName || '',
                        lastName: selectedProfile.lastName || '',
                        homePhone: selectedProfile.homePhone || '',
                        mobilePhone: selectedProfile.mobilePhone || '',
                        email: selectedProfile.email || '',
                        streetAddress: selectedProfile.streetAddress || '',
                        city: selectedProfile.city || '',
                        state: selectedProfile.state || '',
                        zipcode: selectedProfile.zipcode || '',
                        idType: selectedProfile.idType || '',
                        idNumber: selectedProfile.idNumber || ''
                      });
                    }}
                    className="btn-warning"
                  >
                    ✏️ Edit Profile
                  </button>
                  <button
                    onClick={() => {
                      setSelectedProfile(null);
                      setSearchResults([]);
                      setSearchValue('');
                      setMessage('');
                    }}
                    className="btn-primary"
                  >
                    Search Another Profile
                  </button>
                </div>
              </>
            ) : (
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  setLoadingSubmit(true);
                  try {
                    const updateData = {
                      ...editProfileData,
                      ...(profileImage && { profile_image: profileImage })
                    };
                    await http.put(`/customers/${selectedProfile.id}`, updateData);
                    setMessage('✅ Profile updated successfully!');
                    setMessageType('success');
                    
                    // Update selected profile with new data
                    setSelectedProfile({
                      ...selectedProfile,
                      ...editProfileData,
                      ...(profileImage && { profile_image: profileImage })
                    });
                    
                    setShowEditProfile(false);
                    setProfileImage(null);
                    setProfileImagePreview(null);
                    logger.info('Profile updated', { customerId: selectedProfile.id });
                  } catch (error) {
                    const parsedError = error.parsedError || parseError(error);
                    const userMessage = error.userMessage || getErrorMessage(parsedError);
                    setMessage(userMessage);
                    setMessageType('error');
                    logger.error('Error updating profile', parsedError);
                  } finally {
                    setLoadingSubmit(false);
                  }
                }}
              >
                <h4 style={{ marginTop: '0', marginBottom: '15px' }}>Edit Profile Information</h4>
                
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '20px' }}>
                  <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                    <label>Profile Picture</label>
                    <div style={{ display: 'flex', gap: '20px', marginBottom: '15px' }}>
                      <div>
                        {profileImagePreview ? (
                          <img
                            src={profileImagePreview}
                            alt="Profile Preview"
                            style={{ width: '150px', height: '150px', borderRadius: '8px', objectFit: 'cover', border: '2px solid #ddd' }}
                          />
                        ) : (
                          <div style={{ width: '150px', height: '150px', borderRadius: '8px', backgroundColor: '#e0e0e0', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#555' }}>
                            No Photo
                          </div>
                        )}
                      </div>
                      <div style={{ flex: 1 }}>
                        <input
                          type="file"
                          accept="image/*"
                          onChange={handleProfileImageUpload}
                          disabled={loadingSubmit}
                          style={{ marginBottom: '10px' }}
                        />
                        <p style={{ fontSize: '12px', color: '#333', fontWeight: '600', margin: '10px 0 0 0' }}>
                          Select an image file (JPG, PNG, etc.) for the customer profile picture
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
                
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                  <div className="form-group">
                    <label>First Name</label>
                    <input
                      type="text"
                      value={editProfileData.firstName || ''}
                      onChange={(e) => setEditProfileData({ ...editProfileData, firstName: e.target.value })}
                      placeholder="First Name"
                      disabled={loadingSubmit}
                    />
                  </div>
                  <div className="form-group">
                    <label>Last Name</label>
                    <input
                      type="text"
                      value={editProfileData.lastName || ''}
                      onChange={(e) => setEditProfileData({ ...editProfileData, lastName: e.target.value })}
                      placeholder="Last Name"
                      disabled={loadingSubmit}
                    />
                  </div>
                  <div className="form-group">
                    <label>Home Phone</label>
                    <input
                      type="tel"
                      value={editProfileData.homePhone || ''}
                      onChange={(e) => setEditProfileData({ ...editProfileData, homePhone: e.target.value })}
                      placeholder="Home Phone"
                      disabled={loadingSubmit}
                    />
                  </div>
                  <div className="form-group">
                    <label>Mobile Phone</label>
                    <input
                      type="tel"
                      value={editProfileData.mobilePhone || ''}
                      onChange={(e) => setEditProfileData({ ...editProfileData, mobilePhone: e.target.value })}
                      placeholder="Mobile Phone"
                      disabled={loadingSubmit}
                    />
                  </div>
                  <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                    <label>Email</label>
                    <input
                      type="email"
                      value={editProfileData.email || ''}
                      onChange={(e) => setEditProfileData({ ...editProfileData, email: e.target.value })}
                      placeholder="Email Address"
                      disabled={loadingSubmit}
                    />
                  </div>
                  <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                    <label>Street Address</label>
                    <input
                      type="text"
                      value={editProfileData.streetAddress || ''}
                      onChange={(e) => setEditProfileData({ ...editProfileData, streetAddress: e.target.value })}
                      placeholder="Street Address"
                      disabled={loadingSubmit}
                    />
                  </div>
                  <div className="form-group">
                    <label>City</label>
                    <input
                      type="text"
                      value={editProfileData.city || ''}
                      onChange={(e) => setEditProfileData({ ...editProfileData, city: e.target.value })}
                      placeholder="City"
                      disabled={loadingSubmit}
                    />
                  </div>
                  <div className="form-group">
                    <label>State</label>
                    <input
                      type="text"
                      value={editProfileData.state || ''}
                      onChange={(e) => setEditProfileData({ ...editProfileData, state: e.target.value })}
                      placeholder="State"
                      disabled={loadingSubmit}
                    />
                  </div>
                  <div className="form-group">
                    <label>Zipcode</label>
                    <input
                      type="text"
                      value={editProfileData.zipcode || ''}
                      onChange={(e) => setEditProfileData({ ...editProfileData, zipcode: e.target.value })}
                      placeholder="Zipcode"
                      disabled={loadingSubmit}
                    />
                  </div>
                  <div className="form-group">
                    <label>ID Type</label>
                    <input
                      type="text"
                      value={editProfileData.idType || ''}
                      onChange={(e) => setEditProfileData({ ...editProfileData, idType: e.target.value })}
                      placeholder="ID Type (Driver's License, Passport, etc.)"
                      disabled={loadingSubmit}
                    />
                  </div>
                  <div className="form-group">
                    <label>ID Number</label>
                    <input
                      type="text"
                      value={editProfileData.idNumber || ''}
                      onChange={(e) => setEditProfileData({ ...editProfileData, idNumber: e.target.value })}
                      placeholder="ID Number"
                      disabled={loadingSubmit}
                    />
                  </div>
                </div>

                <div style={{ display: 'flex', gap: '10px', marginTop: '20px' }}>
                  <button type="submit" className="btn-success" disabled={loadingSubmit}>
                    {loadingSubmit ? 'Saving...' : '✓ Save Changes'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowEditProfile(false);
                      setEditProfileData({});
                      setProfileImage(null);
                      setProfileImagePreview(null);
                    }}
                    className="btn-primary"
                    disabled={loadingSubmit}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>

        {/* Tabs */}
        <div className="tabs" style={{ marginBottom: '20px' }}>
          <button
            className={`tab-button ${activeTab === 'loans' ? 'active' : ''}`}
            onClick={() => {
              setActiveTab('loans');
              setShowLoanForm(false);
            }}
          >
            📋 Loans ({profileLoans.length})
          </button>
          <button
            className={`tab-button ${activeTab === 'create' ? 'active' : ''}`}
            onClick={() => {
              setActiveTab('create');
              setShowLoanForm(true);
              setOperationType('create');
              setSelectedLoan(null);
            }}
          >
            ➕ Create New Loan
          </button>
        </div>

        {/* Loans List */}
        {activeTab === 'loans' && !showLoanForm && (
          <div>
            {/* Loan Status Tabs */}
            <div className="tabs" style={{ marginBottom: '20px' }}>
              <button
                className={`tab-button ${loansTab === 'active' ? 'active' : ''}`}
                onClick={() => setLoansTab('active')}
              >
                ✓ Active ({profileLoans.filter(l => l.status?.toLowerCase() === 'active').length})
              </button>
              <button
                className={`tab-button ${loansTab === 'overdue' ? 'active' : ''}`}
                onClick={() => setLoansTab('overdue')}
              >
                ⚠️ Overdue ({profileLoans.filter(l => l.status?.toLowerCase() === 'overdue').length})
              </button>
              <button
                className={`tab-button ${loansTab === 'redeemed' ? 'active' : ''}`}
                onClick={() => setLoansTab('redeemed')}
              >
                ✓ Redeemed ({profileLoans.filter(l => l.status?.toLowerCase() === 'redeemed').length})
              </button>
              <button
                className={`tab-button ${loansTab === 'forfeited' ? 'active' : ''}`}
                onClick={() => setLoansTab('forfeited')}
              >
                ✕ Forfeited ({profileLoans.filter(l => l.status?.toLowerCase() === 'forfeited').length})
              </button>
            </div>

            {profileLoans.filter(loan => loan.status?.toLowerCase() === loansTab).length > 0 ? (
              profileLoans
                .filter(loan => loan.status?.toLowerCase() === loansTab)
                .map((loan, idx) => (
                <div key={idx} className="card" style={{ marginBottom: '15px' }}>
                  <div style={{ padding: '20px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: '15px' }}>
                      <div>
                        <p style={{ margin: '0 0 5px 0', fontSize: '16px', fontWeight: 'bold' }}>
                          Loan #{loan.id}
                        </p>
                        <p style={{ margin: '5px 0', fontSize: '12px', color: '#333', fontWeight: '600' }}>
                          Transaction: {loan.transactionNumber}
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

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr 1fr 1fr', gap: '12px', marginBottom: '15px' }}>
                      <div>
                        <p style={{ margin: '0', fontSize: '12px', color: '#000', fontWeight: '600' }}>Amount</p>
                        <p style={{ margin: '5px 0 0 0', fontSize: '14px', fontWeight: 'bold' }}>
                          ${(loan.loanAmount || 0).toFixed(2)}
                        </p>
                      </div>
                      <div>
                        <p style={{ margin: '0', fontSize: '12px', color: '#000', fontWeight: '600' }}>Interest Rate</p>
                        <p style={{ margin: '5px 0 0 0', fontSize: '14px', fontWeight: 'bold' }}>
                          {loan.interestRate}%
                        </p>
                      </div>
                      <div>
                        <p style={{ margin: '0', fontSize: '12px', color: '#000', fontWeight: '600' }}>Interest Amount</p>
                        <p style={{ margin: '5px 0 0 0', fontSize: '14px', fontWeight: 'bold' }}>
                          ${(loan.interestAmount || 0).toFixed(2)}
                        </p>
                      </div>
                      <div>
                        <p style={{ margin: '0', fontSize: '12px', color: '#000', fontWeight: '600' }}>Recurring Fee</p>
                        <p style={{ margin: '5px 0 0 0', fontSize: '14px', fontWeight: 'bold' }}>
                          ${(loan.recurringFee || 0).toFixed(2)}
                        </p>
                      </div>
                      {loan.status?.toLowerCase() === 'redeemed' && loan.redemptionFee > 0 && (
                        <div>
                          <p style={{ margin: '0', fontSize: '12px', color: '#000', fontWeight: '600' }}>Redemption Fee</p>
                          <p style={{ margin: '5px 0 0 0', fontSize: '14px', fontWeight: 'bold', color: '#d32f2f' }}>
                            ${(loan.redemptionFee || 0).toFixed(2)}
                          </p>
                        </div>
                      )}
                      <div>
                        <p style={{ margin: '0', fontSize: '12px', color: '#000', fontWeight: '600' }}>Total Payable</p>
                        <p style={{ margin: '5px 0 0 0', fontSize: '14px', fontWeight: 'bold' }}>
                          ${(loan.totalPayableAmount || 0).toFixed(2)}
                        </p>
                      </div>
                      <div>
                        <p style={{ margin: '0', fontSize: '12px', color: '#000', fontWeight: '600' }}>Remaining Balance</p>
                        <p style={{ margin: '5px 0 0 0', fontSize: '14px', fontWeight: 'bold', color: loan.remainingBalance > 0 ? '#d32f2f' : '#388e3c' }}>
                          ${(loan.remainingBalance || 0).toFixed(2)}
                        </p>
                      </div>
                      <div>
                        <p style={{ margin: '0', fontSize: '12px', color: '#000', fontWeight: '600' }}>Created</p>
                        <p style={{ margin: '5px 0 0 0', fontSize: '12px' }}>
                          {formatDate(loan.createdAt)}
                        </p>
                      </div>
                      <div>
                        <p style={{ margin: '0', fontSize: '12px', color: '#000', fontWeight: '600' }}>Due</p>
                        <p style={{ margin: '5px 0 0 0', fontSize: '12px' }}>
                          {loan.dueDate ? formatDate(loan.dueDate) : 'N/A'}
                        </p>
                      </div>
                    </div>

                    <p style={{ margin: '12px 0', fontSize: '13px', color: '#333', fontWeight: '500' }}>
                      <strong>Item:</strong> {loan.item_description || loan.itemDescription || 'N/A'}
                    </p>

                    {loan.collateral_image && (
                      <div style={{ margin: '12px 0', cursor: 'pointer' }}>
                        <p style={{ margin: '0 0 8px 0', fontSize: '12px', color: '#000', fontWeight: '600' }}>📷 Item Photo:</p>
                        <img
                          src={loan.collateral_image}
                          alt="Collateral"
                          onClick={() => {
                            // Create a modal view for the image
                            const imageWindow = window.open('', '_blank');
                            imageWindow.document.write(`
                              <html>
                                <head><title>Loan Item Photo - Loan #${loan.id}</title></head>
                                <body style="margin: 0; padding: 0; display: flex; align-items: center; justify-content: center; height: 100vh; background-color: #000;">
                                  <img src="${loan.collateral_image}" style="max-width: 90vw; max-height: 90vh; object-fit: contain;">
                                </body>
                              </html>
                            `);
                            imageWindow.document.close();
                          }}
                          style={{ maxWidth: '250px', maxHeight: '250px', borderRadius: '4px', border: '2px solid #ddd', cursor: 'pointer', transition: 'transform 0.2s' }}
                          title="Click to view full size"
                        />
                      </div>
                    )}

                    {loan.status?.toLowerCase() === 'active' && (
                      <div style={{ display: 'flex', gap: '10px', marginTop: '12px', flexWrap: 'wrap' }}>
                        <button
                          onClick={() => {
                            setSelectedLoan(loan);
                            setOperationType('addMoney');
                            setShowLoanForm(true);
                            setActiveTab('operations');
                          }}
                          className="btn-primary"
                          style={{ flex: 1, minWidth: '120px' }}
                        >
                          💰 Add Money
                        </button>
                        <button
                          onClick={() => {
                            setSelectedLoan(loan);
                            setOperationType('payment');
                            setShowLoanForm(true);
                            setActiveTab('operations');
                          }}
                          className="btn-info"
                          style={{ flex: 1, minWidth: '120px' }}
                        >
                          💳 Make Payment
                        </button>
                        <button
                          onClick={() => {
                            setSelectedLoan(loan);
                            setOperationType('discount');
                            setShowLoanForm(true);
                            setActiveTab('operations');
                          }}
                          className="btn-warning"
                          style={{ flex: 1, minWidth: '120px' }}
                        >
                          🏷️ Discount Interest
                        </button>
                        <button
                          onClick={() => {
                            setSelectedLoan(loan);
                            setOperationType('extend');
                            setShowLoanForm(true);
                            setActiveTab('operations');
                          }}
                          className="btn-warning"
                          style={{ flex: 1, minWidth: '120px' }}
                        >
                          📅 Extend Loan
                        </button>
                        <button
                          onClick={() => {
                            setSelectedLoan(loan);
                            setOperationType('redeem');
                            setShowLoanForm(true);
                            setActiveTab('operations');
                          }}
                          className="btn-success"
                          style={{ flex: 1, minWidth: '120px' }}
                        >
                          ✓ Redeem
                        </button>
                        {canForfeitLoan(loan) ? (
                          <button
                            onClick={() => {
                              setSelectedLoan(loan);
                              setOperationType('forfeit');
                              setShowLoanForm(true);
                              setActiveTab('operations');
                            }}
                            className="btn-danger"
                            style={{ flex: 1, minWidth: '120px' }}
                            title={getForfeitButtonTooltip(loan)}
                          >
                            ✕ Forfeit
                          </button>
                        ) : (
                          <button
                            className="btn-danger"
                            style={{ flex: 1, minWidth: '120px', opacity: 0.5, cursor: 'not-allowed' }}
                            disabled
                            title={getForfeitButtonTooltip(loan)}
                          >
                            ✕ Forfeit
                          </button>
                        )}
                        <button
                          onClick={() => handleDownloadReceipt(loan)}
                          className="btn-secondary"
                          style={{ flex: 1, minWidth: '120px' }}
                          title="Download receipt PDF for this loan"
                        >
                          📥 Re-download Receipt
                        </button>
                        <button
                          onClick={() => {
                            if (window.confirm('⚠️ Are you sure you want to void this loan? This will permanently delete it. This action cannot be undone.')) {
                              setSelectedLoan(loan);
                              setOperationType('void');
                              setShowLoanForm(true);
                              setActiveTab('operations');
                            }
                          }}
                          className="btn-danger"
                          style={{ flex: 1, minWidth: '120px', backgroundColor: '#8b0000' }}
                          title="Permanently delete this loan"
                        >
                          🗑️ Void Loan
                        </button>
                      </div>
                    )}

                    {loan.status?.toLowerCase() === 'overdue' && (
                      <div style={{ display: 'flex', gap: '10px', marginTop: '12px', flexWrap: 'wrap' }}>
                        <button
                          onClick={() => {
                            setSelectedLoan(loan);
                            setOperationType('payment');
                            setShowLoanForm(true);
                            setActiveTab('operations');
                          }}
                          className="btn-info"
                          style={{ flex: 1, minWidth: '120px' }}
                          title="Make payment to resolve overdue status"
                        >
                          💳 Make Payment
                        </button>
                        <button
                          onClick={() => {
                            setSelectedLoan(loan);
                            setOperationType('extend');
                            setShowLoanForm(true);
                            setActiveTab('operations');
                          }}
                          className="btn-warning"
                          style={{ flex: 1, minWidth: '120px' }}
                          title="Extend the due date for this overdue loan"
                        >
                          📅 Extend Loan
                        </button>
                        <button
                          onClick={() => {
                            setSelectedLoan(loan);
                            setOperationType('redeem');
                            setShowLoanForm(true);
                            setActiveTab('operations');
                          }}
                          className="btn-success"
                          style={{ flex: 1, minWidth: '120px' }}
                          title="Redeem this loan to close it"
                        >
                          ✓ Redeem
                        </button>
                        <button
                          onClick={() => handleDownloadReceipt(loan)}
                          className="btn-secondary"
                          style={{ flex: 1, minWidth: '120px' }}
                          title="Download receipt PDF for this loan"
                        >
                          📥 Re-download Receipt
                        </button>
                      </div>
                    )}

                    {loan.status?.toLowerCase() === 'forfeited' && (
                      <div style={{ marginTop: '12px', display: 'flex', gap: '10px' }}>
                        <button
                          onClick={() => {
                            setSelectedLoan(loan);
                            setOperationType('reactivate');
                            setShowLoanForm(true);
                            setActiveTab('operations');
                          }}
                          className="btn-success"
                          style={{ flex: 1 }}
                        >
                          ♻️ Reactivate Loan
                        </button>
                        <button
                          onClick={() => {
                            if (window.confirm('⚠️ Are you sure you want to void this loan? This will permanently delete it. This action cannot be undone.')) {
                              setSelectedLoan(loan);
                              setOperationType('void');
                              setShowLoanForm(true);
                              setActiveTab('operations');
                            }
                          }}
                          className="btn-danger"
                          style={{ flex: 1, backgroundColor: '#8b0000' }}
                          title="Permanently delete this loan"
                        >
                          🗑️ Void Loan
                        </button>
                      </div>
                    )}

                    {loan.status?.toLowerCase() === 'redeemed' && (
                      <div style={{ marginTop: '12px' }}>
                        <button
                          onClick={() => {
                            if (window.confirm('⚠️ Are you sure you want to void this loan? This will permanently delete it. This action cannot be undone.')) {
                              setSelectedLoan(loan);
                              setOperationType('void');
                              setShowLoanForm(true);
                              setActiveTab('operations');
                            }
                          }}
                          className="btn-danger"
                          style={{ width: '100%', backgroundColor: '#8b0000' }}
                          title="Permanently delete this loan"
                        >
                          🗑️ Void Loan
                        </button>
                      </div>
                    )}

                    {/* Payment History Toggle */}
                    <div style={{ marginTop: '15px', paddingTop: '15px', borderTop: '1px solid #e0e6ed' }}>
                      <button
                        onClick={() => handleTogglePaymentHistory(loan.id)}
                        style={{
                          background: 'none',
                          border: 'none',
                          color: '#0066cc',
                          cursor: 'pointer',
                          fontSize: '14px',
                          fontWeight: 'bold',
                          padding: '0',
                          textDecoration: 'underline'
                        }}
                      >
                        {expandedLoanId === loan.id ? '▼ Hide' : '▶ Show'} Payment History
                      </button>
                    </div>

                    {/* Payment History Display */}
                    {expandedLoanId === loan.id && (
                      <div style={{ marginTop: '12px', padding: '12px', backgroundColor: '#f5f5f5', borderRadius: '4px' }}>
                        {loanPaymentHistory[loan.id] && loanPaymentHistory[loan.id].length > 0 ? (
                          <div>
                            <p style={{ margin: '0 0 12px 0', fontWeight: 'bold', color: '#333' }}>
                              Payment History ({loanPaymentHistory[loan.id].length})
                            </p>
                            <div style={{ maxHeight: '300px', overflowY: 'auto' }}>
                              {loanPaymentHistory[loan.id].map((payment, idx) => (
                                <div
                                  key={idx}
                                  style={{
                                    display: 'grid',
                                    gridTemplateColumns: '1fr 1fr 1.5fr',
                                    gap: '12px',
                                    padding: '10px',
                                    borderBottom: '1px solid #ddd',
                                    fontSize: '13px'
                                  }}
                                >
                                  <div>
                                    <p style={{ margin: '0', color: '#666', fontSize: '11px' }}>Amount</p>
                                    <p style={{ margin: '3px 0 0 0', fontWeight: 'bold' }}>
                                      ${parseFloat(payment.payment_amount || 0).toFixed(2)}
                                    </p>
                                  </div>
                                  <div>
                                    <p style={{ margin: '0', color: '#666', fontSize: '11px' }}>Method</p>
                                    <p style={{ margin: '3px 0 0 0', fontWeight: 'bold' }}>
                                      {(() => {
                                        const method = (payment.payment_method || 'cash').toLowerCase();
                                        const methodMap = {
                                          'cash': '💵 Cash',
                                          'mastercard': '🟣 Mastercard',
                                          'visa': '🔵 Visa',
                                          'amex': '🟢 American Express',
                                          'etransfer': '📧 E-Transfer',
                                          'debit': '💳 Debit Card',
                                          'check': '📄 Check',
                                          'other': '❓ Other'
                                        };
                                        return methodMap[method] || `${method.charAt(0).toUpperCase() + method.slice(1)}`;
                                      })()}
                                    </p>
                                  </div>
                                  <div>
                                    <p style={{ margin: '0', color: '#666', fontSize: '11px' }}>Date</p>
                                    <p style={{ margin: '3px 0 0 0', fontWeight: 'bold' }}>
                                      {parseDateString(payment.payment_date)?.toLocaleString() || 'N/A'}
                                    </p>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        ) : (
                          <p style={{ margin: '0', color: '#666', fontSize: '13px' }}>No payments made yet</p>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ))
            ) : (
              <div className="alert alert-info">
                No {loansTab} loans for this customer yet.
              </div>
            )}
          </div>
        )}

        {/* Loan Operation Forms */}
        {showLoanForm && (
          <div className="card">
            <div className="card-header">
              {operationType === 'create' && 'Create New Loan'}
              {operationType === 'addMoney' && 'Add Money to Loan'}
              {operationType === 'payment' && 'Make Payment'}
              {operationType === 'extend' && 'Extend Loan Due Date'}
              {operationType === 'redeem' && 'Redeem Loan'}
              {operationType === 'forfeit' && 'Forfeit Loan'}
              {operationType === 'reactivate' && 'Reactivate Loan'}
              {operationType === 'edit' && 'Edit Loan'}
              {operationType === 'void' && 'Void Loan'}
            </div>
            <form onSubmit={handleLoanOperation} style={{ padding: '20px' }}>
              {operationType === 'create' && (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '16px' }}>
                    <div className="form-group">
                      <label>Loan Amount *</label>
                      <input
                        type="number"
                        value={loanFormData.loanAmount}
                        onChange={(e) => setLoanFormData({ ...loanFormData, loanAmount: e.target.value })}
                        placeholder="Amount"
                        step="0.01"
                        required
                        disabled={loadingSubmit}
                      />
                    </div>
                    <div className="form-group">
                      <label>Interest Rate (%) *</label>
                      <input
                        type="number"
                        value={loanFormData.interestRate}
                        onChange={(e) => setLoanFormData({ ...loanFormData, interestRate: e.target.value })}
                        placeholder="Rate"
                        step="0.01"
                        required
                        disabled={loadingSubmit}
                      />
                    </div>
                    <div className="form-group">
                      <label>Loan Term (days) *</label>
                      <input
                        type="number"
                        value={loanFormData.loanTerm}
                        onChange={(e) => setLoanFormData({ ...loanFormData, loanTerm: e.target.value })}
                        placeholder="Days"
                        required
                        disabled={loadingSubmit}
                      />
                    </div>
                    <div className="form-group">
                      <label>Recurring Fee ($/month)</label>
                      <input
                        type="number"
                        value={loanFormData.recurringFee}
                        onChange={(e) => setLoanFormData({ ...loanFormData, recurringFee: e.target.value })}
                        placeholder="0.00"
                        step="0.01"
                        disabled={loadingSubmit}
                      />
                    </div>
                  </div>
                  <div className="form-group">
                    <label>Collateral Description *</label>
                    <textarea
                      value={loanFormData.collateralDescription}
                      onChange={(e) => setLoanFormData({ ...loanFormData, collateralDescription: e.target.value })}
                      placeholder="Describe the collateral"
                      required
                      disabled={loadingSubmit}
                      style={{ minHeight: '80px' }}
                    />
                  </div>
                  <div className="form-group">
                    <label>Collateral Picture 📷</label>
                    {loanFormData.collateralImagePreview ? (
                      <div>
                        <img
                          src={loanFormData.collateralImagePreview}
                          alt="Collateral preview"
                          style={{ maxWidth: '100%', maxHeight: '250px', borderRadius: '8px', marginBottom: '15px', objectFit: 'cover', border: '1px solid #ddd' }}
                        />
                        <button
                          type="button"
                          className="btn-secondary"
                          onClick={() => setLoanFormData({ ...loanFormData, collateralImage: null, collateralImagePreview: null })}
                          style={{ width: '100%', marginBottom: '10px' }}
                          disabled={loadingSubmit}
                        >
                          Remove Image
                        </button>
                        <button
                          type="button"
                          className="btn-primary"
                          onClick={() => setShowImageCapture(true)}
                          style={{ width: '100%' }}
                          disabled={loadingSubmit}
                        >
                          Change Image
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="btn-primary"
                        onClick={() => setShowImageCapture(true)}
                        style={{ width: '100%', padding: '12px' }}
                        disabled={loadingSubmit}
                      >
                        📷 Capture or Upload Collateral Image
                      </button>
                    )}
                  </div>
                  <div className="form-group">
                    <label>Notes</label>
                    <textarea
                      value={loanFormData.customerNote}
                      onChange={(e) => setLoanFormData({ ...loanFormData, customerNote: e.target.value })}
                      placeholder="Additional notes"
                      disabled={loadingSubmit}
                      style={{ minHeight: '60px' }}
                    />
                  </div>
                </>
              )}

              {operationType === 'edit' && (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '16px' }}>
                    <div className="form-group">
                      <label>Loan Amount *</label>
                      <input
                        type="number"
                        value={loanFormData.loanAmount}
                        onChange={(e) => setLoanFormData({ ...loanFormData, loanAmount: e.target.value })}
                        placeholder="Amount"
                        step="0.01"
                        required
                        disabled={loadingSubmit}
                      />
                    </div>
                    <div className="form-group">
                      <label>Interest Rate (%) *</label>
                      <input
                        type="number"
                        value={loanFormData.interestRate}
                        onChange={(e) => setLoanFormData({ ...loanFormData, interestRate: e.target.value })}
                        placeholder="Rate"
                        step="0.01"
                        required
                        disabled={loadingSubmit}
                      />
                    </div>
                    <div className="form-group">
                      <label>Status</label>
                      <input
                        type="text"
                        value={selectedLoan?.status || ''}
                        disabled={true}
                        style={{ backgroundColor: '#f0f0f0' }}
                      />
                    </div>
                  </div>
                  <div className="form-group">
                    <label>Collateral Description *</label>
                    <textarea
                      value={loanFormData.collateralDescription}
                      onChange={(e) => setLoanFormData({ ...loanFormData, collateralDescription: e.target.value })}
                      placeholder="Describe the collateral"
                      required
                      disabled={loadingSubmit}
                      style={{ minHeight: '80px' }}
                    />
                  </div>
                  <div className="form-group">
                    <label>Collateral Picture 📷</label>
                    {loanFormData.collateralImagePreview ? (
                      <div>
                        <img
                          src={loanFormData.collateralImagePreview}
                          alt="Collateral preview"
                          style={{ maxWidth: '100%', maxHeight: '250px', borderRadius: '8px', marginBottom: '15px', objectFit: 'cover', border: '1px solid #ddd' }}
                        />
                        <button
                          type="button"
                          className="btn-secondary"
                          onClick={() => setLoanFormData({ ...loanFormData, collateralImage: null, collateralImagePreview: null })}
                          style={{ width: '100%', marginBottom: '10px' }}
                          disabled={loadingSubmit}
                        >
                          Remove Image
                        </button>
                        <button
                          type="button"
                          className="btn-primary"
                          onClick={() => setShowImageCapture(true)}
                          style={{ width: '100%' }}
                          disabled={loadingSubmit}
                        >
                          Change Image
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="btn-primary"
                        onClick={() => setShowImageCapture(true)}
                        style={{ width: '100%', padding: '12px' }}
                        disabled={loadingSubmit}
                      >
                        📷 Capture or Upload Collateral Image
                      </button>
                    )}
                  </div>
                  <div className="form-group">
                    <label>Notes</label>
                    <textarea
                      value={loanFormData.customerNote}
                      onChange={(e) => setLoanFormData({ ...loanFormData, customerNote: e.target.value })}
                      placeholder="Additional notes"
                      disabled={loadingSubmit}
                      style={{ minHeight: '60px' }}
                    />
                  </div>
                </>
              )}

              {operationType === 'addMoney' && (
                <div className="form-group">
                  <label>Amount to Add *</label>
                  <input
                    type="number"
                    value={loanFormData.addMoneyAmount}
                    onChange={(e) => setLoanFormData({ ...loanFormData, addMoneyAmount: e.target.value })}
                    placeholder="Enter amount to add"
                    step="0.01"
                    required
                    disabled={loadingSubmit}
                  />
                </div>
              )}

              {operationType === 'payment' && (
                <>
                  <div className="form-group">
                    <label>Payment Amount *</label>
                    <input
                      type="number"
                      value={loanFormData.paymentAmount}
                      onChange={(e) => setLoanFormData({ ...loanFormData, paymentAmount: e.target.value })}
                      placeholder={`Max: $${(selectedLoan?.remainingBalance || 0).toFixed(2)}`}
                      step="0.01"
                      required
                      disabled={loadingSubmit}
                    />
                  </div>
                  
                  {loanFormData.paymentAmount && parseFloat(loanFormData.paymentAmount) > (selectedLoan?.remainingBalance || 0) && (
                    <div className="alert alert-warning" style={{ marginBottom: '15px', padding: '12px', backgroundColor: '#fff3cd', border: '1px solid #ffc107', borderRadius: '4px', color: '#856404' }}>
                      ⚠️ <strong>Overpayment Alert:</strong> Payment amount ($${parseFloat(loanFormData.paymentAmount).toFixed(2)}) exceeds remaining balance ($${(selectedLoan?.remainingBalance || 0).toFixed(2)}) by $${(parseFloat(loanFormData.paymentAmount) - (selectedLoan?.remainingBalance || 0)).toFixed(2)}
                    </div>
                  )}
                  
                  <div className="form-group">
                    <label>Payment Method *</label>
                    <select
                      value={loanFormData.paymentMethod}
                      onChange={(e) => setLoanFormData({ ...loanFormData, paymentMethod: e.target.value })}
                      required
                      disabled={loadingSubmit}
                    >
                      <option value="cash">💵 Cash</option>
                      <option value="mastercard">🟣 Mastercard</option>
                      <option value="visa">🔵 Visa</option>
                      <option value="amex">🟢 American Express</option>
                      <option value="etransfer">📧 E-Transfer</option>
                      <option value="debit">💳 Debit Card</option>
                      <option value="check">📄 Check</option>
                      <option value="other">❓ Other</option>
                    </select>
                  </div>
                </>
              )}

              {operationType === 'discount' && (
                <>
                  <div className="form-group">
                    <label>Current Interest Amount: <strong>${(selectedLoan?.interestAmount || 0).toFixed(2)}</strong></label>
                  </div>
                  <div className="form-group">
                    <label>Discount Amount *</label>
                    <input
                      type="number"
                      value={loanFormData.discountAmount}
                      onChange={(e) => setLoanFormData({ ...loanFormData, discountAmount: e.target.value })}
                      placeholder={`Max: $${(selectedLoan?.interestAmount || 0).toFixed(2)}`}
                      step="0.01"
                      min="0"
                      max={selectedLoan?.interestAmount || 0}
                      required
                      disabled={loadingSubmit}
                    />
                  </div>
                  <div className="form-group" style={{ backgroundColor: '#f0f8ff', padding: '10px', borderRadius: '4px' }}>
                    <p><strong>New Interest Amount:</strong> ${Math.max(0, (selectedLoan?.interestAmount || 0) - (parseFloat(loanFormData.discountAmount) || 0)).toFixed(2)}</p>
                    <p><strong>New Total Payable:</strong> ${(parseFloat(selectedLoan?.loanAmount || 0) + Math.max(0, (selectedLoan?.interestAmount || 0) - (parseFloat(loanFormData.discountAmount) || 0))).toFixed(2)}</p>
                  </div>
                </>
              )}

              {operationType === 'extend' && (
                <div className="form-group">
                  <label>Days to Extend *</label>
                  <input
                    type="number"
                    value={loanFormData.daysToExtend}
                    onChange={(e) => setLoanFormData({ ...loanFormData, daysToExtend: e.target.value })}
                    placeholder="Number of days"
                    required
                    disabled={loadingSubmit}
                  />
                </div>
              )}

              {operationType === 'redeem' && (
                <>
                  <div className="alert alert-success">
                    ✓ Redeem Amount: <strong>${(selectedLoan?.totalPayableAmount || 0).toFixed(2)}</strong>
                  </div>
                  <div className="form-group">
                    <label htmlFor="redemptionFee">One-Time Redemption Fee (Repairs, Processing, etc.)</label>
                    <input
                      type="number"
                      id="redemptionFee"
                      name="redemptionFee"
                      step="0.01"
                      min="0"
                      value={loanFormData.redemptionFee}
                      onChange={(e) => setLoanFormData({ ...loanFormData, redemptionFee: e.target.value })}
                      placeholder="Enter redemption fee (optional)"
                      style={{ width: '100%' }}
                    />
                  </div>
                </>
              )}

              {operationType === 'forfeit' && (
                <div className="alert alert-warning">
                  ⚠️ Are you sure you want to forfeit this loan? This will mark the collateral as forfeited.
                </div>
              )}

              {operationType === 'reactivate' && (
                <div className="alert alert-info">
                  ♻️ Are you sure you want to reactivate this loan? The forfeiture will be undone.
                </div>
              )}

              <div style={{ display: 'flex', gap: '10px', marginTop: '20px' }}>
                <button type="submit" className="btn-success" disabled={loadingSubmit}>
                  {loadingSubmit ? 'Processing...' : '✓ Confirm'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowLoanForm(false);
                    setSelectedLoan(null);
                    setLoanFormData({
                      loanAmount: '',
                      interestRate: '',
                      collateralDescription: '',
                      customerNote: '',
                      paymentAmount: '',
                      addMoneyAmount: '',
                      daysToExtend: '',
                      discountAmount: '',
                      loanTerm: '',
                      recurringFee: '',
                      redemptionFee: ''
                    });
                  }}
                  className="btn-primary"
                  disabled={loadingSubmit}
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        )}
      </div>
      {showImageCapture && (
        <CollateralImageCapture 
          onImageCapture={handleImageCapture} 
          onCancel={() => setShowImageCapture(false)} 
        />
      )}
    </React.Fragment>
    );
  }

  // Initial search view
  return (
    <div className="form-container">
      <h3>Manage Customer Profile & Loans</h3>
      <p style={{ color: '#888', marginBottom: '20px', fontSize: '13px' }}>
        Search for a customer profile to manage their loans: create new loans, make payments, extend due dates, redeem, forfeit, or reactivate loans.
      </p>

      {message && (
        <div className={`alert alert-${messageType}`} style={{ marginBottom: '20px' }}>
          {message}
        </div>
      )}

      <form onSubmit={handleSearch} style={{ marginBottom: '30px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr auto', gap: '12px', alignItems: 'flex-end' }}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>Search By</label>
            <select
              value={searchType}
              onChange={(e) => {
                setSearchType(e.target.value);
                setSearchValue('');
              }}
              disabled={loadingSearch}
            >
              <option value="phone">Phone Number</option>
              <option value="name">Name</option>
              <option value="customerId">Customer ID</option>
            </select>
          </div>

          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>
              {searchType === 'phone' ? 'Phone' : searchType === 'name' ? 'Name' : 'Customer ID'}
            </label>
            <input
              type="text"
              value={searchValue}
              onChange={(e) => setSearchValue(e.target.value)}
              placeholder={
                searchType === 'phone' ? 'e.g., 555-123-4567' :
                searchType === 'name' ? 'e.g., John Doe' :
                'e.g., CUST-12345'
              }
              disabled={loadingSearch}
            />
          </div>

          <button type="submit" className="btn-primary" disabled={loadingSearch || !searchValue}>
            {loadingSearch ? 'Searching...' : 'Search'}
          </button>
        </div>
      </form>
      </div>
    );
  };

export default ManageCustomerProfileForm;
