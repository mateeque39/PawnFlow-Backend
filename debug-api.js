/**
 * Debug script to test the API response for customer 6 loans
 * Run this in the browser console to see what data is being returned
 */

async function testCustomerLoansAPI() {
  try {
    console.log('🔍 Testing /customers/6/loans endpoint...\n');
    
    const response = await fetch('/customers/6/loans', {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      console.error('❌ API Error:', response.status, response.statusText);
      return;
    }

    const data = await response.json();
    
    console.log('✅ API Response received:\n');
    console.log('📊 Loan Counts:');
    console.log(`  - activeLoans: ${data.activeLoans?.length || 0}`);
    console.log(`  - overdueLoans: ${data.overdueLoans?.length || 0}`);
    console.log(`  - redeemedLoans: ${data.redeemedLoans?.length || 0}`);
    console.log(`  - forfeitedLoans: ${data.forfeitedLoans?.length || 0}`);
    
    console.log('\n📋 Full Response:');
    console.log(JSON.stringify(data, null, 2));
    
    if (data.overdueLoans && data.overdueLoans.length > 0) {
      console.log('\n✅ OVERDUE LOANS FOUND:');
      data.overdueLoans.forEach(loan => {
        console.log(`  - Loan ${loan.id}: $${loan.loan_amount} | Status: ${loan.status}`);
      });
    } else {
      console.log('\n⚠️ NO OVERDUE LOANS IN RESPONSE');
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

// Run the test
testCustomerLoansAPI();
