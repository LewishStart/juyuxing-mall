# 林元元商城 · 冒烟用例

> 用于在云开发"云端测试" / 小程序 IDE 中跑通关键流程。
> 每条用例覆盖一个核心 action + 业务断言。

## 0. 前置
- 在云开发控制台为 `cloud1-d4gx1jxk675274501` 环境部署以下云函数：
  `login / product / category / favorite / coupon / cart / order / pay / commission / withdrawal / agent / admin / init / chat`
- 首次跑 init 云函数（`{ action: 'init' }`），会自动初始化：
  - 默认商品（小紫瓶）
  - 默认分类（6 个一级分类）
  - 默认优惠券（3 张）
  - favorites / user_coupons / coupons / categories 集合
- 用户需先 `login` 拿到 `openId`，再调用需要鉴权的接口。

---

## 1. 分类模块

### 1.1 `category.list` — 获取一级分类
**入参**：`{ action: 'list' }`
**期望**：`{ success: true, data: [{ _id, name, icon, parentId, sort, status, hot }, ...] }`
**断言**：`data.length >= 6` 且 `data[0].name === '本草养颜'`

### 1.2 `category.products` — 按分类筛选商品
**入参**：`{ action: 'products', id: '<categoryId>', page: 1, pageSize: 20, sortBy: 'sales' }`
**期望**：`{ success: true, data: [...], hasMore: bool }`
**断言**：`data[].categoryId === id`

### 1.3 `category.hotKeywords` — 热门搜索词
**入参**：`{ action: 'hotKeywords' }`
**期望**：`data` 为字符串数组，长度 >= 3

---

## 2. 搜索模块（沿用 product 云函数）

### 2.1 `product.search` — 关键词搜索
**入参**：`{ action: 'search', keyword: '小紫瓶', page: 1 }`
**期望**：`data` 中至少 1 条匹配 `小紫瓶` 的商品

### 2.2 `product.search` — 排序
**入参**：`{ action: 'search', keyword: '', sortBy: 'priceAsc' }`
**断言**：返回商品按价格升序排列

### 2.3 `product.search` — 分页
**入参**：`{ action: 'search', page: 1, pageSize: 2 }` → 第二页 `{ page: 2 }`
**断言**：两次返回的 `_id` 集合不重叠

---

## 3. 收藏模块

### 3.1 `favorite.toggle` — 添加收藏
**入参**：`{ action: 'toggle', productId: '<pid>' }`
**期望**：`{ success: true, favorited: true, action: 'added' }`

### 3.2 `favorite.toggle` — 重复触发取消收藏
**入参**：同 3.1 再次调用
**期望**：`{ success: true, favorited: false, action: 'removed' }`

### 3.3 `favorite.check` — 检查收藏状态
**入参**：`{ action: 'check', productId: '<pid>' }`
**期望**：返回 `{ favorited: bool }`

### 3.4 `favorite.list` — 收藏列表
**入参**：`{ action: 'list', page: 1, pageSize: 10 }`
**期望**：`data[]` 中每条带 `_id, name, price, images, favoriteId` 字段

---

## 4. 优惠券模块

### 4.1 `coupon.center` — 领券中心
**入参**：`{ action: 'center' }`
**期望**：返回上架优惠券，`myClaimed >= 0`

### 4.2 `coupon.claim` — 领取
**入参**：`{ action: 'claim', couponId: '<cid>' }`
**期望**：`{ success: true, message: '领取成功' }`

### 4.3 `coupon.mine` — 我的优惠券（未使用）
**入参**：`{ action: 'mine', status: 'unused' }`
**期望**：返回刚才领取的券，`data[i].status === 'unused'`，`coupon` 字段非空

### 4.4 `coupon.available` — 结算页可用券
**入参**：`{ action: 'available', amount: 6900 }`（小紫瓶价）
**期望**：`data[]` 按 `discount` 降序，包含满足门槛的满减/折扣券

### 4.5 `coupon.calculate` — 计算折后价
**入参**：`{ action: 'calculate', userCouponId: '<ucid>', amount: 6900 }`
**期望**：`{ success: true, discount: <分>, finalAmount: <分> }`

