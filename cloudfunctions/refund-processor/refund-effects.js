'use strict';

const crypto = require('crypto');

// Scan before writing reversals: adding ledger rows cannot shift this immutable _id cursor.
async function commissionPlan(transaction, db, order, refund, callerReadOperations) {
  const rows = [];
  let cursor = '', pages = 0;
  for (;;) {
    const query = cursor ? { orderId: order._id, _id: db.command.gt(cursor) } : { orderId: order._id };
    const result = await transaction.collection('commissions').where(query).orderBy('_id', 'asc').limit(100).get();
    pages++;
    if (!result || !Array.isArray(result.data)) throw new Error('Commission scan incomplete');
    for (const row of result.data) {
      if (typeof row._id !== 'string' || !row._id || row._id <= cursor) throw new Error('Commission cursor invalid');
      cursor = row._id;
      rows.push(row);
    }
    if (rows.length > 2000) throw new Error('Commission scan exceeds safe transaction capacity');
    if (result.data.length < 100) break;
  }
  const add = (a, b) => {
    if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || !Number.isSafeInteger(a + b)) throw new Error('Commission amount invalid');
    return a + b;
  };
  let earned = 0;
  const frozen = [];
  const prefix = 'commission_refund:' + refund._id + ':';
  const groups = new Map(['settled', 'paid', 'withdrawing'].map(status => [status, { status, sources: [], earned: 0, reversed: 0 }]));
  const sources = new Map();
  for (const row of rows) {
    if (!Number.isSafeInteger(row.amount) || row.agentId !== order.agentId) throw new Error('Commission ledger mismatch');
    if (row.type === 'reversal') continue;
    if (row.amount < 0) throw new Error('Earning amount invalid');
    if (row.status === 'frozen') frozen.push(row);
    else if (groups.has(row.status)) {
      const group = groups.get(row.status);
      group.earned = add(group.earned, row.amount);
      earned = add(earned, row.amount);
      group.sources.push(row);
      sources.set(row._id, row);
    } else if (row.status !== 'cancelled') throw new Error('Unknown commission status');
  }
  const prior = rows.filter(item => item.type === 'reversal');
  const keys = new Set();
  const covered = new Map();
  for (const row of prior) {
    if (row.amount >= 0 || row.status !== 'settled' || !String(row.idempotencyKey || '').startsWith(prefix) || keys.has(row.idempotencyKey)) throw new Error('Existing refund reversal requires reconciliation');
    keys.add(row.idempotencyKey);
  }
  // Legacy individual adjustments must prove their own source, not just a group total.
  for (const row of prior.filter(item => item.sourceCommissionId !== undefined)) {
    const source = sources.get(row.sourceCommissionId);
    if (!source || row.idempotencyKey !== prefix + source._id ||
        row.sourceStatus !== undefined && row.sourceStatus !== source.status) throw new Error('Existing refund reversal source unverified');
    const amount = add(covered.get(source._id) || 0, -row.amount);
    if (amount > source.amount) throw new Error('Individual source already over-reversed');
    covered.set(source._id, amount);
    const group = groups.get(source.status);
    group.reversed = add(group.reversed, -row.amount);
  }
  // A v2 aggregate is valid only as the remainder after proven individual subsets.
  for (const row of prior.filter(item => item.sourceCommissionId === undefined)) {
    const group = groups.get(row.sourceStatus);
    if (!group) throw new Error('Existing refund aggregate status unverified');
    const ids = group.sources.map(source => source._id);
    const digest = crypto.createHash('sha256').update(JSON.stringify(group.sources.map(source => [source._id, source.amount]))).digest('hex');
    if (row.reversalVersion !== 2 || row.source !== 'refund' || row.refundId !== refund._id ||
        row.idempotencyKey !== prefix + 'aggregate:' + group.status ||
        !Array.isArray(row.sourceCommissionIds) || row.sourceCommissionCount !== ids.length ||
        JSON.stringify(row.sourceCommissionIds) !== JSON.stringify(ids) || row.sourceCommissionDigest !== digest ||
        row.sourceAmountTotal !== group.earned || row.priorReversedAmount !== group.reversed ||
        -row.amount !== group.earned - group.reversed) throw new Error('Existing refund aggregate provenance unverified');
    for (const source of group.sources) covered.set(source._id, source.amount);
    group.reversed = group.earned;
  }
  const reversals = [];
  for (const group of groups.values()) {
    if (group.reversed > group.earned) throw new Error('Refund commission already exceeds earning');
    if (group.earned === group.reversed) continue;
    reversals.push({ status: group.status, delta: group.earned - group.reversed,
      sourceCount: group.sources.length, sourceIds: group.sources.map(row => row._id),
      sourceDigest: crypto.createHash('sha256').update(JSON.stringify(group.sources.map(row => [row._id, row.amount]))).digest('hex'),
      earned: group.earned, reversed: group.reversed });
  }
  // At most three status aggregates preserve paid/held/available audit meaning.
  // Leave conservative headroom for caller refund reads/writes and inventory journal operations.
  const productCount = new Set((order.items || []).map(item => item.productId)).size;
  if (12 + callerReadOperations + pages + frozen.length + reversals.length + productCount * 3 > 90) throw new Error('Refund exceeds safe transaction operation capacity');
  const user = (await transaction.collection('users').doc(order.agentId).get()).data;
  if (!user) throw new Error('Commission agent missing');
  return { frozen, reversals, hasReversal: earned > 0 };

}

