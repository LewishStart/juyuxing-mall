'use strict';

require('../lib/payment-test-network');
const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const { spawnSync } = require('child_process');

// All private keys exist only in memory. The VM never reads any real payment credential.
const merchant = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const platform = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const wrongPlatform = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const serial = 'PUB_KEY_ID_3000000001';
const bill = 'TEST-RESPONSE-VERIFY-0001';
const filename = path.resolve(__dirname, '../../cloudfunctions/admin/wxpay-transfer.js');
const publicPem = platform.publicKey.export({ type: 'spki', format: 'pem' });
const merchantPem = merchant.privateKey.export({ type: 'pkcs8', format: 'pem' });

function createClient(options = {}) {
  const observed = { requests: [], logs: [] };
  class FixtureDate extends Date { static now() { return Date.now() + (options.clockOffset || 0); } }
  const env = {
    ALLOW_MOCK_PAY: 'false',
    WECHATPAY_PLATFORM_PUBLIC_KEY_ID: serial,
    WECHATPAY_PLATFORM_PUBLIC_KEY_PATH: '/synthetic/platform.pem',
    // Public keys have no embedded expiration: this is an operator rotation deadline.
    WECHATPAY_PLATFORM_PUBLIC_KEY_EXPIRES_AT: new Date(Date.now() + 86400000).toISOString(),
    ...options.env
  };
  const body = options.body === undefined ? '{ "state" : "SUCCESS", "out_bill_no":"' + bill + '", "note":"佣金" }' : options.body;
  const timestamp = String(Math.floor(FixtureDate.now() / 1000) + (options.timeOffset || 0));
  const nonce = 'test-response-nonce';
  const headers = {
    'wechatpay-timestamp': timestamp,
    'wechatpay-nonce': nonce,
    'wechatpay-serial': options.serial || serial,
    'wechatpay-signature': crypto.sign('RSA-SHA256', Buffer.concat([
      Buffer.from(timestamp + '\n' + nonce + '\n'), Buffer.from(options.signedBody === undefined ? body : options.signedBody), Buffer.from('\n')
    ]), options.signingKey || platform.privateKey).toString('base64'),
    ...options.headers
  };
  const adapter = { request: (requestOptions, callback) => {
    observed.requests.push(requestOptions);
    const request = new EventEmitter();
    request.write = () => {};
    request.destroy = error => request.emit('error', error);
    request.end = () => {
      queueMicrotask(() => {
        if (options.networkError) return request.emit('error', new Error('synthetic socket reset'));
        const response = new EventEmitter();
        response.statusCode = options.httpCode || 200;
        response.headers = headers;
        if (options.migration && requestOptions.headers['Wechatpay-Serial'] !== serial) {
          // During migration an omitted public-key selector chooses a certificate response.
          response.headers = { ...headers, 'wechatpay-serial': 'TEST-OLD-PLATFORM-CERTIFICATE' };
        }
        response.setEncoding = () => {};
        // Keep an unhandled legacy response error from terminating the whole test runner.
        response.on('error', () => {});
        callback(response);
        const bytes = Buffer.from(body);
        // Deliberately split inside the UTF-8 Chinese text to require raw byte handling.
        const split = bytes.indexOf(Buffer.from('佣')) + 1;
        response.emit('data', bytes.subarray(0, split > 0 ? split : 3));
        response.emit('data', bytes.subarray(split > 0 ? split : 3));
        if (options.streamError) response.emit('error', new Error('synthetic incomplete response'));
        response.emit('end');
      });
    };
    return request;
  } };
  const syntheticFs = { readFileSync: file => {
    const basename = path.basename(file);
    if (basename === 'apiclient_key.pem') return merchantPem;
    if (file === '/synthetic/platform.pem') return publicPem;
    if (file === '/synthetic/certificate.pem' && options.certificate) return options.certificate;
    throw new Error('Synthetic filesystem refused credential read');
  } };
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module: mod, exports: mod.exports, __dirname: path.dirname(filename), Buffer, URL, Date: FixtureDate,
    process: { env }, console: { log() {}, error() {}, warn() {} },
    require: name => name === 'fs' ? syntheticFs : name === 'https' ? adapter : require(name)
  }, { filename });
  return { client: mod.exports, observed };
}

async function rejectsUntrusted(options, reason, initiate = false) {
  const { client, observed } = createClient(options);
  let error;
  try {
    await (initiate ? client.initiateTransfer({ amountFen: 100, openid: 'synthetic-recipient', outBillNo: bill }) : client.queryBill(bill));
  } catch (caught) { error = caught; }
  assert.ok(error, 'Untrusted response must reject, never return SUCCESS');
  assert.equal(error.code, 'WECHATPAY_RESPONSE_UNTRUSTED');
  assert.equal(error.channelStateTrusted, false);
  assert.equal(error.requiresReconciliation, true);
  assert.equal(error.outBillNo, bill);
  if (reason) assert.equal(error.verificationReason, reason);
  assert.equal(client.isBillNotExistError(error), false);
  return { error, observed };
}

const cases = [];
function test(id, run) { cases.push({ id, issue: 'R3-003', run }); }

