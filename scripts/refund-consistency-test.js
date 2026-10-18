#!/usr/bin/env node
'use strict';
require('./lib/payment-test-network');

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const root = path.resolve(__dirname, '..');

function harness() {
  let tables = {
    admin_config: [{ _id: 'admin', openId: 'owner-wx' }],
    admin_accounts: [{ _id: 'owner', wechatOpenId: 'owner-wx', role: 'owner', status: 'active' }],
    users: [{ _id: 'agent' }], // Existing commission owner supplies the same-agent conflict fence.
    refunds: [{ _id: 'rf', orderId: 'order', status: 'pending_auto', outRefundNo: 'RF-test',
      approvedAmount: 100, subMchId: 'merchant', executionVersion: 2, restock: true, type: 'refund_only', processTime: new Date(0) }],
    orders: [{ _id: 'order', orderNo: 'ORDER-test', totalFee: 100, transactionId: 'TX-test',
      status: 'refunding', inventoryStatus: 'committed', refundId: 'rf', agentId: 'agent', items: [{ productId: 'product', spec: 'sku', quantity: 1 }] }],
    products: [{ _id: 'product', stock: 2, sales: 1, specs: [{ name: 'sku', stock: 2 }] }],
    commissions: [{ _id: 'commission', orderId: 'order', agentId: 'agent', status: 'frozen', amount: 33 }],
    cashflow_entries: [], inventory_adjustments: [], pay_config: [{ _id: 'default', subMchId: 'merchant' }]
  };
  const h = { openId: 'owner-wx', refunds: 0, queries: 0, failWrite: '',
    query: { returnCode: 'SUCCESS', resultCode: 'FAIL', errCode: 'REFUNDNOTEXIST' },
    refund: { returnCode: 'SUCCESS', resultCode: 'SUCCESS', refundId: 'WX-refund' } };
  const matches = (row, filter) => Object.entries(filter).every(([key, v]) => {
    if (v && v.op === 'in') return v.value.includes(row[key]);
    if (v && v.op === 'lt') return new Date(row[key]) < v.value;
    return row[key] === v;
  });
  function collection(name, filter = {}, limit = 1000, sort = null) {
    const rows = () => (tables[name] || []).filter(row => matches(row, filter));
    const write = () => { if (h.failWrite === name) throw new Error('forced ' + name + ' failure'); };
    return {
      where: f => collection(name, { ...filter, ...f }, limit, sort),
      limit: n => collection(name, filter, n, sort),
      orderBy: (field, direction) => collection(name, filter, limit, [field, direction]),
      get: async () => {
        const list = rows();
        if (sort) list.sort((a, b) => ((new Date(a[sort[0]] || 0)) - new Date(b[sort[0]] || 0)) * (sort[1] === 'desc' ? -1 : 1));
        return { data: structuredClone(list.slice(0, limit)) };
      },
      count: async () => ({ total: rows().length }),
      update: async ({ data }) => {
        write();
        const targets = rows();
        for (const row of targets) for (const [k, v] of Object.entries(data)) {
          row[k] = v && v.op === 'inc' ? (Number(row[k]) || 0) + v.value : structuredClone(v);
        }
        return { stats: { updated: targets.length } };
      },
      add: async ({ data }) => {
        write();
        const id = name + '-' + (tables[name] || []).length;
        (tables[name] ||= []).push({ _id: id, ...structuredClone(data) });
        return { _id: id };
      },
      doc: id => ({
        get: async () => ({ data: structuredClone((tables[name] || []).find(row => row._id === id)) }),
        update: input => collection(name, { _id: id }).update(input)
      })
    };
  }
  let lock = Promise.resolve();
  const db = { collection, serverDate: () => new Date(), command: {
    in: value => ({ op: 'in', value }), lt: value => ({ op: 'lt', value }), inc: value => ({ op: 'inc', value })
  }, runTransaction: work => {
    const run = lock.then(async () => {
      const before = structuredClone(tables);
      try { return await work(db); } catch (err) { tables = before; throw err; }
    });
    lock = run.catch(() => {});
    return run;
  } };
  const cloud = { init() {}, database: () => db, getWXContext: () => ({ OPENID: h.openId }), cloudPay: {
    queryRefund: async () => { h.queries++; if (h.query instanceof Error) throw h.query; return structuredClone(h.query); },
    refund: async params => {
      h.refunds++;
      assert.equal(params.outRefundNo, 'RF-test');
      if (h.refund instanceof Error) throw h.refund;
      return structuredClone(h.refund);
    }
  } };
  const filename = path.join(root, 'cloudfunctions/refund-processor/index.js');
  const module = { exports: {} };
  const realRequire = createRequire(filename);
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, require: id => id === 'wx-server-sdk' ? cloud : realRequire(id),
    console: { log() {}, warn() {}, error() {} }, process, Buffer
  }, { filename });
  h.run = () => module.exports.main({ action: 'sweep', userInfo: { openId: 'forged-owner' } });
  const adminFile = path.join(root, 'cloudfunctions/admin/index.js');
  const adminModule = { exports: {} };
  const adminRequire = createRequire(adminFile);
  vm.runInNewContext(fs.readFileSync(adminFile, 'utf8'), {
    module: adminModule, exports: adminModule.exports,
    require: id => id === 'wx-server-sdk' ? cloud : adminRequire(id),
    console, process, Buffer
  }, { filename: adminFile });
  h.admin = event => adminModule.exports.main(event);
  h.tables = () => tables;
  h.ready = () => { tables.refunds[0].processTime = new Date(0); tables.refunds[0].claimTime = new Date(0); };
  h.success = () => { h.query = { returnCode: 'SUCCESS', resultCode: 'SUCCESS', refundCount: 1,
    outRefundNo0: 'RF-test', refundId0: 'WX-refund', refundFee0: 100, refundStatus0: 'SUCCESS', outTradeNo: 'ORDER-test' }; };
  return h;
}

