'use strict';

const cloud = require('wx-server-sdk');
const crypto = require('crypto');
cloud.init({ env: 'cloud1-d4gx1jxk675274501' });
const db = cloud.database();
const _ = db.command;

function withTransaction(work) {
  return typeof db.runTransaction === 'function' ? db.runTransaction(work) : work(db);
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function maskOrderNo(orderNo) {
  const value = String(orderNo || '');
  if (value.length <= 8) return value;
  return value.slice(0, 4) + '****' + value.slice(-4);
}

async function getUser(openId) {
  const res = await db.collection('users').doc(openId).get().catch(() => null);
  return res && res.data;
}

function isActiveAgent(user) {
  return !!(user && user.isAgent && user.agentInfo && user.agentInfo.status === 'active');
}

async function listAll(collectionName, query, max = 5000) {
  const pageSize = 100;
  const data = [];
  for (let offset = 0; offset < max; offset += pageSize) {
    const res = await db.collection(collectionName)
      .where(query)
      .skip(offset)
      .limit(pageSize)
      .get();
    const page = res.data || [];
    data.push(...page);
    if (page.length < pageSize) break;
  }
  if (data.length >= max) throw new Error('数据量超过看板安全上限，请联系管理员导出核对');
  return data;
}

async function requireAgent(openId) {
  const user = await getUser(openId);
  return isActiveAgent(user) ? user : null;
}

// 分销员资料校验：姓名 + 手机号均必填（店主需要联系方式管理分销员）
function normalizeProfileInput(profile) {
  const name = String((profile && profile.name) || '').trim();
  const phone = String((profile && profile.phone) || '').trim();
  const nickName = String((profile && profile.nickName) || '').trim().slice(0, 30);
  if (name.length < 2 || name.length > 30) return { error: '请填写真实姓名（2-30 个字）' };
  if (!/^1\d{10}$/.test(phone)) return { error: '请填写正确的 11 位手机号' };
  return { name, phone, nickName };
}

async function generateReferralCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 20; attempt++) {
    const random = Array.from({ length: 8 }, () => chars[crypto.randomInt(chars.length)]).join('');
    const code = 'JY' + random;
    const exists = await db.collection('users').where({ referralCode: code }).count();
    if (exists.total === 0) return code;
  }
  throw new Error('推广码生成失败，请重试');
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  try {
    switch (event.action) {
      case 'apply':
        return { success: false, error: '分销员仅支持后台邀请开通' };

      case 'claimInvite': {
        const token = String(event.token || '').trim();
        if (!token) return { success: false, error: '邀请链接无效' };
        // 分销员自填资料（bind 页表单）：微信昵称选填；姓名/手机号在最终解析后校验必填
        const rawProfile = event.profile || {};
        const profile = {
          name: String(rawProfile.name || '').trim().slice(0, 30),
          phone: String(rawProfile.phone || '').trim(),
          nickName: String(rawProfile.nickName || '').trim().slice(0, 30)
        };
        if (profile.name && profile.name.length < 2) return { success: false, error: '姓名至少 2 个字' };
        if (profile.phone && !/^1\d{10}$/.test(profile.phone)) return { success: false, error: '请填写正确的 11 位手机号' };
        const user = await getUser(OPENID);
        if (!user) return { success: false, error: '请先登录后再激活' };
        if (isActiveAgent(user)) return { success: true, alreadyActive: true, code: user.referralCode || '' };
        const code = await generateReferralCode();
        return withTransaction(async transaction => {
          const latestUserRes = await transaction.collection('users').doc(OPENID).get().catch(() => null);
          const latestUser = latestUserRes && latestUserRes.data;
          if (!latestUser) return { success: false, error: '请先登录后再激活' };
          if (isActiveAgent(latestUser)) {
            return { success: true, alreadyActive: true, code: latestUser.referralCode || '' };
          }
          const inviteRes = await transaction.collection('agent_invites')
            .where({ tokenHash: sha256(token), status: 'pending' }).limit(1).get();
          const invite = inviteRes.data && inviteRes.data[0];
          if (!invite || !invite.expireTime || new Date(invite.expireTime) <= new Date()) {
            return { success: false, error: '邀请已失效，请联系运营重新生成' };
          }
          // 优先级：分销员自填 > 邀请预填 > 微信昵称兜底
          const finalName = profile.name || String(invite.name || '').trim() || profile.nickName || latestUser.nickName || '';
          const finalPhone = profile.phone || String(invite.phone || '').trim();
          if (!finalName || finalName.length < 2) {
            return { success: false, error: '请填写真实姓名（2-30 个字）' };
          }
          if (!/^1\d{10}$/.test(finalPhone)) {
            return { success: false, error: '请填写 11 位手机号，方便平台联系您' };
          }
          const info = {
            level: '一级分销员', status: 'active', name: finalName, phone: finalPhone,
            nickName: profile.nickName || latestUser.nickName || '',
            inviteId: invite._id, activateTime: db.serverDate()
          };
          await transaction.collection('users').doc(OPENID).update({
            data: { isAgent: true, referralCode: code, agentInfo: info, updateTime: db.serverDate() }
          });
          await transaction.collection('agent_invites').doc(invite._id).update({
            data: { status: 'claimed', claimedBy: OPENID, claimedTime: db.serverDate() }
          });
          return { success: true, code };
        });
      }

      case 'updateProfile': {
        const agent = await requireAgent(OPENID);
        if (!agent) return { success: false, error: '分销员身份未激活' };
        const profile = normalizeProfileInput(event.profile || {});
        if (profile.error) return { success: false, error: profile.error };
        const agentInfo = Object.assign({}, agent.agentInfo, {
          name: profile.name, phone: profile.phone,
          nickName: profile.nickName || agent.agentInfo.nickName || agent.nickName || ''
        });
        await db.collection('users').doc(OPENID).update({
          data: { agentInfo, updateTime: db.serverDate() }
        });
        return { success: true, agentInfo };
      }

      case 'info': {
        const user = await getUser(OPENID);
        return {
          success: true,
          isAgent: isActiveAgent(user),
          level: (user && user.agentInfo && user.agentInfo.level) || '',
          code: (user && user.referralCode) || '',
          status: (user && user.agentInfo && user.agentInfo.status) || '',
          name: (user && user.agentInfo && user.agentInfo.name) || '',
          phone: (user && user.agentInfo && user.agentInfo.phone) || '',
          nickName: (user && user.agentInfo && user.agentInfo.nickName) || (user && user.nickName) || ''
        };
      }

      case 'performance':
      case 'dashboard': {
        const agent = await requireAgent(OPENID);
        if (!agent) return { success: false, error: '分销员身份未激活' };
        const now = new Date();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const [agentOrders, list, team, applications] = await Promise.all([
          listAll('orders', { agentId: OPENID }),
          listAll('commissions', { agentId: OPENID }),
          db.collection('users').where({ referrer: OPENID }).count(),
          listAll('withdrawals', { agentId: OPENID })
        ]);
        const monthOrders = agentOrders.filter(order =>
          ['paid', 'shipped', 'received', 'refunding', 'refunded'].includes(order.status) &&
          order.payTime && new Date(order.payTime) >= monthStart
        );
        const sum = status => list.filter(item => item.status === status)
          .reduce((total, item) => total + (Number(item.amount) || 0), 0);
        const frozen = sum('frozen');
        const pending = applications.filter(w => ['pending', 'processing'].includes(w.status))
          .reduce((total, w) => total + (Number(w.amount) || 0), 0);
        const available = Math.max(0, sum('settled') - pending);
        const paid = sum('paid');
        const totalCommission = frozen + sum('settled') + sum('withdrawing') + paid;
        const monthSales = monthOrders.filter(order => order.status !== 'refunded')
          .reduce((total, order) => total + (Number(order.totalFee) || 0), 0);
        return {
          success: true, totalCommission, frozen, pending: frozen, available, paid, withdrawing: sum('withdrawing'),
          monthSales, monthCommission: monthOrders.reduce((total, order) => total + (Number(order.commission) || 0), 0),
          monthOrders: monthOrders.length, teamCount: team.total || 0,
          code: agent.referralCode || ''
        };
      }

      case 'team': {
        if (!await requireAgent(OPENID)) return { success: false, error: '分销员身份未激活' };
        const res = await db.collection('users').where({ referrer: OPENID }).count();
        return { success: true, total: res.total || 0 };
      }

      case 'commissions': {
        if (!await requireAgent(OPENID)) return { success: false, error: '分销员身份未激活' };
        const pageSize = Math.min(Number(event.pageSize) || 20, 50);
        const page = Math.max(Number(event.page) || 1, 1);
        const res = await db.collection('commissions').where({ agentId: OPENID })
          .orderBy('createTime', 'desc').skip((page - 1) * pageSize).limit(pageSize).get();
        const data = [];
        for (const commission of res.data || []) {
          const orderRes = await db.collection('orders').doc(commission.orderId).get().catch(() => null);
          const order = orderRes && orderRes.data;
          data.push({
            _id: commission._id,
            orderNo: maskOrderNo(commission.orderNo),
            productNames: order ? (order.items || []).map(item => item.name).slice(0, 3) : [],
            amount: Number(commission.amount) || 0,
            type: commission.type || 'earning', status: commission.status,
            createTime: commission.createTime, settleTime: commission.settleTime || null,
            paidTime: commission.paidTime || null
          });
        }
        return { success: true, data };
      }

      case 'bootstrap': {
        // [已下线] 原「自助激活分销员」测试后门已于 2026-09-08 移除。
        // 唯一开通途径：后台生成一次性邀请，分销员在 bind 页 claimInvite。
        return { success: false, error: '该入口已关闭，请通过正规途径申请分销员' };
      }

      default:
        return { success: false, error: 'unknown action' };
    }
  } catch (err) {
    console.error('[agent] 运行时错误:', err);
    return { success: false, error: (err && err.message) || '分销服务暂不可用' };
  }
};
