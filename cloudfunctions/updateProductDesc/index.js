'use strict';

// =============================================================
// 一次性云函数：更新小紫瓶商品详情（description）
// 部署后在微信开发者工具「云开发」面板触发即可。
// 跑完可删除此函数。
// =============================================================
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async () => ({ success: false, code: 'MAINTENANCE_DISABLED', error: 'Runtime maintenance is disabled; use a separately reviewed controlled migration.' });

async function retiredMaintenance(event = {}, context) {
  const NEW_DESCRIPTION = `<p style="font-weight:600;font-size:30rpx;color:#2D4A3E;margin:0 0 12rpx;">一、品牌简介</p>
<p style="font-weight:600;font-size:28rpx;color:#4A3F35;margin:16rpx 0 8rpx;">1.1 品牌定位</p>
<p>林元元是专注中医日化领域的本土护肤防护品牌，深耕传统草本养护理念，秉持"草本温和、安全高效、全家适用"的核心品牌理念，依托传统中药配方结合现代温和生产工艺，主打高适配、高安全的肌肤日常防护类日化产品。品牌坚守天然、无多余化学添加的产品研发准则，聚焦大众日常肌肤不适问题，打造适配全年龄段人群的居家、旅行通用肌肤防护单品，致力于让传统草本养护智慧适配现代家庭日常护肤需求。</p>
<p style="font-weight:600;font-size:28rpx;color:#4A3F35;margin:16rpx 0 8rpx;">1.2 经营资质与核心优势</p>
<p>品牌主营合规中医日化用品，严格遵循《医疗器械监督管理条例》《广告法》等国内相关法律法规，所有产品均完成正规备案、合规生产、合规销售，杜绝违规宣传、虚假功效承诺。品牌摒弃日化产品常见的化学添加剂配方，深耕纯植物中药配方研发，平衡温和安全性与即时实用性，区别于普通护肤产品与激素类肌肤护理产品，打造出适配新生儿至老年人全生命周期的安全肌肤防护产品，为现代家庭提供省心、安心的日常肌肤不适护理解决方案。</p>
<p style="font-weight:600;font-size:30rpx;color:#2D4A3E;margin:24rpx 0 12rpx;">二、核心产品介绍：小紫瓶医用退热凝胶（皮肤用）</p>
<p style="font-weight:600;font-size:28rpx;color:#4A3F35;margin:16rpx 0 8rpx;">2.1 产品基础资质</p>
<p>小紫瓶医用退热凝胶（皮肤用）为品牌独家单品，是正规备案的第一类医疗器械（械字号）产品，生产、备案、销售全流程符合国家医疗器械生产经营标准，产品资质正规可查，品质严格可控。</p>
<p>依据一类医疗器械官方备案预期用途：用于人体体表完整皮肤的局部冷敷理疗与物理舒缓，所有宣传内容严格贴合国家备案信息，合规合法，无超范围、无夸大、无疾病治疗类违规表述。</p>
<p style="font-weight:600;font-size:28rpx;color:#4A3F35;margin:16rpx 0 8rpx;">2.2 产品核心配方特色</p>
<p>本产品核心优势为纯天然植物中药配方，无激素、无抗生素、无刺激性化学药品添加，配方精简安全，从根源上规避化学成分对脆弱肌肤的刺激与副作用。</p>
<p>依托传统草本护肤古方配比，结合现代低温萃取工艺，完整保留天然植物的舒缓养护活性成分，实现"温和不刺激、舒缓见效快"的双重核心优势。既区别于普通护肤品无即时舒缓效果的短板，又规避了激素类产品刺激性强、不能长期使用、不适用于婴幼儿的弊端，安全属性拉满。</p>
<p style="font-weight:600;font-size:28rpx;color:#4A3F35;margin:16rpx 0 8rpx;">2.3 产品核心功能与适用场景</p>
<p>结合草本配方特性与日常肌肤护理需求，产品可用于体表完整皮肤的日常不适舒缓，适配大众生活中常见的各类皮肤表层不适问题，涵盖蚊虫叮咬、环境刺激引发的皮肤泛红、干痒、日常轻微肌肤敏感不适等多种居家、户外常见肌肤问题。</p>
<p>产品冷敷舒缓效果优异，舒缓速度高效，体验感媲美激素类舒缓产品，但无任何激素副作用，兼顾高效性与安全性。</p>
<p style="font-weight:600;font-size:28rpx;color:#4A3F35;margin:16rpx 0 8rpx;">2.4 全人群适配属性</p>
<p>依托纯草本、零化学药添加的安全配方，产品实现全年龄层、全家庭周期通用：</p>
<p>1. 新生儿、婴幼儿：肌肤娇嫩敏感，可安全用于日常蚊虫叮咬、轻微泛红干痒舒缓，温和不损伤肌肤屏障；</p>
<p>2. 成人、老人：针对换季敏感、户外蚊虫侵扰、日常皮肤干痒等问题均可使用，适配全家日常肌肤防护。</p>
<p style="font-weight:600;font-size:28rpx;color:#4A3F35;margin:16rpx 0 8rpx;">2.5 产品使用定位</p>
<p>小紫瓶医用退热凝胶（皮肤用）是居家必备、旅行刚需的通用肌肤防护单品，体积小巧便携、使用便捷、肤感清爽不黏腻，无论是居家日常护理、户外出行、旅游差旅，均可随时用于皮肤表层不适的冷敷舒缓，是家庭常备的多功能肌肤舒缓防护产品。</p>
<p style="font-weight:600;font-size:30rpx;color:#2D4A3E;margin:24rpx 0 12rpx;">三、品牌与产品合规承诺</p>
<p>1. 资质合规：产品为正规一类械字号医疗器械，备案信息真实有效，生产符合国家医疗器械质量管理规范；</p>
<p>2. 宣传合规：严格遵守医疗器械宣传准则，不宣称疾病治疗功效，不使用"根治、治愈、特效"等绝对化词汇，所有产品特性描述基于配方属性与正常冷敷理疗、皮肤舒缓体验；</p>
<p>3. 品质合规：坚持零激素、零化学药品添加标准，配方安全可溯源，适配全年龄段人群安心使用。</p>
<p style="margin-top:20rpx;padding:16rpx 20rpx;background:#FDF8F3;border-radius:12rpx;color:#8B7E72;"><strong>温馨提示：</strong>本产品为一类医疗器械，请仔细阅读产品说明书或者在医务人员指导下购买和使用，仅用于完整体表皮肤冷敷舒缓，不适用破损皮肤，不替代药品治疗。</p>`

  try {
    // 查找小紫瓶
    const { data } = await db.collection('products')
      .where({ name: '小紫瓶' })
      .limit(1)
      .get()

    if (data.length === 0) {
      return { success: false, message: '未找到"小紫瓶"商品，请确认数据库中已有该商品。' }
    }

    const productId = data[0]._id
    const oldDesc = data[0].description || ''

    // 更新 description
    await db.collection('products').doc(productId).update({
      data: { description: NEW_DESCRIPTION }
    })

    return {
      success: true,
      message: '小紫瓶商品详情已更新',
      productId,
      oldLength: oldDesc.length,
      newLength: NEW_DESCRIPTION.length
    }
  } catch (err) {
    return { success: false, message: err.message }
  }
}
