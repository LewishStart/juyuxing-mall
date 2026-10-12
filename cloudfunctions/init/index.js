const cloud = require('wx-server-sdk');
const ENV_ID = 'cloud1-d4gx1jxk675274501';
cloud.init({ env: ENV_ID });
const db = cloud.database();

// ============================================================
// 集合初始化工具
//
// 修复说明（2026-09-02）：
// 1. 服务端 SDK 的 collection().add() 在集合不存在时不会自动建集合，
//    会抛 -502005（DATABASE_COLLECTION_NOT_EXIST）。旧代码依赖这一错误假设。
// 2. -502005 的含义是"集合不存在"，不是"集合已存在"；集合已存在的错误
//    通常是 -501007 或 message 含 exists/已存在。旧代码把两者弄反了。
// 3. 正确顺序：先探测（limit(1).get()），不存在则 createCollection，
//    再用 add/remove 验证可写。
// ============================================================

// 判断错误是否表示"集合已存在"（这类错误应视为成功）
function isCollectionExistsError(err) {
  const msg = String((err && err.message) || '');
  const code = (err && (err.errCode !== undefined ? err.errCode : err.code)) || 0;
  return code === -501007 || /exists|已存在|COLLECTION_EXISTS/i.test(msg);
}

// 通用：确保集合存在且可写
async function ensureCollection(name) {
  // 1. 探测：能读到说明集合已存在
  try {
    await db.collection(name).limit(1).get();
    return true;
  } catch (err) {
    // 读不到（集合不存在或权限异常），继续尝试创建
    console.log(`[ensureCollection:${name}] 探测未通过，尝试创建:`, err && (err.errCode || err.message));
  }

  // 2. 创建集合（注意区分"已存在"错误与真实失败）
  if (typeof db.createCollection === 'function') {
    try {
      await db.createCollection(name);
      console.log(`[ensureCollection:${name}] createCollection 成功`);
      return true;
    } catch (err) {
      if (isCollectionExistsError(err)) {
        return true; // 已存在，视为成功
      }
      console.log(`[ensureCollection:${name}] createCollection 失败:`, err && (err.errCode || err.message));
      // 继续走兜底验证
    }
  } else {
    console.log(`[ensureCollection:${name}] 当前 SDK 不支持 db.createCollection，走 add 兜底`);
  }

  // 3. 兜底验证：add 一条再删掉（同时验证可写；个别旧环境 add 也能触发自动建集合）
  try {
    const res = await db.collection(name).add({
      data: { _init: true, createTime: db.serverDate() }
    });
    await db.collection(name).doc(res._id).remove();
    return true;
  } catch (err) {
    console.error(`[ensureCollection:${name}] 创建/写入均失败:`, err && (err.errCode || err.message));
    return false;
  }
}

// 工具：确保 admin_config 文档存在
async function ensureAdminConfig() {
  const res = await db.collection('admin_config').doc('admin').get().catch(() => null);
  if (!res || !res.data) {
    await db.collection('admin_config').doc('admin').set({
      data: {
        openId: '',
        note: '替换 openId 为你的微信 openId 以获得管理后台权限'
      }
    });
    return true;
  }
  return false;
}

// 默认分类种子
const DEFAULT_CATEGORIES = [
  { name: '本草养颜', icon: '🌸', parentId: '', sort: 1, status: 'on', hot: true },
  { name: '草本润养', icon: '🌿', parentId: '', sort: 2, status: 'on', hot: true },
  { name: '日常滋补', icon: '🍵', parentId: '', sort: 3, status: 'on', hot: true },
  { name: '中医外养', icon: '🌾', parentId: '', sort: 4, status: 'on', hot: false },
  { name: '时令本草', icon: '🍂', parentId: '', sort: 5, status: 'on', hot: false },
  { name: '香疗舒缓', icon: '🕯️', parentId: '', sort: 6, status: 'on', hot: false }
];

