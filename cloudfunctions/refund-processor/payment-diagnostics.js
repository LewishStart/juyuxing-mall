'use strict';

const crypto = require('crypto');

function errorCode(error) {
  const code = String(error && error.code || 'UNKNOWN');
  return new Set(['UNKNOWN', 'ENOENT', 'ETIMEDOUT', 'ECONNRESET', 'INVALID_REQUEST', 'NOT_FOUND',
    'RESOURCE_NOT_EXISTS', 'RESOURCE_NOT_EXIST', 'PARAM_ERROR', 'NOTENOUGH', 'SYSTEMERROR',
    'CHANNEL_RESPONSE_INVALID', 'CHANNEL_STATE_UNKNOWN', 'TEST_NETWORK_FORBIDDEN']).has(code) ? code : 'UNKNOWN';
}

function safeError(error) {
  const code = errorCode(error);
  const message = String(error && error.message || '');
  if (code === 'ENOENT') return 'SIGNING_KEY_UNAVAILABLE: 商户签名文件不可用';
  if (/timeout|超时/i.test(message) || ['ETIMEDOUT', 'ECONNRESET'].includes(code)) return 'CHANNEL_RESULT_UNKNOWN: 接口超时或连接中断，请先核对原单';
  if (code === 'INVALID_REQUEST' && /\bIP\b|IP地址/i.test(message)) return 'INVALID_REQUEST: 接口 IP 限制，请核对商户配置';
  return code + ': 接口调用未完成，请按原单核对，勿重复操作';
}

function event(logger, phase, fields = {}) {
  const entry = { event: String(phase).replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 80), version: 'funds-v2',
    mode: process.env.PAYMENT_TEST_MODE === 'true' || process.env.ALLOW_MOCK_PAY === 'true' ? 'mock' : 'channel' };
  const allowed = {
    state: ['ACCEPTED', 'PROCESSING', 'WAIT_USER_CONFIRM', 'TRANSFERING', 'SUCCESS', 'FAIL', 'CANCELING', 'CANCELLED', 'UNKNOWN', 'NOT_FOUND', 'REFUNDCLOSE', 'CHANGE'],
    channel: ['cloudbase', 'direct', 'wechat', 'mock'], mode: ['mock', 'channel']
  };
  for (const key of Object.keys(allowed)) {
    if (allowed[key].includes(fields[key])) entry[key] = fields[key];
  }
  if (fields.code !== undefined) entry.code = errorCode({ code: fields.code });
  for (const key of ['httpCode', 'durationMs', 'attempt']) {
    if (Number.isFinite(fields[key]) && fields[key] >= 0) entry[key] = Math.min(Math.floor(fields[key]), 1e9);
  }
  if (fields.id) entry.ref = crypto.createHash('sha256').update(String(fields.id)).digest('hex').slice(0, 12);
  logger.log('[payment]', JSON.stringify(entry));
}

module.exports = { event, safeError, errorCode };
