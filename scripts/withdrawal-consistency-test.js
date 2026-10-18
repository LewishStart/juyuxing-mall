#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { createHarness } = require('./lib/payment-flow-harness');

async function snapshot(h) {
  const info = await h.call('withdrawal', { action: 'info' }, 'test-agent');
  const dash = await h.call('agent', { action: 'dashboard' }, 'test-agent');
  const performance = await h.call('agent', { action: 'performance' }, 'test-agent');
  const list = await h.call('agent', { action: 'commissions' }, 'test-agent');
  const finance = await h.call('admin', { action: 'financeOverview', startTime: '2000-01-01', endTime: '2100-01-01' });
  for (const result of [info, dash, performance, list, finance]) assert.equal(result.success, true, JSON.stringify(result));
  return { info, dash, performance, list, finance: finance.data };
}

function amounts(s, paid = 0) {
  assert.equal(s.info.available, 400, 'withdrawal available');
  assert.equal(s.dash.available, 400, 'dashboard available agrees with withdrawal');
  assert.equal(s.performance.available, 400, 'performance available agrees with withdrawal');
  assert.equal(s.dash.paid, paid, 'dashboard paid requires channel success');
  assert.equal(s.dash.totalCommission, 500, 'held commission remains in total');
  assert.equal(s.finance.commissionPaid, paid, 'cash expense requires channel success');
}

