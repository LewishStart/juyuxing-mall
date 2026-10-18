Component({
  properties: {
    coupon: { type: Object, value: {} },
    userCoupon: { type: Object, value: null },
    claimed: { type: Boolean, value: false },
    expired: { type: Boolean, value: false },
    used: { type: Boolean, value: false },
    status: { type: String, value: '' },
    loading: { type: Boolean, value: false }
  },
  data: { amount: '', desc: '', minSpendText: '', expiryText: '', cls: 'cc-active' },
  observers: {
    'coupon, userCoupon, claimed, expired, used, status': function (coupon, uc, claimed, expired, used, status) {
      var amount = '';
      var desc = '';
      if (coupon.type === 'percent') {
        amount = '减' + (coupon.value || 0) + '%';
        desc = '全场通用' + amount;
      } else {
        amount = (Number(coupon.value || 0) / 100).toFixed(0);
        desc = '满' + ((coupon.minSpend || 0) / 100).toFixed(0) + '减' + amount;
      }
      var minSpend = '';
      if (coupon.type !== 'percent' && coupon.minSpend > 0) {
        minSpend = '满 ¥' + (coupon.minSpend / 100).toFixed(0) + ' 可用';
      }
      var expiry = '';
      if (coupon.endTime && coupon.endTime < 9999999999999) {
        var d = new Date((coupon.endTime + '').replace(/-/g, '/'));
        if (!isNaN(d.getTime())) {
          expiry = (d.getMonth() + 1) + '.' + d.getDate() + ' 到期';
        }
      }
      var isUsed = used || status === 'used';
      var isExpired = expired || status === 'expired';
      var cls = 'cc-active';
      if (isUsed) cls = 'cc-used';
      else if (isExpired) cls = 'cc-expired';
      else if (claimed) cls = 'cc-claimed';
      this.setData({
        amount: amount,
        desc: desc,
        minSpendText: minSpend,
        expiryText: expiry,
        cls: cls,
        _used: isUsed,
        _expired: isExpired
      });
    }
  },
  methods: {
    onTap() { this.triggerEvent('click', { coupon: this.data.coupon }); },
    onClaim() {
      if (this.data.loading) return;
      this.triggerEvent('claim', { coupon: this.data.coupon });
    }
  }
});
