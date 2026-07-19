# Agent daemon 与跨进程运行链路

## 状态与范围

- 当前无未完成事项；完成事实与验证证据见 [`completed-foundation.md`](completed-foundation.md)。
- 本阶段已完成消息 Run、compact 与 Digest/Dream Memory task 的 daemon 执行链路；不包含 Memory Provider 正文的跨宿主迁移。
- daemon placement Provider 的首次绑定、数据迁移与真实宿主验收继续由 [`federation-deployment.md`](federation-deployment.md) 负责，既有 gateway placement 不因 daemon login 静默改挂。
