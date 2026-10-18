'use strict';
const assert = require('assert/strict');
const fs = require('fs'); const path = require('path'); const vm = require('vm');
const { createHarness } = require('../lib/prelaunch-remediation-fixture');
const cases=[]; const test=(id,issue,run)=>cases.push({id,issue,run});
function setup() { const h=createHarness(); h.tables().orders=[]; h.tables().commissions=[]; h.tables().inventory_reservations=[]; h.tables().coupons=[]; h.tables().user_coupons=[]; return h; }
function product(h,overrides={}) {const p={_id:'p',name:'Synthetic product',status:'on',price:10000,originalPrice:12000,stock:51,reservedStock:0,sales:0,images:[],specs:[{name:'A',price:10000,stock:1,reservedStock:0},{name:'B',price:15000,stock:50,reservedStock:0}],...overrides};h.tables().products.push(p);return p;}
const address={name:'Synthetic buyer',phone:'13800000000',region:['P','C','D'],detail:'Synthetic road'};
let sequence=100000;
const create=(h,p,spec='B',quantity=1)=>h.call('order',{action:'create',orderNo:'JY20261018120000'+String(++sequence),items:[{productId:p._id,spec,quantity}],address},'test-buyer');
function web(h,storage={}) {let definition;const calls=[],prompts=[];const w={calls,storage,prompts,loseNextAdjustment:false};
 vm.runInNewContext(fs.readFileSync(path.join(h.root,'admin-web/app.js'),'utf8'),{Vue:{createApp:a=>{definition=a;return{mount(){}};},ref:value=>({value}),reactive:value=>value,computed:fn=>({get value(){return fn();}}),onMounted(){},onBeforeUnmount(){},nextTick:fn=>{if(fn)fn();return Promise.resolve();},watch(){}},window:{cloudbase:{init:()=>({auth:()=>({}),callFunction:async req=>{calls.push(structuredClone(req.data));const result=await h.call(req.name,req.data);if(req.data.action==='adjustInventory'&&w.loseNextAdjustment){w.loseNextAdjustment=false;throw Error('synthetic response loss');}return{result};}})}},localStorage:{getItem:k=>storage[k]||null,setItem:(k,v)=>{storage[k]=v;},removeItem:k=>{delete storage[k];}},navigator:{clipboard:{writeText:async()=>{}}},document:{},console:{log(){},warn(){},error(){}},Date,Math,setTimeout:()=>1,clearTimeout(){},setInterval:()=>1,clearInterval(){},prompt:()=>prompts.shift(),confirm:()=>true},{filename:'admin-web/app.js'});w.app=definition.setup();return w; }
function checkout(h) {let definition;const cache=new Map(),toasts=[];const storage=new Map([['openId','test-buyer']]);const wx={getStorageSync:key=>storage.has(key)?storage.get(key):'',setStorageSync:(key,value)=>storage.set(key,structuredClone(value)),removeStorageSync:key=>storage.delete(key),showToast:o=>toasts.push(o.title),cloud:{callFunction:async req=>({result:await h.call(req.name,req.data,'test-buyer')})}};
 function load(file){const filename=path.resolve(h.root,file);if(cache.has(filename))return cache.get(filename).exports;const mod={exports:{}};cache.set(filename,mod);const req=name=>load(path.relative(h.root,path.resolve(path.dirname(filename),name+(path.extname(name)?'':'.js'))));vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module:mod,exports:mod.exports,require:req,Page:o=>{definition=o;},wx,console,setTimeout:()=>1,clearTimeout(){},setInterval:()=>1,clearInterval(){},getApp:()=>({globalData:{cloudReady:true}})},{filename});return mod.exports;}
 load('miniprogram/pages/checkout/checkout.js');const p=definition;p.data=structuredClone(p.data);p.setData=patch=>Object.assign(p.data,patch);return{page:p,toasts,api:load('miniprogram/utils/api.js')}; }