// Domain stock exceptions are returned explicitly; database errors always propagate.
async function planRestock(transaction, order, requested) {
  if (order.inventoryRefunded) return { status: 'completed', updates: [] };
  if (!requested || ['released', 'reserved'].includes(order.inventoryStatus)) return { status: 'not_required', updates: [] };
  if (order.inventoryStatus !== 'committed') return { status: 'pending_exception', error: 'Inventory deduction is not verified', updates: [] };
  if (!Array.isArray(order.items) || !order.items.length) return { status: 'pending_exception', error: 'No order items to restore', updates: [] };
  const products = new Map();
  for (const item of order.items || []) {
    const quantity = Number(item.quantity);
    if (!Number.isSafeInteger(quantity) || quantity <= 0) return { status: 'pending_exception', error: 'Refund stock quantity invalid', updates: [] };
    let update = products.get(item.productId);
    if (!update) {
      const found = await transaction.collection('products').where({ _id: item.productId }).limit(1).get();
      const product = found.data && found.data[0];
      if (!product) return { status: 'pending_exception', error: 'Refund product missing', updates: [] };
      update = { product, specs: (product.specs || []).map(spec => ({ ...spec })), quantity: 0, items: [] };
      products.set(item.productId, update);
    }
    const index = update.specs.findIndex(spec => spec.name === item.spec);
    if ((update.specs.length || item.spec) && index < 0) return { status: 'pending_exception', error: 'Refund SKU missing: ' + String(item.spec || ''), updates: [] };
    update.quantity += quantity;
    if (!Number.isSafeInteger(update.quantity)) return { status: 'pending_exception', error: 'Refund stock overflow', updates: [] };
    if (index >= 0) {
      const next = Number(update.specs[index].stock) + quantity;
      if (!Number.isSafeInteger(next) || next < 0) return { status: 'pending_exception', error: 'Refund SKU stock invalid', updates: [] };
      update.specs[index].stock = next;
    }
    update.items.push({ spec: item.spec || '', quantity });
  }
  for (const update of products.values()) {
    update.stock = Number(update.product.stock) + update.quantity;
    if (!Number.isSafeInteger(update.stock) || update.stock < 0) return { status: 'pending_exception', error: 'Refund product stock invalid', updates: [] };
  }
  return { status: 'completed', updates: [...products.values()] };
}

exports.planRestock = planRestock;

