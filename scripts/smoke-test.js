#!/usr/bin/env node
// =============================================================
// 林元元中医生活 — 业务规则 smoke test
// 运行: node scripts/smoke-test.js
//
// 不依赖云开发环境，本地静态检查 + 关键业务规则验证。
// =============================================================

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const failures = [];
const passes = [];

function ok(name) { passes.push(name); }
function fail(name, reason) { failures.push({ name, reason }); }

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}
function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

// ---------- 1. 文件结构 ----------
console.log('▶ 静态结构检查');

const required = [
  // 云函数
  'cloudfunctions/init/index.js',
  'cloudfunctions/login/index.js',
  'cloudfunctions/product/index.js',
  'cloudfunctions/cart/index.js',
  'cloudfunctions/order/index.js',
  'cloudfunctions/pay/index.js',
  'cloudfunctions/agent/index.js',
  'cloudfunctions/commission/index.js',
  'cloudfunctions/withdrawal/index.js',
  'cloudfunctions/admin/index.js',
  'cloudfunctions/adminQrAuth/index.js',
  'cloudfunctions/adminQrAuth/package.json',
  'cloudfunctions/adminQrAuth/ticket-core.js',
  'cloudfunctions/promotion/index.js',
  'cloudfunctions/maintenance/index.js',
  'cloudfunctions/banner/index.js',
  'cloudfunctions/banner/package.json',
  // 前端页面
  'miniprogram/app.js',
  'miniprogram/app.json',
  'miniprogram/app.wxss',
  'miniprogram/utils/api.js',
  'miniprogram/utils/cloud.js',
  'miniprogram/utils/util.js',
  'miniprogram/pages/index/index.js',
  'miniprogram/pages/index/index.wxml',
  'miniprogram/pages/product/product.js',
  'miniprogram/pages/cart/cart.js',
  'miniprogram/pages/checkout/checkout.js',
  'miniprogram/pages/order/order.js',
  'miniprogram/pages/order-detail/order-detail.js',
  'miniprogram/pages/user/user.js',
  'miniprogram/pages/address/address.js',
  'miniprogram/pages/address-edit/address-edit.js',
  'miniprogram/pages/logistics/logistics.js',
  'miniprogram/pages/about/about.js',
  'miniprogram/subpackages/distributor/bind/bind.js',
  'miniprogram/subpackages/distributor/dashboard/dashboard.js',
  'miniprogram/subpackages/distributor/promotion/promotion.js',
  'miniprogram/subpackages/distributor/commissions/commissions.js',
  'miniprogram/subpackages/distributor/withdrawal/withdrawal.js',
  'miniprogram/subpackages/distributor/profile/profile.js',
  'admin-web/app.js',
  'scripts/admin-qr-auth-test.js',
  'scripts/release-gap-test.js',
  'scripts/refund-diagnostics-test.js',
  'cloudfunctions/admin/refund-query.js',
  'scripts/migrate-abc.js',
  // 配置
  'project.config.json',
  'cloudbaserc.json',
  'database-indexes.json',
];
required.forEach(rel => {
  if (exists(rel)) ok('exists: ' + rel);
  else fail('exists: ' + rel, 'file not found');
});

// 校验 app.json 中注册的每个页面都有 js/wxml/wxss/json 四件套、tabBar 图标存在
const appJson = JSON.parse(read('miniprogram/app.json'));
const customerHomeWxml = read('miniprogram/pages/index/index.wxml');
const userCenterWxml = read('miniprogram/pages/user/user.wxml');
if (/goDistributorCenter|分享赚钱/.test(userCenterWxml)) {
  fail('A 端角色隔离', '个人中心仍包含无条件分销入口');
} else if (/分销中心/.test(userCenterWxml)) {
  // 已激活分销员可见的条件入口：普通消费者不可见，不违背角色隔离
  if (/wx:if="\{\{isAgent\}\}"[^>]*url="\/subpackages\/distributor\/dashboard\/dashboard"/.test(userCenterWxml)) {
    ok('A 端个人中心分销入口仅对已激活分销员显示（isAgent 条件保护）');
  } else {
    fail('A 端角色隔离', '个人中心分销入口缺少 isAgent 条件保护');
  }
} else {
  ok('A 端个人中心不展示分销入口');
}
for (const page of appJson.pages) {
  for (const ext of ['js', 'wxml', 'wxss', 'json']) {
    const rel = 'miniprogram/' + page + '.' + ext;
    if (exists(rel)) ok('page ' + ext + ': ' + page);
    else fail('page ' + ext, rel + ' 缺失');
  }
}
for (const pkg of appJson.subPackages || []) {
  for (const page of pkg.pages || []) {
    for (const ext of ['js', 'wxml', 'wxss', 'json']) {
      const rel = `miniprogram/${pkg.root}/${page}.${ext}`;
      if (exists(rel)) ok(`subpackage ${ext}: ${pkg.root}/${page}`);
      else fail('subpackage ' + ext, rel + ' 缺失');
    }
  }
}
const tabList = (appJson.tabBar && appJson.tabBar.list) || [];
for (const t of tabList) {
  if (exists('miniprogram/' + t.iconPath)) ok('tabBar icon: ' + t.iconPath);
  else fail('tabBar icon', t.iconPath + ' 缺失');
  if (exists('miniprogram/' + t.selectedIconPath)) ok('tabBar icon (active): ' + t.selectedIconPath);
  else fail('tabBar icon (active)', t.selectedIconPath + ' 缺失');
}

