const API = require('../../utils/api');
const { toast, decorateItem } = require('../../utils/util');

Page({
  data: {
    product: null,
    images: [],
    selectedSpec: 0,
    quantity: 1,
    specName: '',
    maxStock: 999,
    showSpecPicker: false,
    isFavorited: false,
    loadedFromServer: false,
    loading: true,
    loadError: ''
  },

  onLoad(options) {
    if (options.ref) {
      const ref = String(options.ref).trim().toUpperCase();
      wx.setStorageSync('pendingReferrer', ref);
      if (wx.getStorageSync('openId')) {
        // 已登录用户：经由分享链接进入即静默绑定（不弹窗）
        getApp().confirmReferralBinding(ref).then(agreed => {
          if (!agreed) return;
          API.login({ action: 'login', ref }, { silent: true }).catch(() => {});
        });
      }
    }
    if (options.id) {
      this.loadProduct(options.id);
      this.checkFav(options.id);
    } else {
      this.setData({ loading: false, loadError: '缺少商品ID' });
    }
  },

  onShow() {
    // 收藏/取消收藏回来要刷新
    if (this.data.product && this.data.product._id) {
      this.checkFav(this.data.product._id);
    }
  },

  async loadProduct(id) {
    const res = await API.getProduct(id);
    if (!res || !res.success || !res.data) {
      this.setData({ loading: false, loadError: '商品不存在或已下架' });
      return;
    }
    const p = res.data;
    const images = (p.images && p.images.length > 0) ? p.images : [];
    const specs = p.specs || [];
    const firstStock = (specs[0] && typeof specs[0].stock === 'number') ? specs[0].stock : 999;
    this.setData({
      product: decorateItem(p),
      images: images,
      selectedSpec: 0,
      specName: (specs[0] && specs[0].name) || '',
      maxStock: firstStock,
      loadedFromServer: true,
      loading: false
    });
    this.updateSpecPrice(this.data.specName);
  },

  // 主价格区跟随所选规格（规格价优先，回退商品主价，与服务端口径一致）
  updateSpecPrice(specName) {
    const p = this.data.product;
    if (!p) return;
    const spec = (p.specs || []).find(s => s && s.name === specName);
    const price = Number(spec && spec.price) || Number(p.price) || 0;
    this.setData({ currentPrice: price, currentPriceText: (price / 100).toFixed(2) });
  },

  async checkFav(productId) {
    try {
      const res = await API.checkFavorite(productId, { silent: true });
      if (res && res.success) {
        this.setData({ isFavorited: !!res.favorited });
      }
    } catch (e) {}
  },

  openSpecPicker() {
    if (!this.data.product) return;
    this.setData({ showSpecPicker: true });
  },

  onSpecClose() {
    this.setData({ showSpecPicker: false });
  },

  onSpecConfirm(e) {
    const { specIndex, specName, quantity } = e.detail;
    this.setData({
      selectedSpec: specIndex,
      specName: specName,
      quantity: quantity,
      showSpecPicker: false
    });
    this.updateSpecPrice(specName);
    this.buyNow();
  },

  onSpecAddCart(e) {
    const { specName, quantity } = e.detail;
    this.setData({ specName: specName, quantity: quantity, showSpecPicker: false });
    this.updateSpecPrice(specName);
    this.addToCart();
  },

  async addToCart() {
    if (!wx.getStorageSync('openId')) { toast('请先登录'); return; }
    const p = this.data.product;
    if (!p) return;
    try {
      // 取已存在的购物车追加
      const cur = await API.getCart({ silent: true });
      const exist = (cur && cur.items) || [];
      const specName = this.data.specName || (p.specs && p.specs[0] && p.specs[0].name) || '';
      // 与服务端口径一致：优先规格价，缺失时回退商品主价
      const spec = (p.specs || []).find(s => s && s.name === specName);
      const newItem = {
        productId: p._id,
        name: p.name,
        spec: specName,
        price: Number(spec && spec.price) || Number(p.price) || 0,
        quantity: this.data.quantity,
        image: (p.images && p.images[0]) || ''
      };
      // 合并相同规格
      const idx = exist.findIndex(it => it.productId === newItem.productId && (it.spec || '') === newItem.spec);
      if (idx >= 0) exist[idx].quantity = (Number(exist[idx].quantity) || 0) + newItem.quantity;
      else exist.push(newItem);
      await API.updateCart(exist);
      toast('已加入购物车', 'success');
    } catch (err) {
      toast('添加失败，请重试');
    }
  },

  buyNow() {
    if (!wx.getStorageSync('openId')) { toast('请先登录'); return; }
    const p = this.data.product;
    if (!p) return;
    wx.navigateTo({
      url: `/pages/checkout/checkout?productId=${p._id}&quantity=${this.data.quantity}&specName=${encodeURIComponent(this.data.specName || '')}`
    });
  },

  async toggleFavorite() {
    if (!wx.getStorageSync('openId')) { toast('请先登录'); return; }
    const p = this.data.product;
    if (!p) return;
    const res = await API.toggleFavorite(p._id);
    if (res && res.success) {
      this.setData({ isFavorited: !!res.favorited });
      toast(res.favorited ? '已收藏' : '已取消收藏', 'success');
    }
  },

  retry() {
    if (this.data.product && this.data.product._id) {
      this.setData({ loading: true, loadError: '' });
      this.loadProduct(this.data.product._id);
    }
  },

  onSwiperError(e) {
    console.warn('swiper image error', e);
  },

  onShareAppMessage() {
    const p = this.data.product || {};
    return {
      title: `${p.name || '好物'} - ${p.subtitle || '林元元中医生活'}`,
      path: `/pages/product/product?id=${p._id || ''}`,
      imageUrl: (p.images && p.images[0]) || '/images/share-banner.png'
    };
  }
});
