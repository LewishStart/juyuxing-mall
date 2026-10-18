'use strict';

const cloud = require('wx-server-sdk');
const { createRefundExecutor } = require('./refund-execution');
const { event: diagnostic } = require('./payment-diagnostics');
cloud.init({ env: 'cloud1-d4gx1jxk675274501' });
const db = cloud.database();
const executor = createRefundExecutor(cloud, db, console);

async function authorized() {
  // Never trust event.userInfo or a client-supplied OpenID.
  const openId = cloud.getWXContext().OPENID;
  if (!openId) return false;
  const result = await db.collection('admin_accounts')
    .where({ wechatOpenId: openId, status: 'active' }).limit(2).get();
  return result.data && result.data.length === 1 && ['owner', 'finance'].includes(result.data[0].role);
}

exports.main = async (event = {}) => {
  if (event.action !== 'sweep') return { success: false, error: '请通过已授权的退款核对入口操作' };
  try {
    if (!await authorized()) return { success: false, error: '仅已绑定微信的店主或财务可核对退款' };
    if (typeof db.runTransaction !== 'function') throw new Error('Transactions unavailable');
    return await executor.sweep();
  } catch (error) {
    diagnostic(console, 'refund.sweep_failed', { code: error.code });
    return { success: false, error: '退款核对失败，请先查询原单，不要重复退款' };
  }
};
