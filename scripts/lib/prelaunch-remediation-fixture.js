// Isolated application fixture: real modules, synthetic identities, serial snapshot transactions.
// This fixture does not establish CloudBase concurrency, operation limits or live authorization.
'use strict';
require('./payment-test-network');

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');

const root = path.resolve(__dirname, '../..');
const clone = value => value === undefined ? undefined : structuredClone(value);

function createHarness(options = {}) {
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
  const h = { defaultQueryLimit: 100, ...options, openId: 'test-agent', failWrite: '', transferCalls: [], queryCalls: [], logs: [],
    transfer: { state: 'WAIT_USER_CONFIRM', packageInfo: 'PRIVATE-PACKAGE', transferBillNo: 'TEST-TRANSFER' },
    bill: { state: 'WAIT_USER_CONFIRM' }, refundCalls: 0, refundQueries: 0 };
  let nextId = 0;
  const op = (kind, value) => ({ _op: kind, value });
  const command = Object.fromEntries(['in', 'neq', 'eq', 'lt', 'lte', 'gt', 'gte', 'inc', 'elemMatch'].map(kind => [kind, value => op(kind, value)]));
  command.set = value => value; // full-field replacement in this fixture
  const pathValues = (value, parts) => {
    if (!parts.length) return [value];
    if (Array.isArray(value)) return value.flatMap(item => pathValues(item, parts));
    return pathValues(value && value[parts[0]], parts.slice(1));
  };
  const matches = (row, filter) => Object.entries(filter).every(([key, value]) => {
    const values = pathValues(row, key.split('.'));
    const one = actual => {
      if (!value || !value._op) return actual === value;
      switch (value._op) {
        case 'in': return value.value.includes(actual);
        case 'neq': return actual !== value.value;
        case 'eq': return actual === value.value;
        case 'lt': return actual < value.value;
        case 'lte': return actual <= value.value;
        case 'gt': return actual > value.value;
        case 'gte': return actual >= value.value;
        case 'elemMatch': return Array.isArray(actual) && actual.some(item => matches(item, value.value));
        default: throw new Error('Unsupported test query operator');
      }
    };
    return value && value._op === 'neq' ? values.every(one) : values.some(one);
  });
  const write = (name, data) => { if (h.failWrite === name || h.failWhen && h.failWhen(name, data)) throw new Error('forced ' + name + ' failure'); };
  const updateRow = (row, data) => {
    for (const [key, value] of Object.entries(data)) {
      const parts = key.split('.'); const last = parts.pop(); let target = row;
      for (const part of parts) target = target[part] ||= {};
      target[last] = value && value._op === 'inc' ? (Number(target[last]) || 0) + value.value : clone(value);
    }
  };
  function collection(name, filter = {}, limit = h.defaultQueryLimit || 1000, skip = 0, order = null) {
    const rows = () => {
      if (h.failRead === name) throw new Error('forced ' + name + ' read failure');
      return (tables[name] || []).filter(row => matches(row, filter));
    };
    const q = {
      where: f => collection(name, { ...filter, ...f }, limit, skip, order),
      limit: n => collection(name, filter, n, skip, order),
      skip: n => collection(name, filter, limit, n, order),
      orderBy: (key, direction) => collection(name, filter, limit, skip, [key, direction]),
      get: async () => {
        const list = rows();
        if (order) list.sort((a, b) => (a[order[0]] < b[order[0]] ? -1 : a[order[0]] > b[order[0]] ? 1 : 0) * (order[1] === 'desc' ? -1 : 1));
        const result = { data: clone(list.slice(skip, skip + limit)) };
        if (h.afterRead) await h.afterRead(name, filter, result);
        return result;
      },
      count: async () => ({ total: rows().length }),
      update: async ({ data }) => {
        if (h.beforeWrite) await h.beforeWrite(name, filter, data);
        write(name, data); const selected = rows(); selected.forEach(row => updateRow(row, data));
        return { stats: { updated: selected.length }, updated: selected.length };
      },
      add: async ({ data }) => {
        write(name, data); const id = data._id || 'fixture-' + (++nextId);
        if ((tables[name] || []).some(row => row._id === id)) throw new Error('duplicate fixture id');
        (tables[name] ||= []).push({ _id: id, ...clone(data) }); return { _id: id };
      },
      remove: async () => { const selected=rows(); write(name, {}); tables[name]=(tables[name] || []).filter(row=>!selected.includes(row)); return { stats: { removed: selected.length } }; },
      doc: id => ({
        get: async () => { const result = { data: clone((tables[name] || []).find(row => row._id === id)) }; if (h.afterRead) await h.afterRead(name, { _id: id }, result); return result; },
        update: args => collection(name, { _id: id }).update(args),
        remove: () => collection(name, { _id: id }).remove(),
        set: async ({ data }) => {
          write(name, data);
          const rows = tables[name] ||= [];
          const index = rows.findIndex(row => row._id === id);
          const replacement = { ...clone(data), _id: id };
          if (index >= 0) rows[index] = replacement; else rows.push(replacement);
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
  const cloud = { init() {}, database: () => db, getWXContext: () => ({ OPENID: h.openId, ...h.wxContext }),
    cloudPay: {
      queryOrder: async params => { (h.paymentQueries ||= []).push(clone(params)); if (h.paymentQuery instanceof Error) throw h.paymentQuery; return clone(h.paymentQuery || { returnCode: 'SUCCESS', resultCode: 'SUCCESS', tradeState: 'NOTPAY' }); },
      closeOrder: async params => { (h.paymentCloses ||= []).push(clone(params)); if (h.paymentClose instanceof Error) throw h.paymentClose; return clone(h.paymentClose || { returnCode: 'SUCCESS', resultCode: 'SUCCESS' }); },
      refund: async params => { h.refundCalls++; (h.refundParams ||= []).push(clone(params)); if (h.beforeRefund) await h.beforeRefund(params); if (h.refundResult instanceof Error) throw h.refundResult; return clone(h.refundResult || { returnCode: 'SUCCESS', resultCode: 'SUCCESS', refundId: 'TEST-REFUND' }); },
      queryRefund: async params => { h.refundQueries++; if (h.beforeQuery) await h.beforeQuery(params); if (h.refundQuery instanceof Error) throw h.refundQuery; return clone(h.refundQuery || { returnCode: 'SUCCESS', resultCode: 'FAIL', errCode: 'REFUNDNOTEXIST' }); }
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
      // H injects the actual response-verifying client with synthetic transport/keys.
      // Other cases retain the explicit state-machine fake; neither permits real I/O.
      if (name === './wxpay-transfer') return h.transferClient || transfer;
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
  h.cloud = cloud; h.tables = () => tables; h.db = db; h.load = load; h.root = root;
  return h;
}

module.exports = { createHarness };
