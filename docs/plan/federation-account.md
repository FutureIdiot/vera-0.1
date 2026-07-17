# Account固定归属、Execution与Workspace迁移

## 状态与范围

- Phase 5已完成；本文件是当前唯一下一执行项
- 本文件只负责Account固定owner数据模型、Space Seat、Execution绑定、Workspace与前端管理迁移；双凭证安全与daemon wire分别在后续文件

## 迁移

- [ ] `owningAgentId`一次迁为不可变`ownerAgentId`，并把存量`Agent 1:N Account`收敛为严格1:1；无法唯一处理时阻止迁移，不复制Memory或静默拆Agent。
- [ ] 删除Account上的`kind/provider/connection/model/authorizedAgentIds`旧字段与所有双读双写。
- [ ] Account改为首层持久身份：`name/ownerAgentId/presence/lastSeenAt/activeAgentId/accessKeyState/accessKeyVersion`。
- [ ] Account与owner Agent严格1:1；首次enroll原子建立唯一owner，普通API不得改绑，同一Agent不得拥有第二个Account。
- [ ] Agent持有私有Memory与runtime profile；普通前端不得创建空Agent。
- [ ] Space Seat从`agentId`一次迁移为`accountId`；旧`blockAgentIds`迁为`blockAccountIds`，`respondTo`同步改用Account id。
- [ ] Space通知模式`agentMessages`一次迁为`accountMessages`并删除旧token。
- [ ] AgentSession唯一键迁为`spaceSessionId + accountId + agentId`；当前`agentId`只允许owner，且任一Agent不得继承另一Agent的provider binding/history。
- [ ] 每个Execution创建时固定`agentId + accountId + runtimeRevision + effectiveModel + delegated`。

## 租约与Workspace

- [ ] 每个Account同一时刻只允许一个owner会话和一个活跃Execution租约；`activeAgentId`只允许`ownerAgentId/null`。
- [ ] owner重复登录或会话竞争返回`account_busy`；当前不实现takeover、非owner会话或跨Account切换。
- [ ] 每个Account恰有一个Workspace。
- [ ] gateway只保存Workspace宿主、绑定、策略、状态和校验时间；实际文件留在daemon宿主，且当前要求`workspace.hostId === owner runtime.hostId`。
- [ ] Workspace、Space与项目数据按`accountId`隔离；provider/runtime/model按`agentId`隔离。
- [ ] SpaceSession、AgentSession与API规范history继续由gateway持有。

## Memory任务关系

- [ ] active Memory Provider binding增加`placement:{runtime:"gateway"|"daemon"|"remote",hostId?}`；新CLI默认daemon宿主，新API可默认gateway宿主。
- [ ] Phase 5存量`vera.markdown`按当前真实vault迁为`gateway` placement，不静默移动文件；后续placement迁移必须另走排空、复制、验证与原子换绑。
- [ ] Digest/Dream的owner与executor继续分离。
- [ ] executor只使用自己的runtime revision和已验证任务模型，不绑定Account。
- [ ] Recall/Write是gateway程序Hook，不提供executor候选。
- [ ] 已选executor不可用时保留选择并显示警告，不自动改投。

## 前端与消息展示

- [ ] `#/settings/accounts`首动作改为“新建Account”；删除“新建Agent”“添加连接”旧动作。
- [ ] Account详情提供一次性Key生成/轮换、所属/当前Agent、Workspace与登录审计；不提供owner改绑、接管或代上线入口。
- [ ] Space联系人和设置均按Account；@解析目标为Account。
- [ ] Account消息展示`Account名 · effectiveModel`；当前不显示代上线语义，相关样式只作为未来兼容位。
- [ ] Message持久化`accountNameSnapshot/executingAgentId/effectiveModel/delegated`，历史不随配置漂移。
- [ ] effectiveModel必须是实际非空模型名，禁止`default`、Account名或provider名占位。

## 验收

- [ ] 存量数据迁移幂等，迁移后不存在旧新双名。
- [ ] owner Agent上线、非owner固定拒绝`delegation_unavailable`、Key轮换、owner重复登录与Account竞争矩阵通过。
- [ ] 非owner即使持有Account Key也不能读取Space/Files/Workspace或建立AgentSession；不同Agent的Memory与provider binding严格隔离。
- [ ] 不同owner Agent的Account可并行；同一Account只有自己的owner Agent可驾驶一个会话。
- [ ] Workspace路径和secret不进入普通API摘要。