// 工具：确保 categories 集合存在；仅在集合为空时播种默认分类（修复重复播种 bug）
async function ensureCategoriesCollection() {
  const ok = await ensureCollection('categories');
  if (!ok) return false;
  try {
    const cnt = await db.collection('categories').count();
    if (cnt.total === 0) {
      for (const c of DEFAULT_CATEGORIES) {
        await db.collection('categories').add({
          data: Object.assign({ createTime: db.serverDate() }, c)
        });
      }
      console.log('[init] 已播种默认分类', DEFAULT_CATEGORIES.length, '条');
    }
    return true;
  } catch (err) {
    console.log('[init] categories count 失败:', err && err.message);
    return false;
  }
}

// 工具：确保 pay_config 默认文档存在（集合必须已存在）
async function ensurePayConfig() {
  const res = await db.collection('pay_config').doc('default').get().catch(() => null);
  if (!res || !res.data) {
    await db.collection('pay_config').doc('default').set({
      data: {
        subMchId: '',
        useMockPay: false,
        note: '默认关闭模拟支付；真实支付需填写商户号并完成云支付绑定'
      }
    });
    return true;
  }
  return false;
}

// 首版需要的全部集合清单（新增业务集合在此登记）
// 2026-09-03 补全：以全部云函数实际引用的集合为准，避免运行时 -502005
const COLLECTIONS = [
  'users',
  'products',
  'categories',
  'coupons',
  'user_coupons',
  'favorites',
  'banners',
  'orders',
  'cart',
  'commissions',
  'refunds',
  'withdrawals',
  'cashflow_entries',
  'addresses',
  'referral_events',
  'messages',
  'admin_accounts',
  'admin_sessions',
  'admin_login_tickets',
  'agent_invites',
  'inventory_adjustments',
  'inventory_reservations',
  'promotion_targets',
  'config',
  'pay_config'
];

