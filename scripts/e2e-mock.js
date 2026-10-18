#!/usr/bin/env node
// =============================================================
// 林元元商城 · 端到端 mock 验证
// 运行: node scripts/e2e-mock.js
//
// 把 wx-server-sdk 用内存数据库替换,串起所有云函数,
// 跑完一整套业务流:显式虚构种子 → 登录 → 加购 → 用券下单 → 模拟支付
// → 支付回调 → 佣金结算 → 提现申请 → 管理员审批 → 提现核销。
// =============================================================

'use strict';
require('./lib/payment-test-network');

const path = require('path');
const Module = require('module');
const fs = require('fs');
const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..');
const CF = path.join(ROOT, 'cloudfunctions');
process.env.CLOUDBASE_CUSTOM_LOGIN_PRIVATE_KEY_ID = 'mock-private-key-id';
process.env.CLOUDBASE_CUSTOM_LOGIN_PRIVATE_KEY = 'mock-private-key';
process.env.ALLOW_MOCK_PAY = 'true';

// ============ wx-server-sdk mock ============
const db = {
  _store: {}, // { collectionName: [doc, ...] }
  _nextId: 1,
  _serverNow: new Date(),
  reset() { this._store = {}; this._nextId = 1; this._serverNow = new Date(); }
};

// 业务操作符
const commandOps = {
  inc(n) { return { __op: 'inc', value: n }; },
  set(v) { return { __op: 'set', value: v }; },
  in(arr) { return { __op: 'in', value: arr }; },
  neq(v) { return { __op: 'neq', value: v }; },
  eq(v) { return { __op: 'eq', value: v }; },
  gt(v) { return { __op: 'gt', value: v }; },
  gte(v) { return { __op: 'gte', value: v }; },
  lt(v) { return { __op: 'lt', value: v }; },
  lte(v) { return { __op: 'lte', value: v }; },
  and(...args) { return { __op: 'and', value: args }; },
  or(...args) { return { __op: 'or', value: args }; }
};
commandOps.elemMatch = value => ({ __op: 'elemMatch', value });
const CMD = { ...commandOps, inc: commandOps.inc, in: commandOps.in, neq: commandOps.neq, eq: commandOps.eq };

let currentOpenId = 'mock-customer';
function setOpenId(id) { currentOpenId = id; }

// 匹配一条 query
function matchDoc(doc, query) {
  const pathValues = (value, parts) => {
    if (!parts.length) return [value];
    if (Array.isArray(value)) return value.flatMap(item => pathValues(item, parts));
    return pathValues(value && value[parts[0]], parts.slice(1));
  };
  return Object.entries(query).every(([key, value]) => {
    const actualValues = pathValues(doc, key.split('.'));
    const one = actual => {
      if (value && typeof value === 'object' && value.__regexp) {
        return value.__regexp.test(String(actual == null ? '' : actual));
      }
      if (!value || typeof value !== 'object' || !value.__op) return actual === value;
      switch (value.__op) {
        case 'in': return value.value.includes(actual);
        case 'neq': return actual !== value.value;
        case 'eq': return actual === value.value;
        case 'gt': return actual > value.value;
        case 'gte': return actual >= value.value;
        case 'lt': return actual < value.value;
        case 'lte': return actual <= value.value;
        case 'and': return value.value.every(condition => matchDoc(doc, condition));
        case 'or': return value.value.some(condition => matchDoc(doc, condition));
        case 'elemMatch': return Array.isArray(actual) && actual.some(item => matchDoc(item, value.value));
        default: throw new Error('Unsupported E2E query operator: ' + value.__op);
      }
    };
    return value && value.__op === 'neq' ? actualValues.every(one) : actualValues.some(one);
  });
}

function applyUpdate(doc, data) {
  for (const k of Object.keys(data)) {
    const v = data[k];
    const parts = k.split('.');
    let target = doc;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!target[parts[i]] || typeof target[parts[i]] !== 'object') target[parts[i]] = {};
      target = target[parts[i]];
    }
    const field = parts[parts.length - 1];
    if (v && typeof v === 'object' && v.__op === 'inc') {
      target[field] = (Number(target[field]) || 0) + Number(v.value || 0);
    } else if (v && typeof v === 'object' && v.__op === 'set') {
      target[field] = v.value;
    } else {
      target[field] = v;
    }
  }
}

class Collection {
  constructor(name) {
    this._name = name;
    this._query = {};
    this._docId = null;
    this._sort = null;
    this._skip = 0;
    this._limit = 100;
    this._db = db;
    if (!db._store[name]) db._store[name] = [];
  }
  doc(id) { this._docId = id; this._query = {}; return this; } // .doc 重置 where 上下文,符合 wx-server-sdk 语义
  where(q) {
    // 浅合并（同一 collection 的多次 .where 调用应覆盖）
    this._query = Object.assign({}, this._query, q);
    return this;
  }
  orderBy(field, dir) { this._sort = { field, dir: dir || 'asc' }; return this; }
  skip(n) { this._skip = n; return this; }
  limit(n) { this._limit = n; return this; }
  async get() {
    let docs = db._store[this._name] || [];
    if (this._docId) {
      const d = docs.find(x => x._id === this._docId);
      // wx-server-sdk 约定: .doc().get() 返回 { data: doc | null }（单条）
      return { data: d || null };
    }
    docs = docs.filter(d => matchDoc(d, this._query));
    if (this._sort) {
      const { field, dir } = this._sort;
      docs.sort((a, b) => {
        const av = a[field], bv = b[field];
        const an = av instanceof Date ? av.getTime() : av;
        const bn = bv instanceof Date ? bv.getTime() : bv;
        if (an === bn) return 0;
        if (an == null) return 1;
        if (bn == null) return -1;
        return (an < bn ? -1 : 1) * (dir === 'desc' ? -1 : 1);
      });
    }
    return { data: docs.slice(this._skip, this._skip + this._limit) };
  }
  async count() {
    let docs = db._store[this._name] || [];
    if (this._docId) docs = docs.filter(x => x._id === this._docId);
    else docs = docs.filter(d => matchDoc(d, this._query));
    return { total: docs.length };
  }
  async add({ data }) {
    const id = data._id || 'doc_' + (db._nextId++) + '_' + Math.random().toString(36).slice(2, 8);
    if (db._store[this._name].some(doc => doc._id === id)) throw new Error('Duplicate document ID');
    const doc = Object.assign({ _id: id, createTime: db._serverNow }, data);
    db._store[this._name].push(doc);
    return { _id: id };
  }
  async update({ data }) {
    const arr = db._store[this._name] || [];
    let targets;
    if (this._docId) targets = arr.filter(x => x._id === this._docId);
    else targets = arr.filter(d => matchDoc(d, this._query));
    for (const t of targets) {
      applyUpdate(t, data);
      t.updateTime = db._serverNow;
    }
    return { updated: targets.length, stats: { updated: targets.length } };
  }
  async remove() {
    const arr = db._store[this._name] || [];
    if (this._docId) {
      const i = arr.findIndex(x => x._id === this._docId);
      if (i >= 0) { arr.splice(i, 1); return { removed: 1 }; }
      return { removed: 0 };
    }
    const before = arr.length;
    db._store[this._name] = arr.filter(d => !matchDoc(d, this._query));
    return { removed: before - db._store[this._name].length };
  }
  async set({ data }) {
    const arr = db._store[this._name];
    const id = this._docId || ('doc_' + (db._nextId++) + '_set');
    const index = arr.findIndex(x => x._id === id);
    const target = { ...data, _id: id };
    if (index < 0) arr.push(target); else arr[index] = target;
    return { _id: target._id };
  }
}

db.collection = (n) => new Collection(n);
db.command = CMD;
db.serverDate = () => new Date();
db.runTransaction = async work => {
  const snapshot = structuredClone(db._store);
  const nextId = db._nextId;
  try {
    return await work(db);
  } catch (err) {
    db._store = snapshot;
    db._nextId = nextId;
    throw err;
  }
};
// 简易 RegExp 占位,匹配 where.name = db.RegExp({ regexp, options })
db.RegExp = function ({ regexp, options }) {
  const re = new RegExp(regexp, options || '');
  return { __regexp: re, test: (s) => re.test(String(s == null ? '' : s)) };
};

