#!/usr/bin/env node
'use strict';

require('./lib/payment-test-network');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { createHarness } = require('./lib/payment-flow-harness');
const diagnostics = require('../cloudfunctions/admin/payment-diagnostics');
const direct = require('../cloudfunctions/admin/wxpay-direct');
const root = path.resolve(__dirname, '..');

function page(name, api, wx = {}) {
  let definition; const messages = [];
  const filename = path.join(root, 'miniprogram/subpackages/distributor', name, name + '.js');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    Page: value => { definition = value; }, wx: { stopPullDownRefresh() {}, showModal() {}, ...wx },
    require: name => name.endsWith('/api') ? api : { toast: message => messages.push(message) }, console
  }, { filename });
  definition.data = structuredClone(definition.data);
  definition.setData = data => Object.assign(definition.data, data);
  definition.messages = messages;
  return definition;
}

const tests = {
  logWhitelistNeverSerializesSecrets() {
    const logs = []; const logger = { log: (...args) => logs.push(args.join(' ')) };
    diagnostics.event(logger, 'withdrawal.failed', { id: 'PRIVATE-OPENID', code: 'PRIVATE-KEY',
      state: 'PRIVATE-PACKAGE', channel: 'PRIVATE-ACCOUNT', mode: 'PRIVATE-TOKEN',
      privateKey: 'PRIVATE-KEY', message: 'PRIVATE-RESPONSE', httpCode: 403, durationMs: 22 });
    assert(!logs.join('').includes('PRIVATE'));
    const entry = JSON.parse(logs[0].slice(logs[0].indexOf('{')));
    assert.equal(entry.httpCode, 403); assert.equal(entry.durationMs, 22); assert.equal(entry.ref.length, 12);
    assert.equal(entry.code, 'UNKNOWN');
    assert(!diagnostics.safeError(Object.assign(new Error('PRIVATE-KEY'), { code: 'PRIVATE-KEY' })).includes('PRIVATE'));
  },
  directResponseRequiresSignatureAndMerchant() {
    const opts = { appId: 'test-app', mchId: 'test-merchant', apiV2Key: 'test-key' };
    const response = { appid: opts.appId, mch_id: opts.mchId, return_code: 'SUCCESS', result_code: 'SUCCESS', sign_type: 'HMAC-SHA256' };
    response.sign = direct.wxSignHmacSha256(response, opts.apiV2Key);
    assert.equal(direct.verifyWxResponse(response, opts), response);
    assert.throws(() => direct.verifyWxResponse({ ...response, mch_id: 'other' }, opts));
    assert.throws(() => direct.verifyWxResponse({ ...response, sign: '0'.repeat(64) }, opts));
    assert.throws(() => direct.verifyWxResponse({ ...response, sign: '' }, opts));
  },
  async onlyKeyIsEnoughForPureDirectQueries() {
    const cfg = { apiV2Key: 'test', subMchId: 'test-merchant' };
    const db = { collection: () => ({ doc: () => ({ get: async () => ({ data: cfg }) }) }) };
    assert.equal(await direct.loadPayApiConfig(db), null);
    assert.equal((await direct.loadPayApiConfig(db, false)).apiV2Key, 'test');
  },
  async actualTransferTransportClassifiesWithoutNetwork() {
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const key = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });
    const platform = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicKey = platform.publicKey.export({ type: 'spki', format: 'pem' });
    const platformId = 'PUB_KEY_ID_3000000001';
    const env = { WECHATPAY_PLATFORM_PUBLIC_KEY_ID: platformId,
      WECHATPAY_PLATFORM_PUBLIC_KEY_PATH: '/synthetic/platform.pem',
      WECHATPAY_PLATFORM_PUBLIC_KEY_EXPIRES_AT: new Date(Date.now() + 86400000).toISOString() };
    let next = { httpCode: 403, body: { code: 'INVALID_REQUEST', message: 'IP rejected PRIVATE-RESPONSE' } };
    let calls = 0;
    const fakeHttps = { request: (options, callback) => {
      calls++; assert(options.headers.Authorization.startsWith('WECHATPAY2-'));
      const req = new EventEmitter(); req.write = () => {}; req.destroy = error => req.emit('error', error);
      req.end = () => queueMicrotask(() => {
        const res = new EventEmitter(); res.statusCode = next.httpCode; res.setEncoding = () => {};
        const body = Buffer.from(JSON.stringify(next.body));
        const timestamp = String(Math.floor(Date.now() / 1000));
        const nonce = 'synthetic-response-nonce';
        res.headers = { 'wechatpay-timestamp': timestamp, 'wechatpay-nonce': nonce,
          'wechatpay-serial': platformId,
          'wechatpay-signature': crypto.sign('RSA-SHA256', Buffer.concat([
            Buffer.from(timestamp + '\n' + nonce + '\n'), body, Buffer.from('\n')
          ]), platform.privateKey).toString('base64') };
        callback(res); res.emit('data', body); res.emit('end');
      });
      return req;
    } };
    const filename = path.join(root, 'cloudfunctions/admin/wxpay-transfer.js');
    const mod = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module: mod, exports: mod.exports,
      require: name => name === 'https' ? fakeHttps : name === 'fs'
        ? { readFileSync: file => file === env.WECHATPAY_PLATFORM_PUBLIC_KEY_PATH ? publicKey : key } : require(name),
      process: { env }, Buffer, console, __dirname: path.dirname(filename) }, { filename });
    const client = mod.exports;
    await assert.rejects(client.initiateTransfer({ amountFen: 100, openid: 'test-agent', outBillNo: 'TEST' }), error => error.code === 'INVALID_REQUEST');
    assert.equal(client.isBillNotExistError({ httpCode: 404, code: 'SYSTEMERROR', message: 'not exist' }), false);
    assert.equal(client.isBillNotExistError({ code: 'NOT_FOUND' }), false);
    assert.equal(client.isBillNotExistError({ channelStateTrusted: true, httpCode: 404, code: 'NOT_FOUND' }), true);
    assert.equal(client.isBillNotExistError({ channelStateTrusted: true, httpCode: 403, code: 'NOT_FOUND' }), false);
    next = { httpCode: 200, body: { out_bill_no: 'TEST', state: 'WAIT_USER_CONFIRM', package_info: 'PRIVATE-PACKAGE', transfer_bill_no: 'TEST' } };
    assert.equal((await client.initiateTransfer({ amountFen: 100, openid: 'test-agent', outBillNo: 'TEST' })).state, 'WAIT_USER_CONFIRM');
    next.body = { out_bill_no: 'TEST', state: 'SUCCESS' }; assert.equal((await client.queryBill('TEST')).state, 'SUCCESS');
    assert.equal(calls, 3);
    const missing = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module: missing, exports: missing.exports,
      require: name => name === 'https' ? fakeHttps : name === 'fs' ? { readFileSync: file => {
        if (file === env.WECHATPAY_PLATFORM_PUBLIC_KEY_PATH) return publicKey;
        throw Object.assign(new Error('PRIVATE-PATH'), { code: 'ENOENT' });
      } } : require(name),
      process: { env }, Buffer, console, __dirname: path.dirname(filename) }, { filename });
    await assert.rejects(missing.exports.initiateTransfer({ amountFen: 100, openid: 'test-agent', outBillNo: 'TEST-MISSING-SIGNING-KEY' }),
      error => error.code === 'WECHATPAY_RESPONSE_UNTRUSTED' && error.verificationReason === 'CLIENT_ERROR'
        && error.outBillNo === 'TEST-MISSING-SIGNING-KEY' && error.requiresReconciliation === true);
    assert.equal(calls, 3, 'missing signature key must fail before HTTP');
  },
  async heldCommissionPagesUseSameMoneyAndReadableState() {
    const h = createHarness(); const r = await h.apply(); await h.approve(r.withdrawalId);
    const api = { getAgentDashboard: () => h.call('agent', { action: 'dashboard' }, 'test-agent'),
      getAgentCommissions: () => h.call('agent', { action: 'commissions' }, 'test-agent') };
    const dashboard = page('dashboard', api); await dashboard.load();
    assert.equal(dashboard.data.stats.available, '4.00'); assert.equal(dashboard.data.stats.paid, '0.00');
    assert.equal(dashboard.data.stats.totalCommission, '5.00');
    const commissions = page('commissions', api); await commissions.load();
    assert(commissions.data.list.some(c => c.status === 'withdrawing' && c.statusText === '提现处理中'));
  },
  async directRefundIsQueriedBeforeSubmissionAndFinalizedOnlyOnMatchingSuccess() {
    const h = createHarness(); const order = h.tables().orders[0]; order.status = 'refunding'; order.refundId = 'rf';
    order.paymentSubMchId = 'test-merchant';
    order.inventoryStatus = 'released'; // Transport-only fixture: no stock deduction to restore.
    h.tables().refunds.push({ _id: 'rf', orderId: order._id, type: 'refund_only', status: 'pending', outRefundNo: 'TEST-RF' });
    Object.assign(h.tables().pay_config[0], { apiV2Key: 'test', apiCertP12: Buffer.from('fixture').toString('base64') });
    let submitted = 0; let response = { return_code: 'SUCCESS', result_code: 'FAIL', err_code: 'REFUNDNOTEXIST' };
    h.directAdapter = {
      directOrderQuery: async () => ({ result_code: 'SUCCESS', trade_state: 'SUCCESS', out_trade_no: order.orderNo,
        total_fee: order.totalFee, transaction_id: order.transactionId }),
      directQueryRefund: async () => response,
      directRefund: async params => { submitted++; assert.equal(params.outRefundNo, 'TEST-RF'); return { return_code: 'SUCCESS', result_code: 'SUCCESS', refund_id: 'TEST-ID' }; }
    };
    const approval = await h.call('admin', { action: 'processRefund', refundId: 'rf', approve: true });
    assert.equal(approval.completed, false); assert.equal(submitted, 1); assert.equal(h.refundCalls, 0);
    assert.equal(h.tables().orders[0].status, 'refunding'); assert.equal(h.tables().cashflow_entries.length, 0);
    await h.call('admin', { action: 'retryRefund', refundId: 'rf' }); assert.equal(submitted, 1);
    response = { return_code: 'SUCCESS', result_code: 'SUCCESS', out_trade_no: order.orderNo,
      refund_count: 1, out_refund_no_0: 'TEST-RF', refund_status_0: 'SUCCESS', refund_id_0: 'TEST-ID', refund_fee_0: order.totalFee - 1 };
    await h.call('admin', { action: 'retryRefund', refundId: 'rf' }); assert.equal(h.tables().cashflow_entries.length, 0);
    response.refund_fee_0 = order.totalFee;
    const completed = await h.call('admin', { action: 'retryRefund', refundId: 'rf' });
    assert.equal(completed.completed, true); assert.equal(submitted, 1);
    assert.equal(h.tables().orders[0].status, 'refunded'); assert.equal(h.tables().cashflow_entries.length, 1);
  },
  async submittedMarkerFailureBlocksMoneyAfterClaimAndQuery() {
    const h = createHarness(); const order = h.tables().orders[0]; order.status = 'refunding'; order.refundId = 'rf';
    h.tables().refunds.push({ _id: 'rf', orderId: order._id, type: 'refund_only', status: 'pending_auto',
      outRefundNo: 'TEST-RF', approvedAmount: order.totalFee, executionVersion: 2, processTime: new Date(0) });
    h.failWhen = (name, data) => name === 'refunds' && data && Object.hasOwn(data, 'submittedAt');
    const result = await h.call('admin', { action: 'executeRefund', refundId: 'rf' });
    assert.equal(result.completed, false); assert.equal(h.refundQueries, 1);
    assert.equal(h.refundCalls, 0); assert.equal(h.tables().cashflow_entries.length, 0);
  },
  async lostSelfInvocationResponseNeverTriggersSecondRefund() {
    const h = createHarness(); const order = h.tables().orders[0]; order.status = 'refunding'; order.refundId = 'rf';
    order.paymentSubMchId = 'test-merchant';
    order.inventoryStatus = 'released'; // Unknown historical stock remains covered by E negative cases.
    h.tables().refunds.push({ _id: 'rf', orderId: order._id, type: 'refund_only', status: 'pending', outRefundNo: 'TEST-RF' });
    h.env = { MINIPROGRAM_APPSECRET: 'fixture-appsecret' };
    let selfCalls = 0;
    h.httpsAdapter = { request: (options, callback) => {
      const req = new EventEmitter(); req.write = () => {}; req.destroy = error => req.emit('error', error);
      req.end = () => queueMicrotask(async () => {
        if (options.path.includes('stable_token')) {
          const res = new EventEmitter(); res.setEncoding = () => {}; callback(res);
          res.emit('data', JSON.stringify({ access_token: 'fixture-token', expires_in: 7200 })); res.emit('end');
        } else {
          selfCalls++;
          await h.call('admin', { action: 'executeRefund', refundId: 'rf' });
          req.emit('error', new Error('timeout after child accepted'));
        }
      });
      return req;
    } };
    const result = await h.call('admin', { action: 'processRefund', refundId: 'rf', approve: true });
    assert.equal(selfCalls, 1); assert.equal(h.refundCalls, 1); assert.equal(result.completed, false);
    assert.equal(h.tables().cashflow_entries.length, 0); assert.equal(h.tables().orders[0].status, 'refunding');
    assert(!h.logs.join('').includes('fixture-appsecret')); assert(!h.logs.join('').includes('fixture-token'));
  },
  async receiveCancelUnsupportedAndFailureRemainUsable() {
    const api = { getWithdrawalInfo: async () => ({ success: true }), getWithdrawalList: async () => ({ success: true, data: [] }),
      getOwnWithdrawalTransfer: async () => ({ success: true, ready: true, packageInfo: 'private', mchId: 'm', appId: 'a' }) };
    let invoked;
    const p = page('withdrawal', api, { canIUse: () => true, requestMerchantTransfer: options => { invoked = options; } });
    await p.receiveTransfer({ currentTarget: { dataset: { id: 'test' } } });
    await invoked.fail({ errMsg: 'cancel' }); assert.equal(p.data.receivingId, '');
    const unsupported = page('withdrawal', api, { canIUse: () => false });
    await unsupported.receiveTransfer({ currentTarget: { dataset: { id: 'test' } } });
    assert.equal(unsupported.data.receivingId, '');
    const failure = page('withdrawal', { ...api, getOwnWithdrawalTransfer: async () => { throw new Error('transport'); } });
    await failure.receiveTransfer({ currentTarget: { dataset: { id: 'test' } } }).catch(() => {});
    assert.equal(failure.data.receivingId, '', 'transport rejection must release receiving state');
  }
};

(async () => {
  let failed = 0;
  for (const [name, run] of Object.entries(tests)) {
    try { await run(); console.log('PASS', name); }
    catch (error) { failed++; console.error('FAIL', name, error.message); }
  }
  process.exitCode = failed ? 1 : 0;
})();
