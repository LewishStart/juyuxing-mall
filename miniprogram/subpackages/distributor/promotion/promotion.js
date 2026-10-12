'use strict';

const API = require('../../../utils/api');
const { toast } = require('../../../utils/util');

Page({
  data: { products: [], selectedProductId: '', asset: null, loading: false, linkLoading: false },
  onLoad() { this.loadProducts(); this.generate(); },

  async loadProducts() {
    const result = await API.getProductList({ pageSize: 50 }, { silent: true });
    if (result && result.success) this.setData({ products: result.data || [] });
  },

  chooseTarget(e) {
    const product = this.data.products[Number(e.detail.value)];
    this.setData({ selectedProductId: (product && product._id) || '', asset: null });
  },

  chooseHome() { this.setData({ selectedProductId: '', asset: null }); },

  async generate() {
    if (this.data.loading) return;
    this.setData({ loading: true });
    const result = await API.getPromotionAsset(this.data.selectedProductId);
    this.setData({ loading: false });
    if (result && result.success) {
      this.setData({ asset: result.data });
    } else {
      toast((result && result.error) || '素材生成失败');
    }
  },

  copyPath() {
    if (!this.data.asset) return;
    wx.setClipboardData({ data: this.data.asset.sharePath, success: () => toast('分享路径已复制', 'success') });
  },

  async createUrlLink() {
    if (this.data.linkLoading) return;
    this.setData({ linkLoading: true });
    const result = await API.getPromotionUrlLink(this.data.selectedProductId);
    this.setData({ linkLoading: false });
    if (result && result.success && result.data.urlLink) {
      wx.setClipboardData({ data: result.data.urlLink, success: () => toast('30 天 URL Link 已复制', 'success') });
    } else toast((result && result.error) || 'URL Link 生成失败');
  },

  saveQr() {
    const fileId = this.data.asset && this.data.asset.qrFileId;
    if (!fileId) { toast('二维码尚未生成，请检查云函数权限'); return; }
    wx.cloud.downloadFile({
      fileID: fileId,
      success: result => wx.saveImageToPhotosAlbum({
        filePath: result.tempFilePath,
        success: () => toast('二维码已保存', 'success'),
        fail: () => toast('请允许保存到相册')
      }),
      fail: () => toast('二维码下载失败')
    });
  },

  onShareAppMessage() {
    const asset = this.data.asset;
    return asset ? { title: '林元元自然生活好物', path: asset.sharePath, imageUrl: '/images/share-banner.png' } : {};
  }
});