const _loadedModules = {};
function loadCloudFunction(name) {
  if (_loadedModules[name]) return _loadedModules[name];
  const m = require(path.join(CF, name, 'index.js'));
  _loadedModules[name] = m;
  return m;
}

const cloud = {
  init() {},
  getWXContext() { return { OPENID: currentOpenId, UID: currentOpenId }; },
  database() { return db; },
  async getTempFileURL({ fileList }) {
    return {
      fileList: (fileList || []).map(fileID => ({
        fileID,
        tempFileURL: 'https://temp.example.test/' + encodeURIComponent(fileID)
      }))
    };
  },
  async callFunction({ name, data }) {
    const mod = loadCloudFunction(name);
    return { result: await mod.main(data || {}, {}) };
  },
  // 不模拟真实云支付
  cloudPay: null
};
cloud.openapi = {
  wxacode: {
    getUnlimited: async () => ({ buffer: Buffer.from('mock-admin-login-qr') })
  }
};
// 给真实云支付 refund 一个桩,避免退款流程因为没有云支付凭证而崩
const channelPayments = new Map();
function recordChannelPayment(orderNo, transactionId) {
  const order = db._store.orders.find(item => item.orderNo === orderNo);
  const record = { returnCode: 'SUCCESS', resultCode: 'SUCCESS', tradeState: 'SUCCESS',
    outTradeNo: orderNo, subMchId: order.paymentSubMchId || 'mock-merchant', transactionId,
    totalFee: order.totalFee, subOpenid: order.userId };
  channelPayments.set(orderNo, record);
  return record;
}
cloud.cloudPay = {
  queryOrder: async params => structuredClone(channelPayments.get(params.outTradeNo) || {
    returnCode: 'SUCCESS', resultCode: 'SUCCESS', tradeState: 'NOTPAY',
    outTradeNo: params.outTradeNo, subMchId: params.subMchId
  }),
  closeOrder: async params => {
    const existing = channelPayments.get(params.outTradeNo);
    if (existing && existing.tradeState === 'SUCCESS') {
      return { returnCode: 'SUCCESS', resultCode: 'FAIL', errCode: 'ORDERPAID' };
    }
    channelPayments.set(params.outTradeNo, { returnCode: 'SUCCESS', resultCode: 'SUCCESS',
      tradeState: 'CLOSED', outTradeNo: params.outTradeNo, subMchId: params.subMchId });
    return { returnCode: 'SUCCESS', resultCode: 'SUCCESS' };
  },
  unifiedOrder: async () => ({ returnCode: 'SUCCESS', resultCode: 'SUCCESS', payment: { timeStamp: '1', nonceStr: 'n', package: 'prepay_id=mock', signType: 'MD5', paySign: 'mock' }, prepayId: 'mock_prepay' }),
  refund: async () => ({ returnCode: 'SUCCESS', resultCode: 'SUCCESS', refundId: 'mock_refund_' + Date.now() })
};

const wxServerSdk = cloud; // 兼容 require('wx-server-sdk') 直接拿到 cloud

// 劫持 require('wx-server-sdk')
const origResolve = Module._resolveFilename;
const origLoad = Module._load;
let mockTransferState = 'WAIT_USER_CONFIRM';
Module._load = function (request, parent, isMain) {
  if (request === 'wx-server-sdk') return wxServerSdk;
  if (request === './wxpay-transfer') {
    const client = origLoad.apply(this, arguments);
    return { ...client, queryBill: async () => ({ state: mockTransferState }) };
  }
  if (request === '@cloudbase/node-sdk') {
    return {
      init() {
        return { auth: () => ({ createTicket: uid => `mock-custom-ticket:${uid}` }) };
      }
    };
  }
  return origLoad.apply(this, arguments);
};

// ============ 测试驱动 ============
const results = [];
function step(name, ok, detail) {
  results.push({ name, ok, detail: detail || '' });
  const mark = ok ? '✓' : '✗';
  console.log(`  ${mark} ${name}${detail ? '  ' + detail : ''}`);
}
function header(t) { console.log('\n=== ' + t + ' ==='); }

async function call(name, data) {
  return cloud.callFunction({ name, data });
}

function generateOrderNo() {
  const stamp = new Date().toISOString().replace(/[-T:Z.]/g, '').slice(0, 14);
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase().padEnd(6, '0');
  return 'JY' + stamp + suffix;
}