const tests = {
  async applicationReservesAcrossReaders() {
    const h = createHarness(); const r = await h.apply(); assert(r.success);
    amounts(await snapshot(h));
  },
  async waitingForUserIsNotPaid() {
    const h = createHarness(); const r = await h.apply(); assert((await h.approve(r.withdrawalId)).success);
    assert.equal(h.tables().commissions.filter(c => c.status === 'paid').length, 0, 'waiting commission must not be paid');
    amounts(await snapshot(h));
    assert.equal(h.tables().cashflow_entries.length, 0, 'no posted expense before success');
    assert.equal(h.tables().commissions.filter(c => c.status === 'paid').length, 0);
  },
  async rejectedTransferDoesNotPost() {
    const h = createHarness(); h.transfer = Object.assign(new Error('IP rejected'), { code: 'INVALID_REQUEST' });
    const r = await h.apply(); await h.approve(r.withdrawalId);
    assert.equal((await snapshot(h)).finance.commissionPaid, 0, 'failed transfer must not post expense');
    amounts(await snapshot(h));
    assert.equal(h.tables().withdrawals[0].status, 'pending_pay');
    assert.equal(h.tables().cashflow_entries.length, 0);
  },
  async confirmedSuccessPostsOnce() {
    const h = createHarness(); const r = await h.apply(); await h.approve(r.withdrawalId);
    h.bill = { state: 'SUCCESS' };
    assert((await h.call('admin', { action: 'queryWithdrawalTransfer', withdrawalId: r.withdrawalId })).success);
    amounts(await snapshot(h), 100);
    await h.call('admin', { action: 'getOwnWithdrawalTransfer', withdrawalId: r.withdrawalId }, 'test-agent');
    amounts(await snapshot(h), 100);
    assert.equal(h.tables().cashflow_entries.length, 1);
    assert.equal(h.transferCalls.length, 1);
  },
  async immediateSuccessAndRepeatedApproval() {
    const h = createHarness(); h.transfer.state = 'SUCCESS'; const r = await h.apply();
    await h.approve(r.withdrawalId); await h.approve(r.withdrawalId);
    amounts(await snapshot(h), 100); assert.equal(h.transferCalls.length, 1);
  },
  async concurrentApprovalDoesNotDoubleSend() {
    const h = createHarness(); const r = await h.apply();
    await Promise.all([h.approve(r.withdrawalId), h.approve(r.withdrawalId)]);
    amounts(await snapshot(h)); assert.equal(h.transferCalls.length, 1);
  },
  async uncertainResultQueriesOriginalOnly() {
    const h = createHarness(); h.transfer = new Error('timeout'); const r = await h.apply();
    await h.approve(r.withdrawalId); const original = h.tables().withdrawals[0].outBatchNo;
    h.bill = new Error('timeout'); await h.approve(r.withdrawalId);
    assert.equal(h.tables().withdrawals[0].outBatchNo, original);
    assert.equal(h.transferCalls.length, 1); assert.deepEqual(h.queryCalls, [original]);
    amounts(await snapshot(h));
    h.bill = { state: 'SUCCESS' }; await h.approve(r.withdrawalId);
    amounts(await snapshot(h), 100); assert.equal(h.transferCalls.length, 1);
  },
  async closedOriginalCanRetryWithoutNewReservation() {
    const h = createHarness(); const r = await h.apply(); await h.approve(r.withdrawalId);
    const original = h.tables().withdrawals[0].outBatchNo;
    h.bill = { state: 'CANCELLED' };
    await h.call('admin', { action: 'queryWithdrawalTransfer', withdrawalId: r.withdrawalId });
    await h.approve(r.withdrawalId);
    assert.equal(h.tables().withdrawals[0].lastOutBatchNo, original);
    assert.notEqual(h.tables().withdrawals[0].outBatchNo, original);
    assert.equal(h.transferCalls.length, 2); amounts(await snapshot(h));
    assert.equal(h.tables().commissions.filter(c => c.paidByWithdrawal === r.withdrawalId).length, 1);
  },
  async nonexistentOriginalMayRetryButUnknownStateMayNot() {
    for (const notFound of [false, true]) {
      const h = createHarness(); h.transfer = new Error('timeout'); const r = await h.apply(); await h.approve(r.withdrawalId);
      const original = h.tables().withdrawals[0].outBatchNo;
      h.bill = notFound ? Object.assign(new Error('missing'), { code: 'NOT_FOUND' }) : { state: 'NEW_UNKNOWN' };
      h.transfer = { state: 'WAIT_USER_CONFIRM', packageInfo: 'test' }; await h.approve(r.withdrawalId);
      assert.equal(h.transferCalls.length, notFound ? 2 : 1);
      if (!notFound) assert.equal(h.tables().withdrawals[0].outBatchNo, original);
      amounts(await snapshot(h));
    }
  },
  async closedResponseMustMatchOriginalIdentityBeforeReplacingBill() {
    for (const state of ['FAIL', 'CANCELLED']) for (const raw of [
      { out_bill_no: 'OTHER-BILL' }, { transfer_amount: 101 }, { mch_id: 'OTHER-MERCHANT' }, { appid: 'OTHER-APP' }
    ]) {
      const h = createHarness(); h.transfer = new Error('timeout'); const r = await h.apply(); await h.approve(r.withdrawalId);
      const original = h.tables().withdrawals[0].outBatchNo;
      h.bill = { state, raw }; h.transfer = { state: 'WAIT_USER_CONFIRM', packageInfo: 'test' };
      await h.approve(r.withdrawalId);
      assert.equal(h.transferCalls.length, 1, 'mismatched closed bill must never permit a second payment');
      assert.equal(h.tables().withdrawals[0].outBatchNo, original); amounts(await snapshot(h));
    }
  },
  async emptyQueryResponseIsNotProofThatOriginalDoesNotExist() {
    const h = createHarness(); h.transfer = new Error('timeout'); const r = await h.apply(); await h.approve(r.withdrawalId);
    const original = h.tables().withdrawals[0].outBatchNo;
    h.bill = null; h.transfer = { state: 'WAIT_USER_CONFIRM' }; await h.approve(r.withdrawalId);
    assert.equal(h.transferCalls.length, 1); assert.equal(h.tables().withdrawals[0].outBatchNo, original);
  },
  async channelSuccessLocalRollbackRecoversWithoutResubmit() {
    const h = createHarness(); const r = await h.apply(); await h.approve(r.withdrawalId);
    h.bill = { state: 'SUCCESS' }; h.failWrite = 'cashflow_entries';
    assert.equal((await h.call('admin', { action: 'queryWithdrawalTransfer', withdrawalId: r.withdrawalId })).success, false);
    assert.equal(h.tables().withdrawals[0].status, 'transferring'); amounts(await snapshot(h));
    h.failWrite = ''; await h.call('admin', { action: 'queryWithdrawalTransfer', withdrawalId: r.withdrawalId });
    amounts(await snapshot(h), 100); assert.equal(h.transferCalls.length, 1);
  },
  async mismatchedProviderAmountNeverPostsAndStaleStateNeverDowngradesSuccess() {
    const h = createHarness(); const r = await h.apply(); await h.approve(r.withdrawalId);
    h.bill = { state: 'SUCCESS', raw: { transfer_amount: 101 } };
    assert.equal((await h.call('admin', { action: 'queryWithdrawalTransfer', withdrawalId: r.withdrawalId })).success, false);
    amounts(await snapshot(h));
    h.bill = { state: 'SUCCESS' }; await h.call('admin', { action: 'queryWithdrawalTransfer', withdrawalId: r.withdrawalId });
    h.bill = { state: 'WAIT_USER_CONFIRM' };
    const stale = await h.call('admin', { action: 'getOwnWithdrawalTransfer', withdrawalId: r.withdrawalId }, 'test-agent');
    assert.equal(stale.ready, false); assert.equal(stale.state, 'SUCCESS'); amounts(await snapshot(h), 100);
  },
  async legacyPostedEntryIsPreserved() {
    const h = createHarness(); h.tables().withdrawals.push({ _id: 'old', agentId: 'test-agent', amount: 100, status: 'pending_pay', outBatchNo: 'OLD' });
    const entry = { _id: 'old-flow', amount: 100, direction: 'out', type: 'commission_payout', status: 'posted', idempotencyKey: 'commission_payout:old', createTime: new Date() };
    h.tables().cashflow_entries.push(entry); const before = JSON.stringify(entry); h.bill = { state: 'SUCCESS' };
    await h.call('admin', { action: 'queryWithdrawalTransfer', withdrawalId: 'old' });
    assert.equal(h.tables().cashflow_entries.length, 1); assert.equal(JSON.stringify(h.tables().cashflow_entries[0]), before);
    assert.equal(h.transferCalls.length, 0);
  },
  async nonOwnerCannotReceiveAndMissingPackageCannotBeInvented() {
    const h = createHarness(); const r = await h.apply(); await h.approve(r.withdrawalId);
    assert.equal((await h.call('admin', { action: 'getOwnWithdrawalTransfer', withdrawalId: r.withdrawalId }, 'other-agent')).success, false);
    h.tables().withdrawals[0].packageInfo = '';
    const result = await h.call('admin', { action: 'getOwnWithdrawalTransfer', withdrawalId: r.withdrawalId }, 'test-agent');
    assert.equal(result.code, 'TRANSFER_PACKAGE_MISSING'); assert.equal(h.transferCalls.length, 1);
  },
  async refundHeldCommissionReversesOnceAcrossReaders() {
    const h = createHarness(); const r = await h.apply(); await h.approve(r.withdrawalId);
    const order = h.tables().orders[0]; order.status = 'refunding'; order.refundId = 'test-refund';
    const refund = { _id: 'test-refund', orderId: order._id };
    const effects = h.load(require('path').join(h.root, 'cloudfunctions/admin/refund-effects.js'));
    await h.db.runTransaction(t => effects.applyRefundEffects(t, h.db, order, refund, false));
    await h.db.runTransaction(t => effects.applyRefundEffects(t, h.db, order, refund, false));
    let s = await snapshot(h);
    assert.equal(s.info.available, 0); assert.equal(s.dash.available, 0); assert.equal(s.dash.totalCommission, 0);
    assert.equal(s.finance.commissionPaid, 0); assert.equal(s.finance.refunds, 1500);
    assert.equal(h.tables().commissions.filter(c => c.type === 'reversal').reduce((sum, c) => sum + c.amount, 0), -500);
    h.bill = { state: 'SUCCESS' }; await h.call('admin', { action: 'queryWithdrawalTransfer', withdrawalId: r.withdrawalId });
    s = await snapshot(h); assert.equal(s.info.available, 0); assert.equal(s.dash.available, 0);
    assert.equal(s.dash.paid, 100); assert.equal(s.dash.totalCommission, 0); assert.equal(s.finance.commissionPaid, 100);
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
