const { processPaymentWithAutoExtend } = require('./payment-utils');

const cases = [
  {
    name: 'active interest paid on due date',
    loan: {
      id: 1,
      loan_amount: 1000,
      interest_rate: 10,
      interest_amount: 100,
      remaining_balance: 1100,
      due_date: '2026-07-17',
      status: 'active',
      interest_paid_this_cycle: 0,
      extended_this_cycle: false,
    },
    payment: 100,
    date: '2026-07-17',
  },
  {
    name: 'active partial payment before due date',
    loan: {
      id: 2,
      loan_amount: 1000,
      interest_rate: 10,
      interest_amount: 100,
      remaining_balance: 1100,
      due_date: '2026-07-20',
      status: 'active',
      interest_paid_this_cycle: 0,
      extended_this_cycle: false,
    },
    payment: 50,
    date: '2026-07-17',
  },
  {
    name: 'already extended this cycle',
    loan: {
      id: 3,
      loan_amount: 1000,
      interest_rate: 10,
      interest_amount: 100,
      remaining_balance: 1100,
      due_date: '2026-07-20',
      status: 'active',
      interest_paid_this_cycle: 100,
      extended_this_cycle: true,
    },
    payment: 50,
    date: '2026-07-17',
  },
  {
    name: 'after due date payment',
    loan: {
      id: 4,
      loan_amount: 1000,
      interest_rate: 10,
      interest_amount: 100,
      remaining_balance: 1100,
      due_date: '2026-07-15',
      status: 'active',
      interest_paid_this_cycle: 0,
      extended_this_cycle: false,
    },
    payment: 100,
    date: '2026-07-17',
  },
];

cases.forEach((c) => {
  const result = processPaymentWithAutoExtend(c.loan, c.payment, new Date(c.date));
  console.log('CASE:', c.name);
  console.log(JSON.stringify(result, null, 2));
  console.log('---');
});
