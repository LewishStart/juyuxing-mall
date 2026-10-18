'use strict';

// Keep the deployable copy in admin/refund-effects.js identical (checked by tests).
exports.applyRefundEffects = async (transaction, db, order, refund, shouldRestock) => {
  const latestOrder = (await transaction.collection('orders').doc(order._id).get()).data;
  if (!latestOrder) throw new Error('关联订单不存在');
  if (latestOrder.refundId && latestOrder.refundId !== refund._id) throw new Error('订单关联退款不匹配');
  if (!Number.isSafeInteger(latestOrder.totalFee) || latestOrder.totalFee <= 0) throw new Error('退款金额无效');
  const refundKey = 'refund:' + latestOrder._id;
  const existing = await transaction.collection('cashflow_entries').where({ idempotencyKey: refundKey }).get();
  if (latestOrder.status === 'refunded') {
    if (!(existing.data || []).some(entry => entry.refundId === refund._id && entry.amount === latestOrder.totalFee)) {
      throw new Error('历史退款账务不一致，需人工核对');
    }
    return;
  }
  if (latestOrder.status !== 'refunding') throw new Error('订单不在售后处理中');
  if ((existing.data || []).length) throw new Error('退款流水与订单状态不一致，需人工核对');
  await transaction.collection('cashflow_entries').add({ data: {
    idempotencyKey: refundKey, type: 'refund', direction: 'out', amount: latestOrder.totalFee,
    orderId: latestOrder._id, orderNo: latestOrder.orderNo, refundId: refund._id,
    source: latestOrder.paymentSource || 'payment', status: 'posted', createTime: db.serverDate()
  } });

  let hasReversal = false;
  if (latestOrder.agentId) {
    const commissions = await transaction.collection('commissions').where({ orderId: latestOrder._id }).get();
    for (const commission of commissions.data || []) {
      if (commission.type === 'reversal') continue;
      if (commission.status === 'frozen') {
        await transaction.collection('commissions').doc(commission._id).update({ data: {
          status: 'cancelled', cancelReason: 'order_refund', cancelTime: db.serverDate()
        } });
      } else if (['settled', 'paid', 'withdrawing'].includes(commission.status)) {
        hasReversal = true;
        const reversalKey = 'commission_refund:' + refund._id + ':' + commission._id;
        const exists = await transaction.collection('commissions').where({ idempotencyKey: reversalKey }).count();
        if (!exists.total) await transaction.collection('commissions').add({ data: {
          idempotencyKey: reversalKey, type: 'reversal', agentId: commission.agentId,
          orderId: latestOrder._id, orderNo: latestOrder.orderNo,
          amount: -Math.abs(Number(commission.amount) || 0), rate: commission.rate || 0,
          status: 'settled', createTime: db.serverDate(), settleTime: db.serverDate(),
          source: 'refund', sourceCommissionId: commission._id
        } });
      }
    }
  }
  if (shouldRestock && !latestOrder.inventoryRefunded) {
    for (const item of latestOrder.items || []) {
      const product = (await transaction.collection('products').doc(item.productId).get()).data;
      if (!product) throw new Error('退款商品不存在，需人工核对库存');
      const quantity = Number(item.quantity);
      if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new Error('退款库存数量无效');
      const specs = Array.isArray(product.specs) ? product.specs.map(spec => ({ ...spec })) : [];
      const index = specs.findIndex(spec => spec.name === item.spec);
      if (specs.length && index < 0) throw new Error('退款规格不存在，需人工核对库存');
      if (index >= 0) specs[index].stock = (Number(specs[index].stock) || 0) + quantity;
      await transaction.collection('products').doc(product._id).update({ data: {
        stock: (Number(product.stock) || 0) + quantity,
        sales: Math.max(0, (Number(product.sales) || 0) - quantity),
        specs, updateTime: db.serverDate()
      } });
      await transaction.collection('inventory_adjustments').add({ data: {
        productId: product._id, productName: product.name || '', spec: item.spec || '', quantity,
        beforeStock: Number(product.stock) || 0, afterStock: (Number(product.stock) || 0) + quantity,
        reason: '售后退款回库', orderId: latestOrder._id, operatorId: 'refund:' + refund._id,
        createTime: db.serverDate()
      } });
    }
  }
  await transaction.collection('orders').doc(latestOrder._id).update({ data: {
    status: 'refunded',
    commissionStatus: latestOrder.agentId ? (hasReversal ? 'reversed' : 'cancelled') : 'none',
    inventoryRefunded: !!(latestOrder.inventoryRefunded || shouldRestock),
    refundTime: db.serverDate(), updateTime: db.serverDate()
  } });
};
