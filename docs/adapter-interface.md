# Adapter 接口契约

> 本文同时规定 **provider adapter 行为契约** 与 Phase 5.5 的 **agent daemon ↔ gateway** 通信协议（2026-07-14修订，见 ground-truth 2.4）。
> 目标形态的核心承诺是：**gateway 不 spawn 任何 agent 进程；agent daemon 在远端独立活着，gateway 只通过 HTTP/SSE 与它通讯**。
> Phase 5.5 落地前，Phase 2–5 代码仍由文末附录 A 的进程内 adapter 承载真实执行；它不是最终部署形态，但在迁移完成前仍是有效实现契约。新 provider 必须先满足本文 1.2 的行为与验收规范，并能逐项翻译到 daemon 协议，不能以“以后会迁移”为由跳过当前闭环。

---

## 一、形态总览

```
Agent daemon (加入同一 Tailscale tailnet 的 Mac / 另一台 VPS)
    │
    │  启动: POST /api/agent/login   (Bearer <vera-agent-token>)
    │  ↓
    │  订阅: GET /api/agent/events   (SSE 长连接)
    │  ↓
    │  收到分型 run.requested：CLI input 或 API input → 在本机 spawn CLI / 调 API
    │  ↓
    │  流式输出 → POST /api/agent/runs/:id/delta
    │  activity   → POST /api/agent/runs/:id/activities
    │  气泡定稿   → POST /api/agent/runs/:id/messages
    │  approval   → POST /api/agent/runs/:id/approvals
    │  ↓
    │  run 结束: PATCH /api/agent/runs/:id (status=completed/failed/cancelled)
    │  CLI绑定CAS: PUT /api/agent/provider-bindings/:agentSessionId
    │  API结果CAS: PUT /api/agent/runs/:id/api-result
    │  ↓
    │  心跳维持: gateway 每 15s 在同 SSE 通道发 agent.heartbeat
    │  失联: 3 次心跳丢失(~45s) → daemon exit(0)
    │
    ▼
Vera gateway (VPS, 7×24)
  - 消息中枢 + 状态库 + 持久化 (SpaceSession/AgentSession/API history/CLI binding/Message/Run/vault)
  - 编译层给CLI现成promptText、给API现成bounded messages
  - Account.presence 维护
  - 离线 @ 直接发 error activity 跳过
```

### 1.1 Execution / Account 绑定模型

- **Execution 是一次实际执行单元，与 Run 1:1 对应**：gateway 每创建一条 Run，就为它选定且固定一个 `accountId`；Execution 开始后不得中途切换 Account。
- **主执行使用 Home Account**：Agent 在 Space 中回应用户的主 Run 默认绑定该 Agent 的 Home Account。Home Account 是主执行的默认驾驶位，不是 Agent 唯一能用的 Account。
- **subagent 可并行借用其他 Account**：主 Execution 派生的 subagent Execution 可绑定另一个 Account，但 token 对应的 `agentId` 必须在该 Account 的 `authorizedAgentIds` 中。授权只表示“可以申请使用”，不绕过 tool policy、Approval 与 workspace 边界。
- **Account 是活跃 Execution 的独占租约单元**：同一`accountId`同一时刻最多有一个`running` Execution；`pending`只表示排队，尚未持有租约。gateway在Run进入`running`前原子获取租约，在`completed`/`failed`/`cancelled`时释放；Account忙时必须排队或明确拒绝，不得通过“让整个Agent切换账户并重登”绕过。
- **Account 1:1 Workspace，Session由Vera建模**：`workspacePath`、provider连接、RuntimeCapabilities及runtime数据随Account；SpaceSession/AgentSession不属于Account。API Agent的规范history/checkpoint由gateway按`agentSessionId + generation`保存；CLI外部thread/resume id只是该generation绑定到实际Account的`providerBinding`。旧`(accountId,spaceId)->sessionState`在P5-C1一次迁移后删除，不双读双写。
- **Memory 随 Agent，不随 Account**：主 Execution 与它派生的 subagent Execution 只要仍以同一 `agentId` 行动，就读取同一份 per-Agent Memory；更换 Execution 的 `accountId` 不复制、迁移或切换 Memory。
- **Memory任务与聊天 run 隔离**：Digest/Dream只接收gateway冻结的安全任务包并返回proposal；不得带入owner或executor的AgentSession、checkpoint、API history、CLI provider binding、Memory身份提示、Workspace或Tools。Dream只做重复合并、语义不变的结构/双链整理和有明确替代项的冗余归档；没有Message证据不得纠正事实。

Memory模型任务的可选adapter方法为`digestMemory({ account, taskModel, payload, signal }) -> Promise<{ proposals, execution? }>`与M4的`dreamMemory({ account, taskModel, payload, signal }) -> Promise<{ proposals, execution? }>`。`account`固定为Data → Memory所选executor Agent的Home Account，只供可信adapter控制层读取`id/kind/provider/connection`与默认聊天`model`；`taskModel`是Memory Orchestrator按该任务的`modelMode: inherit | fixed`解析并通过对应资格记录校验后的实际模型：`inherit`取入队时executor Home Account的默认聊天模型，`fixed`可取同一Account连接下另一个已验证的低成本模型。adapter不得读取Hook/unit binding、查询或选择其他Agent/Account、自行改投或改写`taskModel`。

Digest的`payload.agent`始终是Memory所属owner Agent而不是executor Agent；完整`payload`严格为`{agent:{id,name},chunks,facts,proposalSchema}`。Dream完整`payload`严格为`{agent:{id,name},memories,proposalSchema}`，其中`memories`只含owner active Provider冻结的`slug/version/type/description/status/content/sources/links/derived`安全投影，最多256项且按gateway稳定批次选择；不含stain、query、vault路径或任一Agent提示。二者都是唯一可送入模型执行请求的内容，不含owner或executor Account、connection、secret、聊天提示、其他Memory、AgentSession/checkpoint/API history/CLI provider binding、workspacePath、回调或写能力；Digest中model可见`chunks`只含`{messages:[{messageId,author,target,content,createdAt}]}`，gateway内部chunk id/边界/计数不得进入adapter payload，避免与唯一合法证据标识`messageId`混淆。完整`proposalSchema`或由它确定性派生的provider-compatible transport schema必须经provider structured-output通道传递；完整Schema不在用户文本中重复序列化，且gateway完整validator始终是写入权威。实现必须使用独立无工具会话，遵守signal取消与配置超时，只返回可JSON序列化对象；`execution`若返回，只允许`{adapter,primaryModel,effectiveModel,fallbackUsed,fallbackReason,attempts}`安全路由元数据，其中`primaryModel/effectiveModel`都必须等于冻结`taskModel`且`fallbackUsed=false`。provider原始错误由对应Memory job service折叠为安全`executor_failed`。冻结的owner Agent、executor Agent Home Account与taskModel是该job唯一执行路由，不允许静默fallback。Digest的程序分块、Dream的批次选择与gateway/Provider提交是固定安全边界，不伪装成可替换adapter插件。adapter未实现对应方法时，该类任务明确`executor_unavailable`。

