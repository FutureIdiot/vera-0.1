# 联邦状态、presence与owner入口边界

## 开始条件

- [ ] [`federation-account.md`](federation-account.md) 已完成

## AgentState

- [ ] 跟踪键从`agentId`改为`agentId:accountId:spaceId`。
- [ ] 形状包含`agentId, accountId, spaceId, status, detail, lastActiveAt`。
- [ ] 状态支持`idle/thinking/typing/reading/coding/reviewing/on_task/away`。
- [ ] `/api/agent-states`支持`spaceId`、`accountId`与`agentId`过滤。

## Presence与离线消息

- [ ] daemon登录/离线发布`account.presence.updated`，并保持已落地的`presence/lastSeenAt/activeAgentId`形状；`activeAgentId`只允许owner或null。
- [ ] @离线Account时不创建Run；时间线写入`account-offline`错误Activity。
- [ ] Account重新上线后不补发离线期间错过的@。

## Owner身份

- [ ] gateway只信任本机Tailscale Serve注入并去伪造的身份头。
- [ ] owner login必须命中`config.security.ownerTailscaleLogins`。
- [ ] 生产环境列表为空时拒绝普通业务API。
- [ ] 原生CORS使用配置化精确Origin白名单。
- [ ] 不建立第二套配对码或device session体系。

## 验收

- [ ] 同一owner pair位于不同Space时AgentState互不覆盖；伪造其他Account维度的AgentState更新被拒绝。
- [ ] 在线/离线@行为、presence事件和lastSeenAt通过黑盒测试。
- [ ] 当前任务已冻结的Agent Token、Account Key与Account Session不能被owner Tailscale身份旁路；伪造owner头全部拒绝。
- [ ] 日志与API不泄露owner identity原始头、token、secret或宿主路径。
