# 已完成：Phase 5 Memory与上下文

本文只记录已经落地的能力和验收边界。Phase 5已于2026-07-17冻结。

## P5-X1：Phase 5冻结

- 用户已完成手机与桌面真实浏览器验收，覆盖Agent使用管理四目录、
  Data → Memory与Library，以及Files页面、composer附件入口和消息附件显示。
- 已安装并真实调用精确模型`qwen3-embedding:0.6b`；Ollama返回的完整model
  digest为
  `ac6da0dfba84a81fdbfbaf330198c33cd77c4cdfc53e8bc50eb581914a15621d`，
  维度1024，真实smoke 3/3通过。
- X1完成后最终回归再次通过：`npm test`退出码为0、`node scripts/verify.mjs`
  为94/94、`npm run analyze:web`与`git diff --check`通过；后端
  `node --check`已在F1实现验收中通过，本次冻结提交不含后端代码变更。
- Phase 5下一阶段唯一指向`federation-account.md`。2026-07-17已在Phase 5.5
  契约中把早先Home Account方案替换为Account固定owner；随后当前范围进一步收口为owner-only登录，
  非owner执行等待未来`vera.workspace` MCP闭环后另行冻结。本Phase 5冻结的per-Agent Memory、Files与上下文实现不因此改写。

## P5-F1：Files

- 已冻结File唯一owner Space、`sharedSpaceIds`、`isolation.files`三种读取策略，以及“扩大读取不转移管理权”的权限边界。
- 已冻结原始二进制上传、MIME/大小/完整性校验、同名不覆盖、Message `fileIds`引用、时间线安全附件投影和File删除墓碑。
- 已冻结Space归档保留附件、永久删除owner Space级联清理，以及Files附件根热迁移与逐文件hash验证/失败回滚。
- 已在`src/memory/files-*`模块实现二进制/元数据分离、
  原子上传、路径/父目录符号链接防护、版本并发、共享策略、墓碑和owner Space
  批量级联回滚。
- 已实现`#/spaces/:spaceId/files`、Space设置入口、composer上传与附件chip、
  时间线可用/删除投影，以及Files受控路径迁移。
- 2026-07-17黑盒`p5-f1.1`至`p5-f1.7`通过：真实二进制、隔离/共享/全局读取、
  Message引用、删除墓碑、路径穿越/MIME、热迁移、413与永久Space删除级联。
- 固定`PORT=3210`临时gateway手测中，curl逐帧收到`space.updated` seq 1与
  `file.created` seq 2；公开事件不含hash、storage name或宿主路径。

## P5-X1：自动化收口证据

- `isolation.memory`固定隔离与`isolation.files`三策略已由真实consumer和黑盒覆盖；
  AgentState/Account bootstrap既有形状回归通过，没有提前实现联邦per-Space状态。
- Memory链路已走真实临时gateway：A Space Message经假Codex隔离Digest生成带来源
  Memory，B Space新SpaceSession/AgentSession收到常驻索引与该Memory Recall投影。
- 第一方MCP的`memory_fetch_detail`确认同一generation只写一次`detail_opened`
  usage signal；派生权重、vault索引缺失/损坏等价重建与embedding sidecar重建均有
  独立自动化覆盖。
- Files上传、读取矩阵、Message、下载、单File删除、owner Space级联、路径迁移和
  失败回滚已进入`verify.mjs`。
- 2026-07-17自动化基线：`npm test`为285项、282通过、3项显式真实provider
  smoke跳过；`verify.mjs`为94/94；Web分析、后端`node --check`与
  `git diff --check`通过。
- 上述自动化证据与本文件开头的真实浏览器、真实embedding闸门共同构成Phase 5
  冻结依据。

## P5-D0：契约冻结

- 已冻结per-Agent Memory、slug不可普通改名和gateway单写者；当时记录的Home Account
  执行路由已由后续Phase 5.5 Account固定owner契约取代，不属于Phase 5实现事实。
- 默认Provider为`vera.markdown`；Obsidian兼容是该Provider特性，不是所有Provider的强制格式。
- 第一方Vera Memory MCP是统一Agent访问facade；自定义Provider运行时仍未实现。

## P5-M1与M1.5：权威层和MCP

- 已完成per-Agent Markdown vault、SourceRef、原子写、并发version、坏文件隔离、外部编辑重扫和可重建索引。
- 所有程序写入进入gateway单写队列；不存在文件直写或rename兼容入口。
- 已实现第一方MCP工具：`memory_list`、`memory_fetch_detail`、`memory_create`、`memory_update`、`memory_archive`。
- MCP schema不暴露`agentId/scope/origin/sources`；身份与来源由gateway可信上下文绑定。

## P5-M2：Digest与adapter

- 已完成Message范围Digest、确定性分块、事实匹配、严格proposal校验、持久job/receipt、重试与单写者应用。
- 已完成原生Ollama adapter与Codex CLI adapter；OpenCode digest保留代码但退出生产dispatch。
- `vera.memory.write`负责completed Message水位与自动Digest编排；Digest是隔离任务，不是Hook unit。
- Codex真实chat+Digest闸门已通过。
- Gemma transport已通过，但`gemma4:e4b`在跨job同事实夹具中错误提议`supersede`，validator安全拒绝。复验任务已移到 `federation-deployment.md`。

## P5-M3：Recall

- 已完成常驻索引、自动Recall、`memory_search`、`memory_fetch_more`、增强`memory_fetch_detail`、使用统计和token预算。
- 检索支持关键词、图扩散、五项评分、两阶段去重、软配额与稳定cursor。
- `vera.memory.recall`是gateway程序Hook；Activity不因Memory接入回流prompt。
- 2026-07-15历史黑盒：`npm test` 198通过，`verify.mjs` 76/76，Web分析通过。

## P5-C1：SpaceSession与AgentSession

- 已完成SpaceSession/AgentSession/generation、CLI provider binding、API history CAS、容量水位、自动/手动compact、`/new`和只读历史页面。
- Message、Run、Activity与Approval均绑定`spaceSessionId`。
- 2026-07-16单测为260通过；当时沙箱禁止listen，`verify.mjs`未在该窗口实跑，不能把此记录冒充daemon/Tailscale验收。

## P5-M3.1：真实embedding

- 已接入loopback Ollama `qwen3-embedding:0.6b`、1024维与完整model digest。
- embedding sidecar可重建、可增量更新；失败时公开`degradedChannels:["vector"]`并fail open到keyword + graph。
- 代表节点与全部`mergedSlugs`共同写入当前generation delivered集合。
- 2026-07-17已安装并运行精确`qwen3-embedding:0.6b`真实smoke；完整model
  digest见本文件P5-X1冻结章节。

## P5-M4后端：Provider、权重与Dream

- 已完成per-Agent Provider/Digest/Dream配置、任务资格、冻结快照和旧全局配置一次迁移。
- Digest/Dream始终写owner Agent的Provider；executor只提供自己的runtime与已验证任务模型，
  无静默fallback。Phase 5进程内Account连接参数是待由5.5迁移的承载旧形态。
- 已完成可重建派生权重。
- Dream只允许语义不变的结构/description/links更新、明确重复merge和带active replacement的冗余archive；无Message证据时不得纠正事实。
- 已完成Dream持久job、批量单写者、receipt恢复和IANA schedule。
- 2026-07-15后端验收：`npm test` 236通过、`verify.mjs` 79/79；后续语义收口已并入M3.1的267项单测。
- Data → Memory真实页面与Library已实现，并于2026-07-17由用户完成手机与桌面
  浏览器验收。
