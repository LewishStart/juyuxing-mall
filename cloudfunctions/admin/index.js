'use strict';

const cloud = require('wx-server-sdk');
const { queryRefundStatus } = require('./refund-query');
const { applyRefundEffects } = require('./refund-effects');
const { createRefundExecutor } = require('./refund-execution');
const paymentDiagnostics = require('./payment-diagnostics');
const { loadPayApiConfig, directOrderQuery, directRefund } = require('./wxpay-direct');
const { createWithdrawalService } = require('./withdrawal-effects');
const transferClient = require('./wxpay-transfer');
const crypto = require('crypto');
const https = require('https');
const ENV_ID = 'cloud1-d4gx1jxk675274501';
const APP_ID = 'wx6e685f787f1cd099';
const APP_SECRET = String(process.env.MINIPROGRAM_APPSECRET || '').trim();
cloud.init({ env: ENV_ID });
const db = cloud.database();
const _ = db.command;
const withdrawals = createWithdrawalService(db, transferClient, console);
const refundExecutor = createRefundExecutor(cloud, db, console);

// ===== 微信 HTTP API 自触发（关键能力）=====
// 云开发支付的服务商模式订单，退款必须由「带小程序票据的调用」发起 cloudPay.refund。
// B 端网页（匿名登录）没有该票据；用 AppSecret 换 stable_token 后经
// api.weixin.qq.com/tcb/invokecloudfunction 触发的调用自带票据（SOURCE=wx_http，已实测可用）。
let wxTokenCache = null;

function wxHttpPostJson(url, body) {
  const payload = Buffer.from(JSON.stringify(body || {}));
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = https.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname + (urlObj.search || ''),
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
      timeout: 15000
    }, res => {
      const chunks = [];
      res.setEncoding('utf8');
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(chunks.join(''))); }
        catch (e) { reject(new Error('微信接口响应解析失败')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('微信接口请求超时')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function getWxStableToken() {
  if (!APP_SECRET) throw new Error('MINIPROGRAM_APPSECRET 未配置');
  if (wxTokenCache && wxTokenCache.expiresAt > Date.now()) return wxTokenCache.accessToken;
  const res = await wxHttpPostJson('https://api.weixin.qq.com/cgi-bin/stable_token', {
    grant_type: 'client_credential', appid: APP_ID, secret: APP_SECRET, force_refresh: false
  });
  if (!res.access_token) {
    throw new Error('stable_token 获取失败: ' + String(res.errcode || '') + ' ' + String(res.errmsg || ''));
  }
  const expiresIn = Math.max(300, Number(res.expires_in) || 7200);
  wxTokenCache = { accessToken: res.access_token, expiresAt: Date.now() + (expiresIn - 300) * 1000 };
  return res.access_token;
}

// 经微信 HTTP API 触发 admin 自身（返回被触发调用的结果对象）
async function invokeSelfViaWxHttp(action, data) {
  const token = await getWxStableToken();
  const url = 'https://api.weixin.qq.com/tcb/invokecloudfunction?env=' + ENV_ID +
    '&name=admin&access_token=' + encodeURIComponent(token);
  const res = await wxHttpPostJson(url, { action, ...data });
  if (res.errcode !== 0 || typeof res.resp_data !== 'string') {
    throw new Error('云函数自触发失败: ' + String(res.errcode || '') + ' ' + String(res.errmsg || ''));
  }
  try {
    return JSON.parse(res.resp_data);
  } catch (e) {
    throw new Error('云函数自触发返回解析失败');
  }
}

function updatedCount(result) {
  return result && result.stats ? result.stats.updated : result && result.updated;
}

function withTransaction(work) {
  return typeof db.runTransaction === 'function' ? db.runTransaction(work) : work(db);
}

const ROLE_PERMISSIONS = {
  owner: ['*'],
  operations: [
    'checkAdmin', 'me', 'dashboard', 'orderList', 'shipOrder', 'agentList', 'approveAgent',
    'inviteList', 'createInvite', 'revokeInvite', 'productList', 'createProduct', 'updateProduct',
    'toggleProductStatus', 'deleteProduct', 'cloneProduct', 'batchUpdateCategory', 'batchUpdateSort',
    'saveDraftProduct', 'getProductStats', 'exportProducts', 'inventoryList', 'adjustInventory',
    'bannerList', 'createBanner', 'updateBanner', 'toggleBanner', 'deleteBanner',
    'messageUsers', 'messageHistory', 'adminReply', 'getSettings', 'setFullReduction', 'changePassword', 'logout'
  ],
  finance: [
    'checkAdmin', 'me', 'dashboard', 'orderList', 'refundList', 'processRefund', 'executeRefund', 'retryRefund', 'queryRefundStatus',
    'withdrawalList', 'processWithdrawal', 'queryWithdrawalTransfer', 'financeOverview', 'getSettings', 'changePassword', 'logout'
  ]
};

function hasPermission(role, action) {
  const allowed = ROLE_PERMISSIONS[role] || [];
  return allowed.includes('*') || allowed.includes(action);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function createPasswordHash(password, salt) {
  const actualSalt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password || ''), actualSalt, 64).toString('hex');
  return `scrypt$${actualSalt}$${hash}`;
}

function verifyAccountPassword(password, stored) {
  if (!stored) return false;
  if (!stored.startsWith('scrypt$')) return verifyPassword(password, stored);
  const parts = stored.split('$');
  if (parts.length !== 3) return false;
  const actual = createPasswordHash(password, parts[1]);
  return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(stored));
}

async function ensureLegacyOwner(username, password, configData) {
  const existing = await db.collection('admin_accounts').where({ username }).limit(1).get().catch(() => ({ data: [] }));
  if (existing.data && existing.data[0]) return existing.data[0];
  if (username !== 'owner' || !configData.password || !verifyPassword(password, configData.password)) return null;
  const passwordHash = createPasswordHash(password);
  const result = await db.collection('admin_accounts').add({
    data: {
      username: 'owner', displayName: '店主', role: 'owner', status: 'active',
      passwordHash, mustChangePassword: false,
      migratedFromLegacy: true, createTime: db.serverDate(), updateTime: db.serverDate()
    }
  });
  return { _id: result._id, username: 'owner', displayName: '店主', role: 'owner', status: 'active', passwordHash };
}

async function authenticate(openId, adminToken, configData) {
  const adminOpenIds = configData.adminOpenIds || [];
  const legacyOpenId = configData.openId || '';
  if (openId && (openId === legacyOpenId || adminOpenIds.includes(openId))) {
    return { accountId: 'legacy-openid:' + openId, username: 'mini-admin', displayName: '小程序管理员', role: 'owner' };
  }
  if (!adminToken) return null;
  const sessionRes = await db.collection('admin_sessions')
    .where({ tokenHash: hashToken(adminToken), status: 'active' }).limit(1).get().catch(() => ({ data: [] }));
  const session = sessionRes.data && sessionRes.data[0];
  if (!session || !session.expiresAt || new Date(session.expiresAt) <= new Date()) return null;
  const accountRes = await db.collection('admin_accounts').doc(session.accountId).get().catch(() => null);
  const account = accountRes && accountRes.data;
  if (!account || account.status !== 'active') return null;
  return { accountId: account._id, username: account.username, displayName: account.displayName || account.username, role: account.role };
}

async function generateReferralCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 20; attempt++) {
    const random = Array.from({ length: 8 }, () => chars[crypto.randomInt(chars.length)]).join('');
    const code = 'JY' + random;
    const exists = await db.collection('users').where({ referralCode: code }).count();
    if (exists.total === 0) return code;
  }
  throw new Error('推广码生成失败');
}

function createOutRefundNo(refundId) {
  return 'RF' + crypto.createHash('sha256').update(String(refundId || '')).digest('hex').slice(0, 30);
}

// 密码哈希：SHA-256
function hashPassword(pwd) {
  return crypto.createHash('sha256').update(String(pwd || '')).digest('hex');
}

// 校验密码：同时兼容明文旧密码与已哈希的密码
function verifyPassword(inputPwd, storedPwd) {
  if (!storedPwd) return false;
  if (inputPwd === storedPwd) return true;
  try {
    return hashPassword(inputPwd) === storedPwd;
  } catch (e) {
    return false;
  }
}

