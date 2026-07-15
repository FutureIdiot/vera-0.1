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
    │  收到 run.requested (含 promptText) → 在本机 spawn CLI / 调 API
    │  ↓
    │  流式输出 → POST /api/agent/runs/:id/delta
    │  activity   → POST /api/agent/runs/:id/activities
    │  气泡定稿   → POST /api/agent/runs/:id/messages
    │  approval   → POST /api/agent/runs/:id/approvals
    │  ↓
    │  run 结束: PATCH /api/agent/runs/:id (status=completed/failed/cancelled)
    │  备份会话: POST /api/agent/sync-state
    │  ↓
    │  心跳维持: gateway 每 15s 在同 SSE 通道发 agent.heartbeat
    │  失联: 3 次心跳丢失(~45s) → daemon exit(0)
    │
    ▼
Vera gateway (VPS, 7×24)
  - 消息中枢 + 状态库 + 持久化 (Space/Message/Run/Activity/Approval/sessionState/vault)
  - 编译层 (src/spaces/view-compiler.js) 给 daemon 现成的 promptText
  - Account.presence 维护
  - 离线 @ 直接发 error activity 跳过
```

### 1.1 Execution / Account 绑定模型

- **Execution 是一次实际执行单元，与 Run 1:1 对应**：gateway 每创建一条 Run，就为它选定且固定一个 `accountId`；Execution 开始后不得中途切换 Account。
- **主执行使用 Home Account**：Agent 在 Space 中回应用户的主 Run 默认绑定该 Agent 的 Home Account。Home Account 是主执行的默认驾驶位，不是 Agent 唯一能用的 Account。
- **subagent 可并行借用其他 Account**：主 Execution 派生的 subagent Execution 可绑定另一个 Account，但 token 对应的 `agentId` 必须在该 Account 的 `authorizedAgentIds` 中。授权只表示“可以申请使用”，不绕过 tool policy、Approval 与 workspace 边界。
- **Account 是活跃 Execution 的独占租约单元**：同一`accountId`同一时刻最多有一个`running` Execution；`pending`只表示排队，尚未持有租约。gateway在Run进入`running`前原子获取租约，在`completed`/`failed`/`cancelled`时释放；Account忙时必须排队或明确拒绝，不得通过“让整个Agent切换账户并重登”绕过。
- **Account 1:1 Workspace**：`workspacePath`、供应商会话、`sessionState`、RuntimeCapabilities 及 CLI/API 运行时数据都随 Account 走，不挂在 Agent 上。`sessionState` 的持久化键仍为 `(accountId, spaceId)`；同一 Account 不得声明多个 Workspace。
- **Memory 随 Agent，不随 Account**：主 Execution 与它派生的 subagent Execution 只要仍以同一 `agentId` 行动，就读取同一份 per-Agent Memory；更换 Execution 的 `accountId` 不复制、迁移或切换 Memory。
- **Memory任务与聊天 run 隔离**：M2 Digest任务接收gateway给出的确定性Message chunks、既有Memory安全投影和严格JSON proposal schema，只返回proposal；M4 Dream任务接收长期Memory快照、允许的派生统计和维护proposal schema。两者都是Memory Orchestrator为Memory所属`ownerAgentId`创建的隔离任务，不是Hook unit或聊天Execution；Data → Memory可为每类任务明确选择`executorAgentId`，`null`表示owner自身。可信adapter控制层只使用executor Agent的Home Account provider/connection与gateway已解析的`taskModel`作为执行路由，不得把executor的身份提示、聊天历史、Memory、`sessionState`、Workspace或Tools带入任务，也不得发Message/Activity或直接写store/Provider。adapter若不能提供对应任务所需的无工具、结构化、隔离执行能力，job明确失败为`executor_unavailable`，不得退化为普通聊天`run(ctx)`。

Memory模型任务的可选adapter方法为`digestMemory({ account, taskModel, payload, signal }) -> Promise<{ proposals, execution? }>`与M4的`dreamMemory({ account, taskModel, payload, signal }) -> Promise<{ proposals, execution? }>`。`account`固定为Data → Memory所选executor Agent的Home Account，只供可信adapter控制层读取`id/kind/provider/connection`与默认聊天`model`；`taskModel`是Memory Orchestrator按该任务的`modelMode: inherit | fixed`解析并通过对应资格记录校验后的实际模型：`inherit`取入队时executor Home Account的默认聊天模型，`fixed`可取同一Account连接下另一个已验证的低成本模型。adapter不得读取Hook/unit binding、查询或选择其他Agent/Account、自行改投或改写`taskModel`。

Digest的`payload.agent`始终是Memory所属owner Agent而不是executor Agent；完整`payload`严格为`{agent:{id,name},chunks,facts,proposalSchema}`。Dream完整`payload`严格为`{agent:{id,name},memories,proposalSchema}`，其中`memories`只含owner active Provider冻结的`slug/version/type/description/status/content/sources/links/derived`安全投影，最多256项且按gateway稳定批次选择；不含stain、query、vault路径或任一Agent提示。二者都是唯一可送入模型执行请求的内容，不含owner或executor Account、connection、secret、聊天提示、其他Memory、sessionState、workspacePath、回调或写能力；Digest中model可见`chunks`只含`{messages:[{messageId,author,target,content,createdAt}]}`，gateway内部chunk id/边界/计数不得进入adapter payload，避免与唯一合法证据标识`messageId`混淆。完整`proposalSchema`或由它确定性派生的provider-compatible transport schema必须经provider structured-output通道传递；完整Schema不在用户文本中重复序列化，且gateway完整validator始终是写入权威。实现必须使用独立无工具会话，遵守signal取消与配置超时，只返回可JSON序列化对象；`execution`若返回，只允许`{adapter,primaryModel,effectiveModel,fallbackUsed,fallbackReason,attempts}`安全路由元数据，其中`primaryModel/effectiveModel`都必须等于冻结`taskModel`且`fallbackUsed=false`。provider原始错误由对应Memory job service折叠为安全`executor_failed`。冻结的owner Agent、executor Agent Home Account与taskModel是该job唯一执行路由，不允许静默fallback。Digest的程序分块、Dream的批次选择与gateway/Provider提交是固定安全边界，不伪装成可替换adapter插件。adapter未实现对应方法时，该类任务明确`executor_unavailable`。

OpenCode实现只服务`kind=cli, provider=opencode`的Account，其聊天`run(ctx)`与既有digest代码继续保留；但OpenCode digest当前暂停生产dispatch、fallback与M2完成闸门，`provider=opencode`的Home Account提交digest时明确`executor_unavailable`，不得退化为聊天run。恢复前必须由用户另行授权并重新通过三层闸门。

Codex实现只服务`kind=cli, provider=codex`的Account，并同时实现聊天`run(ctx)`与隔离`digestMemory(...)`。聊天使用非交互`codex exec --json`，续轮使用`codex exec resume <threadId> --json`；prompt从stdin恰好投递一次，`thread.started.thread_id`立即持久化为`sessionState={threadId}`，只有明确thread不存在才上报`session-reset`并新建，普通provider失败不得重置。`item.completed`的`agent_message`按到达顺序映射`onDelta`，CLI未提供逐token事件时不得伪造；`command_execution`等真实tool item映射Activity。Account.model非空时必须显式传`-m`，为空则不传并使用Codex供应商默认模型。当前Codex Account要求`connection.args=[]`，不得借args覆盖sandbox/approval、注入危险bypass或改变Vera固定参数顺序；需要新的受控参数时先改本文再实现。

Codex digest/dream每次创建新的临时cwd/schema/output文件，使用`codex -C <temp> -a never -s read-only exec --ephemeral --ignore-user-config --ignore-rules --skip-git-repo-check --json --output-schema <schema> --output-last-message <output> -`，并以`-m <taskModel>`显式传入gateway冻结的任务模型，禁用CLI当前公开的shell/apps/multi-agent特性；绝不resume聊天thread，不传Account Workspace/connection.args，不创建Message/Activity。`--output-schema`接收gateway完整schema或经真实能力探针确认的确定性Codex-compatible投影；prompt不重复序列化schema，最终仍由gateway完整validator裁决。当前CLI没有单一“禁用全部工具”开关，因此可验证边界是空临时cwd、ephemeral、忽略用户配置/rules、read-only与never；JSONL一旦出现任何tool item即`executor_failed`且结果不得apply。Codex digest/dream无fallback。

Codex运行配置不进Account API/Settings UI：`chatSandbox=workspace-write`、`maxInputBytes=12000`、`watchdogMs=1800000`、`digestTimeoutMs=300000`、`dreamTimeoutMs=600000`，env分别为`VERA_CODEX_CHAT_SANDBOX`、`VERA_CODEX_MAX_INPUT_BYTES`、`VERA_CODEX_WATCHDOG_MS`、`VERA_CODEX_MEMORY_DIGEST_TIMEOUT_MS`、`VERA_CODEX_MEMORY_DREAM_TIMEOUT_MS`。`chatSandbox`只允许`read-only/workspace-write`，真实smoke可在空临时cwd显式覆盖为`read-only`；不得允许`danger-full-access`或危险bypass。`maxInputBytes`是请求前保守UTF-8容量门槛，不伪装成provider tokenizer计数。

本机Gemma是另一条独立Account：`kind=api, provider=ollama, model=gemma4:e4b`，由完整的原生Ollama adapter直接调用Account `connection.baseUrl`下的HTTP API，不经过OpenCode CLI/daemon，不共享Account、sessionState、连接或额度后备。该adapter必须同时实现聊天`run(ctx)`和隔离的`digestMemory(...)`，不得做成只能整理Memory的残缺provider。

Ollama容量与超时走gateway运行配置，不进Account API/Settings UI：`numCtx=16384`、`maxInputBytes=12000`、`watchdogMs=1800000`、`digestTimeoutMs=300000`、`dreamTimeoutMs=600000`，env分别为`VERA_OLLAMA_NUM_CTX`、`VERA_OLLAMA_MAX_INPUT_BYTES`、`VERA_OLLAMA_WATCHDOG_MS`、`VERA_OLLAMA_MEMORY_DIGEST_TIMEOUT_MS`、`VERA_OLLAMA_MEMORY_DREAM_TIMEOUT_MS`。聊天只使用`account.model`并保留provider默认sampling；隔离Digest/Dream请求只使用gateway冻结的`taskModel`，固定`temperature=0`以降低同一资格夹具的随机漂移，但这不替代逐任务、逐模型语义测试。`maxInputBytes`是请求前的保守UTF-8 byte容量门槛，不伪装成provider tokenizer精确计数；它必须与真实smoke验证的`num_ctx`组合使用，不得单独调大绕过截断闸门。

Ollama 0.23.2实测会在把Vera完整proposal schema转换为grammar时被`oneOf`/`patternProperties`/部分`pattern`组合触发进程崩溃。Ollama adapter必须把gateway权威`proposalSchema`下沉为该版本可接受的统一扁平transport shape：所有action共享必填占位字段，adapter只按action确定性移除无关空字段，不补写或改写任何被Vera validator使用的语义值；禁止把已知不兼容关键字原样发送。扁平shape中的target二选一仍必须保持权威语义：catalog条目有非空`factId`时只填`targetFactId`且`targetMemorySlug`占位为空，只有`unmapped:true/factId:null`条目才只填`targetMemorySlug`且`targetFactId`占位为空；两者同时非空不得由adapter猜测或修复，必须交由完整validator拒绝。该下沉与规范化只负责provider传输兼容，不改变Vera proposal契约。模型返回后仍必须由gateway完整proposal validator复核，provider返回200或合法JSON不等于写入合法。未来Ollama版本只有通过1.2的schema能力探针和真实smoke后才能放宽下沉规则，不能按版本号猜测。

OpenCode Memory digest的额度后备逻辑与运行配置映射作为暂停代码保留，不进入Account API或Settings UI，也不在当前生产dispatch中生效。若未来另行授权恢复，仍只允许在402/403/429结构化错误的`code/type`精确为`insufficient_quota`、`quota_exhausted`或`quota_exceeded`时规范化为`quota_exhausted`，丢弃primary残片并用相同不可变payload在新session中重试一次；HTTP状态或自由文本本身不是额度证据。取消、超时、网络、认证、模型不存在、普通rate limit、provider 5xx、坏JSON或非法proposal均不得fallback。聊天`run(ctx)`始终只使用`account.model`且不读取该映射。当前OpenCode digest在进入这些逻辑前即由gateway明确`executor_unavailable`。

因此，daemon 是一个 Agent 的长连接执行宿主，可同时管理多个已授权 Account 的独立 runtime；登录用于拉齐“这个 Agent 可驾驶哪些 Account”，不是把整个 Agent 切换到某个 Account。

**Gateway 与 daemon 的职责切分（Phase 5.5目标形态）**：下表不描述Phase 2–5当前进程内承载，现状差异以附录A为准。

| 职责 | Gateway | Daemon |
|---|---|---|
| 持久化（消息、Run、Activity、Approval、sessionState、vault） | ✅ | ❌ |
| 编译层（群聊视角 promptText） | ✅ | ❌（不回头读 store 拼群状态） |
| 触发判定（responseMode / 离线跳过 / blockAgentIds） | ✅ | ❌ |
| Account.presence（在线/离线） | ✅ 维护 | ✅ 心跳维持 |
| CLI/API 进程的 spawn 与生命周期 | ❌ | ✅（per Account runtime） |
| 本机Tools（文件/进程）、第三方MCP、Hook、Agent Plugin执行 | ❌ | ✅（在 Execution 绑定 Account 的 workspace 与权限策略内） |
| Vera Memory MCP server / vault / 单写队列 | ✅ | ❌（daemon仅作绑定agent身份的MCP client或CLI映射器） |
| RuntimeCapabilities公开快照 | ✅ 按 Account 暂存/提供给前端 | ✅ 登录时按 Account 如实报告 |
| 会话连续性具体实现（resume / daemon keepalive） | ❌ | ✅（agent 自己 spawn 的进程自己管） |
| sessionState 真值 | 按 `(accountId, spaceId)` 备份兜底 | 每个 Account runtime 在线时持有最新副本 |

上表中的“MCP”默认指第三方或本机MCP；Vera Memory MCP是gateway第一方能力，不属于Account Workspace。Phase 5先实现只接受可信内部`agentId/run/source`上下文的tool dispatcher；Phase 5.5 agent token落地后再绑定私网Streamable HTTP transport。daemon不得在tool参数中提交或切换`agentId`，subagent Execution即使换Account也沿用同一Agent的Memory MCP身份。

### 1.2 Provider adapter 创建与一致性规范

本节规范“如何接一个新provider”，目的是把可重复的边界错误前移到固定验收，不承诺消除provider/version自身的协议差异。

**adapter复用单位**：adapter对应一套真实的provider协议与运行生命周期，不对应单个Account、endpoint或model。多个Ollama Account和`gemma4:e4b`、Qwen、Llama等模型共用一个`ollama` adapter；多个OpenCode Account和模型共用一个`opencode` adapter；多个Codex Account和模型共用一个`codex` adapter。鉴权值、base URL、model及可配置参数能仅靠Account/config数据表达、无需在共享代码中按provider名称分支时，应复用既有adapter。若stream帧、会话连续性、tool loop、错误形状、取消清理或structured-output下沉需要provider专属解析与状态机，则新建该provider adapter。不得为单个模型复制adapter，也不得用兼容别名把两个协议伪装成同一provider。

**第一版结构保持显式**：当前形态使用`src/adapters/<provider>-adapter.js`与镜像的`test/adapters/<provider>-adapter.test.js`，由`server.js`显式import并加入普通`provider -> adapter`对象。不得增加`BaseAdapter`、动态注册表、capability DSL或尚无第二个真实用例的`openai-compatible`抽象；未来daemon只迁移承载位置，以下provider翻译、会话、错误和安全语义不变。

每个adapter文件开头必须用短注释声明并由测试覆盖：

- 接受的Account `kind/provider`，错配必须在发请求前fail-fast；
- transport与已实测provider/runtime版本；
- 会话连续性形态（外部session id、resume id或可序列化API history）；
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

`ctx.prompt`固定为`{text,turnText,historyUserText,historyEnvelopeText,residentBlock,retrievalBlock}`：`text`是CLI可直接投递的完整本轮输入；`turnText`不含常驻索引，固定为本轮群聊声告+触发正文+本轮Memory检索尾块；`historyUserText`只在触发者为用户时等于未注入的原始触发正文，否则为`null`；`historyEnvelopeText`是原始触发正文+检索尾块，不含常驻索引或群聊声告；`residentBlock`是当前可用的常驻索引稳定前缀，`retrievalBlock`是本轮volatile检索块或`null`。OpenCode/Codex等CLI adapter只消费`text`；API adapter使用`residentBlock + 稳定history + turnText`组帧，成功后把`historyEnvelopeText + assistant`加入稳定history，不得持久化群聊声告或完整`text`。

M3新增`ctx.recompileForNewSession({reason:"missing"|"invalid"}) -> Promise<ctx.prompt>`。adapter只能在已绑定当前Run且明确确认旧外部session无法续用时调用；普通provider/network错误不得调用。gateway对同一Run的第一次调用幂等地清空旧`(accountId,spaceId)` sessionState、换代独立Memory recall session、清空其已交付slug/cursor，再用同一条冻结trigger Message重编译当轮prompt；重复调用返回同一Promise/prompt，不再换代。callback不为adapter创建provider session，adapter随后仍经`persistSessionState`立即保存新session id/state。Codex只在非空state形状非法或明确missing thread时调用；OpenCode只在`sessionExists`明确返回false后、创建新session前调用；Ollama只在非空但形状非法的history state上调用。

- `run(ctx)`沿附录A入参与返回形状。adapter必须按provider顺序把每段文本恰好一次交给`onDelta`；若产生delta，其拼接文本必须与最终`content`语义一致，无delta时才允许仅以`content`兜底。`sessionState`必须是可JSON序列化的provider私有值：CLI通常保存外部session id，API通常保存稳定history；新会话建立后立即`persistSessionState`，结束时在返回值再次给出。失效会话必须明确报告`session-reset`后重建，不得静默丢上下文。sessionState不得含secret、临时目录或无需持久化的宿主绝对路径。
- adapter不得依赖provider静默截断当前`prompt.text`或digest payload。chat超限时只能按冻结规则确定性裁剪最旧history，不得丢当前prompt；即使清空history仍放不下时，必须在请求前明确失败，或使用已经真实smoke验证的provider容量配置（例如Ollama `num_ctx`）。digest payload是不可变输入，adapter不得自行丢chunks/facts/schema来适配容量；放不下就在provider请求前失败。
- 任何可作为Home Account聊天provider的adapter都必须实现`run(ctx)`；不能为了Memory整理新建digest-only或dream-only provider。`digestMemory`/`dreamMemory`可以是可选能力，但某一精确provider/runtime/taskModel要承担对应任务时必须实现并通过该任务资格，否则明确`executor_unavailable`。
- adapter不得读写gateway store、Memory Provider或Space状态，也不得自行选择另一个Account/model重试。它只翻译当前Account、gateway冻结的`taskModel`和ctx/payload；provider专属fallback必须先写入本文，并且不能影响聊天模型或下一job。Digest与Dream默认均无fallback。

**structured-output下沉**：gateway给出的完整`proposalSchema`和`validateDigestProposals`始终是唯一写入权威。adapter可以根据已实测provider能力生成兼容的transport schema，例如去掉Ollama 0.23.2会崩溃的组合关键字，保留根对象、字段类型、允许action和基础结构约束；但不得用测试专用`const`把真实action或字段值锁死，不得修改冻结payload，也不得把简化schema当成最终校验。完整schema不在用户prompt中重复。provider的200、合法JSON或transport schema通过都只能产生待gateway复核的proposal；坏JSON/坏envelope归adapter执行失败，合法envelope但proposal违反完整契约时由gateway以`invalid_proposal`拒绝且vault零变化。

**错误、取消和secret**：

- chat run只向gateway抛`cancelled/timed_out/unavailable/provider_error/internal`语义。digest adapter内部可区分`timed_out`，但digest service对公共job只保留`executor_unavailable`与`cancelled`，其他provider执行错误包括超时统一折叠为`executor_failed`。provider原始body、含凭证URL、header、key和宿主路径不得进入公共错误、日志、sessionState或API响应。
- 必测pre-abort与mid-flight abort。HTTP adapter中断fetch/stream reader，CLI adapter终止完整进程树；两者都必须在`finally`移除listener/timer并清理临时session/目录。`shutdown()`若存在必须幂等且等待在飞清理或明确取消。
- secret只在可信控制层按`connection.secretRef`解析并放入provider请求；不得进入prompt、回调、activity或测试快照。chat只上报provider真实tool事件并遵守Approval；digest一律无Tools/Workspace。API provider没有本地tool loop时不得宣称`fs.*`或`process.execute`能力。

**每个新adapter的三层合入闸门**：

1. **stub协议单测（必跑、无真实服务）**：固定覆盖kind/provider错配、首轮与续轮、失效会话、碎片化stream顺序、content兜底、provider错误归一、pre/mid abort、timeout、secret不外泄、临时资源与幂等shutdown，以及容量边界下确定history裁剪且当前prompt不得静默丢失。实现`digestMemory`时再覆盖独立session/history、无Tools/Workspace、不可变payload容量边界、transport schema兼容快照、合法envelope、坏JSON/坏结构、取消和超时；gateway权威validator的create/update/supersede/archive/skip与非法proposal零写入仍由Memory pipeline测试负责，adapter测试不得复制第二套validator。
2. **临时gateway黑盒（必跑）**：使用临时data/vault和固定fixture，经真实Account路由验证聊天delta/sessionState与digest job安全摘要、失败零写入；不得连接真实用户数据或借另一个adapter完成请求。
3. **真实provider/model资格（显式执行、普通`npm test`默认skip）**：每个provider/runtime版本至少运行一次chat；每个拟承担digest的精确model/tag/量化变体都必须跑同一固定raw语义夹具与一次digest，记录model不可变标识、transport、版本、容量配置、耗时与安全摘要。夹具至少覆盖可复用create、无复用价值、无来源推断、Agent自创偏好、同事实复用与明确纠错；断言实际直连该provider且当前prompt/digest payload未被静默截断。每个拟承担dream的精确模型还必须独立跑M4 maintenance夹具，覆盖keep/update/merge/archive、来源/双链保留、重复执行幂等与错误归档可恢复；Digest资格不自动授予Dream资格，反之亦然。另跑版本相关能力探针，至少覆盖模型可用、stream、abort和本adapter实际会发送的JSON Schema安全子集。已知可能令provider崩溃的关键字只能在可丢弃的隔离实例做能力探针，不得向共享/常驻实例盲测。一个模型通过不自动认证同adapter下其他模型；真实smoke不能被stub替代，也不得成为发现基础接口错误的第一层手段。

只有三层均通过，才能在`plan.md`把该adapter标为可用。provider升级若改变stream、错误或Schema能力，先重跑真实能力探针；失败时收紧该adapter的provider profile，不改gateway权威契约，也不把临时兼容分支扩散到其他adapter。

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
  "sessionStates": {
    "acc_home…:spc_…": <opaque>
  },
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
| `run.requested` | `{ run, triggerMessage, agent, account, promptText }` | 校验 `run.accountId === account.id` 且该 Account 租约已授予此 Run → 用该 Account runtime 解析 promptText → spawn CLI / 调 API → 走 run 生命周期 |
| `account.upserted` / `space.updated` / `agent.updated` | 同 `/api/events` 一致 | 更新本地缓存的 seat / 配置；不影响在飞 run |
| `account.presence.updated` | `{ accountId, presence, lastSeenAt }` | 知悉其他 agent 上下线（daemon 之间不直接通讯，仅供本地展示/调试） |
| `stream.reset` | `{}` | 重新 `POST /api/agent/login` 拉齐 |

**run.requested 关键字段 `promptText`**：

- gateway 的编译层（`src/spaces/view-compiler.js`，Phase 4.2）已把"该 agent 上次发言之后的他人气泡"聚合成署名声告段塞进 promptText 头部；长驻索引块也在头部；触发消息正文在尾部。
- daemon **不回头读 store 拼群状态**。把 promptText 直接当作"本轮 user 输入"喂给 CLI / API 即可。
- CLI 型：promptText 作为新轮 user message 追加进外部 session（sessionState 已存外部 session id，daemon 自管）。
- API 型：promptText 落在新 user message 尾部，system + 历史气泡由 daemon 自己从 sessionState 派生（仅本人 assistant 轮次 + 用户直接提问）。

### 2.3 Run 生命周期

gateway先创建`pending` Run；取得目标Account租约后原子改为`running`、广播`run.started`并向对应daemon发送`run.requested`。daemon收到的是已存在且已获租约的Run，不得再次POST创建/认领；它直接跑CLI/API并流式上报：

每条Run就是一个Execution，`accountId`创建后不可修改。主Run绑定Home Account；在飞父Run若需subagent，调用`POST /api/agent/runs/:id/subagents`提交目标`accountId`、任务包与必要上下文。gateway创建带`parentRunId`的pending子Run；目标Account空闲后再取得租约并下发。daemon不得自行换Account重试。

| 阶段 | daemon 调用 | gateway 行为 |
|---|---|---|
| 派生subagent | 父Run调用`POST /api/agent/runs/:id/subagents` body `{ accountId, task, context? }` | 验证父Run租约与目标Account授权，创建pending子Run；取得目标租约后广播`run.started`并发`run.requested` |
| 流式增量 | `POST /api/agent/runs/:id/delta` body `{ delta }` | 转 `message.delta` SSE（gateway 按段落边界切气泡，daemon 不切） |
| 创建气泡 | `POST /api/agent/runs/:id/messages` body Message 形状去 `id/runId/createdAt/status` | 落地 Message（`status: "streaming"`）、广播 `message.created` |
| 气泡定稿 | daemon 在切分点发出 `POST .../messages` 后用 `PATCH .../messages/:id` 设 `status: "completed"`（或 gateway 检测到 delta 间隙自动定稿，见下） | 广播 `message.completed` |
| Activity | `POST /api/agent/runs/:id/activities` body `{ phase, label, detail, toolStatus?, callId? }` | 同 callId 合并同一条；广播 `activity.created` / `activity.updated` |
| Approval | `POST /api/agent/runs/:id/approvals` body `{ prompt, options }` | 落地 Approval、广播 `approval.requested`；用户答复后 gateway 通过 SSE `approval.answered` 推给 daemon |
| 结束 | `PATCH /api/agent/runs/:id` body `{ status, error?, agentState? }` | 落地结束状态、广播 `run.ended`；如带 agentState 同步更新该 Space AgentState |
| sessionState 备份 | `POST /api/agent/sync-state` body `{ accountId, spaceId, sessionState }` | 原样持久化（per `(account, Space)` 键） |

**气泡切分权**：仍由 gateway 的 bubble-stream 做（api-contract.md Message 多气泡规则），daemon 只发 delta + 偶尔的"段落已结束"信号（`POST .../delta` body `{ delta: "", paragraphEnd: true }`），gateway 据此切气泡。daemon 不直接切气泡。

### 2.4 主动登出

```http
DELETE /api/agent/sessions
Authorization: Bearer <vera-agent-token>
```

gateway 把 presence 置 `offline` + `lastSeenAt=now`、广播 `account.presence.updated`。sessionState 不动。daemon 之后再上线时通过 `POST /api/agent/login` 响应里的 `sessionStates` 字段取回。

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

## 四、行为规则

- **取消**：gateway 通过 SSE 推 `run.cancelled`（前端用户点了 cancel 按钮）→ daemon 监听该事件 → 中断当前 CLI 进程（SIGTERM 子进程树）→ PATCH `status: "cancelled"`。
- **超时**：daemon 自带看门狗（默认 30 分钟，per-provider 可配），gateway 不设外层超时。
- **隔离**：daemon 不得读其他 agent 的数据；gateway 在 `run.requested` 里给的 `promptText` 是它唯一该看的上下文。daemon 之间不直接通讯。
- **Execution 隔离**：daemon 必须用 `run.accountId` 对应的唯一 Workspace、sessionState、secret 与 runtime 执行；不得因为同属一个 Agent 就混用两个 Account 的运行时数据。subagent 换 Account 不换 Agent Memory。
- **spawn**：daemon 在本机 spawn CLI 一律走 `src/core/spawn.js` 同款的 PATH 修正 + kill 树逻辑（搬运参考，salvage-notes 第一节第 3 条）。daemon 是独立进程，可以从 Vera 仓库 import 这套工具。
- **无交互模式**：CLI 必须以无交互参数运行（opencode `--dangerously-skip-permissions`、CC print 模式、Codex `exec`等），**禁止让 CLI 弹出选项式提问**。Codex当前进程内adapter使用顶层`-a never`（必须位于`exec`前）使无法自动执行的动作直接回给模型；不得使用`--dangerously-bypass-approvals-and-sandbox`。Phase 5.5迁移后需要用户点头的危险操作再走`requestApproval`；其他问题让agent正常发消息问。
- **常驻资源**：CLI daemon（opencode serve）等长命资源是 daemon 内部实现细节，daemon 自己管空闲回收、SIGTERM 关停，gateway 不帮忙清理。
- **secrets**：API型Account的`secretRef`非null时，daemon只能为当前Execution的`accountId`向gateway（或VPS本地`~/.vera/secrets.json`）换取明文key，只存在于该Account runtime内存，不落日志、不进sessionState；`secretRef=null`表示provider无鉴权（如本机Ollama），adapter不得虚构或复用其他Account凭据。
- **网络路径**：daemon 的 HTTP、SSE、心跳和重连全部固定走 Tailscale 私网 base URL。Mac 使用小火箭承载 Tailscale 时，daemon 不感知客户端品牌，只要求 MagicDNS、tailnet 路由与长连接真实可用；不得在私网失败时静默 fallback 到公网域名。
- **缓存纪律**（ground truth 6 技术约束）：
  - CLI 型：**必须复用会话**（sessionState 机制的本意）。禁止退化成"每条消息新开会话、把历史拼进 prompt 重放"——那样供应商侧 prompt cache 全部落空，多轮成本近似平方增长。
  - API 型：prompt 组装必须前缀稳定、只追加。system 提示与历史消息是稳定前缀；时间戳、AgentState 等动态内容只许放消息尾部；长期记忆注入采用版本化批量更新（记忆变更累积后一次性换版），不得逐条改写 system 提示。Anthropic 系设置 `cache_control` 断点。**重建历史气泡只放本人 assistant 轮次 + 用户直接对该 agent 的提问 user 轮次**——其他 agent 的气泡绝不进稳定历史，只以"群内最近发言"形式落在本轮新 user 消息尾部（ground truth 2.3 群聊视角注入形态）。
- **编译层契约**（ground truth 2.3 + 2.4）：gateway 给的 `promptText` 是"本轮应作为新 user 轮次投递的文本"，已含编译好的群内 delta + 长驻索引前缀。daemon **不得回头读 store 拼群状态**——所有需要的上下文已由 gateway 编译进 promptText，或来自 daemon 自身持有的 sessionState。这条让 daemon 各管各的协议形态、编译层保持薄。

## 五、映射示例（接口验收标准）

### 示例 A：OpenCode daemon 型

daemon 启动后在 daemon 那一侧维护一个 `opencode serve` 进程，sessionState 存外部会话 id。

| 接口点 | 映射 |
|---|---|
| daemon 启动 | 从daemon宿主本机runtime配置解析OpenCode binary，Account只提供provider/model等逻辑信息 → 惰性起 `opencode serve` daemon → 健康 check 通过 → `POST /api/agent/login` |
| 收到 `run.requested` | sessionState.externalSessionId 存在 → `GET /api/session/:id` 验证 → 失效则新建并 `POST /api/agent/sync-state` 备份 → spawn `opencode run --attach <daemonUrl> -c -s <sessionId> --dangerously-skip-permissions <promptText>` 短命子进程 |
| SSE poller | daemon 维护一条对 opencode daemon 的 SSE 长连接，按 `data.sessionID` 路由到对应在飞 run |
| 流式输出 | opencode SSE `message.part.delta` (field=text) → `POST /api/agent/runs/:id/delta` |
| Activity | opencode SSE `message.part.updated` (part.type=tool) → `POST /api/agent/runs/:id/activities`；`session.status busy` 用固定 callId 合并成一条原地更新 |
| 完成 | opencode SSE `session.idle` → PATCH run completed → POST sync-state |
| 会话失效 | opencode daemon 重启后旧 sessionID 不存在 → 新建会话 + 上报 `activity { phase: "error", label: "session-reset" }` → sync-state |
| 关停 | daemon 收到 `agent.heartbeat` 缺失 3 次 → 杀 opencode daemon + 杀在飞 runner 子进程 → PATCH run failed (gateway_unreachable) → exit(0) |

### 示例 B：Codex CLI resume 型

| 时机 | daemon 行为 |
|---|---|
| daemon启动 | 校验Account为`kind=cli, provider=codex`，从宿主runtime配置解析Codex binary与版本；Account只提供model等逻辑配置 |
| 首轮聊天 | 在Account Workspace以顶层`-a never -s workspace-write`启动`codex exec --json --output-last-message <tmp> -`，非空Account.model显式传`-m`；stdin写入完整`prompt.text` |
| 会话连续性 | JSONL `thread.started.thread_id`立即sync为`sessionState={threadId}`；续轮用`codex exec resume <threadId> --json ... -`，只对明确thread不存在执行session-reset |
| 流式与Activity | `item.completed`的`agent_message`按段上报delta；CLI没有逐token事件时不伪造。真实command/tool item按契约上报Activity |
| digest | 走独立ephemeral临时cwd，强制`--output-schema`，不resume聊天、不接Workspace/Tools；任何tool item使job失败 |
| 取消/关停 | Abort或timeout终止完整进程组，finally清理临时cwd/schema/output；shutdown幂等并取消仍在飞的子进程 |

### 示例 C：Claude Code resume 型

会话不常驻：每条消息一个 `claude -p` 进程，靠 `--resume` 复活上下文。sessionState 存 resume id。

| 接口点 | 映射 |
|---|---|
| daemon 启动 | `POST /api/agent/login` 拉回 sessionState（含 resumeSessionId 若有） |
| 收到 `run.requested` | 首次：`claude -p --output-format stream-json <promptText>`，从输出捕获 session id → sync-state 备份；后续：`claude -p --resume <resumeSessionId> --output-format stream-json <promptText>` |
| 流式输出 | stream-json 的 assistant 文本增量 → `POST .../delta` |
| Activity | stream-json 的 tool_use / tool_result → `POST .../activities` |
| 完成 | 进程正常退出 → PATCH completed |
| 会话失效 | resume 报错（id 过期/被清理） → 去掉 `--resume` 重跑 + 上报 `session-reset` |
| 关停 | 心跳缺失 → 杀在飞 claude 进程 → PATCH failed → exit(0) |

### 示例 D：原生Ollama API型（Gemma，无CLI进程）

| 接口点 | 映射 |
|---|---|
| daemon 启动 | 校验Account为`kind=api, provider=ollama`，读取`connection.baseUrl`；`secretRef`允许为null；`POST /api/agent/login` |
| 收到 `run.requested` | 从该Account的sessionState取稳定history，追加本轮`promptText`，直接`POST <baseUrl>/api/chat`，model只取`account.model`，不调用OpenCode |
| 流式输出 | Ollama逐行JSON中的`message.content`非空片段按顺序各上报一次`POST .../delta`；`done:true`只结束，不重复正文 |
| Activity | 当前Ollama adapter无本地tool loop，不上报虚构tool Activity或`fs/process`能力 |
| 完成 | stream正常结束 → 把本轮user/assistant追加到可序列化history → PATCH completed → sync-state备份；provider usage若存在只进安全usage记录 |
| 会话失效 | sessionState不是预期history形状时明确上报`session-reset`并从空history开始，不借用其他Account历史 |
| 关停 | 心跳缺失或Run取消 → abort HTTP请求/reader → PATCH对应状态 → exit(0)；无常驻CLI进程可杀 |

### 示例 E：mock adapter（Phase 2 已实现，verify.mjs 使用）

回显两段落文本（验证多气泡），sessionState 存自增计数器并带进回复（验证会话连续性），并演示同 callId 的 tool activity 原地更新。prompt 内触发词：`!!error` → 抛 `provider_error`；`!!approve` → 走一次 requestApproval 全链路。延迟来自 config 的 mock 配置。

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

`run(ctx)` 入参 `{ agent, account, prompt: { text,turnText,historyUserText,historyEnvelopeText,residentBlock,retrievalBlock }, sessionState, workspacePath, onDelta, onActivity, requestApproval, persistSessionState, recompileForNewSession, signal }`。adapter 通过 `onDelta` / `onActivity` 回调上报，通过返回值 `{ content, sessionState }` 兜底。

**Phase 5.5联邦形态如何逐项翻译**：

| Phase 2–5当前进程内形态 | Phase 5.5 daemon对应 |
|---|---|
| `createOpencodeAdapter({ config })` | `scripts/agent-daemon.js`（独立进程，opencode daemon 在它内部管） |
| `createCodexAdapter({ config })` | `scripts/agent-daemon.js`内的Codex runtime（复用同一resume id和JSONL翻译规则） |
| `adapter.run(ctx)` | daemon 收 `run.requested` → spawn CLI → 走 run 生命周期 |
| `ctx.onDelta(text)` | `POST /api/agent/runs/:id/delta` |
| `ctx.onActivity(evt)` | `POST /api/agent/runs/:id/activities` |
| `ctx.requestApproval(req)` | `POST /api/agent/runs/:id/approvals` + 等 SSE `approval.answered` |
| `ctx.persistSessionState(state)` | `POST /api/agent/sync-state` |
| `ctx.signal` (AbortSignal) | gateway SSE 推 `run.cancelled` → daemon 中断 |
| `ctx.sessionState` | `POST /api/agent/login` 响应里的 `sessionStates` 字段 |
| `adapter.shutdown()` | daemon `exit(0)` 时自管的资源回收（杀 CLI daemon 等） |
| `ctx.agent / ctx.account / ctx.prompt.text` | `run.requested` 事件 data 字段 |

`digestMemory`/`dreamMemory`暂无可用的daemon wire对应。Phase 5.5必须先在本文冻结专用Memory job request/result内部通道、取消/超时、安全摘要、入队`memoryTaskSnapshot={ownerAgentId,executorAgentId,accountId,kind,provider,modelMode,taskModel,verificationId}`、无fallback语义及暂停的OpenCode状态，并完成迁移验收后，才能退役进程内Memory task adapter。`ownerAgentId`是Memory所属Agent；`executorAgentId`来自Data → Memory且`null`在入队时解析为owner，`accountId`固定为解析后executor的Home Account。gateway解析对应`taskModel`，daemon不得自行选择其他Agent、Account、provider或model。snapshot和wire只携带Account/连接的稳定指纹，不持久化或公开connection/secret；实际执行前连接变化导致资格指纹不匹配时明确`executor_unavailable`。该通道不得复用聊天`run.requested`、Message/Activity或聊天`sessionState`，也不得携带Workspace或任一Agent的Memory/身份提示。wire冻结前，Memory job仍由Phase 2–5进程内adapter承载。

Phase 2–5形态的四类provider映射示例（OpenCode daemon / Codex CLI resume / Claude Code resume / 原生Ollama API）行为约束仍成立——Phase 5.5只把协议载体从"进程内函数调用"换成"HTTP/SSE 跨进程消息"。上述表格作为daemon实现的对照参考保留。

`docs/salvage-notes.md` 第五节记录的 cloudflared 边缘漂移假活是 2026-07-04 联邦决策的导火索；2026-07-11 纯私网修订直接移除了 cloudflared 与公网入口。历史只用于排查旧部署，不再建设 tunnel watchdog。
