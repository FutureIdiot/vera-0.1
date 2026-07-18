# Account固定归属、Execution与Workspace迁移

## 状态与范围

- Phase 5已完成；本文件是当前唯一下一执行项
- 本文件负责Account固定owner数据模型、Space Seat、Execution绑定、Workspace、前端管理，以及Agent Token + Account Key +进程内Account Session的完整凭证闭环；SSE、Run上报与provider执行wire仍在后续文件
- 固定owner、Account Seat、Execution身份与portable Agent profile迁移已完成；事实与验收证据见`completed-foundation.md`

## 租约与Workspace

- [ ] 每个Account同一时刻只允许一个owner会话和一个活跃Execution租约；`activeAgentId`只允许`ownerAgentId/null`。
- [ ] owner重复登录或会话竞争返回`account_busy`；当前不实现takeover、非owner会话或跨Account切换。
- [ ] 每个Account恰有一个Workspace。
- [ ] 在gateway内实现唯一`Vera Control Service`，统一复用Account/Agent/Session事实来源管理Workspace首次绑定、宿主准入和Execution授权；不另建第二套账号或权限数据库。
- [ ] gateway只保存Workspace宿主、绑定、策略、状态和校验时间；实际文件留在daemon宿主，且当前要求`workspace.hostId === owner runtime.hostId`。
- [ ] 提供第一方Workspace Node内部协议的register/authorize控制面；当前只允许owner且不实现文件/Git/进程远程工具、MCP适配或非owner代上线。
- [ ] Workspace、Space与项目数据按`accountId`隔离；provider/runtime/model按`agentId`隔离。
- [ ] SpaceSession、AgentSession与API规范history继续由gateway持有。

## 凭证安全与Account Session

- [ ] 实现per-Agent高熵Agent Token加载/校验；gateway校验材料在`~/.vera/agent-tokens.json`，daemon明文只在本机secret store，不进repo、日志或API响应。
- [ ] `enroll`只允许`ownerAgentId:null`的Account创建唯一owner Agent并签发Agent Token；owner建立后不得再次enroll，既有Agent不得认领第二个Account。
- [ ] `login`支持互斥的重新授权与普通续连：重新授权验证Agent Token + Account Key；续连验证Agent Token + `X-Vera-Account-Session`，不得每次网络/SSE重连重复校验Key。
- [ ] 两端每次启动生成不落盘的boot id；Key模式成功后签发高熵opaque Account Session Token，绑定`agentId/accountId/Agent Token fingerprint/accessKeyVersion/daemonBootId/gatewayBootId`。只在login成功响应返回一次，gateway仅存进程内Token hash、daemon仅存进程内明文并经header发送，禁止持久化、日志、query、请求body或SSE data泄露。
- [ ] gateway或daemon进程重启、显式登出、Key轮换/撤销及安全撤销令Session失效并返回`account_reauthentication_required`；普通断线、presence暂时offline及runtime刷新继续使用同一Session，无周期性Key重验。
- [ ] 无人值守daemon可从本机`~/.vera/secrets.json`读取Account Key完成崩溃/重启后的自动重新授权；文件权限必须为`0600`，Key不得进入runtime profile、Run或gateway store。
- [ ] Phase 5.5重新授权仍强制`agentId === ownerAgentId`；非owner即使同时持有合法Agent Token与Account Key也固定`delegation_unavailable`。未来代上线只复用该建Session路径，`vera.workspace` MCP只提供受Execution租约约束的Workspace工具平面，不做身份替换；二者均不在本任务开放。
- [ ] 当前任务实现并黑盒验证`/api/agent/enroll`、`/api/agent/login`的Key/Session双模式与`DELETE /api/agent/sessions/:accountId`；后续daemon任务只消费此凭证层，不重新实现认证。

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
- [ ] Workspace register只允许首次原子绑定或精确匹配；login/reconnect不能静默改绑，authorize必须同时匹配owner Session、runtime revision、hostId与目标Run。
- [ ] `runtimeProfile`稳定JSON序列化验收通过；导出数据不含Account/Workspace/宿主状态、会话/租约、任一凭证、secret/`secretRef`、绝对路径或daemon派生snapshot字段。
