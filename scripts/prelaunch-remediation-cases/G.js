'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createHarness } = require('../lib/prelaunch-remediation-fixture');
const cases = [];
const test = (id, issue, run) => cases.push({ id, issue, run });
function setup() {
  const h = createHarness();
  h.tables().orders = []; h.tables().commissions = []; h.tables().messages = [];
  return h;
}
function web(h) {
  let definition;
  const calls = [], storage = {};
  const w = { calls, storage, openId: 'test-owner', transportFailure: false, override: null };
  vm.runInNewContext(fs.readFileSync(path.join(h.root, 'admin-web/app.js'), 'utf8'), {
    Vue: { createApp: value => { definition = value; return { mount() {} }; },
      ref: value => ({ value }), reactive: value => value,
      computed: fn => ({ get value() { return fn(); } }), onMounted() {}, onBeforeUnmount() {},
      nextTick: fn => { if (fn) fn(); return Promise.resolve(); }, watch() {} },
    window: { cloudbase: { init: () => ({ auth: () => ({}), callFunction: async req => {
      calls.push(structuredClone(req.data));
      if (w.transportFailure) throw new Error('Synthetic transport unavailable');
      if (w.override) return w.override(req);
      return { result: await h.call(req.name, req.data, w.openId) };
    } }) } },
    localStorage: { getItem: k => storage[k] || null, setItem: (k, v) => { storage[k] = v; },
      removeItem: k => { delete storage[k]; } }, document: {}, navigator: {},
    Date, Math, console: { log() {}, error() {}, warn() {} }, setTimeout: () => 1,
    clearTimeout() {}, setInterval: () => 1, clearInterval() {}, confirm: () => false
  }, { filename: 'admin-web/app.js' });
  w.app = definition.setup();
  return w;
}
function chatPage(h, openId = 'test-buyer') {
  let definition; const cache = new Map();
  const wx = { getStorageSync: () => openId, showToast() {},
    cloud: { callFunction: async req => ({ result: await h.call(req.name, req.data, openId) }) } };
  function load(relative) {
    const filename = path.resolve(h.root, relative);
    if (cache.has(filename)) return cache.get(filename).exports;
    const mod = { exports: {} }; cache.set(filename, mod);
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module: mod, exports: mod.exports, wx,
      require: name => load(path.relative(h.root, path.resolve(path.dirname(filename), name + '.js'))),
      Page: value => { definition = value; }, console, Date, setTimeout: () => 1,
      clearTimeout() {}, setInterval: () => 1, clearInterval() {} }, { filename });
    return mod.exports;
  }
  load('miniprogram/pages/chat/chat.js');
  const page = { ...definition, data: structuredClone(definition.data) };
  page.setData = update => Object.assign(page.data, update);
  return page;
}
function displayedAddress(h, app) {
  const html = fs.readFileSync(path.join(h.root, 'admin-web/index.html'), 'utf8');
  const line = html.split('\n').find(line => line.includes('{{ orderDetailModal.data.address.province') ||
    line.includes('{{ formatOrderAddress('));
  assert.ok(line, 'Order detail must contain a bound address expression');
  return [...line.matchAll(/{{\s*(.*?)\s*}}/g)].map(match => vm.runInNewContext(match[1], app)).join('');
}
function financeRows(h, count = 1) {
  h.tables().cashflow_entries = Array.from({ length: count }, (_, i) => ({ _id: 'cash-' + i,
    type: 'sale_receipt', direction: 'in', amount: 100, status: 'posted', createTime: new Date() }));
}
const createOrder = h => h.call('order', { action: 'create', orderNo: 'JY20261018010203GGGGGG',
  items: [{ productId: 'p', quantity: 1, spec: '' }], address: { name: 'Buyer', phone: '13800000000',
    region: ['Province', 'City', 'District'], detail: 'Road 1' } }, 'test-buyer');

