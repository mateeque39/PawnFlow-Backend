const axios = require('axios');

const API_URL = 'http://localhost:5000';

async function testLogin() {
  try {
    console.log('🔐 Testing login with default admin credentials...\n');
    
    // Test 1: Login with default admin
    console.log('TEST 1: Login with admin/admin123');
    try {
      const res1 = await axios.post(`${API_URL}/login`, {
        username: 'admin',
        password: 'admin123'
      });
      console.log('✅ SUCCESS:', res1.data);
    } catch (err) {
      console.log('❌ FAILED:', err.response?.data || err.message);
    }
    
    console.log('\n---\n');
    
    // Test 2: Try registering a new user with valid password
    console.log('TEST 2: Register new user with valid password');
    try {
      const res2 = await axios.post(`${API_URL}/register`, {
        username: 'testuser',
        password: 'Test1234',
        role: 'staff'
      });
      console.log('✅ Registration SUCCESS:', res2.data);
      
      // Now try to login
      console.log('\nTrying to login with testuser/Test1234...');
      const res3 = await axios.post(`${API_URL}/login`, {
        username: 'testuser',
        password: 'Test1234'
      });
      console.log('✅ Login SUCCESS:', res3.data);
    } catch (err) {
      console.log('❌ FAILED:', err.response?.data || err.message);
    }
    
    console.log('\n---\n');
    
    // Test 3: Check all users in database
    console.log('TEST 3: List all users in database');
    try {
      const res4 = await axios.get(`${API_URL}/all-accounts`);
      console.log('✅ Users found:', res4.data);
    } catch (err) {
      console.log('❌ Failed to fetch users:', err.response?.data || err.message);
    }
    
  } catch (error) {
    console.error('Test error:', error.message);
  }
}

testLogin();