OpenCode实现只服务`kind=cli, provider=opencode`的Account，其聊天`run(ctx)`与既有digest代码继续保留；但OpenCode digest当前暂停生产dispatch、fallback与M2完成闸门，`provider=opencode`的Home Account提交digest时明确`executor_unavailable`，不得退化为聊天run。恢复前必须由用户另行授权并重新通过三层闸门。

Codex实现只服务`kind=cli, provider=codex`的Account，并同时实现聊天`run(ctx)`与隔离`digestMemory(...)`。聊天使用非交互`codex exec --json`，续轮使用`codex exec resume <threadId> --json`；prompt从stdin恰好投递一次，`thread.started.thread_id`立即作为当前`agentSessionId + generation`的CLI provider binding做CAS持久化。只有明确thread不存在才请求gateway换代generation并从checkpoint建立新thread；普通provider失败不得重置。流式、Activity、model与固定参数安全规则保持不变。

Codex digest/dream每次创建新的临时cwd/schema/output文件，使用`codex -C <temp> -a never -s read-only exec --ephemeral --ignore-user-config --ignore-rules --skip-git-repo-check --json --output-schema <schema> --output-last-message <output> -`，并以`-m <taskModel>`显式传入gateway冻结的任务模型，禁用CLI当前公开的shell/apps/multi-agent特性；绝不resume聊天thread，不传Account Workspace/connection.args，不创建Message/Activity。`--output-schema`接收gateway完整schema或经真实能力探针确认的确定性Codex-compatible投影；prompt不重复序列化schema，最终仍由gateway完整validator裁决。当前CLI没有单一“禁用全部工具”开关，因此可验证边界是空临时cwd、ephemeral、忽略用户配置/rules、read-only与never；JSONL一旦出现任何tool item即`executor_failed`且结果不得apply。Codex digest/dream无fallback。

Codex运行配置不进Account API/Settings UI：`chatSandbox=workspace-write`、`maxInputBytes=12000`、`watchdogMs=1800000`、`digestTimeoutMs=300000`、`dreamTimeoutMs=600000`，env分别为`VERA_CODEX_CHAT_SANDBOX`、`VERA_CODEX_MAX_INPUT_BYTES`、`VERA_CODEX_WATCHDOG_MS`、`VERA_CODEX_MEMORY_DIGEST_TIMEOUT_MS`、`VERA_CODEX_MEMORY_DREAM_TIMEOUT_MS`。`chatSandbox`只允许`read-only/workspace-write`，真实smoke可在空临时cwd显式覆盖为`read-only`；不得允许`danger-full-access`或危险bypass。`maxInputBytes`是请求前保守UTF-8容量门槛，不伪装成provider tokenizer计数。

本机Gemma是另一条独立Account：`kind=api, provider=ollama, model=gemma4:e4b`，由原生Ollama adapter直接调用Account`connection.baseUrl`。它不经过OpenCode，也不持有opaque canonical history：gateway在每个main Run提供已裁剪的`messages + historyVersion`，成功后由gateway以CAS追加规范turn；isolated subagent只收一次性messages且不带historyVersion。该adapter仍必须同时实现聊天与隔离Digest能力。

Ollama容量与超时走gateway运行配置，不进Account API/Settings UI：`numCtx=16384`、`maxInputBytes=12000`、`watchdogMs=1800000`、`digestTimeoutMs=300000`、`dreamTimeoutMs=600000`，env分别为`VERA_OLLAMA_NUM_CTX`、`VERA_OLLAMA_MAX_INPUT_BYTES`、`VERA_OLLAMA_WATCHDOG_MS`、`VERA_OLLAMA_MEMORY_DIGEST_TIMEOUT_MS`、`VERA_OLLAMA_MEMORY_DREAM_TIMEOUT_MS`。聊天只使用`account.model`并保留provider默认sampling；隔离Digest/Dream请求只使用gateway冻结的`taskModel`，固定`temperature=0`以降低同一资格夹具的随机漂移，但这不替代逐任务、逐模型语义测试。`maxInputBytes`是请求前的保守UTF-8 byte容量门槛，不伪装成provider tokenizer精确计数；它必须与真实smoke验证的`num_ctx`组合使用，不得单独调大绕过截断闸门。

Ollama 0.23.2实测会在把Vera完整proposal schema转换为grammar时被`oneOf`/`patternProperties`/部分`pattern`组合触发进程崩溃。Ollama adapter必须把gateway权威`proposalSchema`下沉为该版本可接受的统一扁平transport shape：所有action共享必填占位字段，adapter只按action确定性移除无关空字段，不补写或改写任何被Vera validator使用的语义值；禁止把已知不兼容关键字原样发送。扁平shape中的target二选一仍必须保持权威语义：catalog条目有非空`factId`时只填`targetFactId`且`targetMemorySlug`占位为空，只有`unmapped:true/factId:null`条目才只填`targetMemorySlug`且`targetFactId`占位为空；两者同时非空不得由adapter猜测或修复，必须交由完整validator拒绝。该下沉与规范化只负责provider传输兼容，不改变Vera proposal契约。模型返回后仍必须由gateway完整proposal validator复核，provider返回200或合法JSON不等于写入合法。未来Ollama版本只有通过1.2的schema能力探针和真实smoke后才能放宽下沉规则，不能按版本号猜测。

OpenCode Memory digest的额度后备逻辑与运行配置映射作为暂停代码保留，不进入Account API或Settings UI，也不在当前生产dispatch中生效。若未来另行授权恢复，仍只允许在402/403/429结构化错误的`code/type`精确为`insufficient_quota`、`quota_exhausted`或`quota_exceeded`时规范化为`quota_exhausted`，丢弃primary残片并用相同不可变payload在新session中重试一次；HTTP状态或自由文本本身不是额度证据。取消、超时、网络、认证、模型不存在、普通rate limit、provider 5xx、坏JSON或非法proposal均不得fallback。聊天`run(ctx)`始终只使用`account.model`且不读取该映射。当前OpenCode digest在进入这些逻辑前即由gateway明确`executor_unavailable`。

