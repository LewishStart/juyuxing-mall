'use strict';

const cloud = require('wx-server-sdk');
cloud.init({ env: 'cloud1-d4gx1jxk675274501' });
const db = cloud.database();
const confirmPayment = require('./payment-effects').createPaymentEffects(cloud, db);

// 回调事件留痕：真实回调格式/失败原因落库，便于诊断（集合自动创建，写入失败不阻断主流程）
async function recordEvent(kind, payload) {
  try {
    await db.collection('paynotify_events').add({ data: { kind, payload, time: db.serverDate() } });
  } catch (err) {
    try {
      await db.createCollection('paynotify_events');
      await db.collection('paynotify_events').add({ data: { kind, payload, time: db.serverDate() } });
    } catch (e) {}
  }
}

function generateNonceStr(length = 32) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let str = '';
  for (let i = 0; i < length; i++) str += chars.charAt(Math.floor(Math.random() * chars.length));
  return str;
}

exports.main = async (event) => {
  // ===== 维护入口（微信回调不带 action 字段）：从微信侧同步订单真实交易单号 =====
  if (event && event.action === 'syncTransaction') {
    const outTradeNo = String(event.outTradeNo || '').trim();
    if (!outTradeNo) return { success: false, error: '缺少订单号' };
    const cfgRes = await db.collection('pay_config').doc('default').get().catch(() => null);
    const subMchId = String((cfgRes && cfgRes.data && cfgRes.data.subMchId) || '').trim();
    if (!subMchId) return { success: false, error: '未配置商户号' };
    const query = await cloud.cloudPay.queryOrder({
      subMchId, outTradeNo, nonceStr: generateNonceStr()
    }).catch(err => ({ __error: String(err && (err.errMsg || err.message || err)) }));
    if (query.__error) return { success: false, error: query.__error };
    const tradeState = query.tradeState || query.trade_state || '';
    if (tradeState !== 'SUCCESS') return { success: false, error: '微信侧交易状态: ' + tradeState };
    const transactionId = query.transactionId || query.transaction_id || '';
    const orderRes = await db.collection('orders').where({ orderNo: outTradeNo }).limit(1).get().catch(() => ({ data: [] }));
    const order = orderRes.data && orderRes.data[0];
    if (!order) return { success: false, error: '订单不存在' };
    await db.collection('orders').doc(order._id).update({
      data: { transactionId: transactionId || order.transactionId || '', updateTime: db.serverDate() }
    });
    return { success: true, transactionId };
  }

  const outTradeNo = event.out_trade_no || event.outTradeNo || '';
  const transactionId = event.transaction_id || event.transactionId || '';
  // 服务商模式：event.openid 是微信支付平台侧标识，event.subOpenid 才是本小程序侧用户标识（与订单 userId 同源）
  const payerOpenId = event.subOpenid || event.sub_openid || '';
  const totalFeeValue = event.total_fee === undefined ? event.totalFee : event.total_fee;
  const totalFee = totalFeeValue === undefined || totalFeeValue === null || totalFeeValue === ''
    ? null
    : Number(totalFeeValue);
  const resultCode = event.result_code || event.resultCode || '';
  const returnCode = event.return_code || event.returnCode || '';

  if (returnCode !== 'SUCCESS' || resultCode !== 'SUCCESS') {
    await recordEvent('skipped', { outTradeNo, returnCode, resultCode });
    return { errcode: 0, errmsg: '支付未成功，无需处理' };
  }
  if (!outTradeNo) {
    await recordEvent('bad_request', { event });
    return { errcode: 1, errmsg: '缺少商户订单号' };
  }
  if (totalFee !== null && (!Number.isInteger(totalFee) || totalFee <= 0)) {
    await recordEvent('bad_fee', { outTradeNo, totalFee });
    return { errcode: 1, errmsg: '支付金额格式错误' };
  }

  await recordEvent('received', {
    outTradeNo, transactionId, payerOpenId,
    totalFee, openid: event.openid || '', subAppid: event.subAppid || event.sub_appid || ''
  });

  try {
    const result = await confirmPayment({
      outTradeNo,
      transactionId,
      payerOpenId,
      totalFee,
      source: 'payNotify'
    });
    await recordEvent('processed', { outTradeNo, orderId: result.orderId });
    console.log('[payNotify] 支付副作用已确认:', result.orderId);
    return { errcode: 0, errmsg: 'success' };
  } catch (err) {
    // 只有 sub_openid 与订单 userId 同源；它一旦明确不一致就必须拒绝。
    // 回调未携带 sub_openid 时 payerOpenId 为空，事务层不会做跨口径误判。
    if (err && err.message === '付款身份与订单用户不一致') {
      await recordEvent('payer_mismatch', { outTradeNo, payerOpenId, openid: event.openid || '' });
    }
    await recordEvent('error', { outTradeNo, error: String(err && (err.message || err)) });
    console.error('[payNotify] 处理失败:', err);
    return { errcode: 1, errmsg: '处理异常，请重试' };
  }
};
