'use strict';

const crypto = require('crypto');
const { event, safeError, errorCode } = require('./payment-diagnostics');

const ACTIVE = new Set(['ACCEPTED', 'PROCESSING', 'WAIT_USER_CONFIRM', 'TRANSFERING', 'CANCELING']);
const CLOSED = new Set(['FAIL', 'CANCELLED']);
const CLAIM_MS = 60 * 1000;

function createWithdrawalService(db, transfer, logger = console) {
  const tx = work => {
    if (typeof db.runTransaction !== 'function') throw new Error('提现需要数据库事务支持');
    return db.runTransaction(work);
  };
  const bump = (t, id) => t.collection('users').doc(id).update({ data: { withdrawalVersion: db.command.inc(1), updateTime: db.serverDate() } });

  async function complete(id, billNo, bill = {}) {
    return tx(async t => {
      const wd = (await t.collection('withdrawals').doc(id).get()).data;
      if (!wd || wd.outBatchNo !== billNo) throw new Error('转账单已变化，请重新核对');
      // Historical accounting is retained verbatim; it requires separate reconciliation.
      if (wd.accountingVersion === 2) {
        const list = (await t.collection('commissions').where({ paidByWithdrawal: id }).limit(1000).get()).data || [];
        if (list.some(c => !['withdrawing', 'paid'].includes(c.status)) ||
            list.reduce((sum, c) => sum + Number(c.amount || 0), 0) !== wd.amount) throw new Error('提现占用账本不一致');
        const key = 'commission_payout:' + id;
        const entries = (await t.collection('cashflow_entries').where({ idempotencyKey: key }).limit(2).get()).data || [];
        if (entries.length > 1 || entries.some(e => e.amount !== wd.amount || e.status !== 'posted' ||
            e.type !== 'commission_payout' || e.direction !== 'out' || e.withdrawalId !== id)) throw new Error('提现支出账本不一致');
        for (const c of list.filter(c => c.status === 'withdrawing')) {
          await t.collection('commissions').doc(c._id).update({ data: { status: 'paid', paidTime: db.serverDate() } });
        }
        if (!entries.length) await t.collection('cashflow_entries').add({ data: {
          idempotencyKey: key, type: 'commission_payout', direction: 'out', amount: wd.amount,
          withdrawalId: id, agentId: wd.agentId, status: 'posted', createTime: db.serverDate()
        } });
        await bump(t, wd.agentId);
      }
      await t.collection('withdrawals').doc(id).update({ data: {
        status: 'success', transferState: 'SUCCESS', finishTime: wd.finishTime || db.serverDate(),
        transferBillNo: bill.transferBillNo || bill.raw && bill.raw.transfer_bill_no || wd.transferBillNo || '',
        transferClaimToken: '', lastPayError: ''
      } });
      return { success: true, state: 'SUCCESS', withdrawalStatus: 'success', message: '转账已完成，分销员已收款' };
    });
  }

  async function validateObservation(id, billNo, bill) {
    if (!bill || typeof bill !== 'object') throw Object.assign(new Error('Empty transfer response'), { code: 'CHANNEL_RESPONSE_INVALID' });
    const raw = bill.raw || {};
    const config = transfer.getTransferClientConfig();
    const current = (await db.collection('withdrawals').doc(id).get()).data;
    if (!current || current.outBatchNo !== billNo || raw.out_bill_no && raw.out_bill_no !== billNo || raw.mch_id && raw.mch_id !== config.mchId ||
        raw.appid && raw.appid !== config.appId || raw.transfer_amount !== undefined && raw.transfer_amount !== current.amount) {
      throw Object.assign(new Error('Transfer response mismatch'), { code: 'CHANNEL_RESPONSE_INVALID' });
    }
    if (bill.state !== 'SUCCESS' && !ACTIVE.has(bill.state) && !CLOSED.has(bill.state)) throw Object.assign(new Error('Unknown transfer state'), { code: 'CHANNEL_STATE_UNKNOWN' });
  }

  async function observe(id, billNo, bill) {
    await validateObservation(id, billNo, bill);
    if (bill.state === 'SUCCESS') return complete(id, billNo, bill);
    return tx(async t => {
      const wd = (await t.collection('withdrawals').doc(id).get()).data;
      if (!wd || wd.outBatchNo !== billNo) throw new Error('转账单已变化，请重新核对');
      if (wd.status === 'success') return { success: true, state: 'SUCCESS', withdrawalStatus: 'success' };
      const closed = CLOSED.has(bill.state);
      const data = { status: closed ? 'pending_pay' : 'transferring', transferState: bill.state,
        lastPayError: closed ? '转账单失败或关闭，请先核对原单再重试' : '' };
      if (bill.transferBillNo) data.transferBillNo = bill.transferBillNo;
      if (bill.packageInfo || bill.raw && bill.raw.package_info) data.packageInfo = bill.packageInfo || bill.raw.package_info;
      if (closed) data.packageInfo = '';
      await t.collection('withdrawals').doc(id).update({ data });
      return { success: true, state: bill.state, batchStatus: bill.state, withdrawalStatus: data.status,
        message: closed ? '原转账单已失败或关闭，可核对后重新发起' : '转账处理中，待分销员确认或渠道完成' };
    });
  }

  async function reserve(id, remark) {
    return tx(async t => {
      const wd = (await t.collection('withdrawals').doc(id).get()).data;
      if (!wd || wd.status !== 'pending') return false;
      const user = (await t.collection('users').doc(wd.agentId).get()).data;
      if (!user) throw new Error('分销员账号不存在');
      const rows = (await t.collection('commissions').where({ agentId: wd.agentId, status: 'settled' }).orderBy('settleTime', 'asc').limit(1000).get()).data || [];
      if (!Number.isSafeInteger(wd.amount) || wd.amount < 30 || rows.reduce((sum, c) => sum + Number(c.amount || 0), 0) < wd.amount) throw new Error('可提现佣金已发生变化，请重新审核');
      let remaining = wd.amount;
      for (const c of rows.filter(c => c.amount > 0)) {
        if (!remaining) break;
        const amount = Math.min(c.amount, remaining);
        if (amount === c.amount) await t.collection('commissions').doc(c._id).update({ data: {
          status: 'withdrawing', heldTime: db.serverDate(), paidByWithdrawal: id
        } });
        else {
          await t.collection('commissions').doc(c._id).update({ data: { amount: c.amount - amount } });
          await t.collection('commissions').add({ data: {
            agentId: c.agentId, orderId: c.orderId, orderNo: c.orderNo, rate: c.rate || 0,
            amount, type: c.type || 'earning', idempotencyKey: 'withdrawal:' + id + ':' + c._id,
            status: 'withdrawing', settleTime: c.settleTime, heldTime: db.serverDate(), paidByWithdrawal: id,
            source: 'split-from-' + c._id
          } });
        }
        remaining -= amount;
      }
      if (remaining) throw new Error('佣金流水不足，审核已回滚');
      await t.collection('withdrawals').doc(id).update({ data: {
        status: 'pending_pay', accountingVersion: 2, processTime: db.serverDate(),
        payoutMode: 'wechat_transfer', remark: remark || ''
      } });
      await bump(t, wd.agentId);
      return true;
    });
  }

  async function query(id) {
    const wd = (await db.collection('withdrawals').doc(id).get()).data;
    if (!wd || !wd.outBatchNo) return { success: false, error: '该笔提现尚未发起转账' };
    try { return await observe(id, wd.outBatchNo, await transfer.queryBill(wd.outBatchNo)); }
    catch (error) {
      event(logger, 'withdrawal.query_failed', { id, code: errorCode(error) });
      return { success: false, error: safeError(error) };
    }
  }

  async function getOwn(id, openId) {
    if (!openId || !id) return { success: false, error: '缺少可信微信身份或提现记录ID' };
    const wd = (await db.collection('withdrawals').doc(id).get()).data;
    if (!wd || wd.agentId !== openId) return { success: false, error: '提现记录不存在或无权访问' };
    if (!wd.outBatchNo) return { success: false, error: '该笔提现尚未发起微信转账' };
    try {
      const bill = await transfer.queryBill(wd.outBatchNo);
      const result = await observe(id, wd.outBatchNo, bill);
      if (result.state === 'SUCCESS') return { ...result, ready: false };
      if (CLOSED.has(bill.state)) return { success: false, code: 'TRANSFER_CLOSED', error: '转账单已失败或关闭，请联系财务核对原单' };
      if (!['WAIT_USER_CONFIRM', 'TRANSFERING'].includes(bill.state)) return { ...result, ready: false };
      const latest = (await db.collection('withdrawals').doc(id).get()).data;
      if (!latest.packageInfo) return { success: false, code: 'TRANSFER_PACKAGE_MISSING', error: '旧转账缺少确认凭证，请联系财务核对原单，勿盲目重试' };
      return { ...result, ready: true, packageInfo: latest.packageInfo, ...transfer.getTransferClientConfig() };
    } catch (error) {
      event(logger, 'withdrawal.receive_failed', { id, code: errorCode(error) });
      return { success: false, error: safeError(error) };
    }
  }

  async function processRequest({ withdrawalId: id, approve, remark }) {
    if (typeof id !== 'string' || !id || typeof approve !== 'boolean') return { success: false, error: '提现记录或审批参数无效' };
    try {
      let wd = (await db.collection('withdrawals').doc(id).get()).data;
      if (!wd) return { success: false, error: '提现记录不存在' };
      if (!approve) return tx(async t => {
        const latest = (await t.collection('withdrawals').doc(id).get()).data;
        if (latest.status === 'rejected') return { success: true, alreadyProcessed: true };
        if (latest.status !== 'pending') return { success: false, error: '该提现申请已处理' };
        await t.collection('withdrawals').doc(id).update({ data: { status: 'rejected', processTime: db.serverDate(), remark: remark || '' } });
        await bump(t, latest.agentId); return { success: true, message: '已拒绝' };
      });
      if (['success', 'approved', 'transferring'].includes(wd.status)) return { success: true, alreadyProcessed: true, message: '该提现已处理，请查询原单' };
      if (!['pending', 'pending_pay'].includes(wd.status)) return { success: false, error: '该提现申请已处理' };
      if (wd.status === 'pending' && !await reserve(id, remark)) return { success: true, alreadyProcessed: true };
      const token = crypto.randomBytes(16).toString('hex');
      const claimed = await tx(async t => {
        const latest = (await t.collection('withdrawals').doc(id).get()).data;
        if (latest.status !== 'pending_pay' || latest.transferClaimToken && Date.now() - new Date(latest.transferClaimTime).getTime() < CLAIM_MS) return null;
        const hadBill = !!latest.outBatchNo;
        const attempt = (Number(latest.transferAttempts) || 0) + 1;
        const billNo = latest.outBatchNo || transfer.genOutBillNo();
        await t.collection('withdrawals').doc(id).update({ data: {
          outBatchNo: billNo, transferClaimToken: token, transferClaimTime: db.serverDate(), transferAttempts: attempt
        } });
        return { ...latest, billNo, hadBill, attempt };
      });
      if (!claimed) return { success: true, alreadyProcessed: true, message: '当前正在处理，请勿重复操作' };
      let billNo = claimed.billNo;
      const started = Date.now();
      try {
        if (claimed.hadBill) {
          let bill, notFound = false;
          try { bill = await transfer.queryBill(billNo); }
          catch (error) { if (!transfer.isBillNotExistError(error)) throw error; notFound = true; }
          if (!notFound) {
            await validateObservation(id, billNo, bill);
            if (!CLOSED.has(bill.state)) return await observe(id, billNo, bill);
          }
          const next = transfer.genOutBillNo();
          await tx(async t => {
            const latest = (await t.collection('withdrawals').doc(id).get()).data;
            if (latest.outBatchNo !== billNo || latest.transferClaimToken !== token || latest.status === 'success') throw new Error('提现状态已变化');
            await t.collection('withdrawals').doc(id).update({ data: {
              lastOutBatchNo: billNo, outBillHistory: [...new Set([...(latest.outBillHistory || []), billNo])],
              outBatchNo: next, packageInfo: '', transferBillNo: ''
            } });
          });
          billNo = next;
        }
        event(logger, 'withdrawal.submit', { id, attempt: claimed.attempt });
        const result = await transfer.initiateTransfer({ amountFen: claimed.amount, openid: claimed.agentId, remark: '分销佣金提现', outBillNo: billNo });
        const observed = await observe(id, billNo, result);
        event(logger, 'withdrawal.observed', { id, state: result.state, durationMs: Date.now() - started });
        return { ...observed, transferInitiated: true };
      } catch (error) {
        const message = safeError(error);
        event(logger, 'withdrawal.submit_failed', { id, code: errorCode(error), httpCode: error.httpCode, durationMs: Date.now() - started });
        await tx(async t => {
          const latest = (await t.collection('withdrawals').doc(id).get()).data;
          if (latest.transferClaimToken === token && latest.status !== 'success') await t.collection('withdrawals').doc(id).update({ data: { status: 'pending_pay', lastPayError: message } });
        });
        return { success: true, transferFailed: true, pendingPay: true, message: '审批已保留，但转账结果未完成：' + message };
      } finally {
        await tx(async t => {
          const latest = (await t.collection('withdrawals').doc(id).get()).data;
          if (latest.transferClaimToken === token) await t.collection('withdrawals').doc(id).update({ data: { transferClaimToken: '' } });
        });
      }
    } catch (error) {
      event(logger, 'withdrawal.local_failed', { id, code: errorCode(error) });
      return { success: false, error: '提现处理未完成，请检查账本或稍后核对原单' };
    }
  }

  return { processRequest, observe, query, complete, getOwn };
}

module.exports = { createWithdrawalService };
