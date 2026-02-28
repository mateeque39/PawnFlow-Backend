const axios = require('axios');

async function testRailwayAPI() {
  try {
    console.log('\n🔍 Testing Railway Backend API...\n');
    
    const baseURL = 'https://pawnflow-backend-production.up.railway.app';
    const endpoint = '/customers/6/loans';
    const url = `${baseURL}${endpoint}`;
    
    console.log(`📡 Testing: ${url}\n`);
    
    const response = await axios.get(url, {
      timeout: 10000
    });
    
    console.log('✅ API Response Status:', response.status);
    console.log('\n📊 Loans Data:');
    console.log(`  - activeLoans: ${response.data.activeLoans?.length || 0}`);
    console.log(`  - overdueLoans: ${response.data.overdueLoans?.length || 0}`);
    console.log(`  - redeemedLoans: ${response.data.redeemedLoans?.length || 0}`);
    console.log(`  - forfeitedLoans: ${response.data.forfeitedLoans?.length || 0}`);
    
    if (response.data.overdueLoans?.length > 0) {
      console.log('\n✅ OVERDUE LOANS:');
      response.data.overdueLoans.forEach(loan => {
        console.log(`  - Loan ${loan.id}: $${loan.loan_amount} | Status: ${loan.status}`);
      });
    }
    
    console.log('\n📋 Full Response:');
    console.log(JSON.stringify(response.data, null, 2));
    
  } catch (error) {
    console.error('❌ API Error:');
    console.error('   Status:', error.response?.status);
    console.error('   Message:', error.message);
    if (error.response?.data) {
      console.error('   Response Data:', error.response.data);
    }
  }
}

testRailwayAPI();