因此，daemon 是一个 Agent 的长连接执行宿主，可同时管理多个已授权 Account 的独立 runtime；登录用于拉齐“这个 Agent 可驾驶哪些 Account”，不是把整个 Agent 切换到某个 Account。

**Gateway 与 daemon 的职责切分（Phase 5.5目标形态）**：下表不描述Phase 2–5当前进程内承载，现状差异以附录A为准。

| 职责 | Gateway | Daemon |
|---|---|---|
| 持久化（SpaceSession、AgentSession、API history/checkpoint、消息、Run、Activity、Approval、CLI binding、vault） | ✅ | ❌ |
| 编译层（群聊视角 promptText） | ✅ | ❌（不回头读 store 拼群状态） |
| 触发判定（responseMode / 离线跳过 / blockAgentIds） | ✅ | ❌ |
| Account.presence（在线/离线） | ✅ 维护 | ✅ 心跳维持 |
| CLI/API 进程的 spawn 与生命周期 | ❌ | ✅（per Account runtime） |
| 本机Tools（文件/进程）、第三方MCP、Hook、Agent Plugin执行 | ❌ | ✅（在 Execution 绑定 Account 的 workspace 与权限策略内） |
| Vera Memory MCP server / vault / 单写队列 | ✅ | ❌（daemon仅作绑定agent身份的MCP client或CLI映射器） |
| RuntimeCapabilities公开快照 | ✅ 按 Account 暂存/提供给前端 | ✅ 登录时按 Account 如实报告 |
| SpaceSession/AgentSession/generation/compact/new真值 | ✅ | ❌ |
| API规范history | ✅（裁剪并随Run下发） | ❌（只翻译provider协议，不持久化副本） |
| CLI外部thread生命周期 | 持有versioned provider binding与checkpoint | ✅（spawn/resume/native compact并CAS同步binding） |

上表中的“MCP”默认指第三方或本机MCP；Vera Memory MCP是gateway第一方能力，不属于Account Workspace。Phase 5先实现只接受可信内部`agentId/run/source`上下文的tool dispatcher；Phase 5.5 agent token落地后再绑定私网Streamable HTTP transport。daemon不得在tool参数中提交或切换`agentId`，subagent Execution即使换Account也沿用同一Agent的Memory MCP身份。

### 1.2 Provider adapter 创建与一致性规范

本节规范“如何接一个新provider”，目的是把可重复的边界错误前移到固定验收，不承诺消除provider/version自身的协议差异。

**adapter复用单位**：adapter对应一套真实的provider协议与运行生命周期，不对应单个Account、endpoint或model。多个Ollama Account和`gemma4:e4b`、Qwen、Llama等模型共用一个`ollama` adapter；多个OpenCode Account和模型共用一个`opencode` adapter；多个Codex Account和模型共用一个`codex` adapter。鉴权值、base URL、model及可配置参数能仅靠Account/config数据表达、无需在共享代码中按provider名称分支时，应复用既有adapter。若stream帧、会话连续性、tool loop、错误形状、取消清理或structured-output下沉需要provider专属解析与状态机，则新建该provider adapter。不得为单个模型复制adapter，也不得用兼容别名把两个协议伪装成同一provider。

**第一版结构保持显式**：当前形态使用`src/adapters/<provider>-adapter.js`与镜像的`test/adapters/<provider>-adapter.test.js`，由`server.js`显式import并加入普通`provider -> adapter`对象。不得增加`BaseAdapter`、动态注册表、capability DSL或尚无第二个真实用例的`openai-compatible`抽象；未来daemon只迁移承载位置，以下provider翻译、会话、错误和安全语义不变。

每个adapter文件开头必须用短注释声明并由测试覆盖：

- 接受的Account `kind/provider`，错配必须在发请求前fail-fast；
- transport与已实测provider/runtime版本；
- 会话连续性能力（CLI外部thread/resume binding，或gateway-owned `gateway_history`）；adapter本身不得拥有API history；
- stream事件到`onDelta/onActivity`的映射；
- tool/Approval能力，或明确“无tool loop”；
- structured-output能力与需要下沉/禁用的JSON Schema关键字；
- provider/model的已验证上下文容量、容量配置方式与确定性history裁剪策略；
- 取消、超时、临时资源和`shutdown()`清理方式；
- provider错误到Vera错误码的映射，及是否存在经过契约批准的provider专属fallback。

**当前进程内factory行为**（Phase 5.5前有效）：

```js
createProviderAdapter({ config }) -> {
  run(ctx),              // 生产Account provider必需
  digestMemory?(input),  // 该Account连接/任务模型承担M2时必需
  dreamMemory?(input),   // 该Account连接/任务模型承担M4时必需
  shutdown?()
}
```

main `ctx`必须冻结`spaceSessionId,agentSessionId,contextGeneration,accountId,sessionMode:"main"`。subagent `ctx`冻结审计用`spaceSessionId/accountId,sessionMode:"isolated"`，但`agentSessionId/contextGeneration`为null，且没有持久history/binding callbacks。`ctx.prompt={text?,turnText?,historyUserText?,residentBlock?,retrievalBlock?,apiMessages?}`：CLI input只消费完整`text`与main generation的可选`providerBinding`；API input只消费gateway已按容量编译的`apiMessages`与main Run的`historyVersion`。两种input互斥，daemon/adapter不得维护第二份canonical API history。旧`historyEnvelopeText`在P5-C1迁移后删除。唯一例外是CLI provider在尚未产出任何reply Message前明确确认binding `missing/invalid`：该main Run可通过下述gateway callback原子换到下一generation并重新编译一次prompt；Run记录同步更新为新generation，旧generation保持只读。除此之外Run不得中途换代。

CLI adapter只有明确确认thread/resume id missing或invalid时，才能调用`ctx.rotateProviderBinding({reason:"missing"|"invalid"})`；gateway幂等生成checkpoint、令generation+1、换代Recall sidecar并返回新prompt，adapter再创建新外部会话并通过`persistProviderBinding(state,ifVersion)`做CAS。普通network/provider错误不得换代。API adapter不存在该callback，也不得以history形状错误清空Vera历史。

