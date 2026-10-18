'use strict';

const cloud = require('wx-server-sdk');
cloud.init({ env: 'cloud1-d4gx1jxk675274501' });
const db = cloud.database();
const _ = db.command;
const crypto = require('crypto');
const lifecycle = require('./payment-effects').createPaymentLifecycle(cloud, db);

const ORDER_EXPIRE_MS = 30 * 60 * 1000;
async function reconcilePendingOrders(userId) {
  if (!userId) return;
  const result = await db.collection('orders').where({userId, status: _.in(['pending','closed'])})
    .orderBy('createTime','desc').limit(10).get();
  for (const order of result.data || []) {
    try {
      if (order.status === 'pending' && order.expireTime && new Date(order.expireTime).getTime() <= Date.now()) await lifecycle.close(order._id,'payment_timeout');
      else if (order.paymentSubMchId && order.paymentPhase !== 'not_started') await lifecycle.query(order);
    } catch (error) { console.warn('[order] 原单支付结果待核对', order.orderNo); }
  }
}

function withTransaction(work) {
  if (typeof db.runTransaction !== 'function') throw new Error('订单处理需要事务支持');
  return db.runTransaction(work);
}

function normalizeQuantity(value) {
  const quantity = Number(value);
  return Number.isInteger(quantity) && quantity > 0 ? quantity : 0;
}

function normalizeAddress(address) {
  const normalized = {
    name: String((address && address.name) || '').trim(),
    phone: String((address && address.phone) || '').trim(),
    region: Array.isArray(address && address.region) ? address.region.slice(0, 3).map(item => String(item).slice(0, 30)) : [],
    detail: String((address && address.detail) || '').trim()
  };
  if (!normalized.name || normalized.name.length > 30) throw new Error('收货人姓名无效');
  if (!/^1\d{10}$/.test(normalized.phone)) throw new Error('手机号格式不正确');
  if (!normalized.detail || normalized.detail.length > 200) throw new Error('详细地址无效');
  return normalized;
}

function findSpec(product, specName) {
  const specs = Array.isArray(product.specs) ? product.specs : [];
  if (!specs.length) return null;
  return specs.find(spec => spec.name === specName) || specs[0];
}

function availableStock(product, spec) {
  const stock = Number(spec ? spec.stock : product.stock) || 0;
  const reserved = Number(spec ? spec.reservedStock : product.reservedStock) || 0;
  return Math.min(stock - reserved, (Number(product.stock) || 0) - (Number(product.reservedStock) || 0));
}

async function resolveFullReduction(database, amount) {
  try {
    const cfgRes = await database.collection('admin_config').doc('admin').get().catch(() => null);
    const cfg = (cfgRes && cfgRes.data) || {};
    const fr = cfg.fullReduction;
    if (!fr || fr.enabled !== true) return 0;
    const rules = Array.isArray(fr.rules) ? fr.rules : [];
    let best = 0;
    for (const rule of rules) {
      const threshold = Number(rule && rule.threshold) || 0;
      const discount = Number(rule && rule.discount) || 0;
      if (threshold > 0 && discount > 0 && amount >= threshold && discount > best) best = discount;
    }
    return Math.min(best, amount);
  } catch (e) {
    return 0;
  }
}

async function resolveCouponDiscount(database, userCouponId, userId, amount) {
  if (!userCouponId) return 0;
  const userCouponRes = await database.collection('user_coupons').doc(userCouponId).get().catch(() => null);
  const userCoupon = userCouponRes && userCouponRes.data;
  if (!userCoupon || userCoupon.userId !== userId) throw new Error('优惠券不存在或无权使用');
  if (userCoupon.status !== 'unused') throw new Error('优惠券已使用或已失效');
  const couponRes = await database.collection('coupons').doc(userCoupon.couponId).get().catch(() => null);
  const coupon = couponRes && couponRes.data;
  if (!coupon || coupon.status === 'off') throw new Error('优惠券已下架');
  const now = Date.now();
  if ((coupon.startTime && Number(coupon.startTime) > now) ||
      (coupon.endTime && Number(coupon.endTime) < now)) throw new Error('优惠券不在有效期内');
  if (amount < (Number(coupon.minSpend) || 0)) throw new Error('订单金额未达到优惠券使用门槛');
  if (coupon.type === 'amount') return Math.min(Math.max(0, Number(coupon.value) || 0), amount);
  if (coupon.type === 'percent') {
    return Math.min(Math.floor(amount * Math.max(0, Number(coupon.value) || 0) / 100), amount);
  }
  throw new Error('优惠券类型无效');
}

