#!/usr/bin/env node
'use strict';
// Isolated UI fixture. No CloudBase SDK, credentials or external requests are permitted.
const http = require('http');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../admin-web');
const statuses = ['pending', 'pending_auto', 'processing', 'channel_processing', 'manual_review', 'approved'];
const refunds = statuses.map((status, i) => ({
  _id: 'OFFLINE-' + i, orderId: 'OFFLINE-ORDER-' + i, status, type: 'refund_only',
  reason: '本地隔离预览，不连接云端', createTime: new Date().toISOString(),
  lastProcessError: status === 'manual_review' ? '模拟超时：结果未知，仅核对，不重复退款。' : '',
  order: { orderNo: 'OFFLINE-ORDER-' + i, totalFee: 10, items: [{ name: '测试商品', quantity: 1 }] }
}));
const sdk = `
localStorage.setItem('adminToken', 'offline-preview');
localStorage.setItem('adminAccount', JSON.stringify({ role: 'finance', displayName: '本地隔离测试' }));
window.cloudbase = { init: () => ({ auth: () => ({ getLoginState: async () => ({ user: {} }), signInAnonymously: async () => ({}) }),
callFunction: async request => {
  const action = request.data.action;
  if (request.name === 'adminQrAuth') return { result: { success: false, error: '本地隔离预览：不生成真实登录码、不连接云端。' } };
  if (['checkAdmin', 'me'].includes(action)) return { result: { success: true, account: { role: 'finance', displayName: '本地隔离测试' } } };
  if (action === 'dashboard') return { result: { success: true, stats: {}, recentOrders: [] } };
  if (action === 'refundList') return { result: { success: true, data: ${JSON.stringify(refunds)} } };
  if (action === 'queryRefundStatus') return { result: { success: true, data: { status: 'PROCESSING', message: '本地模拟查询，未联系微信。' } } };
  if (action === 'processRefund') return { result: { success: true, autoProcessing: true, message: '本地模拟审批，未发起真实退款。' } };
  return { result: { success: true, data: [], settings: {} } };
} }) };
`;
const server = http.createServer((req, res) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; form-action 'none'");
  res.setHeader('Cache-Control', 'no-store');
  const route = new URL(req.url, 'http://localhost').pathname;
  if (route === '/offline-sdk.js') {
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8'); res.end(sdk); return;
  }
  const file = path.resolve(root, '.' + (route === '/' ? '/index.html' : route));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
  try {
    let body = fs.readFileSync(file);
    const ext = path.extname(file);
    if (ext === '.html') body = body.toString().replace('https://static.cloudbase.net/cloudbase-js-sdk/2.27.1/cloudbase.full.js', '/offline-sdk.js')
      .replace('<title>林元元 管理后台</title>', '<title>退款本地隔离测试 — 不连接云端</title>');
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[ext] || 'application/octet-stream') + '; charset=utf-8');
    res.end(body);
  } catch (_) { res.writeHead(404); res.end(); }
});
server.listen(0, '127.0.0.1', () => console.log('OFFLINE_PREVIEW http://127.0.0.1:' + server.address().port));
