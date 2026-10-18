'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createHarness } = require('../lib/prelaunch-remediation-fixture');

// The wx boundary is replaced, but Page, Component, API, request and cloud handlers
// are loaded from production sources. This is not a WXML renderer or cloud runtime.
function setup(value = 10) {
  const h = createHarness();
  const coupon = { _id: 'test-coupon', name: 'Test Coupon', type: 'percent', value,
    minSpend: 0, total: 10, claimed: 0, status: 'on', startTime: 0, endTime: 9999999999999 };
  h.tables().coupons = [coupon, { _id: 'referral_reward', status: 'off' }];
  h.tables().user_coupons = [];
  h.tables().products = [{ _id: 'test-product', name: 'Test Product', price: 10000,
    stock: 10, reservedStock: 0, status: 'on', specs: [], images: [] }];
  const calls = [], toasts = [], pending = [];
  let signedIn = true;
  let pageDefinition, componentDefinition;
  const cache = new Map();
  const wx = {
    getStorageSync: () => signedIn ? 'test-buyer' : '',
    showToast: value => toasts.push(value),
    cloud: { callFunction: async ({ name, data }) => {
      calls.push({ name, data });
      return { result: await h.call(name, data, signedIn ? 'test-buyer' : '') };
    } }
  };
  function load(relative) {
    const filename = path.resolve(h.root, relative);
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} }; cache.set(filename, module);
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      module, exports: module.exports, console, wx,
      getApp: () => ({ globalData: { cloudReady: true } }),
      Page: definition => { pageDefinition = definition; },
      Component: definition => { componentDefinition = definition; },
      require: name => {
        assert.ok(name.startsWith('.'), 'UI loader only permits local modules');
        return load(path.relative(h.root, path.resolve(path.dirname(filename), name + '.js')));
      }, setTimeout, clearTimeout
    }, { filename });
    return module.exports;
  }
  const API = load('miniprogram/utils/api.js');
  load('miniprogram/pages/coupon-center/coupon-center.js');
  load('miniprogram/components/coupon-card/coupon-card.js');
  const page = { ...pageDefinition, data: structuredClone(pageDefinition.data) };
  page.setData = update => Object.assign(page.data, update);
  const originalLoad = page.load;
  page.load = function () { const promise = originalLoad.call(page); pending.push(promise); return promise; };
  const component = { ...componentDefinition.methods,
    data: { ...structuredClone(componentDefinition.data), coupon, loading: false } };
  component.setData = update => Object.assign(component.data, update);
  let emitted;
  component.triggerEvent = (name, detail) => {
    assert.equal(name, 'claim');
    // The real template binds claim and has NO data-id. Do not invent one here.
    emitted = page.onClaim({ detail, currentTarget: { dataset: {} } });
  };
  async function click() {
    emitted = undefined;
    component.onClaim();
    await emitted;
    await Promise.all(pending.splice(0));
  }
  function observe() {
    componentDefinition.observers['coupon, userCoupon, claimed, expired, used, status']
      .call(component, coupon, null, false, false, false, '');
    return component.data;
  }
  return { h, coupon, API, calls, toasts, page, component, click, observe,
    logout() { signedIn = false; } };
}

function orderData(userCouponId, suffix = 'AAAAAA') {
  return { orderNo: 'JY20261018010203' + suffix,
    items: [{ productId: 'test-product', quantity: 1, spec: '' }],
    couponId: userCouponId, address: { name: 'Test Buyer', phone: '13800000000',
      region: ['Test Province', 'Test City', 'Test District'], detail: 'Test Street' } };
}

