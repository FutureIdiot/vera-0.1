# 运行时能力与 Agent 设置

## 开始条件

- [ ] Phase 5.5完成

## Adapter补全

- [ ] 实现Claude Code resume型daemon adapter。
- [ ] 实现API tool-call host。
- [ ] 将已完成的Codex进程内driver迁移到daemon，不创建第二套Codex adapter，也不回到gateway spawn。
- [ ] 所有adapter按 `docs/adapter-interface.md` 的stub→临时gateway→真实provider三层闸门验收。

## Agent设置目录

- [ ] Agent设置固定实现 `Skills / Hooks / MCP / Data` 四个平级目录。
- [ ] 不增加第五个Agent Plugin目录，也不把Agent Plugin混入Skills。
- [ ] Skills、Hooks、MCP的绑定与状态是独立资源，不嵌进Agent身份字段。

## Hooks

- [ ] Hooks是通用事件自动化目录，不被Memory两项穷举。
- [ ] 默认内置`vera.memory.recall`与`vera.memory.write`。
- [ ] 两者由gateway程序执行，不显示executor或任务模型。
- [ ] Recall关闭只停止自动注入；Write关闭只停止自动Digest。

## MCP

- [ ] 默认内置`vera.memory`，只显示启用状态、可用性与工具清单。
- [ ] 不显示semantic Agent或模型。
- [ ] 普通第三方MCP按自身契约显示字段，不自动成为Memory Provider。

## Data

- [ ] Digest/Dream的executor、task model、trigger/schedule与Provider能力只由Data → Memory保存。
- [ ] Data不投影Hooks开关。
- [ ] Skills、Tools policy和`runtimeCapabilities`consumer逐项闭环。
- [ ] 三端读取同一gateway保存的Appearance；平台只叠加safe-area与输入法约束，不重做主题系统。
