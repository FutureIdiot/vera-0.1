# Agent daemon 与跨进程运行链路

## 开始条件

- [ ] [`federation-security.md`](federation-security.md) 已完成

## Gateway路由与调度

- [ ] 实现`/api/agent/enroll`与双凭证`login`；Agent runtime与Account Workspace分开登记。
- [ ] login建立`agentId + accountId`会话并处理显式takeover；不在login时取得具体Execution租约。
- [ ] Space主Run从seat Account解析当前activeAgentId，冻结模型后创建pending Execution。
- [ ] CLI input只含`promptText + providerBinding?`；API input只含`messages + historyVersion?`。
- [ ] `run.requested`携带可信delegationContext，让Agent清楚当前代表的Account与切换原因。
- [ ] API daemon通过专用`api-result`提交reply Message ids与安全tool/usage，gateway做historyVersion CAS后才能completed。
- [ ] isolated subagent不持久化AgentSession、history或provider binding。
- [ ] `src/spaces/messages.js`不再同步调用进程内adapter执行真实Run。

## Agent daemon

- [ ] 新增 `scripts/agent-daemon.js`，读取私网gateway URL与agent token。
- [ ] daemon按Agent报告runtime/provider/model，按登录Account报告唯一Workspace。
- [ ] main Run冻结`spaceSessionId + agentSessionId + generation`；isolated任务终态销毁。
- [ ] 处理专用compact request/result，不把压缩结果发布为聊天Message。
- [ ] 连续3次未收到gateway heartbeat后停止在飞Run并`exit(0)`。
- [ ] 私网失败时不得fallback到公网地址。

## Memory任务通道

- [ ] 在 `docs/adapter-interface.md` 先冻结Digest/Dream专用request/result通道。
- [ ] 通道包含取消、超时、安全摘要、无Account的`memoryTaskSnapshot`和无fallback语义。
- [ ] 不复用聊天Run、Message、Activity、AgentSession或provider binding。
- [ ] payload不携带executor的Memory、system prompt、Workspace、Tools、connection或secret。
- [ ] 迁移验收完成前不退役进程内Memory task adapter。

## Mock与验证

- [ ] 增加mock daemon：覆盖enroll、默认Agent login、其他Agent takeover、CLI run→binding CAS→completed。
- [ ] 覆盖API bounded messages→api-result CAS→completed，并证明完整history只在gateway。
- [ ] 覆盖compact、history conflict、isolated subagent、按Account logout、Key轮换和租约释放。
- [ ] gateway内部一致性测试保留现有mock adapter。
