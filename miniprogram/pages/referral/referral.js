const API = require('../../utils/api');
const { toast } = require('../../utils/util');

Page({
  data: {
    isLoggedIn: false,
    openId: '',
    referralCode: '',
    stats: { successCount: 0, rewardCount: 0 },
    loading: true
  },

  onShow() {
    const openId = wx.getStorageSync('openId') || '';
    const isLoggedIn = !!openId;
    this.setData({ openId, isLoggedIn, loading: !isLoggedIn });
    if (isLoggedIn) {
      this.loadStats();
      this.loadReferralCode();
    }
  },

  async loadStats() {
    try {
      const res = await API.getReferralStats({ silent: true });
      this.setData({
        stats: {
          successCount: (res && res.successCount) || 0,
          rewardCount: (res && res.rewardCount) || 0
        }
      });
    } catch (err) {}
  },

  async loadReferralCode() {
    try {
      const res = await API.getReferralCode({ silent: true });
      if (res && res.code) {
        this.setData({ referralCode: res.code, loading: false });
      } else {
        this.setData({ loading: false });
      }
    } catch (err) {
      this.setData({ loading: false });
    }
  },

  onShareAppMessage() {
    const openId = this.data.openId || wx.getStorageSync('openId') || '';
    return {
      title: '林元元中医生活 - 自然舒缓好物',
      path: `/pages/index/index?ref=${openId}`,
      imageUrl: '/images/share-banner.png'
    };
  },

  copyLink() {
    const openId = this.data.openId || wx.getStorageSync('openId') || '';
    if (!openId) {
      toast('请先登录');
      return;
    }
    const link = `${wx.getStorageSync('host') || 'https://your-domain.com'}/pages/index/index?ref=${openId}`;
    wx.setClipboardData({
      data: link,
      success: () => toast('邀请链接已复制', 'success')
    });
  },

  copyCode() {
    const code = this.data.referralCode;
    if (!code) {
      toast('推广码加载中，请稍后');
      return;
    }
    wx.setClipboardData({
      data: code,
      success: () => toast('推广码已复制', 'success')
    });
  },

  goLogin() {
    wx.switchTab({ url: '/pages/user/user' });
  },

  goCoupons() {
    wx.navigateTo({ url: '/pages/coupon-mine/coupon-mine' });
  }
});
