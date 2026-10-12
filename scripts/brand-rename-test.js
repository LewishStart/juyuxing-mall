#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { normalizeBrandDisplay } = require('../miniprogram/utils/brand');
const root = path.resolve(__dirname, '..');
const legacyBrand = '\u6a58\u4e0e\u674f';

async function main() {
  const time = new Date('2026-10-12T00:00:00Z');
  const source = {
    success: true,
    data: [{ _id: legacyBrand + '-product', name: legacyBrand + '小紫瓶', price: 6900,
      description: '<p style="color:#2D4A3E">' + legacyBrand + '草本养护</p>',
      images: ['cloud://env/' + legacyBrand + '.png'], updateTime: time }],
    shippingAddress: { name: legacyBrand, address: legacyBrand + '路', phone: '123' },
    account: { name: legacyBrand, openid: legacyBrand + '-identity', password: legacyBrand },
    payment: { package: legacyBrand, paySign: legacyBrand, outTradeNo: legacyBrand },
    banner: { title: legacyBrand + '新品', linkUrl: '/product?id=' + legacyBrand }
  };
  const before = JSON.stringify(source);
  const result = normalizeBrandDisplay(source);
  assert.equal(result.data[0].name, '林元元小紫瓶');
  assert.equal(result.data[0].description, '<p style="color:#2D4A3E">林元元草本养护</p>');
  assert.equal(result.banner.title, '林元元新品');
  assert.equal(result.data[0].price, 6900);
  assert.equal(result.data[0]._id, source.data[0]._id);
  assert.deepStrictEqual(result.data[0].images, source.data[0].images);
  assert.strictEqual(result.data[0].updateTime, time);
  assert.deepStrictEqual(result.shippingAddress, source.shippingAddress);
  assert.deepStrictEqual(result.account, source.account);
  assert.deepStrictEqual(result.payment, source.payment);
  assert.equal(result.banner.linkUrl, source.banner.linkUrl);
  assert.equal(JSON.stringify(source), before, 'display conversion must not mutate server data');
  assert.deepStrictEqual(normalizeBrandDisplay(result), result, 'conversion is idempotent');
  assert.strictEqual(normalizeBrandDisplay(null), null);

  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'admin-web/brand.js'), 'utf8'), sandbox);
  assert.equal(JSON.stringify(sandbox.window.MallBrand.normalizeBrandDisplay(source)), JSON.stringify(result),
    'A/C and B use identical display conversion');

  const requestPath = path.join(root, 'miniprogram/utils/request.js');
  const apiPath = path.join(root, 'miniprogram/utils/api.js');
  const previousRequest = require.cache[requestPath];
  require.cache[requestPath] = { id: requestPath, filename: requestPath, loaded: true,
    exports: { call: async () => source } };
  delete require.cache[apiPath];
  try {
    const api = require(apiPath);
    assert.equal((await api.getProductList()).data[0].name, '林元元小紫瓶');
    assert.strictEqual(await api.login({}), source, 'identity responses remain untouched');
    assert.strictEqual(await api.requestPayment('order-id'), source, 'payment signatures remain untouched');
  } finally {
    delete require.cache[apiPath];
    if (previousRequest) require.cache[requestPath] = previousRequest;
    else delete require.cache[requestPath];
  }
  console.log('品牌更名验证通过：旧商品文案转换、样式保留、身份/支付/路径不变、A/B/C 一致。');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
