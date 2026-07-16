# 联邦状态、身份与权限

## 开始条件

- [ ] [`federation-account.md`](federation-account.md) 已完成

## AgentState

- [ ] 跟踪键从`agentId`改为`agentId:spaceId`。
- [ ] 形状包含`agentId, spaceId, status, detail, lastActiveAt`。
- [ ] 状态支持`idle/thinking/typing/reading/coding/reviewing/on_task/away`。
- [ ] `/api/agent-states`支持`spaceId`与`agentId`过滤。

## Presence与离线消息

- [ ] Account持久形状提供`presence`与`lastSeenAt`。
- [ ] daemon在线状态变化发布`account.presence.updated`。
- [ ] @离线Agent时不创建Run；时间线写入`phase:"error", label:"agent-offline"`的Activity。
- [ ] Agent重新上线后不补发离线期间错过的@。

## Agent身份

- [ ] 新增agent token加载与校验模块，token存于`~/.vera/agent-tokens.json`，不进repo。
- [ ] Bearer token唯一解析为一个`agentId`；请求参数不得覆盖该身份。
- [ ] 同一可信身份绑定Vera Memory MCP transport。

## Owner身份

- [ ] gateway只信任本机Tailscale Serve注入并去伪造的身份头。
- [ ] owner login必须命中`config.security.ownerTailscaleLogins`。
- [ ] 生产环境列表为空时拒绝普通业务API。
- [ ] 原生CORS使用配置化精确Origin白名单。
- [ ] 不建立第二套配对码或device session体系。

## 验收

- [ ] per-Space AgentState互不覆盖。
- [ ] 在线/离线@行为、presence事件和lastSeenAt通过黑盒测试。
- [ ] 无token、错token、跨Agent冒充和伪造owner头全部拒绝。
- [ ] 日志与API不泄露token、secret或宿主路径。