exports.main = async (event) => {
  const action = event.action || 'init';

  if (action === 'init') {
    // 管理配置
    const adminCreated = await ensureAdminConfig();

    // 逐个确保集合存在，输出每个集合的状态（便于排查）
    const collectionStatus = {};
    for (const name of COLLECTIONS) {
      collectionStatus[name] = name === 'categories'
        ? await ensureCategoriesCollection()
        : await ensureCollection(name);
    }

    // pay_config：集合存在时写入默认文档
    const payConfigCollectionCreated = collectionStatus['pay_config'];
    let payConfigCreated = false;
    let payConfigError = '';
    if (payConfigCollectionCreated) {
      try {
        payConfigCreated = await ensurePayConfig();
      } catch (err) {
        payConfigError = err.message || String(err);
        console.error('[init] ensurePayConfig 失败:', payConfigError);
      }
    } else {
      payConfigError = 'pay_config 集合创建失败，请到 CloudBase 控制台手动创建该集合后重试';
      console.error('[init]', payConfigError);
    }

    const failedCollections = Object.keys(collectionStatus).filter(k => !collectionStatus[k]);
    const messagesCreated = collectionStatus['messages'];

    // 已有商品时补 categoryId（幂等）
    const existing = await db.collection('products').get();
    const catRes = await db.collection('categories').limit(1).get().catch(() => ({ data: [] }));
    const defaultCatId = (catRes.data && catRes.data[0] && catRes.data[0]._id) || '';
    for (const p of existing.data) {
      if (defaultCatId && !p.categoryId) {
        try { await db.collection('products').doc(p._id).update({ data: { categoryId: defaultCatId } }); } catch (e) {}
      }
    }
    if (existing.data.length > 0) {
      return {
        success: true,
        message: failedCollections.length
          ? `数据库已有数据，但有集合初始化失败: ${failedCollections.join(', ')}`
          : '数据库已有数据，跳过商品初始化',
        count: existing.data.length,
        adminCreated,
        messagesCreated,
        payConfigCollectionCreated,
        payConfigCreated,
        payConfigError,
        collectionStatus,
        failedCollections
      };
    }

    // 创建默认商品 - 小紫瓶
    const productRes = await db.collection('products').add({
      data: {
        name: '小紫瓶',
        subtitle: '皮肤舒缓退热凝胶',
        categoryId: defaultCatId,
        price: 6900,
        originalPrice: 7800,
        stock: 1998,
        reservedStock: 0,
        specs: [
          { name: '13.5g', stock: 999, reservedStock: 0 },
          { name: '27g', stock: 999, reservedStock: 0 }
        ],
        images: ['/images/product-xiaoziping.jpg'],
        description: `<p style="font-weight:600;font-size:30rpx;color:#2D4A3E;margin:0 0 12rpx;">一、品牌简介</p>
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
<p style="margin-top:20rpx;padding:16rpx 20rpx;background:#FDF8F3;border-radius:12rpx;color:#8B7E72;"><strong>温馨提示：</strong>本产品为一类医疗器械，请仔细阅读产品说明书或者在医务人员指导下购买和使用，仅用于完整体表皮肤冷敷舒缓，不适用破损皮肤，不替代药品治疗。</p>`,
        status: 'on',
        sales: 0,
        createTime: db.serverDate()
      }
    });

    return {
      success: true,
      message: failedCollections.length
        ? `初始化完成，但有集合初始化失败: ${failedCollections.join(', ')}`
        : '初始化完成',
      productId: productRes._id,
      adminCreated,
      messagesCreated,
      payConfigCollectionCreated,
      payConfigCreated,
      payConfigError,
      collectionStatus,
      failedCollections
    };
  }

  if (action === 'check') {
    const products = await db.collection('products').get();
    const adminRes = await db.collection('admin_config').doc('admin').get().catch(() => null);
    const messagesCheck = await db.collection('messages').limit(1).get().catch(() => null);
    const payConfigCheck = await db.collection('pay_config').doc('default').get().catch(() => null);
    return {
      success: true,
      productCount: products.data.length,
      products: products.data.map(p => ({
        _id: p._id,
        name: p.name,
        price: p.price,
        status: p.status
      })),
      adminConfigured: !!(adminRes && adminRes.data),
      adminOpenIdSet: !!(adminRes && adminRes.data && adminRes.data.openId),
      messagesCollectionReady: !!(messagesCheck && messagesCheck.data !== undefined),
      payConfigCollectionReady: !!(payConfigCheck && payConfigCheck.data !== undefined),
      payConfigDocExists: !!(payConfigCheck && payConfigCheck.data)
    };
  }

  // ===== 设置管理员密码（Web 后台登录用） =====
  if (action === 'setPassword') {
    const password = event.password || 'juyuxing2026';
    const adminRes = await db.collection('admin_config').doc('admin').get().catch(() => null);
    if (!adminRes || !adminRes.data) {
      // admin_config 不存在，先创建
      await db.collection('admin_config').doc('admin').set({
        data: {
          openId: '',
          password: password,
          adminOpenIds: [],
          note: '管理员配置'
        }
      });
    } else {
      await db.collection('admin_config').doc('admin').update({
        data: { password: password }
      });
    }
    return { success: true, message: `管理密码已设置为: ${password}` };
  }

  // ===== 设置管理员 openId（小程序端管理员） =====
  if (action === 'setAdminOpenId') {
    const openId = event.openId;
    if (!openId) return { success: false, error: '请传入 openId' };
    const adminRes = await db.collection('admin_config').doc('admin').get().catch(() => null);
    if (!adminRes || !adminRes.data) {
      await db.collection('admin_config').doc('admin').set({
        data: {
          openId: openId,
          adminOpenIds: [openId],
          note: '管理员配置'
        }
      });
    } else {
      const existing = adminRes.data.adminOpenIds || [];
      if (!existing.includes(openId)) {
        existing.push(openId);
      }
      await db.collection('admin_config').doc('admin').update({
        data: {
          openId: openId,
          adminOpenIds: existing
        }
      });
    }
    return { success: true, message: `管理员 openId 已设置: ${openId}` };
  }

  return { success: false, error: 'unknown action' };
};
