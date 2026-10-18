'use strict';

const cloud = require('wx-server-sdk');
cloud.init({ env: 'cloud1-d4gx1jxk675274501' });
const db = cloud.database();
const crypto = require('crypto');
const confirmPayment = require('./payment-effects').createPaymentEffects(cloud, db);

async function recordEvent(kind, payload) {
  try {
    await db.collection('paynotify_events').add({ data: { kind, payload, time: db.serverDate() } });
  } catch (error) {
    console.warn('[payNotify] diagnostic write failed');
  }
}

function field(value, camel, snake) {
  return value[camel] === undefined ? value[snake] : value[camel];
}

// Do not trust callback-supplied SUCCESS, transaction or amounts. A server-side
// query under the order's proven original merchant is the authority, regardless of invoke SOURCE.
async function verifiedPayment(outTradeNo) {
  const orderRes = await db.collection('orders').where({ orderNo: outTradeNo }).limit(1).get();
  const order = orderRes.data && orderRes.data[0];
  if (!order) throw new Error('Order not found');
  // An old prepay ID does not prove merchant ownership. Never adopt the current
  // configuration (or caller input) for an order whose original merchant is unknown.
  const subMchId = typeof order.paymentSubMchId === 'string' ? order.paymentSubMchId.trim() : '';
  if (!subMchId) throw new Error('Original payment merchant is unproven');
  const query = await cloud.cloudPay.queryOrder({ subMchId, outTradeNo, nonceStr: crypto.randomBytes(16).toString('hex') });
  if (!query || field(query, 'returnCode', 'return_code') !== 'SUCCESS' ||
      field(query, 'resultCode', 'result_code') !== 'SUCCESS' ||
      field(query, 'tradeState', 'trade_state') !== 'SUCCESS') throw new Error('Payment is not confirmed');
  const transactionId = String(field(query, 'transactionId', 'transaction_id') || '').trim();
  const queryOrderNo = String(field(query, 'outTradeNo', 'out_trade_no') || '').trim();
  const queryMerchant = String(field(query, 'subMchId', 'sub_mch_id') || '').trim();
  const rawFee = field(query, 'totalFee', 'total_fee');
  const totalFee = rawFee === undefined || rawFee === null || rawFee === '' ? NaN : Number(rawFee);
  if (!transactionId || queryOrderNo !== outTradeNo || queryMerchant !== subMchId ||
      !Number.isSafeInteger(totalFee) || totalFee <= 0 || totalFee !== Number(order.totalFee)) {
    throw new Error('Payment query association mismatch');
  }
  // Service-provider OPENID belongs to a different app. Only sub_openid is
  // comparable with this Mini Program's order.userId; never compare query.openid.
  const payerOpenId = String(field(query, 'subOpenid', 'sub_openid') || '');
  if (payerOpenId && payerOpenId !== order.userId) throw new Error('Payment payer mismatch');
  if (order.transactionId && order.transactionId !== transactionId) throw new Error('Payment transaction mismatch');
  return { order, transactionId, totalFee, payerOpenId, subMchId };
}

async function canSync(openId) {
  if (!openId) return false;
  const result = await db.collection('admin_accounts')
    .where({ wechatOpenId: openId, status: 'active' }).limit(1).get();
  const account = result.data && result.data[0];
  return !!(account && ['owner', 'finance'].includes(account.role));
}

exports.main = async (event = {}) => {
  const maintenance = event.action === 'syncTransaction';
  try {
    if (event.action && !maintenance) return { success: false, error: 'Unknown action' };
    if (maintenance && !await canSync(cloud.getWXContext().OPENID)) {
      return { success: false, error: 'Forbidden', code: 'FORBIDDEN' };
    }
    const outTradeNo = String(event.outTradeNo || event.out_trade_no || '').trim();
    if (!outTradeNo) throw new Error('Missing order number');
    if (!maintenance && (field(event, 'returnCode', 'return_code') !== 'SUCCESS' ||
        field(event, 'resultCode', 'result_code') !== 'SUCCESS')) {
      return { errcode: 0, errmsg: 'Payment not successful; no effects' };
    }
    const verified = await verifiedPayment(outTradeNo);
    if (maintenance) {
      await db.collection('orders').doc(verified.order._id).update({
        data: { transactionId: verified.transactionId, updateTime: db.serverDate() }
      });
      return { success: true, transactionId: verified.transactionId };
    }
    const result = await confirmPayment({ outTradeNo, transactionId: verified.transactionId,
      totalFee: verified.totalFee, payerOpenId: verified.payerOpenId, subMchId: verified.subMchId, source: 'payNotify' });
    await recordEvent('processed', { outTradeNo, orderId: result.orderId });
    return { errcode: 0, errmsg: 'success' };
  } catch (error) {
    await recordEvent('rejected', { outTradeNo: String(event.outTradeNo || event.out_trade_no || ''),
      error: String(error && error.message || error) });
    return maintenance ? { success: false, error: 'Authoritative payment verification failed' }
      : { errcode: 1, errmsg: 'Payment verification failed; retry or reconcile original order' };
  }
};
