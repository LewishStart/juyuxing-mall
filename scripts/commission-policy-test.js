#!/usr/bin/env node
'use strict';
const assert = require('assert');
const { createHarness } = require('./lib/prelaunch-remediation-fixture');

(async () => {
  const policies = [
    { expected: 0.33, label: 'new default is 33%' },
    { admin: 0.15, expected: 0.15, label: 'explicit admin setting is honored' },
    { admin: 0.15, payment: 0.2, expected: 0.2, label: 'legacy payment setting precedence is explicit' },
    { admin: 0.15, payment: 0, expected: 0, label: 'zero commission is valid' }
  ];
  for (const policy of policies) {
    const h = createHarness({ env: { ALLOW_MOCK_PAY: 'true' } });
    h.tables().orders = [];
    h.tables().commissions = [];
    h.tables().users.push({ _id: 'test-buyer', referrer: 'test-agent' });
    h.tables().products.push({ _id: 'policy-product', name: 'Synthetic policy product',
      status: 'on', price: 1000, stock: 2, reservedStock: 0, specs: [], images: [] });
    if (policy.admin !== undefined) h.tables().admin_config[0].commissionRate = policy.admin;
    if (policy.payment !== undefined) h.tables().pay_config[0].commissionRate = policy.payment;
    h.tables().pay_config[0].useMockPay = true;
    const created = await h.call('order', { action: 'create', orderNo: 'JY20261018010203POLICY',
      items: [{ productId: 'policy-product', spec: '', quantity: 1 }],
      address: { name: 'Synthetic buyer', phone: '13800000000', detail: 'Synthetic road' } }, 'test-buyer');
    assert.equal(created.success, true);
    const order = h.tables().orders.find(row => row._id === created.orderId);
    assert.equal(order.commissionRate, policy.expected, policy.label);
    assert.equal(order.commission, Math.round(1000 * policy.expected), policy.label);
    // Payment must use the order snapshot even if the operator changes future rates.
    h.tables().pay_config[0].commissionRate = 0.99;
    h.tables().admin_config[0].commissionRate = 0.99;
    const paid = await h.call('pay', { action: 'request', orderId: created.orderId }, 'test-buyer');
    assert.equal(paid.success, true);
    assert.equal(order.status, 'paid');
    assert.equal(order.commissionRate, policy.expected, policy.label);
    const commissions = h.tables().commissions.filter(row => row.orderId === order._id);
    assert.equal(commissions.reduce((sum, row) => sum + row.amount, 0), Math.round(1000 * policy.expected));
    assert.equal(commissions.length, policy.expected === 0 ? 0 : 1);
    console.log('PASS commission policy order -> pay:', policy.label);
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
