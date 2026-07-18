# Account详情与Session安全收口

## 状态与范围

- Phase 5已完成；本文件是当前唯一下一执行项
- 固定owner、Account Seat、portable Agent profile、Agent Token + Account Key +进程内Account Session、Workspace控制面、Execution租约与Memory任务运行时归属已经完成；事实与验收证据见`completed-foundation.md`
- 本文件只收口Account详情的Space成员关系、Session撤销终态，以及现有控制面的剩余安全验收；Data → Memory配置与手动Digest已经完成，SSE、Run上报与provider执行wire仍在后续文件
- 契约锚点：`api-contract.md`二章的「Account」「Run」、三章的「Account」、「M2 digest job、触发与事实匹配」「Agent Data → Memory」，以及`adapter-interface.md` 2.1/2.4

## Account详情

- [ ] 从共享bootstrap按Seat展示该Account当前active Space成员关系；不复制第二份Space接口，不提供owner改绑、接管或代上线入口。

## Session撤销终态

- [ ] Key轮换/撤销、显式logout或安全撤销把该Account全部pending/running Run固定终态化为`failed/account_session_revoked`，同步收口streaming Message、Activity与Approval并发布终态事件；旧Run不能被新Session认领。

## 验收

- [ ] 对现有`login/workspace/register/workspace/authorize/logout`控制面完成负面矩阵：Agent Token单独、Account Key单独、过期AccountSession单独均不能读取Account数据或控制Execution；持久化文件、日志和错误响应不泄露明文凭证。
- [ ] 不同owner Account的Session与Execution可并行且不存在全局锁；同一Account仍只有一个活跃AccountSession和一个running Execution。
- [ ] 非owner持有Account Key仍固定`delegation_unavailable`，不得建立AccountSession或取得Workspace授权；不同Agent的Memory与provider binding隔离回归保持通过。
