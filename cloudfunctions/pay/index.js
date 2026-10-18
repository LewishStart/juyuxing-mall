'use strict';
const cloud = require('wx-server-sdk');
const crypto = require('crypto');
const ENV_ID = 'cloud1-d4gx1jxk675274501';
cloud.init({env:ENV_ID});
const db=cloud.database();
const {createPaymentEffects,createPaymentLifecycle}=require('./payment-effects');
const confirm=createPaymentEffects(cloud,db),lifecycle=createPaymentLifecycle(cloud,db);
const field=(o,a,b)=>o&&(o[a]===undefined?o[b]:o[a]);
exports.main=async(event={})=>{
  const userId=cloud.getWXContext().OPENID||'';
  if(!userId)return {success:false,error:'缺少可信微信身份，请重新登录'};
  if(event.action!=='request')return {success:false,error:'unknown action'};
  let attempt;
  try {
    let order=(await db.collection('orders').doc(event.orderId||'').get()).data;
    if(!order||order.userId!==userId)return {success:false,error:'订单不存在或无权操作'};
    const paid=()=>({success:true,alreadyPaid:true,reconciled:true,mock:order.paymentSource==='mockPay',orderId:order._id,paymentResolutionRequired:!!order.paymentResolutionRequired});
    if(['paid','shipped','received','refunding','refunded'].includes(order.status))return paid();
    if(order.status==='closed'&&order.paymentSubMchId) {await lifecycle.query(order);order=await lifecycle.read(order._id);if(order.status==='paid')return paid();}
    if(order.status!=='pending')return {success:false,error:'当前订单状态不可支付'};
    if(order.paymentCloseRequested) {await lifecycle.close(order._id,order.paymentCloseReason||'customer_cancel');order=await lifecycle.read(order._id);return order.status==='paid'?paid():{success:false,code:'PAYMENT_CLOSING',error:'原订单关单核对中，请刷新或重试取消'};}
    const cfg=(await db.collection('pay_config').doc('default').get()).data||{};
    const mock=cfg.useMockPay===true&&process.env.ALLOW_MOCK_PAY==='true';
    if(cfg.useMockPay===true&&!mock)return {success:false,error:'模拟支付未获服务器授权'};
    if(mock) {
      if(order.paymentPhase!=='not_started')return {success:false,error:'原订单已启动渠道支付，不可切换模拟支付'};
      attempt=await lifecycle.begin(order._id,'mock');
      await confirm({orderId:order._id,transactionId:'MOCK_TXN_'+order.orderNo,totalFee:order.totalFee,subMchId:'mock',source:'mockPay'});
      return {success:true,mock:true,orderId:order._id};
    }
    if(order.paymentPhase!=='not_started') {
      const q=await lifecycle.query(order);
      if(q.state==='SUCCESS') {order=await lifecycle.read(order._id);return paid();}
      if(q.state==='CLOSED') {await lifecycle.close(order._id,'channel_closed');return {success:false,error:'原支付单已关闭，请刷新订单'};}
      if(q.state!=='NOTPAY')return {success:false,code:'PAYMENT_PENDING',error:'原支付结果待核对，请稍后刷新，勿重复支付'};
    }
    attempt=await lifecycle.begin(order._id,String(cfg.subMchId||'').trim());
    const result=await cloud.cloudPay.unifiedOrder({body:'林元元 - '+order.items.map(i=>i.name).join(', '),outTradeNo:order.orderNo,spbillCreateIp:'127.0.0.1',subMchId:attempt.paymentSubMchId,totalFee:order.totalFee,envId:ENV_ID,functionName:'payNotify',nonceStr:crypto.randomBytes(16).toString('hex'),tradeType:'JSAPI',openId:userId});
    if(field(result,'returnCode','return_code')!=='SUCCESS'||field(result,'resultCode','result_code')!=='SUCCESS')throw new Error('渠道创建结果未确认，请核对原订单');
    const payment=result.payment||{timeStamp:result.timeStamp,nonceStr:result.nonceStr,package:result.package||('prepay_id='+(result.prepayId||'')),signType:result.signType||'MD5',paySign:result.paySign};
    const prepayId=result.prepayId||String(payment.package||'').replace(/^prepay_id=/,'');
    const latest=await lifecycle.finish(order._id,attempt.paymentIntentId,prepayId);
    if(latest.status!=='pending') {order=latest;return ['paid','shipped','received'].includes(latest.status)?paid():{success:false,error:'原订单已关闭，请刷新'};}
    if(latest.paymentCloseRequested) {const closed=await lifecycle.close(order._id,latest.paymentCloseReason||'customer_cancel');return {success:false,code:'PAYMENT_CLOSING',error:closed.success?'原订单已取消，请刷新':'原订单取消核对中，请刷新后重试取消'};}
    if(!payment.paySign||!prepayId)return {success:false,error:'支付参数不完整，请联系商家核对原订单'};
    return {success:true,payment,orderId:order._id};
  } catch(error) {
    if(attempt)try{await lifecycle.unknown(attempt._id,attempt.paymentIntentId);}catch(recordError){console.warn('[pay] intent result remains unknown');}
    return {success:false,code:'PAYMENT_PENDING',error:String(error&&error.message||'支付结果待核对，请刷新原订单')};
  }
};
