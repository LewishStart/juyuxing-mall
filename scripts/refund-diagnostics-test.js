#!/usr/bin/env node
'use strict';
require('./lib/payment-test-network');

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { createRequire } = require('module');
const root = path.resolve(__dirname, '..');

async function testQuery() {
  let queries = 0;
  let response;
  const refundId = 'test-refund';
  const outRefundNo = 'RF' + crypto.createHash('sha256').update(refundId).digest('hex').slice(0, 30);
  const tables = {
    admin_config: [{ _id: 'admin', openId: 'test-owner' }],
    admin_accounts: [{ _id: 'owner', wechatOpenId: 'test-owner', role: 'owner', status: 'active' }],
    refunds: [{ _id: refundId, orderId: 'test-order', status: 'pending' }],
    orders: [{ _id: 'test-order', orderNo: 'test-order-no', totalFee: 10, transactionId: 'test-payment' }],
    pay_config: [{ _id: 'default', subMchId: 'test-merchant' }]
  };
  const forbiddenWrite = () => { throw new Error('Query attempted a mutation'); };
  const collection = (name, filter = {}) => ({
    where: value => collection(name, value), limit() { return this; },
    get: async () => ({ data: (tables[name] || []).filter(row => Object.keys(filter).every(k => row[k] === filter[k])) }),
    doc: id => ({ get: async () => ({ data: (tables[name] || []).find(row => row._id === id) }), update: forbiddenWrite, set: forbiddenWrite, remove: forbiddenWrite }),
    add: forbiddenWrite, update: forbiddenWrite, remove: forbiddenWrite
  });
  let openId = 'test-owner';
  const cloud = {
    init() {}, database: () => ({ collection }), getWXContext: () => ({ OPENID: openId }),
    cloudPay: { refund: forbiddenWrite, queryRefund: async params => {
      queries++;
      assert.equal(params.outRefundNo, outRefundNo);
      assert.equal(params.subMchId, 'test-merchant');
      assert.equal(params.nonceStr.length, 32);
      assert(!params.functionName, 'query cannot register a payment callback');
      if (response instanceof Error) throw response;
      return response;
    } }
  };
  const filename = path.join(root, 'cloudfunctions/admin/index.js');
  const module = { exports: {} };
  const realRequire = createRequire(filename);
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, require: id => id === 'wx-server-sdk' ? cloud : realRequire(id),
    console, process, Buffer
  }, { filename });
  const main = module.exports.main;
  const event = { action: 'queryRefundStatus', refundId };
  const before = JSON.stringify(tables);
  response = { returnCode: 'SUCCESS', resultCode: 'SUCCESS', refundCount: 1,
    outRefundNo0: outRefundNo, refundStatus0: 'SUCCESS', refundId0: 'wechat-refund', refundFee0: 10,
    refundRecvAccout0: 'PRIVATE-ACCOUNT', sign: 'PRIVATE-SIGN' };
  let result = await main(event);
  assert.equal(result.success, true, 'refund query action exists');
  assert.equal(result.data.status, 'SUCCESS');
  assert(!JSON.stringify(result).includes('PRIVATE'), 'no payment recipient or signature returned');
  response.refundStatus0 = 'PROCESSING';
  assert.equal((await main(event)).data.status, 'PROCESSING');
  response = { return_code: 'SUCCESS', result_code: 'SUCCESS', refund_count: 1,
    out_refund_no_0: outRefundNo, refund_status_0: 'REFUNDCLOSE', refund_fee_0: 10 };
  assert.equal((await main(event)).data.status, 'REFUNDCLOSE', 'snake case is supported');
  response.out_refund_no_0 = 'different-refund';
  assert.equal((await main(event)).success, false, 'never report another refund as this refund');
  response = { returnCode: 'SUCCESS', resultCode: 'SUCCESS', refundCount: 0 };
  assert.equal((await main(event)).success, false, 'empty success cannot prove refund state');
  response = { returnCode: 'SUCCESS', resultCode: 'SUCCESS', refundCount: 1,
    outRefundNo0: outRefundNo, refundStatus0: 'UNRECOGNIZED', refundFee0: 10 };
  assert.equal((await main(event)).success, false, 'unknown status fails closed');
  response = { returnCode: 'SUCCESS', resultCode: 'FAIL', errCode: 'REFUNDNOTEXIST', errCodeDes: 'not found' };
  assert.equal((await main(event)).data.status, 'NOT_FOUND');
  response = new Error('test timeout');
  result = await main(event);
  assert.equal(result.success, false);
  assert(/timeout|超时|未知/i.test(result.error));
  const count = queries;
  openId = 'test-consumer';
  assert.equal((await main(event)).success, false);
  assert.equal(queries, count, 'unauthorized users cannot contact payment channel');
  openId = 'test-owner';
  tables.orders[0].paymentSource = 'mockPay';
  assert.equal((await main(event)).data.status, 'MOCK');
  assert.equal(queries, count, 'mock orders never query real payment channel');
  delete tables.orders[0].paymentSource;
  assert.equal(JSON.stringify(tables), before, 'all query outcomes leave database unchanged');
  tables.pay_config[0].subMchId = '';
  assert.equal((await main(event)).success, false, 'missing merchant cannot query');
  assert.equal(queries, count);
}

