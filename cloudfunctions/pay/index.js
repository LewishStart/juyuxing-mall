const cloud = require('wx-server-sdk');

// 云环境 ID（必须显式写死，cloud.DYNAMIC_CURRENT_ENV 在云支付中可能为空）
const ENV_ID = 'cloud1-d4gx1jxk675274501';

cloud.init({ env: ENV_ID });
const db = cloud.database();
const _ = db.command;
const confirmPayment = require('./payment-effects').createPaymentEffects(cloud, db);

// 从 admin_config 读取佣金比例（默认 15%）
async function getCommissionRate() {
  try {
    const cfgRes = await db.collection('pay_config').doc('default').get().catch(() => null);
    if (cfgRes && cfgRes.data && typeof cfgRes.data.commissionRate === 'number') return cfgRes.data.commissionRate;
    const adminRes = await db.collection('admin_config').doc('admin').get().catch(() => null);
    const cfg = (adminRes && adminRes.data) || {};
    return typeof cfg.commissionRate === 'number' ? cfg.commissionRate : 0.33;
  } catch (e) {
    return 0.33;
  }
}
// 模拟支付是高风险开发能力，必须同时满足数据库开关与云函数环境变量。
// 未配置支付时必须失败关闭，绝不能把订单自动标记为已支付。
async function resolvePaymentConfig() {
  try {
    const cfgRes = await db.collection('pay_config').doc('default').get().catch(() => null);
    const config = (cfgRes && cfgRes.data) || {};
    const mockRequested = config.useMockPay === true;
    return {
      subMchId: String(config.subMchId || '').trim(),
      mockRequested,
      useMockPay: mockRequested && process.env.ALLOW_MOCK_PAY === 'true'
    };
  } catch (e) {
    return { subMchId: '', mockRequested: false, useMockPay: false };
  }
}

