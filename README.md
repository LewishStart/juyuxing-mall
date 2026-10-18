# 林元元商城

微信原生小程序 + CloudBase 的 A/B/C 三端商城：

- A 端消费者商城：商品、购物车、下单支付、订单、物流和售后。
- B 端运营后台：`admin-web/`，负责订单、发货、库存、退款、经营收支、分销邀请和提现审核。
- B 端登录：使用现有小程序扫码确认，签发 CloudBase 自定义身份和 24 小时后台会话；确认页不在消费者菜单展示。
- C 端分销员中心：同一小程序的 `subpackages/distributor/` 独立分包，负责邀请激活、推广素材、业绩、佣金和提现。

三端共享一个 AppID、一个 CloudBase 环境以及同一套商品、订单和用户数据。分销关系仅支持一级。

## 本地验证

```bash
npm install
npm run smoke
node scripts/e2e-mock.js
node scripts/page-load-logic-test.js
node scripts/admin-qr-auth-test.js
node scripts/release-gap-test.js
npm run lint:functions
```

然后在微信开发者工具中导入仓库根目录并检查：

- 普通编译：`pages/index/index`
- C 端编译：`subpackages/distributor/dashboard/dashboard`
- 受影响页面的加载、错误和空状态

## 项目结构

```text
miniprogram/
  pages/                         A 端消费者页面
  subpackages/distributor/       C 端分销员中心
  utils/                         客户端公共代码
admin-web/                       B 端 Vue 管理后台
cloudfunctions/                  CloudBase 云函数
scripts/                         smoke、模拟 E2E、迁移和安装检查
database-indexes.json            数据库索引定义
cloudbaserc.json                 云函数和定时触发器定义
```

## 关键业务规则

- 创建订单原子锁定 SKU 库存，30 分钟未支付自动关闭并释放。
- 支付成功将锁定库存转为正式销量并生成冻结佣金；支付、退款和提现均用幂等键防止重复入账。
- 收货后佣金可提现；发货 7 天后自动确认收货。
- 未发货退款和退货退款分开处理；退货由 B 端确认收到后决定是否回库存。
- 分销员只能通过 B 端生成的 7 天一次性邀请开通，推广码为唯一随机码。
- B 端账号分店主、运营、财务，权限由云函数校验，不依赖前端隐藏。
- C 端订单信息只返回脱敏订单号、商品、金额和状态，不返回姓名、手机号或地址。

## 配置与上线

不要提交商户密钥、OpenID、管理员密码或其他凭据。`miniprogram/app.js`、`cloudbaserc.json` 和 `admin-web/app.js` 必须使用同一个 CloudBase 环境。

完整的数据库、迁移、云函数和试运行步骤见 [A/B/C 上线清单](docs/ABC-DEPLOYMENT.md)。上线前必须由具备真实商户权限的账号完成人工小额支付、退款和提现验收。

同事只需接收[项目交付说明](docs/项目交付说明-2026-10-18.md)，其中已包含待办完成情况、修复成果、代码交付范围及部署验收要求。
