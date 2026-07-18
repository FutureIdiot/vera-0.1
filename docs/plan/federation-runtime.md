# Agent daemon 与跨进程运行链路

## 开始条件

- [ ] [`federation-security.md`](federation-security.md) 已完成

## Gateway路由与调度

- [ ] `/api/agent/events`及全部Run/AgentSession范围端点直接复用`federation-account.md`已完成的`authenticateAccountSession`；只接受Agent Token + Account Session Token，不复制认证逻辑、不重新校验Account Key。
- [ ] daemon启动生成`daemonBootId`并以Account Key重新授权；同一进程普通HTTP/SSE重连只发送Account Session Token，不在login时取得具体Execution租约。
- [ ] Space主Run从seat Account解析当前activeAgentId，冻结模型后创建pending Execution。
- [ ] CLI input只含`promptText + providerBinding?`；API input只含`messages + historyVersion?`。
- [ ] `run.requested`携带可信owner Agent、Account、Workspace与分型input；不携带`delegationContext`，`delegated`固定为false。
- [ ] API daemon通过专用`api-result`提交reply Message ids与安全tool/usage，gateway做historyVersion CAS后才能completed。
- [ ] isolated subagent不持久化AgentSession、history或provider binding。
- [ ] `src/spaces/messages.js`不再同步调用进程内adapter执行真实Run。

## Agent daemon

- [ ] 新增`scripts/agent-daemon.js`，读取私网gateway URL、Agent Token与可选本机Account Key secret；Session Token只放进程内。
- [ ] daemon直接复用已完成的`daemon-credentials`模块；daemon链路启用后才把随后新登记的CLI Agent在首次login原子绑定到已验证的daemon placement Memory。此前已登记为gateway placement的Agent保持原位，不借login静默改挂。
- [ ] daemon按Agent报告稳定`hostId`、runtime/provider/model，按自己的owner Account报告同宿主唯一Workspace，并可报告daemon placement Memory Provider revision。
- [ ] main Run冻结`spaceSessionId + agentSessionId + generation`；isolated任务终态销毁。
- [ ] 处理专用compact request/result，不把压缩结果发布为聊天Message。
- [ ] 连续3次未收到gateway heartbeat后停止在飞Run并`exit(0)`。
- [ ] 私网失败时不得fallback到公网地址。

## Memory任务通道

- [ ] 按`docs/adapter-interface.md`已冻结的边界实现Digest/Dream专用request/result通道：包含取消、超时、安全摘要、无Account的`memoryTaskSnapshot`和无fallback语义，不复用聊天Run、Message、Activity、AgentSession或provider binding。
- [ ] Memory task payload不携带executor的Memory、system prompt、Workspace、Tools、connection或secret；daemon只按冻结runtime指纹和taskModel执行，不自行选择Account、Agent或模型。
- [ ] 迁移验收完成前不退役进程内Memory task adapter。

## Mock与验证

- [ ] 增加mock daemon：覆盖owner Agent login、非owner `delegation_unavailable`、Workspace host不匹配`workspace_unavailable`、CLI run→binding CAS→completed。
- [ ] 覆盖同一boot普通重连不发送Account Key，以及gateway/daemon boot变化后`account_reauthentication_required`→Key重新授权。
- [ ] 覆盖API bounded messages→api-result CAS→completed，并证明完整history只在gateway。
- [ ] 覆盖compact、history conflict、isolated subagent、owner Account logout、Key轮换和租约释放。
- [ ] 覆盖所有新增SSE/Run端点的三凭证隔离、非owner拒绝与日志/SSE/持久化/错误响应无明文凭证；Account Key不得出现在普通重连或任何Run请求。
- [ ] gateway内部一致性测试保留现有mock adapter。
