# 联邦状态、身份与权限

## 开始条件

- [ ] [`federation-account.md`](federation-account.md) 已完成

## AgentState

- [ ] 跟踪键从`agentId`改为`agentId:accountId:spaceId`。
- [ ] 形状包含`agentId, accountId, spaceId, status, detail, lastActiveAt`。
- [ ] 状态支持`idle/thinking/typing/reading/coding/reviewing/on_task/away`。
- [ ] `/api/agent-states`支持`spaceId`、`accountId`与`agentId`过滤。

## Presence与离线消息

- [ ] Account公开`presence/lastSeenAt/activeAgentId`；activeAgentId来自会话，不是所有权。
- [ ] daemon登录/离线发布`account.presence.updated`；`activeAgentId`只允许owner或null。
- [ ] @离线Account时不创建Run；时间线写入`account-offline`错误Activity。
- [ ] Account重新上线后不补发离线期间错过的@。

## Agent身份与Account访问权

- [ ] 新增agent token加载与校验模块，token存于`~/.vera/agent-tokens.json`，不进repo。
- [ ] Bearer token唯一解析为一个`agentId`；请求参数不得覆盖该身份。
- [ ] 同一可信身份绑定Vera Memory MCP transport。
- [ ] Account access key由User生成/轮换/撤销；gateway只保存salted hash/version，明文只返回一次。
- [ ] enroll只允许`ownerAgentId:null`的Account创建唯一owner Agent并签发token；owner建立后不得再次enroll，既有Agent不得认领第二个Account。
- [ ] login同时验证Account key与agent token，任何一方都不能单独冒充另一方，并强制`agentId === ownerAgentId`。
- [ ] 非owner Agent固定拒绝`delegation_unavailable`；协议不接受`takeover/reason`，不建立`delegationContext`。
- [ ] Key泄露后的轮换撤销旧会话；日志、API、SSE和审计不泄露明文。

## Owner身份

- [ ] gateway只信任本机Tailscale Serve注入并去伪造的身份头。
- [ ] owner login必须命中`config.security.ownerTailscaleLogins`。
- [ ] 生产环境列表为空时拒绝普通业务API。
- [ ] 原生CORS使用配置化精确Origin白名单。
- [ ] 不建立第二套配对码或device session体系。

## 验收

- [ ] 同一owner pair位于不同Space时AgentState互不覆盖；伪造其他Account维度的AgentState更新被拒绝。
- [ ] 在线/离线@行为、presence事件和lastSeenAt通过黑盒测试。
- [ ] 无/错agent token、无/错Account key、跨Agent冒充、跨Account复用与伪造owner头全部拒绝。
- [ ] 日志与API不泄露token、secret或宿主路径。
