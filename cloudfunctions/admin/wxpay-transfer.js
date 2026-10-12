'use strict';

/**
 * wxpay-transfer.js — 微信支付 V3「商家转账到零钱（升级版）」模块（提现自动打款）
 *
 * 升级版接口（2025.1.15 后新开通商户必须使用）：
 *   发起转账：POST /v3/fund-app/mch-transfer/transfer-bills（单笔转账单模式）
 *   商户单号查单：GET /v3/fund-app/mch-transfer/transfer-bills/out-bill-no/{out_bill_no}
 *
 * 场景：1005 佣金报酬（需 transfer_scene_report_infos 固定两条：岗位类型 + 报酬说明）。
 * 直连商户 V3 API，RSA-SHA256 请求签名，不依赖 cloud.cloudPay 云调用上下文。
 * 商户私钥存于 ./certs/apiclient_key.pem（从 apiclient_cert.p12 提取，gitignored）。
 *
 * ⚠️ 防重复转账规则（微信官方要求）：
 *   发起转账报错时【严禁】换单号盲目重试——调用超时可能微信侧已建单。
 *   必须先用原商户单号查单，确认原单终态失败（FAIL/CANCELLED）或不存在后，才能换单号重试。
 *   本模块的使用方（admin/index.js）遵循：发起前先落库单号，重试前先查单。
 *
 * 依赖：Node.js 内置 https / crypto / fs / path，无第三方包。
 */

const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MCH_ID = '1114186048';
const APP_ID = 'wx6e685f787f1cd099';
// 商户 API 证书序列号（apiclient_cert.pem 的 serial，公开信息）
const CERT_SERIAL = '557EC5ABB4E20C594FAAB3AD48E279F360B6887B';

const API_HOST = 'api.mch.weixin.qq.com';

let cachedKeyPem = null;
function loadPrivateKey() {
  if (cachedKeyPem) return cachedKeyPem;
  cachedKeyPem = fs.readFileSync(path.join(__dirname, 'certs', 'apiclient_key.pem'), 'utf8');
  return cachedKeyPem;
}

/**
 * 生成商户转账单号：仅数字+大小写字母（微信要求），商户侧唯一
 */
function genOutBillNo() {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = crypto.randomBytes(4).toString('hex').toUpperCase();
  return 'WD' + ts + rand;
}

/**
 * V3 签名请求
 * @returns {Promise<{httpCode:number, data:object}>} 2xx 时 resolve
 * @rejects Error{httpCode:number, code:string, message:string}
 */
function v3Request(method, urlPath, bodyObj) {
  return new Promise((resolve, reject) => {
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomBytes(16).toString('hex');
    const bodyStr = bodyObj ? JSON.stringify(bodyObj) : '';
    const message = method + '\n' + urlPath + '\n' + timestamp + '\n' + nonce + '\n' + bodyStr + '\n';
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(message);
    const signature = signer.sign(loadPrivateKey(), 'base64');
    const auth = 'WECHATPAY2-SHA256-RSA2048 '
      + 'mchid="' + MCH_ID + '",'
      + 'nonce_str="' + nonce + '",'
      + 'signature="' + signature + '",'
      + 'timestamp="' + timestamp + '",'
      + 'serial_no="' + CERT_SERIAL + '"';

    const options = {
      hostname: API_HOST,
      path: urlPath,
      method: method,
      headers: {
        'Authorization': auth,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'juyuxing-miniprogram/1.0'
      },
      timeout: 15000
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch (e) { parsed = null; }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ httpCode: res.statusCode, data: parsed || {} });
        } else {
          const err = new Error((parsed && parsed.message) || String(data).slice(0, 300));
          err.httpCode = res.statusCode;
          err.code = (parsed && parsed.code) || 'UNKNOWN';
          reject(err);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('微信支付V3接口请求超时（15秒）')));
    req.on('error', e => reject(e));
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

/**
 * 判断查单错误是否为「转账单不存在」（此时可安全换单号重试）
 */
