'use strict';

const API = require('../../../utils/api');
const { toast } = require('../../../utils/util');

function money(value) { return ((Number(value) || 0) / 100).toFixed(2); }

const STATUS_TEXT = {
  pending: '审核中',
  rejected: '已拒绝',
  pending_pay: '打款准备中',
  transferring: '待确认收款',
  success: '已到账',
  approved: '打款中'
};

Page({
  data: { available: '0.00', ledgerBalance: '0.00', pendingAmount: '0.00', frozenAmount: '0.00', frozenCount: 0, records: [], amount: '', name: '', account: '', requestId: '', submitting: false, receivingId: '' },
  onShow() { this.load(); },
  async load() {
    const [info, history] = await Promise.all([
      API.getWithdrawalInfo({ silent: true }),
      API.getWithdrawalList({ pageSize: 30 }, { silent: true })
    ]);
    if (info && info.success) this.setData({
      available: money(info.available), ledgerBalance: money(info.ledgerBalance), pendingAmount: money(info.pendingAmount),
      frozenAmount: money(info.frozenAmount), frozenCount: info.frozenCount || 0
    });
    this.setData({
      records: ((history && history.data) || []).map(r => Object.assign({}, r, {
        statusText: STATUS_TEXT[r.status] || r.status
      }))
    });
  },
  onAmount(e) { this.setData({ amount: e.detail.value }); },
  onName(e) { this.setData({ name: e.detail.value }); },
  onAccount(e) { this.setData({ account: e.detail.value }); },
  fullAmount() { this.setData({ amount: this.data.available }); },
  async submit() {
    if (this.data.submitting) return;
    const amount = Math.round(Number(this.data.amount) * 100);
    if (!Number.isFinite(amount) || amount <= 0) { toast('请输入有效金额'); return; }
    if (amount < 30) { toast('单笔提现不能低于 0.3 元'); return; }
    if (!this.data.name.trim() || !this.data.account.trim()) { toast('请填写收款信息'); return; }
    const requestId = this.data.requestId || `wd_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
    this.setData({ submitting: true, requestId });
    const result = await API.applyWithdrawal({
      amount,
      name: this.data.name.trim(),
      account: this.data.account.trim(),
      requestId
    });
    this.setData({ submitting: false });
    if (result && result.success) { toast(result.duplicate ? '申请已提交，请勿重复操作' : '提现申请已提交', 'success'); this.setData({ amount: '', requestId: '' }); this.load(); }
    else toast((result && result.error) || '提交失败');
  },
  async receiveTransfer(e) {
    if (this.data.receivingId) return;
    const withdrawalId = String(e.currentTarget.dataset.id || '');
    if (!withdrawalId) return;
    this.setData({ receivingId: withdrawalId });
    const transfer = await API.getOwnWithdrawalTransfer(withdrawalId, { silent: true });
    if (!transfer || !transfer.success) {
      this.setData({ receivingId: '' });
      toast((transfer && transfer.error) || '暂时无法领取转账');
      await this.load();
      return;
    }
    if (!transfer.ready) {
      this.setData({ receivingId: '' });
      toast(transfer.message || '微信正在处理转账，请稍后再试');
      await this.load();
      return;
    }
    if (!wx.canIUse || !wx.canIUse('requestMerchantTransfer') || typeof wx.requestMerchantTransfer !== 'function') {
      this.setData({ receivingId: '' });
      wx.showModal({ content: '当前微信版本不支持确认收款，请升级微信后重试。', showCancel: false });
      return;
    }
    wx.requestMerchantTransfer({
      mchId: transfer.mchId,
      appId: transfer.appId,
      package: transfer.packageInfo,
      success: async () => {
        this.setData({ receivingId: '' });
        toast('已打开微信收款确认页', 'success');
        await API.getOwnWithdrawalTransfer(withdrawalId, { silent: true });
        await this.load();
      },
      fail: async res => {
        this.setData({ receivingId: '' });
        const message = String((res && (res.errMsg || res.err_msg)) || '');
        if (message.indexOf('cancel') >= 0) toast('你已取消确认，可稍后重新领取');
        else toast('收款确认页打开失败，请稍后重试');
        await this.load();
      }
    });
  }
});