test('G-address-current-order-through-Web-view-and-template', 'R2-002', async () => {
  const h = setup(); h.tables().products = [{ _id: 'p', name: 'Product', price: 10000, stock: 10,
    reservedStock: 0, status: 'on', specs: [], images: [] }];
  const created = await createOrder(h); assert.equal(created.success, true);
  const w = web(h); await w.app.loadOrders();
  const order = w.app.orders.value.find(o => o._id === created.orderId);
  const original = JSON.stringify(order.address);
  w.app.viewOrder(order);
  assert.equal(displayedAddress(h, w.app), 'ProvinceCityDistrictRoad 1');
  assert.equal(JSON.stringify(order.address), original, 'Display must not mutate stored address');
});
test('G-address-legacy-and-missing-controls', 'R2-002', async () => {
  const h = setup(), w = web(h);
  const order = { address: { name: 'Old Buyer', province: 'OldP', city: 'OldC', district: 'OldD', detail: 'OldRoad' } };
  w.app.viewOrder(order);
  assert.equal(displayedAddress(h, w.app), 'OldPOldCOldDOldRoad');
  if (w.app.formatOrderAddress) {
    assert.equal(w.app.formatOrderAddress(null), '');
    assert.equal(w.app.formatOrderAddress({ region: [], province: 'Fallback', detail: 'Road' }), 'FallbackRoad');
  }
});
test('G-Web-reply-consumer-read-unread-readback', 'R4-S04', async () => {
  const h = setup();
  assert.equal((await h.call('chat', { action: 'sendMessage', content: 'Question' }, 'test-buyer')).success, true);
  const w = web(h); await w.app.loadMessageUsers();
  const user = w.app.messageUsers.value.find(u => u.userOpenId === 'test-buyer'); assert.ok(user);
  await w.app.selectChatUser(user);
  w.app.replyText.value = 'Actual Web answer'; await w.app.sendReply();
  assert.ok(w.calls.some(c => c.action === 'adminReply' && c.content === 'Actual Web answer'));
  const unread = await h.call('chat', { action: 'getUnreadCount' }, 'test-buyer');
  assert.equal(unread.count, 1, 'Web reply must use real consumer unread contract');
  const seen = await h.call('chat', { action: 'getMessages' }, 'test-buyer');
  assert.equal(seen.data.filter(m => m.content === 'Actual Web answer').length, 1);
  const reply = seen.data.find(m => m.isAdmin);
  assert.equal(reply.conversationId, 'test-buyer'); assert.equal(reply.toId, 'test-buyer');
  assert.equal(reply.isRead, false);
  await h.call('chat', { action: 'markAsRead' }, 'test-buyer');
  assert.equal((await h.call('chat', { action: 'getUnreadCount' }, 'test-buyer')).count, 0);
  const history = await h.call('admin', { action: 'messageHistory', userOpenId: 'test-buyer' });
  assert.equal(history.data.filter(m => m.content === 'Actual Web answer').length, 1);
  assert.equal(history.data.find(m => m.isAdmin).isRead, true);
});
test('G-mini-operator-Web-history-and-incoming-read-state', 'R4-S04', async () => {
  const h = setup();
  await h.call('chat', { action: 'sendMessage', content: 'Question' }, 'test-buyer');
  await h.call('chat', { action: 'sendMessage', content: 'Mini answer', toId: 'test-buyer' }, 'test-owner');
  const w = web(h); await w.app.selectChatUser({ userOpenId: 'test-buyer', nickName: 'Buyer' });
  assert.ok(w.app.chatMessages.value.some(m => m.content === 'Mini answer'));
  assert.equal(h.tables().messages.find(m => m.content === 'Question').isRead, true);
  await w.app.loadMessageUsers();
  assert.equal(w.app.messageUsers.value.find(u => u.userOpenId === 'test-buyer').unread, 0);
});
test('G-Web-reply-failure-preserves-unsent-input', 'R4-S04', async () => {
  const h = setup(), w = web(h); w.app.currentChatUser.value = 'test-buyer';
  w.app.replyText.value = 'Unsent'; h.failWrite = 'messages'; await w.app.sendReply();
  assert.equal(w.app.replyText.value, 'Unsent'); assert.equal(w.app.chatMessages.value.length, 0);
  assert.equal(h.tables().messages.length, 0); assert.equal(w.app.toast.type, 'error');
});
test('G-chat-role-and-conversation-boundaries', 'R4-S04', async () => {
  for (const role of ['owner', 'operations', 'finance']) {
    const h = setup(); h.tables().admin_accounts[0].role = role;
    const reply = await h.call('admin', { action: 'adminReply', userOpenId: 'test-buyer', content: 'Reply' });
    assert.equal(reply.success, role !== 'finance');
  }
  const h = setup(); h.tables().admin_accounts[0].status = 'disabled';
  assert.equal((await h.call('admin', { action: 'adminReply', userOpenId: 'test-buyer', content: 'Reply' })).success, false);
  for (const action of ['getMessages', 'markAsRead']) {
    assert.equal((await h.call('chat', { action, conversationId: 'test-buyer' }, 'test-other')).success, false);
    assert.equal((await h.call('chat', { action, conversationId: 'test-buyer' }, '')).success, false);
  }
});
test('G-legacy-Web-history-remains-admin-only', 'R4-S04', async () => {
  const h = setup(); h.tables().messages = [{ _id: 'old', fromId: 'admin', targetId: 'test-buyer',
    isAdmin: true, read: false, content: 'Legacy reply', createTime: new Date() }];
  const history = await h.call('admin', { action: 'messageHistory', userOpenId: 'test-buyer' });
  assert.equal(history.data.length, 1);
  const own = await h.call('chat', { action: 'getMessages' }, 'test-other'); assert.equal(own.data.length, 0);
  assert.equal(h.tables().messages[0].conversationId, undefined, 'No historical migration');
});
for (const collection of ['cashflow_entries', 'commissions']) {
  test('G-finance-read-failure-' + collection, 'R4-S07', async () => {
    const h = setup(); financeRows(h); h.failRead = collection;
    const result = await h.call('admin', { action: 'financeOverview' });
    assert.equal(result.success, false, 'Read failure must not produce success-zero report');
    assert.ok(result.error); assert.equal(result.data, undefined);
  });
}
test('G-finance-later-page-failure-is-not-partial-success', 'R4-S07', async () => {
  const h = setup(); financeRows(h, 101); let reads = 0;
  h.afterRead = async name => { if (name === 'cashflow_entries' && ++reads === 1) h.failRead = name; };
  assert.equal((await h.call('admin', { action: 'financeOverview' })).success, false);
});
test('G-finance-real-zero-positive-and-101-page-controls', 'R4-S07', async () => {
  const h = setup(); const zero = await h.call('admin', { action: 'financeOverview' });
  assert.equal(zero.success, true); assert.equal(zero.data.receipts, 0); assert.equal(zero.data.daily.length, 0);
  financeRows(h, 101); h.tables().commissions = [{ _id: 'frozen', amount: 75, status: 'frozen' },
    { _id: 'settled', amount: 25, status: 'settled' }];
  const result = await h.call('admin', { action: 'financeOverview' });
  assert.equal(result.success, true); assert.equal(result.data.receipts, 10100);
  assert.equal(result.data.frozenLiability, 75); assert.equal(result.data.payableLiability, 25);
});
test('G-finance-capacity-limit-remains-explicit', 'R4-S07', async () => {
  const h = setup(); financeRows(h, 5000);
  const result = await h.call('admin', { action: 'financeOverview' });
  assert.equal(result.success, false); assert.ok(result.error.includes('5000'));
});
test('G-Web-finance-failure-clears-stale-report-and-recovery', 'R4-S07', async () => {
  const h = setup(); financeRows(h); const w = web(h); await w.app.loadFinance();
  assert.equal(w.app.finance.value.receipts, 100);
  h.failRead = 'cashflow_entries'; await w.app.loadFinance();
  assert.equal(w.app.finance.value, null, 'Failed report must not leave old normal numbers visible');
  assert.ok(w.app.financeError && w.app.financeError.value);
  const html = fs.readFileSync(path.join(h.root, 'admin-web/index.html'), 'utf8');
  assert.match(html, /v-if="financeError"/); assert.match(html, /v-else-if="finance"/);
  h.failRead = ''; h.tables().cashflow_entries = []; await w.app.loadFinance();
  assert.equal(w.app.financeError.value, ''); assert.equal(w.app.finance.value.receipts, 0);
});
test('G-Web-finance-transport-failure-is-unavailable', 'R4-S07', async () => {
  const h = setup(), w = web(h); w.transportFailure = true; await w.app.loadFinance();
  assert.equal(w.app.finance.value, null); assert.ok(w.app.financeError && w.app.financeError.value);
});
test('G-cleanup-preflight-read-error-and-before-write-order', 'R4-S07', async () => {
  const h = setup(); financeRows(h); h.failRead = 'cashflow_entries';
  const before = JSON.stringify(h.tables());
  const result = await h.call('admin', { action: 'transactionCleanupPreview' });
  assert.equal(result.success, false); assert.equal(JSON.stringify(h.tables()), before);
  const source = fs.readFileSync(path.join(h.root, 'cloudfunctions/admin/index.js'), 'utf8');
  const purge = source.slice(source.indexOf("case 'purgeTestTransactions':"), source.indexOf("case 'dashboard':"));
  assert.ok(purge.indexOf('await buildTransactionCleanupSnapshot()') < purge.indexOf('await runInChunks'));
  // Purge and migrations are intentionally NEVER executed, even with synthetic data.
});
test('G-Web-token-session-reply-is-authorized-by-current-role', 'R4-S04', async () => {
  const h = setup(), w = web(h), crypto = require('crypto');
  const token = 'synthetic-web-session';
  h.tables().admin_sessions = [{ _id: 'web-session', accountId: 'owner', status: 'active',
    tokenHash: crypto.createHash('sha256').update(token).digest('hex'), expiresAt: new Date(Date.now() + 60000) }];
  w.storage.adminToken = token; w.openId = 'synthetic-custom-auth-id';
  w.app.currentChatUser.value = 'test-buyer'; w.app.replyText.value = 'Authorized Web token answer';
  await w.app.sendReply();
  assert.equal(h.tables().messages.length, 1); assert.equal(h.tables().messages[0].adminAccountId, 'owner');
  assert.equal((await h.call('chat', { action: 'getUnreadCount' }, 'test-buyer')).count, 1);
  h.tables().admin_accounts[0].role = 'finance'; w.app.replyText.value = 'Must reject after demotion';
  await w.app.sendReply(); assert.equal(h.tables().messages.length, 1);
  assert.equal(w.app.replyText.value, 'Must reject after demotion');
});
test('G-finance-invalid-query-result-fails-closed', 'R4-S07', async () => {
  const h = setup(); h.afterRead = async (name, query, result) => { if (name === 'cashflow_entries') delete result.data; };
  assert.equal((await h.call('admin', { action: 'financeOverview' })).success, false);
});
test('G-Web-finance-latest-request-wins', 'R4-S07', async () => {
  const h = setup(), w = web(h), requests = [];
  w.override = () => new Promise(resolve => requests.push(resolve));
  const old = w.app.loadFinance(); const latest = w.app.loadFinance();
  requests[1]({ result: { success: true, data: { receipts: 123, daily: [] } } });
  await latest; assert.equal(w.app.finance.value.receipts, 123);
  requests[0]({ result: { success: false, error: 'Outdated failure' } });
  await old; assert.equal(w.app.finance.value.receipts, 123);
  assert.ok(w.app.financeError);
  assert.equal(w.app.financeError.value, ''); assert.equal(w.app.financeLoading.value, false);
});
test('G-Web-template-compiles-with-production-Vue', 'R2-002', async () => {
  const h = setup(), warnings = [];
  const context = { console: { warn: (...args) => warnings.push(args.join(' ')),
    error: (...args) => warnings.push(args.join(' ')), info() {}, log() {} } };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(h.root, 'admin-web/vendor/vue.global.prod.js'), 'utf8') +
    '\nthis.compileTemplate = Vue.compile;', context);
  const html = fs.readFileSync(path.join(h.root, 'admin-web/index.html'), 'utf8');
  const start = html.indexOf('<div id="app"'), end = html.indexOf('<script', start);
  assert.ok(start > 0 && end > start);
  const template = html.slice(start, end);
  assert.ok(template.length > 10000, 'Compile actual application template, not an empty substring');
  const entities = { amp: '&', gt: '>', lt: '<', quot: '"', apos: "'" };
  const compiled = context.compileTemplate(template, {
    decodeEntities: value => value.replace(/&(amp|gt|lt|quot|apos);/g, (_, name) => entities[name])
  });
  assert.equal(typeof compiled, 'function'); assert.equal(warnings.length, 0);
  // Compilation checks syntax only; no browser DOM, visual layout or live admin session.
});
test('G-real-consumer-Page-Web-reply-Page-read-flow', 'R4-S04', async () => {
  const h = setup(), page = chatPage(h), w = web(h);
  page.onInputChange({ detail: { value: 'Question from real Page event' } });
  await page.sendMessage(); assert.equal(h.tables().messages.length, 1);
  await w.app.loadMessageUsers();
  await w.app.selectChatUser(w.app.messageUsers.value.find(u => u.userOpenId === 'test-buyer'));
  w.app.replyText.value = 'Answer from real Web event'; await w.app.sendReply();
  assert.equal((await h.call('chat', { action: 'getUnreadCount' }, 'test-buyer')).count, 1);
  await page.loadMessages(true);
  assert.equal(page.data.messages.length, 2);
  const answer = page.data.messages.find(message => message.content === 'Answer from real Web event');
  assert.ok(answer); assert.equal(answer._isMe, false); assert.equal(page.data.loadError, '');
  assert.equal((await h.call('chat', { action: 'getUnreadCount' }, 'test-buyer')).count, 0);
});
cases.push({ id: 'G-contract-late-payment-rejects-shipping-and-displays-original-receipt',
  issue: 'R1-002', contractOnly: true, run: async () => {
    const h = setup();
    // G consumes F's declared persisted state. F and the combined gate must prove
    // the actual close/release/late-channel-SUCCESS transition that produces it.
    const order = { _id: 'late-paid', orderNo: 'TEST-LATE', status: 'paid', transactionId: 'ORIGINAL-RECEIPT',
      inventoryStatus: 'released', paymentResolutionRequired: true,
      paymentResolutionReason: 'inventory_released', totalFee: 10000, items: [] };
    h.tables().orders = [order];
    const rejected = await h.call('admin', { action: 'shipOrder', orderId: order._id,
      company: 'Synthetic carrier', trackingNo: 'SYNTHETIC-TRACKING' });
    assert.equal(rejected.success, false); assert.equal(rejected.code, 'PAYMENT_RESOLUTION_REQUIRED');
    assert.equal(order.status, 'paid'); assert.equal(order.inventoryStatus, 'released');
    const w = web(h); await w.app.loadOrders();
    const listed = w.app.orders.value.find(value => value._id === order._id);
    assert.equal(listed.paymentResolutionRequired, true);
    w.app.openShipModal(listed); assert.equal(w.app.shipModal.show, false);
    w.app.viewOrder(listed);
    const html = fs.readFileSync(path.join(h.root, 'admin-web/index.html'), 'utf8');
    assert.ok(html.includes('order.status === \'paid\' && !order.paymentResolutionRequired'));
    assert.ok(html.includes('orderDetailModal.data.paymentResolutionRequired'));
    const receiptLine = html.split('\n').find(line => line.includes('orderDetailModal.data.transactionId'));
    assert.ok(receiptLine);
    const expression = [...receiptLine.matchAll(/{{\s*(.*?)\s*}}/g)][0][1];
    assert.equal(vm.runInNewContext(expression, w.app), 'ORIGINAL-RECEIPT');
    assert.ok(html.includes('\u4ec5\u9000\u6b3e'));
    assert.ok(html.includes('\u6309\u539f\u5355\u6062\u590d\u5e93\u5b58\uff08\u4e0d\u9000\u6b3e\uff09'));
    const normal = { _id: 'normal-paid', status: 'paid', inventoryStatus: 'committed' };
    h.tables().orders.push(normal);
    const shipped = await h.call('admin', { action: 'shipOrder', orderId: normal._id,
      company: 'Synthetic carrier', trackingNo: 'SYNTHETIC-NORMAL' });
    assert.equal(shipped.success, true); assert.equal(normal.status, 'shipped');
    assert.equal(order.status, 'paid', 'Normal shipping must not mutate the exception order');
  } });
