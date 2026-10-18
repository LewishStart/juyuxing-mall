'use strict';
const crypto = require('crypto');
const field = (o, a, b) => o && (o[a] === undefined ? o[b] : o[a]);
const digest = value => crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 28);
async function reservedRows(tx, orderId) {
  const rows=[];
  while(true) {
    const page=(await tx.collection('inventory_reservations').where({orderId,status:'reserved'}).skip(rows.length).limit(1000).get()).data;
    rows.push(...page);
    if(page.length<1000)return rows;
  }
}
function createPaymentEffects(cloud, db) {
  function transaction(work) { if (typeof db.runTransaction !== 'function') throw new Error('支付处理需要事务支持'); return db.runTransaction(work); }
  async function ledger(tx, name, key, data) {
    const existing = await tx.collection(name).where({ idempotencyKey: key }).get();
    if (existing.data.length) {
      const row=existing.data[0];
      if(row.orderId!==data.orderId||row.type!==data.type||Number(row.amount)!==Number(data.amount)||(row.transactionId&&data.transactionId&&row.transactionId!==data.transactionId))throw new Error('支付账目关联冲突，需核对原交易');
      return false;
    }
    await tx.collection(name).add({ data: { _id: digest(key), ...data, idempotencyKey: key } }); return true;
  }
  return async function confirmPayment(options) {
    return transaction(async tx => {
      const result = options.orderId ? await tx.collection('orders').doc(options.orderId).get()
        : { data: (await tx.collection('orders').where({ orderNo: options.outTradeNo }).limit(1).get()).data[0] };
      const order = result.data;
      if (!order || !['pending','paid','shipped','received','refunding','refunded','closed'].includes(order.status)) throw new Error('订单状态不可支付');
      if (options.totalFee !== null && options.totalFee !== undefined && Number(options.totalFee) !== Number(order.totalFee)) throw new Error('支付金额与订单金额不一致');
      if (options.payerOpenId && order.userId !== options.payerOpenId) throw new Error('付款身份与订单用户不一致');
      if (order.transactionId && options.transactionId && order.transactionId !== options.transactionId) throw new Error('支付交易号冲突');
      if (order.paymentSubMchId && options.subMchId && order.paymentSubMchId !== options.subMchId) throw new Error('支付商户关联冲突');
      if (!options.transactionId && !order.transactionId) throw new Error('缺少支付交易号');
      const exceptional = order.status === 'closed' || order.inventoryStatus === 'released' || order.paymentResolutionRequired === true || (order.status === 'pending' && !['reserved','committed'].includes(order.inventoryStatus));
      if (exceptional && options.source === 'mockPay') throw new Error('已关闭订单不可模拟支付');
      const update = { transactionId: order.transactionId || options.transactionId, paymentSource: order.paymentSource || options.source || 'payment', paymentPhase: 'paid', updateTime: db.serverDate() };
      if (!order.paymentSubMchId && options.subMchId) update.paymentSubMchId = options.subMchId;
      if (order.inventoryStatus === 'reserved' && !exceptional) {
        const reservations = {data: await reservedRows(tx,order._id)};
        if (!reservations.data.length) throw new Error('缺少库存预留记录，需核对原订单');
        for (const reservation of reservations.data) {
          const product = (await tx.collection('products').doc(reservation.productId).get()).data;
          const quantity = Number(reservation.quantity);
          if (!product || !Number.isSafeInteger(quantity) || quantity <= 0 || Number(product.stock) < quantity || Number(product.reservedStock) < quantity) throw new Error('库存预留事实不一致');
          const specs = (product.specs || []).map(item => ({ ...item }));
          const spec = specs.find(item => item.name === reservation.spec);
          if (specs.length && (!spec || Number(spec.stock) < quantity || Number(spec.reservedStock) < quantity)) throw new Error('规格库存预留事实不一致');
          if (spec) { spec.stock -= quantity; spec.reservedStock -= quantity; }
          await tx.collection('products').doc(product._id).update({ data: { stock: Number(product.stock)-quantity, reservedStock: Number(product.reservedStock)-quantity, specs, sales: (Number(product.sales)||0)+quantity, updateTime: db.serverDate() } });
          await tx.collection('inventory_reservations').doc(reservation._id).update({ data: { status:'committed', commitTime:db.serverDate() } });
        }
        update.inventoryStatus = 'committed';
      }
      if (order.status === 'pending' || order.status === 'closed') { update.status='paid'; update.payTime=order.payTime || db.serverDate(); }
      if (exceptional) { update.paymentResolutionRequired=true; update.paymentResolutionReason=order.inventoryStatus === 'released' ? 'inventory_released' : 'inventory_unverified'; update.paymentResolutionMessage='原订单已收款，但库存已释放或需核对。请按原订单申请退款，勿重复支付。'; }
      await ledger(tx,'cashflow_entries','payment:'+order._id,{ type:'sale_receipt',direction:'in',amount:Number(order.totalFee),orderId:order._id,orderNo:order.orderNo,transactionId:update.transactionId,subMchId:order.paymentSubMchId||options.subMchId||'',source:update.paymentSource,status:'posted',createTime:db.serverDate() });
      if (order.agentId && Number(order.commission)>0 && !exceptional) {
        const rows = (await tx.collection('commissions').where({orderId:order._id,type:'earning'}).limit(1).get()).data;
        if (!rows.length && order.status === 'pending') { await ledger(tx,'commissions','commission:'+order._id,{type:'earning',agentId:order.agentId,orderId:order._id,orderNo:order.orderNo,amount:Number(order.commission),rate:Number(order.commissionRate)||0,status:'frozen',createTime:db.serverDate(),settleTime:null,paidTime:null,source:update.paymentSource}); update.commissionStatus='frozen'; }
        else if (rows.length && !['settled','withdrawing','paid'].includes(order.commissionStatus)) update.commissionStatus=rows[0].status;
      }
      await tx.collection('orders').doc(order._id).update({data:update});
      return {orderId:order._id,orderNo:order.orderNo,status:update.status||order.status,paymentResolutionRequired:exceptional};
    });
  };
}

