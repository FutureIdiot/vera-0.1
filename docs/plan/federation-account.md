# Account固定归属、Execution与Workspace迁移

## 状态与范围

- Phase 5已完成；本文件是当前唯一下一执行项
- 本文件负责Account固定owner数据模型、Space Seat、Execution绑定、Workspace、前端管理，以及Agent Token + Account Key +进程内Account Session的完整凭证闭环；SSE、Run上报与provider执行wire仍在后续文件
- 固定owner、Account Seat、Execution身份与portable Agent profile迁移已完成；事实与验收证据见`completed-foundation.md`

## 凭证安全与Account Session

- [ ] daemon从本机secret store加载明文Agent Token；明文不进repo、日志、普通API响应或gateway持久化。
- [ ] 无人值守daemon可从本机`~/.vera/secrets.json`读取Account Key完成崩溃/重启后的自动重新授权；文件权限必须为`0600`，Key不得进入runtime profile、Run或gateway store。

## Memory任务关系

- [ ] active Memory Provider binding增加`placement:{runtime:"gateway"|"daemon"|"remote",hostId?}`；新CLI默认daemon宿主，新API可默认gateway宿主。
- [ ] Phase 5存量`vera.markdown`按当前真实vault迁为`gateway` placement，不静默移动文件；后续placement迁移必须另走排空、复制、验证与原子换绑。
- [ ] Digest/Dream的owner与executor继续分离。
- [ ] executor只使用自己的runtime revision和已验证任务模型，不绑定Account。
- [ ] Recall/Write是gateway程序Hook，不提供executor候选。
- [ ] 已选executor不可用时保留选择并显示警告，不自动改投。

## 前端与消息展示

- [ ] Account详情提供一次性Key生成/轮换、所属/当前Agent、Workspace与登录审计；不提供owner改绑、接管或代上线入口。

## 验收

- [ ] 存量数据迁移幂等，迁移后不存在旧新双名。
- [ ] owner Agent上线、非owner固定拒绝`delegation_unavailable`、Key轮换、owner重复登录与Account竞争矩阵通过。
- [ ] 同一daemon/gateway boot下，`login`续连模式与共享Account范围鉴权中间件只验证Session Token；daemon boot id或gateway boot id变化、登出与Key轮换后旧Session全部拒绝并要求Key重新授权。后续SSE/Run端点必须直接复用该中间件，不另写Key校验。
- [ ] Agent Token单独、Account Key单独、过期Session单独均不能读取Account数据或控制Execution；日志、SSE、持久化文件与错误响应不泄露三类明文凭证。
- [ ] 非owner即使持有Account Key也不能读取Space/Files/Workspace或建立AgentSession；不同Agent的Memory与provider binding严格隔离。
- [ ] 不同owner Agent的Account可并行；同一Account只有自己的owner Agent可驾驶一个会话。
- [ ] Workspace路径和secret不进入普通API摘要。
- [ ] `runtimeProfile`稳定JSON序列化验收通过；导出数据不含Account/Workspace/宿主状态、会话/租约、任一凭证、secret/`secretRef`、绝对路径或daemon派生snapshot字段。
