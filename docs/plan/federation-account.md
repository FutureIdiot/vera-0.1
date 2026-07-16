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
- [ ] AgentSession唯一键迁为`spaceSessionId + accountId + agentId`；代上线不得继承owner Agent provider binding/history。
- [ ] 每个Execution创建时固定`agentId + accountId + runtimeRevision + effectiveModel + delegated`。

## 租约与Workspace

- [ ] 每个Account同一时刻只允许一个`activeAgentId`会话和一个活跃Execution租约；每个Agent同一时刻也只允许一个Account会话。
- [ ] 显式接管先终态化旧在飞Execution并撤销旧会话；普通竞争返回`account_busy`。
- [ ] 每个Account恰有一个Workspace。
- [ ] gateway只保存Workspace宿主、绑定、策略、状态和校验时间；实际文件留在daemon宿主。
- [ ] Workspace、Space与项目数据按`accountId`隔离；provider/runtime/model按`agentId`隔离。
- [ ] SpaceSession、AgentSession与API规范history继续由gateway持有。

## Memory任务关系

- [ ] Digest/Dream的owner与executor继续分离。
- [ ] executor只使用自己的runtime revision和已验证任务模型，不绑定Account。
- [ ] Recall/Write是gateway程序Hook，不提供executor候选。
- [ ] 已选executor不可用时保留选择并显示警告，不自动改投。

## 前端与消息展示

- [ ] `#/settings/accounts`首动作改为“新建Account”；删除“新建Agent”“添加连接”旧动作。
- [ ] Account详情提供一次性Key生成/轮换、所属/当前Agent、Workspace与接管审计；不提供owner改绑。
- [ ] Space联系人和设置均按Account；@解析目标为Account。
- [ ] Account消息展示`Account名 · effectiveModel`；代上线只改变模型名颜色。
- [ ] Message持久化`accountNameSnapshot/executingAgentId/effectiveModel/delegated`，历史不随配置漂移。
- [ ] effectiveModel必须是实际非空模型名，禁止`default`、Account名或provider名占位。

## 验收

- [ ] 存量数据迁移幂等，迁移后不存在旧新双名。
- [ ] owner Agent上线、其他Agent临时代上线、显式接管、Key轮换、Account竞争和Agent跨Account竞争矩阵通过。
- [ ] 同一Account换Agent后，Space/Files/Workspace连续，但Memory、AgentSession和provider binding严格隔离。
- [ ] 不同owner Agent的Account可并行；同一Account或同一Agent绝不并行驾驶多个会话。
- [ ] Workspace路径和secret不进入普通API摘要。