test('D01-reject-unsigned-success', () => rejectsUntrusted({ headers: { 'wechatpay-signature': undefined } }, 'MISSING_HEADERS'));
test('D02-valid-raw-signed-query', async () => {
  const { client, observed } = createClient();
  assert.equal((await client.queryBill(bill)).state, 'SUCCESS');
  assert.equal(observed.requests[0].rejectUnauthorized, undefined, 'TLS default verification must remain enabled');
  assert.equal(observed.requests[0].hostname, 'api.mch.weixin.qq.com');
});
test('D03-valid-signed-initiation', async () => {
  const { client } = createClient();
  const result = await client.initiateTransfer({ amountFen: 100, openid: 'synthetic-recipient', outBillNo: bill });
  assert.equal(result.state, 'SUCCESS'); assert.equal(result.outBillNo, bill);
});
test('D04-reject-wrong-signing-key', () => rejectsUntrusted({ signingKey: wrongPlatform.privateKey }, 'BAD_SIGNATURE'));
test('D05-reject-tampered-raw-body', () => rejectsUntrusted({ signedBody: '{"state":"FAIL"}' }, 'BAD_SIGNATURE'));
test('D06-reject-unknown-public-key-id', () => rejectsUntrusted({ serial: 'PUB_KEY_ID_9999999999' }, 'UNKNOWN_SERIAL'));
test('D07-reject-old-response', () => rejectsUntrusted({ timeOffset: -301 }, 'STALE_TIMESTAMP'));
test('D08-reject-future-response', () => rejectsUntrusted({ timeOffset: 601 }, 'STALE_TIMESTAMP'));
test('D09-reject-missing-key-before-request', async () => {
  const { observed } = await rejectsUntrusted({ env: { WECHATPAY_PLATFORM_PUBLIC_KEY_ID: '', WECHATPAY_PLATFORM_CERT_PATH: '' } }, 'VERIFIER_CONFIG');
  assert.equal(observed.requests.length, 0);
});
test('D10-reject-expired-public-key-rotation-deadline', () => rejectsUntrusted({ env: {
  WECHATPAY_PLATFORM_PUBLIC_KEY_EXPIRES_AT: new Date(Date.now() - 1000).toISOString()
} }, 'VERIFIER_CONFIG'));
test('D11-trusted-http-not-found-retains-channel-error', async () => {
  const { client } = createClient({ httpCode: 404, body: '{"code":"NOT_FOUND","message":"synthetic missing bill"}' });
  await assert.rejects(client.queryBill(bill), error => error.code === 'NOT_FOUND' && error.channelStateTrusted === true && client.isBillNotExistError(error));
});
test('D12-unsigned-http-not-found-cannot-authorize-retry', () => rejectsUntrusted({ httpCode: 404,
  body: '{"code":"NOT_FOUND"}', headers: { 'wechatpay-signature': undefined } }, 'MISSING_HEADERS'));
test('D13-reject-non-json-signed-success', () => rejectsUntrusted({ body: 'not json' }, 'INVALID_BODY'));
test('D14-reject-signature-probe-prefix', () => rejectsUntrusted({ headers: { 'wechatpay-signature': 'WECHATPAY/SIGNTEST/synthetic' } }, 'BAD_SIGNATURE'));
test('D15-reject-missing-nonce', () => rejectsUntrusted({ headers: { 'wechatpay-nonce': undefined } }, 'MISSING_HEADERS'));
test('D16-reject-malformed-timestamp', () => rejectsUntrusted({ headers: { 'wechatpay-timestamp': 'NaN' } }, 'STALE_TIMESTAMP'));
test('D17-reject-wrong-signature-type', () => rejectsUntrusted({ headers: { 'wechatpay-signature-type': 'unsupported' } }, 'UNSUPPORTED_SIGNATURE_TYPE'));
test('D18-reject-non-object-json', () => rejectsUntrusted({ body: '[]' }, 'INVALID_BODY'));
test('D19-reject-unsigned-initiation-retain-original-bill', () => rejectsUntrusted({ headers: { 'wechatpay-signature': undefined } }, 'MISSING_HEADERS', true));
test('D20-network-failure-remains-reconcilable-original-bill', () => rejectsUntrusted({ networkError: true }, 'TRANSPORT'));
test('D21-stream-failure-remains-reconcilable', () => rejectsUntrusted({ streamError: true }, 'TRANSPORT'));
test('D22-verified-certificate-and-serial', async () => {
  const certificateSerial = '1234567890ABCDEF';
  const created = spawnSync('openssl', ['req', '-new', '-x509', '-key', '/dev/stdin', '-subj', '/CN=Synthetic WeChat Pay Test',
    '-set_serial', '0x' + certificateSerial, '-days', '1'], {
    input: platform.privateKey.export({ type: 'pkcs8', format: 'pem' }), encoding: 'utf8', timeout: 10000
  });
  assert.equal(created.status, 0, 'Synthetic certificate generation must succeed');
  const { client } = createClient({ certificate: created.stdout, serial: certificateSerial, env: {
    WECHATPAY_PLATFORM_PUBLIC_KEY_ID: '', WECHATPAY_PLATFORM_CERT_PATH: '/synthetic/certificate.pem'
  } });
  assert.equal((await client.queryBill(bill)).state, 'SUCCESS');
  await rejectsUntrusted({ certificate: created.stdout, serial: 'DEADBEEF', env: {
    WECHATPAY_PLATFORM_PUBLIC_KEY_ID: '', WECHATPAY_PLATFORM_CERT_PATH: '/synthetic/certificate.pem'
  } }, 'UNKNOWN_SERIAL');
  await rejectsUntrusted({ certificate: created.stdout, serial: certificateSerial, clockOffset: 2 * 86400000, env: {
    WECHATPAY_PLATFORM_PUBLIC_KEY_ID: '', WECHATPAY_PLATFORM_CERT_PATH: '/synthetic/certificate.pem'
  } }, 'VERIFIER_CONFIG');
  await rejectsUntrusted({ certificate: created.stdout, serial: certificateSerial, clockOffset: -2 * 86400000, env: {
    WECHATPAY_PLATFORM_PUBLIC_KEY_ID: '', WECHATPAY_PLATFORM_CERT_PATH: '/synthetic/certificate.pem'
  } }, 'VERIFIER_CONFIG');
});