test('E-selected-second-SKU-stock-is-not-truncated','R1-005',async()=>{const h=setup();product(h);const {page}=checkout(h);await page.fetchItemsDetail([{productId:'p',spec:'B',quantity:5}]);assert.equal(page.data.items[0].quantity,5);assert.equal(page.data.items[0].price,15000);});
test('E-selected-SKU-zero-rejected-and-adjustment-visible','R1-005',async()=>{const h=setup();const p=product(h);p.specs[1].stock=0;let c=checkout(h);await c.page.fetchItemsDetail([{productId:'p',spec:'B',quantity:5}]);assert.equal(c.page.data.items.length,0);assert.ok(c.page.data.loadError);p.specs[1].stock=3;c=checkout(h);await c.page.fetchItemsDetail([{productId:'p',spec:'B',quantity:5}]);assert.equal(c.page.data.items[0].quantity,3);assert.ok(c.toasts.length>0);});
test('E-product-public-available-stock-not-subtracted-twice','R1-005',async()=>{const h=setup();const p=product(h);p.reservedStock=2;p.specs[1].reservedStock=2;p.specs[1].stock=7;const c=checkout(h);await c.page.fetchProductDetail('p',5,'B');assert.equal(c.page.data.items[0].quantity,5);});
test('E-Web-yuan-to-fen-through-real-order','R4-C01',async()=>{const h=setup(),w=web(h);w.app.openProductModal();Object.assign(w.app.productModal.data,{name:'Synthetic',price:'100',originalPrice:'120',stock:5});await w.app.saveProduct();const p=h.tables().products[0];assert.equal(p.price,10000);const r=await create(h,p,'',1);assert.equal(r.success,true);assert.equal(r.totalFee,10000);});
test('E-Web-edit-existing-price-and-independent-SKU','R4-C01',async()=>{const h=setup();const p=product(h);const w=web(h);w.app.openProductModal(p);assert.equal(Number(w.app.productModal.data.price),100);w.app.productModal.data.price='120';await w.app.saveProduct();assert.equal(h.tables().products[0].price,12000);assert.equal(h.tables().products[0].specs[1].price,15000);assert.equal(p.price,12000);});
test('E-Web-cent-and-invalid-decimal-inputs','R4-C01',async()=>{for(const price of ['0.001','-1','NaN','Infinity','1e4','9007199254740992']){const h=setup(),w=web(h);w.app.openProductModal();Object.assign(w.app.productModal.data,{name:'Synthetic',price,stock:1});await w.app.saveProduct();assert.equal(h.tables().products.length,0,price);}const h=setup(),w=web(h);w.app.openProductModal();Object.assign(w.app.productModal.data,{name:'Cent',price:'0.01',stock:1});await w.app.saveProduct();assert.equal(h.tables().products[0].price,1);});
test('E-server-rejects-noninteger-fen-and-invalid-SKU-price','R4-C01',async()=>{const h=setup();const r=await h.call('admin',{action:'createProduct',name:'Synthetic',price:1.2,stock:1});assert.equal(r.success,false);assert.equal(h.tables().products.length,0);product(h);const u=await h.call('admin',{action:'updateProduct',id:'p',specs:[{name:'A',stock:1,price:-1},{name:'B',stock:50,price:15000}]});assert.equal(u.success,false);});
const adjust=(h,extra={})=>h.call('admin',{action:'adjustInventory',productId:'p',spec:'B',quantity:2,reason:'Synthetic count',requestId:'synthetic-adjust-0001',...extra});
test('E-inventory-journal-failure-rolls-back','R4-S06',async()=>{const h=setup();product(h);h.failWrite='inventory_adjustments';const r=await adjust(h);assert.equal(r.success,false);assert.equal(h.tables().products[0].stock,51);assert.equal(h.tables().products[0].specs[1].stock,50);h.failWrite='';assert.equal((await adjust(h)).success,true);assert.equal(h.tables().products[0].stock,53);});
test('E-inventory-idempotency-payload-and-actor-binding','R4-S06',async()=>{const h=setup();product(h);assert.equal((await adjust(h)).success,true);assert.equal((await adjust(h)).success,true);assert.equal(h.tables().products[0].stock,53);assert.equal(h.tables().inventory_adjustments.length,1);assert.equal((await adjust(h,{quantity:3})).success,false);h.tables().admin_accounts.push({_id:'other',wechatOpenId:'other-owner',status:'active',role:'owner'});const r=await h.call('admin',{action:'adjustInventory',productId:'p',spec:'B',quantity:2,reason:'Synthetic count',requestId:'synthetic-adjust-0001'},'other-owner');assert.equal(r.success,false);});
test('E-Web-response-loss-reload-reuses-operation-key','R4-S06',async()=>{const h=setup();const p=product(h);const storage={adminAccount:JSON.stringify({accountId:'owner',role:'owner'})};let w=web(h,storage);w.prompts.push('B','2','Synthetic count');w.loseNextAdjustment=true;await w.app.adjustInventory(p);const first=w.calls.find(x=>x.action==='adjustInventory');w=web(h,storage);w.prompts.push('B','2','Synthetic count');await w.app.adjustInventory(h.tables().products[0]);const second=w.calls.find(x=>x.action==='adjustInventory');assert.ok(first, 'normal inventory dialog must reach handler');assert.ok(second);assert.ok(first.requestId);assert.equal(first.requestId,second.requestId);assert.equal(h.tables().products[0].stock,53);assert.equal(h.tables().inventory_adjustments.length,1);});
test('E-ambiguous-multi-SKU-total-edit-rejected','R4-C02',async()=>{const h=setup();product(h);const r=await h.call('admin',{action:'updateProduct',id:'p',stock:0});assert.equal(r.success,false);assert.equal(h.tables().products[0].stock,51);assert.equal((await adjust(h,{spec:'',quantity:-51})).success,false);});
test('E-single-SKU-Web-zero-stock-prevents-order','R4-C02',async()=>{const h=setup();const p=product(h,{stock:5,specs:[{name:'A',stock:5,reservedStock:0}]});const w=web(h);w.app.openProductModal(p);w.app.productModal.data.stock=0;await w.app.saveProduct();assert.equal(h.tables().products[0].specs[0].stock,0);assert.equal((await create(h,h.tables().products[0],'A')).success,false);});
test('E-SKU-adjustment-root-recomputed-and-reservations-preserved','R4-C02',async()=>{const h=setup();const p=product(h);p.reservedStock=3;p.specs[1].reservedStock=3;assert.equal((await adjust(h,{quantity:-48})).success,false);assert.equal((await adjust(h,{quantity:-47})).success,true);assert.equal(h.tables().products[0].stock,4);assert.equal(h.tables().products[0].reservedStock,3);assert.equal(h.tables().products[0].specs[1].reservedStock,3);});
test('E-root-zero-inconsistent-old-SKU-stock-cannot-sell','R4-C02',async()=>{const h=setup();const p=product(h,{stock:0});assert.equal((await create(h,p)).success,false);});
function refund(h,missing=false) {const p=product(h,{stock:2,sales:1,specs:[{name:missing?'renamed':'A',stock:2,reservedStock:0}]});const o={_id:'o',orderNo:'SYNTHETIC-REFUND',userId:'test-buyer',status:'refunding',refundId:'rf',transactionId:'TX',totalFee:10000,inventoryStatus:'committed',items:[{productId:p._id,spec:'A',quantity:1}],agentId:''};h.tables().orders.push(o);h.tables().refunds=[{_id:'rf',orderId:'o',status:'pending_auto',type:'refund_only',restock:true,executionVersion:2,approvedAmount:10000,outRefundNo:'RF-SYNTHETIC',subMchId:'test-merchant',processTime:new Date(0)}];h.refundQuery={returnCode:'SUCCESS',resultCode:'SUCCESS',outTradeNo:o.orderNo,refundCount:1,outRefundNo0:'RF-SYNTHETIC',refundFee0:10000,refundStatus0:'SUCCESS',refundId0:'WX-SYNTHETIC'};return {p,o,rf:h.tables().refunds[0]};}
test('E-sold-SKU-rename-and-delete-protected','R2-001',async()=>{const h=setup();const p=product(h);assert.equal((await create(h,p,'A')).success,true);const paidOrder=h.tables().orders[0];Object.assign(paidOrder,{paymentSubMchId:'test-merchant',paymentPhase:'open',prepayId:'SYNTHETIC-ORIGINAL-PREPAY'});h.paymentQuery={returnCode:'SUCCESS',resultCode:'SUCCESS',tradeState:'SUCCESS',outTradeNo:paidOrder.orderNo,subMchId:'test-merchant',transactionId:'SYNTHETIC-PAID',totalFee:paidOrder.totalFee,subOpenid:'test-buyer'};assert.equal((await h.call('payNotify',{returnCode:'SUCCESS',resultCode:'SUCCESS',outTradeNo:paidOrder.orderNo},'')).errcode,0);const r=await h.call('admin',{action:'updateProduct',id:'p',specs:[{...p.specs[0],name:'renamed'},p.specs[1]]});assert.equal(r.success,false);assert.equal(h.tables().products[0].specs[0].name,'A');assert.equal((await h.call('admin',{action:'deleteProduct',id:'p'})).success,false);});
test('E-new-refund-preflight-blocks-missing-SKU-before-channel','R2-001',async()=>{const h=setup();refund(h,true);h.tables().refunds[0].status='pending';const r=await h.call('admin',{action:'processRefund',refundId:'rf',approve:true});assert.equal(r.success,false);assert.equal(h.refundCalls,0);assert.equal(h.refundQueries,0);assert.equal(h.tables().refunds[0].status,'pending');});
test('E-confirmed-old-refund-posts-once-and-recovers-original-inventory','R2-001',async()=>{const h=setup();refund(h,true);let r=await h.call('admin',{action:'executeRefund',refundId:'rf'});assert.equal(r.completed,true);assert.equal(h.tables().orders[0].status,'refunded');assert.equal(h.tables().cashflow_entries.length,1);assert.equal(h.tables().orders[0].inventoryRefunded,false);assert.equal(h.tables().refunds[0].inventoryRestockStatus,'pending_exception');assert.equal(h.refundCalls,0);h.tables().products[0].specs[0].name='A';r=await h.call('admin',{action:'retryRefund',refundId:'rf'});assert.equal(r.success,true);assert.equal(h.tables().products[0].stock,3);assert.equal(h.tables().orders[0].inventoryRefunded,true);assert.equal(h.tables().cashflow_entries.length,1);assert.equal(h.refundCalls,0);await h.call('admin',{action:'executeRefund',refundId:'rf'});assert.equal(h.tables().products[0].stock,3);});
test('E-normal-refund-query-success-restocks-once','R2-001',async()=>{const h=setup();refund(h);assert.equal((await h.call('admin',{action:'executeRefund',refundId:'rf'})).completed,true);assert.equal(h.tables().products[0].stock,3);assert.equal(h.tables().cashflow_entries.length,1);await h.call('admin',{action:'executeRefund',refundId:'rf'});assert.equal(h.tables().products[0].stock,3);});
test('E-released-inventory-never-restocked-by-refund','R2-001',async()=>{const h=setup();refund(h);h.tables().orders[0].inventoryStatus='released';assert.equal((await h.call('admin',{action:'executeRefund',refundId:'rf'})).completed,true);assert.equal(h.tables().products[0].stock,2);assert.notEqual(h.tables().orders[0].inventoryRefunded,true);assert.equal(h.tables().orders[0].inventoryRestockStatus,'not_required');});
test('E-stock-exception-sweep-recovers-without-new-refund', 'R2-001', async()=>{
 const h=setup();refund(h,true);assert.equal((await h.call('admin',{action:'executeRefund',refundId:'rf'})).completed,true);
 h.tables().products[0].specs[0].name='A';const before=h.refundQueries;
 assert.equal((await h.call('refund-processor',{action:'sweep'})).success,true);
 assert.equal(h.tables().products[0].stock,3);assert.equal(h.tables().refunds[0].inventoryRestockStatus,'completed');
 assert.equal(h.tables().cashflow_entries.length,1);assert.equal(h.refundCalls,0);assert.equal(h.refundQueries,before);
 await h.call('refund-processor',{action:'sweep'});assert.equal(h.tables().products[0].stock,3);
});
test('E-stock-exception-database-error-not-swallowed', 'R2-001', async()=>{
 const h=setup();refund(h);h.failRead='products';let r=await h.call('admin',{action:'executeRefund',refundId:'rf'});
 assert.equal(r.completed,false);assert.equal(h.tables().cashflow_entries.length,0);assert.equal(h.tables().orders[0].status,'refunding');
 h.failRead='';r=await h.call('admin',{action:'executeRefund',refundId:'rf'});assert.equal(r.completed,true);assert.equal(h.tables().cashflow_entries.length,1);assert.equal(h.refundCalls,0);
});
test('E-no-partial-restock-when-second-product-missing', 'R2-001', async()=>{
 const h=setup();refund(h);h.tables().orders[0].items.push({productId:'missing-product',spec:'B',quantity:1});
 assert.equal((await h.call('admin',{action:'executeRefund',refundId:'rf'})).completed,true);
 assert.equal(h.tables().products[0].stock,2);assert.equal(h.tables().inventory_adjustments.length,0);assert.equal(h.tables().cashflow_entries.length,1);
 assert.equal(h.tables().orders[0].inventoryRefunded,false);h.tables().products.push({_id:'missing-product',stock:0,sales:1,specs:[{name:'B',stock:0}]});
 assert.equal((await h.call('admin',{action:'retryRefund',refundId:'rf'})).success,true);assert.equal(h.tables().products[0].stock,3);assert.equal(h.tables().products[1].stock,1);
 assert.equal(h.tables().inventory_adjustments.length,2);assert.equal(h.refundCalls,0);
});
test('E-unverified-historical-deduction-remains-visible-stock-exception', 'R2-001', async()=>{
 const h=setup();refund(h);delete h.tables().orders[0].inventoryStatus;
 assert.equal((await h.call('admin',{action:'executeRefund',refundId:'rf'})).completed,true);
 assert.equal(h.tables().products[0].stock,2);assert.equal(h.tables().orders[0].inventoryRefunded,false);assert.equal(h.tables().refunds[0].inventoryRestockStatus,'pending_exception');
 const w=web(h);w.app.refundFilter.value='inventory_pending';await w.app.loadRefunds();assert.equal(w.app.refunds.value.length,1);
 const html=fs.readFileSync(path.join(h.root,'admin-web/index.html'),'utf8');assert.ok(html.includes('按原单恢复库存（不退款）'));assert.ok(html.includes('rf.inventoryRestockError'));
});
test('E-Web-recover-refund-inventory-through-original-action', 'R2-001', async()=>{
 const h=setup();refund(h,true);await h.call('admin',{action:'executeRefund',refundId:'rf'});h.tables().products[0].specs[0].name='A';
 const w=web(h);await w.app.retryRefund(h.tables().refunds[0]);assert.ok(w.calls.some(call=>call.action==='retryRefund'&&call.refundId==='rf'));
 assert.equal(h.tables().products[0].stock,3);assert.equal(h.tables().cashflow_entries.length,1);assert.equal(h.refundCalls,0);
});
test('E-update-reserved-SKU-preserves-authoritative-reservation', 'R4-C02', async()=>{
 const h=setup();product(h);assert.equal((await create(h,h.tables().products[0],'B',3)).success,true);
 const p=h.tables().products[0];const r=await h.call('admin',{action:'updateProduct',id:'p',specs:p.specs.map(item=>({...item,reservedStock:0}))});
 assert.equal(r.success,true);assert.equal(h.tables().products[0].reservedStock,3);assert.equal(h.tables().products[0].specs[1].reservedStock,3);
});
test('E-inventory-without-transaction-fails-closed', 'R4-S06', async()=>{
 const h=setup();product(h);delete h.db.runTransaction;assert.equal((await adjust(h)).success,false);assert.equal(h.tables().products[0].stock,51);assert.equal(h.tables().inventory_adjustments.length,0);
});
test('E-copy-parity-for-refund-behavior', 'R2-001', async()=>{
 const h=setup();for(const file of ['refund-effects.js','refund-execution.js'])assert.equal(fs.readFileSync(path.join(h.root,'cloudfunctions/admin',file),'utf8'),fs.readFileSync(path.join(h.root,'cloudfunctions/refund-processor',file),'utf8'));
});
test('E-unreferenced-SKU-edit-and-product-delete-positive', 'R2-001', async()=>{
 const h=setup();const p=product(h);const r=await h.call('admin',{action:'updateProduct',id:'p',specs:[{...p.specs[0],name:'new-A'},p.specs[1]]});
 assert.equal(r.success,true);assert.equal(h.tables().products[0].specs[0].name,'new-A');
 assert.equal((await h.call('admin',{action:'deleteProduct',id:'p'})).success,true);assert.equal(h.tables().products.length,0);
});
test('E-new-refund-approval-normal-original-query-flow', 'R2-001', async()=>{
 const h=setup();refund(h);h.tables().refunds[0].status='pending';h.refundQuery={returnCode:'SUCCESS',resultCode:'FAIL',errCode:'REFUNDNOTEXIST'};
 let r=await h.call('admin',{action:'processRefund',refundId:'rf',approve:true});assert.equal(r.channelAccepted,true);assert.equal(h.refundCalls,1);assert.equal(h.tables().cashflow_entries.length,0);
 h.refundQuery={returnCode:'SUCCESS',resultCode:'SUCCESS',outTradeNo:'SYNTHETIC-REFUND',refundCount:1,outRefundNo0:'RF-SYNTHETIC',refundFee0:10000,refundStatus0:'SUCCESS',refundId0:'WX-SYNTHETIC'};
 r=await h.call('admin',{action:'executeRefund',refundId:'rf'});assert.equal(r.completed,true);assert.equal(h.tables().products[0].stock,3);assert.equal(h.tables().cashflow_entries.length,1);assert.equal(h.refundCalls,1);
});
for(const count of [101,1001]) test('E-tail-SKU-reference-count-'+count, 'R2-001', async()=>{
 const h=setup();const p=product(h);h.tables().orders=Array.from({length:count},(_,i)=>({_id:'historical-'+i,items:[{productId:'other-product',spec:'A',quantity:1}]}));
 h.tables().orders[count-1].items=[{productId:'p',spec:'A',quantity:1}];
 const r=await h.call('admin',{action:'updateProduct',id:'p',specs:[{...p.specs[0],name:'renamed'},p.specs[1]]});assert.equal(r.success,false);assert.equal(h.tables().products[0].specs[0].name,'A');
});
test('E-same-element-SKU-reference-avoids-unrelated-item-collision', 'R2-001', async()=>{
 const h=setup();const p=product(h);h.tables().orders=[{_id:'mixed-order',items:[{productId:'p',spec:'B',quantity:1},{productId:'other-product',spec:'A',quantity:1}]}];
 const r=await h.call('admin',{action:'updateProduct',id:'p',specs:[{...p.specs[0],name:'unused-renamed'},p.specs[1]]});assert.equal(r.success,true);assert.equal(h.tables().products[0].specs[0].name,'unused-renamed');
});
test('E-invalid-historical-unit-price-never-creates-positive-mixed-order', 'R4-C01', async()=>{
 const h=setup();const p=product(h);p.specs[0].price=-1;const r=await h.call('order',{action:'create',orderNo:'JY20261018120000'+String(++sequence),items:[{productId:'p',spec:'A',quantity:1},{productId:'p',spec:'B',quantity:1}],address},'test-buyer');
 assert.equal(r.success,false);assert.equal(h.tables().orders.length,0);
});
test('E-full-normal-Web-Page-API-order-payment-refund-ledger', 'R2-001', async()=>{
 const h=setup();const w=web(h);w.app.openProductModal();Object.assign(w.app.productModal.data,{name:'Normal synthetic item',price:'100',stock:5});await w.app.saveProduct();
 const p=h.tables().products[0];const c=checkout(h);await c.page.fetchProductDetail(p._id,1,'');c.page.data.address=address;await c.page.submitOrder();
 assert.equal(h.tables().orders.length,1);const o=h.tables().orders[0];assert.equal(o.totalFee,10000);assert.equal(o.items[0].quantity,1);assert.equal(p.reservedStock,1);
 Object.assign(o,{paymentSubMchId:'test-merchant',paymentPhase:'open',prepayId:'SYNTHETIC-ORIGINAL-PREPAY'});
 h.paymentQuery={returnCode:'SUCCESS',resultCode:'SUCCESS',tradeState:'SUCCESS',outTradeNo:o.orderNo,subMchId:'test-merchant',transactionId:'NORMAL-TX',totalFee:o.totalFee,subOpenid:'test-buyer'};
 assert.equal((await h.call('payNotify',{returnCode:'SUCCESS',resultCode:'SUCCESS',outTradeNo:o.orderNo},'')).errcode,0);assert.equal(p.stock,4);assert.equal(p.reservedStock,0);
 const requested=await c.api.requestRefund(o._id,{reason:'Synthetic refund request'});assert.equal(requested.success,true);
 assert.equal((await h.call('admin',{action:'processRefund',refundId:requested.refundId,approve:true})).channelAccepted,true);assert.equal(h.refundCalls,1);
 const rf=h.tables().refunds[0];h.refundQuery={returnCode:'SUCCESS',resultCode:'SUCCESS',outTradeNo:o.orderNo,refundCount:1,outRefundNo0:rf.outRefundNo,refundFee0:10000,refundStatus0:'SUCCESS',refundId0:'NORMAL-WX-REFUND'};
 assert.equal((await h.call('admin',{action:'executeRefund',refundId:rf._id})).completed,true);assert.equal(p.stock,5);assert.equal(p.specs[0].stock,5);assert.equal(h.tables().orders[0].inventoryRefunded,true);
 assert.equal(h.tables().cashflow_entries.filter(e=>e.type==='sale_receipt').length,1);assert.equal(h.tables().cashflow_entries.filter(e=>e.type==='refund').length,1);
 assert.equal(h.tables().cashflow_entries.reduce((sum,e)=>sum+(e.direction==='in'?e.amount:-e.amount),0),0);assert.equal(h.refundCalls,1);
});
test('E-adjustment-ids-bounded-and-full-operation-binding', 'R4-S06', async()=>{
 const h=setup();product(h);assert.equal((await adjust(h)).success,true);const row=h.tables().inventory_adjustments[0];
 assert.ok(/^[A-Za-z0-9_]{1,32}$/.test(row._id));assert.equal(row.requestId,'synthetic-adjust-0001');assert.equal(row.operatorId,'owner');assert.ok(row.operationPayload.includes('Synthetic count'));
});
test('E-refund-stock-journal-write-failure-retry-is-atomic', 'R2-001', async()=>{
 const h=setup();refund(h);h.failWrite='inventory_adjustments';assert.equal((await h.call('admin',{action:'executeRefund',refundId:'rf'})).completed,false);
 assert.equal(h.tables().cashflow_entries.length,0);assert.equal(h.tables().orders[0].status,'refunding');assert.equal(h.tables().products[0].stock,2);
 h.failWrite='';assert.equal((await h.call('admin',{action:'executeRefund',refundId:'rf'})).completed,true);assert.equal(h.tables().products[0].stock,3);assert.equal(h.tables().cashflow_entries.length,1);
 assert.ok(/^[a-f0-9]{32}$/.test(h.tables().inventory_adjustments[0]._id));assert.equal(h.refundCalls,0);
});
test('E-empty-committed-items-never-claim-restock-completed', 'R2-001', async()=>{
 const h=setup();refund(h);h.tables().orders[0].items=[];assert.equal((await h.call('admin',{action:'executeRefund',refundId:'rf'})).completed,true);
 assert.equal(h.tables().orders[0].inventoryRefunded,false);assert.equal(h.tables().refunds[0].inventoryRestockStatus,'pending_exception');assert.equal(h.tables().products[0].stock,2);
});
for (const [label, value] of [['zero', 0], ['empty', ''], ['null', null], ['nonnumeric', 'not-a-price']]) {
 test('E-explicit-invalid-SKU-price-' + label + '-Page-and-server-reject', 'R4-C01', async()=>{
  const h=setup();const p=product(h);p.specs[1].price=value;
  const c=checkout(h);await c.page.fetchProductDetail('p',1,'B');
  assert.equal(c.page.data.items.length,0,'invalid explicit SKU price must not inherit root price in Page');
  assert.ok(c.page.data.loadError.includes('价格'),'Page must identify a price error');
  c.page.data.address=address;await c.page.submitOrder();assert.equal(h.tables().orders.length,0,'Page cannot submit invalid-price item');
  const r=await create(h,p,'B');assert.equal(r.success,false,'server independently rejects invalid explicit price');
  assert.equal(h.tables().orders.length,0);assert.equal(h.tables().inventory_reservations.length,0);assert.equal(h.tables().products[0].reservedStock,0);
 });
}
test('E-missing-SKU-price-inherits-root-Page-API-positive', 'R4-C01', async()=>{
 const h=setup();const p=product(h);delete p.specs[1].price;
 const c=checkout(h);await c.page.fetchProductDetail('p',1,'B');assert.equal(c.page.data.items[0].price,10000);
 c.page.data.address=address;await c.page.submitOrder();assert.equal(h.tables().orders.length,1);
 assert.equal(h.tables().orders[0].items[0].price,10000);assert.equal(h.tables().orders[0].totalFee,10000);
});
module.exports=cases;