function reserveProduct(product, specName, quantity) {
  const specs = Array.isArray(product.specs) ? product.specs.map(spec => ({ ...spec })) : [];
  const specIndex = specs.findIndex(spec => spec.name === specName);
  if (specIndex >= 0) {
    specs[specIndex].reservedStock = (Number(specs[specIndex].reservedStock) || 0) + quantity;
  }
  return {
    specs,
    reservedStock: (Number(product.reservedStock) || 0) + quantity
  };
}

async function getCommissionRate(database = db) {
  try {
    const payRes = await database.collection('pay_config').doc('default').get().catch(() => null);
    if (payRes && payRes.data && typeof payRes.data.commissionRate === 'number') return payRes.data.commissionRate;
    const adminRes = await database.collection('admin_config').doc('admin').get().catch(() => null);
    const cfg = (adminRes && adminRes.data) || {};
    return typeof cfg.commissionRate === 'number' ? cfg.commissionRate : 0.33;
  } catch (e) {
    return 0.33;
  }
}

async function resolveActiveAgentId(referrerId, buyerOpenId, database = db) {
  const candidate = String(referrerId || '').trim();
  if (!candidate || candidate === buyerOpenId) return '';
  const agentRes = await database.collection('users').doc(candidate).get().catch(() => null);
  const agent = agentRes && agentRes.data;
  return agent && agent.isAgent && agent.agentInfo && agent.agentInfo.status === 'active' ? candidate : '';
}

async function settleCommission(orderId) {
  return withTransaction(async transaction => {
    const orderRes = await transaction.collection('orders').doc(orderId).get().catch(() => null);
    const order = orderRes && orderRes.data;
    if (!order || order.status !== 'shipped') return { success: false, error: '当前订单状态不可确认收货' };
    if (order.agentId) {
      await transaction.collection('commissions').where({ orderId, status: 'frozen' }).update({
        data: { status: 'settled', settleTime: db.serverDate(), settleSource: 'customer_receive' }
      });
    }
    await transaction.collection('orders').doc(orderId).update({ data: {
      status: 'received', receivedTime: db.serverDate(),
      commissionStatus: order.agentId ? 'settled' : 'none', updateTime: db.serverDate()
    } });
    return { success: true };
  });
}

