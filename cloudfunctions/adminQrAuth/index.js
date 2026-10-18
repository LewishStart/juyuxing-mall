'use strict';

const cloud = require('wx-server-sdk');
const crypto = require('crypto');
const {
  SESSION_TTL_MS,
  createTicketValues,
  customUserId,
  hashValue,
  parseScene,
  publicAccount,
  ticketState
} = require('./ticket-core');
const { getUnlimitedWxacode } = require('./wxacode-client');

const ENV_ID = 'cloud1-d4gx1jxk675274501';
const CONFIRM_PAGE = 'pages/index/index';
// 分销员邀请小程序码直达 C 端激活页
const INVITE_PAGE = 'subpackages/distributor/bind/bind';
// 项目尚未上线，后台扫码使用在公众平台选定的体验版。
// 正式发布前改为 release，并与正式小程序版本一同验收。
const REQUESTED_ENV_VERSION = String(process.env.MINIPROGRAM_ENV_VERSION || 'trial').trim();
const QR_ENV_VERSION = ['develop', 'trial', 'release'].includes(REQUESTED_ENV_VERSION)
  ? REQUESTED_ENV_VERSION
  : 'trial';

cloud.init({ env: ENV_ID });
const db = cloud.database();

function updatedCount(result) {
  return result && result.stats ? result.stats.updated : result && result.updated;
}