async function testWeb() {
  let definition;
  const calls = [];
  const responses = [];
  let copied;
  const store = {};
  const sandbox = {
    Vue: { createApp: app => { definition = app; return { mount() {} }; }, ref: value => ({ value }), reactive: value => value,
      computed: fn => ({ get value() { return fn(); } }), onMounted() {}, onBeforeUnmount() {}, nextTick: async () => {}, watch() {} },
    window: { cloudbase: { init: () => ({ auth: () => ({}), callFunction: async request => {
      calls.push(request.data);
      const response = responses.shift();
      return { result: await (typeof response === 'function' ? response() : response) };
    } }) } },
    localStorage: { getItem: key => store[key] || null, removeItem: key => { delete store[key]; } },
    navigator: { clipboard: { writeText: async text => { copied = text; } } },
    console, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {}
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'admin-web/app.js'), 'utf8'), sandbox);
  const app = definition.setup();
  const rf = { _id: 'refund-a', status: 'pending', type: 'refund_only', order: { orderNo: 'order-a' } };
  assert.equal(typeof app.queryRefundStatus, 'function', 'web exposes read-only query');
  responses.push({ success: true, data: { status: 'PROCESSING', message: '渠道处理中' } });
  await app.queryRefundStatus(rf);
  assert.equal(calls[0].action, 'queryRefundStatus');
  assert(app.refundDiagnostics[rf._id].text.includes('PROCESSING'));
  app.openRefundModal(rf, true);
  responses.push({ success: false, error: '退款接口异常: test failure' });
  await app.confirmRefund();
  assert.equal(app.processingAction.value, false);
  assert(app.refundDiagnostics[rf._id].text.includes('test failure'));
  app.refundModal.show = false;
  app.openRefundModal(rf, true);
  assert(app.refundDiagnostics[rf._id].text.includes('test failure'), 'error survives reopening dialog');
  await app.copyRefundDiagnostic(rf._id);
  assert(copied.includes('test failure') && copied.includes('order-a'));
  let resolve;
  responses.push(() => new Promise(done => { resolve = done; }));
  const pending = app.queryRefundStatus(rf);
  const priorCalls = calls.length;
  await app.queryRefundStatus(rf);
  await app.confirmRefund();
  assert.equal(calls.length, priorCalls, 'query and refund cannot overlap or duplicate');
  resolve({ success: false, error: 'query timeout' });
  await pending;
  assert.equal(app.queryingRefundId.value, '');
  assert(app.refundDiagnostics[rf._id].text.includes('query timeout'));
  assert(app.refundDiagnostics[rf._id].text.includes('test failure'), 'query must preserve prior refund error');
  app.viewRefund({ ...rf, status: 'approved' });
  const beforeView = calls.length;
  await app.confirmRefund();
  assert.equal(calls.length, beforeView, 'view-only detail cannot submit refund');
  responses.push({ success: false, error: 'unknown action' });
  await app.queryRefundStatus(rf);
  assert(app.refundDiagnostics[rf._id].text.includes('尚未部署'), 'old cloud deployment is explained persistently');
  for (const status of ['pending_auto', 'processing', 'channel_processing', 'manual_review']) {
    assert(!/已退款|已同意/.test(app.refundStatusText(status)), 'unfinished state never labelled complete');
  }
  const beforeQr = calls.length;
  app.currentAccount.value = { role: 'operations' };
  await app.openRefundOperatorQr();
  assert.equal(calls.length, beforeQr);
  app.currentAccount.value = { role: 'finance' };
  responses.push({ success: true, qrDataUrl: 'data:image/png;base64,TEST' });
  await app.openRefundOperatorQr();
  assert.equal(calls[calls.length - 1].action, 'createQrLogin');
  assert.equal(app.refundOperatorQr.image, 'data:image/png;base64,TEST');
}

(async () => {
  for (const test of [testQuery, testWeb]) {
    try { await test(); console.log('PASS ' + test.name); }
    catch (err) { console.error(err.stack); process.exitCode = 1; }
  }
})();
