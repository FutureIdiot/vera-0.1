# Agent使用管理与运行时能力

## 阶段A：纯前端目录壳

- [ ] 新建独立于Vera全局Settings的Agent使用管理页：`#/agents`按默认顺序进入，`#/agents/:agentId`定位指定Agent。
- [ ] 聊天时间线中发言Agent头像进入指定Agent；Space导航左下角联系人图标进入默认顺序。两个入口复用同一页面和分页状态。
- [ ] 页面上半部分展示Agent像素形象，左右两侧提供前后翻页箭头；下半部分展示当前状态、所在Space及 `Skills / Hooks / MCP / Data` 四个平级入口。
- [ ] 路由固定为 `#/agents/:agentId/skills|hooks|mcp|data`；Data当前只列Memory入口。
- [ ] Vera全局 `#/settings/accounts` 只保留系统层Agent生命周期、Home Account、连接、Workspace与授权管理，不展示AgentState或能力/Data入口。
- [ ] Skills / Hooks / MCP复用一个无HTTP职责的单列目录view和标准化投影，不创建三份相似页面。
- [ ] Shell管理页顶栏支持右侧两个页面动作；三个目录固定显示“添加”“管理”。
- [ ] 实现loading、empty、error、单列条目、可用性、可选开关和窄屏长名称布局。
- [ ] 生产Skills显示“还没有 Skill”；未接入动作全部disabled并说明原因，不弹假表单。
- [ ] 生产路由不硬编码内置Hook/MCP或示例Skill；列表行视觉用测试夹具覆盖。
- [ ] 本阶段只改前端与前端测试，不改gateway、store、unit binding或Extension接口。

## 阶段A验收闸门

- [ ] 手机与桌面确认头像入口、联系人入口、默认/指定Agent定位、前后翻页、四入口、返回关系、标题和右侧动作位置。
- [ ] deep-link刷新、前进后退、单Agent、无Agent、Agent不存在、loading/empty/error、长名称与禁用按钮状态通过。
- [ ] 夹具证明Skill/Hook/MCP行使用同一组件；生产构建中没有示例条目或伪造状态。
- [ ] `npm test`、`node scripts/verify.mjs`、`npm run analyze:web`、`git diff --check`通过。
- [ ] 阶段A验收前不得开始真实接口接线。

## 阶段B：内置能力真实接线

- [ ] Hooks读取`GET /api/agents/:agentId/unit-bindings?kind=hook`，展示`vera.memory.recall`与`vera.memory.write`。
- [ ] MCP读取`GET /api/agents/:agentId/unit-bindings?kind=mcp`，展示`vera.memory`。
- [ ] 开关只通过`PATCH /api/agents/:agentId/unit-bindings/:unitId`写入并使用真实`version`处理409。
- [ ] Skills保持真实空列表；“添加/管理”继续disabled，直到Extension Package/Skill接口完成。
- [ ] Hooks/MCP的“添加/管理”也不提前模拟第三方安装；当前只有内置binding开关。
- [ ] 阶段B完成并验收后，Data → Memory页面才在完整四目录IA下实现。

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
