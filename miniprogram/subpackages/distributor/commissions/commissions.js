'use strict';

const API = require('../../../utils/api');

function money(value) { return ((Number(value) || 0) / 100).toFixed(2); }

Page({
  data: { list: [], loading: true },
  onLoad() { this.load(); },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  async load() {
    this.setData({ loading: true });
    const result = await API.getAgentCommissions({ pageSize: 50 }, { silent: true });
    const statusText = { frozen: '冻结中', settled: '可提现', withdrawing: '提现处理中', paid: '已提现', cancelled: '已取消' };
    this.setData({
      loading: false,
      list: ((result && result.data) || []).map(item => ({
        ...item, amountText: money(Math.abs(item.amount)), sign: Number(item.amount) < 0 ? '-' : '+',
        statusText: statusText[item.status] || item.status, productText: (item.productNames || []).join('、') || '商城订单'
      }))
    });
  }
});