// ============== 主流程 ==============
async function main() {
  console.log('林元元 E2E Mock 验证\n');
  header('Step 1: 运行时初始化关闭，显式播种虚构内存数据');
  setOpenId('mock-customer');
  const initRes = (await call('init', { action: 'init' })).result;
  step('运行时 init 拒绝且没有数据写入', !initRes.success &&
    initRes.code === 'MAINTENANCE_DISABLED' && Object.keys(db._store).length === 0);
  const productId = 'mock-product';
  const salt = 'mock-owner-salt';
  db._store.admin_config = [{ _id: 'admin', openId: 'mock-owner', adminOpenIds: ['mock-owner'] }];
  db._store.admin_accounts = [{ _id: 'mock-owner-account', username: 'owner', displayName: 'Mock Owner',
    role: 'owner', status: 'active', wechatOpenId: 'mock-owner',
    passwordHash: 'scrypt$' + salt + '$' + crypto.scryptSync('owner-password', salt, 64).toString('hex') }];
  db._store.pay_config = [{ _id: 'default', subMchId: '', useMockPay: false }];
  db._store.categories = Array.from({ length: 6 }, (_, index) => ({ _id: 'mock-category-' + index,
    name: 'Mock Category ' + index, parentId: '', sort: index, status: 'on' }));
  db._store.products = [{ _id: productId, name: '小紫瓶', price: 6900, originalPrice: 7800,
    categoryId: 'mock-category-0', status: 'on', stock: 1998, reservedStock: 0, sales: 0,
    specs: [{ name: '13.5g', stock: 999, reservedStock: 0 }, { name: '27g', stock: 999, reservedStock: 0 }],
    images: ['/images/product-xiaoziping.jpg'], description: 'Synthetic fixture product' }];
  const payConfig = db._store.pay_config.find(item => item._id === 'default');
  step('新环境默认关闭模拟支付', payConfig && payConfig.useMockPay === false && !payConfig.subMchId);
  // 后续主链路显式切换为测试模式，仍需环境变量二次授权。
  payConfig.useMockPay = true;
  payConfig.subMchId = 'mock-merchant';
  // This historical E2E fixture uses an explicitly configured 15% rate, not the 33% default.
  // The default and configuration precedence are covered by commission-policy-test.js.
  payConfig.commissionRate = 0.15;

  // 验证 6 个分类 + 3 张券被 seed
  const cats = (await call('category', { action: 'list' })).result;
  step('6 个分类', cats.data && cats.data.length >= 6, '实际=' + (cats.data && cats.data.length));
  const coupons = (await call('coupon', { action: 'center' })).result;
  step('3 张券 seed', coupons.data && coupons.data.length >= 3, '实际=' + (coupons.data && coupons.data.length));

  header('Step 1.5: 首页公开 Banner 读取');
  db._store.banners = [
    { _id: 'banner-off', status: 'off', sort: 0, imageUrl: 'https://example.test/off.png', secret: 'hidden' },
    { _id: 'banner-late', status: 'on', sort: 20, imageUrl: 'https://example.test/late.png', title: '晚', linkUrl: '/pages/category/category', secret: 'hidden' },
    { _id: 'banner-first', status: 'on', sort: 10, imageUrl: 'cloud://env/banner-first.png', title: '先', linkUrl: '/pages/search/search', secret: 'hidden' }
  ];
  const bannerList = (await call('banner', { action: 'list' })).result;
  step('公开 Banner 读取成功', bannerList.success);
  step('公开 Banner 只返回上架项且按 sort 排序', bannerList.data && bannerList.data.length === 2 && bannerList.data[0]._id === 'banner-first');
  step('公开 Banner 字段白名单', bannerList.data && bannerList.data.every(b => Object.keys(b).every(k => ['_id', 'imageUrl', 'title', 'linkUrl'].includes(k))));
  step('公开 Banner 云文件转临时图片地址', bannerList.data && bannerList.data[0].imageUrl.indexOf('https://temp.example.test/') === 0);
  const badBannerAction = (await call('banner', { action: 'unknown' })).result;
  step('公开 Banner 未知 action 拒绝', !badBannerAction.success);
  const bannerSrc = fs.readFileSync(path.join(CF, 'banner', 'index.js'), 'utf8');
  step('公开 Banner 读取不依赖 where/orderBy 索引',
    !bannerSrc.includes('.where(') && !bannerSrc.includes('.orderBy('));

  const originalCollection = db.collection;
  db.collection = (name) => {
    const query = originalCollection(name);
    if (name === 'banners') query.get = async () => { throw new Error('banner unavailable'); };
    return query;
  };
  const bannerFailure = (await call('banner', { action: 'list' })).result;
  db.collection = originalCollection;
  step('公开 Banner 查询失败返回通用失败', !bannerFailure.success && bannerFailure.error === 'Banner 暂不可用');

  header('Step 2: B 端邀请 → C 端激活 → 推广绑定');
  const adminCfg = db._store.admin_config && db._store.admin_config.find(d => d._id === 'admin');
  if (adminCfg) {
    adminCfg.openId = 'mock-owner';
    adminCfg.adminOpenIds = ['mock-owner'];
  }
  setOpenId('mock-owner');
  const fixtureOwner = db._store.admin_accounts.find(item => item._id === 'mock-owner-account');
  fixtureOwner.status = 'disabled';
  const revokedLegacyOwner = (await call('admin', { action: 'checkAdmin' })).result;
  step('legacy 配置不能绕过账号停用', !revokedLegacyOwner.success);
  fixtureOwner.status = 'active';
  const invite = (await call('admin', { action: 'createInvite', name: '分销员A', phone: '13800138001' })).result;
  step('B 端生成 7 天邀请', invite.success && invite.invitePath && invite.invitePath.includes('token='));
  const inviteToken = decodeURIComponent(invite.invitePath.split('token=')[1]);

  setOpenId('mock-agent-A');
  const loginA = (await call('login', { action: 'login', ref: '' })).result;
  step('分销员 A 登录', loginA.success && loginA.openId === 'mock-agent-A');
  const publicApply = (await call('agent', { action: 'apply', name: 'A', phone: '13800138001' })).result;
  step('公开申请入口已关闭', !publicApply.success && publicApply.error.includes('后台邀请'));
  const claimInvite = (await call('agent', { action: 'claimInvite', token: inviteToken })).result;
  step('C 端领取一次性邀请', claimInvite.success && /^JY[A-Z2-9]{8}$/.test(claimInvite.code || ''));
  const repeatClaim = (await call('agent', { action: 'claimInvite', token: inviteToken })).result;
  step('已激活分销员重复领取保持幂等', repeatClaim.success && repeatClaim.alreadyActive);
  const agentInfo = (await call('agent', { action: 'info' })).result;
  step('A 已成为 active 分销员', agentInfo.isAgent && agentInfo.status === 'active');

  const homeAsset = (await call('promotion', { action: 'asset' })).result;
  step('生成商城首页推广素材', homeAsset.success && homeAsset.data && homeAsset.data.sharePath.includes(agentInfo.code));
  const resolvedScene = (await call('promotion', { action: 'resolve', scene: homeAsset.data.scene })).result;
  step('小程序码 scene 可解析', resolvedScene.success && resolvedScene.ref === agentInfo.code);

  // 无效推广码与自推荐都不应永久绑定。
  setOpenId('mock-invalid-ref-C');
  await call('login', { action: 'login', ref: 'INVALID001' });
  const userC = db._store.users.find(u => u._id === 'mock-invalid-ref-C');
  step('无效推广码不绑定', userC && !userC.referrer, '实际=' + (userC && userC.referrer));

  setOpenId('mock-agent-A');
  await call('login', { action: 'login', ref: agentInfo.code });
  const agentUser = db._store.users.find(u => u._id === 'mock-agent-A');
  step('自推荐不绑定', agentUser && !agentUser.referrer, '实际=' + (agentUser && agentUser.referrer));

  setOpenId('mock-customer-B');
  const loginB = (await call('login', { action: 'login', ref: agentInfo.code })).result;
  step('客户 B 登录（带 ref）', loginB.success);

  // 验证 B 的 referrer 写入了
  const userB = db._store.users.find(u => u._id === 'mock-customer-B');
  step('B.referrer = A', userB && userB.referrer === 'mock-agent-A', '实际=' + (userB && userB.referrer));

  header('Step 3: B 领取新人立减券');
  const newUserCoupon = coupons.data.find(c => c.name === '新人立减券');
  const claimRes = (await call('coupon', { action: 'claim', couponId: newUserCoupon._id })).result;
  step('领取新人立减券', claimRes.success);
  const duplicateClaim = (await call('coupon', { action: 'claim', couponId: newUserCoupon._id })).result;
  step('同一优惠券不可重复领取', duplicateClaim.success && duplicateClaim.alreadyClaimed && duplicateClaim.userCouponId === claimRes.userCouponId);

  const myCoupons = (await call('coupon', { action: 'mine' })).result;
  step('我的券列表 1 张', myCoupons.data && myCoupons.data.length === 1, '实际=' + (myCoupons.data && myCoupons.data.length));

  header('Step 4: B 加购 + 用券下单');
  setOpenId('mock-customer-B');
  // 加购
  const updateCart = (await call('cart', { action: 'update', items: [{
    productId, name: '小紫瓶', spec: '13.5g', price: 6900, quantity: 1, image: ''
  }]})).result;
  step('更新购物车', updateCart.success);

  // 获取可用券
  const avail = (await call('coupon', { action: 'available', amount: 6900 })).result;
  step('可用券列表 1 张', avail.data && avail.data.length === 1, '实际=' + (avail.data && avail.data.length));
  const usableCoupon = avail.data[0];
  step('券折扣 = 1000 分', usableCoupon.discount === 1000, '实际=' + usableCoupon.discount);

  const couponRecord = db._store.coupons.find(c => c._id === newUserCoupon._id);
  const originalCoupon = { ...couponRecord };
  for (const [label, override] of [
    ['下架', { status: 'off' }],
    ['尚未生效', { startTime: Date.now() + 60000 }],
    ['已过期', { endTime: Date.now() - 60000 }]
  ]) {
    Object.assign(couponRecord, originalCoupon, override);
    const invalid = (await call('coupon', { action: 'available', amount: 6900 })).result;
    step(label + '券不出现在结算可用列表', invalid.success && invalid.data.length === 0);
  }
  Object.assign(couponRecord, originalCoupon);

  // 计算折后价
  const calc = (await call('coupon', { action: 'calculate', userCouponId: usableCoupon.userCouponId, amount: 6900 })).result;
  step('折后价 = 5900', calc.finalAmount === 5900, '实际=' + calc.finalAmount);

  const tamperedDiscount = (await call('order', {
    action: 'create', orderNo: generateOrderNo(),
    items: [{ productId, spec: '13.5g', quantity: 1 }],
    totalFee: 100, couponDiscount: 6800,
    address: { name: '张三', phone: '13800138000', detail: '北京市朝阳区某街道1号' }
  })).result;
  step('服务端拒绝伪造优惠金额', !tamperedDiscount.success && tamperedDiscount.error.includes('优惠信息'));

  // 下单
  const orderNo = generateOrderNo();
  const orderRes = (await call('order', {
    action: 'create',
    orderNo,
    items: [{ productId, name: '小紫瓶', spec: '13.5g', price: 6900, quantity: 2, image: '' }],
    totalFee: 12800,
    address: { name: '张三', phone: '13800138000', detail: '北京市朝阳区某街道1号' },
    remark: '请尽快发货',
    couponId: usableCoupon.userCouponId,
    couponDiscount: 1000
  })).result;
  step('创建订单', orderRes.success, 'orderId=' + orderRes.orderId);
  step('服务端重算 totalFee=12800', orderRes.totalFee === 12800, '实际=' + orderRes.totalFee);

  const orderId = orderRes.orderId;
  const orderDoc = db._store.orders.find(o => o._id === orderId);
  step('订单状态=pending', orderDoc.status === 'pending');
  const firstReservation = db._store.inventory_reservations.find(item => item.orderId === orderId);
  step('下单即锁定 SKU 库存', firstReservation && firstReservation.status === 'reserved' && orderDoc.inventoryStatus === 'reserved');
  step('库存预留写入业务幂等键', firstReservation && firstReservation.idempotencyKey === `reservation:${orderNo}:0`);
  step('订单 agentId=A', orderDoc.agentId === 'mock-agent-A', '实际=' + orderDoc.agentId);
  step('订单 commission=1920(15%*12800)', orderDoc.commission === 1920, '实际=' + orderDoc.commission);

  // 模拟支付必须同时具备数据库开关和云函数环境变量授权。
  process.env.ALLOW_MOCK_PAY = 'false';
  const blockedMockPay = (await call('pay', { action: 'request', orderId })).result;
  step('未获环境变量授权时模拟支付被拦截', !blockedMockPay.success && orderDoc.status === 'pending');
  process.env.ALLOW_MOCK_PAY = 'true';
  const payRes = (await call('pay', { action: 'request', orderId })).result;
  step('模拟支付受理', payRes.success && payRes.mock, 'message=' + (payRes.message || ''));

  // mock 模式下订单已变为 paid
  const orderAfterPay = db._store.orders.find(o => o._id === orderId);
  step('订单已 paid（mock 直接落 paid）', orderAfterPay.status === 'paid', '实际=' + orderAfterPay.status);
  const orderCounts = (await call('order', { action: 'counts' })).result;
  step('我的页订单状态计数聚合', orderCounts.success &&
    orderCounts.data && orderCounts.data.pending === 0 && orderCounts.data.paid === 1 &&
    orderCounts.data.shipped === 0 && orderCounts.data.refunding === 0,
  'counts=' + JSON.stringify(orderCounts.data || {}));
  // 记住 wdId 以便后续断言拆分后产生的 paid 佣金
  let _wdIdForCheck = '';
  // payNotify 回调验证金额、付款身份及幂等性。
  setOpenId('');
  const originalReceipt = recordChannelPayment(orderNo, orderDoc.transactionId);
  channelPayments.set(orderNo, { ...originalReceipt, totalFee: 1 });
  const wrongAmountNotify = (await call('payNotify', {
    outTradeNo: orderNo, transactionId: 'WRONG_AMOUNT_TXN', openid: 'mock-customer-B',
    totalFee: 1, resultCode: 'SUCCESS', returnCode: 'SUCCESS'
  })).result;
  step('权威查单金额不一致时拒绝入账', wrongAmountNotify.errcode !== 0);
  channelPayments.set(orderNo, { ...originalReceipt, subOpenid: 'mock-customer-A' });
  const wrongPayerNotify = (await call('payNotify', {
    outTradeNo: orderNo, transactionId: 'WRONG_PAYER_TXN',
    openid: 'mock-platform-payer', subOpenid: 'mock-customer-A',
    totalFee: orderDoc.totalFee, resultCode: 'SUCCESS', returnCode: 'SUCCESS'
  })).result;
  step('权威查单付款身份不一致时拒绝入账', wrongPayerNotify.errcode !== 0);
  channelPayments.set(orderNo, originalReceipt);
  const notify = (await call('payNotify', {
    outTradeNo: orderNo, transactionId: 'MOCK_TXN_001', openid: 'mock-customer-B',
    totalFee: orderDoc.totalFee, resultCode: 'SUCCESS', returnCode: 'SUCCESS'
  })).result;
  step('支付回调幂等', notify.errcode === 0, JSON.stringify(notify));

  // 支付时佣金只冻结，收货后才能结算。
  const comm = db._store.commissions.find(c => c.orderId === orderId);
  step('佣金记录创建', !!comm);
  step('佣金金额=1920', comm && comm.amount === 1920, '实际=' + (comm && comm.amount));
  step('佣金状态=frozen', comm && comm.status === 'frozen', '实际=' + (comm && comm.status));

  const orderAfterNotify = db._store.orders.find(o => o._id === orderId);
  step('订单 commissionStatus=frozen', orderAfterNotify.commissionStatus === 'frozen', '实际=' + orderAfterNotify.commissionStatus);
  const firstProductAfterPay = db._store.products.find(product => product._id === productId);
  step('支付后锁定库存转正式扣减', orderAfterNotify.inventoryStatus === 'committed' &&
    firstReservation.status === 'committed' && firstProductAfterPay.reservedStock === 0);
  step('支付现金流只写一笔', db._store.cashflow_entries.filter(entry => entry.idempotencyKey === 'payment:' + orderId).length === 1);

  const userCouponDoc = db._store.user_coupons.find(uc => uc._id === usableCoupon.userCouponId);
  step('订单与优惠券在同一事务核销', userCouponDoc.status === 'used' && userCouponDoc.orderId === orderId,
    '实际=' + userCouponDoc.status);

  header('Step 4.5: 多商品购物车结算（只删已结算商品）');
  setOpenId('mock-customer-B');
  // B 购物车放 3 件商品：2 件小紫瓶（不同规格/数量）+ 1 件占位商品
  const cartItems = [
    { productId, name: '小紫瓶', spec: '13.5g', price: 6900, quantity: 1, image: '' },
    { productId, name: '小紫瓶', spec: '27g', price: 12800, quantity: 2, image: '' },
    { productId: 'other-product', name: '其他商品', spec: '', price: 5000, quantity: 1, image: '' }
  ];
  await call('cart', { action: 'update', items: cartItems });
  // 只结算前 2 件（移除 other-product）。商品为单一价格 6900 分，规格不单独定价
  const removeKeys = ['other-product_'];
  const multiOrderNo = generateOrderNo();
  const multiRes = (await call('order', {
    action: 'create',
    orderNo: multiOrderNo,
    items: cartItems.filter(c => !removeKeys.includes(`${c.productId}_${c.spec || ''}`)),
    totalFee: 6900 * 1 + 6900 * 2,
    address: { name: '李四', phone: '13900139000', detail: '上海市浦东新区某路2号' },
    remark: '',
    removeCartKeys: removeKeys
  })).result;
  step('多商品下单成功', multiRes.success, 'orderId=' + (multiRes.orderId || multiRes.error));
  const multiOrderDoc = db._store.orders.find(o => o._id === multiRes.orderId);
  step('多商品订单含 2 个 item', multiOrderDoc && multiOrderDoc.items && multiOrderDoc.items.length === 2, '实际=' + (multiOrderDoc && multiOrderDoc.items && multiOrderDoc.items.length));
  // 验证购物车只删了 other-product，保留了 2 件小紫瓶
  const cartAfter = (await call('cart', { action: 'get' })).result;
  const remaining = (cartAfter.items || []);
  step('购物车保留 2 件', remaining.length === 2, '实际=' + remaining.length);
  step('被结算的 other-product 已移除', !remaining.find(i => i.productId === 'other-product'));

  header('Step 4.6: 真实格式支付回调 + 管理员发货');
  // CloudBase 官方回调使用 snake_case 字段；该格式必须能把 pending 订单落成 paid。
  setOpenId('');
  // This positive callback fixture represents a pre-existing original merchant binding.
  Object.assign(multiOrderDoc, { paymentSubMchId: 'mock-merchant', paymentPhase: 'open', prepayId: 'SYNTHETIC-ORIGINAL-PREPAY' });
  recordChannelPayment(multiOrderNo, 'MOCK_TXN_REAL_SHAPE');
  const realShapeNotify = (await call('payNotify', {
    out_trade_no: multiOrderNo,
    transaction_id: 'MOCK_TXN_REAL_SHAPE',
    openid: 'mock-customer-B',
    total_fee: multiOrderDoc.totalFee,
    result_code: 'SUCCESS',
    return_code: 'SUCCESS'
  })).result;
  step('snake_case 支付回调受理', realShapeNotify.errcode === 0, JSON.stringify(realShapeNotify));
  step('snake_case 回调后订单已 paid', multiOrderDoc.status === 'paid', '实际=' + multiOrderDoc.status);

  // 管理员只能发已支付订单。
  db._store.orders.push({
    _id: 'mock-pending-order',
    orderNo: 'MOCK_PENDING_ORDER',
    userId: 'mock-customer-B',
    totalFee: 100,
    status: 'pending',
    items: []
  });
  setOpenId('mock-owner');
  const rejectPendingShip = (await call('admin', {
    action: 'shipOrder', orderId: 'mock-pending-order', company: '顺丰', trackingNo: 'SF000'
  })).result;
  step('待支付订单禁止发货', !rejectPendingShip.success);
  const rejectMissingShip = (await call('admin', {
    action: 'shipOrder', orderId: 'missing-order', company: '顺丰', trackingNo: 'SF404'
  })).result;
  step('不存在订单禁止发货', !rejectMissingShip.success);
  const shipRes = (await call('admin', {
    action: 'shipOrder', orderId: multiRes.orderId, company: ' 顺丰 ', trackingNo: ' SF123456 '
  })).result;
  step('管理员发出已支付订单', shipRes.success, shipRes.error || '');
  step('订单状态=shipped 且物流已保存', multiOrderDoc.status === 'shipped' &&
    multiOrderDoc.logistics && multiOrderDoc.logistics.company === '顺丰' &&
    multiOrderDoc.logistics.trackingNo === 'SF123456');
  const rejectRepeatShip = (await call('admin', {
    action: 'shipOrder', orderId: multiRes.orderId, company: '顺丰', trackingNo: 'SF123456'
  })).result;
  step('已发货订单禁止重复发货', !rejectRepeatShip.success);

  const shipFirst = (await call('admin', {
    action: 'shipOrder', orderId, company: '中通快递', trackingNo: 'ZT123456'
  })).result;
  step('首笔订单发货', shipFirst.success);
  setOpenId('mock-customer-B');
  const receiveFirst = (await call('order', { action: 'updateStatus', id: orderId, status: 'received' })).result;
  const receiveMulti = (await call('order', { action: 'updateStatus', id: multiRes.orderId, status: 'received' })).result;
  step('客户确认两笔订单收货', receiveFirst.success && receiveMulti.success);
  step('确认收货后佣金转 settled', db._store.commissions.filter(item => item.agentId === 'mock-agent-A' && item.status === 'settled').length === 2);

  // 核心持久化失败时必须让支付平台重试，不能返回成功吞掉通知。
  db._store.orders.push({
    _id: 'mock-notify-failure-order',
    orderNo: 'MOCK_NOTIFY_FAILURE',
    paymentSubMchId: 'mock-merchant',
    paymentPhase: 'open',
    prepayId: 'SYNTHETIC-ORIGINAL-PREPAY',
    userId: 'mock-customer-B',
    totalFee: 100,
    status: 'pending',
    agentId: '',
    items: []
  });
  const collectionBeforeNotifyFailure = db.collection;
  db.collection = (name) => {
    const query = collectionBeforeNotifyFailure(name);
    if (name === 'orders') {
      const originalUpdate = query.update.bind(query);
      query.update = async payload => {
        if (query._docId === 'mock-notify-failure-order' || query._query._id === 'mock-notify-failure-order') {
          throw new Error('forced order update failure');
        }
        return originalUpdate(payload);
      };
    }
    return query;
  };
  setOpenId('');
  recordChannelPayment('MOCK_NOTIFY_FAILURE', 'MOCK_TXN_FAILURE');
  const retryableNotify = (await call('payNotify', {
    out_trade_no: 'MOCK_NOTIFY_FAILURE',
    transaction_id: 'MOCK_TXN_FAILURE',
    openid: 'mock-customer-B',
    total_fee: 100,
    result_code: 'SUCCESS',
    return_code: 'SUCCESS'
  })).result;
  db.collection = collectionBeforeNotifyFailure;
  step('支付回调持久化失败返回可重试错误', retryableNotify.errcode !== 0, JSON.stringify(retryableNotify));
  const failedNotifyOrder = db._store.orders.find(o => o._id === 'mock-notify-failure-order');
  step('失败回调未伪造 paid 状态', failedNotifyOrder.status === 'pending');

  header('Step 5: 分销员 A 申请提现');
  setOpenId('mock-agent-A');
  const wdInfo = (await call('withdrawal', { action: 'info' })).result;
  step('A 可提现=5025（两笔已支付订单）', wdInfo.available === 5025, '实际=' + wdInfo.available);
  step('A 处理中=0', wdInfo.pendingCount === 0);

  const withdrawalRequestId = 'wd_mock_agent_a_0001';
  const apply = (await call('withdrawal', {
    action: 'apply', amount: 1000, name: '分销员A', account: '6222021234567890', requestId: withdrawalRequestId
  })).result;
  step('申请提现 1000', apply.success);
  const duplicateApply = (await call('withdrawal', {
    action: 'apply', amount: 1000, name: '分销员A', account: '6222021234567890', requestId: withdrawalRequestId
  })).result;
  step('同一提现请求幂等复用原申请', duplicateApply.success && duplicateApply.duplicate && duplicateApply.withdrawalId === apply.withdrawalId);
  const wdInfo2 = (await call('withdrawal', { action: 'info' })).result;
  step('A 剩余可提现=4025', wdInfo2.available === 4025 && wdInfo2.pendingAmount === 1000, '实际=' + wdInfo2.available);

  // 验证申请边界: 微信商家转账最低 0.3 元
  const small = (await call('withdrawal', { action: 'apply', amount: 20, name: 'A', account: 'x' })).result;
  step('低于0.3元起提拦截', !small.success && small.error.indexOf('0.3') >= 0);

  // 验证申请超额应失败
  setOpenId('mock-agent-A');
  const over = (await call('withdrawal', { action: 'apply', amount: 99999, name: 'A', account: 'x' })).result;
  step('超额拦截', !over.success && over.error.indexOf('余额') >= 0);

  header('Step 6: 管理员审批提现');
  setOpenId('mock-owner');
  const pending = (await call('admin', { action: 'withdrawalList', statusFilter: 'pending' })).result;
  step('管理员看到 1 条 pending 提现', pending.data && pending.data.length === 1, '实际=' + (pending.data && pending.data.length));
  const wdId = pending.data[0]._id; _wdIdForCheck = wdId;

  const approve = (await call('admin', { action: 'processWithdrawal', withdrawalId: wdId, approve: true, remark: '已打款' })).result;
  step('审批通过', approve.success, 'consumed=' + (approve.consumed || ''));

  // 审核只占用佣金，渠道确认后才记已支付和现金支出。
  const originalComm = db._store.commissions.find(c => c.orderId === orderId && c.status === 'settled');
  step('原 settled 佣金扣减到 920', originalComm && originalComm.amount === 920, '实际=' + (originalComm && originalComm.amount));
  const paidComm = db._store.commissions.find(c => c.paidByWithdrawal === _wdIdForCheck);
  step('拆分出占用佣金 1000', paidComm && paidComm.amount === 1000, '实际=' + (paidComm && paidComm.amount));
  step('占用佣金 status=withdrawing', paidComm && paidComm.status === 'withdrawing', '实际=' + (paidComm && paidComm.status));
  step('待确认时不记现金支出', !db._store.cashflow_entries.some(entry => entry.idempotencyKey === 'commission_payout:' + wdId));
  setOpenId('mock-agent-A');
  const heldInfo = (await call('withdrawal', { action: 'info' })).result;
  const heldDash = (await call('agent', { action: 'dashboard' })).result;
  const heldList = (await call('agent', { action: 'commissions' })).result;
  step('提现余额与看板可用一致', heldInfo.available === heldDash.available && heldDash.paid === 0);
  step('佣金列表保留占用状态', heldList.data.some(c => c.status === 'withdrawing'));

  // 审核后已向微信发起转账，并保存 C 端拉起确认页所需的 package_info。
  const wdDoc = db._store.withdrawals.find(w => w._id === wdId);
  step('提现 status=transferring', wdDoc.status === 'transferring', '实际=' + wdDoc.status);
  step('提现保存微信收款确认凭证', !!wdDoc.packageInfo && wdDoc.transferState === 'WAIT_USER_CONFIRM');

  setOpenId('mock-customer-B');
  const forbiddenReceive = (await call('admin', { action: 'getOwnWithdrawalTransfer', withdrawalId: wdId })).result;
  step('非本人不能领取提现转账', !forbiddenReceive.success && forbiddenReceive.error.indexOf('无权') >= 0);
  setOpenId('mock-agent-A');
  const ownReceive = (await call('admin', { action: 'getOwnWithdrawalTransfer', withdrawalId: wdId })).result;
  step('分销员本人取得微信确认参数', ownReceive.success && ownReceive.ready &&
    ownReceive.mchId && ownReceive.appId && ownReceive.packageInfo === wdDoc.packageInfo);

  mockTransferState = 'SUCCESS';
  setOpenId('mock-owner');
  const confirmed = (await call('admin', { action: 'queryWithdrawalTransfer', withdrawalId: wdId })).result;
  step('模拟渠道确认成功后完成提现', confirmed.success && db._store.withdrawals.find(w => w._id === wdId).status === 'success');
  step('渠道成功后才标已支付', db._store.commissions.find(c => c.paidByWithdrawal === wdId).status === 'paid');

  // 重复审批应返回同一结果，且不能重复写资金流水。
  setOpenId('mock-owner');
  const dup = (await call('admin', { action: 'processWithdrawal', withdrawalId: wdId, approve: true })).result;
  step('重复审批幂等', dup.success && dup.alreadyProcessed &&
    db._store.cashflow_entries.filter(entry => entry.idempotencyKey === 'commission_payout:' + wdId).length === 1);

  header('Step 7: 申请退款');
  setOpenId('mock-customer-B');
  const refundReq = (await call('order', { action: 'requestRefund', id: orderId, reason: '不想要了', description: '测试' })).result;
  step('申请退款', refundReq.success);
  const orderRef = db._store.orders.find(o => o._id === orderId);
  step('订单状态=refunding', orderRef.status === 'refunding', '实际=' + orderRef.status);

  // 重复申请应幂等返回已有售后单。
  const dupRefund = (await call('order', { action: 'requestRefund', id: orderId, reason: 'x' })).result;
  step('重复退款申请幂等', dupRefund.success && dupRefund.duplicate && dupRefund.refundId === refundReq.refundId);

  header('Step 8: 财务确认退货并处理退款');
  setOpenId('mock-owner');
  const refundList = (await call('admin', { action: 'refundList', statusFilter: 'pending' })).result;
  step('管理员看到 1 条 pending 退款', refundList.data && refundList.data.length === 1);
  const rejectWithoutReturn = (await call('admin', { action: 'processRefund', refundId: refundList.data[0]._id, approve: true, adminNote: 'OK' })).result;
  step('退货未收货禁止退款', !rejectWithoutReturn.success && rejectWithoutReturn.error.includes('收到退回'));
  const processedRefund = (await call('admin', {
    action: 'processRefund', refundId: refundList.data[0]._id, approve: true,
    adminNote: '已验收', returnReceived: true, restock: true
  })).result;
  step('处理退款', processedRefund.success, 'msg=' + (processedRefund.message || ''));
  const orderFinal = db._store.orders.find(o => o._id === orderId);
  step('订单状态=refunded', orderFinal.status === 'refunded', '实际=' + orderFinal.status);
  const reversal = db._store.commissions.find(item => item.orderId === orderId && item.type === 'reversal' && item.amount === -1000);
  step('已提现佣金生成负向冲销', reversal && reversal.amount === -1000 && reversal.status === 'settled');
  const reversals = db._store.commissions.filter(item => item.orderId === orderId && item.type === 'reversal');
  step('结算后退款保留原流水并全额冲销', reversals.reduce((sum, item) => sum + item.amount, 0) === -1920);
  step('退款、佣金支出现金流各一笔',
    db._store.cashflow_entries.filter(entry => entry.idempotencyKey === 'refund:' + orderId).length === 1 &&
    db._store.cashflow_entries.filter(entry => entry.idempotencyKey === 'commission_payout:' + wdId).length === 1);

  header('Step 9: checkAdmin 权限校验');
  // 非管理员
  setOpenId('mock-customer-B');
  const noAdmin = (await call('admin', { action: 'checkAdmin' })).result;
  step('非管理员 checkAdmin 拒绝', !noAdmin.success && noAdmin.error.indexOf('管理员') >= 0);

  // 管理员
  setOpenId('mock-owner');
  const yesAdmin = (await call('admin', { action: 'checkAdmin' })).result;
  step('管理员 checkAdmin 通过', yesAdmin.success);

  header('Step 9.5: Web 后台账号与三角色 RBAC');
  const ownerLogin = (await call('admin', { action: 'login', username: 'owner', password: 'owner-password' })).result;
  step('旧后台密码迁移为 owner 账号', ownerLogin.success && ownerLogin.account.role === 'owner');

  header('Step 9.5a: 微信扫码登录后台');
  setOpenId('mock-web-anonymous');
  const qrCreate = (await call('adminQrAuth', { action: 'createQrLogin' })).result;
  step('Web 创建两分钟扫码票据', qrCreate.success && qrCreate.qrDataUrl.startsWith('data:image/png;base64,') && qrCreate.pollSecret);
  setOpenId('mock-customer-B');
  const qrForbidden = (await call('adminQrAuth', { action: 'inspectQrLogin', scene: qrCreate.scene })).result;
  step('非管理员微信不能确认后台登录', !qrForbidden.success && qrForbidden.status === 'forbidden');
  setOpenId('mock-owner');
  const qrInspect = (await call('adminQrAuth', { action: 'inspectQrLogin', scene: qrCreate.scene })).result;
  const qrConfirm = (await call('adminQrAuth', { action: 'confirmQrLogin', scene: qrCreate.scene })).result;
  step('旧 owner OpenID 自动绑定并确认', qrInspect.success && qrConfirm.success && qrConfirm.account.role === 'owner');
  setOpenId('mock-web-anonymous');
  const qrPoll = (await call('adminQrAuth', {
    action: 'pollQrLogin', publicId: qrCreate.publicId, pollSecret: qrCreate.pollSecret
  })).result;
  step('扫码确认后签发自定义登录和后台会话', qrPoll.success && qrPoll.cloudbaseTicket && qrPoll.adminToken && qrPoll.account.role === 'owner');
  const qrDashboard = (await call('admin', { action: 'dashboard', adminToken: qrPoll.adminToken })).result;
  step('扫码会话可按 owner 权限进入后台', qrDashboard.success);
  const qrRepeat = (await call('adminQrAuth', {
    action: 'pollQrLogin', publicId: qrCreate.publicId, pollSecret: qrCreate.pollSecret
  })).result;
  step('扫码票据只能消费一次', !qrRepeat.success && qrRepeat.status === 'consumed');
  const expiredCreate = (await call('adminQrAuth', { action: 'createQrLogin' })).result;
  const expiredTicket = db._store.admin_login_tickets.find(item => item.publicId === expiredCreate.publicId);
  expiredTicket.expiresAt = new Date(Date.now() - 1000);
  const expiredPoll = (await call('adminQrAuth', {
    action: 'pollQrLogin', publicId: expiredCreate.publicId, pollSecret: expiredCreate.pollSecret
  })).result;
  step('过期扫码票据拒绝登录', !expiredPoll.success && expiredPoll.status === 'expired');

  setOpenId('mock-web-session');
  const createOps = (await call('admin', {
    action: 'createAccount', adminToken: ownerLogin.token, username: 'operations1',
    displayName: '运营一号', role: 'operations', password: 'operations-password'
  })).result;
  const createFinance = (await call('admin', {
    action: 'createAccount', adminToken: ownerLogin.token, username: 'finance1',
    displayName: '财务一号', role: 'finance', password: 'finance-password'
  })).result;
  step('店主创建运营和财务账号', createOps.success && createFinance.success);
  const opsLogin = (await call('admin', { action: 'login', username: 'operations1', password: 'operations-password' })).result;
  const opsProducts = (await call('admin', { action: 'productList', adminToken: opsLogin.token })).result;
  const opsFinance = (await call('admin', { action: 'financeOverview', adminToken: opsLogin.token })).result;
  step('运营可管理商品但不可查看财务', opsProducts.success && !opsFinance.success && opsFinance.code === 'FORBIDDEN');
  const financeLogin = (await call('admin', { action: 'login', username: 'finance1', password: 'finance-password' })).result;
  const financeView = (await call('admin', { action: 'financeOverview', adminToken: financeLogin.token })).result;
  const financeProductEdit = (await call('admin', { action: 'toggleProductStatus', adminToken: financeLogin.token, id: productId, status: 'off' })).result;
  step('财务可查看经营收支但不可修改商品', financeView.success && !financeProductEdit.success && financeProductEdit.code === 'FORBIDDEN');
  const queryRefund = refundList.data[0];
  const queryOrder = db._store.orders.find(item => item._id === queryRefund.orderId);
  const originalQueryOrder = { ...queryOrder };
  const queryPayConfig = db._store.pay_config.find(item => item._id === 'default');
  const originalSubMchId = queryPayConfig.subMchId;
  queryPayConfig.subMchId = 'test-query-merchant';
  const originalRefundApi = cloud.cloudPay.refund;
  let refundQueryCalls = 0;
  let refundWriteCalls = 0;
  Object.assign(queryOrder, { paymentSource: 'wechatPay', transactionId: 'WX_QUERY_TEST' });
  const querySnapshot = JSON.stringify(db._store);
  cloud.cloudPay.refund = async () => { refundWriteCalls++; throw new Error('只读查询禁止退款'); };
  cloud.cloudPay.queryRefund = async params => {
    refundQueryCalls++;
    return { returnCode: 'SUCCESS', resultCode: 'SUCCESS', refundCount: 1,
      outRefundNo0: params.outRefundNo, refundStatus0: 'SUCCESS', refundFee0: queryOrder.totalFee };
  };
  const opsQuery = (await call('admin', { action: 'queryRefundStatus', refundId: queryRefund._id, adminToken: opsLogin.token })).result;
  step('运营无权查询渠道退款且不调用支付渠道', !opsQuery.success && opsQuery.code === 'FORBIDDEN' && refundQueryCalls === 0);
  const financeQuery = (await call('admin', { action: 'queryRefundStatus', refundId: queryRefund._id, adminToken: financeLogin.token })).result;
  step('财务可只读查询微信退款结果', financeQuery.success && financeQuery.data.status === 'SUCCESS');
  step('退款查询不重复退款、不改数据库', refundWriteCalls === 0 && refundQueryCalls === 1 && JSON.stringify(db._store) === querySnapshot);
  Object.assign(queryOrder, originalQueryOrder);
  queryPayConfig.subMchId = originalSubMchId;
  cloud.cloudPay.refund = originalRefundApi;
  delete cloud.cloudPay.queryRefund;
  step('经营现金流汇总正确', financeView.data.receipts === 33500 && financeView.data.refunds === 12800 &&
    financeView.data.commissionPaid === 1000 && financeView.data.netCashflow === 19700,
  JSON.stringify(financeView.data));

  setOpenId('mock-agent-A');
  const sanitizedCommissions = (await call('agent', { action: 'commissions', pageSize: 20 })).result;
  step('C 端佣金明细不含客户隐私', sanitizedCommissions.success && sanitizedCommissions.data.every(item =>
    !Object.prototype.hasOwnProperty.call(item, 'address') && !Object.prototype.hasOwnProperty.call(item, 'phone') && !Object.prototype.hasOwnProperty.call(item, 'userId')));

  header('Step 9.6: 取消订单释放库存与防超卖');
  setOpenId('mock-customer-B');
  const cancelNo = generateOrderNo();
  const cancelCreate = (await call('order', {
    action: 'create', orderNo: cancelNo,
    items: [{ productId, spec: '13.5g', quantity: 1 }], totalFee: 6900,
    address: { name: '王五', phone: '13700137000', detail: '测试地址' }
  })).result;
  const cancelReservation = db._store.inventory_reservations.find(item => item.orderId === cancelCreate.orderId);
  const cancelResult = (await call('order', { action: 'cancel', id: cancelCreate.orderId })).result;
  const cancelOrder = db._store.orders.find(item => item._id === cancelCreate.orderId);
  step('取消待支付订单并释放库存', cancelResult.success && cancelOrder.status === 'closed' && cancelReservation.status === 'released');
  const timeoutCreate = (await call('order', {
    action: 'create', orderNo: generateOrderNo(), items: [{ productId, spec: '13.5g', quantity: 1 }],
    totalFee: 6900, address: { name: '王五', phone: '13700137000', detail: '测试地址' }
  })).result;
  const timeoutOrder = db._store.orders.find(item => item._id === timeoutCreate.orderId);
  const timeoutReservation = db._store.inventory_reservations.find(item => item.orderId === timeoutCreate.orderId);
  timeoutOrder.expireTime = new Date(Date.now() - 1000);
  db._store.orders.push({
    _id: 'mock-auto-receive', orderNo: 'MOCK_AUTO_RECEIVE', userId: 'mock-customer-B',
    agentId: 'mock-agent-A', status: 'shipped', commissionStatus: 'frozen',
    shipTime: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000), items: [], totalFee: 100
  });
  db._store.commissions.push({
    _id: 'mock-auto-commission', idempotencyKey: 'commission:mock-auto-receive', type: 'earning',
    agentId: 'mock-agent-A', orderId: 'mock-auto-receive', orderNo: 'MOCK_AUTO_RECEIVE',
    amount: 15, status: 'frozen', createTime: new Date()
  });
  setOpenId('');
  const maintenance = (await call('maintenance', {})).result;
  step('30 分钟超时关单并释放库存', maintenance.success && timeoutOrder.status === 'closed' && timeoutReservation.status === 'released');
  step('发货 7 天自动收货并结算佣金',
    db._store.orders.find(item => item._id === 'mock-auto-receive').status === 'received' &&
    db._store.commissions.find(item => item._id === 'mock-auto-commission').status === 'settled');
  setOpenId('mock-customer-B');
  const oversell = (await call('order', {
    action: 'create', orderNo: generateOrderNo(), items: [{ productId, spec: '13.5g', quantity: 99999 }],
    totalFee: 6900 * 99999, address: { name: '王五', phone: '13700137000', detail: '测试地址' }
  })).result;
  step('超出可售库存时拒绝下单', !oversell.success && oversell.error.includes('库存不足'));

  header('Step 10: 收藏 / 搜索 / 分类');
  setOpenId('mock-customer-B');
  const fav = (await call('favorite', { action: 'toggle', productId })).result;
  step('切换收藏', fav.success);
  const fav2 = (await call('favorite', { action: 'toggle', productId })).result;
  step('再次切换（取消）', fav2.success && fav2.favorited === false);
  const favList = (await call('favorite', { action: 'list' })).result;
  step('收藏列表空（已取消）', favList.data && favList.data.length === 0);

  const search = (await call('product', { action: 'search', keyword: '小紫瓶' })).result;
  step('搜索"小紫瓶"命中', search.data && search.data.length >= 1, '命中=' + (search.data && search.data.length));

  const catProducts = (await call('category', { action: 'products', id: cats.data[0]._id })).result;
  step('分类下商品', catProducts.data && Array.isArray(catProducts.data));

  header('Step 11: 客服 chat 消息收发 / 拉取 / markAsRead');
  setOpenId('mock-customer-B');
  const sendRes = (await call('chat', { action: 'sendMessage', type: 'text', content: '你好,小紫瓶几天发货?' })).result;
  step('B 发消息', sendRes.success, 'messageId=' + (sendRes.messageId || ''));
  const getRes = (await call('chat', { action: 'getMessages' })).result;
  step('B 拉消息 1 条', getRes.data && getRes.data.length === 1, '实际=' + (getRes.data && getRes.data.length));
  // markAsRead 不报错即可
  const markRes = (await call('chat', { action: 'markAsRead' })).result;
  step('B markAsRead', markRes.success);
  // 管理员视角拉会话列表
  setOpenId('mock-owner');
  const conv = (await call('chat', { action: 'getConversationList' })).result;
  step('管理员看到 1 个会话', conv.data && conv.data.length === 1, '实际=' + (conv.data && conv.data.length));
  // 管理员回复
  const reply = (await call('chat', { action: 'sendMessage', content: '亲,24 小时内发货~', toId: 'mock-customer-B' })).result;
  step('管理员回复', reply.success);

  header('Step 12: 店主清理测试交易数据');
  setOpenId('mock-web-session');
  const forbiddenCleanup = (await call('admin', {
    action: 'transactionCleanupPreview', adminToken: opsLogin.token
  })).result;
  step('运营无权清理测试交易', !forbiddenCleanup.success && forbiddenCleanup.code === 'FORBIDDEN');
  setOpenId('mock-owner');
  const cleanupPreview = (await call('admin', { action: 'transactionCleanupPreview' })).result;
  step('清理前只读预检返回订单及关联数量', cleanupPreview.success && cleanupPreview.data.orders > 0 &&
    cleanupPreview.data.inventoryReservations > 0 && cleanupPreview.data.cashflowEntries > 0);
  const rejectedCleanup = (await call('admin', {
    action: 'purgeTestTransactions', confirm: 'WRONG_CONFIRM',
    expectedOrderCount: cleanupPreview.data.orders
  })).result;
  step('错误确认码不能删除交易数据', !rejectedCleanup.success && db._store.orders.length === cleanupPreview.data.orders);
  const cleanup = (await call('admin', {
    action: 'purgeTestTransactions', confirm: 'PURGE_TEST_TRANSACTIONS',
    expectedOrderCount: cleanupPreview.data.orders
  })).result;
  step('店主可幂等清理完整测试交易链', cleanup.success &&
    ['orders', 'inventory_reservations', 'refunds', 'commissions', 'withdrawals', 'cashflow_entries']
      .every(name => (db._store[name] || []).length === 0));
  step('订单关联库存调整记录已清理', (db._store.inventory_adjustments || []).every(item => !item.orderId));
  step('订单绑定优惠券恢复为未使用', (db._store.user_coupons || [])
    .filter(item => item._id === userCouponDoc._id)
    .every(item => item.status === 'unused' && item.orderId === null));
  step('清理保留商品、用户和后台账号', (db._store.products || []).length > 0 &&
    (db._store.users || []).length > 0 && (db._store.admin_accounts || []).length > 0);

  header('Step 13: 满减规则配置与下单联动');
  // 读取当前佣金比例（与 order 云函数 getCommissionRate 口径一致）
  const frPayCfg = db._store.pay_config.find(i => i._id === 'default');
  const frAdminCfg = (db._store.admin_config || []).find(d => d._id === 'admin');
  const frRate = typeof (frPayCfg && frPayCfg.commissionRate) === 'number' ? frPayCfg.commissionRate
    : typeof (frAdminCfg && frAdminCfg.commissionRate) === 'number' ? frAdminCfg.commissionRate : 0.15;

  setOpenId('mock-owner');
  const badFr = (await call('admin', {
    action: 'setFullReduction',
    fullReduction: { enabled: true, rules: [{ threshold: 5000, discount: 6000 }] }
  })).result;
  step('优惠大于门槛的规则被拒绝', !badFr.success);

  const saveFr = (await call('admin', {
    action: 'setFullReduction',
    fullReduction: {
      enabled: true,
      rules: [{ threshold: 20000, discount: 3000 }, { threshold: 10000, discount: 1000 }]
    }
  })).result;
  step('店主保存满减规则', saveFr.success);

  const promotions = (await call('coupon', { action: 'promotions' })).result;
  step('公开读取满减规则（启用+按门槛升序）', promotions.success && promotions.data.enabled &&
    promotions.data.rules.length === 2 && promotions.data.rules[0].threshold === 10000);

  setOpenId('mock-customer-B');
  // 2×6900=13800，命中满10000减1000
  const frOrder1 = (await call('order', {
    action: 'create', orderNo: generateOrderNo(),
    items: [{ productId, spec: '13.5g', quantity: 2 }], totalFee: 12800,
    address: { name: '王五', phone: '13700137000', detail: '测试地址' },
    fullReductionDiscount: 1000
  })).result;
  const frOrder1Doc = db._store.orders.find(o => o._id === frOrder1.orderId);
  step('满减订单实付 12800', frOrder1.success && frOrder1.totalFee === 12800 &&
    frOrder1.fullReductionDiscount === 1000 && frOrder1Doc.totalFee === 12800);
  step('佣金按满减后实付计算',
    frOrder1Doc.commission === Math.round(12800 * frRate),
    '期望=' + Math.round(12800 * frRate) + ' 实际=' + frOrder1Doc.commission);

  // 前端传入的满减金额与服务端不一致时拒绝
  const frMismatch = (await call('order', {
    action: 'create', orderNo: generateOrderNo(),
    items: [{ productId, spec: '13.5g', quantity: 2 }], totalFee: 12800,
    address: { name: '王五', phone: '13700137000', detail: '测试地址' },
    fullReductionDiscount: 999
  })).result;
  step('满减金额不一致时拒绝下单', !frMismatch.success && frMismatch.error.includes('优惠信息已变化'));

  // 满减 + 优惠券叠加：13800 → 满10000减1000 → 12800 → 券再减1000 → 11800
  const frOrder2 = (await call('order', {
    action: 'create', orderNo: generateOrderNo(),
    items: [{ productId, spec: '13.5g', quantity: 2 }], totalFee: 11800,
    address: { name: '王五', phone: '13700137000', detail: '测试地址' },
    couponId: userCouponDoc._id, couponDiscount: 1000,
    fullReductionDiscount: 1000
  })).result;
  const frOrder2Doc = db._store.orders.find(o => o._id === frOrder2.orderId);
  step('满减与优惠券叠加实付 11800', frOrder2.success && frOrder2.totalFee === 11800 &&
    frOrder2Doc.couponDiscount === 1000 && frOrder2Doc.fullReductionDiscount === 1000);
  step('叠加后佣金仍按实付计算',
    frOrder2Doc.commission === Math.round(11800 * frRate),
    '期望=' + Math.round(11800 * frRate) + ' 实际=' + frOrder2Doc.commission);

  // 未达门槛：1×6900=6900 < 10000，无满减
  const frOrder3 = (await call('order', {
    action: 'create', orderNo: generateOrderNo(),
    items: [{ productId, spec: '13.5g', quantity: 1 }], totalFee: 6900,
    address: { name: '王五', phone: '13700137000', detail: '测试地址' },
    fullReductionDiscount: 0
  })).result;
  const frOrder3Doc = db._store.orders.find(o => o._id === frOrder3.orderId);
  step('未达门槛无满减', frOrder3.success && frOrder3Doc.fullReductionDiscount === 0 &&
    frOrder3Doc.totalFee === 6900);

  // 3×6900=20700 命中更高档 满20000减3000
  const frOrder4 = (await call('order', {
    action: 'create', orderNo: generateOrderNo(),
    items: [{ productId, spec: '13.5g', quantity: 3 }], totalFee: 17700,
    address: { name: '王五', phone: '13700137000', detail: '测试地址' },
    fullReductionDiscount: 3000
  })).result;
  step('阶梯规则命中更高档减 3000', frOrder4.success && frOrder4.totalFee === 17700 &&
    frOrder4.fullReductionDiscount === 3000);

  // 停用满减后规则不再生效
  setOpenId('mock-owner');
  const disableFr = (await call('admin', {
    action: 'setFullReduction',
    fullReduction: { enabled: false, rules: [{ threshold: 10000, discount: 1000 }] }
  })).result;
  step('停用满减', disableFr.success);
  const disabledPromotions = (await call('coupon', { action: 'promotions' })).result;
  step('停用后公开接口返回未启用', disabledPromotions.success && disabledPromotions.data.enabled === false);
  setOpenId('mock-customer-B');
  const frOrder5 = (await call('order', {
    action: 'create', orderNo: generateOrderNo(),
    items: [{ productId, spec: '13.5g', quantity: 2 }], totalFee: 13800,
    address: { name: '王五', phone: '13700137000', detail: '测试地址' }
  })).result;
  const frOrder5Doc = db._store.orders.find(o => o._id === frOrder5.orderId);
  step('停用后下单不再享受满减', frOrder5.success && frOrder5Doc.totalFee === 13800 &&
    frOrder5Doc.fullReductionDiscount === 0);

  // ===== 汇总 =====
  const pass = results.filter(r => r.ok).length;
  const fail = results.filter(r => !r.ok).length;
  console.log('\n════════════════════════════════════════════');
  console.log(' 通过: ' + pass);
  console.log(' 失败: ' + fail);
  console.log('════════════════════════════════════════════');
  if (fail > 0) {
    console.log('\n❌ 失败项:');
    results.filter(r => !r.ok).forEach(r => console.log('  - ' + r.name + (r.detail ? ' [' + r.detail + ']' : '')));
    process.exitCode = 1;
  } else {
    console.log('\n✅ 全部业务流通过');
  }
}

main().catch(err => {
  console.error('E2E mock 异常:', err);
  process.exitCode = 1;
});
