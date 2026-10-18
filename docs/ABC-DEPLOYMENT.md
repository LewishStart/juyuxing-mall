# A/B/C 上线与试运行清单

本清单只描述上线操作。执行前先备份 CloudBase 数据库；不要在本地脚本、仓库或聊天记录中写入商户密钥、管理员密码、OpenID。

## 1. 上线前本地门禁

```bash
npm install
npm run smoke
node scripts/e2e-mock.js
node scripts/page-load-logic-test.js
node scripts/admin-qr-auth-test.js
node scripts/release-gap-test.js
npm run lint:functions
```

在微信开发者工具中分别编译：

- A 端：`pages/index/index`
- C 端：`subpackages/distributor/dashboard/dashboard`

确认问题面板为 0，并人工检查 A 端没有分销、后台或店铺编辑入口。

## 2. 数据库准备

保留现有数据，补齐下列集合：

```text
admin_accounts
admin_sessions
agent_invites
inventory_reservations
inventory_adjustments
cashflow_entries
promotion_targets
```

按 `database-indexes.json` 在 CloudBase 控制台建立索引。唯一索引是幂等和身份安全的一部分，尤其不能漏掉：

- `users.referralCode`
- `orders.orderNo`
- `admin_accounts.username`
- `admin_sessions.tokenHash`
- `agent_invites.tokenHash`
- `inventory_reservations.idempotencyKey`
- `commissions.idempotencyKey`
- `withdrawals.idempotencyKey`
- `refunds.idempotencyKey`
- `cashflow_entries.idempotencyKey`

已有数据时，先运行第 3 节迁移补齐提现和退款幂等键，再创建对应唯一索引。索引创建成功前不要开放真实下单。

## 3. 数据迁移

先导出数据库快照，在副本上验证可重复执行的离线迁移：

```bash
node scripts/migrate-abc.js before.json after.json
node scripts/migrate-abc.js after.json after-second.json
```

比较两次输出，确认第二次没有新增重复业务记录。线上迁移由店主账号调用 `admin` 云函数：

1. `migrationPreview`
2. 确认统计数量符合预期
3. `runMigration`，参数 `confirm` 必须为 `MIGRATE_ABC_V1`
4. 再次执行 `migrationPreview`，待迁移项应归零

当前线上迁移单集合最多处理 1000 条。若任一集合超过 1000 条，先不要执行，需把迁移改为分页批处理。

旧 `admin_config/admin` 中的密码在首次使用账号 `owner` 登录时迁移为 scrypt 哈希；登录成功后应立即在 B 端改成至少 8 位的新密码。若旧配置没有密码，应先通过受控的 CloudBase 管理流程建立首个店主账号，不能把明文密码写入代码。

## 4. 云函数与定时任务

将 `cloudbaserc.json` 中列出的云函数部署到同一个环境。交易闭环至少需要：

```text
login product cart order pay payNotify
agent commission withdrawal admin
promotion maintenance
```

重点确认：

- `order`、`pay`、`payNotify`、`admin` 的运行内存和超时与配置一致。
- `maintenance` 定时器 `abc-order-maintenance` 已启用，每 5 分钟执行一次。
- `maintenance` 只能由定时触发器调用，普通用户调用会被拒绝。
- `promotion` 具备生成小程序码和写入云存储所需的官方权限。
- 支付通知指向 `payNotify`，商户号和环境 ID 使用正式环境配置；该函数必须仅允许微信支付平台触发，不能向小程序端或 Web 端开放调用权限。代码还会在事务内核对付款 OpenID 与订单金额。
- `pay_config/default.useMockPay` 上线时必须为 `false`；缺少商户号时支付会安全失败，不会自动模拟成功。
- 只有开发测试确有需要时，才同时设置 `useMockPay=true` 和 `pay` 云函数环境变量 `ALLOW_MOCK_PAY=true`；测试结束立即移除环境变量并关闭数据库开关。

不要在部署过程中调用 `init` 覆盖已有商品；它只用于全新测试环境。

## 5. B 端发布与权限