// ---------- 2. 配置正确性 ----------
console.log('▶ 配置正确性');

const projectConfig = JSON.parse(read('project.config.json'));
const databaseIndexes = JSON.parse(read('database-indexes.json'));
if (projectConfig.appid && projectConfig.appid !== 'your-app-id') {
  ok('appid 已配置: ' + projectConfig.appid);
} else {
  fail('appid', '尚未填写真实 AppID');
}

const cloudbaserc = JSON.parse(read('cloudbaserc.json'));
if (cloudbaserc.envId && cloudbaserc.envId !== 'your-env-id') {
  ok('云环境 envId: ' + cloudbaserc.envId);
} else {
  fail('envId (cloudbaserc)', '尚未填写');
}

const manifestFunctionNames = new Set((cloudbaserc.functions || []).map(item => item.name));
const clientApiSrc = read('miniprogram/utils/api.js');
const clientFunctionNames = new Set(Array.from(clientApiSrc.matchAll(/\bcall\('([^']+)'/g), match => match[1]));
const requiredRuntimeFunctions = new Set([...clientFunctionNames, 'payNotify', 'maintenance']);
const missingManifestFunctions = [...requiredRuntimeFunctions].filter(name => !manifestFunctionNames.has(name));
if (missingManifestFunctions.length === 0) {
  ok('CloudBase 清单覆盖全部客户端与回调函数');
} else {
  fail('CloudBase 函数清单', '缺少: ' + missingManifestFunctions.join(', '));
}

const invalidManifestFunctions = [...manifestFunctionNames].filter(name =>
  !exists(`cloudfunctions/${name}/index.js`) || !exists(`cloudfunctions/${name}/package.json`));
if (invalidManifestFunctions.length === 0) {
  ok('CloudBase 清单中的函数均可打包');
} else {
  fail('CloudBase 函数目录', '缺少 index.js 或 package.json: ' + invalidManifestFunctions.join(', '));
}

const productionForbiddenFunctions = ['init', 'updateProductDesc', 'uploadProductImage']
  .filter(name => manifestFunctionNames.has(name));
if (productionForbiddenFunctions.length === 0) {
  ok('正式部署清单不暴露一次性数据写入函数');
} else {
  fail('CloudBase 正式部署边界', '应移除: ' + productionForbiddenFunctions.join(', '));
}

const floatingSdkFunctions = fs.readdirSync(path.join(ROOT, 'cloudfunctions')).filter(name => {
  const packagePath = `cloudfunctions/${name}/package.json`;
  if (!exists(packagePath)) return false;
  const pkg = JSON.parse(read(packagePath));
  return pkg.dependencies && pkg.dependencies['wx-server-sdk'] === 'latest';
});
if (floatingSdkFunctions.length === 0) {
  ok('云函数 SDK 版本均已固定');
} else {
  fail('云函数 SDK 版本', '禁止使用 latest: ' + floatingSdkFunctions.join(', '));
}

const appJs = read('miniprogram/app.js');
const envIdMatch = appJs.match(/envId:\s*['"]([^'"]+)['"]/);
if (envIdMatch && envIdMatch[1] !== 'your-env-id') {
  ok('app.js envId: ' + envIdMatch[1]);
} else {
  fail('envId (app.js)', '尚未填写');
}

if (projectConfig.appid && cloudbaserc.envId && envIdMatch &&
    projectConfig.appid !== 'your-app-id' &&
    cloudbaserc.envId !== 'your-env-id') {
  ok('AppID 与云环境 ID 一致性已就绪');
}

// ---------- 3. 关键业务规则 ----------
console.log('▶ 关键业务规则');

const orderSrc = read('cloudfunctions/order/index.js');
// 新规则默认 33%，显式配置的历史比例由 E2E 与 commission-policy-test 覆盖。
const COMMISSION_RATE_MATCH = orderSrc.match(/COMMISSION_RATE\s*=\s*([\d.]+)/);
const DYNAMIC_RATE_MATCH = orderSrc.match(/commissionRate[^\d]*([\d.]+)/);
const rate = COMMISSION_RATE_MATCH ? parseFloat(COMMISSION_RATE_MATCH[1]) : (DYNAMIC_RATE_MATCH ? parseFloat(DYNAMIC_RATE_MATCH[1]) : null);
if (rate === 0.33) ok('默认佣金比例 = 33%');
else fail('佣金比例', '默认应为 0.33，实际 ' + rate);

const agentSrc = read('cloudfunctions/agent/index.js');
if (agentSrc.includes('generateReferralCode') && agentSrc.includes('crypto.randomInt') &&
    agentSrc.includes("where({ referralCode: code })")) {
  ok('推广码使用随机唯一值，不再派生自 OpenID');
} else fail('推广码生成', '必须使用随机码并检查唯一性');

const withdrawalSrc = read('cloudfunctions/withdrawal/index.js');
if (withdrawalSrc.includes('amount <= 0') && withdrawalSrc.includes('amount < 30') &&
    withdrawalSrc.includes('0.3 元')) {
  ok('提现仅保留 0.3 元微信转账下限（无其他最低金额限制）');
} else {
  fail('提现金额下限', '应只保留微信转账 0.3 元下限（amount < 30 拒绝），不应有其他限制');
}

const initSrc = read('cloudfunctions/init/index.js');
if (initSrc.includes('admin_config')) {
  ok('init 函数会创建 admin_config 文档');
} else {
  fail('admin_config 创建', 'init 函数中未发现 admin_config 创建逻辑');
}

const adminSrc = read('cloudfunctions/admin/index.js');
const withdrawalEffectsSrc = read('cloudfunctions/admin/withdrawal-effects.js');
if (adminSrc.includes('createWithdrawalService') && withdrawalEffectsSrc.includes("status: 'withdrawing'") &&
    withdrawalEffectsSrc.includes('paidByWithdrawal') && withdrawalEffectsSrc.includes("status: 'paid'")) {
  ok('提现审核占用佣金，渠道成功后才标已支付（防重复提现与提前入账）');
} else {
  fail('admin.processWithdrawal', '未发现消耗 settled 佣金的逻辑');
}

const bannerSrc = read('cloudfunctions/banner/index.js');
const homePageSrc = read('miniprogram/pages/index/index.js');
const userPageSrc = read('miniprogram/pages/user/user.js');
const cartPageSrc = read('miniprogram/pages/cart/cart.js');
const cartFunctionSrc = read('cloudfunctions/cart/index.js');
const apiSrc = read('miniprogram/utils/api.js');
const searchSrc = read('miniprogram/pages/search/search.js');
const skeletonSrc = read('miniprogram/components/skeleton/skeleton.wxml');
if (!bannerSrc.includes('admin_config') && !bannerSrc.includes("collection('admin") &&
    bannerSrc.includes("event.action !== 'list'") && bannerSrc.includes("banner.status === 'on'") &&
    bannerSrc.includes('Number(a.sort)') && bannerSrc.includes('.slice(0, 20)')) {
  ok('banner:list 为公开的上架排序读取（无索引依赖）');
} else {
  fail('banner:list 公共边界', '不得读取管理员配置，且必须限制 action/状态并在服务端排序');
}
if (bannerSrc.includes('_id: banner._id') && bannerSrc.includes('imageUrl:') && bannerSrc.includes('title:') && bannerSrc.includes('linkUrl:')) {
  ok('banner:list Banner 字段白名单');
} else {
  fail('banner:list Banner 字段', '必须仅映射公开字段');
}
if (bannerSrc.includes('cloud.getTempFileURL') && bannerSrc.includes("imageUrl.indexOf('cloud://') === 0")) {
  ok('banner:list 云文件图片转临时 URL');
} else {
  fail('banner:list 云文件图片', 'cloud:// 图片必须在云函数返回前转成可渲染 URL');
}
if (apiSrc.includes("getBannerList: (options) => call('banner', { action: 'list' }") &&
    !apiSrc.includes('getHomeFeed:') && homePageSrc.includes('API.getProductList') &&
    homePageSrc.includes('API.getBannerList') && homePageSrc.includes('BANNER_CACHE_TTL')) {
  ok('首页使用独立商品和公开 Banner 缓存');
} else {
  fail('首页独立 Banner 缓存', '首页必须独立加载商品和公开 Banner，不得使用 home/admin 聚合接口');
}
if (apiSrc.includes("getHotKeywords: (options) => call('category', { action: 'hotKeywords' }") &&
    searchSrc.includes('Promise.all([categoryPromise, hotKeywordPromise])') &&
    !searchSrc.includes('wx.cloud.callFunction')) {
  ok('搜索热词走 API 并发加载');
} else {
  fail('搜索热词加载', '应通过 API 并发加载分类和热词');
}
if (!/wx:key="[^"]*\{\{/.test(skeletonSrc) && (skeletonSrc.match(/wx:key="index"/g) || []).length === 3) {
  ok('骨架屏 wx:key 合法');
} else {
  fail('骨架屏 wx:key', '三处静态占位循环必须使用合法 key');
}
if (orderSrc.includes("case 'counts'") && apiSrc.includes("getOrderCounts: (options) => call('order', { action: 'counts' }") &&
    userPageSrc.includes('ORDER_COUNTS_CACHE_TTL = 30 * 1000') && userPageSrc.includes('API.getOrderCounts') &&
    !userPageSrc.includes("API.getOrderList({ status: 'pending'")) {
  ok('我的页订单角标走聚合计数和 30 秒缓存');
} else {
  fail('我的页订单角标', '应使用 order:counts 聚合接口和 30 秒本地缓存，不再四次调用 order:list');
}
if (cartPageSrc.includes('CART_CACHE_TTL = 30 * 1000') &&
    cartPageSrc.includes('readCartCache') && cartPageSrc.includes('writeCartCache') &&
    cartPageSrc.includes('silent: true') && cartPageSrc.includes('force: true')) {
  ok('购物车页使用 30 秒缓存和静默刷新');
} else {
  fail('购物车页缓存', '应使用 30 秒缓存、静默刷新，且下拉刷新强制云端');
}
if (cartFunctionSrc.includes("_.in(productIds)") &&
    !cartFunctionSrc.includes('Promise.all(items.map(async (item)') &&
    cartFunctionSrc.includes('productMap')) {
  ok('cart:get 批量补齐商品信息，避免 N+1 查询');
} else {
  fail('cart:get 商品查询', '应批量查询 products，避免按购物车 item 逐条 doc().get()');
}

const paySrc = read('cloudfunctions/pay/index.js');
const payNotifySrc = read('cloudfunctions/payNotify/index.js');
const paymentEffectsSrc = read('cloudfunctions/payNotify/payment-effects.js');
if (paySrc.includes('cloud.cloudPay.unifiedOrder') &&
    paySrc.includes('functionName:') &&
    payNotifySrc.includes('confirmPayment') &&
    paymentEffectsSrc.includes("'cashflow_entries'") &&
    paymentEffectsSrc.includes("status: 'frozen'") &&
    paymentEffectsSrc.includes("status: 'committed'")) {
  ok('支付统一提交库存、现金流及冻结佣金');
} else {
  fail('pay/payNotify', '支付必须统一提交库存、现金流并冻结佣金');
}

if (payNotifySrc.includes('event.out_trade_no') &&
    payNotifySrc.includes('event.return_code') &&
    payNotifySrc.includes('event.result_code')) {
  ok('payNotify 兼容 CloudBase 官方 snake_case 回调字段');
} else {
  fail('payNotify 回调字段', '必须读取 out_trade_no / return_code / result_code');
}

if (payNotifySrc.includes('payerOpenId') && payNotifySrc.includes('totalFee') &&
    paymentEffectsSrc.includes('支付金额与订单金额不一致') &&
    paymentEffectsSrc.includes('付款身份与订单用户不一致')) {
  ok('payNotify 在事务内校验支付金额和付款身份');
} else {
  fail('payNotify 回调校验', '必须在变更订单前校验回调金额和付款身份');
}

if (payNotifySrc.match(/errcode:\s*1/) && payNotifySrc.includes('处理异常，请重试')) {
  ok('payNotify 核心持久化失败返回非零，允许平台重试');
} else {
  fail('payNotify 重试语义', '持久化异常不能返回 errcode: 0');
}

if (paySrc.includes("process.env.ALLOW_MOCK_PAY === 'true'") &&
    paySrc.includes('mockRequested && !paymentConfig.useMockPay') &&
    paySrc.includes('微信支付尚未配置') &&
    !paySrc.includes('return true; // 兜底：未配置商户号时保持 mock')) {
  ok('支付未配置时安全失败，模拟支付采用双开关');
} else {
  fail('支付安全模式', '缺少商户配置时不得自动模拟支付，模拟支付必须有环境变量授权');
}

if (adminSrc.includes("order.status !== 'paid'") &&
    adminSrc.includes('updatedCount(updateRes) !== 1')) {
  ok('admin.shipOrder 仅允许 paid → shipped 且校验更新命中');
} else {
  fail('admin.shipOrder 状态机', '发货必须校验已支付状态和数据库更新结果');
}

const loginSrc = read('cloudfunctions/login/index.js');
if (loginSrc.includes('resolveActiveReferrer') &&
    loginSrc.includes("where({ referralCode })") &&
    loginSrc.includes("referrer.agentInfo.status !== 'active'") &&
    orderSrc.includes('resolveActiveAgentId')) {
  ok('推荐绑定和下单归因都要求 active 代理');
} else {
  fail('代理归因资格', '推荐绑定及下单必须校验 active 代理身份');
}

// ---------- 4. 关键业务方法单元验证 ----------
console.log('▶ 业务方法单元验证');

// 验证订单号格式
const utilSrc = read('miniprogram/utils/util.js');
// util.js 依赖 wx 全局 toast/showLoading/hideLoading，但纯函数部分（订单号、价格、状态文案）不依赖 wx，
// require 后只用到的这几个都不会调 wx。
const util = require(path.join(ROOT, 'miniprogram/utils/util.js'));

if (typeof util.generateOrderNo === 'function') {
  const orderNo = util.generateOrderNo();
  if (/^JY\d{14}[A-Z0-9]{6}$/.test(orderNo)) ok('订单号格式正确: ' + orderNo);
  else fail('订单号格式', '应为 JY+14位时间戳+6位随机，实际 ' + orderNo);
} else {
  fail('util.generateOrderNo', '函数不存在');
}

if (typeof util.formatPrice === 'function' && typeof util.parsePrice === 'function') {
  const cases = [
    [6900, '69.00', 69],
    [1, '0.01', 0.01],
    [99, '0.99', 0.99],
    [12345, '123.45', 123.45],
  ];
  let allOk = true;
  for (const [cents, str, back] of cases) {
    const got = util.formatPrice(cents);
    const backCents = util.parsePrice(String(back));
    if (got !== str) { allOk = false; break; }
    if (backCents !== cents) { allOk = false; break; }
  }
  if (allOk) ok('价格格式转换双向正确 (分 ↔ 元)');
  else fail('价格转换', '转换结果不符合预期');
}

if (typeof util.getOrderStatusText === 'function') {
  const expected = ['pending', 'paid', 'shipped', 'received', 'refunding', 'refunded', 'closed'];
  const allOk = expected.every(s => util.getOrderStatusText(s).length > 0);
  if (allOk) ok('订单状态文案映射完整');
  else fail('订单状态文案', '部分状态缺失');
}

// ---------- 5. 数据流一致性 ----------
console.log('▶ 数据流一致性');

// 验证 order 中 COMMISSION_RATE 与 pay 不再写死 0.15
if (!paySrc.match(/const\s+rate\s*=\s*0\.15/) && !paySrc.match(/rate:\s*0\.15/)) {
  ok('pay 不再硬编码佣金比例 0.15');
} else {
  fail('pay 硬编码', 'pay 中仍存在写死的 0.15，应改用常量或通过 order 统一处理');
}

const maintenanceSrc = read('cloudfunctions/maintenance/index.js');
const adminQrAuthSrc = read('cloudfunctions/adminQrAuth/index.js');
const adminWxacodeSrc = read('cloudfunctions/adminQrAuth/wxacode-client.js');
const adminQrConfirmSrc = read('miniprogram/subpackages/admin-auth/confirm/confirm.js');
const adminWebSrc = read('admin-web/app.js');
const adminWebHtml = read('admin-web/index.html');
const userWxml = read('miniprogram/pages/user/user.wxml');
if (orderSrc.includes("inventoryStatus: 'reserved'") && orderSrc.includes("collection('inventory_reservations')") &&
    orderSrc.includes('idempotencyKey: `reservation:${orderNo}:${reservationIndex}`') &&
    orderSrc.includes("status: 'closed'") && maintenanceSrc.includes('payment_timeout')) {
  ok('订单创建锁库存，取消/超时释放库存');
} else fail('库存生命周期', '缺少锁定、释放或超时关单逻辑');
if (orderSrc.includes('resolveCouponDiscount(transaction') &&
    orderSrc.includes("transaction.collection('user_coupons')") &&
    orderSrc.includes('优惠信息已变化') &&
    !read('miniprogram/pages/checkout/checkout.js').includes('API.useCoupon(')) {
  ok('订单服务端计算并原子核销优惠券');
} else {
  fail('优惠券金额安全', '订单不得信任前端优惠金额，且必须和订单在同一事务核销');
}
const indexCollections = Object.fromEntries((databaseIndexes.collections || []).map(item => [item.name, item.indexes || []]));
const reservationUnique = (indexCollections.inventory_reservations || []).some(index =>
  index.name === 'reservation_idempotency_unique' && index.unique === true &&
  index.fields && index.fields[0] && index.fields[0].name === 'idempotencyKey');
const commissionUnique = (indexCollections.commissions || []).some(index =>
  index.name === 'commission_idempotency_unique' && index.unique === true &&
  index.fields && index.fields[0] && index.fields[0].name === 'idempotencyKey');
const withdrawalUnique = (indexCollections.withdrawals || []).some(index =>
  index.name === 'withdrawal_idempotency_unique' && index.unique === true &&
  index.fields && index.fields[0] && index.fields[0].name === 'idempotencyKey');
const refundUnique = (indexCollections.refunds || []).some(index =>
  index.name === 'refund_request_unique' && index.unique === true &&
  index.fields && index.fields[0] && index.fields[0].name === 'idempotencyKey');
if (reservationUnique && commissionUnique && withdrawalUnique && refundUnique) {
  ok('库存、佣金、提现和退款均配置唯一幂等索引');
} else {
  fail('幂等唯一索引', '库存、佣金、提现或退款缺少 idempotencyKey 唯一索引');
}
if (withdrawalSrc.includes('withTransaction') && withdrawalSrc.includes('withdrawalVersion') &&
    withdrawalSrc.includes('idempotencyKey') && withdrawalEffectsSrc.includes("payoutMode: 'wechat_transfer'") &&
    withdrawalEffectsSrc.includes('initiateTransfer') && withdrawalEffectsSrc.includes('transferClaimToken')) {
  ok('提现申请与自动转账打款具备事务和幂等保护');
} else {
  fail('提现事务保护', '申请或审核缺少事务冲突字段、幂等键或自动转账标识');
}
const distributorWithdrawalSrc = read('miniprogram/subpackages/distributor/withdrawal/withdrawal.js');
if (adminSrc.includes('getOwnWithdrawalTransfer') && withdrawalEffectsSrc.includes('data.packageInfo') &&
    withdrawalEffectsSrc.includes('wd.agentId !== openId') &&
    apiSrc.includes('getOwnWithdrawalTransfer') &&
    distributorWithdrawalSrc.includes('wx.requestMerchantTransfer')) {
  ok('提现转账保存确认凭证并由分销员本人拉起微信收款确认页');
} else {
  fail('提现收款确认闭环', '应保存 package_info、校验提现归属并调用 wx.requestMerchantTransfer');
}
if (adminSrc.includes('createOutRefundNo') && adminSrc.includes("refundChannel: 'mock'") &&
    adminSrc.includes('订单缺少微信支付交易号') && orderSrc.includes('idempotencyKey: `refund_request:')) {
  ok('退款区分模拟/真实支付并使用固定退款单号');
} else {
  fail('退款安全', '退款必须区分模拟支付、拒绝缺失交易号，并使用固定幂等退款单号');
}
if (orderSrc.includes("status: 'received'") && orderSrc.includes("status: 'settled'") &&
    maintenanceSrc.includes('auto_receive')) {
  ok('确认收货或自动收货后结算佣金');
} else fail('佣金结算时点', '佣金必须在收货后结算');
if (adminSrc.includes('ROLE_PERMISSIONS') && adminSrc.includes('operations') && adminSrc.includes('finance') &&
    adminSrc.includes('admin_accounts') && adminSrc.includes('admin_sessions')) {
  ok('B 端账号及店主/运营/财务 RBAC 已落地');
} else fail('B 端 RBAC', '缺少独立账号、会话或角色权限');
if (adminSrc.includes("case 'financeOverview'") && adminSrc.includes("collection('cashflow_entries')") &&
    adminWebSrc.includes("id: 'finance'") && adminWebSrc.includes("id: 'inventory'")) {
  ok('B 端经营收支和库存模块已接入');
} else fail('B 端经营模块', '缺少经营收支或库存模块');
if (adminSrc.includes("case 'transactionCleanupPreview'") &&
    adminSrc.includes("case 'purgeTestTransactions'") &&
    adminSrc.includes("event.confirm !== 'PURGE_TEST_TRANSACTIONS'") &&
    adminSrc.includes("actor.role !== 'owner'") &&
    adminWebHtml.includes('清理测试交易数据') &&
    adminWebSrc.includes("transactionCleanup.confirmText !== '清空测试订单'")) {
  ok('测试交易清理仅限店主，并具备预检与双重确认');
} else fail('测试交易清理保护', '缺少店主权限、只读预检或双重确认');
if (adminWebHtml.includes('static.cloudbase.net/cloudbase-js-sdk/2.27.1/cloudbase.full.js') &&
    adminWebSrc.includes('window.cloudbase')) {
  ok('B 端使用可用的官方 CloudBase Web SDK');
} else fail('B 端 CloudBase SDK', '后台仍使用失效的 Web SDK 地址或错误全局变量');
if (!adminWebHtml.includes('unpkg.com/vue') &&
    adminWebHtml.includes('vendor/vue.global.prod.js') &&
    adminWebSrc.includes('adminDashboardCache') &&
    adminSrc.includes('recentOrders: recentOrders.data || []') &&
    adminSrc.includes("case 'dashboard':") &&
    adminSrc.includes('pendingRefunds, recentOrders') &&
    adminSrc.includes('] = await Promise.all([')) {
  ok('B 端首屏依赖本地化且看板查询并发、单请求返回');
} else fail('B 端首屏性能', '仍存在境外阻塞依赖、串行看板查询或多次首屏云函数调用');
if (adminWebSrc.includes('后台连接尚未启用') &&
    adminWebSrc.includes("callAdminQrAuth('createQrLogin')") &&
    adminWebSrc.includes("throw new Error('ANONYMOUS_LOGIN_NOT_ESTABLISHED')") &&
    adminWebSrc.includes('扫码登录云函数权限尚未开放') &&
    !adminWebSrc.includes('try { await auth.signInAnonymously(); } catch')) {
  ok('B 端扫码登录连接异常时停止云调用并显示明确提示');
} else fail('B 端匿名登录提示', '匿名登录失败后仍继续调用云函数或提示不明确');
const adminQrIndexes = indexCollections.admin_login_tickets || [];
const hasQrPublicUnique = adminQrIndexes.some(index => index.name === 'admin_login_public_unique' && index.unique === true);
const hasQrPollUnique = adminQrIndexes.some(index => index.name === 'admin_login_poll_unique' && index.unique === true);
if (adminQrAuthSrc.includes("case 'createQrLogin'") &&
    adminQrAuthSrc.includes("case 'confirmQrLogin'") &&
    adminQrAuthSrc.includes("case 'pollQrLogin'") &&
    adminQrAuthSrc.includes('CLOUDBASE_CUSTOM_LOGIN_PRIVATE_KEY') &&
    adminQrAuthSrc.includes('MINIPROGRAM_APPSECRET') &&
    adminQrAuthSrc.includes("const CONFIRM_PAGE = 'pages/index/index'") &&
    adminQrAuthSrc.includes('MINIPROGRAM_ENV_VERSION') &&
    adminQrAuthSrc.includes('selfOpenId: openId') &&
    adminWxacodeSrc.includes('cgi-bin/stable_token') &&
    adminWxacodeSrc.includes('wxa/getwxacodeunlimit') &&
    appJs.includes('pendingAdminQrScene') &&
    appJs.includes('consumeAdminQrScene') &&
    homePageSrc.includes('redirectAdminQrLogin') &&
    adminQrConfirmSrc.includes('copySelfOpenId') &&
    adminQrConfirmSrc.includes("API.login({ action: 'login' }") &&
    !adminQrAuthSrc.includes('BEGIN PRIVATE KEY') &&
    adminWebSrc.includes('signInWithCustomTicket') &&
    adminWebSrc.includes('document.hidden') &&
    hasQrPublicUnique && hasQrPollUnique &&
    (appJson.subPackages || []).some(pkg => pkg.root === 'subpackages/admin-auth')) {
  ok('微信扫码后台登录采用一次性票据、自定义身份和独立确认分包');
} else {
  fail('微信扫码后台登录', '缺少票据幂等、私钥隔离、自定义登录或确认页');
}
if (!userWxml.includes('/pages/agent-') && !userWxml.includes('/pages/admin/admin') &&
    !(appJson.pages || []).some(page => /agent|withdrawal|admin|shop-editor|referral/.test(page)) &&
    (appJson.subPackages || []).some(pkg => pkg.root === 'subpackages/distributor') &&
    !customerHomeWxml.includes('成为林元元代理') &&
    !customerHomeWxml.includes('/pages/agent-join/agent-join')) {
  ok('A 端已移除分销/后台入口，C 端使用独立分包');
} else fail('A/C 端隔离', 'A 端仍暴露分销后台入口或 C 端未分包');
if (agentSrc.includes("case 'claimInvite'") && agentSrc.includes("return { success: false, error: '分销员仅支持后台邀请开通' }") &&
    agentSrc.includes('maskOrderNo') && !read('miniprogram/subpackages/distributor/commissions/commissions.wxml').includes('address')) {
  ok('C 端邀请制及客户隐私隔离');
} else fail('C 端边界', '缺少邀请制或脱敏佣金明细');

// ---------- 6. WXS 依赖扫描(避免再次踩 IDE 老编译器坑) ----------
console.log('▶ WXS 静态扫描');

// 扫所有 .wxml,不允许再出现 <wxs> 标签或 f.price() / f.formatTime() / f.statusText() 调用
const pagesDir = path.join(ROOT, 'miniprogram');
const componentsDir = path.join(ROOT, 'miniprogram/components');
const allWxml = [];
function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    const fp = path.join(dir, f);
    const st = fs.statSync(fp);
    if (st.isDirectory()) walk(fp);
    else if (f.endsWith('.wxml')) allWxml.push(fp);
  }
}
walk(pagesDir);
walk(componentsDir);

let wxsViolation = 0;
for (const fp of allWxml) {
  const src = fs.readFileSync(fp, 'utf8');
  if (/<wxs[\s>]/.test(src)) { fail('wxs 残留: ' + path.relative(ROOT, fp), '不应再使用 <wxs> 标签(WXML 内置表达式已够用)'); wxsViolation++; }
  if (/f\.(price|priceYuan|statusText|formatTime|formatHourMin)\s*\(/.test(src)) { fail('wxs filter 调用: ' + path.relative(ROOT, fp), '不应再调用 f.* 滤镜'); wxsViolation++; }
}
if (wxsViolation === 0) ok('无 <wxs> 标签 / 无 f.* 调用 (兼容老 IDE)');

// utils 下不应有 .wxs 文件
const utilsDir = path.join(ROOT, 'miniprogram/utils');
if (fs.existsSync(utilsDir)) {
  const wxsFiles = fs.readdirSync(utilsDir).filter(f => f.endsWith('.wxs'));
  if (wxsFiles.length === 0) ok('utils 下无 .wxs 文件');
  else wxsFiles.forEach(f => fail('wxs 文件: miniprogram/utils/' + f, '应迁移到 utils/*.js'));
}

// ---------- 输出 ----------
console.log('');
console.log('════════════════════════════════════════════');
console.log(' 通过: ' + passes.length);
console.log(' 失败: ' + failures.length);
console.log('════════════════════════════════════════════');
if (failures.length > 0) {
  console.log('');
  console.log('❌ 失败项:');
  failures.forEach(f => console.log('  - ' + f.name + ': ' + f.reason));
  process.exit(1);
} else {
  console.log('');
  console.log('✅ 全部通过');
  process.exit(0);
}