### 4.6 `coupon.use` — 下单成功后标记
**入参**：`{ action: 'use', userCouponId: '<ucid>', orderId: '<oid>' }`
**期望**：`{ success: true }`，二次调用返回 `'该券已使用或失效'`

---

## 5. 主链路冒烟

### 5.1 浏览 → 加购 → 下单 → 支付
1. `category.list` → 拿到第一个分类 id
2. `category.products` → 拿到第一个商品 id
3. `cart.update` → 把这个商品加入购物车
4. `cart.get` → 检查购物车已含该商品
5. `coupon.claim` → 领一张满 50 减 10 券
6. `coupon.available` → 拿可用的 userCouponId
7. `order.create` → 提交订单，`items, address, couponId(userCouponId), couponDiscount`
8. `pay.request` → 拿到 prepay / 二维码（mock 下直接返回 success）
9. `coupon.use` → 把券标记 used

**断言**：
- 步骤 7 返回 `{ success: true, orderId }`
- 步骤 9 成功后 `coupon.mine status=used` 列表里能找到该券

### 5.2 收藏 → 下单
1. `favorite.toggle` → 收藏一个商品
2. `product.get` → 取详情
3. `order.create` → 下单

### 5.3 搜索 → 加入购物车
1. `product.search keyword=本草` → 拿商品
2. `cart.update` → 入车

---

## 6. 失败路径

| 用例 | 入参 | 期望 |
|------|------|------|
| `product.get id=invalid` | `{ action: 'get', id: 'invalid' }` | `{ success: false, error: ... }` |
| `favorite.toggle productId=''` | `{ action: 'toggle' }` | `{ success: false, error: '缺少 productId' }` |
| `coupon.claim` 未登录 | 调用前移除 openId | `{ success: false, code: 'NO_AUTH' }` |

---

## 7. 前端验收清单

- [ ] 启动小程序：`npm i` 后用微信开发者工具打开 `/miniprogram`
- [ ] 首页 → 4 个 tabBar：首页 / 分类 / 购物车 / 我的
- [ ] 首页 → 搜索框可点击进入搜索页（输入"小紫瓶"能看到历史、热搜、结果）
- [ ] 首页 → 4 个功能入口：分类 / 领券中心 / 我的收藏 / 订单查询
- [ ] 分类页：左侧 6 个一级分类可切换；右侧有商品 / 排序 / 下拉刷新 / 加载更多
- [ ] 搜索页：未输入 → 历史 + 热搜；输入 → 联想；提交 → 结果列表
- [ ] 商品详情：右上角 ♡ 按钮可登录后切换收藏状态
- [ ] 结算页：底部"选择优惠券"展示可用张数，弹出 actionSheet；选完折扣金额变化
- [ ] 我的 → 我的收藏 / 我的优惠券 / 领券中心 三个入口可见
- [ ] 收藏页：管理按钮可移除单条 / 全部移除；下拉刷新
- [ ] 优惠券中心：领取按钮点击后变"已领取"
- [ ] 我的优惠券：未使用 / 已使用 / 已过期 tab 切换正常

---

## 10. 端到端动态 E2E（本地 mock，不依赖云开发）

执行：
```bash
node scripts/e2e-mock.js
```

本脚本在内存里 mock 掉 `wx-server-sdk`，按真实链路串起 14 个云函数，验证：

- 0. 初始化：自动 seed 默认商品 / 6 个分类 / 3 张券
- 1. 登录 + 自动设管理员 + referrer 绑定
- 2. 领券 → 我的券列表
- 3. 加购 → 可用券筛选 → 服务端校验 totalFee 折扣 → 创建订单
- 4. Mock 支付受理（不落 paid，留给 payNotify） → 回调 → 佣金 settled
- 5. 提现申请：起提 / 超额 / 处理中冻结
- 6. 管理员审批：settled 佣金拆分、新增 paid 记录、重复审批拦截
- 7. 申请退款 + 状态机（refunding）
- 8. 管理员处理退款（callFunction pay 退款，订单→refunded）
- 9. checkAdmin 权限：非管理员拒绝 / 管理员通过
- 10. 收藏 toggle / 取消 / 列表空 / 搜索 RegExp / 分类商品

