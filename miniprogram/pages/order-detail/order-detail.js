const API = require('../../utils/api');
const { toast, showLoading, hideLoading, decorateItem, decorateList, smartFormatTime } = require('../../utils/util');

Page({
  data: {
    // 页面渲染状态
    loading: true,
    loadError: '',
    order: null,
    
    // 订单展示数据
    statusDesc: '',
    addressRegionText: '',
    totalFeeText: '0.00',
    originalTotalFeeText: '0.00',
    couponDiscountText: '0.00',
    hasDiscount: false,
    timeline: [],
    refundDetail: null,
    
    // 交互状态
    submitting: false
  },

  onLoad(options) {
    console.log('[order-detail] onLoad, options:', JSON.stringify(options));
    if (options.id) {
      this._orderId = options.id;
      console.log('[order-detail] 开始加载订单:', options.id);
      this.loadOrder(options.id);
    } else {
      console.warn('[order-detail] 缺少订单ID');
      this.setData({ loading: false, loadError: '订单ID缺失' });
    }
  },

  onShow() {
    console.log('[order-detail] onShow, 当前order:', this.data.order ? this.data.order._id : 'null');
    if (this.data.order && this.data.order._id) {
      console.log('[order-detail] onShow 触发刷新');
      this.loadOrder(this.data.order._id);
    }
  },

  onPullDownRefresh() {
    console.log('[order-detail] 下拉刷新');
    const id = this._orderId || (this.data.order && this.data.order._id);
    if (id) {
      this.loadOrder(id).finally(() => wx.stopPullDownRefresh());
    } else {
      wx.stopPullDownRefresh();
    }
  },

  async loadOrder(id) {
    // 防重入
    if (this._loading) {
      console.log('[order-detail] loadOrder 跳过（重入防护）');
      return;
    }
    this._loading = true;
    this._orderId = id;

    console.log('[order-detail] loadOrder 开始, id:', id);
    this.setData({ loading: true, loadError: '' });

    try {
      const res = await API.getOrderDetail(id);
      console.log('[order-detail] API.getOrderDetail 返回:', JSON.stringify(res));

      if (!res) {
        console.error('[order-detail] API 返回 null/undefined');
        this.setData({ loading: false, loadError: '服务返回为空' });
        return;
      }

      if (!res.success) {
        console.error('[order-detail] 云函数返回失败:', res.error);
        this.setData({ loading: false, loadError: res.error || '订单加载失败' });
        return;
      }

      if (!res.data) {
        console.error('[order-detail] res.data 为空');
        this.setData({ loading: false, loadError: '订单数据为空' });
        return;
      }

      const order = res.data;
      console.log('[order-detail] 订单数据:', {
        _id: order._id,
        orderNo: order.orderNo,
        status: order.status,
        itemsCount: (order.items || []).length,
        totalFee: order.totalFee,
        hasAddress: !!order.address,
        createTime: order.createTime
      });

      // 状态描述
      const statusDescMap = {
        pending: '请尽快完成支付',
        paid: '等待商家发货',
        shipped: '商品正在路上',
        received: '感谢您的购买，欢迎再次光临',
        refunding: '退款申请处理中',
        refunded: '退款已处理完成',
        cancelled: '订单已取消',
        closed: '订单已关闭'
      };

      // 地址区域
      let regionText = '';
      try {
        if (order.address) {
          if (Array.isArray(order.address.region)) {
            regionText = order.address.region.join(' ');
          } else if (typeof order.address.region === 'string') {
            regionText = order.address.region;
          }
        }
      } catch (e) {
        console.warn('[order-detail] 地址解析警告:', e);
      }

      // 装饰数据
      let decoratedOrder;
      try {
        decoratedOrder = Object.assign({}, decorateItem(order), {
          items: decorateList(order.items || [])
        });
      } catch (e) {
        console.error('[order-detail] decorateItem 失败:', e);
        // 回退：原始数据
        decoratedOrder = Object.assign({}, order);
      }

      // 时间线
      let timeline = [];
      try {
        timeline = this.buildTimeline(order).map(s => ({
          label: s.label,
          time: s.time,
          timeText: s.time ? smartFormatTime(s.time) : '',
          done: s.done
        }));
      } catch (e) {
        console.warn('[order-detail] buildTimeline 警告:', e);
      }

      // 金额计算
      const couponDiscount = Number(order.couponDiscount) || 0;
      const totalFee = Number(order.totalFee) || 0;
      const originalTotalFee = Number(order.originalTotalFee) || (totalFee + couponDiscount);

      console.log('[order-detail] setData 即将设置, loading→false');
      this.setData({
        order: decoratedOrder,
        statusDesc: (order.paymentResolutionRequired && order.status === 'paid' ? '原单已收款，库存需核对，请按原单申请退款' : order.paymentCloseRequested && order.status === 'pending' ? '正在核对原单支付与关单，请刷新或重试取消' : statusDescMap[order.status]) || '',
        addressRegionText: regionText,
        totalFeeText: (totalFee / 100).toFixed(2),
        originalTotalFeeText: (originalTotalFee / 100).toFixed(2),
        couponDiscountText: (couponDiscount / 100).toFixed(2),
        hasDiscount: couponDiscount > 0,
        timeline: timeline,
        loading: false
      });
      console.log('[order-detail] setData 完成，页面应显示订单内容');

      // 退款详情
      if (['refunding', 'refunded'].includes(order.status) && order.refundId) {
        this.loadRefundDetail(order.refundId);
      }
    } catch (e) {
      console.error('[order-detail] loadOrder 异常:', e);
      console.error('[order-detail] 异常堆栈:', e.stack || '无堆栈');
      this.setData({
        loading: false,
        loadError: '加载失败: ' + (e.message || '未知错误')
      });
    } finally {
      this._loading = false;
    }
  },

  async loadRefundDetail(refundId) {
    try {
      const res = await API.getRefundDetail(refundId, { silent: true });
      if (res && res.success && res.data) {
        const r = res.data;
        const statusMap = { pending: '审核中', pending_auto: '已批准，等待执行', processing: '退款核对中',
          channel_processing: '微信退款处理中', manual_review: '退款待商家核查', approved: '已退款', rejected: '已拒绝' };
        this.setData({
          refundDetail: {
            reason: r.reason || '',
            description: r.description || '',
            adminNote: r.adminNote || '',
            status: r.status,
            statusText: r.refundChannel === 'wechat_manual' ? '退款结果待商家核对' : (statusMap[r.status] || '处理中')
          }
        });
      }
    } catch (e) {
      console.warn('[order-detail] 退款详情加载失败:', e);
    }
  },

  buildTimeline(o) {
    const steps = [];
    const doneStatuses = o.status ? [o.status] : [];
    steps.push({ label: '提交订单', time: o.createTime, done: true });
    
    if (o.payTime || ['paid','shipped','received','refunding','refunded'].some(s => doneStatuses.includes(s))) {
      steps.push({ label: '支付完成', time: o.payTime, done: true });
    } else {
      steps.push({ label: '支付完成', time: null, done: false });
    }
    
    if (o.shipTime || ['shipped','received'].some(s => doneStatuses.includes(s))) {
      steps.push({ label: '商家发货', time: o.shipTime, done: true });
    } else if (['paid','pending'].some(s => doneStatuses.includes(s))) {
      steps.push({ label: '商家发货', time: null, done: false });
    }
    
    if (o.receivedTime || doneStatuses.includes('received')) {
      steps.push({ label: '确认收货', time: o.receivedTime || null, done: true });
    } else if (doneStatuses.includes('shipped')) {
      steps.push({ label: '确认收货', time: null, done: false });
    }
    
    return steps;
  },

  async payOrder() {
    if (!this.data.order || this.data.submitting) return;
    this.setData({ submitting: true });
    showLoading('处理支付...');
    
    try {
      const res = await API.requestPayment(this.data.order._id);
      hideLoading();
      
      if (res && res.success && (res.mock || res.alreadyPaid || res.reconciled)) {
        this.setData({ submitting: false });
        toast('支付成功', 'success');
        this.loadOrder(this.data.order._id);
        return;
      }
      
      if (res && res.success && res.payment) {
        const payment = res.payment;
        let settled = false;
        const guard = setTimeout(() => {
          if (settled) return;
          settled = true;
          this.setData({ submitting: false });
          wx.showModal({
            title: '请使用真机支付',
            content: '当前环境（开发者工具）无法拉起微信支付。请在手机上通过「真机预览」打开小程序完成支付。',
            showCancel: false
          });
        }, 12000);
        
        const finish = () => {
          if (!settled) { settled = true; clearTimeout(guard); }
        };
        
        wx.requestPayment({
          ...payment,
          success: async () => {
            finish();
            this.setData({ submitting: false });
            await this.loadOrder(this.data.order._id);
            const current = this.data.order;
            const confirmed = current && ['paid','shipped','received','refunding','refunded'].includes(current.status);
            toast(confirmed ? (current.paymentResolutionRequired ? '已收款，请按原单核对退款' : '支付成功') : '支付结果核对中，请稍后刷新', confirmed ? 'success' : 'none');
          },
          fail: (payErr) => {
            finish();
            if (payErr && payErr.errMsg && payErr.errMsg.indexOf('cancel') > -1) {
              toast('已取消支付');
            } else {
              const isDev = (() => {
                try {
                  const info = typeof wx.getDeviceInfo === 'function' ? wx.getDeviceInfo() : wx.getSystemInfoSync();
                  return info.platform === 'devtools';
                } catch (e) { return false; }
              })();
              if (isDev) {
                wx.showModal({
                  title: '请使用真机支付',
                  content: '开发者工具不支持微信支付，请在手机「真机预览」中支付。',
                  showCancel: false
                });
              } else {
                wx.showModal({
                  title: '支付失败',
                  content: (payErr && payErr.errMsg) || '未知错误',
                  showCancel: false
                });
              }
            }
            this.setData({ submitting: false });
          }
        });
        return;
      }
      
      this.setData({ submitting: false });
      wx.showModal({
        title: '支付失败',
        content: (res && res.error) || '支付服务暂不可用',
        showCancel: false
      });
    } catch (e) {
      hideLoading();
      console.error('[order-detail] payOrder 异常:', e);
      this.setData({ submitting: false });
      toast('支付异常，请重试');
    }
  },

  cancelOrder() {
    if (!this.data.order) return;
    wx.showModal({
      title: '提示',
      content: '确定取消该订单？',
      success: async (r) => {
        if (r.confirm) {
          const res = await API.cancelOrder(this.data.order._id);
          if (res && res.success) {
            toast('已取消', 'success');
            this.loadOrder(this.data.order._id);
          } else {
            toast((res && res.error) || '取消失败');
          }
        }
      }
    });
  },

  confirmReceive() {
    if (!this.data.order) return;
    wx.showModal({
      title: '提示',
      content: '确认已收到商品？',
      success: async (r) => {
        if (r.confirm) {
          const res = await API.updateOrderStatus(this.data.order._id, 'received');
          if (res && res.success) {
            toast('已确认收货', 'success');
            this.loadOrder(this.data.order._id);
          }
        }
      }
    });
  },

  contactService() {
    wx.navigateTo({ url: '/pages/chat/chat' });
  },

  requestRefund() {
    if (!this.data.order) return;
    wx.navigateTo({ url: '/pages/refund/refund?orderId=' + this.data.order._id });
  },

  viewLogistics() {
    if (!this.data.order) return;
    if (this.data.order.logistics && this.data.order.logistics.trackingNo) {
      wx.navigateTo({ url: `/pages/logistics/logistics?orderId=${this.data.order._id}` });
    } else {
      toast('暂无物流信息');
    }
  },

  copyOrderNo() {
    if (!this.data.order) return;
    wx.setClipboardData({
      data: this.data.order.orderNo || '',
      success: () => toast('订单号已复制', 'success')
    });
  },

  retry() {
    // 修复：从 _orderId 或 order._id 取 ID，确保没有已加载订单也能重试
    const id = this._orderId || (this.data.order && this.data.order._id);
    console.log('[order-detail] retry, id:', id);
    if (id) {
      this.setData({ loading: true, loadError: '' });
      this.loadOrder(id);
    } else {
      toast('无法重试：缺少订单ID');
    }
  },

  onShareAppMessage() {
    if (!this.data.order) return {};
    return {
      title: '订单 - ' + (this.data.order.orderNo || ''),
      path: '/pages/order-detail/order-detail?id=' + (this.data.order._id || '')
    };
  }
});
