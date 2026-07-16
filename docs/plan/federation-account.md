# Home Account / Execution / Workspace 迁移

## 状态与范围

- Phase 5已完成；本文件是当前唯一下一执行项
- 本文件只负责账户所有权、Execution绑定、Workspace与租约，不负责网络身份或daemon协议

## 迁移

- [ ] 将现有 `Agent 1:N Account` 数据和Account管理UI一次迁移为每Agent恰有一个Home Account。
- [ ] 删除`owningAgentId`旧所有权语义和所有双读双写；不得保留兼容别名。
- [ ] 每个Execution创建时固定`agentId + accountId`。
- [ ] 主Execution只使用Home Account。
- [ ] subagent只有在目标Account的`authorizedAgentIds`包含其Agent时，才可创建绑定该Account的Execution。
- [ ] Seat不携带`accountId`；账户选择只存在于Execution。

## 租约与Workspace

- [ ] 每个Account同一时刻只允许一个活跃Execution租约。
- [ ] 竞争请求排队或明确返回`account_busy`；结束、取消、超时或失联必须释放。
- [ ] 每个Account恰有一个Workspace。
- [ ] gateway只保存Workspace宿主、绑定、策略、状态和校验时间；实际文件留在daemon宿主。
- [ ] Workspace、连接/runtime与CLI执行边界按`accountId`隔离。
- [ ] SpaceSession、AgentSession与API规范history继续由gateway持有。

## Memory任务关系

- [ ] Digest/Dream的owner与executor继续分离。
- [ ] executor只能使用自己的Home Account和同connection下已验证任务模型。
- [ ] Recall/Write是gateway程序Hook，不提供executor候选。
- [ ] 已选executor不可用时保留选择并显示警告，不自动改投。

## 验收

- [ ] 存量数据迁移幂等，迁移后不存在旧新双名。
- [ ] 主Execution、授权subagent、未授权subagent和Account竞争矩阵通过。
- [ ] 不同Account可并行，同一Account绝不并行。
- [ ] Workspace路径和secret不进入普通API摘要。