function originalMerchantRefund(h, fields = {}) {
  const order = { _id: 'original-order', userId: 'test-buyer', orderNo: 'ORIGINAL-ORDER',
    status: 'refunding', refundId: 'original-refund', transactionId: 'ORIGINAL-TRANSACTION',
    paymentSubMchId: 'original-merchant', totalFee: 10000, inventoryStatus: 'released', items: [], ...fields.order };
  const refund = { _id: 'original-refund', orderId: order._id, type: 'refund_only',
    status: 'pending', subMchId: 'original-merchant', prevStatus: 'paid', ...fields.refund };
  h.tables().orders = [order]; h.tables().refunds = [refund];
  h.tables().pay_config[0].subMchId = 'changed-current-merchant';
  const queries = []; h.beforeQuery = params => queries.push(structuredClone(params));
  return { order, refund, queries };
}
cases.push({ id: 'G-contract-refund-original-merchant-survives-current-config-change', issue: 'R1-002',
  contractOnly: true, run: async () => {
    const h = setup(), state = originalMerchantRefund(h);
    financeRows(h);
    h.tables().cashflow_entries[0].amount = 10000;
    h.tables().cashflow_entries[0].orderId = state.order._id;
    const result = await h.call('admin', { action: 'processRefund', refundId: state.refund._id, approve: true });
    assert.equal(result.success, true); assert.equal(h.refundCalls, 1);
    assert.equal(h.refundParams[0].subMchId, 'original-merchant');
    assert.equal(state.queries[0].subMchId, 'original-merchant');
    assert.equal(state.refund.subMchId, 'original-merchant');
    h.refundQuery = { returnCode: 'SUCCESS', resultCode: 'SUCCESS', outTradeNo: state.order.orderNo,
      refundCount: 1, outRefundNo0: state.refund.outRefundNo, refundFee0: 10000,
      refundStatus0: 'SUCCESS', refundId0: 'ORIGINAL-REFUND-RECEIPT' };
    const completed = await h.call('admin', { action: 'executeRefund', refundId: state.refund._id });
    assert.equal(completed.completed, true); assert.equal(h.refundCalls, 1);
    assert.equal(h.tables().orders[0].status, 'refunded');
    assert.equal(h.tables().orders[0].inventoryStatus, 'released');
    assert.equal(h.tables().orders[0].inventoryRefunded, false);
    assert.equal(h.tables().refunds[0].inventoryRestockStatus, 'not_required');
    const finance = await h.call('admin', { action: 'financeOverview' });
    assert.equal(finance.data.netCashflow, 0);
  } });
