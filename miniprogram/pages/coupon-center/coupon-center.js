const API = require('../../utils/api');

Page({
  data: {
    coupons: [],
    loading: true,
    loadError: '',
    claiming: ''
  },

  onShow() {
    if (this.data.coupons.length === 0) this.load();
    else this.load();
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh());
  },

  async load() {
    this.setData({ loading: this.data.coupons.length === 0, loadError: '' });
    const res = await API.getCouponCenter();
    if (res && res.success) {
      this.setData({ coupons: res.data || [], loading: false });
    } else {
      this.setData({ loading: false, loadError: (res && res.error) || '加载失败' });
    }
  },

  async onClaim(e) {
    const coupon = e && e.detail && e.detail.coupon;
    const id = coupon && coupon._id;
    if (!id) return;
    if (!wx.getStorageSync('openId')) {
      wx.showToast({ title: '请先登录', icon: 'none' });
      return;
    }
    if (this.data.claiming === id) return;
    this.setData({ claiming: id });
    const res = await API.claimCoupon(id);
    this.setData({ claiming: '' });
    if (res && res.success) {
      wx.showToast({ title: '领取成功', icon: 'success' });
      this.load();
    }
  },

  goMine() {
    wx.navigateTo({ url: '/pages/coupon-mine/coupon-mine' });
  },

  retry() {
    this.setData({ loading: true, loadError: '' });
    this.load();
  }
});
