# Data → Memory 页面

## 状态与范围

- [ ] 实现 `#/settings/accounts/:agentId/data/memory`
- 前置后端已完成，见 [`completed-memory.md`](completed-memory.md)
- 必须先完成并验收 [`runtime-capabilities.md`](runtime-capabilities.md) 的阶段A与阶段B，确保四个平级目录及内置Hooks/MCP已有真实唯一入口
- 本文件只负责状态/配置页面，不负责长期Memory正文编辑、Hooks目录或MCP目录

## 不可推导的页面语义

- Agent设置只有 `Skills / Hooks / MCP / Data` 四个平级目录。
- Recall与Write只属于Hooks；本页不显示、不投影、不保存两者状态。
- `vera.memory`只属于MCP；普通第三方MCP不进入Memory Provider列表。
- Digest与Dream是Memory Orchestrator创建的隔离任务，不是Hook unit。
- 本页是控制与状态页。长期Memory编辑器是 `#/settings/accounts/:agentId/data/memory/library`。
- Memory始终归owner Agent。executor Agent只提供其Home Account connection/runtime和已验证任务模型，不取得Memory所有权。
- 不显示“当前Agent是否兼容”等兼容性徽章。executor使用下拉选择；已选executor不可用时保留选择并显示明确警告，不自动改投。

## 页面内容

- [ ] “Memory结构”展示唯一active Provider。当前只提供真实可用的`vera.markdown`，文案为`Vera（兼容 Obsidian）`。
- [ ] 展示Provider条件配置、连接状态和受控位置入口。文件位置只读，修改位置跳转现有Path受控迁移流程。
- [ ] 展示长期Memory条数、逻辑大小和token估算。
- [ ] 待整理区域按SpaceSession展示未Digest Message数、字符数和估算token。
- [ ] 单独展示“带入当前AgentSession将额外消耗的上下文压力”。这是估算压力，不是精确provider计费或下一轮确定token。
- [ ] Digest配置：executor、`inherit | fixed`模型模式、任务模型、`realtime | scheduled | manual`策略、运行状态和手动动作。
- [ ] Dream配置：executor、`inherit | fixed`模型模式、任务模型、schedule、上次/下次运行、运行状态和“立即Dream”。
- [ ] 提供进入长期Memory Library的明确入口，但不在本页嵌入编辑器。

## 数据与错误

- 读取/写入只使用 `docs/api-contract.md` 的 per-Agent Memory `_config`、`_options`、`_status` 与任务端点。
- 自定义Provider未安装时不得出现“自定义”假选项。
- Provider缺少`digest.ingest`或`dream.maintenance`时，对应功能显示不可用原因，不套用`vera.markdown`行为。
- executor、Account、模型或Provider失效时明确失败；不得静默fallback到其他Agent、Account、模型或Provider。

## 验收

- [ ] 页面刷新后Provider、Digest、Dream配置与状态真实回显。
- [ ] 分SpaceSession待整理量和当前AgentSession压力来自真实后端数据。
- [ ] 手动Digest、立即Dream、schedule与任务状态走真实API。
- [ ] Data页不出现Recall/Write；Hooks与Data各自只有一个事实来源。
- [ ] Library入口进入独立路由，本页不加载Memory正文。
- [ ] `npm test`、`node scripts/verify.mjs`、`npm run analyze:web`、`git diff --check`通过，并完成手机与桌面真实浏览器验收。