for (const source of ['refund-only', 'payment-only']) cases.push({
  id: 'G-contract-refund-one-known-original-binding-' + source, issue: 'R1-002', contractOnly: true, run: async () => {
    const h = setup(); const fields = source === 'refund-only' ? { order: { paymentSubMchId: '' } } : { refund: { subMchId: '' } };
    const state = originalMerchantRefund(h, fields);
    assert.equal((await h.call('admin', { action: 'processRefund', refundId: state.refund._id, approve: true })).success, true);
    assert.equal(h.refundParams[0].subMchId, 'original-merchant');
    assert.equal(h.tables().refunds[0].subMchId, 'original-merchant');
  } });
for (const kind of ['conflict', 'unknown']) cases.push({
  id: 'G-contract-refund-' + kind + '-merchant-blocked-before-query-or-submit', issue: 'R1-002',
  contractOnly: true, run: async () => {
    const h = setup(); const state = originalMerchantRefund(h, kind === 'conflict'
      ? { order: { paymentSubMchId: 'different-original-merchant' } }
      : { order: { paymentSubMchId: '' }, refund: { subMchId: '' } });
    const before = JSON.stringify(h.tables().refunds);
    const result = await h.call('admin', { action: 'processRefund', refundId: state.refund._id, approve: true });
    assert.equal(result.success, false);
    assert.equal(result.code, kind === 'conflict' ? 'REFUND_MERCHANT_MISMATCH' : 'REFUND_MERCHANT_UNVERIFIED');
    assert.equal(h.refundCalls, 0); assert.equal(h.refundQueries, 0);
    assert.equal(JSON.stringify(h.tables().refunds), before);
  } });
