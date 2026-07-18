# Account详情、Memory配置与Session安全收口

## 状态与范围

- Phase 5已完成；本文件是当前唯一下一执行项
- 固定owner、Account Seat、portable Agent profile、Agent Token + Account Key +进程内Account Session、Workspace控制面、Execution租约与Memory任务运行时归属已经完成；事实与验收证据见`completed-foundation.md`
- 本文件只收口Account详情/登录审计、Data → Memory配置与手动Digest、Session撤销终态，以及现有控制面的剩余安全验收；SSE、Run上报与provider执行wire仍在后续文件
- 契约锚点：`api-contract.md`二章的「Account」「Run」、三章的「Account」、「M2 digest job、触发与事实匹配」「Agent Data → Memory」，以及`adapter-interface.md` 2.1/2.4

## Account详情与登录审计

- [ ] Control Service持久化每个Account最近200条安全登录审计：`enroll/login/reconnect/logout`记录成功或拒绝，`session_revoked`只记录成功及枚举化撤销reason；不记录任一凭证、hash/fingerprint、boot id、原始身份头、IP、Workspace路径或provider连接。
- [ ] `GET /api/accounts/:id`严格返回`{account,ownerAgent,activeAgent,recentLogins}`；Workspace只返回安全摘要，审计只返回最近20条。
- [ ] Account详情消费唯一响应，保留一次性Key生成/轮换、所属/当前Agent与Workspace展示，增加真实登录审计，并从共享bootstrap按Seat展示当前active Space成员关系；不复制第二份Space接口，不提供owner改绑、接管或代上线入口。

## Data → Memory收口

- [ ] `_options`后端按任务分别返回executor及其当前`runtimeRevision`下真实可用的已验证模型，并标记最多一个`isDefault`；`inherit`只匹配该默认模型，Digest与Dream资格不复用。
- [ ] 页面同时读取`_config/_options/_status`并提供Digest/Dream executor、已验证模型与trigger/schedule配置；已保存选择失效时原样保留、显示警告并禁止新job，不自动改投。
- [ ] 手动Digest从`pendingContext.spaces`选择一个明确的`accountId + spaceId + spaceSessionId`范围；零项disabled、一项可默认、多项必须显式选择，提交严格incremental body且不跨窗口合并。

## Session撤销终态

- [ ] Key轮换/撤销、显式logout或安全撤销把该Account全部pending/running Run固定终态化为`failed/account_session_revoked`，同步收口streaming Message、Activity与Approval并发布终态事件；旧Run不能被新Session认领。
- [ ] 显式logout写安全`logout`审计，Key轮换/撤销或安全撤销写`session_revoked`审计及枚举reason；Account离线、租约释放且AgentSession/Workspace/Memory保持不变。

## 验收

- [ ] Account详情与登录审计覆盖排序、200条裁剪、最近20条投影、成功/拒绝/撤销事件及全禁字段；详情页面有专项前端测试。
- [ ] Data → Memory覆盖可用选择、失效选择保留、无fallback、配置CAS、零/一/多待整理窗口及手动Digest完整HTTP闭环。
- [ ] 对现有`login/workspace/register/workspace/authorize/logout`控制面完成负面矩阵：Agent Token单独、Account Key单独、过期AccountSession单独均不能读取Account数据或控制Execution；持久化文件、日志和错误响应不泄露明文凭证。
- [ ] 不同owner Account的Session与Execution可并行且不存在全局锁；同一Account仍只有一个活跃AccountSession和一个running Execution。
- [ ] 非owner持有Account Key仍固定`delegation_unavailable`，不得建立AccountSession或取得Workspace授权；不同Agent的Memory与provider binding隔离回归保持通过。
