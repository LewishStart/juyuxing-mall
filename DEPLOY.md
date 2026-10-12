# 林元元商城部署入口

本文件只保留当前有效的部署入口，避免早期单体版、公开申请分销员和自动模拟支付说明继续误导操作。

完整步骤请按 [A/B/C 上线与试运行清单](docs/ABC-DEPLOYMENT.md) 执行。

## 本地门禁

```bash
npm install
npm run smoke
node scripts/e2e-mock.js
node scripts/page-load-logic-test.js
node scripts/admin-qr-auth-test.js
node scripts/release-gap-test.js
node scripts/refund-diagnostics-test.js
npm run lint:functions
```

## 当前架构

- A 端：消费者商城主包，仅包含商品、购物车、订单、支付、物流和售后。
- B 端：`admin-web/`，包含订单发货、库存、退款、收支、分销员、提现和账号权限。
- C 端：`miniprogram/subpackages/distributor/`，仅限 B 端一次性邀请激活。
- 三端共用 AppID、CloudBase 环境和业务数据。

## 交易安全要求

- 下单锁定库存，支付成功后正式扣减；30 分钟未支付由 `maintenance` 释放库存。
- `pay_config/default.useMockPay` 默认和上线时必须为 `false`。
- 测试模拟支付必须同时设置数据库 `useMockPay=true` 与 `pay` 云函数环境变量 `ALLOW_MOCK_PAY=true`；任一条件缺失都不会把订单标为已支付。
- 支付、退款、佣金和提现资金流水依赖 `database-indexes.json` 中的唯一幂等索引。
- 提现一期是人工转账：财务实际完成线下打款后，才能在 B 端点击“确认已打款”。
- 真实支付、退款和打款只能由持有微信商户权限的负责人做小额验收。

## 部署边界

需要部署的函数以 `cloudbaserc.json` 为准。`init`、`updateProductDesc`、`uploadProductImage` 是初始化/维护函数，不在正式部署清单中。

部署及数据库写入需要环境管理员在微信开发者工具或 CloudBase 控制台确认；密钥、密码、OpenID 不得写入仓库或聊天记录。

退款还需部署 `refund-processor`、导入 `refund_queue_time` 索引，并按 `docs/ABC-DEPLOYMENT.md` 第 9 节执行。审批通过不代表退款到账。