- `run(ctx)`必须按provider顺序把输入恰好一次交给`onDelta`。CLI返回`{content,providerBinding?}`；API返回`{content,usage?,toolTranscript?}`。进程内形态由gateway直接以`historyVersion` CAS追加完整turn；daemon形态必须先定稿reply Messages，再调用专用`api-result`端点提交`assistantMessageIds/toolTranscript/usage`。API main Run只有CAS成功后才能completed；`history_conflict`时history零变化、Run失败且不得重调provider。isolated subagent不提交API history。adapter不得保存、返回或同步API完整history。
- adapter不得依赖provider静默截断。gateway在Run前按AgentSession容量水位执行compact并给API bounded messages；CLI到hard水位也必须先完成native compact或checkpoint+新thread。仍放不下当前消息时明确`context_capacity`，不得丢当前prompt。Digest/Dream payload仍不可裁剪。
- 任何可作为Home Account聊天provider的adapter都必须实现`run(ctx)`；不能为了Memory整理新建digest-only或dream-only provider。`digestMemory`/`dreamMemory`可以是可选能力，但某一精确provider/runtime/taskModel要承担对应任务时必须实现并通过该任务资格，否则明确`executor_unavailable`。
- adapter不得读写gateway store、Memory Provider或Space状态，也不得自行选择另一个Account/model重试。它只翻译当前Account、gateway冻结的`taskModel`和ctx/payload；provider专属fallback必须先写入本文，并且不能影响聊天模型或下一job。Digest与Dream默认均无fallback。

**structured-output下沉**：gateway给出的完整`proposalSchema`和`validateDigestProposals`始终是唯一写入权威。adapter可以根据已实测provider能力生成兼容的transport schema，例如去掉Ollama 0.23.2会崩溃的组合关键字，保留根对象、字段类型、允许action和基础结构约束；但不得用测试专用`const`把真实action或字段值锁死，不得修改冻结payload，也不得把简化schema当成最终校验。完整schema不在用户prompt中重复。provider的200、合法JSON或transport schema通过都只能产生待gateway复核的proposal；坏JSON/坏envelope归adapter执行失败，合法envelope但proposal违反完整契约时由gateway以`invalid_proposal`拒绝且vault零变化。

**错误、取消和secret**：

- chat run只向gateway抛`cancelled/timed_out/unavailable/provider_error/internal`语义。Memory task错误继续折叠为安全code。provider原始body、含凭证URL、header、key和宿主路径不得进入公共错误、日志、AgentSession、provider binding或API响应。
- 必测pre-abort与mid-flight abort。HTTP adapter中断fetch/stream reader，CLI adapter终止完整进程树；两者都必须在`finally`移除listener/timer并清理临时session/目录。`shutdown()`若存在必须幂等且等待在飞清理或明确取消。
- secret只在可信控制层按`connection.secretRef`解析并放入provider请求；不得进入prompt、回调、activity或测试快照。chat只上报provider真实tool事件并遵守Approval；digest一律无Tools/Workspace。API provider没有本地tool loop时不得宣称`fs.*`或`process.execute`能力。

**每个新adapter的三层合入闸门**：

1. **stub协议单测（必跑、无真实服务）**：固定覆盖kind/provider错配、首轮与续轮、失效会话、碎片化stream顺序、content兜底、provider错误归一、pre/mid abort、timeout、secret不外泄、临时资源与幂等shutdown，以及容量边界下确定history裁剪且当前prompt不得静默丢失。实现`digestMemory`时再覆盖独立session/history、无Tools/Workspace、不可变payload容量边界、transport schema兼容快照、合法envelope、坏JSON/坏结构、取消和超时；gateway权威validator的create/update/supersede/archive/skip与非法proposal零写入仍由Memory pipeline测试负责，adapter测试不得复制第二套validator。
2. **临时gateway黑盒（必跑）**：使用临时data/vault和固定fixture，经真实Account路由验证聊天delta、AgentSession generation、CLI binding/API history与digest job安全摘要、失败零写入；不得连接真实用户数据或借另一个adapter完成请求。
3. **真实provider/model资格（显式执行、普通`npm test`默认skip）**：每个provider/runtime版本至少运行一次chat；每个拟承担digest的精确model/tag/量化变体都必须跑同一固定raw语义夹具与一次digest，记录model不可变标识、transport、版本、容量配置、耗时与安全摘要。夹具至少覆盖可复用create、无复用价值、无来源推断、Agent自创偏好、同事实复用与明确纠错；断言实际直连该provider且当前prompt/digest payload未被静默截断。每个拟承担dream的精确模型还必须独立跑M4 maintenance夹具，覆盖keep/update/merge/archive、来源/双链保留、重复执行幂等与错误归档可恢复；Digest资格不自动授予Dream资格，反之亦然。另跑版本相关能力探针，至少覆盖模型可用、stream、abort和本adapter实际会发送的JSON Schema安全子集。已知可能令provider崩溃的关键字只能在可丢弃的隔离实例做能力探针，不得向共享/常驻实例盲测。一个模型通过不自动认证同adapter下其他模型；真实smoke不能被stub替代，也不得成为发现基础接口错误的第一层手段。

只有三层均通过，才能在`plan.md`把该adapter标为可用。provider升级若改变stream、错误或Schema能力，先重跑真实能力探针；失败时收紧该adapter的provider profile，不改gateway权威契约，也不把临时兼容分支扩散到其他adapter。

### 1.3 AgentSession上下文与压缩适配

- Vera/gateway始终拥有SpaceSession、AgentSession、generation、checkpoint、context pressure和provider binding元数据真值。Run进入provider执行时冻结这些ID；除1.2冻结的“CLI binding在首个reply前明确missing/invalid”单次换代外，完成时只有匹配generation/version的结果可以提交，旧Run不得覆盖新窗口。
- adapter profile必须声明已验证`contextWindowTokens`、usage来源与compact能力：`native`表示可在现有CLI thread可靠压缩，`checkpoint_new_binding`表示需由gateway从可见历史生成checkpoint后开新thread，`gateway_history`只用于API。默认warning/auto/hard为70%/80%/95%，覆盖值必须严格递增。
- API daemon收到的是gateway已编译的bounded messages；每个main Run的稳定history turn由当前trigger Message最小署名input（无论author是user还是其他Agent）+本Agent assistant+provider确需的安全tool call/result组成，不含累计群聊声告、Activity、隐藏思维、常驻Memory索引或旧Recall投影。daemon只翻译provider协议、tool loop、stream和安全usage，最终turn由gateway在`api-result` CAS时构造。
- CLI native compact成功后仍必须由gateway提交新generation并冻结旧Recall sidecar；native compact失败保持旧generation。无native compact时，gateway生成checkpoint并创建新generation，daemon在新的external thread投递checkpoint+最近完整轮次。任何方式都不把compact结果写入长期Memory。
- 自动compact只作用于达到水位的单个AgentSession；手动裸`/compact`在群聊目标为全部当前seats，但每个Agent独立成功/失败。目标Agent compact期间其新Run排队，其他Agent继续工作。
- `/new`由gateway在没有active Run/compact时原子归档当前SpaceSession及全部AgentSessions/bindings并创建新窗口；daemon不能自行解释`/new`文本，也不能resume归档binding。
- compact由gateway创建target并冻结`agentSessionId/fromGeneration/accountId/mode`、Message高水位及已排在compact前面的active Run ids；后续pending Run的trigger不得渗入本次source，排在前面的Run完成后按完整轮次纳入。target取得该Home Account的同一排他租约；compact不是Run，但租约期间不得有其他Execution。随后gateway向daemon发`agent-session.compact.requested`：`native`只给CLI安全binding，成功结果返回同一thread压缩后的binding并由gateway挂到`generation+1`；`checkpoint_new_binding`和`gateway_history`只给裁剪后的compaction source与checkpoint schema，daemon使用当前Account做隔离、无Tools的总结并只返回checkpoint，新generation不继承binding，CLI在下一main Run建立新thread，API由gateway用checkpoint+最近完整turn构造新history。结果走专用compaction target端点CAS；失败保持旧generation并释放租约。compact请求/结果不走聊天delta、Message、Activity、Digest或Dream。

