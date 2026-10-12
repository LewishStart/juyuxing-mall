const API = require('../../utils/api');
const { toast } = require('../../utils/util');

const ORDER_COUNTS_CACHE_TTL = 30 * 1000;
const AGENT_STATUS_CACHE_TTL = 60 * 1000;
const EMPTY_ORDER_COUNTS = { pending: 0, paid: 0, shipped: 0, refunding: 0 };

function isValidOrderCounts(counts) {
  return !!(counts && ['pending', 'paid', 'shipped', 'refunding']
    .every(key => Number.isFinite(counts[key]) && counts[key] >= 0));
}

function readTimedCache(key, ttl) {
  try {
    const cache = wx.getStorageSync(key);
    if (!cache || !Number.isFinite(cache.timestamp) || Date.now() - cache.timestamp >= ttl) return null;
    return cache.data === undefined ? null : cache.data;
  } catch (e) {
    return null;
  }
}

function writeTimedCache(key, data) {
  try {
    wx.setStorageSync(key, { timestamp: Date.now(), data });
  } catch (e) {}
}

Page({
  data: {
    userInfo: {},
    isLoggedIn: false,
    hasUserInfo: false,
    showPrivacy: false,
    orderCounts: EMPTY_ORDER_COUNTS,
    isAgent: false
  },

  onShow() {
    return Promise.all([this.loadUserInfo(), this.loadOrderCounts(), this.loadAgentStatus()]);
  },

  // 已激活分销员显示「分销中心」入口（分包页面，普通用户不可见）；60s 缓存减少云函数调用
  async loadAgentStatus() {
    const openId = wx.getStorageSync('openId');
    if (!openId) { this.setData({ isAgent: false }); return; }
    const cacheKey = 'userAgentStatus_' + openId;
    const cached = readTimedCache(cacheKey, AGENT_STATUS_CACHE_TTL);
    if (cached !== null && cached !== undefined) { this.setData({ isAgent: !!cached }); return; }
    try {
      const info = await API.getAgentInfo({ silent: true });
      const active = !!(info && info.success && info.isAgent && info.status === 'active');
      this.setData({ isAgent: active });
      writeTimedCache(cacheKey, active);
    } catch (e) {
      this.setData({ isAgent: false });
    }
  },

  async loadUserInfo() {
    const openId = wx.getStorageSync('openId');
    const savedInfo = wx.getStorageSync('userInfo');
    if (!openId) {
      this.setData({ isLoggedIn: false, hasUserInfo: false, userInfo: {}, orderCounts: EMPTY_ORDER_COUNTS });
      return;
    }
    getApp().globalData.openId = openId;
    this.setData({
      isLoggedIn: true,
      userInfo: savedInfo || {},
      hasUserInfo: !!(savedInfo && savedInfo.nickName)
    });

  },

  async loadOrderCounts() {
    const openId = wx.getStorageSync('openId');
    if (!openId) return;

    const cacheKey = 'userOrderCounts_' + openId;
    const cachedCounts = readTimedCache(cacheKey, ORDER_COUNTS_CACHE_TTL);
    if (isValidOrderCounts(cachedCounts)) {
      this.setData({ orderCounts: cachedCounts });
      return;
    }

    try {
      const res = await API.getOrderCounts({ silent: true });
      if (!res || !res.success || !isValidOrderCounts(res.data)) return;
      this.setData({ orderCounts: res.data });
      writeTimedCache(cacheKey, res.data);
    } catch (e) {}
  },

  loginOrUpdateProfile() {
    if (!wx.getStorageSync('openId')) this.getUserProfile();
    else if (!this.data.hasUserInfo) this.getUserProfile();
    else toast('已登录', 'success');
  },


  getUserProfile() {
    wx.getUserProfile({
      desc: '用于完善个人资料',
      success: async (res) => {
        const { nickName, avatarUrl } = res.userInfo;
        try {
          // 推荐关系绑定：经由分享链接进入即静默绑定（不弹窗）
          let ref = wx.getStorageSync('pendingReferrer') || getApp().getReferrer();
          if (ref) {
            const agreed = await getApp().confirmReferralBinding(ref);
            if (!agreed) ref = null;
          }
          const loginRes = await API.login({ ref, nickName, avatarUrl });
          if (loginRes && loginRes.openId) {
            wx.setStorageSync('openId', loginRes.openId);
            wx.setStorageSync('userInfo', { nickName, avatarUrl });
            wx.removeStorageSync('pendingReferrer');
            getApp().globalData.openId = loginRes.openId;
            this.setData({ userInfo: { nickName, avatarUrl }, isLoggedIn: true, hasUserInfo: true });
            toast('登录成功', 'success');
            this.loadUserInfo();
            this.loadOrderCounts();
          }
        } catch (err) {
          toast('登录失败');
        }
      },
      fail: () => this.loginWithOpenIdOnly()
    });
  },

  // 隐私拦截器触发时由 app.js 调用，弹出品牌化授权框
  showPrivacyPopup() {
    this.setData({ showPrivacy: true });
  },

  onPrivacyAgree() {
    this.setData({ showPrivacy: false });
    const resolve = getApp().privacyResolve;
    if (resolve) resolve({ event: 'agree' });
  },

  onPrivacyDisagree() {
    this.setData({ showPrivacy: false });
    const resolve = getApp().privacyResolve;
    if (resolve) resolve({ event: 'disagree' });
    // 用户拒绝隐私授权时，降级为仅用 openId 登录（不取昵称/头像）
    this.loginWithOpenIdOnly();
  },

  async loginWithOpenIdOnly() {
    if (wx.getStorageSync('openId')) return;
    try {
      // 推荐关系绑定：经由分享链接进入即静默绑定（不弹窗）
      let ref = wx.getStorageSync('pendingReferrer') || getApp().getReferrer();
      if (ref) {
        const agreed = await getApp().confirmReferralBinding(ref);
        if (!agreed) ref = null;
      }
      const res = await API.login({ ref });
      if (res && res.openId) {
        wx.setStorageSync('openId', res.openId);
        wx.removeStorageSync('pendingReferrer');
        getApp().globalData.openId = res.openId;
        this.setData({ isLoggedIn: true });
        this.loadOrderCounts();
      }
    } catch (e) {}
  },

  onShareAppMessage() {
    return {
      title: '林元元中医生活 - 我的',
      path: '/pages/index/index'
    };
  }
});
