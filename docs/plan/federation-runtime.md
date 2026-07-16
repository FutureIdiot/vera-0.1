# Agent daemon 与跨进程运行链路

## 开始条件

- [ ] [`federation-security.md`](federation-security.md) 已完成

## Gateway路由与调度

- [ ] 实现 `/api/agent/*` 路由；login只登记daemon、Account runtime、Workspace状态、runtimeCapabilities与provider bindings，不在login时取得Execution租约。
- [ ] 主Run先创建pending Execution；调度器取得Account租约后转running并发送分型`run.requested`。
- [ ] CLI input只含`promptText + providerBinding?`；API input只含`messages + historyVersion?`。
- [ ] API daemon通过专用`api-result`提交reply Message ids与安全tool/usage，gateway做historyVersion CAS后才能completed。
- [ ] isolated subagent不持久化AgentSession、history或provider binding。
- [ ] `src/spaces/messages.js`不再同步调用进程内adapter执行真实Run。

## Agent daemon

- [ ] 新增 `scripts/agent-daemon.js`，读取私网gateway URL与agent token。
- [ ] daemon按Account报告唯一Workspace、CLI binary和runtimeCapabilities。
- [ ] main Run冻结`spaceSessionId + agentSessionId + generation`；isolated任务终态销毁。
- [ ] 处理专用compact request/result，不把压缩结果发布为聊天Message。
- [ ] 连续3次未收到gateway heartbeat后停止在飞Run并`exit(0)`。
- [ ] 私网失败时不得fallback到公网地址。

## Memory任务通道

- [ ] 在 `docs/adapter-interface.md` 先冻结Digest/Dream专用request/result通道。
- [ ] 通道包含取消、超时、安全摘要、冻结`memoryTaskSnapshot`和无fallback语义。
- [ ] 不复用聊天Run、Message、Activity、AgentSession或provider binding。
- [ ] payload不携带executor的Memory、system prompt、Workspace、Tools、connection或secret。
- [ ] 迁移验收完成前不退役进程内Memory task adapter。

## Mock与验证

- [ ] 增加mock daemon：覆盖CLI login→run→binding CAS→completed。
- [ ] 覆盖API bounded messages→api-result CAS→completed，并证明完整history只在gateway。
- [ ] 覆盖compact、history conflict、isolated subagent、logout和租约释放。
- [ ] gateway内部一致性测试保留现有mock adapter。