## 二、Daemon 接入协议

### 2.1 登录

```http
POST /api/agent/login
Authorization: Bearer <vera-agent-token>
```

base URL 必须是 VPS 的 Tailscale MagicDNS / `*.ts.net` HTTPS 私网地址。tailnet ACL 是网络门禁，Bearer token 是 agent 身份；Vera 不配置公网域名或公网 fallback。不再发送 Cloudflare Access Service Token 头。

请求body：

```json
{
  "homeAccountId": "acc_home…",
  "accountRuntimes": [
    {
      "accountId": "acc_home…",
      "workspace": {
        "hostId": "host_local_mac",
        "path": "/srv/vera/workspaces/home",
        "status": "ready",
        "policy": {},
        "lastValidatedAt": "…"
      },
      "runtimeCapabilities": {
        "tools": [
          { "name": "web.search", "source": "native", "scope": "network" },
          { "name": "fs.read", "source": "daemon", "scope": "workspace" },
          { "name": "fs.write", "source": "daemon", "scope": "workspace", "approval": "onRequest" },
          { "name": "process.execute", "source": "native", "scope": "workspace", "approval": "onRequest" }
        ],
        "extensions": ["skill", "mcp", "hook", "agentPlugin"]
      }
    }
  ]
}
```

`homeAccountId`可省略（缺省为token对应Agent的Home Account）。`accountRuntimes`只声明该daemon当前真实承载的Account runtime；每个`accountId`必须属于该Agent或已在`authorizedAgentIds`中授权，同一`accountId`不得重复声明或带不同Workspace。`workspace.hostId/path/status/policy/lastValidatedAt`与api-contract Workspace形状一致；gateway对未授权或绑定冲突的Account整个拒绝，不做部分登录。

`runtimeCapabilities` 是该 Account runtime 在本次 daemon 会话中的临时事实：`source` 为 `native` / `provider` / `daemon`，tool `name` 是可扩展命名空间字符串；基础标准名见 ground truth 4.2.1。availability 不等于 authorization，最终执行仍受 Vera 保存的 tool policy、workspace 边界与 Approval 约束。daemon 不得为了让 UI 好看而上报实际不可调用的能力。

```json
// 200 响应
{
  "agent": { …Agent… },
  "homeAccountId": "acc_home…",
  "accounts": [{ …Account… }],
  "seats": [
    { "spaceId": "spc_…", "agentId": "agt_…", "responseMode": "default", "respondTo": ["user"], "blockAgentIds": [] }
  ],
  "providerBindings": [
    {"agentSessionId":"ags_…","generation":1,"accountId":"acc_home…","version":"opaque","providerState":{"threadId":"…"}}
  ],
  "accountRuntimes": [
    {
      "accountId": "acc_home…",
      "workspace": {
        "hostId": "host_local_mac",
        "path": "/srv/vera/workspaces/home",
        "status": "ready",
        "policy": {},
        "lastValidatedAt": "…"
      },
      "runtimeCapabilities": { "tools": [ … ], "extensions": [ … ] }
    }
  ],
  "heartbeatIntervalMs": 15000
}
```

gateway 只在该登录 session 期间按 Account 暂存并公开 `runtimeCapabilities`；daemon 登出/离线后前端将对应 Account 的能力显示为不可用，不写回 Account 持久记录。CLI 已有的原生 Tools 由 daemon 报告而不是在 Vera 重复安装；API 型 daemon 若要访问本机代码，必须自己实现 provider tool-call 循环并在该 Account 唯一 Workspace 内执行受限 Tools。纯远程 API、无本地 daemon 时不得报告 `fs.*` 或 `process.execute`。

gateway 把本次成功登记的各 Account.presence 置 `online` + `lastSeenAt=now`，并逐条广播 `account.presence.updated` SSE。

### 2.2 SSE 订阅

```http
GET /api/agent/events
Authorization: Bearer <vera-agent-token>
Accept: text/event-stream
```

单一长连接，daemon 不区分 Space 全收。事件类型：

| 事件 | data | daemon 处理 |
|---|---|---|
| `agent.heartbeat` | `{ ts }` | 收到即更新本地"上次心跳时间"；连续 3 次未收到（默认 45s） → 触发自杀 |
| `run.requested` | `{run,triggerMessage,agent,account,workspace,input}`；input按kind严格分型 | 校验 `run.accountId === account.id` 且租约已授予此Run。CLI只接受`{kind:"cli",sessionMode,promptText,providerBinding?}`；API只接受`{kind:"api",sessionMode,messages,historyVersion?}`；字段混用即拒绝并报`internal` |
| `agent-session.compact.requested` | `{jobId,target:{agentId,agentSessionId,fromGeneration,mode},account,input}` | 校验target/account/租约与当前generation；按native或隔离checkpoint模式执行，禁止产生聊天输出，再调用专用compaction result端点 |
| `account.upserted` / `space.updated` / `agent.updated` | 同 `/api/events` 一致 | 更新本地缓存的 seat / 配置；不影响在飞 run |
| `account.presence.updated` | `{ accountId, presence, lastSeenAt }` | 知悉其他 agent 上下线（daemon 之间不直接通讯，仅供本地展示/调试） |
| `stream.reset` | `{}` | 重新 `POST /api/agent/login` 拉齐 |

**run.requested上下文**：

- gateway的编译层先生成同一语义结果，再按Account provider分型wire。daemon **不回头读store拼群状态**。
- CLI型只接收`input.kind="cli"`的`promptText + providerBinding?`；main只允许resume当前AgentSession generation，isolated subagent必须开临时thread且不得回传binding。
- API型只接收`input.kind="api"`的`messages + historyVersion?`；main必须带historyVersion，isolated subagent不得带。daemon不得自行从opaque state派生、追加或同步history。