`admin-web/` 是现有 Vue 管理后台。发布前把 `admin-web/app.js` 的 CloudBase 环境 ID 与小程序保持一致，并为后台域名配置 CloudBase Web 安全域名和匿名登录。匿名登录只负责建立 Web 访问上下文，所有业务权限仍由 `admin` 云函数中的账号、会话和角色校验。

### 5.1 微信扫码登录

B 端默认使用现有小程序扫码确认登录。网页匿名身份只能创建和轮询两分钟票据；微信端确认后，`adminQrAuth` 签发 CloudBase 自定义登录 Ticket，网页切换为非匿名身份后才能调用 `admin`。

部署时由环境管理员完成以下操作（私钥不得提交到仓库）：

1. 身份认证 → 登录方式：开启“匿名登录”和“自定义登录”。
2. 下载自定义登录私钥，把其中的 `private_key_id` 和 `private_key` 分别配置为 `adminQrAuth` 云函数环境变量：
   - `CLOUDBASE_CUSTOM_LOGIN_PRIVATE_KEY_ID`
   - `CLOUDBASE_CUSTOM_LOGIN_PRIVATE_KEY`
3. 当前项目尚未上线，先在微信公众平台把最新上传代码“选为体验版”。`adminQrAuth` 和 `promotion` 默认生成体验版入口；正式发布前给这两个云函数设置环境变量 `MINIPROGRAM_ENV_VERSION=release`，重新部署并完成正式版扫码验收。
4. 为网页端生成小程序码配置 `MINIPROGRAM_APPSECRET`；`MINIPROGRAM_APPID` 默认使用当前项目 AppID，也可用同名环境变量覆盖。AppSecret 只能存放在云函数环境变量中，不能提交到仓库。网页触发的云函数不具备微信云调用票据，因此 `adminQrAuth` 会通过微信服务端 `stable_token` 接口生成小程序码。
5. 创建 `admin_login_tickets` 集合，并按 `database-indexes.json` 创建三个索引。
6. 部署 `adminQrAuth`，确认它具备调用 `wxacode.getUnlimited` 的权限。
7. 身份认证 → 权限控制 → 匿名用户：增加云函数网关策略 `FunctionsHttpApiAllow`。
8. 云函数 → 权限控制：保持其他函数拒绝匿名，只允许匿名身份访问扫码认证函数：

```json
{
  "*": {
    "invoke": "auth != null && auth.loginType != 'ANONYMOUS'"
  },
  "adminQrAuth": {
    "invoke": "auth != null"
  },
  "payNotify": { "invoke": "false" },
  "init": { "invoke": "false" },
  "updateProductDesc": { "invoke": "false" },
  "uploadProductImage": { "invoke": "false" }
}
```

8. 将本地测试地址 `127.0.0.1:8765` 和正式后台域名加入 CloudBase Web 安全域名。

后台登录二维码先落到稳定的主包首页 `pages/index/index`。首页仅在识别到后台专用 `q=` 场景参数时，立即中转到 `subpackages/admin-auth/confirm/confirm`；该确认页不在 A 端任何菜单出现，普通消费者入口和推广链接不会触发中转。扫码、小程序管理入口和客服权限统一读取 admin_accounts 中 active 且 wechatOpenId 明确绑定的账号及当前角色。旧 admin_config 标识不再授权，也不在登录时自动创建或绑定 owner。首次账号设置必须由环境管理员通过另行审核的受控流程完成，本次修复不执行迁移。后台接口只返回 `wechatBound`，不会把 OpenID 返回网页。

### 2026-09-07 修复部署范围

- 更新云函数：`coupon`、`promotion`、`adminQrAuth`。已有后台账号绑定与分销员身份保留，不需要清库。
- 更新小程序体验版：结算页优惠券接口/显示修复、A 端个人中心移除分销入口。C 端仍通过独立分包或邀请进入；后台身份本身不再自动获得分销身份。
- `promotion` 的 `MINIPROGRAM_ENV_VERSION` 和当前验收版本保持一致（体验版 `trial`，正式版 `release`）。推广码缓存增加 `qrEnvVersion`，云文件按版本分目录。没有版本信息的旧缓存会在下一次请求时重新生成，不删除历史云文件。消费者仍需使用新生成的推广码。
- 本地模拟不证明真实云事务并发或真实微信支付可用。部署后应验证已绑定店主扫码登录、C 端首页/商品推广码、消费者满减叠加用券，并另行完成真实小额支付、退款、提现验收。

