'use strict';

const cloud = require('wx-server-sdk');
const crypto = require('crypto');

cloud.init({ env: 'cloud1-d4gx1jxk675274501' });
const db = cloud.database();
const _ = db.command;

function withTransaction(work) {
  if (typeof db.runTransaction !== 'function') throw new Error('提现需要数据库事务支持');
  return db.runTransaction(work);
}

function normalizeRequestId(value) {
  const requestId = String(value || '').trim();
  if (/^[A-Za-z0-9_-]{12,64}$/.test(requestId)) return requestId;
  return crypto.randomBytes(16).toString('hex');
}

// Bounded, immutable-key cursor scan. Never accept a truncated financial ledger.
async function scanLedger(database, name, filter, command, max = 2000) {
  const rows = [];
  let cursor = '';
  for (;;) {
    const where = cursor ? { ...filter, _id: command.gt(cursor) } : filter;
    const result = await database.collection(name).where(where).orderBy('_id', 'asc').limit(100).get();
    if (!result || !Array.isArray(result.data)) throw new Error('账本读取不完整，请核对原单');
    const page = result.data;
    for (const row of page) {
      if (typeof row._id !== 'string' || !row._id || row._id <= cursor) throw new Error('账本分页不完整，请核对原单');
      cursor = row._id;
      rows.push(row);
    }
    if (rows.length > max) throw new Error('账本超过单次安全核对容量，请联系财务分批核对');
    if (page.length < 100) return rows;
  }
}

function money(value, positive = false) {
  if (!Number.isSafeInteger(value) || positive && value <= 0) throw new Error('账本金额无效，请核对原单');
  return value;
}
function sumMoney(rows) {
  return rows.reduce((sum, row) => money(sum + money(row.amount)), 0);
}

async function agentBalance(database, agentId, command) {
  const commissions = await scanLedger(database, 'commissions', { agentId, status: command.in(['settled', 'withdrawing', 'frozen']) }, command);
  const applications = await scanLedger(database, 'withdrawals', { agentId, status: command.in(['pending', 'processing', 'pending_pay', 'transferring']) }, command);
  return balanceRows(commissions, applications);
}

function balanceRows(commissions, applications) {
  const holds = new Map();
  for (const row of commissions.filter(c => c.status === 'withdrawing')) {
    if (!row.paidByWithdrawal) throw new Error('提现占用缺少原申请，请核对原单');
    money(row.amount, true);
    holds.set(row.paidByWithdrawal, money((holds.get(row.paidByWithdrawal) || 0) + row.amount));
  }
  let pendingAmount = 0;
  for (const application of applications) {
    money(application.amount, true);
    const held = holds.get(application._id);
    if (held !== undefined && held !== application.amount) throw new Error('提现占用账本不一致');
    if (held === undefined && application.accountingVersion === 2 && ['pending_pay', 'transferring'].includes(application.status)) throw new Error('提现占用账本缺失');
    pendingAmount = money(pendingAmount + application.amount);
    holds.delete(application._id);
  }
  // An unmatched hold still occupies the balance; never make it available twice.
  for (const held of holds.values()) pendingAmount = money(pendingAmount + held);
  const ledgerBalance = sumMoney(commissions.filter(c => c.status !== 'frozen'));
  const frozen = commissions.filter(c => c.status === 'frozen');
  return { commissions, applications, ledgerBalance, pendingAmount,
    pendingCount: applications.length + holds.size, frozenAmount: sumMoney(frozen), frozenCount: frozen.length,
    available: Math.max(0, money(ledgerBalance - pendingAmount)) };
}

async function getBalance(database, agentId) {
  const { commissions, applications, ...balance } = await agentBalance(database, agentId, _);
  return balance;
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
      try { return { success: true, ...await getBalance(db, OPENID) }; }
      catch (error) { return { success: false, error: error.message || '账本核对未完成' }; }
    }

    case 'apply': {
      const amount = event.amount;
      const name = String(event.name || '').trim();
      const account = String(event.account || '').trim();
      const requestId = normalizeRequestId(event.requestId);
      const idempotencyKey = `withdrawal:${OPENID}:${requestId}`;

      if (!Number.isSafeInteger(amount) || amount <= 0) {
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
          if (!latestUserRes.data || !latestUserRes.data.isAgent || !latestUserRes.data.agentInfo || latestUserRes.data.agentInfo.status !== 'active') {
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
