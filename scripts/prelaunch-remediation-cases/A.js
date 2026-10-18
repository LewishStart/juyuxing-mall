'use strict';
const assert = require('assert/strict');
const crypto = require('crypto');
const { createHarness } = require('../lib/prelaunch-remediation-fixture');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const cases = [];
function test(id, issue, run) { cases.push({ id, issue, run }); }
function order(h) {
  Object.assign(h.tables().orders[0], { status: 'pending', transactionId: '', agentId: '', commission: 0 });
  provenMerchant(h);
}
// Explicit synthetic original-payment evidence, limited to callback fixtures.
function provenMerchant(h) {
  Object.assign(h.tables().orders[0], { paymentSubMchId: 'test-merchant', paymentPhase: 'open', prepayId: 'SYNTHETIC-ORIGINAL-PREPAY' });
}
function paidQuery(extra = {}) { return { returnCode: 'SUCCESS', resultCode: 'SUCCESS', tradeState: 'SUCCESS',
  outTradeNo: 'TEST-ORDER', subMchId: 'test-merchant', transactionId: 'AUTH-TX', totalFee: 1500,
  subOpenid: 'test-buyer', openid: 'platform-distinct-id', ...extra }; }
const notify = { return_code: 'SUCCESS', result_code: 'SUCCESS', out_trade_no: 'TEST-ORDER' };
test('A-forged-callback-not-paid', 'R1-001', async () => {
  const h = createHarness(); order(h); const r = await h.call('payNotify', notify, 'test-stranger');
  assert.notEqual(r.errcode, 0); assert.equal(h.tables().orders[0].status, 'pending'); assert.equal(h.tables().cashflow_entries.length, 0);
});
test('A-authoritative-payment-posts-once', 'R1-001', async () => {
  const h = createHarness(); order(h); h.paymentQuery = paidQuery();
  const r = await h.call('payNotify', { ...notify, transaction_id: 'CALLER-TX', total_fee: 1 }, '');
  assert.equal(r.errcode, 0); assert.equal(h.tables().orders[0].status, 'paid'); assert.equal(h.tables().orders[0].transactionId, 'AUTH-TX');
  assert.equal((await h.call('payNotify', notify, '')).errcode, 0); assert.equal(h.tables().cashflow_entries.length, 1);
});
for (const [label, extra] of Object.entries({ fee: { totalFee: 1 }, payer: { subOpenid: 'other-buyer' }, merchant: { subMchId: 'other-merchant' }, number: { outTradeNo: 'OTHER' }, missingTx: { transactionId: '' }, missingFee: { totalFee: undefined }, result: { resultCode: 'FAIL' } })) {
  test('A-query-mismatch-' + label, 'R1-001', async () => {
    const h = createHarness(); order(h); h.paymentQuery = paidQuery(extra); const r = await h.call('payNotify', notify, '');
    assert.notEqual(r.errcode, 0); assert.equal(h.tables().orders[0].status, 'pending'); assert.equal(h.tables().cashflow_entries.length, 0);
  });
}
test('A-query-error-fail-closed', 'R1-001', async () => {
  const h = createHarness(); order(h); h.paymentQuery = new Error('synthetic timeout');
  assert.notEqual((await h.call('payNotify', notify, '')).errcode, 0); assert.equal(h.tables().cashflow_entries.length, 0);
});
test('A-sync-permission-and-positive-control', 'R1-001', async () => {
  const h = createHarness(); provenMerchant(h); h.paymentQuery = paidQuery(); h.tables().orders[0].transactionId = '';
  assert.equal((await h.call('payNotify', { action: 'syncTransaction', outTradeNo: 'TEST-ORDER' }, 'stranger')).success, false);
  assert.equal(h.tables().orders[0].transactionId, '');
  assert.equal((await h.call('payNotify', { action: 'syncTransaction', outTradeNo: 'TEST-ORDER' })).success, true);
  assert.equal(h.tables().orders[0].transactionId, 'AUTH-TX');
});
test('A-init-rejects-all-actions-without-write', 'R4-S01', async () => {
  for (const action of ['init', 'check', 'setPassword', 'setAdminOpenId', 'unknown']) {
    const h = createHarness(); const before = JSON.stringify(h.tables());
    const r = await h.call('init', { action, openId: 'synthetic-untrusted', password: 'synthetic-only' }, 'stranger');
    assert.equal(r.success, false); assert.equal(r.code, 'MAINTENANCE_DISABLED'); assert.equal(JSON.stringify(h.tables()), before);
  }
});
test('A-legacy-id-is-not-owner', 'R4-S02', async () => {
  const h = createHarness(); h.tables().admin_accounts = [];
  assert.equal((await h.call('admin', { action: 'checkAdmin' })).success, false);
});
test('A-bound-owner-disable-demote-rebind', 'R4-S02', async () => {
  const h = createHarness(); const a = h.tables().admin_accounts[0];
  assert.equal((await h.call('admin', { action: 'me' })).account.role, 'owner');
  a.role = 'operations'; assert.equal((await h.call('admin', { action: 'accountList' })).success, false);
  assert.equal((await h.call('admin', { action: 'me' })).account.role, 'operations');
  a.status = 'disabled'; assert.equal((await h.call('admin', { action: 'me' })).success, false);
  a.status = 'active'; a.wechatOpenId = 'new-owner'; assert.equal((await h.call('admin', { action: 'me' })).success, false);
  assert.equal((await h.call('admin', { action: 'me' }, 'new-owner')).success, true);
});
test('A-web-session-current-role-and-revocation', 'R4-S02', async () => {
  const h = createHarness(); h.tables().admin_sessions = [{ _id: 'session', tokenHash: hash('session-token'), accountId: 'owner', status: 'active', expiresAt: new Date(Date.now()+60000) }];
  assert.equal((await h.call('admin', { action: 'me', adminToken: 'session-token' }, '')).success, true);
  h.tables().admin_accounts[0].role = 'finance';
  assert.equal((await h.call('admin', { action: 'me', adminToken: 'session-token' }, '')).account.role, 'finance');
  h.tables().admin_accounts[0].status = 'disabled';
  assert.equal((await h.call('admin', { action: 'me', adminToken: 'session-token' }, '')).success, false);
});
function ticket(h, status = 'pending', bound = 'test-owner') {
  h.tables().admin_login_tickets = [{ _id: 'ticket', publicId: 'abcdefghijklmnop', pollSecretHash: hash('poll-secret'),
    status, accountId: 'owner', confirmedOpenIdHash: hash(bound), expiresAt: new Date(Date.now()+60000) }];
}
test('A-qr-does-not-bootstrap-legacy', 'R4-S02', async () => {
  const h = createHarness(); ticket(h); h.tables().admin_accounts = [];
  assert.equal((await h.call('adminQrAuth', { action: 'inspectQrLogin', publicId: 'abcdefghijklmnop' })).success, false);
  assert.equal(h.tables().admin_accounts.length, 0);
});
test('A-qr-normal-confirm-poll-and-rebind-revokes-session', 'R4-S02', async () => {
  const h = createHarness(); ticket(h);
  assert.equal((await h.call('adminQrAuth', { action: 'confirmQrLogin', publicId: 'abcdefghijklmnop' })).success, true);
  const r = await h.call('adminQrAuth', { action: 'pollQrLogin', publicId: 'abcdefghijklmnop', pollSecret: 'poll-secret' }, '');
  assert.equal(r.success, true); assert.ok(r.adminToken);
  assert.equal((await h.call('admin', { action: 'me', adminToken: r.adminToken }, '')).success, true);
  h.tables().admin_accounts[0].wechatOpenId = 'new-owner';
  assert.equal((await h.call('admin', { action: 'me', adminToken: r.adminToken }, '')).success, false);
});
test('A-qr-rebind-between-confirm-and-poll', 'R4-S02', async () => {
  const h = createHarness(); ticket(h, 'confirmed'); h.tables().admin_accounts[0].wechatOpenId = 'new-owner';
  const r = await h.call('adminQrAuth', { action: 'pollQrLogin', publicId: 'abcdefghijklmnop', pollSecret: 'poll-secret' }, '');
  assert.equal(r.success, false); assert.equal((h.tables().admin_sessions || []).length, 0);
});
test('A-chat-consumer-own-and-cross-owner-controls', 'R4-S03', async () => {
  const h = createHarness(); h.tables().messages = [{ _id: 'msg', conversationId: 'buyer-1', content: 'synthetic-private', createTime: new Date() }];
  assert.equal((await h.call('chat', { action: 'getMessages' }, 'buyer-1')).data.length, 1);
  assert.equal((await h.call('chat', { action: 'getMessages', conversationId: 'buyer-1' }, 'buyer-2')).success, false);
  assert.equal((await h.call('chat', { action: 'getMessages', conversationId: 'buyer-1' }, '')).success, false);
  assert.equal((await h.call('chat', { action: 'getMessages', conversationId: 'buyer-1' })).data.length, 1);
});
test('A-chat-role-disable-rebind-controls', 'R4-S03', async () => {
  const h = createHarness(); const a=h.tables().admin_accounts[0];
  a.role='operations'; assert.equal((await h.call('chat', { action: 'getConversationList' })).success, true);
  a.role='finance'; assert.equal((await h.call('chat', { action: 'getConversationList' })).success, false);
  a.role='owner'; a.status='disabled'; assert.equal((await h.call('chat', { action: 'getConversationList' })).success, false);
  a.status='active'; a.wechatOpenId='new-owner'; assert.equal((await h.call('chat', { action: 'getConversationList' })).success, false);
});
test('A-one-off-writers-disabled-before-io', 'R4-S05', async () => {
  for (const name of ['updateProductDesc', 'uploadProductImage']) {
    const h=createHarness(); const before=JSON.stringify(h.tables());
    const r=await h.call(name, {}, 'stranger'); assert.equal(r.success, false); assert.equal(r.code, 'MAINTENANCE_DISABLED');
    assert.equal(JSON.stringify(h.tables()), before);
  }
});
test('A-sync-does-not-overwrite-conflicting-transaction', 'R1-001', async () => {
  const h = createHarness(); provenMerchant(h); h.paymentQuery = paidQuery();
  assert.equal((await h.call('payNotify', { action: 'syncTransaction', outTradeNo: 'TEST-ORDER' })).success, false);
  assert.equal(h.tables().orders[0].transactionId, 'TEST-TX');
});
test('A-authoritative-snake-case-and-no-subopenid', 'R1-001', async () => {
  const h = createHarness(); order(h);
  h.paymentQuery = { return_code: 'SUCCESS', result_code: 'SUCCESS', trade_state: 'SUCCESS', out_trade_no: 'TEST-ORDER',
    sub_mch_id: 'test-merchant', transaction_id: 'AUTH-TX', total_fee: 1500, openid: 'provider-app-id' };
  assert.equal((await h.call('payNotify', notify, '')).errcode, 0);
  assert.equal(h.tables().orders[0].status, 'paid');
});
test('A-password-login-existing-account-control', 'R4-S02', async () => {
  const h = createHarness(); const a = h.tables().admin_accounts[0];
  a.username = 'owner'; const salt = 'synthetic-salt';
  a.passwordHash = 'scrypt$' + salt + '$' + crypto.scryptSync('synthetic-password', salt, 64).toString('hex');
  const r = await h.call('admin', { action: 'login', username: 'owner', password: 'synthetic-password' }, '');
  assert.equal(r.success, true); assert.ok(r.token);
  assert.equal((await h.call('admin', { action: 'me', adminToken: r.token }, '')).success, true);
});
test('A-legacy-password-cannot-create-owner', 'R4-S01', async () => {
  const h = createHarness(); h.tables().admin_accounts = [];
  h.tables().admin_config[0].password = 'synthetic-old-password';
  const r = await h.call('admin', { action: 'login', password: 'synthetic-old-password' }, '');
  assert.equal(r.success, false); assert.equal(h.tables().admin_accounts.length, 0);
});
test('A-unbound-legacy-account-not-auto-bound', 'R4-S02', async () => {
  const h = createHarness(); ticket(h); delete h.tables().admin_accounts[0].wechatOpenId;
  assert.equal((await h.call('adminQrAuth', { action: 'confirmQrLogin', publicId: 'abcdefghijklmnop' })).success, false);
  assert.equal(h.tables().admin_accounts[0].wechatOpenId, undefined);
});
for (const mode of ['expired', 'revoked', 'old-qr', 'unknown-role']) {
  test('A-session-rejects-' + mode, 'R4-S02', async () => {
    const h = createHarness();
    h.tables().admin_sessions = [{ _id: 'session', tokenHash: hash('token'), accountId: 'owner', status: 'active', expiresAt: new Date(Date.now()+60000) }];
    if (mode === 'expired') h.tables().admin_sessions[0].expiresAt = new Date(0);
    if (mode === 'revoked') h.tables().admin_sessions[0].status = 'revoked';
    if (mode === 'old-qr') h.tables().admin_sessions[0].source = 'wechat_qr';
    if (mode === 'unknown-role') h.tables().admin_accounts[0].role = 'not-a-role';
    assert.equal((await h.call('admin', { action: 'me', adminToken: 'token' }, '')).success, false);
  });
}
test('A-sync-finance-allowed-operations-and-disabled-rejected', 'R1-001', async () => {
  const h = createHarness(); provenMerchant(h); h.paymentQuery = paidQuery(); h.tables().orders[0].transactionId = '';
  const a = h.tables().admin_accounts[0]; a.role = 'operations';
  assert.equal((await h.call('payNotify', { action: 'syncTransaction', outTradeNo: 'TEST-ORDER' })).success, false);
  assert.equal((h.paymentQueries || []).length, 0);
  a.role = 'finance'; a.status = 'disabled';
  assert.equal((await h.call('payNotify', { action: 'syncTransaction', outTradeNo: 'TEST-ORDER' })).success, false);
  a.status = 'active'; assert.equal((await h.call('payNotify', { action: 'syncTransaction', outTradeNo: 'TEST-ORDER' })).success, true);
});
test('A-authorization-read-error-fails-closed', 'R4-S02', async () => {
  const h = createHarness(); h.failRead = 'admin_accounts';
  assert.equal((await h.call('admin', { action: 'me' })).success, false);
  assert.equal((await h.call('chat', { action: 'getMessages', conversationId: 'other-user' })).success, false);
});
test('A-query-payment-side-effect-failure-retries', 'R1-001', async () => {
  const h = createHarness(); order(h); h.paymentQuery = paidQuery(); h.failWrite = 'cashflow_entries';
  assert.notEqual((await h.call('payNotify', notify, '')).errcode, 0);
  assert.equal(h.tables().orders[0].status, 'pending'); assert.equal(h.tables().cashflow_entries.length, 0);
  h.failWrite = ''; assert.equal((await h.call('payNotify', notify, '')).errcode, 0);
  assert.equal(h.tables().cashflow_entries.length, 1);
});