用店主账号建立：

- 1 个运营账号
- 1 个财务账号

逐项验证：运营不能审核提现；财务不能修改商品或库存；只有店主能管理后台账号。

## 6. 试运行链路

使用 1 名店主、1 名分销员、2 名测试消费者：

1. B 端创建 7 天邀请。
2. 分销员从邀请链接进入 C 端并激活；重复领取必须失败。
3. C 端生成首页和商品推广码/分享路径。
4. 消费者 1 首次从推广入口进入并绑定；消费者 2 验证并发抢购不会超卖。
5. 创建订单后核对实际库存、锁定库存和可售库存。
6. 支付后核对库存正式扣减、销售现金流和冻结佣金各只有一条。
7. B 端填写物流公司和运单号并发货；重复发货不得重复改变资金或库存。
8. A 端查看物流并确认收货；C 端佣金转为可提现。
9. C 端申请提现，B 端店主/财务审批并发起微信商家转账；先核对占用佣金、各端可用额度与报表未记支出，再由分销员本人确认收款。核对原单为 `SUCCESS` 后，佣金转为已支付、现金支出只记一笔；重复审批/核对不重复出款或入账。
10. 分别验证发货前退款、退货退款、结算后退款及负佣金结转。

最后由具备真实商户权限的账号完成人工小额支付、退款和提现。真实资金操作必须由负责人在微信和商户平台中亲自确认。

物流一期保存物流公司、运单号和可选轨迹，并允许消费者查看。项目尚未接入第三方物流订阅/查询服务；若上线要求自动轨迹，需先确定服务商、购买接口并配置合法域名，不能把静态发货信息误称为实时物流查询。

## 7. 放量条件

以下条件全部满足后才开放正式流量：

- 自动化测试全部通过。
- A/C 端开发者工具编译无错误。
- B 端三个角色的浏览器流程通过。
- 支付、退款、提现回调在重复投递下无重复流水。
- 库存预留与释放在多用户并发场景下账实一致。
- C 端接口返回中没有客户姓名、手机号或地址。
- 试运行财务报表与订单、退款、提现流水一致。

## 8. 已完成的上线前安全清理

- 分销员自助激活入口已关闭；后端 `apply` 与旧 `bootstrap` 均拒绝开通，只允许领取 B 端生成的一次性邀请。
- A 端个人中心不展示分销入口；C 端只能通过邀请链接进入。
- 首页和商品分享入口经由好友链接进入即静默绑定推荐关系（店主决定取消确认弹窗，2026-09-13）。
- 正式部署模板将 `ALLOW_MOCK_PAY` 设为 `false`；模拟支付仍需数据库开关和云函数环境变量同时开启。
- 订单、支付和提现只信任 `cloud.getWXContext().OPENID`，不读取请求参数中的身份。

## 9. 退款部署与验收

退款最终结果是异步确认的。B 端“同意”先写入 `pending_auto`，并可立即提交一次退款请求；接口受理后保持 `channel_processing`，不提前记退款支出、回库存、冲销佣金或将订单改为已退款。只有权威查询确认对应原单最终成功，才完成本地事务入账。

