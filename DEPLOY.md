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
- 提现由后台审批后调用微信商家转账，分销员本人按微信页面确认收款。审批只占用佣金，不代表到账；只有渠道 `SUCCESS` 才完成佣金支付与现金支出入账。失败/关闭后保留占用，核对原单后才重试，不盲目换号。
- 真实支付、退款和打款只能由持有微信商户权限的负责人做小额验收。

## 部署边界

需要部署的函数以 `cloudbaserc.json` 为准。`init`、`updateProductDesc`、`uploadProductImage` 是初始化/维护函数，不在正式部署清单中。

部署及数据库写入需要环境管理员在微信开发者工具或 CloudBase 控制台确认；密钥、密码、OpenID 不得写入仓库或聊天记录。

退款还需部署 `refund-processor`、导入 `refund_queue_time` 索引，并按 `docs/ABC-DEPLOYMENT.md` 第 9 节执行。审批通过不代表退款到账。

资金链路修改必须完整上传函数目录内的辅助模块，不能只更新 `index.js`。`admin` 需要 `withdrawal-effects.js`、`refund-execution.js`、`payment-diagnostics.js`、`wxpay-direct.js` 等文件；`refund-processor` 需要相同版本的 `refund-execution.js`、`refund-effects.js`、`wxpay-direct.js`、`payment-diagnostics.js`。部署前运行 `npm run verify` 和 `npm run test:brand`。

退款保留审批后立即提交的路径；接口受理后仍为渠道处理中，最终核对才入账。当前 `refund-processor` 的 `sweep` 要求可信的店主/财务微信身份，不是无需授权的定时任务；不要只添加旧 `refundTimer` 声明就认定会自动完成。按下述验收文档由操作员核对；本轮没有部署或启用任何触发器。

本次交接只需[项目交付说明](docs/项目交付说明-2026-10-18.md)，已包含完成情况、完整部署范围和验收步骤。旧拆分报告仅保留本地历史，不能只按旧生产提交覆盖部署。
