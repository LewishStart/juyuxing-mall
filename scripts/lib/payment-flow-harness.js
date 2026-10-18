'use strict';
require('./payment-test-network');

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');

const root = path.resolve(__dirname, '../..');
const clone = value => value === undefined ? undefined : structuredClone(value);

function createHarness() {
  let tables = {
    admin_config: [{ _id: 'admin', openId: 'test-owner' }],
    admin_accounts: [{ _id: 'owner', role: 'owner', status: 'active', wechatOpenId: 'test-owner' }],
    users: [{ _id: 'test-agent', isAgent: true, referralCode: 'TEST', agentInfo: { status: 'active' } }],
    commissions: [{ _id: 'commission', agentId: 'test-agent', orderId: 'order', orderNo: 'TEST-ORDER',
      type: 'earning', amount: 500, status: 'settled', settleTime: new Date(0) }],
    orders: [{ _id: 'order', userId: 'test-buyer', agentId: 'test-agent', orderNo: 'TEST-ORDER',
      totalFee: 1500, transactionId: 'TEST-TX', status: 'received', payTime: new Date(), items: [] }],
    withdrawals: [], cashflow_entries: [], refunds: [], inventory_adjustments: [], products: [],
    pay_config: [{ _id: 'default', subMchId: 'test-merchant' }]
  };
  const h = { openId: 'test-agent', failWrite: '', transferCalls: [], queryCalls: [], logs: [],
    transfer: { state: 'WAIT_USER_CONFIRM', packageInfo: 'PRIVATE-PACKAGE', transferBillNo: 'TEST-TRANSFER' },
    bill: { state: 'WAIT_USER_CONFIRM' }, refundCalls: 0, refundQueries: 0 };
  let nextId = 0;
  const op = (kind, value) => ({ _op: kind, value });
  const command = Object.fromEntries(['in', 'neq', 'eq', 'lt', 'lte', 'gt', 'gte', 'inc'].map(kind => [kind, value => op(kind, value)]));
  const matches = (row, filter) => Object.entries(filter).every(([key, value]) => {
    const actual = key.split('.').reduce((o, k) => o && o[k], row);
    if (!value || !value._op) return actual === value;
    switch (value._op) {
      case 'in': return value.value.includes(actual);
      case 'neq': return actual !== value.value;
      case 'eq': return actual === value.value;
      case 'lt': return actual < value.value;
      case 'lte': return actual <= value.value;
      case 'gt': return actual > value.value;
      case 'gte': return actual >= value.value;
      default: throw new Error('Unsupported test query operator');
    }
  });
  const write = (name, data) => { if (h.failWrite === name || h.failWhen && h.failWhen(name, data)) throw new Error('forced ' + name + ' failure'); };
  const updateRow = (row, data) => {
    for (const [key, value] of Object.entries(data)) {
      const parts = key.split('.'); const last = parts.pop(); let target = row;
      for (const part of parts) target = target[part] ||= {};
      target[last] = value && value._op === 'inc' ? (Number(target[last]) || 0) + value.value : clone(value);
    }
  };
  function collection(name, filter = {}, limit = 1000, skip = 0, order = null) {
    const rows = () => (tables[name] || []).filter(row => matches(row, filter));
    const q = {
      where: f => collection(name, { ...filter, ...f }, limit, skip, order),
      limit: n => collection(name, filter, n, skip, order),
      skip: n => collection(name, filter, limit, n, order),
      orderBy: (key, direction) => collection(name, filter, limit, skip, [key, direction]),
      get: async () => {
        const list = rows();
        if (order) list.sort((a, b) => (a[order[0]] < b[order[0]] ? -1 : a[order[0]] > b[order[0]] ? 1 : 0) * (order[1] === 'desc' ? -1 : 1));
        return { data: clone(list.slice(skip, skip + limit)) };
      },
      count: async () => ({ total: rows().length }),
      update: async ({ data }) => {
        write(name, data); const selected = rows(); selected.forEach(row => updateRow(row, data));
        return { stats: { updated: selected.length }, updated: selected.length };
      },
      add: async ({ data }) => {
        write(name, data); const id = data._id || 'fixture-' + (++nextId);
        if ((tables[name] || []).some(row => row._id === id)) throw new Error('duplicate fixture id');
        (tables[name] ||= []).push({ _id: id, ...clone(data) }); return { _id: id };
      },
      doc: id => ({
        get: async () => ({ data: clone((tables[name] || []).find(row => row._id === id)) }),
        update: args => collection(name, { _id: id }).update(args),
        set: async ({ data }) => {
          write(name, data); const old = (tables[name] || []).find(row => row._id === id);
          if (old) Object.assign(old, clone(data)); else (tables[name] ||= []).push({ _id: id, ...clone(data) });
          return { _id: id };
        }
      })
    };
    return q;
  }
  let lock = Promise.resolve();
  const db = { collection, command, serverDate: () => new Date(), runTransaction: callback => {
    const task = lock.then(async () => {
      const before = clone(tables);
      try { return await callback(db); } catch (error) { tables = before; throw error; }
    });
    lock = task.catch(() => {}); return task;
  } };
  const transfer = {
    genOutBillNo: () => 'TEST-BILL-' + (++nextId),
    getTransferClientConfig: () => ({ mchId: 'test-merchant', appId: 'test-app' }),
    isBillNotExistError: error => error && error.code === 'NOT_FOUND',
    initiateTransfer: async params => {
      h.transferCalls.push(clone(params));
      if (h.beforeTransfer) await h.beforeTransfer(params);
      if (h.transfer instanceof Error) throw h.transfer;
      return { ...clone(h.transfer), outBillNo: params.outBillNo };
    },
    queryBill: async billNo => {
      h.queryCalls.push(billNo); if (h.bill instanceof Error) throw h.bill; return clone(h.bill);
    }
  };
  const cloud = { init() {}, database: () => db, getWXContext: () => ({ OPENID: h.openId }),
    cloudPay: {
      refund: async () => { h.refundCalls++; return { returnCode: 'SUCCESS', resultCode: 'SUCCESS', refundId: 'TEST-REFUND' }; },
      queryRefund: async () => { h.refundQueries++; return clone(h.refundQuery || { returnCode: 'SUCCESS', resultCode: 'FAIL', errCode: 'REFUNDNOTEXIST' }); }
    } };
  const cache = new Map();
  const logger = Object.fromEntries(['log', 'warn', 'error'].map(level => [level, (...args) => h.logs.push(args.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '))]));
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename).exports;
    const mod = { exports: {} }; cache.set(filename, mod);
    const realRequire = createRequire(filename);
    const localRequire = name => {
      if (name === 'wx-server-sdk') return cloud;
      if (name === 'https' && h.httpsAdapter) return h.httpsAdapter;
      if (name === './wxpay-transfer') return transfer;
      if (name === './wxpay-direct' && h.directAdapter) return { ...load(realRequire.resolve(name)), ...h.directAdapter };
      if (name.startsWith('.')) return load(realRequire.resolve(name));
      return realRequire(name);
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module: mod, exports: mod.exports,
      require: localRequire, console: logger, process: { ...process, env: { ...process.env, ...h.env } }, Buffer, URL, setTimeout, clearTimeout }, { filename });
    return mod.exports;
  }
  h.call = (name, data = {}, openId = 'test-owner') => {
    h.openId = openId;
    return load(path.join(root, 'cloudfunctions', name, 'index.js')).main(data);
  };
  h.apply = () => h.call('withdrawal', { action: 'apply', amount: 100, name: 'Test Agent', account: 'test', requestId: 'test-request-0001' }, 'test-agent');
  h.approve = id => h.call('admin', { action: 'processWithdrawal', withdrawalId: id, approve: true });
  h.tables = () => tables; h.db = db; h.load = load; h.root = root;
  return h;
}

module.exports = { createHarness };