function normalizeSpecs(specs, fallbackStock, existingSpecs) {
  const existing = Array.isArray(existingSpecs) ? existingSpecs : [];
  const source = Array.isArray(specs) && specs.length ? specs : [{ name: '默认规格', stock: fallbackStock }];
  return source.map(spec => {
    const old = existing.find(item => item.name === spec.name) || {};
    return {
      ...spec,
      name: String(spec.name || '默认规格').trim(),
      stock: Math.max(0, Number(spec.stock) || 0),
      reservedStock: Math.max(0, Number(old.reservedStock) || Number(spec.reservedStock) || 0)
    };
  });
}

const TRANSACTION_COLLECTIONS = [
  'inventory_reservations',
  'refunds',
  'commissions',
  'withdrawals',
  'cashflow_entries',
  'orders'
];

async function listAllDocuments(collectionName, max = 5000) {
  return listQueryDocuments(collectionName, {}, max);
}

async function listQueryDocuments(collectionName, query, max = 5000) {
  const pageSize = 100;
  const data = [];
  for (let offset = 0; offset < max; offset += pageSize) {
    const res = await db.collection(collectionName).where(query).skip(offset).limit(pageSize).get()
      .catch(() => ({ data: [] }));
    const page = res.data || [];
    data.push(...page);
    if (page.length < pageSize) break;
  }
  if (data.length >= max) throw new Error(`${collectionName} 数据量超过安全清理上限 ${max}`);
  return data;
}

async function buildTransactionCleanupSnapshot() {
  const collections = {};
  const lists = await Promise.all(TRANSACTION_COLLECTIONS.map(name => listAllDocuments(name)));
  TRANSACTION_COLLECTIONS.forEach((name, index) => { collections[name] = lists[index]; });
  const orderIds = new Set((collections.orders || []).map(order => order._id));
  const [userCoupons, inventoryAdjustments, products] = await Promise.all([
    listAllDocuments('user_coupons'),
    listAllDocuments('inventory_adjustments'),
    listAllDocuments('products')
  ]);
  const couponsToReset = userCoupons.filter(item => item.orderId && orderIds.has(item.orderId));
  const adjustmentsToDelete = inventoryAdjustments.filter(item => item.orderId && orderIds.has(item.orderId));
  const productsToUnlock = products.filter(product =>
    (Number(product.reservedStock) || 0) !== 0 ||
    (product.specs || []).some(spec => (Number(spec.reservedStock) || 0) !== 0)
  );
  return {
    collections,
    couponsToReset,
    adjustmentsToDelete,
    productsToUnlock,
    counts: {
      orders: collections.orders.length,
      inventoryReservations: collections.inventory_reservations.length,
      refunds: collections.refunds.length,
      commissions: collections.commissions.length,
      withdrawals: collections.withdrawals.length,
      cashflowEntries: collections.cashflow_entries.length,
      inventoryAdjustments: adjustmentsToDelete.length,
      couponsToReset: couponsToReset.length,
      productsToUnlock: productsToUnlock.length
    }
  };
}

async function runInChunks(items, task, size = 20) {
  for (let index = 0; index < items.length; index += size) {
    await Promise.all(items.slice(index, index + size).map(task));
  }
}

async function removeDocuments(collectionName, documents) {
  await runInChunks(documents, item => db.collection(collectionName).doc(item._id).remove());
  return documents.length;
}

// ===== 一键退款：审批通过后直接执行退款，无需手机端二次操作 =====
// 双通道设计（云开发支付订单为 CloudBase 服务商模式，直连 API 查不到此类订单）：
//  通道一 cloud.cloudPay.refund —— 覆盖云开发支付订单；要求调用方带云调用票据（B 端网页登录态）
//  通道二 商户直连 API —— 覆盖直连模式订单；用商户自己的 APIv2 密钥 + 证书
// 安全设计：
//  1) 提交微信前先落痕 submittedAt —— 网络结果未知时只允许只读查询核对，禁止盲目重试；
//  2) 微信退款 API 按退款单号幂等，同一 outRefundNo 重复提交不会重复扣款；
//  3) 渠道受理成功后事务入账（refund-effects 幂等）；失败转 manual_review 并保留原因。
async function executeApprovedRefundDirect(refundId) {
  return refundExecutor.execute(refundId, true);
}