exports.main = async (event) => {
  const ctx = cloud.getWXContext();
  const OPENID = ctx.OPENID || '';
  if (!OPENID) return { success: false, error: '缺少可信微信身份，请从小程序重新登录' };
  try {
    switch (event.action) {
      case 'create': {
        const { orderNo, items, totalFee, address, remark } = event;
        if (!Array.isArray(items) || items.length === 0) return { success: false, error: '订单商品为空' };
        if (!/^JY\d{14}[A-Z0-9]{6}$/.test(String(orderNo || ''))) {
          return { success: false, error: '订单号格式无效，请重试' };
        }
        const safeAddress = normalizeAddress(address);
        const requestId = String(event.requestId || orderNo);
        if (!/^[A-Za-z0-9_-]{8,100}$/.test(requestId)) throw new Error('提交标识无效');
        const requestDocId = crypto.createHash('sha256').update(requestId).digest('hex').slice(0,32);
        const orderDocId = crypto.createHash('sha256').update('order:'+orderNo).digest('hex').slice(0,32);
        const createPayload = JSON.stringify({orderNo, items:items.map(item=>({productId:String(item.productId||''),spec:String(item.spec||''),quantity:Number(item.quantity)})),address:safeAddress,remark:String(remark||'').slice(0,200),couponId:String(event.couponId||''),totalFee:event.totalFee===undefined?null:event.totalFee,couponDiscount:event.couponDiscount===undefined?null:event.couponDiscount,fullReductionDiscount:event.fullReductionDiscount===undefined?null:event.fullReductionDiscount,removeCartKeys:(event.removeCartKeys||[]).map(String).sort()});

        const userRes = await db.collection('users').doc(OPENID).get().catch(() => null);
        const user = (userRes && userRes.data) || {};
        const agentId = await resolveActiveAgentId(user.referrer, OPENID);
        const commissionRate = await getCommissionRate();
        const result = await withTransaction(async transaction => {
          const existingRequest = (await transaction.collection('order_create_requests').where({_id:requestDocId}).limit(1).get()).data[0];
          if (existingRequest) {
            if (existingRequest.requestId !== requestId || existingRequest.userId !== OPENID || existingRequest.createPayload !== createPayload) throw new Error('IDEMPOTENCY_CONFLICT: 提交标识与用户或内容不一致');
            if (existingRequest.outcome === 'rejected') return {...existingRequest.result};
            const existingOrder = (await transaction.collection('orders').doc(existingRequest.result.orderId).get()).data;
            if (!existingOrder || existingOrder.userId !== OPENID || existingOrder.orderNo !== orderNo) throw new Error('提交记录与原订单不一致，需核对');
            return {...existingRequest.result, duplicate:true};
          }
          const duplicate = await transaction.collection('orders').where({orderNo}).limit(1).get();
          if (duplicate.data.length) throw new Error('IDEMPOTENCY_CONFLICT: 订单号已绑定其他提交');
          // A terminal refusal competes for the same unique request anchor as
          // creation. No delayed identical request can commit after this refusal.
          async function rejectCreate(error) {
            const response={success:false,code:'CREATE_REJECTED',creationOutcome:'rejected',creationOutcomeVersion:1,requestId,orderNo,error};
            await transaction.collection('order_create_requests').add({data:{_id:requestDocId,requestId,userId:OPENID,createPayload,orderNo,outcome:'rejected',result:response,createTime:db.serverDate()}});
            return response;
          }
          let calculatedTotal = 0;
          const enrichedItems = [];
          const productUpdates = [];
          for (const item of items) {
            const quantity = normalizeQuantity(item.quantity);
            if (!item.productId || !quantity) throw new Error('商品参数无效');
            const productRes = await transaction.collection('products').doc(item.productId).get().catch(() => null);
            const product = productRes && productRes.data;
            if (!product || product.status !== 'on') throw new Error('商品不存在或已下架');
            if (item.spec && Array.isArray(product.specs) && product.specs.length &&
                !product.specs.some(spec => spec.name === item.spec)) throw new Error('商品规格不存在: ' + product.name);
            const spec = findSpec(product, item.spec || '');
            const specName = spec ? spec.name : '';
            if (availableStock(product, spec) < quantity) throw new Error('库存不足: ' + product.name);
            const rawPrice = spec && spec.price !== undefined ? spec.price : product.price;
            const unitPrice = Number(rawPrice);
            if (!['number', 'string'].includes(typeof rawPrice) || String(rawPrice).trim() === '' ||
                !Number.isSafeInteger(unitPrice) || unitPrice <= 0) throw new Error('商品价格无效，请联系商家');
            calculatedTotal += unitPrice * quantity;
            if (!Number.isSafeInteger(calculatedTotal)) throw new Error('订单金额超出范围');
            enrichedItems.push({
              productId: product._id, name: product.name, spec: specName,
              image: (product.images && product.images[0]) || '', quantity, price: unitPrice
            });
            productUpdates.push({ product, specName, quantity });
          }

          const fullReductionDiscount = await resolveFullReduction(transaction, calculatedTotal);
          if (event.fullReductionDiscount !== undefined && Number(event.fullReductionDiscount) !== fullReductionDiscount) {
            return rejectCreate('优惠信息已变化，请刷新后重试');
          }
          const couponDiscount = await resolveCouponDiscount(transaction, event.couponId || '', OPENID, calculatedTotal - fullReductionDiscount);
          if (event.couponDiscount !== undefined && Number(event.couponDiscount) !== couponDiscount) {
            return rejectCreate('优惠信息已变化，请刷新后重试');
          }
          const actualTotalFee = calculatedTotal - couponDiscount - fullReductionDiscount;
          if (!Number.isInteger(actualTotalFee) || actualTotalFee < 1) {
            throw new Error('应付金额必须至少为0.01元');
          }
          // 安全设计：以服务端计算的金额为准，忽略客户端传的 totalFee，
          // 避免多规格不同价商品在客户端算错金额时下不了单。
          // 客户端传的金额仅用于比对告警（不再作为下单硬性条件）。
          if (typeof totalFee === 'number' && Number(totalFee) !== actualTotalFee) {
            console.warn('[order] 客户端金额与服务端不一致, 已采用服务端金额:', {
              orderNo, clientTotal: totalFee, serverTotal: actualTotalFee
            });
          }
          for (const update of productUpdates) {
            const latestRes = await transaction.collection('products').doc(update.product._id).get();
            const latestSpec = findSpec(latestRes.data, update.specName);
            if (availableStock(latestRes.data, latestSpec) < update.quantity) throw new Error('库存不足: ' + update.product.name);
            const next = reserveProduct(latestRes.data, update.specName, update.quantity);
            await transaction.collection('products').doc(update.product._id).update({
              data: { ...next, updateTime: db.serverDate() }
            });
          }

          const expireTime = new Date(Date.now() + ORDER_EXPIRE_MS);
          const orderResult = await transaction.collection('orders').add({ data: {
            _id: orderDocId, requestId, createPayload, paymentPhase: 'not_started', paymentCloseRequested: false,
            orderNo, userId: OPENID, items: enrichedItems, totalFee: actualTotalFee,
            originalTotalFee: calculatedTotal, couponDiscount, couponId: event.couponId || '',
            fullReductionDiscount,
            status: 'pending', inventoryStatus: 'reserved', address: safeAddress, agentId,
            commission: agentId ? Math.round(actualTotalFee * commissionRate) : 0,
            commissionRate: agentId ? commissionRate : 0,
            commissionStatus: agentId ? 'pending' : 'none', remark: String(remark || '').slice(0, 200),
            createTime: db.serverDate(), expireTime, payTime: null, updateTime: db.serverDate()
          } });
          for (const [reservationIndex, update] of productUpdates.entries()) {
            await transaction.collection('inventory_reservations').add({ data: {
              idempotencyKey: `reservation:${orderNo}:${reservationIndex}`,
              orderId: orderResult._id, orderNo, productId: update.product._id,
              spec: update.specName, quantity: update.quantity, status: 'reserved',
              expireTime, createTime: db.serverDate()
            } });
          }
          if (event.couponId) {
            await transaction.collection('user_coupons').doc(event.couponId).update({ data: {
              status: 'used', useTime: db.serverDate(), orderId: orderResult._id, updateTime: db.serverDate()
            } });
          }
          const response = {orderId:orderResult._id,actualTotalFee,calculatedTotal,couponDiscount,fullReductionDiscount};
          await transaction.collection('order_create_requests').add({data:{_id:requestDocId,requestId,userId:OPENID,createPayload,orderNo,outcome:'created',result:response,createTime:db.serverDate()}});
          return response;
        });

        if (result.creationOutcome === 'rejected') return result;
        try {
          const cartRes = await db.collection('cart').where({ userId: OPENID }).get();
          if (cartRes.data.length > 0) {
            const cart = cartRes.data[0];
            const removeKeys = (event.removeCartKeys || []).map(String);
            const remaining = (cart.items || []).filter(item => !removeKeys.includes(`${item.productId}_${item.spec || ''}`));
            await db.collection('cart').doc(cart._id).update({ data: { items: remaining, updateTime: db.serverDate() } });
          }
        } catch (e) {}
        return { success: true, orderId: result.orderId, totalFee: result.actualTotalFee,
          originalTotalFee: result.calculatedTotal, couponDiscount: result.couponDiscount,
          fullReductionDiscount: result.fullReductionDiscount };
      }

      case 'recoverCreate': {
        const requestId=String(event.requestId||'');
        if(!/^[A-Za-z0-9_-]{8,100}$/.test(requestId))return {success:false,error:'提交标识无效'};
        const id=crypto.createHash('sha256').update(requestId).digest('hex').slice(0,32);
        const row=(await db.collection('order_create_requests').where({_id:id}).limit(1).get()).data[0];
        if(!row||row.requestId!==requestId||row.userId!==OPENID)return {success:false,code:'CREATE_NOT_FOUND',error:'未找到本人的已提交订单，请沿原提交重试'};
        if(row.outcome==='rejected')return {...row.result,recovered:true};
        const order=(await db.collection('orders').doc(row.result.orderId).get()).data;
        if(!order||order.userId!==OPENID||order.orderNo!==row.orderNo)return {success:false,error:'原订单需核对'};
        return {success:true,orderId:order._id,totalFee:order.totalFee,recovered:true};
      }
      case 'list': {
        const pageSize = Math.min(Number(event.pageSize) || 20, 50);
        const page = Math.max(Number(event.page) || 1, 1);
        const query = { userId: OPENID };
        if (event.status) query.status = event.status;
        const countRes = await db.collection('orders').where(query).count().catch(() => ({ total: 0 }));
        const res = await db.collection('orders').where(query).orderBy('createTime', 'desc')
          .skip((page - 1) * pageSize).limit(pageSize).get();
        return { success: true, data: res.data, total: countRes.total || 0 };
      }

      case 'counts': {
        await reconcilePendingOrders(OPENID);
        const statuses = ['pending', 'paid', 'shipped', 'refunding'];
        const data = { pending: 0, paid: 0, shipped: 0, refunding: 0 };
        await Promise.all(statuses.map(async status => {
          const res = await db.collection('orders').where({ userId: OPENID, status }).count().catch(() => ({ total: 0 }));
          data[status] = res.total || 0;
        }));
        return { success: true, data };
      }

      case 'detail': {
        if (!event.id) return { success: false, error: '缺少订单ID' };
        const res = await db.collection('orders').doc(event.id).get().catch(() => null);
        if (!res || !res.data || res.data.userId !== OPENID) return { success: false, error: '订单不存在或无权限' };
        if (res.data.paymentSubMchId && ['pending','closed'].includes(res.data.status)) {
          try { await lifecycle.query(res.data); } catch (error) { /* keep original state, expose pending check */ }
        }
        return { success: true, data: (await db.collection('orders').doc(event.id).get()).data };
      }

      case 'updateStatus': {
        if (event.status !== 'received') return { success: false, error: '不允许的状态变更' };
        const orderRes = await db.collection('orders').doc(event.id).get().catch(() => null);
        const order = orderRes && orderRes.data;
        if (!order || order.userId !== OPENID) return { success: false, error: '订单不存在或无权限' };
        return settleCommission(event.id);
      }

      case 'requestRefund': {
        if (!event.reason) return { success: false, error: '请选择退款原因' };
        return withTransaction(async transaction => {
          const orderRes = await transaction.collection('orders').doc(event.id).get().catch(() => null);
          const order = orderRes && orderRes.data;
          if (!order || order.userId !== OPENID) return { success: false, error: '订单不存在或无权限' };
          if (order.status === 'refunding' && order.refundId) {
            return { success: true, refundId: order.refundId, duplicate: true };
          }
          if (!['paid', 'shipped', 'received'].includes(order.status)) {
            return { success: false, error: '当前订单状态不支持售后' };
          }
          const exist = await transaction.collection('refunds')
            .where({ orderId: order._id, status: 'pending' })
            .limit(1)
            .get();
          if (exist.data && exist.data[0]) {
            return { success: true, refundId: exist.data[0]._id, duplicate: true };
          }
          const refundType = order.status === 'paid' ? 'refund_only' : 'return_refund';
          const refundAttempt = (Number(order.refundAttempt) || 0) + 1;
          const refundResult = await transaction.collection('refunds').add({ data: {
            idempotencyKey: `refund_request:${order._id}:${refundAttempt}`,
            orderId: order._id, orderNo: order.orderNo, userId: OPENID, prevStatus: order.status, subMchId: order.paymentSubMchId || '',
            type: refundType, reason: String(event.reason).slice(0, 100),
            description: String(event.description || '').slice(0, 1000),
            images: Array.isArray(event.images) ? event.images.slice(0, 6) : [], status: 'pending',
            returnStatus: refundType === 'return_refund' ? 'awaiting_return' : 'not_required',
            restock: false, adminNote: '', createTime: db.serverDate(), processTime: null
          } });
          await transaction.collection('orders').doc(order._id).update({ data: {
            status: 'refunding', refundId: refundResult._id, refundAttempt, updateTime: db.serverDate()
          } });
          return { success: true, refundId: refundResult._id, refundType };
        });
      }

      case 'refundDetail': {
        if (!event.id) return { success: false, error: '缺少售后ID' };
        const res = await db.collection('refunds').doc(event.id).get().catch(() => null);
        if (!res || !res.data || res.data.userId !== OPENID) return { success: false, error: '售后记录不存在或无权限' };
        return { success: true, data: res.data };
      }

      case 'myRefunds': {
        const pageSize = Math.min(Number(event.pageSize) || 20, 50);
        const page = Math.max(Number(event.page) || 1, 1);
        const query = { userId: OPENID };
        const countRes = await db.collection('refunds').where(query).count().catch(() => ({ total: 0 }));
        const res = await db.collection('refunds').where(query).orderBy('createTime', 'desc')
          .skip((page - 1) * pageSize).limit(pageSize).get();
        return { success: true, data: res.data, total: countRes.total || 0 };
      }

      case 'cancel': {
        const orderRes = await db.collection('orders').doc(event.id).get().catch(() => null);
        const order = orderRes && orderRes.data;
        if (!order || order.userId !== OPENID) return { success: false, error: '订单不存在或无权限' };
        if (order.status !== 'pending') return { success: false, error: '当前订单状态不可取消' };
        return lifecycle.close(order._id, 'customer_cancel');
      }

      default:
        return { success: false, error: 'unknown action' };
    }
  } catch (err) {
    console.error('[order] 运行时错误:', err);
    return { success: false, error: (err && err.message) || '订单处理失败' };
  }
};