module.exports = [
  { id: 'C04-component-event-through-api-to-cloud', issue: 'R4-C04', run: async () => {
    const s = setup();
    const template = fs.readFileSync(path.join(s.h.root, 'miniprogram/pages/coupon-center/coupon-center.wxml'), 'utf8');
    assert.match(template, /bind:claim="onClaim"/);
    assert.doesNotMatch(template, /data-id=/);
    await s.page.load();
    await s.click();
    assert.equal(s.calls.filter(c => c.name === 'coupon' && c.data.action === 'claim').length, 1,
      'Actual Component detail.coupon must reach coupon.claim through real Page/API/request');
    assert.equal(s.h.tables().user_coupons.length, 1);
    assert.equal(s.h.tables().user_coupons[0].userId, 'test-buyer');
    assert.equal(s.h.tables().coupons[0].claimed, 1);
    assert.equal(s.page.data.coupons.find(c => c._id === s.coupon._id).myClaimed, 1);
    assert.equal(s.page.data.claiming, '');
  } },
  { id: 'C04-claim-idempotency-owner-and-order-redemption-control', issue: 'R4-C04', run: async () => {
    const s = setup();
    const claim = await s.API.claimCoupon(s.coupon._id);
    const repeated = await s.API.claimCoupon(s.coupon._id);
    assert.equal(claim.success, true);
    assert.equal(repeated.userCouponId, claim.userCouponId);
    assert.equal(repeated.alreadyClaimed, true);
    assert.equal(s.h.tables().user_coupons.length, 1);
    assert.equal(s.h.tables().coupons[0].claimed, 1);
    const other = await s.h.call('order', { action: 'create', ...orderData(claim.userCouponId, 'BBBBBB') }, 'test-other');
    assert.equal(other.success, false, 'Another identity cannot redeem buyer coupon');
    assert.equal(s.h.tables().user_coupons[0].status, 'unused');
    const created = await s.API.createOrder(orderData(claim.userCouponId));
    assert.equal(created.success, true);
    assert.equal(created.totalFee, 9000);
    assert.equal(created.couponDiscount, 1000);
    assert.equal(s.h.tables().user_coupons[0].status, 'used');
    assert.equal(s.h.tables().user_coupons[0].orderId, created.orderId);
    const again = await s.API.createOrder(orderData(claim.userCouponId, 'CCCCCC'));
    assert.equal(again.success, false, 'Consumed coupon cannot discount a second order');
    assert.equal(s.h.tables().orders.filter(o => o.couponId === claim.userCouponId).length, 1);
  } },
  { id: 'C04-authentication-invalid-event-and-loading-controls', issue: 'R4-C04', run: async () => {
    const s = setup();
    s.logout(); await s.click();
    assert.equal(s.calls.length, 0, 'Unauthenticated tap must not call cloud');
    assert.equal(s.toasts.length, 1);
    const loggedIn = setup();
    await loggedIn.page.onClaim({ detail: {}, currentTarget: { dataset: {} } });
    assert.equal(loggedIn.calls.length, 0);
    loggedIn.component.data.loading = true;
    await loggedIn.click();
    assert.equal(loggedIn.calls.length, 0);
    loggedIn.page.data.claiming = loggedIn.coupon._id;
    loggedIn.component.data.loading = false;
    await loggedIn.click();
    assert.equal(loggedIn.calls.length, 0, 'An in-flight claim cannot be resubmitted');
  } },
  { id: 'C05-display-agrees-with-real-ten-percent-discount-order', issue: 'R4-C05', run: async () => {
    const s = setup(); const display = s.observe();
    const claim = await s.API.claimCoupon(s.coupon._id);
    const created = await s.API.createOrder(orderData(claim.userCouponId));
    assert.equal(created.success, true);
    assert.equal(created.totalFee, 9000);
    assert.equal(created.couponDiscount, 1000);
    assert.equal(display.amount, '\u51cf10%');
    assert.equal(display.desc, '\u5168\u573a\u901a\u7528\u51cf10%');
  } },
  ...[0, 100].map(value => ({ id: 'C05-percent-boundary-' + value, issue: 'R4-C05', run: async () => {
    const s = setup(value);
    assert.equal(s.observe().amount, '\u51cf' + value + '%');
    assert.equal(s.component.data.desc, '\u5168\u573a\u901a\u7528\u51cf' + value + '%');
    const claim = await s.API.claimCoupon(s.coupon._id);
    const calculated = await s.API.calculateCouponDiscount({ userCouponId: claim.userCouponId, amount: 10000 });
    assert.equal(calculated.success, true);
    assert.equal(calculated.discount, value * 100);
    const created = await s.API.createOrder(orderData(claim.userCouponId));
    if (value === 0) { assert.equal(created.success, true); assert.equal(created.totalFee, 10000); }
    else { assert.equal(created.success, false, 'Existing one-fen minimum is preserved');
      assert.equal(s.h.tables().user_coupons[0].status, 'unused'); }
  } })),
  { id: 'C05-amount-coupon-display-control', issue: 'R4-C05', run: async () => {
    const s = setup(); s.coupon.type = 'amount'; s.coupon.value = 1000; s.coupon.minSpend = 5000;
    const display = s.observe();
    assert.equal(display.amount, '10');
    assert.equal(display.desc, '\u6ee150\u51cf10');
    assert.equal(display.minSpendText, '\u6ee1 \u00a550 \u53ef\u7528');
  } }
];
