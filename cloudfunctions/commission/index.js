'use strict';

const cloud = require('wx-server-sdk');

cloud.init({ env: 'cloud1-d4gx1jxk675274501' });
const db = cloud.database();

function sanitizeCommission(item) {
  if (!Number.isSafeInteger(item.amount)) throw new Error('佣金账本金额无效，请核对原单');
  return {
    _id: item._id,
    orderNo: item.orderNo || '',
    amount: item.amount,
    rate: Number(item.rate) || 0,
    type: item.type || 'earning',
    status: item.status || '',
    createTime: item.createTime || null,
    settleTime: item.settleTime || null,
    paidTime: item.paidTime || null
  };
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const userRes = await db.collection('users').doc(OPENID).get().catch(() => null);
  const user = userRes && userRes.data;
  if (!user || !user.isAgent || !user.agentInfo || user.agentInfo.status !== 'active') {
    return { success: false, error: '分销员身份未激活' };
  }

  if (event.action !== 'list') {
    return { success: false, error: '佣金由支付、收货、退款和提现流程自动处理' };
  }

  const pageSize = Math.min(Math.max(Number(event.pageSize) || 20, 1), 50);
  const page = Math.max(Number(event.page) || 1, 1);
  const res = await db.collection('commissions')
    .where({ agentId: OPENID })
    .orderBy('createTime', 'desc')
    .skip((page - 1) * pageSize)
    .limit(pageSize)
    .get();
  return { success: true, data: (res.data || []).map(sanitizeCommission) };
};