### 2.3 Run 生命周期

gateway先创建`pending` Run；取得目标Account租约后原子改为`running`、广播`run.started`并向对应daemon发送`run.requested`。daemon收到的是已存在且已获租约的Run，不得再次POST创建/认领；它直接跑CLI/API并流式上报：

每条Run就是一个Execution，`accountId`创建后不可修改。主Run绑定Home Account；在飞父Run若需subagent，调用`POST /api/agent/runs/:id/subagents`提交目标`accountId`、任务包与必要上下文。gateway创建带`parentRunId`的pending子Run；目标Account空闲后再取得租约并下发。daemon不得自行换Account重试。

| 阶段 | daemon 调用 | gateway 行为 |
|---|---|---|
| 派生subagent | 父Run调用`POST /api/agent/runs/:id/subagents` body `{ accountId, task, context? }` | 验证父Run租约与目标Account授权，创建`agentSessionId/contextGeneration:null`的pending子Run；下发`sessionMode:"isolated"`，取得目标租约后广播`run.started`并发`run.requested` |
| 流式增量 | `POST /api/agent/runs/:id/delta` body `{ delta }` | 转 `message.delta` SSE（gateway 按段落边界切气泡，daemon 不切） |
| 创建气泡 | `POST /api/agent/runs/:id/messages` body Message 形状去 `id/runId/createdAt/status` | 落地 Message（`status: "streaming"`）、广播 `message.created` |
| 气泡定稿 | daemon 在切分点发出 `POST .../messages` 后用 `PATCH .../messages/:id` 设 `status: "completed"`（或 gateway 检测到 delta 间隙自动定稿，见下） | 广播 `message.completed` |
| Activity | `POST /api/agent/runs/:id/activities` body `{ phase, label, detail, toolStatus?, callId? }` | 同 callId 合并同一条；广播 `activity.created` / `activity.updated` |
| Approval | `POST /api/agent/runs/:id/approvals` body `{ prompt, options }` | 落地 Approval、广播 `approval.requested`；用户答复后 gateway 通过 SSE `approval.answered` 推给 daemon |
| API结果提交 | API main Run在气泡定稿后调用`PUT /api/agent/runs/:id/api-result` body `{agentSessionId,generation,baseHistoryVersion,assistantMessageIds,toolTranscript?,usage?}` | 从权威Message构造assistant，与trigger署名input作为完整turn做CAS；成功返回新historyVersion。409 `history_conflict`时history不变且Run必须failed，不重调provider |
| 结束 | `PATCH /api/agent/runs/:id` body `{ status, error?, agentState? }` | CLI main、isolated subagent可在输出完成后结束；API main只有`api-result`成功后才接受completed。落地结束状态、广播 `run.ended` |
| CLI binding同步 | `PUT /api/agent/provider-bindings/:agentSessionId` body `{generation,accountId,providerFingerprint,providerState,ifVersion}` | 校验token/租约/generation并CAS持久化；API不得调用 |
| compact结果 | `PUT /api/agent/compactions/:jobId/targets/:agentId` body `{agentSessionId,fromGeneration,status,checkpoint?,providerBinding?,error?}` | 按冻结mode校验字段并CAS提交新generation；完全相同重试幂等，失败保留旧generation |

**气泡切分权**：仍由 gateway 的 bubble-stream 做（api-contract.md Message 多气泡规则），daemon 只发 delta + 偶尔的"段落已结束"信号（`POST .../delta` body `{ delta: "", paragraphEnd: true }`），gateway 据此切气泡。daemon 不直接切气泡。

### 2.4 主动登出

```http
DELETE /api/agent/sessions
Authorization: Bearer <vera-agent-token>
```

gateway把presence置`offline`、释放Execution租约并保留AgentSessions与CLI provider bindings。daemon再上线时只取回可恢复的CLI bindings；API history始终留在gateway。

登出是整个 daemon 会话的结束，不是切换 Execution Account 的手段。Execution 选择 Account 只能通过创建 Run 时的不可变 `accountId`完成；不存在“登出 Home Account → 整个 Agent 用另一 Account 重登”协议。

### 2.5 失联与自杀（防 token 烧穿）

- gateway 每 `agentDaemon.heartbeatIntervalMs`（默认 15s，可配）在 SSE 通道发 `agent.heartbeat`。
- daemon 跟踪本地"距上次心跳时间"。**连续 3 个心跳间隔未收到（默认 45s）→ 立即停所有在飞 run（向 gateway PATCH 一次 `status: "failed", error: { code: "internal", message: "gateway unreachable" }` 然后立刻 `exit(0)`）**。
- launchd/systemd unit 配 `KeepAlive.SuccessfulExit=false` / `Restart=on-failure`：daemon `exit(0)` 视为正常退出不自动拉起；崩溃才起。
- 唯一可能烧 token 的窗口 = "心跳缺失瞬间正在跑的那一条 run"。损失被框死在该 run 已花的部分。无"反复撞网关"场景。
- **未来 `missionMode` 扩展位**：gateway 通过特殊 prompt "你被授权做 X 直到 gateway 恢复" 让 daemon 进入 mission 模式（`daemon.missionMode = true`），心跳缺失不自杀，按任务自己跑完为止。MVP 不做。

## 三、错误契约

daemon 向 gateway 报 run 失败时 PATCH `error: { code, message }`：

| code | 语义 | 来源 |
|---|---|---|
| `cancelled` | 取消信号触发（gateway 通过 SSE 推 `run.cancelled` 或 daemon 自己取消） | daemon |
| `timed_out` | daemon 自管的看门狗到期 | daemon |
| `unavailable` | CLI 二进制缺失 / API key 无效 / 跑不起来 | daemon |
| `provider_error` | 供应商侧报错（限流、模型不存在…） | daemon |
| `internal` | daemon 内部异常 | daemon |
| `gateway_unreachable` | 心跳缺失自杀时的兜底状态 | daemon 自杀前 PATCH |

任何其他异常按 `internal` 处理。**错误必须上报，不得吞掉后假装 completed 返回空 content**。

`context_capacity`与`history_conflict`不是provider/daemon可自由上报的泛化错误：前者只由gateway容量与compact编排在下一main Run前产生；后者只由gateway的API history CAS产生。daemon收到对应HTTP冲突后按本契约把Run置failed，但不得改写code、清空history、换generation或重调provider。

## 四、行为规则

