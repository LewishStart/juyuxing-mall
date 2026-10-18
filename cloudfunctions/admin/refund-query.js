'use strict';

const crypto = require('crypto');
const { loadPayApiConfig, directQueryRefund } = require('./wxpay-direct');
const { event: diagnostic, safeError, errorCode } = require('./payment-diagnostics');

const APP_ID = 'wx6e685f787f1cd099';

function field(response, camel, snake) {
  return response[camel] === undefined ? response[snake] : response[camel];
}

const STATUS_TEXT = {
  SUCCESS: '微信已退款成功；如本地仍待处理，请核对账务，不要再次退款。',
  PROCESSING: '微信正在处理退款，请稍后仅查询，不要再次退款。',
  REFUNDCLOSE: '微信退款已关闭，请人工核查，不要直接重试。',
  CHANGE: '微信退款异常，需要在商户平台核查。'
};

// Only reads local records and calls queryRefund. Never applies payment/inventory effects.
exports.queryRefundStatus = async (cloud, db, refundId) => {
  if (typeof refundId !== 'string' || !refundId.trim() || refundId.length > 128) {
    return { success: false, error: '退款记录 ID 无效' };
  }
  try {
    const rfRes = await db.collection('refunds').doc(refundId).get();
    const rf = rfRes && rfRes.data;
    if (!rf || !rf.orderId) return { success: false, error: '退款记录不存在' };
    const orderRes = await db.collection('orders').doc(rf.orderId).get();
    const order = orderRes && orderRes.data;
    if (!order) return { success: false, error: '关联订单不存在' };
    const outRefundNo = rf.outRefundNo || ('RF' + crypto.createHash('sha256').update(refundId).digest('hex').slice(0, 30));
    const base = { outRefundNo, orderNo: order.orderNo || '', localStatus: rf.status || '', queriedAt: new Date().toISOString() };
    if (order.paymentSource === 'mockPay' || String(order.transactionId || '').startsWith('MOCK_TXN_')) {
      return { success: true, data: { ...base, status: 'MOCK', message: '模拟支付订单，没有真实微信退款；仅展示本地状态。' } };
    }
    const config = await db.collection('pay_config').doc('default').get();
    const subMchId = String((config && config.data && config.data.subMchId) || '').trim();
    if (!subMchId) return { success: false, error: '未配置微信支付商户号，无法查询退款' };

    // ===== 优先走直连查询（只需 APIv2 密钥，不需要证书，不受 CloudBase access_token 影响）=====
    const payApiCfg = await loadPayApiConfig(db, false);
    if (payApiCfg && payApiCfg.apiV2Key) {
      try {
        const wxResp = await directQueryRefund({
          appId: APP_ID,
          mchId: subMchId,
          apiV2Key: payApiCfg.apiV2Key,
          outRefundNo
        });
        diagnostic(console, 'refund.query_response', { id: refundId, channel: 'direct' });
        if (wxResp.return_code === 'SUCCESS' && wxResp.result_code === 'FAIL' && wxResp.err_code === 'REFUNDNOTEXIST') {
          return { success: true, data: { ...base, status: 'NOT_FOUND', message: '暂未查到此退款单。可能存在延迟或历史单号差异，不代表可以安全重复退款。' } };
        }
        if (wxResp.return_code !== 'SUCCESS' || wxResp.result_code !== 'SUCCESS') {
          const message = wxResp.err_code_des || wxResp.return_msg || '渠道未返回成功结果';
          return { success: false, code: String(wxResp.err_code || '').slice(0, 80), error: `直连退款查询失败：${String(message).slice(0, 500)}` };
        }
        const count = Number(wxResp.refund_count);
        if (Number.isInteger(count) && count >= 1 && count <= 100) {
          for (let i = 0; i < count; i++) {
            const returnedNo = wxResp['out_refund_no_' + i];
            if (returnedNo !== outRefundNo) continue;
            const status = wxResp['refund_status_' + i];
            const amount = Number(wxResp['refund_fee_' + i]);
            if (STATUS_TEXT[status] && Number.isSafeInteger(amount) && amount === order.totalFee && wxResp.out_trade_no === order.orderNo) {
              return { success: true, data: { ...base, status, amount, via: 'direct_api',
                wechatRefundId: String(wxResp['refund_id_' + i] || ''),
                message: STATUS_TEXT[status] + ' 本次查询未更改订单或账本。'
              } };
            }
          }
        }
        return { success: false, error: '直连查询返回数据不完整，不能确认资金状态' };
      } catch (directErr) {
        diagnostic(console, 'refund.query_direct_failed', { id: refundId, code: directErr.code });
        // 直连失败 → 继续走下面的 cloudPay 查询
      }
    }

    if (!cloud.cloudPay || typeof cloud.cloudPay.queryRefund !== 'function') {
      return { success: false, error: '当前云支付 SDK 不支持退款查询' };
    }
    const response = await cloud.cloudPay.queryRefund({ subMchId, outRefundNo, nonceStr: crypto.randomBytes(16).toString('hex') });
    if (!response || typeof response !== 'object') return { success: false, error: '退款查询返回为空，资金状态未知，请勿重试退款' };
    const returnCode = field(response, 'returnCode', 'return_code');
    const resultCode = field(response, 'resultCode', 'result_code');
    const code = field(response, 'errCode', 'err_code') || '';
    if (returnCode === 'SUCCESS' && resultCode === 'FAIL' && code === 'REFUNDNOTEXIST') {
      return { success: true, data: { ...base, status: 'NOT_FOUND', message: '暂未查到此退款单。可能存在延迟或历史单号差异，不代表可以安全重复退款。' } };
    }
    if (returnCode !== 'SUCCESS' || resultCode !== 'SUCCESS') {
      const message = field(response, 'errCodeDes', 'err_code_des') || field(response, 'returnMsg', 'return_msg') || '渠道未返回成功结果';
      return { success: false, code: String(code).slice(0, 80), error: `退款查询失败：${String(message).slice(0, 500)}` };
    }
    const count = Number(field(response, 'refundCount', 'refund_count'));
    if (!Number.isInteger(count) || count < 1 || count > 100) {
      return { success: false, error: '退款查询数据不完整，不能确认资金状态' };
    }
    for (let i = 0; i < count; i++) {
      const returnedNo = field(response, 'outRefundNo' + i, 'out_refund_no_' + i);
      if (returnedNo !== outRefundNo) continue;
      const status = field(response, 'refundStatus' + i, 'refund_status_' + i);
      const amount = Number(field(response, 'refundFee' + i, 'refund_fee_' + i));
      const tradeNo = field(response, 'outTradeNo', 'out_trade_no');
      if (!STATUS_TEXT[status] || !Number.isSafeInteger(amount) || amount !== order.totalFee || tradeNo && tradeNo !== order.orderNo) {
        return { success: false, error: '退款状态或金额无法识别，请核查商户平台' };
      }
      return { success: true, data: { ...base, status, amount,
        wechatRefundId: String(field(response, 'refundId' + i, 'refund_id_' + i) || ''),
        message: STATUS_TEXT[status] + ' 本次查询未更改订单或账本。'
      } };
    }
    return { success: false, error: '渠道返回的退款单号与本次申请不匹配，不能确认退款结果' };
  } catch (err) {
    diagnostic(console, 'refund.query_failed', { id: refundId, code: err.code });
    return { success: false, code: errorCode(err), error: safeError(err) + '；查询失败不代表退款失败，请勿直接重试退款。' };
  }
};
