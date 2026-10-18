const API = require('../../utils/api');
const request = require('../../utils/request');
const { toast, generateOrderNo, decorateList, decorateItem } = require('../../utils/util');

Page({
  data: {
    items: [],
    totalPrice: 0,
    discountAmount: 0,
    finalPrice: 0,
    address: null,
    remark: '',
    submitting: false,
    fromCart: false,
    productId: '',
    selectedCoupon: null,
    availableCoupons: [],
    promotion: { enabled: false, rules: [] },
    fullReduction: 0,
    promotionTip: '',
    loadError: '',
    loading: true
  },

  onLoad(options) {
    this._recoveryPromise = this.recoverPendingSubmission(options);
    if (options.fromCart === '1') {
      // 优先从临时 storage 读取（避免 URL 超长），兼容旧版 URL 传参
      let items = wx.getStorageSync('checkoutItems') || [];
      if (items.length === 0 && options.items) {
        try {
          items = JSON.parse(decodeURIComponent(options.items));
        } catch (e) {
          items = [];
        }
      }
      if (items.length === 0) {
        this.setData({ loading: false, loadError: '结算商品为空，请重新选择' });
        return;
      }
      // 不预先渲染旧价格，避免「先显示 0.01 闪一下」；交给 fetchItemsDetail 按规格价校正后再渲染
      this.fetchItemsDetail(items);
      this.setData({ fromCart: true });
    } else if (options.productId) {
      this.setData({ productId: options.productId });
      this.fetchProductDetail(options.productId, Number(options.quantity) || 1, options.specName || '');
    } else {
      this.setData({ loading: false, loadError: '订单参数缺失' });
    }
    this.loadDefaultAddress();
    this.loadPromotions();
  },

  async loadPromotions() {
    const res = await API.getPromotions();
    if (res && res.success) {
      this.setData({ promotion: res.data || { enabled: false, rules: [] } });
      this.calcTotal();
      // 满减会影响优惠券门槛校验，重新拉取可用券
      this.loadAvailableCoupons();
    }
  },

  // 与服务端 order 云函数口径一致：优先取规格价，规格价缺失时回退商品主价
  resolveSpecPrice(p, specName) {
    const specs = (p && p.specs) || [];
    const spec = specName ? specs.find(s => s && s.name === specName) : null;
    const rawPrice = spec && spec.price !== undefined ? spec.price : p.price;
    const price = Number(rawPrice);
    if (!['number', 'string'].includes(typeof rawPrice) || String(rawPrice).trim() === '' ||
        !Number.isSafeInteger(price) || price <= 0) return 0;
    return price;
  },

  resolvePurchaseItem(product, quantity, specName) {
    if (!product || (product.status && product.status !== 'on')) return null;
    const specs = Array.isArray(product.specs) ? product.specs : [];
    const selected = specName ? specs.find(spec => spec.name === specName) : specs[0];
    if (specs.length && !selected) return null;
    // product API has already projected available stock. Do not subtract reservations again.
    const rootAvailable = Number(product.stock);
    const available = selected ? Math.min(Number(selected.stock), rootAvailable) : rootAvailable;
    if (!Number.isSafeInteger(available) || available <= 0) return null;
    const requested = Number(quantity);
    if (!Number.isSafeInteger(requested) || requested <= 0) return null;
    const price = this.resolveSpecPrice(product, selected && selected.name);
    if (!Number.isSafeInteger(price) || price <= 0) return null;
    return { productId: product._id, name: product.name,
      spec: selected ? selected.name : '', price,
      quantity: Math.min(requested, available), image: (product.images && product.images[0]) || '' };
  },

  async fetchProductDetail(productId, quantity, specName) {
    const res = await API.getProduct(productId);
    const item = res && res.success && this.resolvePurchaseItem(res.data, quantity, specName);
    if (!item) {
      this.setData({ items: [], loading: false, loadError: '商品已下架、价格或规格无效、库存不足' });
      return;
    }
    if (item.quantity !== quantity) toast('库存不足，数量已调整，请核对后提交');
    this.setData({ items: decorateList([item]), loading: false, loadError: '' });
    this.calcTotal();
    this.loadAvailableCoupons();
  },

  async fetchItemsDetail(items) {
    const fixed = [];
    let changed = false;
    for (const item of items) {
      try {
        const res = await API.getProduct(item.productId);
        const current = res && res.success && this.resolvePurchaseItem(res.data, Number(item.quantity), item.spec);
        if (!current) { changed = true; continue; }
        if (current.quantity !== Number(item.quantity)) changed = true;
        fixed.push(current);
      } catch (error) {
        this.setData({ items: [], loading: false, loadError: '商品库存核对失败，请重试' });
        return;
      }
    }
    if (!fixed.length) {
      this.setData({ items: [], loading: false, loadError: '所选商品价格异常、已下架或库存不足' });
      return;
    }
    if (changed) toast('商品或数量已因库存变化调整，请核对后提交');
    this.setData({ items: decorateList(fixed), loading: false, loadError: '' });
    this.calcTotal();
    this.loadAvailableCoupons();
  },

  async loadDefaultAddress() {
    const res = await API.getAddressList();
    const addrList = (res && res.data) || [];
    const def = addrList.find(a => a.isDefault) || addrList[0];
    if (def) this.setData({ address: def });
  },

  async loadAvailableCoupons() {
    const requestId = this._couponRequestId = (this._couponRequestId || 0) + 1;
    const items = this.data.items || [];
    if (items.length === 0) {
      this.setData({ availableCoupons: [], selectedCoupon: null });
      this.calcTotal();
      return;
    }
    // 与服务端口径一致：优惠券门槛按满减后的金额校验
    const amount = Math.max(0, this.data.totalPrice - (this.data.fullReduction || 0));
    let res;
    try { res = await API.getAvailableCoupons({ amount }); } catch (err) { res = null; }
    if (requestId !== this._couponRequestId) return;
    const availableCoupons = (res && res.success && Array.isArray(res.data) ? res.data : [])
      .filter(c => c && c.userCouponId && c.available === true && Number.isSafeInteger(c.discount) && c.discount > 0 && c.discount <= amount)
      .map(c => ({ ...c, label: (c.coupon && c.coupon.name) || '优惠券' }));
    const selectedId = this.data.selectedCoupon && this.data.selectedCoupon.userCouponId;
    this.setData({ availableCoupons, selectedCoupon: availableCoupons.find(c => c.userCouponId === selectedId) || null });
    this.calcTotal();
  },

  computeFullReduction(total) {
    const promotion = this.data.promotion || {};
    if (!promotion.enabled) return { discount: 0, tip: '' };
    const rules = promotion.rules || [];
    let best = 0;
    let bestRule = null;
    let nextRule = null;
    for (const rule of rules) {
      if (total >= rule.threshold && rule.discount > best) { best = rule.discount; bestRule = rule; }
      if (total < rule.threshold && (!nextRule || rule.threshold < nextRule.threshold)) nextRule = rule;
    }
    let tip = '';
    if (bestRule) {
      tip = '已享满' + (bestRule.threshold / 100) + '减' + (best / 100) + '优惠';
    } else if (nextRule) {
      const gap = nextRule.threshold - total;
      tip = '还差¥' + (gap / 100).toFixed(2) + ' 可享满' + (nextRule.threshold / 100) + '减' + (nextRule.discount / 100);
    }
    return { discount: Math.min(best, total), tip };
  },

  calcTotal() {
    const items = this.data.items || [];
    const total = items.reduce((s, it) => s + (Number(it.price) || 0) * (Number(it.quantity) || 1), 0);
    const fr = this.computeFullReduction(total);
    const fullReduction = fr.discount;
    const discount = Number((this.data.selectedCoupon && this.data.selectedCoupon.discount) || 0);
    const finalPrice = Math.max(0, total - fullReduction - discount);
    this.setData({
      totalPrice: total, totalPriceText: (total / 100).toFixed(2),
      fullReduction, fullReductionText: (fullReduction / 100).toFixed(2),
      promotionTip: fr.tip,
      discountAmount: discount, discountAmountText: (discount / 100).toFixed(2),
      finalPrice: finalPrice, finalPriceText: (finalPrice / 100).toFixed(2)
    });
  },

  selectAddress() {
    wx.navigateTo({ url: '/pages/address/address?from=checkout&selectedId=' + (this.data.address && this.data.address._id || '') });
  },

  onRemarkInput(e) {
    this.setData({ remark: e.detail.value });
  },

  pickCoupon() {
    const list = this.data.availableCoupons || [];
    if (list.length === 0) { toast('暂无可用优惠券'); return; }
    wx.showActionSheet({
      itemList: list.map(c => `${c.label}（减¥${(c.discount / 100).toFixed(2)}）`).concat(['不使用优惠券']),
      success: (res) => {
        if (res.tapIndex >= list.length) {
          this.setData({ selectedCoupon: null });
        } else {
          this.setData({ selectedCoupon: list[res.tapIndex] });
        }
        this.calcTotal();
      }
    });
  },

  async submitOrder() {
    if (this._recoveryPromise) await this._recoveryPromise;
    if (this._recoveredOrderId) return;
    if (this.data.submitting) return;
    if (!this.data.address) { toast('请选择收货地址'); return; }
    const items = this.data.items || [];
    if (items.length === 0) { toast('订单商品为空'); return; }

    this.setData({ submitting: true });
    const orderData = {
      items: items.map(it => ({
        productId: it.productId,
        name: it.name,
        spec: it.spec,
        image: it.image || '',
        quantity: it.quantity,
        price: it.price
      })),
      // 告诉服务端只移除这些已结算的商品（productId_spec 组合），保留购物车其余商品
      removeCartKeys: items.map(it => `${it.productId}_${it.spec || ''}`),
      totalFee: this.data.finalPrice,
      address: this.data.address,
      remark: this.data.remark,
      couponId: (this.data.selectedCoupon && this.data.selectedCoupon.userCouponId) || '',
      couponDiscount: this.data.discountAmount,
      fullReductionDiscount: this.data.fullReduction
    };
    try {
      const actor = String(wx.getStorageSync('openId') || '');
      if (!actor) throw new Error('请先登录再提交订单');
      const storageKey = 'checkoutPending:' + actor;
      const stored = wx.getStorageSync(storageKey);
      const pending = stored && Array.isArray(stored.entries) ? stored.entries.slice() : [];
      const fingerprint = JSON.stringify({items:orderData.items.map(item=>({productId:item.productId,spec:item.spec||'',quantity:item.quantity})),address:{name:orderData.address.name,phone:orderData.address.phone,region:orderData.address.region,detail:orderData.address.detail},remark:orderData.remark||'',couponId:orderData.couponId});
      let intent = pending.find(entry => entry.fingerprint === fingerprint && entry.actor === actor);
      if (!intent) {
        const orderNo = generateOrderNo();
        intent = { actor, fingerprint, requestId: orderNo, orderNo, orderData };
        pending.push(intent);
      }
      // Persist before sending. Storage failure must not create an untracked order.
      wx.setStorageSync(storageKey, { entries: pending });
      const res = await API.createOrder({ ...(intent.orderData || orderData), orderNo: intent.orderNo, requestId: intent.requestId });
      if (res && res.success && res.orderId) {
        const latest = wx.getStorageSync(storageKey);
        const entries = latest && Array.isArray(latest.entries) ? latest.entries : pending;
        wx.setStorageSync(storageKey, { entries: entries.filter(entry => entry.requestId !== intent.requestId) });
        if (this.data.fromCart) { try { wx.removeStorageSync('checkoutItems'); } catch (e) {} }
        toast('下单成功', 'success');
        setTimeout(() => wx.redirectTo({url:'/pages/order-detail/order-detail?id='+res.orderId,fail:()=>wx.navigateTo({url:'/pages/order/order'})}),600);
      } else {
        this.retireRejectedIntent(storageKey,actor,intent,res);
        toast((res && res.error) || '提交结果待核对，请沿原提交重试');
        this.setData({ submitting: false });
      }
    } catch (error) {
      toast(error && error.message || '提交结果待核对，请重试');
      this.setData({ submitting: false });
    }
  },

  retireRejectedIntent(storageKey,actor,intent,result) {
    if(!result || result.success!==false || result.code!=='CREATE_REJECTED' || result.creationOutcome!=='rejected' || result.creationOutcomeVersion!==1 || result.requestId!==intent.requestId || result.orderNo!==intent.orderNo)return false;
    const latest=wx.getStorageSync(storageKey);
    if(latest&&Array.isArray(latest.entries))wx.setStorageSync(storageKey,{entries:latest.entries.filter(entry=>!(entry.actor===actor&&entry.requestId===intent.requestId&&entry.orderNo===intent.orderNo&&entry.fingerprint===intent.fingerprint))});
    return true;
  },

  async recoverPendingSubmission(options = {}) {
    try {
      const actor=String(wx.getStorageSync('openId')||'');
      const stored=wx.getStorageSync('checkoutPending:'+actor);
      if(!actor||!stored||!Array.isArray(stored.entries))return;
      for(const intent of stored.entries) {
        if(intent.actor!==actor)continue;
        if(options.productId && (!intent.orderData || intent.orderData.items.length!==1 || intent.orderData.items[0].productId!==options.productId || options.specName && String(intent.orderData.items[0].spec||'')!==String(options.specName) || Number(intent.orderData.items[0].quantity)!==(Number(options.quantity)||1)))continue;
        if(options.fromCart==='1') {
          let basket=wx.getStorageSync('checkoutItems');
          if(!Array.isArray(basket)&&options.items)try{basket=JSON.parse(decodeURIComponent(options.items));}catch(error){basket=[];}
          const key=items=>JSON.stringify((items||[]).map(item=>({productId:item.productId,spec:item.spec||'',quantity:Number(item.quantity)})).sort((a,b)=>(a.productId+'_'+a.spec).localeCompare(b.productId+'_'+b.spec)));
          if(!Array.isArray(basket)||!intent.orderData||key(basket)!==key(intent.orderData.items))continue;
        }
        const res=await API.recoverOrderCreate(intent.requestId,{silent:true});
        if(this.retireRejectedIntent('checkoutPending:'+actor,actor,intent,res))continue;
        if(!res||!res.success||!res.orderId)continue;
        this._recoveredOrderId=res.orderId;
        const latest=wx.getStorageSync('checkoutPending:'+actor);
        if(latest&&Array.isArray(latest.entries))wx.setStorageSync('checkoutPending:'+actor,{entries:latest.entries.filter(entry=>entry.requestId!==intent.requestId)});
        wx.redirectTo({url:'/pages/order-detail/order-detail?id='+res.orderId});
        return;
      }
    } catch(error) { /* preserve unresolved intent for the next explicit retry */ }

  }
});
