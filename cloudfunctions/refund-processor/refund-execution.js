'use strict';

const crypto = require('crypto');
const { applyRefundEffects } = require('./refund-effects');
const { event, safeError } = require('./payment-diagnostics');
const { loadPayApiConfig, directOrderQuery, directQueryRefund, directRefund } = require('./wxpay-direct');
const ENV_ID = 'cloud1-d4gx1jxk675274501';
const LEASE_MS = 5 * 60 * 1000;
const CHECK_INTERVAL_MS = 30 * 1000;
const ACTIVE = ['pending_auto', 'channel_processing', 'manual_review', 'processing'];
const field = (value, camel, snake) => value[camel] === undefined ? value[snake] : value[camel];
const refundNo = id => 'RF' + crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 30);
const errorText = safeError;

function createRefundExecutor(cloud, db, logger = console) {
  const _ = db.command;
  async function claim(id, force = false) {
    return db.runTransaction(async tx => {
      const rf = (await tx.collection('refunds').doc(id).get()).data;
      if (!rf || !ACTIVE.includes(rf.status)) return null;
      if (rf.status === 'processing' && Date.now() - new Date(rf.claimTime || 0).getTime() < LEASE_MS) return null;
      if (!force && rf.status !== 'processing' && Date.now() - new Date(rf.processTime || 0).getTime() < CHECK_INTERVAL_MS) return null;
      const claimToken = crypto.randomBytes(16).toString('hex');
      // Existing leases and any previous attempt are query-only, even when the network outcome was lost.
      const submissionUncertain = !!rf.submissionUncertain || rf.status === 'processing';
      const explicitlyRejectedRetry = force && rf.status === 'manual_review' && rf.definitiveRejected === true;
      const queryOnly = rf.executionVersion !== 2 || submissionUncertain || rf.status === 'channel_processing' ||
        !explicitlyRejectedRetry && (!!rf.submittedAt || !!rf.processAttempts || !!rf.refundId || !!rf.channelObserved);
      await tx.collection('refunds').doc(id).update({ data: {
        status: 'processing', claimToken, submissionUncertain, claimTime: db.serverDate(), processTime: db.serverDate()
      } });
      return { ...rf, claimToken, queryOnly };
    });
  }

  async function patchClaim(rf, data) {
    const result = await db.collection('refunds').where({
      _id: rf._id, status: 'processing', claimToken: rf.claimToken
    }).update({ data: { ...data, processTime: db.serverDate() } });
    return !!(result.stats && result.stats.updated);
  }

  async function manualReview(rf, reason) {
    await patchClaim(rf, { status: 'manual_review', lastProcessError: reason });
    return 'manualReview';
  }

  async function queryChannel(rf, order, subMchId) {
    if (rf.submittedChannel && !['cloudbase', 'direct'].includes(rf.submittedChannel)) throw new Error('退款通道未知，需核对原单');
    const cfg = await loadPayApiConfig(db, false);
    let channel = rf.submittedChannel || (rf.refundChannel === 'direct' ? 'direct' : 'cloudbase');
    // A pure order query can establish direct-merchant ownership before any submission.
    // An uncertain or failed payment request never selects another submission channel.
    if (!rf.submittedChannel && !rf.submittedAt && cfg && cfg.subMchId === subMchId) {
      try {
        const paid = await directOrderQuery({ appId: 'wx6e685f787f1cd099', mchId: subMchId, apiV2Key: cfg.apiV2Key, outTradeNo: order.orderNo });
        if (paid.result_code === 'SUCCESS' && paid.trade_state === 'SUCCESS' && paid.out_trade_no === order.orderNo &&
            Number(paid.total_fee) === order.totalFee && paid.transaction_id === order.transactionId) channel = 'direct';
      } catch (error) { event(logger, 'refund.direct_ownership_unverified', { id: rf._id, code: error.code }); }
    }
    if (channel === 'direct') {
      if (!cfg || cfg.subMchId !== subMchId) throw new Error('直连查询凭据不匹配');
      const response = await directQueryRefund({ appId: 'wx6e685f787f1cd099', mchId: subMchId, apiV2Key: cfg.apiV2Key, outRefundNo: rf.outRefundNo });
      if (response.result_code === 'SUCCESS' && response.out_trade_no !== order.orderNo) throw new Error('直连查询订单不匹配');
      return { response, channel, cfg };
    }
    return { response: await cloud.cloudPay.queryRefund({
      subMchId, outRefundNo: rf.outRefundNo, nonceStr: crypto.randomBytes(16).toString('hex')
    }), channel, cfg: null };
  }

  async function finish(rf, order, wechatRefundId, channel) {
    await db.runTransaction(async tx => {
      const latest = (await tx.collection('refunds').doc(rf._id).get()).data;
      if (!latest || latest.status !== 'processing' || latest.claimToken !== rf.claimToken) throw new Error('退款执行锁已失效');
      if (latest.type === 'return_refund' && latest.returnStatus !== 'received') throw new Error('退货尚未确认收货');
      const effects = await applyRefundEffects(tx, db, order, latest, latest.restock === true);
      await tx.collection('refunds').doc(rf._id).update({ data: {
        status: 'approved', refundId: wechatRefundId, refundChannel: channel, completionVersion: 2,
        ...effects,
        outRefundNo: rf.outRefundNo, channelStatus: 'SUCCESS', lastProcessError: '',
        refundTime: db.serverDate(), processTime: db.serverDate()
      } });
    });
    return 'completed';
  }

  function parseQuery(response, rf, order) {
    if (!response || typeof response !== 'object') throw new Error('退款查询返回为空');
    const rc = field(response, 'returnCode', 'return_code');
    const code = field(response, 'resultCode', 'result_code');
    if (rc === 'SUCCESS' && code === 'FAIL' && field(response, 'errCode', 'err_code') === 'REFUNDNOTEXIST') {
      return { status: 'NOT_FOUND' };
    }
    if (rc !== 'SUCCESS' || code !== 'SUCCESS') throw new Error('退款查询失败：' +
      String(field(response, 'errCodeDes', 'err_code_des') || field(response, 'returnMsg', 'return_msg') || '未知'));
    const tradeNo = field(response, 'outTradeNo', 'out_trade_no');
    if (tradeNo && tradeNo !== order.orderNo) throw new Error('退款查询订单号不匹配');
    const count = Number(field(response, 'refundCount', 'refund_count'));
    if (!Number.isSafeInteger(count) || count < 1 || count > 100) throw new Error('退款查询条数无效');
    for (let i = 0; i < count; i++) {
      if (field(response, 'outRefundNo' + i, 'out_refund_no_' + i) !== rf.outRefundNo) continue;
      const amount = Number(field(response, 'refundFee' + i, 'refund_fee_' + i));
      if (amount !== order.totalFee) throw new Error('退款查询金额不匹配');
      const status = field(response, 'refundStatus' + i, 'refund_status_' + i);
      const id = String(field(response, 'refundId' + i, 'refund_id_' + i) || '');
      if (status === 'SUCCESS' && !id) throw new Error('缺少渠道退款凭据');
      if (!['SUCCESS', 'PROCESSING', 'REFUNDCLOSE', 'CHANGE'].includes(status)) throw new Error('未知退款状态');
      return { status, id };
    }
    throw new Error('退款查询单号不匹配');
  }

  async function processOne(rf) {
    const order = (await db.collection('orders').doc(rf.orderId).get()).data;
    if (!order) return manualReview(rf, '关联订单不存在');
    if (order.status === 'refunded') return manualReview(rf, '历史已退款记录需单独核对，不自动修复账本');
    if (order.status !== 'refunding' || (order.refundId && order.refundId !== rf._id)) return manualReview(rf, '订单售后状态不匹配');
    if (rf.type === 'return_refund' && rf.returnStatus !== 'received') return manualReview(rf, '退货尚未确认收货');
    if (!['refund_only', 'return_refund'].includes(rf.type)) return manualReview(rf, '售后类型无效');
    if (!Number.isSafeInteger(order.totalFee) || order.totalFee <= 0 ||
        (rf.approvedAmount !== undefined && rf.approvedAmount !== order.totalFee)) return manualReview(rf, '审批金额与订单金额不匹配');
    rf.outRefundNo = rf.outRefundNo || refundNo(rf._id);
    if (order.paymentSource === 'mockPay' || String(order.transactionId || '').startsWith('MOCK_TXN_')) {
      return finish(rf, order, '', 'mock');
    }
    if (!order.transactionId) return manualReview(rf, '订单缺少微信支付交易号');
    const config = (await db.collection('pay_config').doc('default').get()).data || {};
    const subMchId = String(rf.subMchId || config.subMchId || '').trim();
    if (!subMchId) return manualReview(rf, '微信支付商户号未配置');
    let state, selected;
    try {
      selected = await queryChannel(rf, order, subMchId);
      state = parseQuery(selected.response, rf, order);
    } catch (err) {
      event(logger, 'refund.query_failed', { id: rf._id, code: err.code });
      return manualReview(rf, errorText(err) + '；仅核对，不重复提交退款');
    }
    if (state.status !== 'NOT_FOUND') await patchClaim(rf, { channelObserved: true, channelStatus: state.status });
    if (state.status === 'SUCCESS') return finish(rf, order, state.id, selected.channel);
    if (state.status === 'PROCESSING') {
      await patchClaim(rf, { status: 'channel_processing', channelStatus: 'PROCESSING', lastProcessError: '' });
      return 'waiting';
    }
    if (state.status !== 'NOT_FOUND') return manualReview(rf, '渠道状态 ' + state.status + '，请核查商户平台');
    if (rf.queryOnly) return manualReview(rf, '此前已尝试或接管过退款，暂未查询到结果；禁止自动再次提交');
    if (selected.channel === 'direct' && !selected.cfg.apiCertP12) return manualReview(rf, '直连退款证书缺失，未提交退款');

    // Persist uncertainty BEFORE the external mutation. A crash or timeout can only lead to query, never resubmission.
    if (!await patchClaim(rf, {
      submittedAt: db.serverDate(), outRefundNo: rf.outRefundNo,
      subMchId, approvedAmount: order.totalFee, submittedChannel: selected.channel,
      definitiveRejected: false, processAttempts: _.inc(1)
    })) return 'waiting';
    try {
      event(logger, 'refund.submit', { id: rf._id, channel: selected.channel });
      const response = selected.channel === 'direct' ? await directRefund({
        appId: 'wx6e685f787f1cd099', mchId: subMchId, apiV2Key: selected.cfg.apiV2Key,
        pfxBuffer: selected.cfg.apiCertP12 ? Buffer.from(selected.cfg.apiCertP12, 'base64') : undefined,
        passphrase: selected.cfg.apiCertPassword, outTradeNo: order.orderNo, outRefundNo: rf.outRefundNo,
        totalFee: order.totalFee, refundFee: order.totalFee
      }) : await cloud.cloudPay.refund({
        subMchId, outTradeNo: order.orderNo, outRefundNo: rf.outRefundNo,
        nonceStr: crypto.randomBytes(16).toString('hex'), totalFee: order.totalFee,
        refundFee: order.totalFee, envId: ENV_ID, functionName: 'refund-processor'
      });
      // Acceptance is NOT completion. Only a subsequent authoritative query may post effects.
      const accepted = response && field(response, 'returnCode', 'return_code') === 'SUCCESS' &&
        field(response, 'resultCode', 'result_code') === 'SUCCESS' && field(response, 'refundId', 'refund_id');
      // Only this documented, explicit refusal allows a later operator retry after query.
      // Timeouts, SYSTEMERROR and unknown responses remain query-only.
      const definitiveRejected = response && field(response, 'returnCode', 'return_code') === 'SUCCESS' &&
        field(response, 'resultCode', 'result_code') === 'FAIL' && field(response, 'errCode', 'err_code') === 'NOTENOUGH';
      await patchClaim(rf, {
        status: accepted ? 'channel_processing' : 'manual_review',
        definitiveRejected: !!definitiveRejected,
        channelStatus: accepted ? 'PROCESSING' : 'UNKNOWN',
        lastProcessError: accepted ? '' : definitiveRejected ? '商户余额不足，未受理；确认余额后可按原号重试' : '退款申请未确认受理；请先核对渠道结果，禁止重复提交'
      });
      event(logger, 'refund.observed', { id: rf._id, channel: selected.channel,
        state: accepted ? 'PROCESSING' : 'UNKNOWN', code: field(response || {}, 'errCode', 'err_code') });
      return accepted ? 'waiting' : 'manualReview';
    } catch (err) {
      return manualReview(rf, errorText(err) + '；资金结果未知，请查询核对，禁止重复提交');
    }
  }


  async function recoverInventory(id) {
    return db.runTransaction(async tx => {
      const refund = (await tx.collection('refunds').doc(id).get()).data;
      if (!refund || refund.status !== 'approved' || refund.inventoryRestockStatus !== 'pending_exception') return null;
      if (refund.completionVersion !== 2 || refund.channelStatus !== 'SUCCESS' || !refund.refundId || !refund.outRefundNo) {
        throw new Error('Verified original refund receipt required for inventory recovery');
      }
      const order = (await tx.collection('orders').doc(refund.orderId).get()).data;
      if (!order || order.status !== 'refunded') throw new Error('Financial refund is not complete');
      const effects = await applyRefundEffects(tx, db, order, refund, refund.restock === true);
      await tx.collection('refunds').doc(id).update({ data: { ...effects, processTime: db.serverDate() } });
      return { success: true, completed: true, ...effects,
        message: effects.inventoryRestockStatus === 'pending_exception' ? 'Refund money completed; inventory exception remains' : 'Original refund inventory recovered; no channel submission' };
    });
  }

  async function execute(id, force = true) {
    try {
      const recovered = await recoverInventory(id);
      if (recovered) return recovered;
      const rf = await claim(id, force);
      if (!rf) {
        const current = (await db.collection('refunds').doc(id).get()).data;
        const completed = !!current && current.status === 'approved' && (current.completionVersion === 2 || current.refundChannel === 'mock');
        return { success: !!current, alreadyProcessed: true, completed,
          message: completed ? '退款已完成，请勿重复提交' : '记录已处理或正在核对；历史结果仍需核实，请勿重复提交' };
      }
      let outcome;
      try { outcome = await processOne(rf); }
      catch (error) { outcome = await manualReview(rf, errorText(error)); }
      const completedRefund = outcome === 'completed' ? (await db.collection('refunds').doc(id).get()).data : null;
      return { success: outcome !== 'manualReview', completed: outcome === 'completed',
        ...(completedRefund ? { inventoryRestockStatus: completedRefund.inventoryRestockStatus, inventoryRestockError: completedRefund.inventoryRestockError } : {}),
        channelAccepted: outcome === 'waiting', message: outcome === 'completed'
          ? (completedRefund.inventoryRestockStatus === 'pending_exception' ? '退款已入账，库存异常待恢复；不要重复退款' : '渠道已确认退款完成并入账') : '退款尚未完成，请核对原单，不要重复退款',
        ...(outcome === 'manualReview' ? { error: '退款需要核对原单，请勿重复提交' } : {}) };
    } catch (error) {
      event(logger, 'refund.local_failed', { id, code: error.code });
      return { success: false, completed: false, error: '退款执行未完成，请核对原单' };
    }
  }
  async function sweep() {
    const stockPending = await db.collection('refunds').where({ status: 'approved', inventoryRestockStatus: 'pending_exception', completionVersion: 2 }).limit(3).get();
    let inventoryRecovered = 0, inventoryPending = 0;
    for (const refund of stockPending.data || []) {
      const result = await recoverInventory(refund._id);
      if (result && result.inventoryRestockStatus === 'completed') inventoryRecovered++;
      else inventoryPending++;
    }
    const pending = await db.collection('refunds').where({ status: _.in(ACTIVE) }).orderBy('processTime', 'asc').limit(20).get();
    const counts = { processed: 0, completed: 0, waiting: 0, manualReview: 0 };
    for (const row of pending.data || []) {
      if (counts.processed >= 3) break;
      const rf = await claim(row._id);
      if (!rf) continue;
      counts.processed++;
      try { counts[await processOne(rf)]++; }
      catch (error) { await manualReview(rf, errorText(error)); counts.manualReview++; }
    }
    return { success: true, ...counts, inventoryRecovered, inventoryPending };
  }
  return { execute, sweep };
}

module.exports = { createRefundExecutor };
