# Agent使用管理与运行时能力

## 阶段C开始条件

- [ ] Phase 5.5完成

## 阶段C：Adapter补全

- [ ] 实现Claude Code resume型daemon adapter。
- [ ] 实现API tool-call host。
- [ ] 将已完成的Codex进程内driver迁移到daemon，不创建第二套Codex adapter，也不回到gateway spawn。
- [ ] 所有adapter按 `docs/adapter-interface.md` 的stub→临时gateway→真实provider三层闸门验收。

## 阶段C：Agent使用设置运行时闭环

- [ ] 不增加第五个Agent Plugin目录，也不把Agent Plugin混入Skills。
- [ ] Skills、Hooks、MCP的绑定与状态是独立资源，不嵌进Agent身份字段。

## 阶段C：后台工作与过程关注

- [ ] gateway实现不持久化的全局`observedSpaceId + revision`事实来源、CAS更新和`observation.updated`；只允许一个active单Account私聊Space，群聊固定拒绝。
- [ ] `run.requested`下发`activityVisibility`，关注切换只向受影响的在飞Run发送`run.activity-visibility.updated`；切换不重启Run、不改变Tool/Approval权限，也不补发此前过程。
- [ ] daemon在`status-only`时只合并并上报AgentState，不把provider思考/工具/usage过程发送到gateway；gateway二次拒绝非关注或群聊Run的过程Activity并保持零写入。
- [ ] AgentState按`agentId + accountId + spaceId`覆盖、完全去重并对detail-only更新限频；安全detail不得成为隐藏推理、tool参数/输出、secret、路径或provider原文的旁路。
- [ ] `thinking`只接受provider明确允许公开的安全过程摘要，模型原始隐藏推理永不采集、传输、保存或显示；Approval、安全错误、最终Message与API规范history所需tool transcript保持独立。
- [ ] 用并发后台Run验收详细Activity流全局最多来自一个私聊Space，群聊与其他Space只有AgentState/Approval/错误/Message；关注切换、多端revision冲突、SSE重连和gateway重启归零均通过。

## Hooks

- [ ] Hooks是通用事件自动化目录，不被Memory两项穷举。
- [ ] 第三方Hook按manifest声明自己的运行位置、权限、失败策略与可选控件。

## MCP

- [ ] 普通第三方MCP按自身契约显示字段，不自动成为Memory Provider。

## 后续：跨宿主Workspace MCP（不阻塞Phase 5.5）

- [ ] 设计第一方`vera.workspace` MCP，由Workspace宿主执行受Execution租约、Account权限与Workspace policy约束的文件、Git和进程工具。
- [ ] 工具调用绑定可信`agentId + accountId + runId + workspaceRevision`，tool schema不允许调用方自选宿主路径或扩大Account范围。
- [ ] 完成远程工具隔离、取消、审批、审计、并发租约与宿主离线失败语义；不得通过SSH旁路或复制Workspace冒充远程执行。
- [ ] 上述契约与黑盒验收完成后，另行冻结非owner登录、`delegated:true`与临时代上线授权；其他Agent必须以自己的Agent Token + 目标Account Key建立进程内Account Session，普通续连沿用Session Token，不切换Memory身份。
- [ ] 在此之前`vera.workspace`不注册、非owner固定`delegation_unavailable`。

## Data

- [ ] Digest/Dream的executor、task model、trigger/schedule与Provider能力只由Data → Memory保存。
- [ ] Data不投影Hooks开关。
- [ ] Skills、Tools policy和`runtimeCapabilities`consumer逐项闭环。
- [ ] 三端读取同一gateway保存的Appearance；平台只叠加safe-area与输入法约束，不重做主题系统。
