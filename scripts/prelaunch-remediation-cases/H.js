'use strict';
require('../lib/payment-test-network');
const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const { createHarness } = require('../lib/prelaunch-remediation-fixture');
const cases = [];
const test = (id, issue, run, contractOnly = false) => cases.push({ id, issue, run, contractOnly });
function harness(options = {}) {
  const h = createHarness(options);
  const original = h.db.runTransaction;
  h.txCounts = [];
  h.db.runTransaction = fn => original(async t => {
    let count = 0;
    const wrap = query => new Proxy(query, { get(target, key) {
      const value = target[key];
      if (typeof value !== 'function') return value;
      if (['get', 'count', 'add', 'update', 'set', 'remove'].includes(key)) return (...args) => {
        count++; if (count > 100) throw new Error('Synthetic transaction exceeds conservative 100 operations');
        return value(...args);
      };
      return (...args) => wrap(value(...args));
    } });
    try { return await fn({ ...t, collection: name => wrap(t.collection(name)) }); }
    finally { h.txCounts.push(count); }
  });
  return h;
}
const info = h => h.call('withdrawal', { action: 'info' }, 'test-agent');
function rows(h, count, tail = 30) {
  h.tables().commissions = Array.from({ length: count }, (_, i) => ({ _id: 'c' + String(i).padStart(5, '0'),
    agentId: 'test-agent', orderId: 'order', orderNo: 'TEST-ORDER', type: 'earning', amount: 30,
    status: 'settled', settleTime: new Date(i) }));
  h.tables().commissions[count - 1].amount = tail;
}
function refundSeed(h, count = 101) {
  rows(h, count);
  Object.assign(h.tables().orders[0], { status: 'refunding', refundId: 'rf', inventoryStatus: 'committed',
    paymentSubMchId: 'test-merchant', items: [{ productId: 'p', spec: 'old', quantity: 1 }] });
  h.tables().products = [{ _id: 'p', stock: 2, sales: 1, specs: [{ name: 'old', stock: 2 }] }];
  h.tables().refunds = [{ _id: 'rf', orderId: 'order', status: 'pending_auto', type: 'refund_only', restock: true,
    executionVersion: 2, approvedAmount: 1500, outRefundNo: 'RF-ORIGINAL', subMchId: 'test-merchant', processTime: new Date(0) }];
  h.refundQuery = { returnCode: 'SUCCESS', resultCode: 'SUCCESS', outTradeNo: 'TEST-ORDER', refundCount: 1,
    outRefundNo0: 'RF-ORIGINAL', refundFee0: 1500, refundStatus0: 'SUCCESS', refundId0: 'WX-ORIGINAL' };
}
const reversed = h => h.tables().commissions.filter(c => c.type === 'reversal').reduce((n, c) => n + c.amount, 0);
for (const count of [99, 100, 101, 999, 1000, 1001]) {
  test('H-balance-tail-negative-' + count, 'R3-001', async () => {
    const h = harness(); rows(h, count, -30 * (count - 1));
    const result = await info(h); assert.equal(result.success, true); assert.equal(result.available, 0);
    assert.equal((await h.apply()).success, false); assert.equal(h.tables().withdrawals.length, 0);
    const dash = await h.call('agent', { action: 'dashboard' }, 'test-agent'); assert.equal(dash.available, 0);
  });
  test('H-approval-tail-negative-' + count, 'R3-001', async () => {
    const h = harness(); rows(h, count, -30 * (count - 1));
    h.tables().withdrawals.push({ _id: 'w', agentId: 'test-agent', amount: 30, status: 'pending' });
    assert.equal((await h.approve('w')).success, false); assert.equal(h.transferCalls.length, 0);
    assert.equal(h.tables().commissions.some(c => c.status === 'withdrawing'), false);
  });
}
for (const value of ['bad', '30', 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
  test('H-invalid-ledger-' + String(value), 'R3-001', async () => {
    const h = harness(); h.tables().commissions.push({ _id: 'tail', agentId: 'test-agent', status: 'settled', amount: value });
    let result; try { result = await info(h); } catch (error) { result = { success: false }; }
    assert.equal(result.success, false); assert.equal((await h.apply()).success, false);
    h.tables().withdrawals.push({ _id: 'w', agentId: 'test-agent', amount: 30, status: 'pending' });
    assert.equal((await h.approve('w')).success, false); assert.equal(h.transferCalls.length, 0);
  });
}
test('H-overflow-ledger-rejects', 'R3-001', async () => {
  const h = harness(); h.tables().commissions[0].amount = Number.MAX_SAFE_INTEGER;
  h.tables().commissions.push({ ...h.tables().commissions[0], _id: 'overflow' });
  assert.equal((await h.apply()).success, false); assert.equal(h.tables().withdrawals.length, 0);
});
test('H-middle-page-read-failure-rolls-back', 'R3-001', async () => {
  const h = harness(); rows(h, 1001); let reads = 0;
  h.afterRead = (name, filter) => { if (name === 'commissions' && ++reads === 2) throw new Error('synthetic page failure'); };
  assert.equal((await h.apply()).success, false); assert.equal(h.tables().withdrawals.length, 0);
});
test('H-safe-capacity-rejects-without-channel', 'R3-001', async () => {
  const h = harness(); rows(h, 6000);
  assert.equal((await h.apply()).success, false); assert.equal(h.tables().withdrawals.length, 0);
});
test('H-reservations-approval-and-apply-same-net', 'R3-001', async () => {
  const h = harness(); const first = await h.apply(); assert.equal(first.success, true);
  h.tables().commissions.push({ _id: 'debt', agentId: 'test-agent', orderId: 'other', type: 'reversal', status: 'settled', amount: -350 });
  h.tables().withdrawals.push({ _id: 'other', agentId: 'test-agent', amount: 100, status: 'pending' });
  assert.equal((await info(h)).available, 0);
  assert.equal((await h.approve(first.withdrawalId)).success, false); assert.equal(h.transferCalls.length, 0);
});
test('H-normal-holds-not-double-subtracted-and-paid-once', 'R3-001', async () => {
  const h = harness(); const r = await h.apply(); assert.equal((await info(h)).available, 400);
  assert.equal((await h.approve(r.withdrawalId)).success, true); assert.equal((await info(h)).available, 400);
  const second = await h.call('withdrawal', { action: 'apply', amount: 400, name: 'Test', account: 'test', requestId: 'second-request-0001' }, 'test-agent');
  assert.equal(second.success, true); assert.equal((await info(h)).available, 0);
  h.bill = { state: 'SUCCESS' }; await h.call('admin', { action: 'queryWithdrawalTransfer', withdrawalId: r.withdrawalId });
  assert.equal((await info(h)).available, 0); assert.equal(h.tables().cashflow_entries.length, 1);
  assert.ok(h.txCounts.every(n => n <= 100));
});
test('H-concurrent-applications-shared-version', 'R3-001', async () => {
  const h = harness(); const apply = id => h.call('withdrawal', { action: 'apply', amount: 400, name: 'Test', account: 'test', requestId: id }, 'test-agent');
  const r = await Promise.all([apply('concurrent-00001'), apply('concurrent-00002')]);
  assert.equal(r.filter(x => x.success).length, 1); assert.equal(h.tables().users[0].withdrawalVersion, 1);
});
for (const count of [99, 100, 101, 1001]) for (const module of ['admin', 'refund-processor']) {
  test('H-refund-' + module + '-all-fragments-' + count, 'R3-002', async () => {
    const h = harness(); refundSeed(h, count);
    const result = module === 'admin' ? await h.call('admin', { action: 'executeRefund', refundId: 'rf' }) : await h.call('refund-processor', { action: 'sweep' });
    assert.equal(h.tables().orders[0].status, 'refunded', JSON.stringify(result)); assert.equal(reversed(h), -count * 30);
    assert.equal(h.tables().cashflow_entries.length, 1); assert.equal(h.tables().products[0].stock, 3); assert.equal(h.refundCalls, 0);
    await h.call('admin', { action: 'executeRefund', refundId: 'rf' }); await h.call('refund-processor', { action: 'sweep' });
    assert.equal(reversed(h), -count * 30); assert.equal(h.tables().cashflow_entries.length, 1); assert.equal(h.tables().products[0].stock, 3);
    assert.ok(h.txCounts.every(n => n <= 100)); assert.ok(h.tables().users[0].withdrawalVersion >= 1);
  });
}
test('H-subset-reversals-top-up-once', 'R3-002', async () => {
  const h = harness(); refundSeed(h);
  h.tables().commissions.push({ _id: 'previous', orderId: 'order', agentId: 'test-agent', type: 'reversal', amount: -30,
    status: 'settled', idempotencyKey: 'commission_refund:rf:c00000', sourceCommissionId: 'c00000' });
  assert.equal((await h.call('admin', { action: 'executeRefund', refundId: 'rf' })).completed, true);
  assert.equal(reversed(h), -3030); assert.equal(h.tables().cashflow_entries.length, 1);
});
test('H-refund-failure-and-stock-recovery-do-not-duplicate', 'R3-002', async () => {
  const h = harness(); refundSeed(h); h.failWrite = 'commissions';
  assert.equal((await h.call('admin', { action: 'executeRefund', refundId: 'rf' })).completed, false);
  assert.equal(reversed(h), 0); assert.equal(h.tables().cashflow_entries.length, 0); assert.equal(h.tables().orders[0].status, 'refunding');
  h.failWrite = ''; h.tables().products[0].specs[0].name = 'renamed';
  assert.equal((await h.call('admin', { action: 'executeRefund', refundId: 'rf' })).completed, true);
  assert.equal(reversed(h), -3030); assert.equal(h.tables().refunds[0].inventoryRestockStatus, 'pending_exception');
  const queries = h.refundQueries; h.tables().products[0].specs[0].name = 'old';
  assert.equal((await h.call('admin', { action: 'retryRefund', refundId: 'rf' })).success, true);
  assert.equal(reversed(h), -3030); assert.equal(h.tables().cashflow_entries.length, 1); assert.equal(h.tables().products[0].stock, 3);
  assert.equal(h.refundQueries, queries); assert.equal(h.refundCalls, 0);
});
test('H-refund-middle-page-failure-and-malformed-tail', 'R3-002', async () => {
  for (const mode of ['read', 'money']) {
    const h = harness(); refundSeed(h, 101); let reads = 0;
    if (mode === 'money') h.tables().commissions[100].amount = 'bad';
    else h.afterRead = name => { if (name === 'commissions' && ++reads === 2) throw new Error('synthetic tail read failure'); };
    assert.equal((await h.call('admin', { action: 'executeRefund', refundId: 'rf' })).completed, false);
    assert.equal(reversed(h), 0); assert.equal(h.tables().cashflow_entries.length, 0); assert.equal(h.tables().products[0].stock, 2);
  }
});
test('H-refund-and-approval-share-agent-fence', 'R3-002', async () => {
  const h = harness(); refundSeed(h); const before = h.tables().users[0].withdrawalVersion || 0;
  assert.equal((await h.call('admin', { action: 'executeRefund', refundId: 'rf' })).completed, true);
  assert.equal(h.tables().users[0].withdrawalVersion, before + 1);
  h.tables().withdrawals.push({ _id: 'w', agentId: 'test-agent', amount: 30, status: 'pending' });
  assert.equal((await h.approve('w')).success, false); assert.equal(h.transferCalls.length, 0);
});
test('H-actual-101-withdrawal-splits-reverse-3030', 'R3-002', async () => {
  const h = harness(); h.tables().commissions[0].amount = 3030; h.transfer.state = 'SUCCESS';
  for (let i = 0; i < 101; i++) {
    const r = await h.call('withdrawal', { action: 'apply', amount: 30, name: 'Test', account: 'test', requestId: 'actual-split-' + String(i).padStart(5, '0') }, 'test-agent');
    assert.equal(r.success, true); assert.equal((await h.approve(r.withdrawalId)).state, 'SUCCESS');
  }
  const fragments = structuredClone(h.tables().commissions);
  assert.equal(fragments.length, 101); assert.equal(fragments.reduce((sum, c) => sum + c.amount, 0), 3030);
  assert.ok(fragments.every(c => c.status === 'paid' && c.amount === 30));
  refundSeed(h); h.tables().commissions = structuredClone(fragments); const payouts = h.tables().cashflow_entries.length;
  assert.equal((await h.call('admin', { action: 'executeRefund', refundId: 'rf' })).completed, true);
  assert.equal(reversed(h), -3030); assert.equal(h.tables().cashflow_entries.length, payouts + 1);
  const aggregate = h.tables().commissions.find(c => c.type === 'reversal');
  assert.equal(aggregate.sourceCommissionIds.length, 101); assert.equal(aggregate.sourceCommissionDigest.length, 64);
  assert.deepEqual(h.tables().commissions.filter(c => c.type !== 'reversal'), fragments);
  await h.call('refund-processor', { action: 'sweep' }); assert.equal(reversed(h), -3030);
  assert.equal(h.transferCalls.length, 101); assert.equal(h.refundCalls, 0); assert.ok(h.txCounts.every(n => n <= 100));
});
test('H-refunded-hold-can-query-original-but-not-replace', 'R3-001', async () => {
  const h = harness(); h.transfer = new Error('synthetic timeout'); const r = await h.apply();
  assert.equal((await h.approve(r.withdrawalId)).pendingPay, true); const original = h.tables().withdrawals[0].outBatchNo;
  h.tables().commissions.push({ _id: 'debt', agentId: 'test-agent', orderId: 'order', type: 'reversal', amount: -500, status: 'settled' });
  h.bill = { state: 'CANCELLED' }; await h.approve(r.withdrawalId);
  assert.equal(h.tables().withdrawals[0].outBatchNo, original); assert.equal(h.transferCalls.length, 1);
  h.bill = { state: 'SUCCESS' }; assert.equal((await h.approve(r.withdrawalId)).state, 'SUCCESS');
  assert.equal(h.tables().cashflow_entries.length, 1); assert.equal(h.transferCalls.length, 1);
});
test('H-large-frozen-refund-rejects-before-effects', 'R3-002', async () => {
  const h = harness(); refundSeed(h); h.tables().commissions.forEach(c => { c.status = 'frozen'; });
  assert.equal((await h.call('admin', { action: 'executeRefund', refundId: 'rf' })).completed, false);
  assert.equal(h.tables().cashflow_entries.length, 0); assert.equal(h.tables().orders[0].status, 'refunding');
  assert.ok(h.tables().commissions.every(c => c.status === 'frozen')); assert.ok(h.txCounts.every(n => n <= 100));
});
// Actual production D client, with in-memory keys and a synthetic HTTPS byte stream.
const merchant = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const platform = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const wrong = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
function actualClient(mode) {
  const observed = [];
  const filename = path.resolve(__dirname, '../../cloudfunctions/admin/wxpay-transfer.js');
  const serial = 'PUB_KEY_ID_3000000001';
  const adapter = { request(options, callback) {
    observed.push(options); const req = new EventEmitter(); let sent = '';
    req.write = data => { sent += data; }; req.destroy = error => req.emit('error', error);
    req.end = () => queueMicrotask(() => {
      const billNo = options.method === 'POST' ? JSON.parse(sent).out_bill_no : decodeURIComponent(options.path.split('/').pop());
      const body = JSON.stringify({ state: 'SUCCESS', out_bill_no: billNo });
      const timestamp = String(Math.floor(Date.now() / 1000) - (mode === 'stale' ? 601 : 0)); const nonce = 'synthetic-nonce';
      const signature = crypto.sign('RSA-SHA256', Buffer.from(timestamp + '\n' + nonce + '\n' + (mode === 'tampered' ? '{}' : body) + '\n'), mode === 'bad' ? wrong.privateKey : platform.privateKey).toString('base64');
      const res = new EventEmitter(); res.statusCode = 200; res.headers = { 'wechatpay-timestamp': timestamp, 'wechatpay-nonce': nonce,
        'wechatpay-serial': mode === 'serial' ? 'PUB_KEY_ID_UNKNOWN' : serial, 'wechatpay-signature': mode === 'missing' ? undefined : signature };
      res.setEncoding = () => {}; res.on('error', () => {}); callback(res); res.emit('data', Buffer.from(body)); res.emit('end');
    }); return req;
  } };
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module: mod, exports: mod.exports, __dirname: path.dirname(filename), Buffer, URL, Date,
    console: { log() {}, error() {}, warn() {} }, process: { env: { ALLOW_MOCK_PAY: 'false', WECHATPAY_PLATFORM_PUBLIC_KEY_ID: serial,
      WECHATPAY_PLATFORM_PUBLIC_KEY_PATH: '/synthetic/platform.pem', WECHATPAY_PLATFORM_PUBLIC_KEY_EXPIRES_AT: new Date(Date.now() + 86400000).toISOString() } },
    require: name => name === 'https' ? adapter : name === 'fs' ? { readFileSync(file) {
      if (path.basename(file) === 'apiclient_key.pem') return merchant.privateKey.export({ type: 'pkcs8', format: 'pem' });
      if (file === '/synthetic/platform.pem') return platform.publicKey.export({ type: 'spki', format: 'pem' });
      throw new Error('Synthetic key boundary');
    } } : require(name) }, { filename });
  return { client: mod.exports, observed };
}
for (const mode of ['valid', 'missing', 'bad', 'stale', 'serial', 'tampered']) {
  test('H-actual-D-client-withdrawal-' + mode, 'R3-003', async () => {
    const synthetic = actualClient(mode); const h = harness({ transferClient: synthetic.client }); const r = await h.apply(); assert.equal(r.success, true);
    const result = await h.approve(r.withdrawalId); const original = h.tables().withdrawals[0].outBatchNo;
    assert.ok(original); assert.equal(h.transferCalls.length, 0); assert.equal(synthetic.observed.filter(x => x.method === 'POST').length, 1);
    assert.ok(synthetic.observed.every(x => x.rejectUnauthorized !== false));
    if (mode === 'valid') {
      assert.equal(result.state, 'SUCCESS'); assert.equal(h.tables().cashflow_entries.length, 1); assert.equal(h.tables().withdrawals[0].status, 'success');
      await h.approve(r.withdrawalId); await h.call('admin', { action: 'queryWithdrawalTransfer', withdrawalId: r.withdrawalId });
      assert.equal(h.tables().cashflow_entries.length, 1); assert.equal(synthetic.observed.filter(x => x.method === 'POST').length, 1);
    } else {
      assert.equal(result.pendingPay, true); assert.equal(h.tables().cashflow_entries.length, 0);
      assert.ok(h.tables().withdrawals[0].lastPayError.includes('WECHATPAY_RESPONSE_UNTRUSTED'));
      await h.approve(r.withdrawalId); const queried = await h.call('admin', { action: 'queryWithdrawalTransfer', withdrawalId: r.withdrawalId });
      assert.equal(queried.success, false); assert.equal(h.tables().cashflow_entries.length, 0);
      assert.equal(h.tables().withdrawals[0].outBatchNo, original); assert.equal(synthetic.observed.filter(x => x.method === 'POST').length, 1);
      assert.equal(h.tables().commissions.some(c => c.status === 'paid'), false);
    }
  }, true);
}
// Round 2: prior reversal provenance and caller-inclusive transaction budget.
for (const kind of ['unknown-source-with-status', 'known-source-overreversed']) {
  test('H-prior-individual-' + kind, 'R3-002', async () => {
    const h = harness(); refundSeed(h, 3);
    h.tables().commissions.push({ _id: 'old-reversal', orderId: 'order', agentId: 'test-agent', type: 'reversal', status: 'settled',
      amount: kind === 'known-source-overreversed' ? -31 : -30, idempotencyKey: 'commission_refund:rf:c00000',
      sourceCommissionId: kind === 'known-source-overreversed' ? 'c00000' : 'missing-source', sourceStatus: 'settled' });
    const before = structuredClone(h.tables().commissions);
    assert.equal((await h.call('admin', { action: 'executeRefund', refundId: 'rf' })).completed, false);
    assert.deepEqual(h.tables().commissions, before); assert.equal(h.tables().cashflow_entries.length, 0);
    assert.equal(h.tables().orders[0].status, 'refunding'); assert.equal(h.tables().products[0].stock, 2);
  });
}
test('H-mock-24-products-caller-cost-budget', 'R3-002', async () => {
  const h = harness(); refundSeed(h, 1);
  Object.assign(h.tables().orders[0], { paymentSource: 'mockPay', transactionId: 'MOCK_TXN_BUDGET',
    items: Array.from({ length: 24 }, (_, i) => ({ productId: 'p' + i, spec: '', quantity: 1 })) });
  h.tables().products = Array.from({ length: 24 }, (_, i) => ({ _id: 'p' + i, stock: 1, sales: 1, specs: [] }));
  h.tables().refunds[0].status = 'pending';
  const r = await h.call('admin', { action: 'processRefund', refundId: 'rf', approve: true });
  assert.ok(h.txCounts.every(n => n <= 100), 'Must reject in preflight rather than attempt operation101: ' + JSON.stringify(h.txCounts));
  assert.equal(r.success, false); assert.equal(h.tables().cashflow_entries.length, 0); assert.equal(reversed(h), 0);
  assert.ok(h.tables().products.every(p => p.stock === 1)); assert.equal(h.tables().refunds[0].status, 'pending');
});
function priorAggregate(h, withSubset = false) {
  const sourceRows = structuredClone(h.tables().commissions);
  if (withSubset) h.tables().commissions.push({ _id: 'old-subset', orderId: 'order', agentId: 'test-agent',
    type: 'reversal', status: 'settled', amount: -30, idempotencyKey: 'commission_refund:rf:c00000', sourceCommissionId: 'c00000' });
  const aggregate = { _id: 'old-aggregate', orderId: 'order', agentId: 'test-agent', type: 'reversal', status: 'settled',
    amount: withSubset ? -60 : -90, refundId: 'rf', source: 'refund', sourceStatus: 'settled', reversalVersion: 2,
    idempotencyKey: 'commission_refund:rf:aggregate:settled', sourceAmountTotal: 90, priorReversedAmount: withSubset ? 30 : 0,
    sourceCommissionCount: 3, sourceCommissionIds: sourceRows.map(c => c._id),
    sourceCommissionDigest: crypto.createHash('sha256').update(JSON.stringify(sourceRows.map(c => [c._id, c.amount]))).digest('hex') };
  h.tables().commissions.push(aggregate); return aggregate;
}
for (const subset of [false, true]) test('H-valid-prior-aggregate-with-subset-' + subset, 'R3-002', async () => {
  const h = harness(); refundSeed(h, 3); priorAggregate(h, subset); const before = structuredClone(h.tables().commissions);
  assert.equal((await h.call('admin', { action: 'executeRefund', refundId: 'rf' })).completed, true);
  assert.equal(reversed(h), -90); assert.deepEqual(h.tables().commissions, before); assert.equal(h.tables().cashflow_entries.length, 1);
  await h.call('admin', { action: 'executeRefund', refundId: 'rf' });
  assert.equal(reversed(h), -90); assert.equal(h.tables().cashflow_entries.length, 1); assert.equal(h.refundCalls, 0);
});
for (const kind of ['digest', 'missing-id', 'amount', 'unproven-prior']) test('H-invalid-prior-aggregate-' + kind, 'R3-002', async () => {
  const h = harness(); refundSeed(h, 3); const aggregate = priorAggregate(h);
  if (kind === 'digest') aggregate.sourceCommissionDigest = '0'.repeat(64);
  if (kind === 'missing-id') aggregate.sourceCommissionIds.pop();
  if (kind === 'amount') aggregate.amount = -89;
  if (kind === 'unproven-prior') { aggregate.priorReversedAmount = 30; aggregate.amount = -60; }
  const before = structuredClone(h.tables().commissions);
  assert.equal((await h.call('admin', { action: 'executeRefund', refundId: 'rf' })).completed, false);
  assert.deepEqual(h.tables().commissions, before); assert.equal(h.tables().cashflow_entries.length, 0);
  assert.equal(h.tables().orders[0].status, 'refunding'); assert.equal(h.tables().products[0].stock, 2);
});
module.exports = cases;
