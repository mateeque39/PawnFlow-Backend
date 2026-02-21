import React, { useState } from 'react';
import logger from './services/logger';
import { http } from './services/httpClient';
import RegisterForm from './RegisterForm';
import LoginForm from './LoginForm';
import AdminPanel from './AdminPanel';
import ShiftManagement from './ShiftManagement';
import CashReport from './CashReport';
import LoansOverview from './LoansOverview';
import CreateCustomerProfileForm from './CreateCustomerProfileForm';
import ManageCustomerProfileForm from './ManageCustomerProfileForm';
import EditLoanForm from './EditLoanForm';
import PDFSettingsForm from './PDFSettingsForm';
import ErrorBoundary from './ErrorBoundary'; // Import the ErrorBoundary component

function App() {
  const [isLogin, setIsLogin] = useState(true);
  const [isRegister, setIsRegister] = useState(false);
  const [isAdminPanel, setIsAdminPanel] = useState(false);
  const [loggedInUser, setLoggedInUser] = useState(() => {
    // Restore logged-in user from localStorage on app load
    const saved = localStorage.getItem('loggedInUser');
    if (saved) {
      try {
        const user = JSON.parse(saved);
        // SECURITY: Only restore if valid token exists
        if (user && user.token) {
          logger.info('User session restored from localStorage');
          return user;
        } else {
          // Invalid session - force re-login
          localStorage.removeItem('loggedInUser');
          return null;
        }
      } catch (e) {
        logger.warn('Failed to parse saved user:', e);
        localStorage.removeItem('loggedInUser');
        return null;
      }
    }
    return null;
  });
  const [selectedOption, setSelectedOption] = useState('');
  const [registrationPassword, setRegistrationPassword] = useState('');
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [showChangePasswordModal, setShowChangePasswordModal] = useState(false);
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordChangeMessage, setPasswordChangeMessage] = useState('');

  // Handle Login Success (set logged-in user)
  const handleLoginSuccess = (user) => {
    setLoggedInUser(user);
    setIsLogin(false);
    setIsRegister(false); // Hide register form
    // Save user to localStorage to persist across page refreshes
    localStorage.setItem('loggedInUser', JSON.stringify(user));
    logger.info('User logged in successfully:', { username: user.username, role: user.role });
  };

  // Handle Logout
  const handleLogout = async () => {
    try {
      // Validate user ID before making request
      if (!loggedInUser?.user_id) {
        logger.warn('Logout: No valid user_id found, proceeding with logout');
        setLoggedInUser(null);
        localStorage.removeItem('loggedInUser');
        return;
      }

      // Check if user has an active shift
      const response = await http.get(`/current-shift/${loggedInUser.user_id}`);
      const activeShift = response?.data;
      
      if (activeShift && activeShift.shift_end_time === null) {
        // User has an active shift
        alert('You cannot logout before closing your shift. Please end your shift first.');
        logger.warn('Logout blocked - user has active shift', { userId: loggedInUser.user_id });
        return;
      }
    } catch (error) {
      // If we get 404 or other errors, it means no active shift (which is good)
      logger.debug('No active shift found, proceeding with logout');
    }
    
    // No active shift, proceed with logout
    setLoggedInUser(null); // Clear logged-in user state
    setIsLogin(true); // Redirect back to login
    setIsRegister(false); // Hide register form
    // Remove user from localStorage
    localStorage.removeItem('loggedInUser');
    setSelectedOption(''); // Clear selected menu option
    logger.info('User logged out');
  };

  const handleRegistrationPasswordSubmit = () => {
    const DEFAULT_REGISTRATION_PASSWORD = 'pawnflowniran!@#12';
    const STORED_REGISTRATION_PASSWORD = localStorage.getItem('registrationPassword') || DEFAULT_REGISTRATION_PASSWORD;
    
    if (registrationPassword === STORED_REGISTRATION_PASSWORD) {
      setShowPasswordModal(false);
      setRegistrationPassword('');
      setIsRegister(true);
      setIsLogin(false);
    } else {
      alert('Incorrect password. Please try again.');
      setRegistrationPassword('');
    }
  };

  const handleRegistrationClick = () => {
    setShowPasswordModal(true);
    setRegistrationPassword('');
  };

  const handleChangePassword = () => {
    const REGISTRATION_PASSWORD = 'pawnflowniran!@#12';
    
    setPasswordChangeMessage('');
    
    // Validate old password
    if (oldPassword !== REGISTRATION_PASSWORD) {
      setPasswordChangeMessage('❌ Old password is incorrect');
      return;
    }
    
    // Validate new password
    if (!newPassword || newPassword.trim() === '') {
      setPasswordChangeMessage('❌ New password cannot be empty');
      return;
    }
    
    // Validate password match
    if (newPassword !== confirmPassword) {
      setPasswordChangeMessage('❌ New passwords do not match');
      return;
    }
    
    // Validate password length
    if (newPassword.length < 8) {
      setPasswordChangeMessage('❌ Password must be at least 8 characters');
      return;
    }
    
    // Save new password to localStorage
    localStorage.setItem('registrationPassword', newPassword);
    
    setPasswordChangeMessage('✅ Password changed successfully!');
    setTimeout(() => {
      setShowChangePasswordModal(false);
      setOldPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPasswordChangeMessage('');
    }, 2000);
  };

  return (
    <div className="App dark-mode">
      <div className="pawnflow-header">
        <div className="header-content">
          <img src="/pawnflow-logo.png" alt="PawnFlow Logo" className="logo-img-title" />
        </div>
      </div>

      {/* Registration Password Modal */}
      {showPasswordModal && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.7)',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          zIndex: 1000
        }}>
          <div style={{
            backgroundColor: 'white',
            padding: '40px',
            borderRadius: '8px',
            boxShadow: '0 4px 6px rgba(0, 0, 0, 0.1)',
            minWidth: '300px',
            maxWidth: '400px'
          }}>
            <h3 style={{ marginBottom: '20px', textAlign: 'center' }}>Registration Access</h3>
            <p style={{ marginBottom: '20px', color: '#666', textAlign: 'center' }}>
              Enter the registration password to continue
            </p>
            <div style={{ marginBottom: '20px' }}>
              <input
                type="password"
                placeholder="Enter registration password"
                value={registrationPassword}
                onChange={(e) => setRegistrationPassword(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && handleRegistrationPasswordSubmit()}
                style={{
                  width: '100%',
                  padding: '10px',
                  border: '1px solid #ddd',
                  borderRadius: '4px',
                  fontSize: '14px',
                  boxSizing: 'border-box'
                }}
                autoFocus
              />
            </div>
            <div style={{ display: 'flex', gap: '10px' }}>
              <button
                onClick={handleRegistrationPasswordSubmit}
                style={{
                  flex: 1,
                  padding: '10px',
                  backgroundColor: '#28a745',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontSize: '14px',
                  fontWeight: 'bold'
                }}
              >
                Submit
              </button>
              <button
                onClick={() => {
                  setShowPasswordModal(false);
                  setRegistrationPassword('');
                }}
                style={{
                  flex: 1,
                  padding: '10px',
                  backgroundColor: '#6c757d',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontSize: '14px',
                  fontWeight: 'bold'
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Change Registration Password Modal */}
      {showChangePasswordModal && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.7)',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          zIndex: 1000
        }}>
          <div style={{
            backgroundColor: 'white',
            padding: '40px',
            borderRadius: '8px',
            boxShadow: '0 4px 6px rgba(0, 0, 0, 0.1)',
            minWidth: '300px',
            maxWidth: '400px'
          }}>
            <h3 style={{ marginBottom: '20px', textAlign: 'center' }}>Change Registration Password</h3>
            
            {passwordChangeMessage && (
              <div style={{
                marginBottom: '20px',
                padding: '12px',
                backgroundColor: passwordChangeMessage.includes('✅') ? '#d4edda' : '#f8d7da',
                border: `1px solid ${passwordChangeMessage.includes('✅') ? '#28a745' : '#f5c6cb'}`,
                borderRadius: '4px',
                color: passwordChangeMessage.includes('✅') ? '#155724' : '#721c24',
                textAlign: 'center'
              }}>
                {passwordChangeMessage}
              </div>
            )}
            
            <div style={{ marginBottom: '15px' }}>
              <label style={{ display: 'block', marginBottom: '5px', fontSize: '14px', fontWeight: 'bold' }}>Old Password</label>
              <input
                type="password"
                placeholder="Enter current password"
                value={oldPassword}
                onChange={(e) => setOldPassword(e.target.value)}
                style={{
                  width: '100%',
                  padding: '10px',
                  border: '1px solid #ddd',
                  borderRadius: '4px',
                  fontSize: '14px',
                  boxSizing: 'border-box'
                }}
              />
            </div>

            <div style={{ marginBottom: '15px' }}>
              <label style={{ display: 'block', marginBottom: '5px', fontSize: '14px', fontWeight: 'bold' }}>New Password</label>
              <input
                type="password"
                placeholder="Enter new password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                style={{
                  width: '100%',
                  padding: '10px',
                  border: '1px solid #ddd',
                  borderRadius: '4px',
                  fontSize: '14px',
                  boxSizing: 'border-box'
                }}
              />
            </div>

            <div style={{ marginBottom: '20px' }}>
              <label style={{ display: 'block', marginBottom: '5px', fontSize: '14px', fontWeight: 'bold' }}>Confirm New Password</label>
              <input
                type="password"
                placeholder="Confirm new password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && handleChangePassword()}
                style={{
                  width: '100%',
                  padding: '10px',
                  border: '1px solid #ddd',
                  borderRadius: '4px',
                  fontSize: '14px',
                  boxSizing: 'border-box'
                }}
              />
            </div>

            <div style={{ display: 'flex', gap: '10px' }}>
              <button
                onClick={handleChangePassword}
                style={{
                  flex: 1,
                  padding: '10px',
                  backgroundColor: '#28a745',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontSize: '14px',
                  fontWeight: 'bold'
                }}
              >
                Change Password
              </button>
              <button
                onClick={() => {
                  setShowChangePasswordModal(false);
                  setOldPassword('');
                  setNewPassword('');
                  setConfirmPassword('');
                  setPasswordChangeMessage('');
                }}
                style={{
                  flex: 1,
                  padding: '10px',
                  backgroundColor: '#6c757d',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontSize: '14px',
                  fontWeight: 'bold'
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="container">
        {isRegister ? (
          <div className="form-container">
            <h2>Create New Account</h2>
            <RegisterForm 
              onRegisterSuccess={() => {
                setIsRegister(false);
                setIsLogin(true);
              }}
              onSwitchToLogin={() => {
                setIsRegister(false);
                setIsLogin(true);
              }}
            />
          </div>
        ) : isLogin ? (
          <div className="form-container">
            <h2>Login</h2>
            <LoginForm 
              onLoginSuccess={handleLoginSuccess}
              onSwitchToRegister={handleRegistrationClick}
              onSwitchToAdminPanel={() => {
                setIsLogin(false);
                setIsAdminPanel(true);
              }}
            />
          </div>
        ) : isAdminPanel ? (
          <AdminPanel 
            onSwitchToLogin={() => {
              setIsAdminPanel(false);
              setIsLogin(true);
            }}
          />
        ) : loggedInUser ? (
          <div>
            <h2 style={{ textAlign: 'center', marginBottom: '20px' }}>Welcome to Dashboard, {loggedInUser.username}</h2>
            <div className="menu">
              <button className="btn-primary" onClick={() => setSelectedOption('view-all-loans')}>📊 View All Loans (Overdue)</button>
              <button className="btn-primary" onClick={() => setSelectedOption('create-profile')}>👤 Create Customer Profile</button>
              <button className="btn-success" onClick={() => setSelectedOption('manage-profile')}>⚙️ Manage Profile & Loans</button>
              <button className="btn-info" onClick={() => setSelectedOption('edit-loan')}>✏️ Edit Existing Loan</button>
              <button className="btn-warning" onClick={() => setSelectedOption('pdf-settings')}>📄 PDF Settings</button>
              <button className="btn-info" onClick={() => setSelectedOption('shift-management')}>Shift Management</button>
              <button className="btn-success" onClick={() => setSelectedOption('cash-report')}>💰 Cash Report</button>
              {loggedInUser?.role === 'admin' && (
                <>
                  <button className="btn-warning" onClick={() => setSelectedOption('register-user')}>👥 Register User (Admin Only)</button>
                  <button className="btn-warning" onClick={() => setShowChangePasswordModal(true)}>🔐 Change Registration Password (Admin Only)</button>
                </>
              )}
              <button className="btn-danger" onClick={handleLogout}>Logout</button>
            </div>

            {/* Wrap the components inside ErrorBoundary to catch runtime errors */}
            <ErrorBoundary>
              {selectedOption === 'view-all-loans' && <LoansOverview loggedInUser={loggedInUser} />}
              {selectedOption === 'create-profile' && <CreateCustomerProfileForm loggedInUser={loggedInUser} />}
              {selectedOption === 'manage-profile' && <ManageCustomerProfileForm loggedInUser={loggedInUser} />}
              {selectedOption === 'edit-loan' && <EditLoanForm loggedInUser={loggedInUser} />}
              {selectedOption === 'pdf-settings' && <PDFSettingsForm loggedInUser={loggedInUser} />}
              {selectedOption === 'shift-management' && <ShiftManagement userId={loggedInUser?.id} />}
              {selectedOption === 'cash-report' && <CashReport loggedInUser={loggedInUser} />}
              {selectedOption === 'register-user' && loggedInUser?.role === 'admin' && (
                <div className="form-container">
                  <h3>Register New User (Admin Only)</h3>
                  <RegisterForm loggedInUser={loggedInUser} onRegisterSuccess={() => setSelectedOption('')} />
                </div>
              )}
            </ErrorBoundary>
          </div>
        ) : (
          <div className="form-container">
            <h2 style={{ color: '#5dd9ff', textAlign: 'center', marginBottom: '10px' }}>Session Expired</h2>
            <p style={{ color: '#e0e0e0', textAlign: 'center', marginBottom: '30px' }}>Please log in again to continue.</p>
            <LoginForm 
              onLoginSuccess={handleLoginSuccess}
              onSwitchToRegister={() => {
                setIsLogin(false);
                setIsRegister(true);
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

export default App;