function isBillNotExistError(err) {
  if (!err) return false;
  if (err.httpCode === 404) return true;
  const c = String(err.code || '').toUpperCase();
  if (c === 'NOT_FOUND' || c === 'RESOURCE_NOT_EXISTS' || c === 'RESOURCE_NOT_EXIST') return true;
  return /not exist|不存在/i.test(String(err.message || ''));
}

/**
 * 发起单笔转账（升级版，佣金报酬 1005 场景）
 * @param {object} p { amountFen, openid, remark, outBillNo? }
 *   outBillNo 传入则复用（重试场景）；不传则新生成
 * @returns {Promise<{outBillNo, transferBillNo, state, packageInfo, raw}>}
 *   state: ACCEPTED / PROCESSING / WAIT_USER_CONFIRM / TRANSFERING / SUCCESS / FAIL / CANCELING / CANCELLED
 *   WAIT_USER_CONFIRM 时需由小程序调用 wx.requestMerchantTransfer 拉起确认页（24小时不确认单据关闭）
 */
async function initiateTransfer(p) {
  const amountFen = Math.round(Number(p.amountFen) || 0);
  if (amountFen <= 0) throw new Error('转账金额无效');
  if (!p.openid) throw new Error('收款人 openid 缺失');
  const outBillNo = p.outBillNo || genOutBillNo();
  if (process.env.ALLOW_MOCK_PAY === 'true') {
    return {
      outBillNo,
      transferBillNo: 'mock_transfer_' + outBillNo,
      state: 'WAIT_USER_CONFIRM',
      packageInfo: 'mock_package_' + outBillNo,
      raw: {}
    };
  }
  const remark = String(p.remark || '分销佣金提现').slice(0, 32);
  const body = {
    appid: APP_ID,
    out_bill_no: outBillNo,
    transfer_scene_id: '1005',            // 佣金报酬场景
    openid: p.openid,
    transfer_amount: amountFen,           // 单位：分
    transfer_remark: remark,
    user_recv_perception: '劳务报酬',
    // 1005 场景固定两条报备信息：岗位类型 + 报酬说明（微信官方要求，缺一报 PARAM_ERROR）
    transfer_scene_report_infos: [
      { info_type: '岗位类型', info_content: '商品分销推广员' },
      { info_type: '报酬说明', info_content: '商品推广佣金提现' }
    ]
  };
  const resp = await v3Request('POST', '/v3/fund-app/mch-transfer/transfer-bills', body);
  return {
    outBillNo,
    transferBillNo: resp.data.transfer_bill_no || '',
    state: resp.data.state || '',
    packageInfo: resp.data.package_info || '',
    raw: resp.data
  };
}

/**
 * 按商户单号查询单笔转账单状态（升级版）
 * 状态机：ACCEPTED(已受理) / PROCESSING(处理中) / WAIT_USER_CONFIRM(待收款人确认) /
 *         TRANSFERING(转账中) / SUCCESS(成功,终态) / FAIL(失败,终态) / CANCELING(撤销中) / CANCELLED(已撤销,终态)
 * 注意：单据创建 24 小时内不确认收款会自动关闭（终态）。
 * @returns {Promise<{state, failReason, updateTime, raw}>}
 * @rejects Error{httpCode, code, message} 单不存在时可用 isBillNotExistError 判定
 */
async function queryBill(outBillNo) {
  if (process.env.ALLOW_MOCK_PAY === 'true') {
    return { state: 'WAIT_USER_CONFIRM', failReason: '', updateTime: '', raw: {} };
  }
  const resp = await v3Request('GET',
    '/v3/fund-app/mch-transfer/transfer-bills/out-bill-no/' + encodeURIComponent(outBillNo),
    null);
  return {
    state: resp.data.state || '',
    failReason: resp.data.fail_reason || '',
    updateTime: resp.data.update_time || '',
    raw: resp.data
  };
}

function getTransferClientConfig() {
  return { mchId: MCH_ID, appId: APP_ID };
}

module.exports = { initiateTransfer, queryBill, genOutBillNo, isBillNotExistError, getTransferClientConfig };
