const API = require('../../utils/api');
const { toast, decorateItem, decorateList, decorateYuanItem } = require('../../utils/util');

Page({
  data: {
    openId: '',
    agentCode: '',
    userInfo: {},
    agentInfo: { code: '', level: '初级代理' },
    stats: { totalCommission: 0, available: 0, teamCount: 0, monthSales: 0, monthCommission: 0, monthOrders: 0 },
    commissions: [],
    loading: true
  },

  onShow() { this.loadData(); },
  onPullDownRefresh() {
    this.loadData().finally(() => wx.stopPullDownRefresh());
  },

  async loadData() {
    this.setData({ loading: true });
    try {
      const [infoRes, perfRes, teamRes, commRes] = await Promise.all([
        API.getAgentInfo({ silent: true }),
        API.getAgentPerformance({ silent: true }),
        API.getAgentTeam({ silent: true }),
        API.getAgentCommissions({ pageSize: 10 }, { silent: true })
      ]);
      const userInfo = wx.getStorageSync('userInfo') || {};
      const openId = wx.getStorageSync('openId') || '';
      const agentCode = openId ? 'JY' + openId.substring(Math.max(0, openId.length - 6)).toUpperCase() : '';
      this.setData({
        userInfo,
        openId,
        agentCode,
        agentInfo: Object.assign({ code: '', level: '初级代理' }, infoRes || {}),
        stats: decorateYuanItem({
          totalCommission: ((perfRes && perfRes.totalCommission) || 0) / 100,
          available: ((perfRes && perfRes.available) || 0) / 100,
          teamCount: (teamRes && teamRes.total) || 0,
          monthSales: ((perfRes && perfRes.monthSales) || 0) / 100,
          monthCommission: ((perfRes && perfRes.monthCommission) || 0) / 100,
          monthOrders: (perfRes && perfRes.monthOrders) || 0
        }),
        commissions: decorateList(((commRes && commRes.data) || []).slice(0, 10)),
        loading: false
      });
    } catch (err) {
      toast('加载代理数据失败');
      this.setData({ loading: false });
    }
  },

  copyCode() {
    const code = this.data.agentInfo.code || this.data.agentCode;
    if (!code) { toast('暂无推广码'); return; }
    wx.setClipboardData({ data: code, success: () => toast('推广码已复制', 'success') });
  },

  copyLink() {
    const openId = wx.getStorageSync('openId') || '';
    const link = `pages/index/index?ref=${openId}`;
    wx.setClipboardData({ data: link, success: () => toast('推广链接已复制', 'success') });
  },

  onShareAppMessage() {
    const openId = wx.getStorageSync('openId');
    return {
      title: '林元元中医生活 - 自然疗愈好物',
      path: `/pages/index/index?ref=${openId || ''}`,
      imageUrl: '/images/share-banner.png'
    };
  }
});
