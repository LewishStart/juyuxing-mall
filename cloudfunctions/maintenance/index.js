'use strict';

const cloud = require('wx-server-sdk');
cloud.init({ env: 'cloud1-d4gx1jxk675274501' });
const db = cloud.database();
const _ = db.command;
const lifecycle = require('./payment-effects').createPaymentLifecycle(cloud, db);

function withTransaction(work) {
  return typeof db.runTransaction === 'function' ? db.runTransaction(work) : work(db);
}

async function autoReceive(order) {
  return withTransaction(async transaction => {
    const currentRes = await transaction.collection('orders').doc(order._id).get().catch(() => null);
    const current = currentRes && currentRes.data;
    if (!current || current.status !== 'shipped') return false;
    if (current.agentId) {
      await transaction.collection('commissions').where({ orderId: current._id, status: 'frozen' }).update({
        data: { status: 'settled', settleTime: db.serverDate(), settleSource: 'auto_receive' }
      });
    }
    await transaction.collection('orders').doc(current._id).update({ data: {
      status: 'received', receivedTime: db.serverDate(), autoReceived: true,
      commissionStatus: current.agentId ? 'settled' : 'none', updateTime: db.serverDate()
    } });
    return true;
  });
}

exports.main = async () => {
  const { OPENID } = cloud.getWXContext();
  if (OPENID) return { success: false, error: '该函数只允许定时触发器调用' };
  const now = new Date();
  const receiveBefore = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const expired = await db.collection('orders')
    .where({ status: 'pending', expireTime: _.lte(now) }).limit(100).get().catch(() => ({ data: [] }));
  const shipped = await db.collection('orders')
    .where({ status: 'shipped', shipTime: _.lte(receiveBefore) }).limit(100).get().catch(() => ({ data: [] }));
  let closed = 0;
  let received = 0;
  for (const order of expired.data || []) if ((await lifecycle.close(order._id, 'payment_timeout')).success) closed++;
  for (const order of shipped.data || []) if (await autoReceive(order)) received++;
  return { success: true, closed, received };
};