- **取消**：gateway 通过 SSE 推 `run.cancelled`（前端用户点了 cancel 按钮）→ daemon 监听该事件 → 中断当前 CLI 进程（SIGTERM 子进程树）→ PATCH `status: "cancelled"`。
- **超时**：daemon 自带看门狗（默认 30 分钟，per-provider 可配），gateway 不设外层超时。
- **隔离**：daemon 不得读其他 agent 的数据；gateway 在 `run.requested` 里给的 `promptText` 是它唯一该看的上下文。daemon 之间不直接通讯。
- **Execution 隔离**：main Run必须使用冻结的`spaceSessionId/agentSessionId/contextGeneration/accountId`；Workspace、secret与runtime取该Account，CLI binding取该AgentSession generation，API messages只取本Run payload。isolated subagent仅有审计用`spaceSessionId/accountId`，session字段为null，必须开临时provider上下文且终态销毁。不得因同属一个Agent混用Account或上下文。
- **spawn**：daemon 在本机 spawn CLI 一律走 `src/core/spawn.js` 同款的 PATH 修正 + kill 树逻辑（搬运参考，salvage-notes 第一节第 3 条）。daemon 是独立进程，可以从 Vera 仓库 import 这套工具。
- **无交互模式**：CLI 必须以无交互参数运行（opencode `--dangerously-skip-permissions`、CC print 模式、Codex `exec`等），**禁止让 CLI 弹出选项式提问**。Codex当前进程内adapter使用顶层`-a never`（必须位于`exec`前）使无法自动执行的动作直接回给模型；不得使用`--dangerously-bypass-approvals-and-sandbox`。Phase 5.5迁移后需要用户点头的危险操作再走`requestApproval`；其他问题让agent正常发消息问。
- **常驻资源**：CLI daemon（opencode serve）等长命资源是 daemon 内部实现细节，daemon 自己管空闲回收、SIGTERM 关停，gateway 不帮忙清理。
- **secrets**：API型Account的明文key只存在于当前Account runtime内存，不落日志、不进AgentSession、history或provider binding；`secretRef=null`表示provider无鉴权。
- **网络路径**：daemon 的 HTTP、SSE、心跳和重连全部固定走 Tailscale 私网 base URL。Mac 使用小火箭承载 Tailscale 时，daemon 不感知客户端品牌，只要求 MagicDNS、tailnet 路由与长连接真实可用；不得在私网失败时静默 fallback 到公网域名。
- **缓存纪律**（ground truth 6 技术约束）：
  - CLI型：在同一AgentSession generation复用provider binding；compact/new/明确失效后绝不resume旧binding。
  - API型：gateway维护稳定前缀、checkpoint与规范history，daemon只消费bounded messages；群聊声告与Recall保持volatile，不进稳定history。
- **编译层契约**：CLI的`promptText`与API的`messages`都由gateway编译；daemon不得回头读store拼群状态，也不得持有第二份API history。

## 五、映射示例（接口验收标准）

### 示例 A：OpenCode daemon 型

daemon启动后维护一个`opencode serve`进程；外部session id只存为当前AgentSession generation的CLI provider binding。

| 接口点 | 映射 |
|---|---|
| daemon 启动 | 从daemon宿主本机runtime配置解析OpenCode binary，Account只提供provider/model等逻辑信息 → 惰性起 `opencode serve` daemon → 健康 check 通过 → `POST /api/agent/login` |
| 收到 `run.requested` | 校验`run.agentSessionId/contextGeneration`与binding；存在则验证外部session，明确失效时请求gateway换代后新建并CAS保存binding；随后spawn runner |
| SSE poller | daemon 维护一条对 opencode daemon 的 SSE 长连接，按 `data.sessionID` 路由到对应在飞 run |
| 流式输出 | opencode SSE `message.part.delta` (field=text) → `POST /api/agent/runs/:id/delta` |
| Activity | opencode SSE `message.part.updated` (part.type=tool) → `POST /api/agent/runs/:id/activities`；`session.status busy` 用固定 callId 合并成一条原地更新 |
| 完成 | opencode SSE `session.idle` → PATCH run completed；若binding变化则CAS同步 |
| 会话失效 | 旧sessionID明确不存在 → `rotateProviderBinding`生成新generation/checkpoint → 新建外部session并CAS绑定 |
| 关停 | daemon 收到 `agent.heartbeat` 缺失 3 次 → 杀 opencode daemon + 杀在飞 runner 子进程 → PATCH run failed (gateway_unreachable) → exit(0) |

### 示例 B：Codex CLI resume 型

| 时机 | daemon 行为 |
|---|---|
| daemon启动 | 校验Account为`kind=cli, provider=codex`，从宿主runtime配置解析Codex binary与版本；Account只提供model等逻辑配置 |
| 首轮聊天 | 在Account Workspace以顶层`-a never -s workspace-write`启动`codex exec --json --output-last-message <tmp> -`，非空Account.model显式传`-m`；stdin写入完整`prompt.text` |
| 会话连续性 | `thread.started.thread_id`立即CAS为当前AgentSession generation的binding；续轮resume该thread，只对明确missing执行generation换代 |
| 流式与Activity | `item.completed`的`agent_message`按段上报delta；CLI没有逐token事件时不伪造。真实command/tool item按契约上报Activity |
| digest | 走独立ephemeral临时cwd，强制`--output-schema`，不resume聊天、不接Workspace/Tools；任何tool item使job失败 |
| 取消/关停 | Abort或timeout终止完整进程组，finally清理临时cwd/schema/output；shutdown幂等并取消仍在飞的子进程 |

### 示例 C：Claude Code resume 型

会话不常驻：每条消息一个`claude -p`进程，靠`--resume`复活；resume id是CLI provider binding。

| 接口点 | 映射 |
|---|---|
| daemon 启动 | `POST /api/agent/login`拉回active AgentSessions的CLI bindings |
| 收到 `run.requested` | 首次运行后CAS保存resume id；后续只resume匹配agentSessionId+generation的binding |
| 流式输出 | stream-json 的 assistant 文本增量 → `POST .../delta` |
| Activity | stream-json 的 tool_use / tool_result → `POST .../activities` |
| 完成 | 进程正常退出 → PATCH completed |
| 会话失效 | resume明确missing/invalid → 报gateway换代；gateway生成checkpoint与新generation后才无`--resume`重跑，并CAS保存新binding |
| 关停 | 心跳缺失 → 杀在飞 claude 进程 → PATCH failed → exit(0) |

### 示例 D：原生Ollama API型（Gemma，无CLI进程）