function customLoginCredentials() {
  const privateKeyId = String(process.env.CLOUDBASE_CUSTOM_LOGIN_PRIVATE_KEY_ID || '').trim();
  const privateKey = String(process.env.CLOUDBASE_CUSTOM_LOGIN_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim();
  if (!privateKeyId || !privateKey) {
    throw new Error('CUSTOM_LOGIN_NOT_CONFIGURED');
  }
  return { env_id: ENV_ID, private_key_id: privateKeyId, private_key: privateKey };
}

function createCustomLoginTicket(accountId) {
  const cloudbase = require('@cloudbase/node-sdk');
  const app = cloudbase.init({ env: ENV_ID, credentials: customLoginCredentials() });
  return app.auth().createTicket(customUserId(accountId), {
    refresh: 60 * 60 * 1000,
    expire: Date.now() + 30 * 24 * 60 * 60 * 1000
  });
}

async function getTicket(publicId, pollSecret) {
  const query = { publicId };
  if (pollSecret !== undefined) query.pollSecretHash = hashValue(pollSecret);
  const res = await db.collection('admin_login_tickets').where(query).limit(1).get();
  return res.data && res.data[0];
}

async function ensureAdminAccountsCollection() {
  return db.collection('admin_accounts').limit(1).get()
    .then(() => true)
    .catch(async () => {
      if (typeof db.createCollection !== 'function') return false;
      try { await db.createCollection('admin_accounts'); return true; }
      catch (err) { return /exists|已存在/i.test(String(err && err.message)); }
    });
}

async function ensureAdminLoginTicketsCollection() {
  return db.collection('admin_login_tickets').limit(1).get()
    .then(() => true)
    .catch(async () => {
      if (typeof db.createCollection !== 'function') return false;
      try { await db.createCollection('admin_login_tickets'); return true; }
      catch (err) { return /exists|已存在/i.test(String(err && err.message)); }
    });
}

async function ensureAdminSessionsCollection() {
  return db.collection('admin_sessions').limit(1).get()
    .then(() => true)
    .catch(async () => {
      if (typeof db.createCollection !== 'function') return false;
      try { await db.createCollection('admin_sessions'); return true; }
      catch (err) { return /exists|已存在/i.test(String(err && err.message)); }
    });
}

async function resolveWechatAccount(openId) {
  if (!openId) return null;
  const bound = await db.collection('admin_accounts')
    .where({ wechatOpenId: openId, status: 'active' }).limit(1).get();
  const account = bound.data && bound.data[0];
  return account && ['owner', 'operations', 'finance'].includes(account.role) ? account : null;
}

async function createSceneQrImage(scene, page, context) {
  const envVersion = QR_ENV_VERSION;
  let buffer;
  if (context && context.OPENID && cloud.openapi && cloud.openapi.wxacode) {
    const code = await cloud.openapi.wxacode.getUnlimited({
      scene,
      page,
      checkPath: false,
      envVersion,
      width: 430
    });
    buffer = code && code.buffer;
  } else {
    const appId = String(process.env.MINIPROGRAM_APPID || 'wx6e685f787f1cd099').trim();
    const appSecret = String(process.env.MINIPROGRAM_APPSECRET || '').trim();
    if (!appSecret) throw new Error('请在 adminQrAuth 环境变量中配置 MINIPROGRAM_APPSECRET');
    buffer = await getUnlimitedWxacode({
      appId,
      appSecret,
      scene,
      page,
      checkPath: false,
      envVersion,
      width: 430
    });
  }
  return buffer ? `data:image/png;base64,${buffer.toString('base64')}` : '';
}

async function createQrImage(publicId, context) {
  return createSceneQrImage(`q=${publicId}`, CONFIRM_PAGE, context);
}

async function createQrLogin(context) {
  const values = createTicketValues();
  const requesterId = String(context.UID || context.OPENID || context.CLIENTIP || 'anonymous');
  await db.collection('admin_login_tickets').add({ data: {
    publicId: values.publicId,
    pollSecretHash: values.pollSecretHash,
    requesterId,
    status: 'pending',
    expiresAt: values.expiresAt,
    createTime: db.serverDate(),
    updateTime: db.serverDate()
  } });
  const qrDataUrl = await createQrImage(values.publicId, context);
  return {
    success: true,
    status: 'pending',
    publicId: values.publicId,
    pollSecret: values.pollSecret,
    expiresAt: values.expiresAt,
    scene: `q=${values.publicId}`,
    qrDataUrl,
    confirmPage: CONFIRM_PAGE
  };
}

// 为待领取的分销员邀请生成小程序码（scene: i=<token>，直达激活页）。
// 仅对有效待领取邀请开放；同版本二维码生成后缓存在邀请文档中，便于后台随时重新展示。
async function createInviteQrImage(token, context) {
  const inviteRes = await db.collection('agent_invites')
    .where({ tokenHash: hashValue(token), status: 'pending' }).limit(1).get().catch(() => ({ data: [] }));
  const invite = inviteRes.data && inviteRes.data[0];
  if (!invite) return { success: false, error: '邀请不存在、已使用或已撤销' };
  if (invite.expireTime && new Date(invite.expireTime) <= new Date()) {
    return { success: false, error: '邀请已过期，请重新生成' };
  }
  if (invite.qrDataUrl && invite.qrEnvVersion === QR_ENV_VERSION) {
    return { success: true, qrDataUrl: invite.qrDataUrl, inviteId: invite._id, cached: true };
  }
  const qrDataUrl = await createSceneQrImage(`i=${token}`, INVITE_PAGE, context);
  if (!qrDataUrl) return { success: false, error: '小程序码生成失败，请稍后重试' };
  await db.collection('agent_invites').doc(invite._id).update({
    data: { qrDataUrl, qrEnvVersion: QR_ENV_VERSION, qrCreateTime: db.serverDate() }
  });
  return { success: true, qrDataUrl, inviteId: invite._id };
}

async function inspectQrLogin(event, openId) {
  const publicId = parseScene(event.scene) || String(event.publicId || '');
  const ticket = await getTicket(publicId);
  const state = ticketState(ticket);
  if (state !== 'pending') return { success: false, status: state, error: state === 'expired' ? '二维码已过期' : '登录二维码不可用' };
  const account = await resolveWechatAccount(openId);
  if (!account) return {
    success: false,
    status: 'forbidden',
    error: '当前微信未绑定后台账号',
    selfOpenId: openId || ''
  };
  return { success: true, status: 'pending', publicId, account: publicAccount(account), expiresAt: ticket.expiresAt };
}

async function confirmQrLogin(event, openId) {
  const publicId = parseScene(event.scene) || String(event.publicId || '');
  const ticket = await getTicket(publicId);
  const state = ticketState(ticket);
  if (state !== 'pending') return { success: false, status: state, error: state === 'expired' ? '二维码已过期' : '登录二维码不可用' };
  const account = await resolveWechatAccount(openId);
  if (!account) return { success: false, status: 'forbidden', error: '当前微信未绑定后台账号' };
  const updateRes = await db.collection('admin_login_tickets').where({
    publicId,
    status: 'pending'
  }).update({ data: {
    status: 'confirmed',
    accountId: account._id,
    confirmedOpenIdHash: hashValue(openId),
    confirmTime: db.serverDate(),
    updateTime: db.serverDate()
  } });
  if (updatedCount(updateRes) !== 1) return { success: false, status: 'used', error: '二维码状态已变化，请返回后台刷新' };
  return { success: true, status: 'confirmed', account: publicAccount(account) };
}

async function pollQrLogin(event) {
  const publicId = String(event.publicId || '');
  const pollSecret = String(event.pollSecret || '');
  if (!publicId || !pollSecret) return { success: false, error: '轮询参数无效' };
  const ticket = await getTicket(publicId, pollSecret);
  const state = ticketState(ticket);
  if (state === 'pending') return { success: true, status: 'pending', expiresAt: ticket.expiresAt };
  if (state === 'expired') return { success: false, status: 'expired', error: '二维码已过期' };
  if (state === 'consumed') return { success: false, status: 'consumed', error: '二维码已使用' };
  if (state !== 'confirmed') return { success: false, status: state, error: '登录二维码不可用' };

  const accountRes = await db.collection('admin_accounts').doc(ticket.accountId).get().catch(() => null);
  const account = accountRes && accountRes.data;
  if (!account || account.status !== 'active' || !account.wechatOpenId ||
      hashValue(account.wechatOpenId) !== ticket.confirmedOpenIdHash) return { success: false, status: 'forbidden', error: '后台账号不可用' };

  let cloudbaseTicket = '';
  try {
    cloudbaseTicket = await Promise.resolve(createCustomLoginTicket(account._id));
  } catch (err) {
    // 后台业务权限由 adminToken + 服务端角色校验控制。自定义登录仅作为
    // 可选的传输身份增强，未配置或暂时不可用时沿用匿名登录即可。
    console.warn('[adminQrAuth] 自定义登录不可用，回退到匿名传输身份:', err && err.message);
  }

  const adminToken = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const exchanged = await db.runTransaction(async transaction => {
    const latestRes = await transaction.collection('admin_login_tickets').doc(ticket._id).get();
    const latest = latestRes && latestRes.data;
    if (ticketState(latest) !== 'confirmed') return false;
    const accountResult = await transaction.collection('admin_accounts').doc(account._id).get();
    const current = accountResult.data;
    if (!current || current.status !== 'active' || !current.wechatOpenId ||
        !['owner', 'operations', 'finance'].includes(current.role) ||
        hashValue(current.wechatOpenId) !== latest.confirmedOpenIdHash) return false;
    await transaction.collection('admin_sessions').add({ data: {
      tokenHash: hashValue(adminToken),
      accountId: account._id,
      role: account.role,
      source: 'wechat_qr',
      wechatOpenIdHash: latest.confirmedOpenIdHash,
      status: 'active',
      expiresAt,
      createTime: db.serverDate()
    } });
    await transaction.collection('admin_login_tickets').doc(ticket._id).update({ data: {
      status: 'consumed',
      consumeTime: db.serverDate(),
      updateTime: db.serverDate()
    } });
    return true;
  });
  if (!exchanged) return { success: false, status: 'consumed', error: '二维码已使用' };
  return {
    success: true,
    status: 'authenticated',
    cloudbaseTicket,
    authMode: cloudbaseTicket ? 'custom' : 'anonymous',
    adminToken,
    expiresAt,
    account: publicAccount(account)
  };
}

exports.main = async (event = {}) => {
  const context = cloud.getWXContext();
  try {
    switch (event.action) {
      case 'createQrLogin': {
        await ensureAdminLoginTicketsCollection();
        return await createQrLogin(context);
      }
      case 'inspectQrLogin': {
        await ensureAdminAccountsCollection();
        return await inspectQrLogin(event, context.OPENID);
      }
      case 'confirmQrLogin': {
        await ensureAdminAccountsCollection();
        await ensureAdminSessionsCollection();
        return await confirmQrLogin(event, context.OPENID);
      }
      case 'pollQrLogin': {
        await ensureAdminSessionsCollection();
        return await pollQrLogin(event);
      }
      case 'inviteQr': {
        const token = String(event.token || '').trim();
        if (!/^[A-Za-z0-9_-]{8,64}$/.test(token)) {
          return { success: false, error: '邀请参数无效' };
        }
        return await createInviteQrImage(token, context);
      }
      default: return { success: false, error: 'unknown action' };
    }
  } catch (err) {
    console.error('[adminQrAuth] 运行时错误:', err);
    return { success: false, error: (err && err.message) || '扫码登录服务异常' };
  }
};