cases.push({ id: 'G-contract-refund-merchant-rechecked-inside-approval-transaction', issue: 'R1-002',
  contractOnly: true, run: async () => {
    const h = setup(), state = originalMerchantRefund(h); let reads = 0;
    h.afterRead = async (name, query, result) => {
      if (name === 'refunds' && ++reads === 2) {
        result.data.subMchId = 'concurrent-other-merchant';
        h.tables().refunds[0].subMchId = 'concurrent-other-merchant';
      }
    };
    const result = await h.call('admin', { action: 'processRefund', refundId: state.refund._id, approve: true });
    assert.equal(result.success, false); assert.equal(result.code, 'REFUND_MERCHANT_MISMATCH');
    assert.equal(h.refundQueries, 0); assert.equal(h.refundCalls, 0);
    assert.equal(h.tables().refunds[0].status, 'pending');
  } });
function incomingMessage(id, time) {
  return { _id: id, conversationId: 'test-buyer', fromId: 'test-buyer', toId: 'test-owner',
    isAdmin: false, isRead: false, content: id, type: 'text', createTime: new Date(time) };
}
test('G-history-unreturned-201st-message-retains-unread', 'R4-S04', async () => {
  const h = setup(); h.tables().messages = Array.from({ length: 201 }, (_, i) => incomingMessage('message-' + i, i));
  const result = await h.call('admin', { action: 'messageHistory', userOpenId: 'test-buyer' });
  assert.equal(result.success, true); assert.equal(result.data.length, 200);
  assert.equal(result.data.some(message => message._id === 'message-200'), false);
  assert.equal(h.tables().messages.find(message => message._id === 'message-200').isRead, false);
  assert.equal(h.tables().messages.filter(message => message.isRead).length, 200);
  assert.ok(result.data.every(message => message.isRead === true));
});
test('G-history-arrival-after-read-retains-unread', 'R4-S04', async () => {
  const h = setup(); h.tables().messages = [incomingMessage('existing', 1)]; let injected = false;
  h.beforeWrite = async name => {
    if (name === 'messages' && !injected) {
      injected = true; h.tables().messages.push(incomingMessage('arrived-after-read', 2));
    }
  };
  const result = await h.call('admin', { action: 'messageHistory', userOpenId: 'test-buyer' });
  assert.equal(result.success, true); assert.equal(result.data.length, 1);
  assert.equal(result.data.some(message => message._id === 'arrived-after-read'), false);
  assert.equal(h.tables().messages.find(message => message._id === 'arrived-after-read').isRead, false);
  assert.equal(h.tables().messages.find(message => message._id === 'existing').isRead, true);
  assert.equal(result.data[0].isRead, true);
});
cases.push({
  id: 'G-contract-actual-close-late-payment-ship-block-original-merchant-refund',
  issue: 'R1-002', contractOnly: true,
  run: async () => {
    const h = setup();
    h.tables().products = [{ _id: 'p', name: 'Integrated fixture', price: 1000,
      stock: 10, reservedStock: 0, sales: 0, status: 'on', specs: [], images: [] }];
    h.tables().users.push({ _id: 'test-buyer', referrer: 'test-agent' });
    h.tables().pay_config[0].subMchId = 'original-merchant';
    const created = await createOrder(h);
    assert.equal(created.success, true);
    let channelState = 'NOTPAY';
    const paymentQueries = [], refundQueries = [];
    h.cloud.cloudPay.unifiedOrder = async params => {
      assert.equal(params.subMchId, 'original-merchant');
      return { returnCode: 'SUCCESS', resultCode: 'SUCCESS', prepayId: 'INTEGRATED-PREPAY',
        payment: { timeStamp: '1', nonceStr: 'synthetic', package: 'prepay_id=INTEGRATED-PREPAY',
          signType: 'MD5', paySign: 'SYNTHETIC' } };
    };
    h.cloud.cloudPay.queryOrder = async params => {
      paymentQueries.push(structuredClone(params));
      return { returnCode: 'SUCCESS', resultCode: 'SUCCESS', tradeState: channelState,
        outTradeNo: 'JY20261018010203GGGGGG', subMchId: 'original-merchant',
        totalFee: 1000, transactionId: 'INTEGRATED-ORIGINAL-TX', subOpenid: 'test-buyer' };
    };
    h.cloud.cloudPay.closeOrder = async params => {
      assert.equal(params.subMchId, 'original-merchant');
      channelState = 'CLOSED';
      return { returnCode: 'SUCCESS', resultCode: 'SUCCESS' };
    };
    assert.equal((await h.call('pay', { action: 'request', orderId: created.orderId }, 'test-buyer')).success, true);
    assert.equal((await h.call('order', { action: 'cancel', id: created.orderId }, 'test-buyer')).success, true);
    const order = h.tables().orders.find(row => row._id === created.orderId);
    assert.equal(order.status, 'closed');
    assert.equal(order.inventoryStatus, 'released');
    assert.equal(h.tables().products[0].reservedStock, 0);
    h.tables().pay_config[0].subMchId = 'changed-current-merchant';
    channelState = 'SUCCESS';
    const notification = { returnCode: 'SUCCESS', resultCode: 'SUCCESS', outTradeNo: order.orderNo };
    assert.equal((await h.call('payNotify', notification, '')).errcode, 0);
    assert.equal((await h.call('payNotify', notification, '')).errcode, 0);
    assert.equal(order.status, 'paid');
    assert.equal(order.paymentResolutionRequired, true);
    assert.equal(order.inventoryStatus, 'released');
    assert.equal(order.transactionId, 'INTEGRATED-ORIGINAL-TX');
    assert.equal(h.tables().products[0].stock, 10);
    assert.equal(h.tables().commissions.length, 0);
    assert.equal(h.tables().cashflow_entries.length, 1);
    const shipped = await h.call('admin', { action: 'shipOrder', orderId: order._id,
      company: 'Synthetic', trackingNo: 'SYNTHETIC-INTEGRATED' });
    assert.equal(shipped.code, 'PAYMENT_RESOLUTION_REQUIRED');
    const w = web(h);
    await w.app.loadOrders();
    const listed = w.app.orders.value.find(row => row._id === order._id);
    assert.equal(listed.paymentResolutionRequired, true);
    w.app.openShipModal(listed);
    assert.equal(w.app.shipModal.show, false);
    const requested = await h.call('order', { action: 'requestRefund', id: order._id,
      reason: 'Integrated late payment' }, 'test-buyer');
    assert.equal(requested.success, true);
    const refund = h.tables().refunds.find(row => row.orderId === order._id);
    assert.equal(refund.subMchId, 'original-merchant');
    h.beforeQuery = params => refundQueries.push(structuredClone(params));
    h.refundQuery = { returnCode: 'SUCCESS', resultCode: 'FAIL', errCode: 'REFUNDNOTEXIST' };
    const approval = await h.call('admin', { action: 'processRefund', refundId: refund._id, approve: true });
    assert.equal(approval.channelAccepted, true);
    assert.equal(h.refundCalls, 1);
    assert.equal(h.refundParams[0].subMchId, 'original-merchant');
    h.refundQuery = { returnCode: 'SUCCESS', resultCode: 'SUCCESS', outTradeNo: order.orderNo,
      refundCount: 1, outRefundNo0: refund.outRefundNo, refundStatus0: 'SUCCESS',
      refundFee0: order.totalFee, refundId0: 'INTEGRATED-REFUND' };
    assert.equal((await h.call('admin', { action: 'executeRefund', refundId: refund._id })).completed, true);
    assert.equal((await h.call('admin', { action: 'executeRefund', refundId: refund._id })).completed, true);
    assert.equal(order.status, 'refunded');
    assert.equal(h.tables().products[0].stock, 10, 'Released stock must never be restored by refund');
    assert.equal(h.tables().commissions.length, 0);
    assert.equal(h.tables().cashflow_entries.length, 2);
    assert.equal(h.tables().cashflow_entries.reduce((sum, row) => sum +
      (row.direction === 'in' ? row.amount : -row.amount), 0), 0);
    assert.equal(h.refundCalls, 1);
    assert.ok(paymentQueries.length >= 3 && paymentQueries.every(row => row.subMchId === 'original-merchant'));
    assert.ok(refundQueries.length >= 1 && refundQueries.every(row => row.subMchId === 'original-merchant'));
  }
});
module.exports = cases;
