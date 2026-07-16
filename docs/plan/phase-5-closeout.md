# Phase 5 收口

## 开始条件

- [ ] [`memory-ui.md`](memory-ui.md) 已完成
- [ ] [`files.md`](files.md) 已完成

条件未满足时不得执行本文件。

## 收口任务

- [ ] `isolation.memory`与Files读取策略的所有真实consumer生效；AgentState只验证现状未被破坏，per-Space结构仍由联邦阶段负责。
- [ ] 分类扩展使用数据驱动的capability/policy描述，不在业务代码散落固定分支，也不提前建立Extension或存储插件框架。
- [ ] 跑通Memory端到端：A Space产生有来源事实 → Digest → 新SpaceSession中的B Space按scope召回 → `memory_fetch_detail` → usage进入后续派生权重。
- [ ] 跑通Files端到端：上传 → 隔离/共享读取 → Message引用 → 下载 → 删除 → 路径迁移与回滚。
- [ ] 清空所有Memory派生索引，从vault + store等价重建。

## 验证

- [ ] 手测使用 `VERA_DATA_PATH=/tmp/... PORT=3210` 和独立临时vault/files目录。
- [ ] `node --check`覆盖所有后端改动文件。
- [ ] `npm test`
- [ ] `node scripts/verify.mjs`
- [ ] 在允许本机listen的环境补跑C1相关临时gateway黑盒，不以单测替代。
- [ ] 显式运行 `VERA_TEST_OLLAMA_EMBEDDING=1` 的真实`qwen3-embedding:0.6b` smoke，并记录精确model digest。
- [ ] 涉及SSE时用curl确认事件逐帧到达。
- [ ] `npm run build:web`
- [ ] `npm run analyze:web`
- [ ] `git diff --check`

## 完成动作

- [ ] 将Memory与Files完成证据追加到 `completed-memory.md` 的独立章节。
- [ ] 更新 `index.md`，下一阶段指向 `federation-account.md`。
- [ ] 形成Phase 5可回退commit。
- [ ] 开新任务窗口进入Phase 5.5；不得顺手迁移VPS或生成Android/iOS工程。