for (const [label, merchant] of [['missing', undefined], ['empty', ''], ['blank', '  '], ['invalid-type', 123]]) {
  for (const action of ['notify', 'sync']) {
    test('A-unproven-original-merchant-' + label + '-' + action, 'R1-001', async () => {
      const h = createHarness(); order(h); const o = h.tables().orders[0];
      if (merchant === undefined) delete o.paymentSubMchId; else o.paymentSubMchId = merchant;
      h.tables().pay_config[0].subMchId = 'changed-current-merchant';
      let queries = 0; h.cloud.cloudPay.queryOrder = async () => { queries++; return paidQuery({ subMchId: 'changed-current-merchant' }); };
      const before = JSON.stringify({ orders: h.tables().orders, commissions: h.tables().commissions,
        products: h.tables().products, reservations: h.tables().inventory_reservations, receipts: h.tables().cashflow_entries });
      const event = action === 'notify' ? { ...notify, subMchId: 'caller-guessed-merchant' }
        : { action: 'syncTransaction', outTradeNo: 'TEST-ORDER', subMchId: 'caller-guessed-merchant' };
      const r = await h.call('payNotify', event, action === 'sync' ? 'test-owner' : '');
      assert.equal(queries, 0, 'Unknown original merchant must be refused before channel I/O');
      if (action === 'sync') assert.equal(r.success, false); else assert.notEqual(r.errcode, 0);
      assert.equal(JSON.stringify({ orders: h.tables().orders, commissions: h.tables().commissions,
        products: h.tables().products, reservations: h.tables().inventory_reservations, receipts: h.tables().cashflow_entries }), before);
    });
  }
}
for (const action of ['notify', 'sync']) {
  test('A-proven-original-ignores-changed-current-merchant-' + action, 'R1-001', async () => {
    const h = createHarness(); order(h); h.tables().pay_config[0].subMchId = 'changed-current-merchant';
    let queries = 0; h.cloud.cloudPay.queryOrder = async params => {
      queries++; assert.equal(params.subMchId, 'test-merchant'); return paidQuery();
    };
    const r = await h.call('payNotify', action === 'notify' ? notify : { action: 'syncTransaction', outTradeNo: 'TEST-ORDER' }, action === 'sync' ? 'test-owner' : '');
    assert.equal(queries, 1); assert.equal(action === 'notify' ? r.errcode : r.success, action === 'notify' ? 0 : true);
    assert.equal(h.tables().orders[0].paymentSubMchId, 'test-merchant');
    assert.equal(h.tables().orders[0].transactionId, 'AUTH-TX');
    assert.equal(h.tables().cashflow_entries.length, action === 'notify' ? 1 : 0);
  });
}
module.exports = cases;