| 接口点 | 映射 |
|---|---|
| daemon 启动 | 校验Account为`kind=api, provider=ollama`，读取`connection.baseUrl`；`secretRef`允许为null；`POST /api/agent/login` |
| 收到 `run.requested` | 直接把gateway给出的bounded`messages`发`POST <baseUrl>/api/chat`，model只取`account.model`，不调用OpenCode也不读opaque history |
| 流式输出 | Ollama逐行JSON中的`message.content`非空片段按顺序各上报一次`POST .../delta`；`done:true`只结束，不重复正文 |
| Activity | 当前Ollama adapter无本地tool loop，不上报虚构tool Activity或`fs/process`能力 |
| 完成 | stream正常结束并定稿reply Messages → PUT `api-result`提交assistantMessageIds/安全usage/tool transcript；historyVersion CAS成功后再PATCH completed |
| 会话失效 | API无daemon history；historyVersion冲突由gateway拒绝旧结果，不允许清空历史重来 |
| 关停 | 心跳缺失或Run取消 → abort HTTP请求/reader → PATCH对应状态 → exit(0)；无常驻CLI进程可杀 |

### 示例 E：mock adapter（Phase 2 已实现，verify.mjs 使用）

回显两段落文本（验证多气泡），由测试AgentSession history保存自增轮次（验证Vera会话连续性），并演示同callId的tool activity原地更新。prompt触发词和Approval行为保持不变。

> **Phase 5.5 实施期间 mock 的位置**：mock adapter 当前是 gateway 同机模块，用于 verify.mjs 黑盒验收。联邦形态下 verify.mjs 需要额外加一个"mock daemon"模式——一个最小 daemon 进程实现 `/api/agent/*` 协议、用回声内容回 POST。Phase 5.5 落地时 verify.mjs 拆成两段：gateway 内部一致性测试保留 mock；端到端协议测试起 mock daemon。

两个示例对 gateway 呈现**完全相同**的接口行为（都是 daemon 通过 HTTP/SSE 说话）。若某个接口改动只有其中一型能自然实现，说明改动泄漏了生命周期假设，打回。

---

## 附录 A：当前进程内承载形态（Phase 2–5有效，Phase 5.5迁移后退役）

> 当前`src/adapters/*-adapter.js`与`src/spaces/run-controller.js`仍通过本接口执行Phase 2–5真实运行和测试；Phase 5.5只把同一provider driver迁入agent daemon，迁移验收完成后本承载形态才退役。1.2的行为、错误、安全与conformance规范在迁移前后都有效。

当前过渡形态：gateway进程内部显式加载adapter模块，`run-controller.js`的`executeRun`调用`adapter.run(ctx)`；CLI adapter可在gateway同机spawn进程，API adapter直接发HTTP请求。

```js
// Phase 5当前factory形状；Phase 5.5迁移承载位置后退役
export function createOpencodeAdapter({ config }) {
  return {
    async run(ctx) { /* spawn opencode run --attach ... */ },
    async digestMemory(input) { /* optional isolated structured execution */ },
    async shutdown() { /* kill daemon */ }
  };
}
```

以下是P5-C1迁移前的legacy调用形状，仅用于识别待删代码：`run(ctx)`曾接收`historyEnvelopeText/sessionState/persistSessionState/recompileForNewSession`并返回`sessionState`。迁移目标以1.2/1.3为准：CLI使用providerBinding，API使用gateway bounded messages；完成后删除legacy字段，不保留兼容别名。

**Phase 5.5联邦形态如何逐项翻译**：

| Phase 2–5当前进程内形态 | Phase 5.5 daemon对应 |
|---|---|
| `createOpencodeAdapter({ config })` | `scripts/agent-daemon.js`（独立进程，opencode daemon 在它内部管） |
| `createCodexAdapter({ config })` | `scripts/agent-daemon.js`内的Codex runtime（复用同一resume id和JSONL翻译规则） |
| `adapter.run(ctx)` | daemon 收 `run.requested` → spawn CLI → 走 run 生命周期 |
| `ctx.onDelta(text)` | `POST /api/agent/runs/:id/delta` |
| `ctx.onActivity(evt)` | `POST /api/agent/runs/:id/activities` |
| `ctx.requestApproval(req)` | `POST /api/agent/runs/:id/approvals` + 等 SSE `approval.answered` |
| legacy `ctx.persistSessionState(state)` | 删除；CLI改provider binding CAS；API不上传完整history，只用`api-result`提交本Run安全结果供gateway构造turn |
| `ctx.signal` (AbortSignal) | gateway SSE 推 `run.cancelled` → daemon 中断 |
| legacy `ctx.sessionState` | 删除；login只返CLI providerBindings |
| `adapter.shutdown()` | daemon `exit(0)` 时自管的资源回收（杀 CLI daemon 等） |
| `ctx.agent / ctx.account` | `run.requested`公共外壳的`agent/account`字段 |
| CLI `ctx.prompt.text` / `providerBinding` | `run.requested.input={kind:"cli",promptText,providerBinding?}` |
| API `ctx.prompt.apiMessages` / `historyVersion` | `run.requested.input={kind:"api",messages,historyVersion?}`；isolated subagent无historyVersion |

`digestMemory`/`dreamMemory`暂无可用的daemon wire对应。Phase 5.5必须先在本文冻结专用Memory job request/result内部通道、取消/超时、安全摘要、入队`memoryTaskSnapshot={ownerAgentId,executorAgentId,accountId,kind,provider,modelMode,taskModel,verificationId}`、无fallback语义及暂停的OpenCode状态，并完成迁移验收后，才能退役进程内Memory task adapter。`ownerAgentId`是Memory所属Agent；`executorAgentId`来自Data → Memory且`null`在入队时解析为owner，`accountId`固定为解析后executor的Home Account。gateway解析对应`taskModel`，daemon不得自行选择其他Agent、Account、provider或model。snapshot和wire只携带Account/连接的稳定指纹，不持久化或公开connection/secret；实际执行前连接变化导致资格指纹不匹配时明确`executor_unavailable`。该通道不得复用聊天`run.requested`、Message/Activity、AgentSession/checkpoint/API history或CLI provider binding，也不得携带Workspace或任一Agent的Memory/身份提示。wire冻结前，Memory job仍由Phase 2–5进程内adapter承载。

Phase 2–5形态的四类provider映射示例（OpenCode daemon / Codex CLI resume / Claude Code resume / 原生Ollama API）行为约束仍成立——Phase 5.5只把协议载体从"进程内函数调用"换成"HTTP/SSE 跨进程消息"。上述表格作为daemon实现的对照参考保留。

`docs/salvage-notes.md` 第五节记录的 cloudflared 边缘漂移假活是 2026-07-04 联邦决策的导火索；2026-07-11 纯私网修订直接移除了 cloudflared 与公网入口。历史只用于排查旧部署，不再建设 tunnel watchdog。