exports.main = async (event, context) => {
  const ctx = cloud.getWXContext();
  const OPENID = ctx.OPENID || '';
  if (!OPENID) return { success: false, error: '缺少可信微信身份，请从小程序重新登录' };

  switch (event.action) {
    case 'request': {
      const orderId = event.orderId;
      if (!orderId) {
        return { success: false, error: '订单号缺失' };
      }

      // 仅允许本人支付自己的订单
      const orderRes = await db.collection('orders').doc(orderId).get().catch(() => null);
      const order = orderRes && orderRes.data;
      if (!order) {
        return { success: false, error: '订单不存在' };
      }
      if (order.userId !== OPENID) {
        return { success: false, error: '无权操作此订单' };
      }
      if (order.status === 'paid' || order.status === 'shipped' || order.status === 'received') {
        return {
          success: true,
          alreadyPaid: true,
          mock: order.paymentSource === 'mockPay',
          message: '订单已支付',
          orderId
        };
      }
      if (order.status !== 'pending') {
        return { success: false, error: '当前订单状态不可支付' };
      }

      const paymentConfig = await resolvePaymentConfig();
      if (paymentConfig.mockRequested && !paymentConfig.useMockPay) {
        return {
          success: false,
          error: '模拟支付未获服务器授权，请在 pay 云函数环境变量中明确设置 ALLOW_MOCK_PAY=true'
        };
      }

      // ===== 回调丢失自愈：已有预支付单且下单超过 3 分钟，先向微信查单 =====
      // 避免"用户已付款但回调未落库"时重复拉起支付；查到已支付直接补齐副作用。
      if (order.prepayId && !paymentConfig.useMockPay) {
        const orderAge = Date.now() - new Date(order.createTime).getTime();
        if (orderAge > 3 * 60 * 1000) {
          try {
            const query = await cloud.cloudPay.queryOrder({
              subMchId: paymentConfig.subMchId,
              outTradeNo: order.orderNo,
              nonceStr: generateNonceStr()
            });
            const tradeState = query && (query.tradeState || query.trade_state);
            if (tradeState === 'SUCCESS') {
              const totalFeeValue = query.totalFee !== undefined ? query.totalFee : query.total_fee;
              await confirmPayment({
                outTradeNo: order.orderNo,
                transactionId: (query.transactionId || query.transaction_id) || '',
                totalFee: totalFeeValue === undefined ? null : Number(totalFeeValue),
                source: 'reconcile'
              });
              return {
                success: true, alreadyPaid: true, reconciled: true,
                message: '订单已支付', orderId
              };
            }
          } catch (err) {
            console.warn('[pay] 查单自愈失败:', order.orderNo, err && (err.message || err));
          }
        }
      }

      // ===== 显式授权的模拟支付模式（仅用于开发环境）=====
      if (paymentConfig.useMockPay) {
        const mockTxnId = 'MOCK_TXN_' + order.orderNo;
        await confirmPayment({ orderId, transactionId: mockTxnId, source: 'mockPay' });
        return {
          success: true,
          mock: true,
          message: '模拟支付成功',
          orderId
        };
      }

      const subMchId = paymentConfig.subMchId;
      if (!subMchId) {
        return { success: false, error: '微信支付尚未配置，请联系管理员完善商户号和云支付绑定' };
      }

      // ===== 真实微信支付（微信云开发云支付）=====
      try {
        // 调用微信云支付统一下单
        const payRes = await cloud.cloudPay.unifiedOrder({
          body: `林元元 - ${order.items.map(i => i.name).join(', ')}`,
          outTradeNo: order.orderNo,
          spbillCreateIp: '127.0.0.1',
          subMchId: subMchId,
          totalFee: order.totalFee,
          envId: ENV_ID,
          functionName: 'payNotify',
          nonceStr: generateNonceStr(),
          tradeType: 'JSAPI',
          openId: OPENID
        });

        console.log('云支付 unifiedOrder 返回:', JSON.stringify({
          returnCode: payRes.returnCode,
          resultCode: payRes.resultCode,
          errCode: payRes.errCode || '',
          outTradeNo: order.orderNo
        }));

        if (payRes.returnCode !== 'SUCCESS' || payRes.resultCode !== 'SUCCESS') {
          console.error('统一下单失败:', JSON.stringify(payRes));
          const errMsg = payRes.errCodeDes || payRes.returnMsg || payRes.errCode || '未知错误';
          return { success: false, error: `下单失败(${errMsg})` };
        }

        // 微信云支付 unifiedOrder 返回的 payment 对象，包含前端直接需要的所有参数
        // 结构：{ timeStamp, nonceStr, package, signType, paySign }
        const paymentParams = payRes.payment;

        if (!paymentParams || !paymentParams.paySign) {
          console.error('云支付返回缺少 payment 参数:', JSON.stringify(payRes));
          // 尝试手动从 payRes 顶层拼装（兼容旧版云支付 SDK）
          const fallbackPayment = {
            timeStamp: payRes.timeStamp || String(Math.floor(Date.now() / 1000)),
            nonceStr: payRes.nonceStr || generateNonceStr(),
            package: payRes.package || `prepay_id=${payRes.prepayId}`,
            signType: payRes.signType || 'MD5',
            paySign: payRes.paySign
          };
          if (!fallbackPayment.paySign) {
            return { success: false, error: '支付参数不完整，请管理员检查云支付配置' };
          }
          // 记录支付单号
          await db.collection('orders').doc(orderId).update({
            data: { prepayId: payRes.prepayId || '' }
          });
          return { success: true, payment: fallbackPayment, orderId };
        }

        // 记录支付单号
        await db.collection('orders').doc(orderId).update({
          data: {
            prepayId: payRes.prepayId || (paymentParams.package || '').replace('prepay_id=', '')
          }
        });

        // 直接把 payment 对象透传给前端
        return {
          success: true,
          payment: paymentParams,
          orderId
        };
      } catch (err) {
        console.error('云支付调用失败:', JSON.stringify(err));
        return { success: false, error: '支付服务暂不可用，请稍后重试' };
      }
    }

    default:
      return { success: false, error: 'unknown action' };
  }
};

function generateNonceStr(length = 32) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let str = '';
  for (let i = 0; i < length; i++) {
    str += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return str;
}