// Keep deployable copies identical. Financial completion and stock exception state are separate.
exports.applyRefundEffects = async (transaction, db, order, refund, shouldRestock, callerReadOperations = 0) => {
  if (!Number.isSafeInteger(callerReadOperations) || callerReadOperations < 0) throw new Error('Invalid caller transaction budget');
  const latestOrder = (await transaction.collection('orders').doc(order._id).get()).data;
  if (!latestOrder) throw new Error('Associated order missing');
  if (latestOrder.refundId && latestOrder.refundId !== refund._id) throw new Error('Order refund mismatch');
  if (!Number.isSafeInteger(latestOrder.totalFee) || latestOrder.totalFee <= 0) throw new Error('Refund amount invalid');
  const productCount = new Set((latestOrder.items || []).map(item => item.productId)).size;
  if (12 + callerReadOperations + productCount * 3 > 90) throw new Error('Refund exceeds safe transaction operation capacity');
  const alreadyRefunded = latestOrder.status === 'refunded';
  const commissions = !alreadyRefunded && latestOrder.agentId ? await commissionPlan(transaction, db, latestOrder, refund, callerReadOperations) : null;
  const refundKey = 'refund:' + latestOrder._id;
  const existing = await transaction.collection('cashflow_entries').where({ idempotencyKey: refundKey }).get();
  if (alreadyRefunded) {
    if ((existing.data || []).length !== 1 || !existing.data.some(entry => entry.refundId === refund._id &&
        entry.orderId === latestOrder._id && entry.type === 'refund' && entry.direction === 'out' &&
        entry.status === 'posted' && entry.amount === latestOrder.totalFee)) {
      throw new Error('Historical financial refund mismatch; do not auto-correct ledger');
    }
  } else {
    if (latestOrder.status !== 'refunding') throw new Error('Order is not refunding');
    if ((existing.data || []).length) throw new Error('Refund ledger and order state conflict');
    await transaction.collection('cashflow_entries').add({ data: {
      idempotencyKey: refundKey, type: 'refund', direction: 'out', amount: latestOrder.totalFee,
      orderId: latestOrder._id, orderNo: latestOrder.orderNo, refundId: refund._id,
      source: latestOrder.paymentSource || 'payment', status: 'posted', createTime: db.serverDate()
    } });
  }
  const hasReversal = !!(commissions && commissions.hasReversal);
  if (commissions) {
    for (const row of commissions.frozen) await transaction.collection('commissions').doc(row._id).update({ data: {
      status: 'cancelled', cancelReason: 'order_refund', cancelTime: db.serverDate()
    } });
    for (const reversal of commissions.reversals) await transaction.collection('commissions').add({ data: {
      idempotencyKey: 'commission_refund:' + refund._id + ':aggregate:' + reversal.status, type: 'reversal',
      agentId: latestOrder.agentId, orderId: latestOrder._id, orderNo: latestOrder.orderNo,
      amount: -reversal.delta, rate: 0, status: 'settled', refundId: refund._id,
      source: 'refund', sourceStatus: reversal.status, sourceCommissionCount: reversal.sourceCount, reversalVersion: 2,
      sourceCommissionIds: reversal.sourceIds, sourceCommissionDigest: reversal.sourceDigest,
      sourceAmountTotal: reversal.earned, priorReversedAmount: reversal.reversed,
      createTime: db.serverDate(), settleTime: db.serverDate()
    } });
    // All deductions and withdrawal reservations contend on the same agent document.
    await transaction.collection('users').doc(latestOrder.agentId).update({ data: {
      withdrawalVersion: db.command.inc(1), updateTime: db.serverDate()
    } });
  }
  const plan = await planRestock(transaction, latestOrder, shouldRestock);
  for (const update of plan.updates) {
    await transaction.collection('products').doc(update.product._id).update({ data: {
      stock: update.stock, sales: Math.max(0, (Number(update.product.sales) || 0) - update.quantity),
      specs: update.specs, updateTime: db.serverDate()
    } });
    const journalKey = 'refundstock:' + refund._id + ':' + update.product._id;
    await transaction.collection('inventory_adjustments').add({ data: {
      _id: crypto.createHash('sha256').update(journalKey).digest('hex').slice(0, 32), idempotencyKey: journalKey,
      productId: update.product._id, productName: update.product.name || '',
      spec: update.items.map(item => item.spec).join(' / '), quantity: update.quantity,
      beforeStock: Number(update.product.stock) || 0, afterStock: update.stock,
      reason: 'Refund stock return', orderId: latestOrder._id, operatorId: 'refund:' + refund._id,
      createTime: db.serverDate()
    } });
  }
  const data = {
    status: 'refunded', inventoryRefunded: !!(latestOrder.inventoryRefunded || (shouldRestock && plan.status === 'completed')),
    inventoryRestockStatus: plan.status, inventoryRestockError: plan.error || '',
    refundTime: latestOrder.refundTime || db.serverDate(), updateTime: db.serverDate()
  };
  if (!alreadyRefunded) data.commissionStatus = latestOrder.agentId ? (hasReversal ? 'reversed' : 'cancelled') : 'none';
  await transaction.collection('orders').doc(latestOrder._id).update({ data });
  return { inventoryRestockStatus: plan.status, inventoryRestockError: plan.error || '' };
};