const tests = {
  async manualFallbackHasNoEffects() {
    const h = harness(); h.tables().orders[0].transactionId = '';
    await h.run();
    assert.equal(h.tables().refunds[0].status, 'manual_review');
    assert.equal(h.tables().orders[0].status, 'refunding');
    assert.equal(h.tables().cashflow_entries.length, 0);
    assert.equal(h.tables().products[0].stock, 2);
    assert.equal(h.tables().commissions[0].status, 'frozen');
  },
  async consumerAndOperationsCannotExecute() {
    for (const role of ['consumer', 'operations', 'disabled', 'anonymous']) {
      const h = harness();
      if (role === 'consumer') h.openId = 'consumer';
      if (role === 'operations') h.tables().admin_accounts[0].role = role;
      if (role === 'disabled') h.tables().admin_accounts[0].status = 'disabled';
      if (role === 'anonymous') h.openId = '';
      assert.equal((await h.run()).success, false, role);
      assert.equal(h.queries + h.refunds, 0);
      assert.equal(h.tables().refunds[0].status, 'pending_auto');
    }
  },
  async acceptedIsNotCompleted() {
    const h = harness(); const result = await h.run();
    assert.equal(h.refunds, 1);
    assert.equal(h.tables().refunds[0].status, 'channel_processing');
    assert.equal(h.tables().orders[0].status, 'refunding');
    assert.equal(h.tables().cashflow_entries.length, 0);
    assert(!JSON.stringify(result).includes('ORDER-test'));
    h.ready(); await h.run();
    assert.equal(h.refunds, 1, 'not-found after submission cannot trigger second refund');
  },
  async timeoutNeverReissuesMoney() {
    const h = harness(); h.refund = new Error('timeout');
    await h.run(); h.ready(); await h.run();
    assert.equal(h.refunds, 1);
    assert.equal(h.tables().cashflow_entries.length, 0);
    assert.notEqual(h.tables().refunds[0].status, 'approved');
  },
  async verifiedSuccessIsAtomicAndIdempotent() {
    const h = harness(); h.success();
    const result = await h.run();
    assert.equal(result.success, true);
    assert.equal(h.refunds, 0, 'existing channel success never resubmits');
    assert.equal(h.tables().orders[0].status, 'refunded');
    assert.equal(h.tables().refunds[0].status, 'approved');
    assert.equal(h.tables().cashflow_entries.length, 1);
    assert.equal(h.tables().products[0].stock, 3);
    await h.run();
    assert.equal(h.tables().cashflow_entries.length, 1);
    assert.equal(h.tables().products[0].stock, 3);
  },
  async incompleteAndMismatchedResultsDoNotPost() {
    for (const patch of [{ refundFee0: 99 }, { outRefundNo0: 'OTHER' }, { refundStatus0: 'PROCESSING' },
      { refundStatus0: 'UNKNOWN' }, { outTradeNo: 'OTHER' }, { refundId0: '' }]) {
      const h = harness(); h.success(); Object.assign(h.query, patch);
      await h.run();
      assert.equal(h.tables().cashflow_entries.length, 0, JSON.stringify(patch));
      assert.equal(h.refunds, 0);
    }
  },
  async rollbackDoesNotLeaveRefundedOrder() {
    const h = harness(); h.success(); h.failWrite = 'inventory_adjustments';
    await h.run();
    assert.equal(h.tables().orders[0].status, 'refunding');
    assert.equal(h.tables().cashflow_entries.length, 0);
    assert.equal(h.tables().products[0].stock, 2);
    h.failWrite = ''; h.ready(); await h.run();
    assert.equal(h.tables().cashflow_entries.length, 1);
  },
  async settledCommissionCreatesReversalAndNoRestockWhenDeclined() {
    const h = harness(); h.success();
    Object.assign(h.tables().refunds[0], { type: 'return_refund', returnStatus: 'received', restock: false });
    h.tables().commissions[0].status = 'settled';
    await h.run();
    assert.equal(h.tables().products[0].stock, 2);
    assert.equal(h.tables().commissions[0].status, 'settled');
    assert.equal(h.tables().commissions[1].amount, -33);
  },
  async returnNotReceivedCannotBeProcessed() {
    const h = harness(); h.tables().refunds[0].type = 'return_refund';
    await h.run();
    assert.equal(h.queries + h.refunds, 0);
    assert.equal(h.tables().cashflow_entries.length, 0);
  },
  async concurrentWorkersOnlySubmitOnce() {
    const h = harness(); await Promise.all([h.run(), h.run()]);
    assert.equal(h.refunds, 1);
  },
  async expiredLeaseOnlyQueries() {
    const h = harness(); h.success(); h.tables().refunds[0].status = 'processing'; h.ready();
    await h.run();
    assert.equal(h.refunds, 0);
    assert.equal(h.tables().refunds[0].status, 'approved');
  },
  async legacyUncertainQueueNeverSubmits() {
    const h = harness(); delete h.tables().refunds[0].executionVersion;
    await h.run(); h.ready(); await h.run();
    assert.equal(h.refunds, 0);
    assert.equal(h.tables().refunds[0].status, 'manual_review');
  },
  async initialQueryFailureCanRecoverWithoutSecondSubmission() {
    const h = harness(); h.query = new Error('temporary query failure');
    await h.run(); assert.equal(h.refunds, 0);
    h.query = { returnCode: 'SUCCESS', resultCode: 'FAIL', errCode: 'REFUNDNOTEXIST' };
    h.ready(); await h.run(); assert.equal(h.refunds, 1);
    h.ready(); await h.run(); assert.equal(h.refunds, 1);
  },
  async paidReversalAndFrozenCancellation() {
    const h = harness(); h.success(); h.tables().commissions[0].status = 'paid';
    await h.run();
    assert.equal(h.tables().commissions[0].status, 'paid');
    assert.equal(h.tables().commissions[1].amount, -33);
    assert.equal(h.tables().orders[0].commissionStatus, 'reversed');
    const frozen = harness(); frozen.success(); await frozen.run();
    assert.equal(frozen.tables().commissions[0].status, 'cancelled');
  },
  async legacyHttpEndpointIsClosed() {
    const filename = path.join(root, 'cloudfunctions/admin-refund-http/index.js');
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      module, exports: module.exports, console,
      require: name => name === 'wx-server-sdk' ? { init() {}, database: () => ({}) } : require(name)
    }, { filename });
    for (const action of ['query', 'processRefund']) {
      const result = await module.exports.main({ httpMethod: 'POST', body: JSON.stringify({ action, refundId: 'rf', approve: true }) });
      assert.equal(result.code, 'REFUND_ENDPOINT_RETIRED');
    }
  },
  async deploymentCopiesAgree() {
    for (const file of ['refund-effects.js', 'refund-execution.js', 'wxpay-direct.js', 'payment-diagnostics.js']) {
      assert.equal(fs.readFileSync(path.join(root, 'cloudfunctions/admin', file), 'utf8'),
        fs.readFileSync(path.join(root, 'cloudfunctions/refund-processor', file), 'utf8'), file);
    }
  },
  async approvalSubmitsOnceButAcceptanceNeverPostsAndRejectCannotReverse() {
    const h = harness(); h.tables().refunds[0].status = 'pending';
    const result = await h.admin({ action: 'processRefund', refundId: 'rf', approve: true });
    assert.equal(result.success, true);
    assert.equal(result.completed, false);
    assert.equal(h.tables().refunds[0].status, 'channel_processing');
    assert.equal(h.tables().refunds[0].executionVersion, 2);
    assert.equal(h.tables().orders[0].status, 'refunding');
    assert.equal(h.refunds, 1, 'one-click approval may submit once; acceptance is not completion');
    assert.equal(h.tables().cashflow_entries.length, 0);
    assert.equal(h.tables().products[0].stock, 2);
    assert.equal(h.tables().commissions[0].status, 'frozen');
    assert.equal((await h.admin({ action: 'processRefund', refundId: 'rf', approve: false })).success, false);
    assert.equal(h.tables().orders[0].status, 'refunding');
    h.success(); h.ready(); await h.run();
    assert.equal(h.tables().orders[0].status, 'refunded');
    assert.equal(h.tables().cashflow_entries.length, 1);
    assert.equal((await h.admin({ action: 'processRefund', refundId: 'rf', approve: false })).success, false);
    await h.admin({ action: 'executeRefund', refundId: 'rf' });
    assert.equal(h.refunds, 1); assert.equal(h.tables().cashflow_entries.length, 1);
  },
  async adminTimeoutOnlyReconcilesOriginalBillAndNeverPosts() {
    const h = harness(); h.tables().refunds[0].status = 'pending'; h.refund = new Error('timeout');
    const result = await h.admin({ action: 'processRefund', refundId: 'rf', approve: true });
    assert.equal(result.completed, false); assert.equal(h.refunds, 1);
    await h.admin({ action: 'retryRefund', refundId: 'rf' });
    h.ready(); await h.run();
    assert.equal(h.refunds, 1); assert.equal(h.tables().cashflow_entries.length, 0);
    assert.equal(h.tables().orders[0].status, 'refunding');
  },
  async sharedAdminAndWorkerClaimAllowsOnlyOneSubmission() {
    const h = harness();
    await Promise.all([h.admin({ action: 'executeRefund', refundId: 'rf' }), h.run()]);
    assert.equal(h.refunds, 1); assert.equal(h.tables().cashflow_entries.length, 0);
    assert.notEqual(h.tables().refunds[0].status, 'approved');
  },
  async claimWriteFailurePreventsEveryExternalCall() {
    const h = harness(); h.failWrite = 'refunds';
    const result = await h.admin({ action: 'executeRefund', refundId: 'rf' });
    assert.equal(result.success, false); assert.equal(h.refunds + h.queries, 0);
    assert.equal(h.tables().refunds[0].status, 'pending_auto');
  },
  async explicitBalanceRefusalAllowsOperatorRetryOnOriginalChannel() {
    const h = harness(); h.refund = { returnCode: 'SUCCESS', resultCode: 'FAIL', errCode: 'NOTENOUGH' };
    await h.admin({ action: 'executeRefund', refundId: 'rf' });
    assert.equal(h.tables().refunds[0].definitiveRejected, true);
    h.ready(); await h.run(); assert.equal(h.refunds, 1, 'worker never automatically retries money');
    h.refund = { returnCode: 'SUCCESS', resultCode: 'SUCCESS', refundId: 'WX-refund' };
    // A query-only sweep must not erase the documented refusal needed by the operator.
    const result = await h.admin({ action: 'retryRefund', refundId: 'rf' });
    assert.equal(result.completed, false); assert.equal(h.refunds, 2);
    assert.equal(h.tables().refunds[0].submittedChannel, 'cloudbase');
    assert.equal(h.tables().cashflow_entries.length, 0);
  },
  async mockApprovalRollsBackAsOneTransaction() {
    const h = harness(); h.tables().refunds[0].status = 'pending';
    h.tables().orders[0].paymentSource = 'mockPay';
    h.failWrite = 'refunds';
    const result = await h.admin({ action: 'processRefund', refundId: 'rf', approve: true });
    assert.equal(result.success, false);
    assert.equal(h.tables().orders[0].status, 'refunding');
    assert.equal(h.tables().cashflow_entries.length, 0);
    assert.equal(h.tables().products[0].stock, 2);
  },
  async pendingListIncludesAllUnfinishedStates() {
    const h = harness();
    for (const status of ['pending_auto', 'processing', 'channel_processing', 'manual_review']) {
      h.tables().refunds[0].status = status;
      const result = await h.admin({ action: 'refundList', statusFilter: 'pending' });
      assert.equal(result.data.length, 1, status);
    }
  },
  async adminCommissionSettingUpdatesEffectiveRateAtomically() {
    const h = harness(); h.tables().pay_config[0].commissionRate = 0.2;
    const result = await h.admin({ action: 'setCommissionRate', commissionRate: 0.33 });
    assert.equal(result.success, true);
    assert.equal(h.tables().pay_config[0].commissionRate, 0.33);
    assert.equal(h.tables().admin_config[0].commissionRate, 0.33);
    assert.equal((await h.admin({ action: 'getSettings' })).settings.commissionRate, 0.33);
    h.failWrite = 'pay_config';
    await h.admin({ action: 'setCommissionRate', commissionRate: 0.15 });
    assert.equal(h.tables().admin_config[0].commissionRate, 0.33, 'partial config update rolls back');
  }
};

(async () => {
  let failed = 0;
  for (const [name, test] of Object.entries(tests)) {
    try { await test(); console.log('PASS', name); }
    catch (err) { failed++; console.error('FAIL', name, err.message); }
  }
  process.exitCode = failed ? 1 : 0;
})();
