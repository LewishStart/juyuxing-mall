'use strict';

const cloud = require('wx-server-sdk');
const crypto = require('crypto');

cloud.init({ env: 'cloud1-d4gx1jxk675274501' });
const db = cloud.database();
const _ = db.command;

function withTransaction(work) {
  return typeof db.runTransaction === 'function' ? db.runTransaction(work) : work(db);
}

function normalizeRequestId(value) {
  const requestId = String(value || '').trim();
  if (/^[A-Za-z0-9_-]{12,64}$/.test(requestId)) return requestId;
  return crypto.randomBytes(16).toString('hex');
}

async function getBalance(database, agentId) {
  // 注意：此函数会被传入事务对象调用。云开发事务会话不支持并发请求（Promise.all 会报
  // TransactionBusy -501001），必须逐个 await 顺序执行查询。
  const commissionRes = await database.collection('commissions')
    .where({ agentId, status: _.in(['settled', 'withdrawing']) })
    .limit(1000)
    .get();
  const pendingRes = await database.collection('withdrawals')
    .where({ agentId, status: _.in(['pending', 'processing']) })
    .limit(1000)
    .get();
  const frozenRes = await database.collection('commissions')
    .where({ agentId, status: 'frozen' })
    .limit(1000)
    .get();
  const ledgerBalance = (commissionRes.data || [])
    .reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  const held = (commissionRes.data || []).filter(item => item.status === 'withdrawing');
  const heldAmount = held.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  const pendingAmount = (pendingRes.data || [])
    .reduce((sum, item) => sum + (Number(item.amount) || 0), 0) + heldAmount;
  const frozenAmount = (frozenRes.data || [])
    .reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  return {
    ledgerBalance,
    pendingAmount,
    pendingCount: (pendingRes.data || []).length + new Set(held.map(item => item.paidByWithdrawal)).size,
    frozenAmount,
    frozenCount: (frozenRes.data || []).length,
    available: Math.max(0, ledgerBalance - pendingAmount)
  };
}

exports.main = async (event) => {
  const ctx = cloud.getWXContext();
  const OPENID = ctx.OPENID || '';
  if (!OPENID) return { success: false, error: '缺少可信微信身份，请从小程序重新登录' };
  const action = event.action || 'info';

  const userRes = await db.collection('users').doc(OPENID).get().catch(() => null);
  const user = userRes && userRes.data;
  if (!user || !user.isAgent || !user.agentInfo || user.agentInfo.status !== 'active') {
    return { success: false, error: '分销员身份未激活' };
  }

  switch (action) {
    case 'info': {
      const balance = await getBalance(db, OPENID);
      return { success: true, ...balance };
    }

    case 'apply': {
      const amount = Number(event.amount);
      const name = String(event.name || '').trim();
      const account = String(event.account || '').trim();
      const requestId = normalizeRequestId(event.requestId);
      const idempotencyKey = `withdrawal:${OPENID}:${requestId}`;

      if (!Number.isInteger(amount) || amount <= 0) {
        return { success: false, error: '提现金额无效' };
      }
      // 微信商家转账单笔下限为 0.3 元，低于此金额转账接口会直接拒绝
      if (amount < 30) {
        return { success: false, error: '单笔提现不能低于 0.3 元（微信转账最低限额）' };
      }
      if (!name || !account) {
        return { success: false, error: '请填写收款信息' };
      }
      if (name.length > 40 || account.length > 100) {
        return { success: false, error: '收款信息过长' };
      }

      const steps = [];
      try {
        const result = await withTransaction(async transaction => {
          steps.push('tx-start');
          const duplicateRes = await transaction.collection('withdrawals')
            .where({ idempotencyKey })
            .limit(1)
            .get();
          steps.push('dup ok');
          const duplicate = duplicateRes.data && duplicateRes.data[0];
          if (duplicate) {
            return { withdrawalId: duplicate._id, duplicate: true };
          }

          // 读写用户版本字段，使同一分销员的并发申请冲突后重新计算余额。
          const latestUserRes = await transaction.collection('users').doc(OPENID).get();
          steps.push('user ok');
          if (!latestUserRes.data || !latestUserRes.data.isAgent) {
            throw new Error('分销员身份未激活');
          }
          const balance = await getBalance(transaction, OPENID);
          steps.push('balance ok');
          if ((balance.ledgerBalance - balance.pendingAmount) <= 0) {
            throw new Error('当前存在退款冲销，佣金余额恢复为正后方可提现');
          }
          if (amount > (balance.ledgerBalance - balance.pendingAmount)) {
            if (balance.frozenAmount > 0) {
              throw new Error('可提现余额不足：还有冻结中的佣金，买家确认收货后即可提现');
            }
            throw new Error('可提现余额不足');
          }

          const createRes = await transaction.collection('withdrawals').add({ data: {
            idempotencyKey,
            requestId,
            agentId: OPENID,
            amount,
            name,
            account,
            status: 'pending',
            createTime: db.serverDate(),
            processTime: null,
            remark: ''
          } });
          steps.push('add ok');
          await transaction.collection('users').doc(OPENID).update({
            data: { withdrawalVersion: _.inc(1), updateTime: db.serverDate() }
          });
          steps.push('update ok');
          return { withdrawalId: createRes._id, duplicate: false };
        });
        return {
          success: true,
          withdrawalId: result.withdrawalId,
          duplicate: result.duplicate
        };
      } catch (err) {
        return { success: false, error: (err && err.message) || '提现申请失败', steps };
      }
    }

    case 'list': {
      const pageSize = Math.min(Math.max(Number(event.pageSize) || 20, 1), 50);
      const page = Math.max(Number(event.page) || 1, 1);
      const res = await db.collection('withdrawals')
        .where({ agentId: OPENID })
        .orderBy('createTime', 'desc')
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .get();
      return { success: true, data: res.data };
    }

    default:
      return { success: false, error: 'unknown action' };
  }
};