1. 由负责人完整部署 `admin`、`agent`、`withdrawal`、`refund-processor` 和受影响的小程序页面。`admin` 的 `withdrawal-effects.js`、两端相同的 `refund-execution.js`、`refund-effects.js`、`wxpay-direct.js`、`payment-diagnostics.js` 必须随各自函数上传；本地验证会检查副本一致。旧 `admin-refund-http` 已在代码中返回 `410 REFUND_ENDPOINT_RETIRED`，若线上存在 HTTP 触发器应另行核对处理，本轮不修改云端配置。
2. 为 `refunds` 导入 `refund_queue_time` 复合索引：`status asc + processTime asc`。
3. 店主或财务从 B 端退款页生成二维码，用已绑定的微信扫码进入后台登录确认页。
4. 点击“处理并核对退款”。管理端执行与此入口共享 claim/提交痕迹；已提交、超时或被接管的记录只核对原号原商户原通道，未知结果不切换通道提交。仅渠道明确 `NOTENOUGH` 拒绝时，操作员确认余额并查原单后才可按原号原通道重试，worker 不自动再次出款。
5. 只有微信查询返回 `SUCCESS` 且退款单号、金额和订单号一致时，才在一个数据库事务中同步订单、退款、库存、佣金和现金流。
6. `PROCESSING` 保留为“渠道处理中”；查询异常、关闭、金额不符和历史不确定记录进入 `manual_review`，均不能显示为已退款。
7. 对历史 `refundChannel=wechat_manual` 或“订单已退款但渠道未确认”的记录逐笔核对商户平台和本地流水，不自动补账，也不直接重退。

真机验收必须使用新建的小额测试订单，并分别验证：受理不等于成功、超时不重退、重复扫码不重复流水、退款成功后库存与佣金只处理一次。真实资金验收由具备商户权限的人在最后一步确认。

当前 `refund-processor` 仅接受带操作员身份的 `action=sweep`；普通定时/支付通知没有该身份，不能据函数目录旧 `refundTimer` 声明假定队列自动推进。2026-10-18 只读观察到云端无定时器，本轮不新增。若需要无人值守自动核对，另行设计可信触发、权限和调度后再发布。

新提现仅在审核时标记 `accountingVersion=2`、佣金 `withdrawing`，成功后转 `paid`。旧单和旧 `posted` 流水不自动迁移或改账；不要为本轮修复运行初始化或历史迁移。真实部署时另核 `wx-server-sdk` 版本、事务 where/get 支持、唯一幂等索引与事务操作/时间上限，本地模拟不能证明服务端支持。

## Runtime authorization hardening (2026-10-18)

The rule overrides above deny client/Web invocation of payNotify and retired one-off functions; they are a deployment template, not evidence of applied cloud rules. Verify the platform-specific payment trigger remains operational separately. Do not add a guessed SOURCE allowlist or expose a public HTTP route for notifications. Actual live invoke rules, deployed hashes, gateway routes and payment-trigger compatibility require colleague acceptance before release.

payNotify independently queries CloudPay.queryOrder under pay_config/default.subMchId. It requires successful query/result/trade state, matching merchant and order number, positive integer totalFee matching the order, and a nonempty transactionId. subOpenid/sub_openid, when returned, must match the Mini Program order user; the service-provider openid belongs to a different app and is not compared. Both documented historical camelCase/snake_case response names are recognized. Missing association data, unknown payment, query errors or conflicting existing transaction IDs reject posting. Callback-supplied amounts and transaction IDs are never authoritative. syncTransaction additionally requires an active bound owner or finance account and never overwrites a conflicting existing transaction.

The original official CloudPay.queryOrder page could not be retrieved during local implementation. Before release, validate actual authorized query responses include the required association fields and inspect failures using the original order number; never work around missing fields by trusting the incoming callback. This is not evidence of a completed real payment.

QR tickets and new QR sessions carry the confirmed binding hash. Disabled accounts fail, roles are read on each business request, and ownership rebind invalidates old QR tickets and sessions. Existing QR sessions without the new binding hash must sign in again; valid password sessions retain current-account role/status checks. This code performs no account migration and does not mutate historical sessions automatically.

init, updateProductDesc and uploadProductImage exports return MAINTENANCE_DISABLED before any operation for every caller. Remove their old deployments or deny every client entry under an explicitly controlled release procedure. New environment bootstrap or exceptional product migration needs a separately reviewed offline procedure; no runtime event or environment toggle enables these writers. Do not run them as part of deploying this patch.
