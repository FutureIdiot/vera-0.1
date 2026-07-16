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

## Hooks

- [ ] Hooks是通用事件自动化目录，不被Memory两项穷举。
- [ ] 第三方Hook按manifest声明自己的运行位置、权限、失败策略与可选控件。

## MCP

- [ ] 普通第三方MCP按自身契约显示字段，不自动成为Memory Provider。

## Data

- [ ] Digest/Dream的executor、task model、trigger/schedule与Provider能力只由Data → Memory保存。
- [ ] Data不投影Hooks开关。
- [ ] Skills、Tools policy和`runtimeCapabilities`consumer逐项闭环。
- [ ] 三端读取同一gateway保存的Appearance；平台只叠加safe-area与输入法约束，不重做主题系统。