exports.main = async (event, context) => {
  try {
  const { OPENID } = cloud.getWXContext();
  const action = event.action || 'dashboard';
  const adminToken = event.adminToken || '';

  // 分销员本人领取已审核的微信转账：只返回本人单据的临时确认参数。
  // 此入口必须在后台账号鉴权之前，否则 C 端无法拉起微信官方收款确认页。
  if (action === 'getOwnWithdrawalTransfer') {
    return await withdrawals.getOwn(String(event.withdrawalId || '').trim(), OPENID);
  }

  // ===== 登录接口：不需要管理员权限验证 =====
  if (action === 'login') {
    const username = String(event.username || 'owner').trim().toLowerCase();
    const { password } = event;
    const loginRes = await db.collection('admin_config').doc('admin').get().catch(() => null);
    const configData = (loginRes && loginRes.data) || {};
    let accountRes = await db.collection('admin_accounts').where({ username }).limit(1).get().catch(() => ({ data: [] }));
    let account = accountRes.data && accountRes.data[0];
    if (!account) account = await ensureLegacyOwner(username, password, configData);
    if (!account || account.status !== 'active' || !verifyAccountPassword(password, account.passwordHash)) {
      return { success: false, error: '账号或密码错误' };
    }
    const token = crypto.randomBytes(32).toString('hex');
    const expireTime = new Date();
    expireTime.setHours(expireTime.getHours() + 24);
    await db.collection('admin_sessions').add({
      data: {
        tokenHash: hashToken(token), accountId: account._id, role: account.role,
        status: 'active', expiresAt: expireTime, createTime: db.serverDate()
      }
    });
    return { success: true, token, account: { username: account.username, displayName: account.displayName, role: account.role } };
  }

  // ===== 验证管理员身份：支持小程序 OPENID 和 Web token 两种方式 =====
  const adminRes = await db.collection('admin_config').doc('admin').get().catch(() => null);
  const configData = (adminRes && adminRes.data) || {};
  const legacyOpenId = configData.openId || '';
  const actor = await authenticate(OPENID, adminToken, configData);
  const isAdmin = !!actor;
  if (!actor) {
    return { success: false, error: '无管理员权限' };
  }

  if (!hasPermission(actor.role, action)) {
    return { success: false, error: '当前角色无此操作权限', code: 'FORBIDDEN' };
  }

  // ===== 轻量级权限检查：不做任何数据库查询，只返回是否是管理员 =====
  if (action === 'checkAdmin') {
    return { success: true, account: actor };
  }
  if (action === 'me') {
    return { success: true, account: actor, permissions: ROLE_PERMISSIONS[actor.role] || [] };
  }
  if (action === 'logout') {
    if (adminToken) {
      await db.collection('admin_sessions').where({ tokenHash: hashToken(adminToken), status: 'active' }).update({
        data: { status: 'revoked', revokeTime: db.serverDate() }
      });
    }
    return { success: true };
  }

  switch (action) {

    case 'accountList': {
      const res = await db.collection('admin_accounts').orderBy('createTime', 'asc').limit(100).get();
      return { success: true, data: (res.data || []).map(account => ({
        _id: account._id, username: account.username, displayName: account.displayName,
        role: account.role, status: account.status, createTime: account.createTime,
        wechatBound: !!account.wechatOpenId
      })) };
    }

    case 'createAccount': {
      const username = String(event.username || '').trim().toLowerCase();
      const password = String(event.password || '');
      const role = String(event.role || '');
      if (!/^[a-z0-9._-]{3,32}$/.test(username)) return { success: false, error: '账号格式不正确' };
      if (password.length < 8) return { success: false, error: '密码至少 8 位' };
      if (!['owner', 'operations', 'finance'].includes(role)) return { success: false, error: '角色无效' };
      const exists = await db.collection('admin_accounts').where({ username }).count();
      if (exists.total > 0) return { success: false, error: '账号已存在' };
      const result = await db.collection('admin_accounts').add({ data: {
        username, displayName: String(event.displayName || username).trim(), role, status: 'active',
        passwordHash: createPasswordHash(password), mustChangePassword: true,
        createTime: db.serverDate(), updateTime: db.serverDate(), createdBy: actor.accountId
      } });
      return { success: true, accountId: result._id };
    }

    case 'updateAccount': {
      if (!event.id) return { success: false, error: '账号ID不能为空' };
      if (event.id === actor.accountId && event.status === 'disabled') return { success: false, error: '不能停用当前账号' };
      const data = { updateTime: db.serverDate() };
      if (event.displayName !== undefined) data.displayName = String(event.displayName).trim();
      if (event.role !== undefined) {
        if (!['owner', 'operations', 'finance'].includes(event.role)) return { success: false, error: '角色无效' };
        data.role = event.role;
      }
      if (event.status !== undefined) {
        if (!['active', 'disabled'].includes(event.status)) return { success: false, error: '状态无效' };
        data.status = event.status;
      }
      if (event.password) {
        if (String(event.password).length < 8) return { success: false, error: '密码至少 8 位' };
        data.passwordHash = createPasswordHash(event.password);
        data.mustChangePassword = true;
      }
      await db.collection('admin_accounts').doc(event.id).update({ data });
      return { success: true };
    }

    case 'inviteList': {
      const status = event.status || '';
      const query = status ? { status } : {};
      const res = await db.collection('agent_invites').where(query).orderBy('createTime', 'desc').limit(100).get();
      return { success: true, data: res.data || [] };
    }

    case 'createInvite': {
      // 12 字节 → 16 字符 base64url；配合小程序码 scene "i=<token>"（18 字符）不超微信 32 字符限制
      const token = crypto.randomBytes(12).toString('base64url');
      const expireTime = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const result = await db.collection('agent_invites').add({ data: {
        tokenHash: hashToken(token), tokenPreview: token.slice(-6), status: 'pending',
        name: String(event.name || '').trim(), phone: String(event.phone || '').trim(),
        expireTime, createTime: db.serverDate(), createdBy: actor.accountId
      } });
      return {
        success: true, inviteId: result._id, expireTime,
        invitePath: `/subpackages/distributor/bind/bind?token=${encodeURIComponent(token)}`
      };
    }

    case 'revokeInvite': {
      const inviteRes = await db.collection('agent_invites').doc(event.id).get().catch(() => null);
      if (!inviteRes || !inviteRes.data || inviteRes.data.status !== 'pending') return { success: false, error: '邀请不存在或已使用' };
      await db.collection('agent_invites').doc(event.id).update({
        data: { status: 'revoked', revokeTime: db.serverDate(), revokedBy: actor.accountId }
      });
      return { success: true };
    }

    case 'financeOverview': {
      const startTime = event.startTime ? new Date(event.startTime) : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
      const endTime = event.endTime ? new Date(event.endTime) : new Date();
      const entries = await listQueryDocuments('cashflow_entries', { status: 'posted' });
      const byDay = {};
      let receipts = 0;
      let refunds = 0;
      let commissionPaid = 0;
      for (const entry of entries.filter(item => {
        const time = item.createTime ? new Date(item.createTime) : null;
        return time && time >= startTime && time <= endTime;
      })) {
        const amount = Number(entry.amount) || 0;
        if (entry.type === 'sale_receipt') receipts += amount;
        if (entry.type === 'refund') refunds += amount;
        if (entry.type === 'commission_payout') commissionPaid += amount;
        const day = entry.createTime ? new Date(entry.createTime).toISOString().slice(0, 10) : 'unknown';
        if (!byDay[day]) byDay[day] = { date: day, receipts: 0, refunds: 0, commissionPaid: 0, net: 0 };
        if (entry.type === 'sale_receipt') byDay[day].receipts += amount;
        if (entry.type === 'refund') byDay[day].refunds += amount;
        if (entry.type === 'commission_payout') byDay[day].commissionPaid += amount;
        byDay[day].net += entry.direction === 'out' ? -amount : amount;
      }
      const commissions = await listQueryDocuments('commissions', { status: _.in(['frozen', 'settled', 'withdrawing']) });
      const frozenLiability = commissions.filter(item => item.status === 'frozen').reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
      const payableLiability = commissions.filter(item => ['settled', 'withdrawing'].includes(item.status)).reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
      return {
        success: true,
        data: {
          receipts, refunds, commissionPaid, netCashflow: receipts - refunds - commissionPaid,
          frozenLiability, payableLiability,
          daily: Object.values(byDay).sort((a, b) => a.date.localeCompare(b.date))
        }
      };
    }

    case 'inventoryList': {
      const products = await db.collection('products').orderBy('createTime', 'desc').limit(500).get();
      const data = (products.data || []).map(product => ({
        _id: product._id, name: product.name, status: product.status,
        stock: Number(product.stock) || 0, reservedStock: Number(product.reservedStock) || 0,
        availableStock: (Number(product.stock) || 0) - (Number(product.reservedStock) || 0),
        lowStock: ((Number(product.stock) || 0) - (Number(product.reservedStock) || 0)) <= (Number(product.lowStockThreshold) || 10),
        specs: (product.specs || []).map(spec => ({
          name: spec.name, stock: Number(spec.stock) || 0, reservedStock: Number(spec.reservedStock) || 0,
          availableStock: (Number(spec.stock) || 0) - (Number(spec.reservedStock) || 0)
        }))
      }));
      return { success: true, data };
    }

    case 'adjustInventory': {
      const quantity = Number(event.quantity);
      if (!event.productId || !Number.isInteger(quantity) || quantity === 0) return { success: false, error: '库存调整参数无效' };
      if (!String(event.reason || '').trim()) return { success: false, error: '请填写调整原因' };
      const productRes = await db.collection('products').doc(event.productId).get().catch(() => null);
      const product = productRes && productRes.data;
      if (!product) return { success: false, error: '商品不存在' };
      const specs = Array.isArray(product.specs) ? product.specs.map(spec => ({ ...spec })) : [];
      if (event.spec) {
        const index = specs.findIndex(spec => spec.name === event.spec);
        if (index < 0) return { success: false, error: '规格不存在' };
        if ((Number(specs[index].stock) || 0) + quantity < (Number(specs[index].reservedStock) || 0)) return { success: false, error: '调整后库存不能低于锁定库存' };
        specs[index].stock = (Number(specs[index].stock) || 0) + quantity;
      }
      const nextStock = (Number(product.stock) || 0) + quantity;
      if (nextStock < (Number(product.reservedStock) || 0)) return { success: false, error: '调整后库存不能低于锁定库存' };
      await db.collection('products').doc(product._id).update({ data: { stock: nextStock, specs, updateTime: db.serverDate() } });
      await db.collection('inventory_adjustments').add({ data: {
        productId: product._id, productName: product.name, spec: event.spec || '', quantity,
        beforeStock: Number(product.stock) || 0, afterStock: nextStock,
        reason: String(event.reason).trim(), operatorId: actor.accountId, createTime: db.serverDate()
      } });
      return { success: true, stock: nextStock };
    }

    case 'migrationPreview': {
      const [users, products, orders, commissions, withdrawals, refunds] = await Promise.all([
        db.collection('users').limit(1000).get().catch(() => ({ data: [] })),
        db.collection('products').limit(1000).get().catch(() => ({ data: [] })),
        db.collection('orders').limit(1000).get().catch(() => ({ data: [] })),
        db.collection('commissions').limit(1000).get().catch(() => ({ data: [] })),
        db.collection('withdrawals').limit(1000).get().catch(() => ({ data: [] })),
        db.collection('refunds').limit(1000).get().catch(() => ({ data: [] }))
      ]);
      return { success: true, data: {
        agentsNeedingCode: (users.data || []).filter(user => user.isAgent && !user.referralCode).length,
        productsNeedingInventoryFields: (products.data || []).filter(product => product.reservedStock === undefined).length,
        legacyClosedOrders: (orders.data || []).filter(order => order.status === 'cancelled').length,
        legacyCommissions: (commissions.data || []).filter(item => !item.type || !item.idempotencyKey).length,
        legacyWithdrawals: (withdrawals.data || []).filter(item => !item.idempotencyKey).length,
        legacyRefunds: (refunds.data || []).filter(item => !item.idempotencyKey).length
      } };
    }

    case 'runMigration': {
      if (event.confirm !== 'MIGRATE_ABC_V1') return { success: false, error: '迁移确认码不正确' };
      const result = { agents: 0, products: 0, orders: 0, commissions: 0, withdrawals: 0, refunds: 0, cashflows: 0 };
      const users = await db.collection('users').limit(1000).get().catch(() => ({ data: [] }));
      for (const user of users.data || []) {
        if (user.isAgent && !user.referralCode) {
          await db.collection('users').doc(user._id).update({ data: { referralCode: await generateReferralCode(), updateTime: db.serverDate() } });
          result.agents++;
        }
      }
      const products = await db.collection('products').limit(1000).get().catch(() => ({ data: [] }));
      for (const product of products.data || []) {
        if (product.reservedStock === undefined || (product.specs || []).some(spec => spec.reservedStock === undefined)) {
          await db.collection('products').doc(product._id).update({ data: {
            reservedStock: Number(product.reservedStock) || 0,
            specs: (product.specs || []).map(spec => ({ ...spec, reservedStock: Number(spec.reservedStock) || 0 })),
            updateTime: db.serverDate()
          } });
          result.products++;
        }
      }
      const orders = await db.collection('orders').limit(1000).get().catch(() => ({ data: [] }));
      for (const order of orders.data || []) {
        if (order.status === 'cancelled' || (order.status === 'pending' && !order.expireTime)) {
          await db.collection('orders').doc(order._id).update({ data: {
            status: 'closed', closeReason: 'abc_v1_migration', closeTime: db.serverDate(),
            inventoryStatus: order.inventoryStatus || 'released', updateTime: db.serverDate()
          } });
          result.orders++;
        }
        if (['paid', 'shipped', 'received', 'refunding', 'refunded'].includes(order.status)) {
          const key = 'payment:' + order._id;
          const exists = await db.collection('cashflow_entries').where({ idempotencyKey: key }).count();
          if (exists.total === 0) {
            await db.collection('cashflow_entries').add({ data: {
              idempotencyKey: key, type: 'sale_receipt', direction: 'in', amount: Number(order.totalFee) || 0,
              orderId: order._id, orderNo: order.orderNo, source: 'abc_v1_migration',
              status: 'posted', createTime: order.payTime || order.createTime || db.serverDate()
            } });
            result.cashflows++;
          }
        }
      }
      const commissions = await db.collection('commissions').limit(1000).get().catch(() => ({ data: [] }));
      for (const commission of commissions.data || []) {
        if (commission.type && commission.idempotencyKey) continue;
        const order = (orders.data || []).find(item => item._id === commission.orderId);
        let status = commission.status;
        if (status === 'refunded') status = 'cancelled';
        if (status === 'pending') status = 'frozen';
        if (status === 'settled' && order && order.status !== 'received') status = 'frozen';
        await db.collection('commissions').doc(commission._id).update({ data: {
          type: commission.type || 'earning', idempotencyKey: `commission:${commission.orderId}:${commission._id}`,
          status, updateTime: db.serverDate()
        } });
        result.commissions++;
      }
      const withdrawals = await db.collection('withdrawals').limit(1000).get().catch(() => ({ data: [] }));
      for (const withdrawal of withdrawals.data || []) {
        if (withdrawal.idempotencyKey) continue;
        await db.collection('withdrawals').doc(withdrawal._id).update({ data: {
          idempotencyKey: `legacy_withdrawal:${withdrawal._id}`,
          requestId: withdrawal.requestId || `legacy_${withdrawal._id}`,
          updateTime: db.serverDate()
        } });
        result.withdrawals++;
      }
      const refunds = await db.collection('refunds').limit(1000).get().catch(() => ({ data: [] }));
      for (const refund of refunds.data || []) {
        if (refund.idempotencyKey) continue;
        await db.collection('refunds').doc(refund._id).update({ data: {
          idempotencyKey: `legacy_refund:${refund._id}`,
          updateTime: db.serverDate()
        } });
        result.refunds++;
      }
      return { success: true, data: result };
    }

    case 'transactionCleanupPreview': {
      if (actor.role !== 'owner') return { success: false, error: '仅店主可以清理测试交易数据', code: 'FORBIDDEN' };
      const snapshot = await buildTransactionCleanupSnapshot();
      return { success: true, data: snapshot.counts };
    }

    case 'purgeTestTransactions': {
      if (actor.role !== 'owner') return { success: false, error: '仅店主可以清理测试交易数据', code: 'FORBIDDEN' };
      if (event.confirm !== 'PURGE_TEST_TRANSACTIONS') {
        return { success: false, error: '清理确认码不正确' };
      }
      const snapshot = await buildTransactionCleanupSnapshot();
      const expectedOrderCount = Number(event.expectedOrderCount);
      if (!Number.isInteger(expectedOrderCount) || expectedOrderCount !== snapshot.counts.orders) {
        return { success: false, error: '订单数量已变化，请重新预检后再清理', code: 'STALE_PREVIEW' };
      }

      await runInChunks(snapshot.couponsToReset, coupon => db.collection('user_coupons').doc(coupon._id).update({
        data: { status: 'unused', orderId: null, useTime: null, updateTime: db.serverDate() }
      }));
      await runInChunks(snapshot.productsToUnlock, product => db.collection('products').doc(product._id).update({
        data: {
          reservedStock: 0,
          specs: (product.specs || []).map(spec => ({ ...spec, reservedStock: 0 })),
          updateTime: db.serverDate()
        }
      }));
      await removeDocuments('inventory_adjustments', snapshot.adjustmentsToDelete);
      for (const collectionName of TRANSACTION_COLLECTIONS) {
        await removeDocuments(collectionName, snapshot.collections[collectionName]);
      }
      return { success: true, data: snapshot.counts };
    }

    case 'dashboard': {
      // 看板查询互不依赖，并发执行，避免数据库往返耗时累加。
      const [
        totalOrders, paidOrders, shippedOrders, allOrders,
        pendingAgents, pendingWithdrawals, pendingRefunds, recentOrders
      ] = await Promise.all([
        db.collection('orders').count().catch(() => ({ total: 0 })),
        db.collection('orders').where({ status: 'paid' }).count().catch(() => ({ total: 0 })),
        db.collection('orders').where({ status: 'shipped' }).count().catch(() => ({ total: 0 })),
        listQueryDocuments('orders', { status: _.in(['paid', 'shipped', 'received']) }),
        db.collection('users').where({ 'agentInfo.status': 'pending' }).count().catch(() => ({ total: 0 })),
        db.collection('withdrawals').where({ status: 'pending' }).count().catch(() => ({ total: 0 })),
        db.collection('refunds').where({ status: _.in(['pending', 'pending_auto', 'processing', 'channel_processing', 'manual_review']) }).count().catch(() => ({ total: 0 })),
        db.collection('orders').orderBy('createTime', 'desc').limit(10).get().catch(() => ({ data: [] }))
      ]);

      const totalSales = allOrders.reduce((s, o) => s + (o.totalFee || 0), 0);

      return {
        success: true,
        account: actor,
        recentOrders: recentOrders.data || [],
        stats: {
          totalOrders: totalOrders.total,
          paidOrders: paidOrders.total,
          shippedOrders: shippedOrders.total,
          totalSales,
          pendingAgents: pendingAgents.total,
          pendingWithdrawals: pendingWithdrawals.total,
          pendingRefunds: pendingRefunds.total
        }
      };
    }

    case 'orderList': {
      const pageSize = event.pageSize || 50;
      const page = event.page || 1;
      const status = event.status || '';
      let query = {};
      if (status) query.status = status;
      const res = await db.collection('orders')
        .where(query)
        .orderBy('createTime', 'desc')
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .get();
      return { success: true, data: res.data };
    }

    case 'shipOrder': {
      // 发货：更新订单状态 + 添加物流信息
      const { orderId, company, trackingNo } = event;
      const normalizedCompany = String(company || '').trim();
      const normalizedTrackingNo = String(trackingNo || '').trim();
      if (!orderId || !normalizedCompany || !normalizedTrackingNo) {
        return { success: false, error: '请填写完整的物流信息' };
      }
      const orderRes = await db.collection('orders').doc(orderId).get().catch(() => null);
      const order = orderRes && orderRes.data;
      if (!order) {
        return { success: false, error: '订单不存在' };
      }
      if (order.status !== 'paid') {
        return { success: false, error: '只有已支付订单可以发货' };
      }
      const updateRes = await db.collection('orders').where({ _id: orderId, status: 'paid' }).update({
        data: {
          status: 'shipped',
          // 历史订单 logistics 为 null：嵌套对象更新会报 Cannot create field in element null，
          // 用 _.set 整体替换字段，兼容 null / 缺失 / 已有对象三种情况
          logistics: _.set({ company: normalizedCompany, trackingNo: normalizedTrackingNo, status: '已发货' }),
          shipTime: db.serverDate(),
          autoReceiveTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          updateTime: db.serverDate()
        }
      });
      if (updatedCount(updateRes) !== 1) {
        return { success: false, error: '发货状态更新失败，请重试' };
      }
      return { success: true, message: '已标记为发货' };
    }

    case 'agentList': {
      // 获取代理列表，支持状态筛选。只列真正的分销员（isAgent=true），
      // 普通用户注册时 login 会写入空壳 agentInfo，不能混进代理管理。
      const statusFilter = event.statusFilter || 'pending';
      const query = { isAgent: true };
      if (statusFilter !== 'all') {
        query['agentInfo.status'] = statusFilter;
      }
      const res = await db.collection('users')
        .where(query)
        .orderBy('createTime', 'desc')
        .limit(100)
        .get();
      return { success: true, data: res.data };
    }

    case 'approveAgent': {
      const { userId, approve } = event;
      if (approve) {
        const userRes = await db.collection('users').doc(userId).get().catch(() => null);
        if (!userRes || !userRes.data) return { success: false, error: '用户不存在' };
        const referralCode = userRes.data.referralCode || await generateReferralCode();
        await db.collection('users').doc(userId).update({
          data: {
            isAgent: true,
            referralCode,
            'agentInfo.level': '一级分销员',
            'agentInfo.status': 'active',
            'agentInfo.activateTime': db.serverDate()
          }
        });
      } else {
        await db.collection('users').doc(userId).update({
          data: {
            isAgent: false,
            'agentInfo.status': 'rejected'
          }
        });
      }
      return { success: true };
    }

    case 'withdrawalList': {
      // 获取提现列表，支持状态筛选
      const statusFilter = event.statusFilter || 'pending';
      let query = {};
      if (statusFilter !== 'all') {
        query.status = statusFilter;
      }
      const res = await db.collection('withdrawals')
        .where(query)
        .orderBy('createTime', 'desc')
        .limit(100)
        .get();
      return { success: true, data: res.data };
    }

    case 'processWithdrawal':
      return await withdrawals.processRequest(event);

    case 'queryWithdrawalTransfer':
      return await withdrawals.query(event.withdrawalId);

    case 'queryRefundStatus':
      return queryRefundStatus(cloud, db, event.refundId);

    case 'refundList': {
      // 获取退款列表，支持状态筛选
      const statusFilter = event.statusFilter || 'pending';
      let query = {};
      if (statusFilter === 'pending') {
        // 未完成退款始终保留在待处理列表。
        query.status = _.in(['pending', 'pending_auto', 'processing', 'channel_processing', 'manual_review']);
      } else if (statusFilter !== 'all') {
        query.status = statusFilter;
      }
      const res = await db.collection('refunds')
        .where(query)
        .orderBy('createTime', 'desc')
        .limit(100)
        .get();
      // 补充订单信息
      const refunds = res.data;
      for (const rf of refunds) {
        const ordRes = await db.collection('orders').doc(rf.orderId).get().catch(() => null);
        rf.order = ordRes && ordRes.data ? ordRes.data : null;
      }
      return { success: true, data: refunds };
    }

    case 'processRefund': {
      // 处理退款申请（通过/拒绝）
      const { refundId, approve, adminNote } = event;
      if (typeof approve !== 'boolean' || typeof refundId !== 'string' || !refundId.trim()) return { success: false, error: '退款参数无效' };
      if (typeof db.runTransaction !== 'function') return { success: false, error: '退款需要数据库事务支持' };
      const rfRes = await db.collection('refunds').doc(refundId).get();
      const rf = rfRes.data;
      if (!rf) return { success: false, error: '退款记录不存在' };
      if (rf.status === (approve ? 'approved' : 'rejected')) {
        return { success: true, alreadyProcessed: true, message: approve ? '该退款已处理' : '该退款已拒绝' };
      }
      if (rf.status !== 'pending') return { success: false, error: '该退款申请已处理' };

      if (!approve) {
        return await withTransaction(async transaction => {
          const latestRefundRes = await transaction.collection('refunds').doc(refundId).get();
          const latestRefund = latestRefundRes.data;
          if (!latestRefund) return { success: false, error: '退款记录不存在' };
          if (latestRefund.status === 'rejected') return { success: true, alreadyProcessed: true, message: '该退款已拒绝' };
          if (latestRefund.status !== 'pending') return { success: false, error: '该退款申请已处理' };
          await transaction.collection('refunds').doc(refundId).update({
            data: { status: 'rejected', adminNote: adminNote || '', processTime: db.serverDate() }
          });
          await transaction.collection('orders').doc(latestRefund.orderId).update({
            data: { status: latestRefund.prevStatus || 'paid', refundId: '', updateTime: db.serverDate() }
          });
          return { success: true, message: '已拒绝退款' };
        });
      }

      // ===== 同意退款 =====
      // 获取订单信息
      const orderRes = await db.collection('orders').doc(rf.orderId).get().catch(() => null);
      const order = orderRes && orderRes.data;
      if (!order) return { success: false, error: '关联订单不存在' };
      if (!['refund_only', 'return_refund'].includes(rf.type)) return { success: false, error: '退款类型无效，请核对售后单' };
      if (rf.type === 'return_refund' && !event.returnReceived) {
        return { success: false, error: '退货退款必须先确认已收到退回商品' };
      }
      const shouldRestock = rf.type === 'refund_only' ? true : !!event.restock;
      const isMockPayment = order.paymentSource === 'mockPay' || String(order.transactionId || '').startsWith('MOCK_TXN_');

      if (!order.transactionId && !isMockPayment) {
        return {
          success: false,
          error: '订单缺少微信支付交易号，已阻止自动退款；请先核查支付记录'
        };
      }

      let subMchId = '';
      if (!isMockPayment) {
        const payConfig = await db.collection('pay_config').doc('default').get();
        subMchId = String((payConfig.data && payConfig.data.subMchId) || '').trim();
        if (!subMchId) return { success: false, error: '微信支付商户号未配置，无法发起退款' };
      }
      // Approval, rejection and mock completion compete within the same transaction.
      const approvalResult = await db.runTransaction(async transaction => {
        const latestRefund = (await transaction.collection('refunds').doc(refundId).get()).data;
        if (!latestRefund || latestRefund.status !== 'pending') {
          return { success: false, error: '该退款申请已处理，请刷新状态' };
        }
        const latestOrder = (await transaction.collection('orders').doc(latestRefund.orderId).get()).data;
        if (!latestOrder || latestOrder.status !== 'refunding' ||
            (latestOrder.refundId && latestOrder.refundId !== refundId) ||
            latestOrder.totalFee !== order.totalFee || latestOrder.transactionId !== order.transactionId) {
          return { success: false, error: '订单状态已变化，请重新核对' };
        }
        if (!Number.isSafeInteger(latestOrder.totalFee) || latestOrder.totalFee <= 0) {
          return { success: false, error: '订单金额无效' };
        }
        const data = {
          status: isMockPayment ? 'approved' : 'pending_auto',
          outRefundNo: latestRefund.outRefundNo || createOutRefundNo(refundId),
          approvedAmount: latestOrder.totalFee, subMchId, executionVersion: 2,
          restock: shouldRestock, adminNote: adminNote || '',
          returnStatus: latestRefund.type === 'return_refund' ? 'received' : (latestRefund.returnStatus || ''),
          processAttempts: 0, processTime: db.serverDate()
        };
        if (isMockPayment) {
          await applyRefundEffects(transaction, db, latestOrder, latestRefund, shouldRestock);
          Object.assign(data, { refundChannel: 'mock', refundTime: db.serverDate() });
        }
        await transaction.collection('refunds').doc(refundId).update({ data });
        return { success: true };
      });
      if (!approvalResult.success) return approvalResult;
      if (isMockPayment) {
        return { success: true, message: '模拟支付退款已完成（无真实资金）' };
      }
      // ===== 一键退款 =====
      // B 端网页调用没有小程序票据（cloudPay 会报 -501001），
      // 先经微信 HTTP API 自触发一次（带票据上下文）执行退款；失败再回退当前上下文双通道。
      if (APP_SECRET) {
        try {
          const execResult = await invokeSelfViaWxHttp('executeRefund', { adminToken, refundId });
          if (execResult && typeof execResult === 'object') return execResult;
        } catch (err) {
          paymentDiagnostics.event(console, 'refund.self_invoke_uncertain', { id: refundId, code: err.code });
        }
      }
      return await executeApprovedRefundDirect(refundId);
    }

    case 'executeRefund': {
      // 由 processRefund / retryRefund 经微信 HTTP API 自触发（上下文带小程序票据，cloudPay 可用）。
      // 鉴权走常规 adminToken 通道；权限归入 processRefund 同组。
      const refundId = String(event.refundId || '').trim();
      if (!refundId) return { success: false, error: '退款参数无效' };
      return await executeApprovedRefundDirect(refundId);
    }

    case 'retryRefund': {
      // 重试「待人工核查」的退款（如商户余额不足被微信拒绝后，充值完毕再试）。
      // 微信退款 API 按 outRefundNo 幂等：同一退款单号重复提交不会重复扣款。
      const refundId = String(event.refundId || '').trim();
      if (!refundId) return { success: false, error: '退款参数无效' };
      const rfRes = await db.collection('refunds').doc(refundId).get().catch(() => null);
      const rf = rfRes && rfRes.data;
      if (!rf) return { success: false, error: '退款记录不存在' };
      if (!['manual_review', 'pending_auto', 'processing', 'channel_processing'].includes(rf.status)) {
        return { success: false, error: '当前状态（' + rf.status + '）无需重试' };
      }
      if (APP_SECRET) {
        try {
          const execResult = await invokeSelfViaWxHttp('executeRefund', { adminToken, refundId });
          if (execResult && typeof execResult === 'object') return execResult;
        } catch (err) {
          paymentDiagnostics.event(console, 'refund.self_retry_uncertain', { id: refundId, code: err.code });
        }
      }
      return await executeApprovedRefundDirect(refundId);
    }

    case 'productList': {
      const res = await db.collection('products')
        .orderBy('createTime', 'desc')
        .get();
      return { success: true, data: (res.data || []).map(product => ({
        ...product,
        reservedStock: Number(product.reservedStock) || 0,
        availableStock: (Number(product.stock) || 0) - (Number(product.reservedStock) || 0)
      })) };
    }

    case 'createProduct': {
      const { name, subtitle, price, originalPrice, stock, specs, images, description, category, status } = event;
      if (!name || !price) {
        return { success: false, error: '商品名称和价格不能为空' };
      }
      const res = await db.collection('products').add({
        data: {
          name: name.trim(),
          subtitle: subtitle || '',
          price: Number(price),
          originalPrice: Number(originalPrice) || 0,
          stock: Math.max(0, Number(stock) || 0),
          reservedStock: 0,
          specs: normalizeSpecs(specs, Number(stock) || 0),
          images: images || [],
          description: description || '',
          category: category || '',
          status: status || 'on',
          sales: 0,
          rating: 5.0,
          createTime: db.serverDate(),
          updateTime: db.serverDate()
        }
      });
      return { success: true, productId: res._id, message: '商品创建成功' };
    }

    case 'updateProduct': {
      const { id, name, subtitle, price, originalPrice, stock, specs, images, description, category, status } = event;
      if (!id) return { success: false, error: '商品ID不能为空' };
      const currentRes = await db.collection('products').doc(id).get().catch(() => null);
      const current = currentRes && currentRes.data;
      if (!current) return { success: false, error: '商品不存在' };
      const updateData = {};
      if (name !== undefined) updateData.name = name.trim();
      if (subtitle !== undefined) updateData.subtitle = subtitle;
      if (price !== undefined) updateData.price = Number(price);
      if (originalPrice !== undefined) updateData.originalPrice = Number(originalPrice) || 0;
      if (stock !== undefined) {
        const nextStock = Math.max(0, Number(stock) || 0);
        if (nextStock < (Number(current.reservedStock) || 0)) return { success: false, error: '库存不能低于锁定量' };
        updateData.stock = nextStock;
      }
      if (specs !== undefined) {
        updateData.specs = normalizeSpecs(specs, Number(stock !== undefined ? stock : current.stock) || 0, current.specs);
        if (updateData.specs.some(spec => spec.stock < spec.reservedStock)) return { success: false, error: '规格库存不能低于锁定量' };
      }
      if (images !== undefined) updateData.images = images;
      if (description !== undefined) updateData.description = description;
      if (category !== undefined) updateData.category = category;
      if (status !== undefined) updateData.status = status;
      updateData.updateTime = db.serverDate();
      await db.collection('products').doc(id).update({ data: updateData });
      return { success: true, message: '商品更新成功' };
    }

    case 'toggleProductStatus': {
      const { id, status } = event;
      if (!id || !['on', 'off'].includes(status)) {
        return { success: false, error: '参数错误' };
      }
      await db.collection('products').doc(id).update({
        data: { status, updateTime: db.serverDate() }
      });
      return { success: true, message: status === 'on' ? '已上架' : '已下架' };
    }

    case 'deleteProduct': {
      const { id } = event;
      if (!id) return { success: false, error: '商品ID不能为空' };
      // 检查是否有订单引用该商品（简单检查）
      const orderCount = await db.collection('orders')
        .where({ 'items.productId': id }).count();
      if (orderCount.total > 0) {
        return { success: false, error: '该商品已有订单，无法删除，建议下架' };
      }
      await db.collection('products').doc(id).remove();
      return { success: true, message: '商品已删除' };
    }

    case 'bannerList': {
      const res = await db.collection('banners')
        .orderBy('sort', 'asc')
        .get()
        .catch(() => ({ data: [] }));
      return { success: true, data: res.data || [] };
    }

    case 'createBanner': {
      const { imageUrl, linkUrl, title, sort, status } = event;
      if (!imageUrl) {
        return { success: false, error: '图片链接不能为空' };
      }
      const res = await db.collection('banners').add({
        data: {
          imageUrl: imageUrl.trim(),
          linkUrl: linkUrl || '',
          title: title || '',
          sort: Number(sort) || 0,
          status: status || 'on',
          createTime: db.serverDate()
        }
      });
      return { success: true, bannerId: res._id, message: '轮播图创建成功' };
    }

    case 'updateBanner': {
      const { id, imageUrl, linkUrl, title, sort, status } = event;
      if (!id) return { success: false, error: 'ID不能为空' };
      const updateData = {};
      if (imageUrl !== undefined) updateData.imageUrl = imageUrl.trim();
      if (linkUrl !== undefined) updateData.linkUrl = linkUrl;
      if (title !== undefined) updateData.title = title;
      if (sort !== undefined) updateData.sort = Number(sort) || 0;
      if (status !== undefined) updateData.status = status;
      await db.collection('banners').doc(id).update({ data: updateData });
      return { success: true, message: '轮播图更新成功' };
    }

    case 'toggleBanner': {
      const { id, status } = event;
      if (!id || !['on', 'off'].includes(status)) {
        return { success: false, error: '参数错误' };
      }
      await db.collection('banners').doc(id).update({
        data: { status }
      });
      return { success: true, message: status === 'on' ? '已启用' : '已禁用' };
    }

    case 'deleteBanner': {
      const { id } = event;
      if (!id) return { success: false, error: 'ID不能为空' };
      await db.collection('banners').doc(id).remove();
      return { success: true, message: '已删除' };
    }

    // ===== 商城编辑器进阶功能 =====
    case 'cloneProduct': {
      const { id } = event;
      if (!id) return { success: false, error: '商品ID不能为空' };
      const src = await db.collection('products').doc(id).get().catch(() => null);
      if (!src || !src.data) return { success: false, error: '原商品不存在' };
      const { _id, createTime, updateTime, ...rest } = src.data;
      const cloned = await db.collection('products').add({
        data: {
          ...rest,
          name: (rest.name || '未命名商品') + ' (副本)',
          sales: 0,
          status: 'off',
          draft: true,
          createTime: db.serverDate(),
          updateTime: db.serverDate()
        }
      });
      return { success: true, productId: cloned._id, message: '已复制为草稿' };
    }

    case 'batchUpdateCategory': {
      const { ids, category } = event;
      if (!Array.isArray(ids) || ids.length === 0) return { success: false, error: '请选择商品' };
      const cmd = db.command;
      await db.collection('products').where({ _id: cmd.in(ids) }).update({
        data: { category: category || '', updateTime: db.serverDate() }
      });
      return { success: true, count: ids.length };
    }

    case 'batchUpdateSort': {
      const { items } = event;
      if (!Array.isArray(items) || items.length === 0) return { success: false, error: '无排序数据' };
      const promises = items.map((it) => db.collection('products').doc(it.id).update({
        data: { sort: Number(it.sort) || 0, updateTime: db.serverDate() }
      }));
      await Promise.all(promises);
      return { success: true, count: items.length };
    }

    case 'saveDraftProduct': {
      const { name, subtitle, price, originalPrice, stock, specs, images, description, category, status } = event;
      const res = await db.collection('products').add({
        data: {
          name: (name || '未命名草稿').trim(),
          subtitle: subtitle || '',
          price: Number(price) || 0,
          originalPrice: Number(originalPrice) || 0,
          stock: Number(stock) || 0,
          specs: Array.isArray(specs) ? specs : [],
          images: Array.isArray(images) ? images : [],
          description: description || '',
          category: category || '',
          status: status || 'off',
          draft: true,
          sales: 0,
          rating: 5.0,
          createTime: db.serverDate(),
          updateTime: db.serverDate()
        }
      });
      return { success: true, productId: res._id, message: '草稿已保存' };
    }

    case 'getProductStats': {
      const all = await db.collection('products').orderBy('createTime', 'desc').limit(1000).get();
      const list = all.data || [];
      const total = list.length;
      const on = list.filter((p) => p.status === 'on' && !p.draft).length;
      const off = list.filter((p) => p.status === 'off' && !p.draft).length;
      const drafts = list.filter((p) => p.draft).length;
      const topSales = [...list]
        .filter((p) => (p.sales || 0) > 0)
        .sort((a, b) => (b.sales || 0) - (a.sales || 0))
        .slice(0, 10)
        .map((p) => ({
          _id: p._id,
          name: p.name,
          sales: p.sales || 0,
          stock: p.stock || 0,
          priceText: ((p.price || 0) / 100).toFixed(2)
        }));
      const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
      const now = Date.now();
      const stale = list.filter((p) => {
        if (p.status !== 'on' || p.draft || (p.sales || 0) > 0) return false;
        const t = p.createTime ? new Date(p.createTime).getTime() : now;
        return (now - t) > THIRTY_DAYS;
      }).slice(0, 10).map((p) => ({
        _id: p._id,
        name: p.name,
        stock: p.stock || 0,
        createTimeText: p.createTime ? new Date(p.createTime).toISOString().slice(0, 10) : '-'
      }));
      const byCategoryMap = {};
      list.forEach((p) => {
        const c = p.category || '未分类';
        byCategoryMap[c] = (byCategoryMap[c] || 0) + 1;
      });
      const byCategory = Object.keys(byCategoryMap)
        .map((k) => ({ name: k, count: byCategoryMap[k] }))
        .sort((a, b) => b.count - a.count);
      return { success: true, data: { total, on, off, drafts, topSales, stale, byCategory } };
    }

    case 'exportProducts': {
      const { filter = 'all' } = event;
      let query = {};
      if (filter === 'on') query = { status: 'on', draft: _.neq(true) };
      else if (filter === 'off') query = { status: 'off', draft: _.neq(true) };
      else if (filter === 'draft') query = { draft: true };
      const all = await db.collection('products').where(query).orderBy('createTime', 'desc').limit(1000).get();
      const rows = [['ID', '名称', '分类', '售价(元)', '原价(元)', '库存', '已售', '状态', '草稿', '创建时间']];
      (all.data || []).forEach((p) => {
        const statusLabel = p.draft ? '草稿' : (p.status === 'on' ? '上架' : '下架');
        rows.push([
          p._id || '',
          p.name || '',
          p.category || '',
          ((p.price || 0) / 100).toFixed(2),
          ((p.originalPrice || 0) / 100).toFixed(2),
          String(p.stock || 0),
          String(p.sales || 0),
          statusLabel,
          p.draft ? '是' : '否',
          p.createTime ? new Date(p.createTime).toISOString() : ''
        ]);
      });
      const escape = (v) => {
        const s = String(v == null ? '' : v);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      };
      const csv = '\uFEFF' + rows.map((r) => r.map(escape).join(',')).join('\n');
      return { success: true, data: { csv, count: rows.length - 1, filter } };
    }

    // ===== Web 后台专用：消息管理 =====
    case 'messageUsers': {
      if (!isAdmin) return { success: false, error: '无管理员权限' };
      const allMsgs = await db.collection('messages')
        .orderBy('createTime', 'desc')
        .limit(500)
        .get();
      const userMap = {};
      for (const msg of allMsgs.data) {
        const uid = msg.isAdmin ? msg.targetId : (msg.fromId === 'admin' ? msg.targetId : msg.fromId);
        if (!uid || uid === 'admin') continue;
        if (!userMap[uid]) {
          userMap[uid] = {
            userOpenId: uid,
            lastContent: msg.content,
            lastTime: msg.createTime,
            unread: 0,
            nickName: '用户',
            avatarUrl: ''
          };
        }
        if (!msg.isAdmin && !msg.read) {
          userMap[uid].unread++;
        }
      }
      const userIds = Object.keys(userMap);
      for (const uid of userIds) {
        const userRes = await db.collection('users').where({ openId: uid }).get().catch(() => null);
        if (userRes && userRes.data && userRes.data[0]) {
          userMap[uid].nickName = userRes.data[0].nickName || '用户';
          userMap[uid].avatarUrl = userRes.data[0].avatarUrl || '';
        }
      }
      return { success: true, data: Object.values(userMap) };
    }

    case 'messageHistory': {
      if (!isAdmin) return { success: false, error: '无管理员权限' };
      const { userOpenId } = event;
      if (!userOpenId) return { success: false, error: '缺少用户ID' };
      const fromUser = await db.collection('messages')
        .where({ fromId: userOpenId })
        .orderBy('createTime', 'asc')
        .limit(200)
        .get();
      const toUser = await db.collection('messages')
        .where({ targetId: userOpenId })
        .orderBy('createTime', 'asc')
        .limit(200)
        .get();
      const allMsgs = [...fromUser.data, ...toUser.data];
      // 去重（两条查询可能返回同一条消息）
      const seen = new Set();
      const deduped = allMsgs.filter(m => {
        if (seen.has(m._id)) return false;
        seen.add(m._id);
        return true;
      });
      deduped.sort((a, b) => new Date(a.createTime) - new Date(b.createTime));
      return { success: true, data: deduped };
    }

    case 'adminReply': {
      const { userOpenId, content } = event;
      if (!userOpenId || !content) return { success: false, error: '参数不完整' };
      await db.collection('messages').add({
        data: {
          fromId: 'admin',
          targetId: userOpenId,
          content: content,
          type: 'text',
          isAdmin: true,
          read: false,
          createTime: db.serverDate()
        }
      });
      return { success: true, message: '发送成功' };
    }

    // ===== Web 后台专用：设置管理 =====
    case 'getSettings': {
      const payConfigRes = await db.collection('pay_config').doc('default').get().catch(() => null);
      const payConfig = (payConfigRes && payConfigRes.data) || {};
      const subMchId = String(payConfig.subMchId || '').trim();
      return {
        success: true,
        settings: {
          account: actor,
          passwordSet: true,
          commissionRate: typeof payConfig.commissionRate === 'number' ? payConfig.commissionRate
            : (typeof configData.commissionRate === 'number' ? configData.commissionRate : 0.33),
          fullReduction: configData.fullReduction && typeof configData.fullReduction === 'object'
            ? configData.fullReduction
            : { enabled: false, rules: [] },
          payment: {
            mode: payConfig.useMockPay === true ? 'mock_requested' : (subMchId ? 'wechat' : 'unconfigured'),
            merchantConfigured: !!subMchId,
            merchantSuffix: subMchId ? subMchId.slice(-4) : ''
          },
          payApiDirect: {
            configured: payConfig.apiCertConfigured === true && !!String(payConfig.apiV2Key || '').trim(),
            updateTime: payConfig.apiCertUpdateTime || null
          }
        }
      };
    }

    case 'setCommissionRate': {
      const { commissionRate } = event;
      const rate = Number(commissionRate);
      if (isNaN(rate) || rate < 0 || rate > 1) {
        return { success: false, error: '佣金比例必须在 0~1 之间' };
      }
      await db.runTransaction(async transaction => {
        const payConfig = (await transaction.collection('pay_config').doc('default').get()).data;
        await transaction.collection('admin_config').doc('admin').update({ data: { commissionRate: rate } });
        if (payConfig) {
          await transaction.collection('pay_config').doc('default').update({ data: { commissionRate: rate } });
        } else {
          await transaction.collection('pay_config').doc('default').set({ data: {
            commissionRate: rate, useMockPay: false, subMchId: ''
          } });
        }
      });
      return { success: true, message: '佣金比例已更新为 ' + Math.round(rate * 100) + '%' };
    }

    case 'setFullReduction': {
      const fr = event.fullReduction || {};
      const enabled = fr.enabled === true;
      const rawRules = Array.isArray(fr.rules) ? fr.rules : [];
      const rules = rawRules
        .map(rule => ({
          threshold: Math.round(Number(rule && rule.threshold) || 0),
          discount: Math.round(Number(rule && rule.discount) || 0)
        }))
        .filter(rule => rule.threshold > 0 && rule.discount > 0 && rule.discount < rule.threshold)
        .sort((a, b) => a.threshold - b.threshold)
        .slice(0, 5);
      if (enabled && rules.length === 0) {
        return { success: false, error: '请至少配置一条有效规则：门槛与优惠均为正数，且优惠必须小于门槛' };
      }
      await db.collection('admin_config').doc('admin').update({
        data: { fullReduction: { enabled, rules } }
      });
      return { success: true, message: enabled ? '满减规则已保存并启用' : '满减已停用（规则已保存）' };
    }

    case 'savePayApiConfig': {
      // 保存微信支付 APIv2 直连凭证（密钥 + 证书），用于绕过 CloudBase access_token 直连退款
      const { apiV2Key, apiCertP12, apiCertPassword } = event;
      const key = String(apiV2Key || '').trim();
      if (!key || !/^[0-9a-zA-Z]{32}$/.test(key)) {
        return { success: false, error: 'APIv2 密钥格式不正确（应为 32 位字母数字）' };
      }
      const p12 = String(apiCertP12 || '').trim();
      if (!p12) {
        return { success: false, error: '请上传 apiclient_cert.p12 证书文件' };
      }
      // 简单校验 base64 可解码
      let certOk = false;
      try {
        const buf = Buffer.from(p12, 'base64');
        certOk = buf.length > 100;
      } catch (e) { certOk = false; }
      if (!certOk) {
        return { success: false, error: '证书文件内容无效（base64 解码失败）' };
      }
      const updateData = {
        apiV2Key: key,
        apiCertP12: p12,
        apiCertConfigured: true,
        apiCertUpdateTime: db.serverDate()
      };
      if (apiCertPassword !== undefined && apiCertPassword !== null) {
        updateData.apiCertPassword = String(apiCertPassword).trim();
      }
      await db.collection('pay_config').doc('default').update({ data: updateData });
      return { success: true, message: '微信支付 API 直连凭证已保存，退款将优先走直连通道' };
    }

    case 'clearPayApiConfig': {
      // 清除直连凭证（回退到 CloudBase cloudPay 路径）
      await db.collection('pay_config').doc('default').update({
        data: { apiV2Key: '', apiCertP12: '', apiCertConfigured: false, apiCertPassword: '' }
      });
      return { success: true, message: '已清除直连凭证，退款恢复 CloudBase 通道' };
    }

    case 'debugPayApi': {
      // 一键诊断直连退款各环节：凭证、证书加载、签名、订单可见性
      const diagnostics = {};
      const cfg = await loadPayApiConfig(db);
      diagnostics.credentialsSaved = !!cfg;
      if (!cfg) {
        return { success: false, error: '直连凭证未保存，请先在系统设置录入 APIv2 密钥和证书', diagnostics };
      }
      diagnostics.keyLength = cfg.apiV2Key.length;
      diagnostics.certBase64Length = cfg.apiCertP12.length;
      diagnostics.certPasswordSet = !!cfg.apiCertPassword;
      diagnostics.mchId = cfg.subMchId;

      // 环节1：证书加载（云端 Node 环境）
      try {
        const tls = require('tls');
        const pfxBuffer = Buffer.from(cfg.apiCertP12, 'base64');
        const ctx = tls.createSecureContext({ pfx: pfxBuffer, passphrase: cfg.apiCertPassword });
        diagnostics.certLoad = 'OK（证书与密码匹配）';
      } catch (certErr) {
        diagnostics.certLoad = 'FAIL: ' + String(certErr.message || certErr).slice(0, 200);
      }

      // 环节2：签名验证 — 用直连订单查询 API 测（免证书，测密钥有效性 + 交易可见性）
      // 用最近一笔微信支付订单做查询标的
      let testOrderNo = event.orderNo || '';
      if (!testOrderNo) {
        const recentOrder = await db.collection('orders')
          .where({ paymentSource: _.neq('mockPay') })
          .orderBy('createTime', 'desc')
          .limit(1)
          .get()
          .catch(() => null);
        const ord = recentOrder && recentOrder.data && recentOrder.data[0];
        testOrderNo = ord ? ord.orderNo : '';
      }
      diagnostics.testOrderNo = testOrderNo;
      if (testOrderNo) {
        try {
          const wxResp = await directOrderQuery({
            appId: APP_ID,
            mchId: cfg.subMchId,
            apiV2Key: cfg.apiV2Key,
            outTradeNo: testOrderNo
          });
          diagnostics.orderQueryReturnCode = wxResp.return_code || '';
          diagnostics.orderQueryResultCode = wxResp.result_code || '';
          diagnostics.orderQueryErrCode = wxResp.err_code || '';
          diagnostics.orderQueryErrDes = (wxResp.err_code_des || wxResp.return_msg || '').slice(0, 200);
          if (wxResp.result_code === 'FAIL' && wxResp.err_code === 'SIGN_ERROR') {
            diagnostics.signature = 'FAIL — APIv2 密钥不正确，请重新核对';
          } else if (wxResp.result_code === 'FAIL' && /ORDERNOTEXIST|ORDER_NOT_EXIST|INVALID_REQUEST/i.test(wxResp.err_code || '')) {
            diagnostics.signature = 'OK（密钥有效）';
            diagnostics.modeCheck = 'FAIL — 订单在直连商户名下查不到，交易可能走的是 CloudBase 服务商通道，直连证书无法退款该类订单';
          } else if (wxResp.result_code === 'SUCCESS') {
            diagnostics.signature = 'OK（密钥有效）';
            diagnostics.modeCheck = 'OK — 订单在直连商户名下可见，直连退款应该可用';
            diagnostics.orderTradeState = wxResp.trade_state || '';
            diagnostics.orderTransactionId = wxResp.transaction_id || '';
          } else {
            diagnostics.signature = '未知（见上方 err_code）';
          }
        } catch (qErr) {
          diagnostics.orderQueryError = String(qErr.message || qErr).slice(0, 300);
        }
      } else {
        diagnostics.orderQuerySkipped = '没有可测试的真实订单';
      }

      return { success: true, diagnostics };
    }

    case 'changePassword': {
      const { oldPassword, newPassword } = event;
      if (!newPassword || newPassword.length < 8) {
        return { success: false, error: '新密码至少8位' };
      }
      if (actor.accountId.startsWith('legacy-openid:')) {
        return { success: false, error: '请在 Web 后台使用账号登录后修改密码' };
      }
      const accountRes = await db.collection('admin_accounts').doc(actor.accountId).get().catch(() => null);
      const account = accountRes && accountRes.data;
      if (!account || !verifyAccountPassword(oldPassword || '', account.passwordHash)) {
        return { success: false, error: '原密码错误' };
      }
      await db.collection('admin_accounts').doc(actor.accountId).update({
        data: { passwordHash: createPasswordHash(newPassword), mustChangePassword: false, updateTime: db.serverDate() }
      });
      return { success: true, message: '密码已更新' };
    }

    case 'addAdminOpenId': {
      const { openId: newOpenId } = event;
      if (!newOpenId) return { success: false, error: 'openId不能为空' };
      const current = configData.adminOpenIds || (legacyOpenId ? [legacyOpenId] : []);
      if (current.includes(newOpenId)) {
        return { success: false, error: '该openId已存在' };
      }
      current.push(newOpenId);
      await db.collection('admin_config').doc('admin').update({
        data: { adminOpenIds: current }
      });
      return { success: true, message: '已添加管理员' };
    }

    case 'removeAdminOpenId': {
      const { openId: removeId } = event;
      const current = configData.adminOpenIds || [];
      const newList = current.filter(id => id !== removeId);
      await db.collection('admin_config').doc('admin').update({
        data: { adminOpenIds: newList }
      });
      return { success: true, message: '已移除管理员' };
    }

    default:
      return { success: false, error: 'unknown action' };
  }
  } catch (err) {
    paymentDiagnostics.event(console, 'admin.failed', { code: err && err.code });
    return {
      success: false,
      error: '云函数执行失败: ' + String((err && (err.errMsg || err.message)) || err).slice(0, 200)
    };
  }
};