function createPaymentLifecycle(cloud, db) {
  const confirm = createPaymentEffects(cloud, db);
  function transaction(work) { if (typeof db.runTransaction !== 'function') throw new Error('支付处理需要事务支持'); return db.runTransaction(work); }
  const read = async id => (await db.collection('orders').doc(id).get()).data;
  async function pending(id,message) { await db.collection('orders').doc(id).update({data:{paymentCloseError:message,updateTime:db.serverDate()}}); return {success:false,code:'PAYMENT_PENDING',error:message}; }
  async function query(order) {
    if (!order.paymentSubMchId) throw new Error('原支付商户未绑定，请联系商家按原订单核对');
    const q=await cloud.cloudPay.queryOrder({subMchId:order.paymentSubMchId,outTradeNo:order.orderNo,nonceStr:crypto.randomBytes(16).toString('hex')});
    if (field(q,'returnCode','return_code')!=='SUCCESS'||field(q,'resultCode','result_code')!=='SUCCESS') throw new Error('原支付结果未知，请稍后核对原单');
    if (String(field(q,'outTradeNo','out_trade_no')||'')!==order.orderNo||String(field(q,'subMchId','sub_mch_id')||'')!==order.paymentSubMchId) throw new Error('支付查单关联不匹配');
    const state=field(q,'tradeState','trade_state');
    if (state==='SUCCESS') {
      const fee=Number(field(q,'totalFee','total_fee')),tx=String(field(q,'transactionId','transaction_id')||''),payer=String(field(q,'subOpenid','sub_openid')||'');
      if (!Number.isSafeInteger(fee)||fee<=0||fee!==Number(order.totalFee)||!tx||(payer&&payer!==order.userId)||(order.transactionId&&order.transactionId!==tx)) throw new Error('支付成功回执关联不匹配');
      await confirm({orderId:order._id,transactionId:tx,totalFee:fee,payerOpenId:payer,subMchId:order.paymentSubMchId,source:'reconcile'});
    }
    return {state,response:q};
  }
  async function release(id,reason,proofMerchant,localOnly=false) {
    return transaction(async tx=>{
      const order=(await tx.collection('orders').doc(id).get()).data;
      if (!order||order.status!=='pending'||!order.paymentCloseRequested) return false;
      if (localOnly && (order.paymentPhase!=='not_started'||order.prepayId||order.paymentSubMchId)) throw new Error('支付已启动，不可仅本地关单');
      if (!localOnly && order.paymentSubMchId!==proofMerchant) throw new Error('关单商户关联已变化');
      const rs=await reservedRows(tx,id);
      for (const r of rs) {
        const p=(await tx.collection('products').doc(r.productId).get()).data;
        if (!p) throw new Error('库存商品缺失，关单需核对');
        const n=Number(r.quantity),specs=(p.specs||[]).map(s=>({...s})),s=specs.find(x=>x.name===r.spec);
        if(!Number.isSafeInteger(n)||n<=0||Number(p.reservedStock)<n||(specs.length&&(!s||Number(s.reservedStock)<n))) throw new Error('预留库存不一致，不能释放');
        if(s)s.reservedStock-=n;
        await tx.collection('products').doc(p._id).update({data:{reservedStock:Number(p.reservedStock)-n,specs,updateTime:db.serverDate()}});
        await tx.collection('inventory_reservations').doc(r._id).update({data:{status:'released',releaseReason:reason,releaseTime:db.serverDate()}});
      }
      await tx.collection('orders').doc(id).update({data:{status:'closed',inventoryStatus:order.inventoryStatus==='reserved'?'released':order.inventoryStatus,paymentPhase:'closed',paymentCloseError:'',closeReason:reason,closeTime:db.serverDate(),updateTime:db.serverDate()}});return true;
    });
  }
  async function close(id,reason) {
    const order=await transaction(async tx=>{const o=(await tx.collection('orders').doc(id).get()).data;if(!o||o.status!=='pending')return o;await tx.collection('orders').doc(id).update({data:{paymentCloseRequested:true,paymentCloseReason:reason,updateTime:db.serverDate()}});return o;});
    if(!order||order.status!=='pending')return {success:!!(order&&order.status==='closed'),error:'订单状态已变化，请刷新'};
    try {
      if(order.paymentPhase==='not_started'&&!order.prepayId&&!order.paymentSubMchId) return {success:await release(id,reason,'',true)};
      let q=await query(order);
      if(q.state==='SUCCESS')return {success:false,alreadyPaid:true,error:'原订单已支付，请刷新后申请退款'};
      if(q.state==='NOTPAY') {
        const c=await cloud.cloudPay.closeOrder({subMchId:order.paymentSubMchId,outTradeNo:order.orderNo,nonceStr:crypto.randomBytes(16).toString('hex')});
        if(field(c,'returnCode','return_code')!=='SUCCESS'||field(c,'resultCode','result_code')!=='SUCCESS')throw new Error('渠道关单结果未知，请核对原订单');
        q=await query(order);
      }
      if(q.state==='SUCCESS')return {success:false,alreadyPaid:true,error:'原订单已支付，请刷新后申请退款'};
      if(q.state!=='CLOSED')return pending(id,'支付尚未确认关闭，请刷新原订单后重试取消');
      return {success:await release(id,reason,order.paymentSubMchId)};
    } catch(error) {return pending(id,String(error&&error.message||error));}
  }
  async function begin(id,merchant) {
    return transaction(async tx=>{
      const o=(await tx.collection('orders').doc(id).get()).data;
      if(!o||o.status!=='pending'||o.paymentCloseRequested)throw new Error('订单正在关闭或已支付，请刷新原订单');
      if(o.paymentPhase==='creating')throw new Error('支付创建中，请稍后核对原订单');
      if(!o.paymentSubMchId && o.paymentPhase!=='not_started')throw new Error('历史支付商户未知，请联系商家核对原单');
      const subMchId=o.paymentSubMchId||merchant;
      if(!subMchId)throw new Error('支付商户未配置');
      const intent=crypto.randomBytes(16).toString('hex');
      await tx.collection('orders').doc(id).update({data:{paymentPhase:'creating',paymentSubMchId:subMchId,paymentIntentId:intent,paymentIntentTime:db.serverDate(),updateTime:db.serverDate()}});
      return {...o,paymentSubMchId:subMchId,paymentIntentId:intent,paymentPhase:'creating'};
    });
  }
  async function finish(id,intent,prepayId) {
    return transaction(async tx=>{const o=(await tx.collection('orders').doc(id).get()).data;if(!o||o.paymentIntentId!==intent)throw new Error('支付创建关联不匹配');if(o.status!=='pending')return o;await tx.collection('orders').doc(id).update({data:{prepayId:prepayId||'',paymentPhase:'open',updateTime:db.serverDate()}});return {...o,prepayId:prepayId||'',paymentPhase:'open'};});
  }
  async function unknown(id,intent) {await transaction(async tx=>{const o=(await tx.collection('orders').doc(id).get()).data;if(o&&o.status==='pending'&&o.paymentIntentId===intent)await tx.collection('orders').doc(id).update({data:{paymentPhase:'unknown',updateTime:db.serverDate()}});});}
  return {query,close,begin,finish,unknown,read};
}
module.exports = {createPaymentEffects,createPaymentLifecycle};