test('D23-reject-validly-signed-wrong-bill', () => rejectsUntrusted({ body: JSON.stringify({ state: 'SUCCESS', out_bill_no: 'SOME-OTHER-BILL' }) }, 'BILL_MISMATCH'));
test('D24-reject-validly-signed-missing-bill', () => rejectsUntrusted({ body: JSON.stringify({ state: 'SUCCESS' }) }, 'BILL_MISMATCH'));
test('D25-signed-business-error-preserved', async () => {
  const { client } = createClient({ httpCode: 403, body: '{"code":"INVALID_REQUEST","message":"synthetic request denied"}' });
  await assert.rejects(client.initiateTransfer({ amountFen: 100, openid: 'synthetic-recipient', outBillNo: bill }),
    error => error.code === 'INVALID_REQUEST' && error.channelStateTrusted === true && error.outBillNo === bill);
});

test('D26-public-key-request-selector-distinct-from-merchant-serial', async () => {
  for (const initiate of [false, true]) {
    const { client, observed } = createClient();
    if (initiate) await client.initiateTransfer({ amountFen: 100, openid: 'synthetic-recipient', outBillNo: bill });
    else await client.queryBill(bill);
    const request = observed.requests[0];
    assert.equal(request.headers['Wechatpay-Serial'], serial);
    const merchantSerial = /serial_no="([^"]+)"/.exec(request.headers.Authorization);
    assert.ok(merchantSerial);
    assert.equal(merchantSerial[1], '557EC5ABB4E20C594FAAB3AD48E279F360B6887B');
    assert.notEqual(merchantSerial[1], request.headers['Wechatpay-Serial']);
  }
});
test('D27-public-key-migration-valid-initiate-and-query', async () => {
  for (const initiate of [false, true]) {
    const { client, observed } = createClient({ migration: true });
    let result;
    await assert.doesNotReject(async () => {
      result = await (initiate ? client.initiateTransfer({ amountFen: 100, openid: 'synthetic-recipient', outBillNo: bill }) : client.queryBill(bill));
    }, 'Public-key request must select a matching platform signature during migration');
    assert.equal(result.state, 'SUCCESS');
    assert.equal(observed.requests[0].headers['Wechatpay-Serial'], serial);
  }
});
test('D28-signed-non404-not-found-cannot-authorize-replacement', async () => {
  for (const httpCode of [400, 403, 500]) {
    const { client } = createClient({ httpCode, body: '{"code":"NOT_FOUND","message":"synthetic status mismatch"}' });
    let caught;
    try { await client.queryBill(bill); } catch (error) { caught = error; }
    assert.ok(caught);
    assert.equal(caught.channelStateTrusted, true, 'Must exercise an actually signature-verified HTTP error');
    assert.equal(caught.httpCode, httpCode);
    assert.equal(caught.outBillNo, bill);
    assert.equal(client.isBillNotExistError(caught), false);
  }
});
test('D29-missing-bill-helper-exact-trusted-404-contract', async () => {
  const { client } = createClient();
  assert.equal(client.isBillNotExistError({ channelStateTrusted: true, httpCode: 404, code: 'NOT_FOUND' }), true);
  for (const httpCode of [undefined, null, 0, 200, 400, 403, 500]) {
    assert.equal(client.isBillNotExistError({ channelStateTrusted: true, httpCode, code: 'NOT_FOUND' }), false);
  }
  for (const code of ['RESOURCE_NOT_EXISTS', 'RESOURCE_NOT_EXIST', 'not_found', 'UNKNOWN']) {
    assert.equal(client.isBillNotExistError({ channelStateTrusted: true, httpCode: 404, code }), false);
  }
  for (const channelStateTrusted of [false, undefined]) {
    assert.equal(client.isBillNotExistError({ channelStateTrusted, httpCode: 404, code: 'NOT_FOUND' }), false);
  }
});

module.exports = cases;
