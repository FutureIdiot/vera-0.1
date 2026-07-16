# API 契约

> 前后端唯一接口基准。接口变更先改本文档再动代码。
> 覆盖 Phase 2–4 所需；标注 `[P4]` / `[P5]` 的条目在对应阶段前不实现，但形状现在定死。

---

## 一、通用约定

- 所有接口挂在 `/api/` 下，请求与响应均为 JSON（SSE 除外）。
- 时间一律 ISO 8601 UTC 字符串（`2026-07-02T03:00:00.000Z`）。
- ID 带类型前缀的随机串：`agt_` / `spc_` / `sps_`（SpaceSession）/ `ags_`（AgentSession）/ `msg_` / `run_`。
- 错误统一形状，HTTP 状态码配合语义：

```json
{ "error": { "code": "not_found", "message": "space spc_xxx does not exist" } }
```

`code` 枚举：`invalid_request`(400) / `control_command_required`(400) / `memory_cursor_invalid`(400) / `unauthorized`(401) / `forbidden`(403) / `not_found`(404) / `memory_cursor_expired`(410) / `conflict`(409) / `account_busy`(409) / `session_busy`(409) / `context_capacity`(409) / `history_conflict`(409) / `memory_job_active`(409) / `memory_task_unavailable`(409) / `invalid_memory_file`(422) / `memory_provider_unsupported`(422) / `adapter_unavailable`(502) / `memory_retrieval_unavailable`(503) / `memory_provider_unavailable`(503) / `internal`(500)。`account_busy`专指目标Account的活跃Execution租约已被占用；`session_busy`表示SpaceSession仍有未结束Run或compact，不能执行`/new`；`context_capacity`表示目标AgentSession在hard水位前未能完成安全压缩；`history_conflict`表示API Run以过期`historyVersion`提交结果；`control_command_required`表示精确`/new`或`/compact`被错误提交到Message端点。`memory_job_active`表示Provider切换被该Agent在途Digest/Dream阻止；`memory_task_unavailable`专指已保存的Digest/Dream执行Agent、其Home Account、任务模型或对应资格当前不可用；`memory_provider_unsupported`表示候选未声明/未通过Memory Provider契约或不支持所需操作；`memory_provider_unavailable`表示active Provider已绑定但当前不可达。不得用泛化的`conflict`隐去这些原因。错误对象可带领域专用的`details.reason`等安全字段，但不得包含secret、provider原文、宿主路径或改变`code/message`的通用包络。

- Secret 永不出现在任何响应中。API 型 agent 的 key 存 `~/.vera/secrets.json`，接口只引用键名（`secretRef`）。
- 生产部署的全部 `/api/*` 只允许经 Tailscale Serve 私网入口到达。普通客户端请求校验 Serve 注入的 owner Tailscale identity；`/api/agent/*` 在 tailnet 门禁之外再用 `Authorization: Bearer <vera-agent-token>` 识别具体 agent（token 文件 `~/.vera/agent-tokens.json`）。不定义公网匿名入口。详见 ground truth 2.4。

## 二、数据形状

### Agent（ground truth 2.2）

Agent = Vera 内独立身份实体。身份字段只有命名 + 时间戳；Agent设置固定为Skills / Hooks / MCP / Data四个平级目录，其绑定与Data下的Memory Provider/Digest/Dream配置都是独立的per-Agent资源，不嵌进Agent身份。Agent Plugin仍是Phase 6扩展类型，但0.0.1不提供第五个Agent设置入口。连接、供应商和聊天默认模型随Account；SpaceSession/AgentSession及API规范history由Vera持有，CLI外部会话只以provider binding挂到AgentSession generation。

```json
{
  "id": "agt_x1y2",
  "name": "Iota",
  "createdAt": "…",
  "updatedAt": "…"
}
```

- 身份 = `name`，永久绑定记忆与历史。
- 每个 agent 注册时自动派生且始终只有一条 **Home Account**（`owningAgentId` 指回自身且全局唯一）。Agent 不持有第二条 owned Account。
- Agent 的主 Execution 默认绑定 Home Account；经用户把该 Agent 加入目标 Account 的 `authorizedAgentIds` 后，主 Execution 不必退出 Home Account，可派 subagent Execution 绑定该目标 Account。跨账户发生在 Execution 层，不改变 Home Account 归属。
- 改连接/供应商/模型改的是 account，agent 身份与记忆不变。

`[P5-M4内置unit；Phase 5.5/6通用运行时]` MCP/Hook unit binding是独立资源，最小公共语义为`{agentId,unitId,kind,name,enabled,runtime,version}`。`runtime`至少区分`gateway/daemon`；执行Agent不是所有Hook的强制公共字段，只有unit manifest明确声明需要代理执行时才可附带可选`executorAgentId`及候选。gateway内置确定性unit没有该字段。Digest/Dream的`modelMode/model/schedule`属于Data → Memory领域配置，不是Hook字段。内置unit固定为MCP `vera.memory`、Hook `vera.memory.recall`与Hook `vera.memory.write`，名称分别展示为`Vera Memory MCP`、`Vera Memory Recall Hook`和`Vera Memory Write Hook`；三者均为`runtime:"gateway"`且无执行Agent/模型。Digest与Dream由Memory Orchestrator创建隔离模型任务，不注册为unit；Hooks目录仍可包含任意其他领域Hook。

unit binding统一使用同一资源接口，不为MCP、Hook或Memory另建第二套绑定事实来源：

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/agents/:agentId/unit-bindings?kind=<mcp-or-hook>` | 返回`{bindings:[{agentId,unitId,kind,name,enabled,runtime,availability,executorAgentId?,version}]}`；`kind`必填且只允许`mcp`或`hook`。仅manifest声明需要代理执行的unit可返回`executorAgentId`与安全候选；不暴露Account连接、secret或任务模型 |
| PATCH | `/api/agents/:agentId/unit-bindings/:unitId` | body严格为`{enabled?,executorAgentId?,ifMatch}`；只修改已安装/内置unit的binding。未声明代理执行的unit若收到`executorAgentId`则400；声明该字段的unit必须校验owner有权选择的现存Agent。成功返回`{binding}`，version冲突409，unit或Agent不存在404 |

`unitId`本身全局唯一，因此PATCH不再重复传`kind`；gateway仍按已安装unit清单校验其真实类型。`vera.memory.recall`与`vera.memory.write`的状态只在Hooks目录读取、展示和修改；Data → Memory不得读取、投影或复制它们，也不能把同字段写进`memory/_config`。关闭Recall只停止自动检索/注入；关闭Write停止scheduled/realtime等所有自动Digest enqueue，不影响Message保存、pending context统计、owner手动Digest、MCP手动Memory写入或Dream调度/手动Dream。

Skills不复用unit binding接口，也不为了统一页面外观扩展`kind=skill`。真实Skill列表、导入、加载与卸载仍等待Extension Package/Skill契约；在该契约落地前生产前端使用合法空列表，不调用不存在的HTTP端点。

Skills / Hooks / MCP共用的只是前端目录view接口，不是gateway资源。路由/controller向view注入以下标准化投影；该形状不持久化，也不作为HTTP响应：

```json
{
  "kind": "skill | hook | mcp",
  "items": [{
    "id": "stable-domain-id",
    "name": "display name",
    "summary": "optional truthful summary",
    "enabled": true,
    "availability": "available | unavailable | unknown",
    "version": "optional-write-version",
    "canToggle": true,
    "toggleUnavailableReason": null,
    "canOpen": false
  }],
  "actions": {
    "canAdd": false,
    "addUnavailableReason": "Skill接口尚未接入",
    "canManage": false,
    "manageUnavailableReason": "Skill接口尚未接入"
  }
}
```

`enabled`在该领域没有开关时为`null`，`version`无CAS写入时为`null`；不得用默认值伪造启用状态。`*UnavailableReason`在动作可用时为`null`，不可用时必须提供可展示说明。Hooks/MCP接线阶段从上述unit binding响应映射，Skills在真实接口落地前固定为`items:[]`。目录view只渲染投影并发出`add/manage/toggle/open`意图，不import HTTP client，不知道endpoint。controller没有提供动作处理器时，顶栏“添加/管理”和行内开关必须disabled；视觉夹具只用于测试或UI Lab，不得进入生产路由。

### Account（ground truth 2.2 2026-07-03 修订）

Account = 供应商连接 + Workspace/runtime，随账户不随agent；它不是SpaceSession或AgentSession的所有者。

```json
{
  "id": "acc_a1b2",
  "owningAgentId": "agt_x1y2",
  "name": "Iota 的 Codex",
  "kind": "cli",
  "provider": "codex",
  "connection": {
    "command": "/Applications/ChatGPT.app/Contents/Resources/codex",
    "args": [],
    "secretRef": null
  },
  "model": "gpt-5.6-sol",
  "presence": "offline",
  "lastSeenAt": "2026-07-04T10:58:00.000Z",
  "runtimeCapabilities": null,
  "authorizedAgentIds": ["agt_x1y2"],
  "createdAt": "…",
  "updatedAt": "…"
}
```

原生Ollama/Gemma是另一条独立API Account，不复用上面的Codex CLI Account。以下只展示该Account特有的连接字段，公共id、owner和状态字段省略：

```json
{
  "kind": "api",
  "provider": "ollama",
  "connection": {
    "baseUrl": "http://127.0.0.1:11434",
    "secretRef": null
  },
  "model": "gemma4:e4b"
}
```

- `owningAgentId`：该账户唯一的主人 Agent，也就是该 Agent 的 Home Account。`Agent 1:1 Home Account`；同一 Agent 不得再创建第二条 owned Account，一个 Account 也不得有第二个 owner。
- **Account 选择是 Execution 级，不是 daemon 登录级或 Seat 级**：主 Execution 默认绑定 Agent 的 Home Account；subagent Execution 可绑定 `authorizedAgentIds` 已授权的其他 Account。`run` 同时记录 `spaceSessionId + agentSessionId + contextGeneration + agentId + accountId`：Memory与AgentSession随`agentId`，Workspace、供应商连接和runtime data随`accountId`。
- `authorizedAgentIds: ["agt_…"]` `[P5.5]`：哪些Agent有资格创建绑定该Account的subagent Execution（默认仅`[owningAgentId]`）。API型Account据此决定是否可换取明文key；CLI型key虽不由gateway持有，仍必须先过相同的Execution授权与租约判定，daemon宿主文件权限只提供额外物理边界。名单外一律403。
- `kind: "cli"` 时 `connection.command/args` 有效；具体adapter可因安全与参数顺序约束收窄args，当前Codex adapter要求`args=[]`，只从Account读取command/model，不允许用args注入sandbox、approval或bypass参数。`kind: "api"` 时 `connection.baseUrl/secretRef` 有效。`baseUrl`是adapter宿主看到的provider根URL，必须由Account/config显式给出并规范化为无尾斜杠；loopback本机服务允许`http://127.0.0.1`/`http://localhost`，非loopback只允许当前Tailscale私网或HTTPS，不得静默fallback公网。无鉴权provider（如本机Ollama）`secretRef`为`null`。
- `provider`以精确小写token选择adapter，不接受兼容别名；adapter在任何网络/进程副作用前校验`kind/provider`。切换同provider的model或baseUrl复用同一adapter，不能靠复制adapter文件实现；协议或生命周期不同才新增provider adapter，具体判据与三层验收见`adapter-interface.md` 1.2。
- `model` 为空串 = 使用该供应商默认模型（CLI 型 adapter 不传 `-m` 类参数）。
- secret 永不出现在响应里；`connection` 里只用 `secretRef` 引用 `~/.vera/secrets.json` 中的键名。
- `presence: "online"` 由 agent daemon 通过 `/api/agent/*` 心跳维持（ground truth 2.4 联邦形态）；daemon 主动登出或心跳缺失后由 gateway 置 `offline`。`lastSeenAt` 是上一次心跳或最后一次 SSE 收到时刻。
- `runtimeCapabilities` `[P5.5]` 是当前daemon登录时报告的临时公开快照，形状见 `adapter-interface.md` 2.1；Account系统管理可把它作为宿主连接诊断，Agent使用管理用它判断Tools/扩展运行支持，但能力开关与配置仍属于Agent使用层。离线时返回 `null`，不写入accounts集合。能力可用不等于已获授权，执行仍按workspace/tool policy/Approval判定。
- **单活跃 Execution 租约** `[P5.5]`：一个 Account 同一时刻最多由一个活跃 Execution 控制，租约记录 `accountId/executionId/agentId/acquiredAt`。创建或启动另一条绑定同一 Account 的 Execution 时，gateway 必须原子抢占；已占用则返回 HTTP 409、`error.code = "account_busy"`，不得让两个 Agent/daemon 并发驾驶同一CLI provider binding或Workspace。Execution 结束、取消、失败或 daemon 租约超时后释放。尚未获得租约的内部排队项不算活跃 Execution。
- **联邦形态遗留说明**：`connection.command` 字段在 ground truth 2.4 联邦形态下从语义上已无意义（gateway 不 spawn CLI，路径是 agent daemon 的事），但 v1 形状保留以兼容 4.1 已落代码；Phase 5.5 联邦实现时该字段不再被任何代码读取，可在前端管理界面隐藏。

**v0 / v1 兼容说明（仅限 Phase 4 一次迁移）**：v0 agent 记录里内嵌的 `kind/provider/connection/model` 由 store 启动时迁移到新建的 Home Account；v0 的 `session-states.json` 键 `${agentId}:${spaceId}` 重映射为 `${accountId}:${spaceId}`（用各 agent 的 Home Account）。迁移幂等，旧文件留 `.legacy`。此后 Agent 与 Account 是两条独立路径，不再有"内嵌字段"形态。

**v1 → Seat 去 accountId 一次性迁移（Phase 4.4）**：4.1 落地的 `seat.accountId` 字段废弃——账户归属改为 Execution 级，普通主 Execution 默认 owning/Home Account。store 启动时清理所有 spaces 下 seats 上的 `accountId` 字段，session-states 键**不动**（仍按 `(accountId, spaceId)`，默认 accountId = 派生 Home Account id）。4.1 那条 backfill `seat.accountId` 的迁移逻辑同时撤掉。

### Workspace `[Phase 5.5]`

Workspace = Account 对应的执行环境与项目工作边界；`Account 1:1 Workspace`。它不属于 Agent、Space 或 Memory。

```json
{
  "accountId": "acc_a1b2",
  "hostId": "host_local_mac",
  "path": "/Users/theta/projects/example",
  "status": "ready",
  "policy": {},
  "lastValidatedAt": "…",
  "updatedAt": "…"
}
```

- gateway 的 data 层只保存 Workspace 的 `accountId` 归属、宿主绑定、路径、校验状态与执行策略；实际项目文件保留在 daemon 宿主机，不复制进 gateway store，也不由 VPS 索引。
- `path` 是 `hostId` 上的机器本地路径，只有绑定到同一宿主的 daemon 可解释；不得把绝对路径当作跨设备可用地址。
- Execution 绑定 Account 后只能使用该 Account 的 Workspace。即使 subagent 与父 Execution 共享 Agent 身份及 Memory，也不得继承父 Execution/Home Account 的 Workspace。
- Workspace 重新绑定宿主或路径必须显式校验并更新绑定；不得静默生成同一 Account 的第二个 Workspace。
- 本形状及持久化在 Phase 5.5 实施；当前代码尚未完成迁移，不得据本文档宣称运行时已隔离。

### Space

```json
{
  "id": "spc_a1b2",
  "name": "vera-dev",
  "topic": "Vera 0.0.1 开发",
  "notifications": {
    "mode": "agentMessages",
    "includeActivityErrors": true
  },
  "seats": [
    { "agentId": "agt_x1y2", "responseMode": "default" }
  ],
  "activeSpaceSessionId": "sps_a1b2",
  "archivedAt": null,
  "createdAt": "…"
}
```

- `seat.agentId`：在该 Space 上以哪个身份出席。
- `seats`必须至少包含一个有效Agent，创建时缺失或为空均返回`400 invalid_request`；更新成员时不得移除最后一个seat。历史空记录只允许读取并通过一次非空`PATCH`修复，不构成合法的新建或编辑结果。
- `seat.responseMode`（per-agent per-Space，ground truth 2.3）：`default`（都响应）/ `silent`（只响应指定来源的 @）/ `focused`（只响应 @自己）。定向 @ 到的 agent 一律响应，不受 responseMode 影响。
- **Seat 不携带 `accountId`**（Phase 4.4 调整）：Account 由每条 Execution 显式绑定，普通主 Execution 默认 Home Account，不允许 per-Space 覆盖。
- `silent` 的来源过滤字段 `respondTo: ["user", "agt_..."]` 挂在 seat 上（成员为 `"user"` 或 `agt_` id）；Phase 4 落地，落地前 silent 对定向 @ 等价 focused。
- `seat.blockAgentIds: ["agt_…"]`（Phase 4.3，可选）：屏蔽名单——名单里 agent 的气泡不进该 agent 的群聊视角 prompt 段，等价于对它单向静默。定向 @ 仍穿透屏蔽（用户拥有最终决策权，ground truth 2.3）。
- `notifications` `[P4.6]`：当前Space的提醒策略。`mode` 为 `all`（agent消息与Activity均提醒）/ `agentMessages`（只提醒agent消息，默认）/ `off`；`includeActivityErrors` 控制error Activity是否即使在 `agentMessages` 下也提醒。这里是gateway持久的Space策略；浏览器/系统通知权限仍由各客户端自己申请，二者不得混成一个开关。
- `activeSpaceSessionId`：该Space唯一可写SpaceSession。创建Space时必须在同一事务创建首个active SpaceSession；任何时刻不得为空或指向archived记录。
- `archivedAt` `[P4.6]`：`null` 表示活跃；ISO时间戳表示已归档。归档只把Space移出活跃导航并禁止新消息/新Run，Space自身、active/archived SpaceSession、时间线和provider bindings全部保留；恢复后继续使用原Space id及原active SpaceSession。只有已归档Space可永久删除；SpaceSession归档仍不可恢复或单独删除。
- Space Module绑定不直接塞任意脚本进Space记录。Phase 6先定义全局Extension Package与per-Space Module binding的独立集合/API，再由Space设置页读取；契约未补全前不得在 `seats` 或任意自由字段里偷放Module配置。

### SpaceSession 与 AgentSession `[P5-C1]`

```json
{
  "id": "sps_a1b2",
  "spaceId": "spc_a1b2",
  "status": "active",
  "createdAt": "…",
  "archivedAt": null,
  "archiveReason": null
}
```

- `Space 1:N SpaceSession`且每个Space恰有一个`active`；其余只能为`archived`。`archiveReason`当前只允许`new_command`。归档SpaceSession永久只读，不提供restore；`/new`是唯一创建下一SpaceSession的产品动作。
- Message、Run、Activity、Approval都必须带`spaceSessionId`；所有时间线、speaker-view、Digest范围和自动触发先按它隔离，禁止只靠时间戳猜窗口边界。用户Message写入时与当前`activeSpaceSessionId`原子绑定；agent输出从Run继承。

```json
{
  "id": "ags_a1b2",
  "spaceSessionId": "sps_a1b2",
  "agentId": "agt_x1y2",
  "status": "active",
  "generation": 1,
  "context": {
    "checkpointVersion": 0,
    "estimatedInputTokens": 3200,
    "effectiveLimitTokens": 16384,
    "pressureRatio": 0.195313,
    "measurement": "estimate"
  },
  "createdAt": "…",
  "updatedAt": "…"
}
```

- `SpaceSession 1:N AgentSession`，唯一键`(spaceSessionId,agentId)`。当前seats可预建；后加入seat首次需要Run前补建，移除seat后保留历史但不再新建Run。subagent Execution不自动创建Space成员AgentSession。
- `generation`从1开始，只在该AgentSession成功compact或CLI provider binding明确missing/invalid并完成重建后递增。旧generation的checkpoint/provider binding/Recall sidecar只读冻结。
- `measurement`只允许`provider_reported/tokenizer/estimate`。默认容量水位warning/auto/hard为`0.70/0.80/0.95`，可按已验证provider/model profile覆盖且必须严格递增。完成Run后跨auto水位在安全点排队；下一Run前已达hard水位必须先compact，失败返回`context_capacity`且不得丢当前Message。
- Vera持有AgentSession、generation、checkpoint、容量与provider binding元数据真值。API Agent的规范history/checkpoint落gateway store并以CAS version追加；daemon只接收Vera裁好的bounded messages。CLI内容仍由provider thread持有，但其thread/resume id只作为`(agentSessionId,generation,accountId,providerFingerprint)`绑定，daemon不得把它升级成SpaceSession真值。
- compact保留顺序固定为：稳定Agent身份/规则 → 上代checkpoint → 最近完整轮次 → 当前Message → 当前Recall。旧群聊声告和旧Recall投影不写入稳定history；成功后新generation首次Run重新注入常驻Memory索引并换代Recall sidecar。

**一次迁移**：为每个现有Space创建一个active SpaceSession，并给全部既有Message/Run/Activity/Approval回填该`spaceSessionId`。旧`(accountId,spaceId) -> sessionState`只在能由Space seat与Home Account唯一映射时迁成对应AgentSession generation 1的CLI provider binding；API history按现有可验证Message/assistant记录重建，无法唯一映射的opaque state直接失效并从新binding开始，不能按数组第一项猜。旧Recall sidecar能唯一映射则挂generation 1，否则失效重建。迁移完成后删除旧collection/字段读写，不长期双读双写。

**Speaker view 编译层输出契约**（ground truth 2.3「群聊视角注入形态」）：触发某 agent 的 run 时，gateway 的编译层（`src/spaces/view-compiler.js`，Phase 4.2）只在当前`spaceSessionId`内，从该Agent上次本人发言之后到当前触发之间临时派生他人Message署名声告段；Activity和归档SpaceSession的Message不进本轮prompt。`silent/focused/blockAgentIds`统一在此层过滤。CLI与API adapter共享同一编译结果，但API的规范history由gateway维护，CLI只消费当前完整投递文本。

**prompt.text 物理拼装顺序**：`[常驻索引块]?\n\n[群聊声告段]?\n\n[触发消息正文]\n\n[本轮Memory检索块]?`。常驻索引只在当前AgentSession generation首次Run注入；群聊声告与Recall都是本轮volatile段，不写入API稳定history。群聊声告格式和现有条数/字符配置保持不变，但查询边界必须是当前`spaceSessionId`。

编译层返回`text/turnText/historyUserText/residentBlock/retrievalBlock`及gateway已经裁剪好的`apiMessages`。每个API main Run成功时以一个CAS原子追加完整turn：`input`只取当前trigger Message并保留author/target/sourceMessageId署名信封，`assistant`引用本Run已完成reply Message并可带provider确需的安全tool transcript/usage。即使trigger来自另一个Agent，也必须保存这一个最小输入信封与assistant成对，不能产生孤立assistant轮次。累计群聊声告、Activity、隐藏思维、常驻索引和Recall投影不进稳定turn。CLI adapter继续只消费`text`。旧`historyEnvelopeText`字段在P5-C1迁移后删除，不保留双写兼容。

### Message

```json
{
  "id": "msg_m1n2",
  "spaceId": "spc_a1b2",
  "spaceSessionId": "sps_a1b2",
  "author": { "type": "user" },
  "target": { "type": "broadcast" },
  "content": "大家看一下这个报错",
  "runId": null,
  "status": "completed",
  "createdAt": "…"
}
```

- `author`：`{ "type": "user" }` 或 `{ "type": "agent", "agentId": "agt_…" }`。用户和 agent 在消息层对等。
- `target`：`{ "type": "broadcast" }` 或 `{ "type": "direct", "agentIds": ["agt_…"] }`。
- `runId`：agent 消息关联其产生 run；用户消息为 null。

**多气泡规则（产品需求，契约级）**：一次 run 的回复**不是一条巨长消息，而是一串短消息**。gateway 在流式输出中按段落边界切分：当前气泡以 `status: "streaming"` 创建、随 delta 增长，检测到切分点即定稿（`completed`）并开下一个气泡。一个 run 产生 N 条 Message 记录，每条是独立气泡，历史记录里也保持切分后的形态。切分策略（边界规则、最小/最大长度）是 gateway 配置项，不硬编码；无段落边界的超长文本按就近空格软切；前端只负责渲染，不做切分。若 adapter 未产生任何 delta 只返回全文，gateway 以全文兜底切气泡（见 adapter-interface「run() 返回」）。

### Run

一次 agent 响应的执行记录。

```json
{
  "id": "run_r1s2",
  "agentId": "agt_x1y2",
  "accountId": "acc_a1b2",
  "parentRunId": null,
  "role": "main",
  "spaceId": "spc_a1b2",
  "spaceSessionId": "sps_a1b2",
  "agentSessionId": "ags_a1b2",
  "contextGeneration": 1,
  "triggerMessageId": "msg_m1n2",
  "replyMessageIds": ["msg_p3q4", "msg_p3q5"],
  "status": "running",
  "createdAt": "…",
  "endedAt": null
}
```

`status`：`pending` / `running` / `completed` / `failed` / `cancelled`。`pending`表示Run已创建但尚未取得Account租约或目标AgentSession正在compact，不得执行、发delta或修改context/provider binding；取得租约且generation仍匹配后原子转`running`并广播`run.started`。`failed`时Run带`error: { code, message }`字段（挂在Run对象上，其余状态无此字段）。

gateway启动时不得resume上一进程遗留的`pending/running` Run；它们统一终态化为`failed/internal`，关联的streaming Message、pending Activity与Approval也同步安全终态化。SSE按跨重启缺口触发bootstrap重取，不补发伪造的旧进程流事件。这样遗留Run不会永久占住Account或阻塞`/new`。

- `accountId` `[P5.5]` 是这次 Execution 使用的 Account。主 Execution 默认 Home Account；`role: "subagent"` 时可使用已授权的其他 Account。`parentRunId` 仅在 subagent Execution 上指向发起它的父 Run，主 Execution 为 `null`。
- `role:"main"`必须带当前active `spaceSessionId/agentSessionId/contextGeneration`。`role:"subagent"`仍继承审计用`spaceId/spaceSessionId`，但`agentSessionId/contextGeneration`必须为`null`；它只消费父Run显式传入的isolated task/context，使用全新临时provider上下文，终态后不保存API history、CLI provider binding、Recall sidecar或checkpoint。
- main Run的session字段在进入provider执行时冻结。唯一例外是CLI provider在尚未产出任何reply Message前明确确认当前binding `missing/invalid`：gateway可为同一Run原子生成checkpoint、令generation+1、更新该Run的`contextGeneration`并重新编译一次prompt；普通provider/network错误、已有reply或API Run均不得中途换代。
- Memory读取与写入目标始终由`agentId`决定；Account切换不得生成、复制或改挂Memory。主Run的AgentSession及API history由`agentSessionId + contextGeneration`决定；Workspace、provider/model/key与runtime data由`accountId`决定。
- Run 是当前 API 中 Execution 的持久记录，`role` 取 `main` / `subagent`。父 Run 与 subagent Run 上下文隔离；父方只显式传递任务包和必要材料，subagent 完成后返回结果，不继承父 Account 的 provider history 或 Workspace。

同一Account上的活跃run **串行执行**：gateway创建Run时先写`pending`；调度器原子取得Account租约后才转`running`并发送`run.requested`。内部主/subagent触发可留在pending队列；要求立即占用的外部请求在Account忙时返回409 `account_busy`。因此不同Account可并行，同一Account绝不并行；旧的“仅同一(agent, Space)串行”不足以提供隔离。Phase 5当前进程内adapter路径已用进程级Account排他队列实现此边界；Phase 5.5仍须把它迁为可处理daemon失联、跨进程调度和超时释放的持久租约，不能把当前队列冒充联邦租约已完成。

### Activity（时间线成员）

思考链、工具执行记录等过程信息。**不是独立面板，是 Space 时间线的正式成员**：与消息气泡按时间穿插排列，历史记录里同样保留。

```json
{
  "id": "act_t1u2",
  "spaceId": "spc_a1b2",
  "spaceSessionId": "sps_a1b2",
  "runId": "run_r1s2",
  "agentId": "agt_x1y2",
  "phase": "tool",
  "label": "bash",
  "detail": "npm test\n…(输出截断)",
  "toolStatus": "completed",
  "createdAt": "…",
  "updatedAt": "…"
}
```

- `phase`：`thinking`（思考链）/ `tool`（工具执行）/ `working` / `usage` / `error`。
- 工具类 activity 是**同一条记录原地更新**（pending → running → completed/error），不是每个状态一条。
- `detail` 截断长度、activity 历史保留策略均为配置项。

### Approval（时间线成员）

agent 的提权申请（执行危险操作前要用户点头）。也进时间线，渲染为带按钮的卡片。

```json
{
  "id": "apr_v1w2",
  "spaceId": "spc_a1b2",
  "spaceSessionId": "sps_a1b2",
  "runId": "run_r1s2",
  "agentId": "agt_x1y2",
  "prompt": "要执行 rm -rf ./dist，允许吗？",
  "options": ["allow", "deny"],
  "status": "pending",
  "answer": null,
  "createdAt": "…"
}
```

`status`：`pending` / `answered` / `expired`（run 结束仍未答复即过期）。

**交互原则**：Approval 是唯一允许的结构化阻塞提问。**选项式提问（AskUserQuestion 类）一律禁用**——adapter 以无交互模式运行 CLI；agent 有问题就正常发消息用文字问，用户用文字答。

### AgentState（per-Space 活动层，ground truth 3.3 + 2026-07-04 联邦精化）

```json
{
  "agentId": "agt_x1y2",
  "spaceId": "spc_a1b2",
  "status": "coding",
  "detail": "正在 review PR #42",
  "lastActiveAt": "…"
}
```

- 同一 agent 可同时在多个 Space 有活动，每个 Space 一条独立记录；前端按当前 Space 取数；`GET /api/agent-states` 返回数组（不再去重成 per-agent）。
- `status` 枚举（agent daemon 自己向 gateway 声明，gateway 不猜）：
  - `idle`：默认/未指派
  - `thinking`：LLM 流式回复中
  - `typing`：tool use 之后再回 final 输出
  - `reading`：工具在读
  - `coding`：工具在 write/git
  - `reviewing`：review PR/issue
  - `on_task`：多步骤跑一个整体活儿
  - `away`：daemon 在线但闲置超 N 分钟未活动
- `detail`：一行人类可读，daemon 自己写。
- AgentState 是**运行时派生状态**，不持久化；gateway 重启后全部归 `idle`、所有 `away` 复位。与 `Account.presence` 正交：presence 表示该 Account Workspace 宿主 daemon 当前是否可执行，AgentState 是该 agent 在某 Space 内的具体工作相。

## 三、HTTP Endpoints

### 系统

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/health` | `{ "app": "vera", "ok": true }` |
| GET | `/api/bootstrap` | 一次拉齐聊天主页所需摘要：agents + accounts + spaces + agentStates + 当前 SSE `seq` 水位；联系人栏由Agent与Space成员集合派生，Account只用于补连接/presence信息，不是联系人实体。不得继续向bootstrap加入Memory正文、Extension主体、Settings表单数据或中控台详情 |
| GET | `/`（及其他非 `/api/` 路径） | 静态前端：当前Phase 2–4.5回退伺服`frontend/`源码目录；F2引入Vite后production改为伺服`frontend/dist/`并对hash资源长期缓存、HTML用ETag/协商缓存。开发预览由Vite提供且保持`no-store`。两种模式都需SPA hash路由回退与路径穿越防护，不得让CDN缓存旧HTML指向失效bundle |

### Agent

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/agents` | 列表 |
| POST | `/api/agents` | 创建。body 至少 `{ "name": "…" }`；可一次性带 `{ name, kind, provider, connection?, model? }` 初始化唯一 Home Account。响应 `{ "agent": Agent, "account": Account }`；创建必须原子保证一个 Agent 恰有一个 Home Account |
| PATCH | `/api/agents/:id` | 更新 `name`。普通聊天换模型/供应商/连接仍改account；扩展unit绑定走独立资源，不塞进这个接口 |
| DELETE | `/api/agents/:id` | 删除身份（Memory 与历史处置 `[P5]` 再定，Phase 2–4 直接拒绝删除有历史的 agent）。无活跃 Execution 时才可连带删除 Home Account 元数据；不得删除 daemon 宿主上的 Workspace 实际文件，并从其他 Account 的 `authorizedAgentIds` 移除该 id |

### Account

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/accounts` | 列表；支持 `?agentId=<agt_…>` 精确过滤该 Agent 的唯一 Home Account。查看该 Agent 可授权使用的其他 Account 用列表中的 `authorizedAgentIds` 派生，不把它们算作“名下账户” |
| PATCH | `/api/accounts/:id` | 更新 `name` / `kind` / `provider` / `connection` / `model` / `authorizedAgentIds`（换 key/供应商/模型或授权名单不换 Home Account 归属；`owningAgentId` 不可改） |
| DELETE | `/api/accounts/:id` | Home Account 只随 owning Agent 一起删除，不允许单独删除；Agent 仍存在时返回 409 `conflict`。存在活跃 Execution 时删除 Agent 同样返回 409；不得在删除路径下静默清理尚在使用的CLI provider binding或 Workspace |

Phase 5 目标 API 不提供“给同一 Agent 新增第二条 owned Account”的端点。现有 Phase 4 代码与存量数据须在 Phase 5/5.5 迁移中收口；迁移完成前不得把旧实现解释成仍受支持的产品语义。

Vera全局Settings中的`#/settings/accounts`只负责系统层管理：按Agent聚合其身份、唯一Home Account、连接、Workspace与授权关系；授权使用的其他Account是Execution候选，不是该Agent的owned Account。这只是读取时组合，响应形状仍保持独立`agents` / `accounts`，不得新增内嵌双写形状。AgentState、当前所在Space、Skills / Hooks / MCP / Data与Memory使用页属于独立的Agent使用管理`#/agents`，不得塞回Account页面。

### Space

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/spaces` | 默认只列活跃Space；`?archived=true`只列已归档，`?archived=all`列全部。`/api/bootstrap`只返回活跃Space |
| POST | `/api/spaces` | 创建Space；body必须包含至少一个seat，并在同一事务创建首个active SpaceSession与当前seats的generation 1 AgentSessions |
| PATCH | `/api/spaces/:id` | 更新 name/topic/seats/notifications（席位增删、responseMode/提醒策略调整；seats不得为空） |
| POST | `/api/spaces/:id/archive` `[P4.6]` | 归档Space。存在未结束Run或compaction时返回409；成功写入`archivedAt`，不删除或级联清理任何SpaceSession/provider binding。重复归档幂等返回当前Space |
| POST | `/api/spaces/:id/restore` `[P4.6]` | 恢复已归档Space：把`archivedAt`置回`null`并继续原active SpaceSession。重复恢复幂等返回当前Space |
| GET | `/api/spaces/:id/deletion-preview` | 仅已归档Space；返回`{preview:{spaceId,messageCount,affectedMemoryCount,exclusiveMemoryCount}}`。`affectedMemoryCount`为至少一个Message来源属于该Space的Memory，`exclusiveMemoryCount`为全部sources均为该Space Message的Memory |
| DELETE | `/api/spaces/:id` | 仅已归档Space；body严格为`{deleteExclusiveMemories:boolean}`。先按预检版本更新Memory：所有保留Memory把该Space的Message SourceRef改为`deleted-message`墓碑；选项为true时额外删除exclusive Memory。Memory全部提交成功后，删除Space及其Message/Activity/Run/Approval/SpaceSession/AgentSession/provider binding/API history/context control与compaction记录；已成功且仍承载Memory事实身份的Digest receipt作为无原文审计保留。返回`200 {deleted:{spaceId,messageCount,affectedMemoryCount,deletedMemoryCount}}`并发布`space.deleted`。active Memory job仍引用该Space或Memory版本冲突时返回409且Space保持已归档 |
| GET | `/api/spaces/:id/timeline?before=<itemId>&limit=50` | 只返回active SpaceSession时间线。返回`{spaceSession,items:[...],runs:[...]}`；`runs`只含与本页item关联的持久Run安全投影，归档窗口不得由该端点隐式混入 |
| POST | `/api/spaces/:id/messages` | 发消息（见下）；已归档Space返回409 `conflict`，必须先恢复 |
| GET | `/api/spaces/:id/sessions?status=active|archived|all` `[P5-C1]` | 默认列archived SpaceSession摘要，按createdAt倒序；`active/all`显式选择。返回`{sessions}`，不含时间线正文 |
| GET | `/api/spaces/:id/sessions/:spaceSessionId/timeline?before=&limit=50` `[P5-C1]` | 只读返回指定SpaceSession时间线及与本页item关联的持久Run状态；归档窗口同样可读，但该路由没有写、restore或新Run能力 |
| POST | `/api/spaces/:id/session/_new` `[P5-C1]` | body严格为`{requestId}`。当前有pending/running Run或compaction则409 `session_busy`；否则单事务归档当前SpaceSession/AgentSessions并创建新active窗口。`(spaceId,requestId)`幂等，返回`{archivedSession,newSession}` |
| POST | `/api/spaces/:id/session/_compact` `[P5-C1]` | body严格为`{requestId}`；私聊压唯一Agent，群聊默认压当前全部seats。返回202`{job}`，命令本身不落Message。target创建时冻结Message高水位及已排在compact前面的active Run ids；后续新建pending Run的trigger不得进入本次checkpoint，排在前面的Run则等其完成后按完整轮次纳入。每个target取得对应Home Account的同一排他租约后执行；compact不是Run但不得与该Account Execution并发。各Agent独立提交generation，部分失败不回滚已成功项；gateway重启时遗留queued/running target统一失败终态化，旧generation保持有效 |
| GET | `/api/spaces/:id/session/_compact/jobs/:jobId` `[P5-C1]` | 返回`{job:{id,spaceId,spaceSessionId,status,targets:[{agentId,agentSessionId,fromGeneration,toGeneration?,status,error?}],createdAt,finishedAt?}}`；job与target status都只允许`queued/running/succeeded/failed/cancelled`，job按targets派生；不返回checkpoint、history或provider binding |

**发消息**（用户或 agent 均走此接口；agent 发消息 `[P4]`）：

```json
// 请求
{ "author": { "type": "user" }, "target": { "type": "broadcast" }, "content": "…" }
// 响应 201
{ "message": { …Message… }, "runs": [ { …Run… } ] }
```

gateway 依据每个 seat 的 responseMode 决定哪些 agent 产生 run，同步返回创建的 runs；后续进展全部走 SSE。

精确去除首尾空白后的`/new`与`/compact`由前端映射到上述控制端点，不调用Message端点；gateway控制端点同样是唯一权威。若客户端仍把这两个精确字符串提交到`POST .../messages`，gateway返回400 `control_command_required`，不得把它保存成普通Message或同时执行控制动作。其他包含斜杠的正文仍是普通Message。

聊天前端不提供独立的发送对象选择器。提交时按当前Space seats中的Agent名称解析正文里的`@Agent名`：命中的Agent id写入`target: { "type": "direct", "agentIds": [...] }`，未命中任何Agent名称则写入`target: { "type": "broadcast" }`；`content`保留用户输入的@文本。同名Agent全部命中，避免前端静默任选其中一个身份。

### Run

| Method | Path | 说明 |
|---|---|---|
| POST | `/api/runs/:id/cancel` | 取消在飞 run。幂等：已结束返回当前状态 |

### Approval

| Method | Path | 说明 |
|---|---|---|
| POST | `/api/approvals/:id/answer` | body `{ "answer": "allow" }`。幂等；非 pending 返回 409 `conflict` |

### AgentState

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/agent-states` | 全部 per-Space AgentState 列表；可带 `?spaceId=<spc_…>` / `?agentId=<agt_…>` 过滤 |

### Agent daemon 联邦接入 `[Phase 5.5]`

> 这是联邦形态（ground truth 2.4）的 agent daemon ↔ gateway 通道。所有路径以 `/api/agent/` 为前缀，只从 Tailscale Serve 私网入口开放；tailnet ACL 提供网络门禁，Vera agent token（`Authorization: Bearer <token>`）提供 agent 身份。用户视角仍走原 `/api/agents/*` / `/api/spaces/*`，不混用。

| Method | Path | 说明 |
|---|---|---|
| POST | `/api/agent/login` | daemon启动时报到。body `{ "homeAccountId"?, "accountRuntimes": [{ "accountId", "workspace": { "hostId", "path", "status", "policy", "lastValidatedAt" }, "runtimeCapabilities": {...} }] }`；登录只建立daemon/Agent在线会话，**不选择或独占Account**。响应返回agent、homeAccountId、候选accounts、seats、该Agent active AgentSessions的CLI `providerBindings`安全摘要、accountRuntimes、heartbeatIntervalMs；API规范history不下发为opaque state |
| DELETE | `/api/agent/sessions` | 主动登出。gateway将该daemon的presence/capability快照置离线并释放Execution租约，保留AgentSessions、CLI provider bindings与Workspace绑定不动 |
| GET | `/api/agent/events` | SSE 订阅，daemon 单一长连接收 *(1)* `agent.heartbeat`，*(2)* 分型`run.requested`：CLI只含`input:{kind:"cli",promptText,providerBinding?}`，API只含`input:{kind:"api",messages,historyVersion}`，subagent的input另标`sessionMode:"isolated"`且无持久binding/history，*(3)* CLI/API compact所需的`agent-session.compact.requested`，*(4)* 配置变更。不得同时发送两种input或在API payload夹带`promptText/providerBinding` |
| POST | `/api/agent/runs/:id/subagents` | 当前Run请求派生subagent Execution。body `{ "accountId": "acc_…", "task": "…", "context": {...}? }`；gateway从父Run继承审计用`agentId/spaceId/spaceSessionId`，校验目标Account的`authorizedAgentIds`与Workspace绑定，创建`role:"subagent"`、`parentRunId=:id`且`agentSessionId/contextGeneration:null`的pending Run。下发input固定`sessionMode:"isolated"`、无provider binding/historyVersion，终态不提交AgentSession。Account空闲时取得租约并下发；忙时保留pending排队。调用方不是父Run当前租约持有daemon→403；目标未授权→403 |
| PATCH | `/api/agent/runs/:id` | 在飞run的状态/属性更新；body可带`status/error/agentState`。daemon不得自行提交pending→running，该转换只属gateway调度器。API main Run未先成功提交`api-result`时，`completed`返回409 `history_conflict`；CLI main与isolated subagent无此门槛 |
| POST | `/api/agent/runs/:id/messages` | agent 发言气泡。body 为 Message 形状去掉 `id/runId/createdAt/status`。每条气泡各发一次，落地进 Space 时间线 + 走 SSE `message.created` |
| POST | `/api/agent/runs/:id/delta` | 当前气泡的流式增量。gateway 转 `message.delta` SSE 事件给前端 |
| POST | `/api/agent/runs/:id/activities` | 创建/更新 activity（带 `callId` 合并同一条），落地 + `activity.created`/`activity.updated` SSE |
| POST | `/api/agent/runs/:id/approvals` | 提权申请，gateway 转 `approval.requested` 给前端 |
| PUT | `/api/agent/provider-bindings/:agentSessionId` `[P5-C1]` | 仅同步CLI外部会话绑定。body严格为`{generation,accountId,providerFingerprint,providerState,ifVersion}`；`providerState`只允许对应adapter已声明的thread/resume id安全形状，不得含API history、secret、路径或Memory。gateway校验agent token、当前Execution租约、AgentSession/generation/account匹配并以CAS保存；旧generation或version返回409。API Agent不调用此端点 |
| PUT | `/api/agent/runs/:id/api-result` `[P5-C1]` | 仅API main Run在终态前调用。body严格为`{agentSessionId,generation,baseHistoryVersion,assistantMessageIds,toolTranscript?,usage?}`；gateway要求ids逐一属于该Run且已completed，用当前trigger Message构造最小署名input信封，与assistant/tool结果作为一个完整turn以CAS追加。toolTranscript只允许adapter profile声明的安全`{callId,name,arguments,result,status}`数组，不含隐藏思维、secret、路径或provider原文。成功返回`{historyVersion}`；版本/generation不符返回409 `history_conflict`并原子保持history不变。未成功提交该结果的API main Run不得标completed，冲突后必须failed且不重调provider。CLI与subagent不得调用 |
| PUT | `/api/agent/compactions/:jobId/targets/:agentId` `[P5-C1]` | daemon回报一个compact target。body严格为`{agentSessionId,fromGeneration,status:"succeeded"|"failed"|"cancelled",checkpoint?,providerBinding?,error?}`并匹配gateway已下发request。`native`成功必须返回同一CLI thread压缩后的安全providerBinding；`checkpoint_new_binding`或`gateway_history`成功必须返回checkpoint且不得返回binding，新generation首次Run再建CLI binding或由gateway构造API history。gateway CAS提交`generation+1`、冻结旧sidecar/binding并更新job；旧generation/重复不同结果409，完全相同重试幂等。compact输出不创建Message/Activity/Digest/Dream |

### Owner Tailscale 身份 `[Phase 5.5]`

普通客户端不使用 Vera 自建配对码或 device session。Tailscale Serve 必须覆盖/清除客户端伪造的身份头后，把已认证的 Tailscale login 转给回环 gateway；gateway 只在请求来源为本机 Serve 代理时信任该身份，并要求 login 精确命中 `config.security.ownerTailscaleLogins`。未命中返回 403；生产配置列表为空时除最小 health 外全部普通业务 API 拒绝服务并记录配置错误。

设备加入、过期与撤销由 tailnet 管理；Vera 不复制一套设备目录。`/api/agent/*` 不把 owner login 当成 agent 身份，仍必须验证 per-agent Bearer token。开发期直接访问 `127.0.0.1:3210` 的测试豁免只能由显式 development 配置开启，生产默认关闭。

**离线 @ 行为**（ground truth 2.4 决策第 3 条）：`POST /api/spaces/:id/messages` 处理时，普通主 Execution 默认取 seat Agent 的 Home Account；若该 Account 的 Workspace 宿主 `presence=offline`，gateway **不创建 Run**、不发 `run.requested`，而是在该 Space 时间线发一条 Activity：

```json
{
  "itemType": "activity",
  "id": "act_…",
  "spaceId": "spc_…",
  "runId": null,
  "agentId": "agt_离线那位",
  "phase": "error",
  "label": "agent-offline",
  "detail": "X 当前离线，已跳过此条",
  "createdAt": "…"
}
```

前端渲染成一行普通 error 提示（无 `runId` 关联，无引爆 card）。下次该 agent 上线不补发这条触发消息（无副作用历史）。

### 配置 `[P4]`

- `GET /api/settings` → 200 `{ settings: <object> }`：返回合并视图（overrides 叠 config 启动默认）。字段清单严格按 ground truth 4.1 / 4.3；运维参数（端口、数据路径、SSE 心跳/缓冲、store 落盘、daemon 回收、run 看门狗）走 env 不进，前端可读可写。
- `PATCH /api/settings` body `{ settings: <patch> }`：部分字段覆盖，成功 → 200 `{ settings: <object> }`（合并后视图）。未知 key 或值类型不合（enum 非 valid member / number 非 finite number / string 非 string）→ 400 `invalid_request`；body 形状非 `{ settings: <object> }` → 400。
- `[P4.6]` 对已知 key 传 `null` 表示删除该 override、恢复 config 默认值；响应仍返回恢复后的合并视图。`null` 不能创建未知 key。设置页“按组恢复默认”即对该组已知 key 一次 PATCH `null`，不另造 reset API。

**系统字段清单**（ground truth 4.1，严格遵守不扩）：

| key | 类型 | 默认值（config 派生） |
|---|---|---|
| `isolation.memory` | enum: `isolated` | `isolated`；Phase 5 起长期 Memory 固定 per-Agent、跨 Space，旧 `globalReadable` / `perSpace` 值不再是合法写入值 |
| `isolation.files` | enum: `isolated` / `specifiedShared` / `globalReadable` | `isolated` |
| `isolation.agentState` | enum: `isolated` / `globalVisible` | `globalVisible` |
| `memory.injectionBudgetResidentLines` | number | `config.memory.residentIndexMaxLines`（默认 25） |
| `memory.injectionBudgetRetrievalTokens` | integer `0..4096` | `384`；`0`只关闭自动消息尾部注入，不关闭Agent主动MCP拉取 |
| `presentation.bubbleBoundaryPattern` | string（正则源） | `config.bubbles.boundaryPattern` |
| `presentation.bubbleMinLength` | number | `config.bubbles.minLength` |
| `presentation.bubbleMaxLength` | number | `config.bubbles.maxLength` |

旧`memory.digestTrigger`、`memory.digestSchedule`与`memory.digestRealtimeThresholdChars`只作为M4一次性迁移输入，不属于当前`GET/PATCH /api/settings`白名单。gateway为每个迁移前现存Agent生成`memory/_config`中的Digest配置；旧`schedule`没有时区，固定使用运行配置`memory.scheduleTimezone`（env `VERA_MEMORY_SCHEDULE_TIMEZONE`，默认`UTC`），不得猜宿主本地时区。迁移记录版本`memory-config-v1`，先把原settings与待写per-Agent配置保存为store migration marker并flush，再逐Agent幂等写入，最后删除settings旧键并完成marker，崩溃重启按marker继续。迁移完成后新Agent使用per-Agent默认：Digest `manual`、Dream `manual`，不再继承历史全局模板；不得保留“全局默认 + per-Agent override”的双读优先级或第二个可写UI入口。两项injection budget仍是gateway全局预算。

**Appearance字段 `[P4.6]`**（ground truth 4.3；默认值统一由 `config.appearance` 派生，代码不得另写第二份）：

| key | 类型 | CSS变量消费者 |
|---|---|---|
| `appearance.theme` | enum: `system` / `light` / `dark` / `custom` | 根节点 `data-theme` + token组 |
| `appearance.themeId` | string或`null`；`theme: custom`时指向已保存Theme | token loader加载Theme Palette |
| `appearance.themeColor` | string（合法CSS color） | `--vera-color-theme` |
| `appearance.accentColor` | string（合法CSS color） | `--vera-color-accent` |
| `appearance.fontFamily` | string | `--vera-font-family`（全局） |
| `appearance.fontSize.phone.chat` / `.management` | number（px，正数） | `--vera-font-size-phone-chat` / `--vera-font-size-phone-management` |
| `appearance.fontSize.desktop.chat` / `.management` | number（px，正数） | `--vera-font-size-desktop-chat` / `--vera-font-size-desktop-management` |
| `appearance.bubbleRadius.phone` / `.desktop` | number（px，非负） | `--vera-bubble-radius-phone` / `--vera-bubble-radius-desktop`（只用于聊天气泡） |
| `appearance.bubbleGap.phone` / `.desktop` | number（px，非负） | `--vera-bubble-gap-phone` / `--vera-bubble-gap-desktop`（只用于聊天时间线） |
| `appearance.windowMargin.phone.chat` / `.management` | number（px，非负） | `--vera-window-margin-phone-chat` / `--vera-window-margin-phone-management` |
| `appearance.windowMargin.desktop.chat` / `.management` | number（px，非负） | `--vera-window-margin-desktop-chat` / `--vera-window-margin-desktop-management` |

`chat`只指全屏聊天主页；`management`覆盖Space导航、当前Space设置、Settings及其子页、Account/Memory等管理页面。主题、主题色、高亮色和字体族保持全局；字体大小与窗口边距按“phone/desktop × chat/management”分域，气泡圆角/间距按phone/desktop分域且只影响聊天。前端按当前媒体宽度与路由把这些源token映射到`--vera-font-size-base`、`--vera-window-margin`、`--vera-bubble-radius`、`--vera-bubble-gap`四个运行时别名，组件只消费别名，不自行判断设备或页面。

F0确认默认值：`theme: "system"`、`themeId: null`、`fontFamily: "system"`；`fontSize.phone.{chat,management}: 14`、`fontSize.desktop.{chat,management}: 16`；`bubbleRadius.{phone,desktop}: 16`；`bubbleGap.phone: 4`、`bubbleGap.desktop: 10`；`windowMargin.phone.{chat,management}: 12`、`windowMargin.desktop.chat: 64`、`windowMargin.desktop.management: 8`。实现时这些值只定义在`config.appearance`，本文不形成第二份运行时默认。

前端允许在内存中覆盖这些CSS变量做实时预览；只有用户确认保存才 PATCH gateway。刷新、换设备或取消预览后，以 `GET /api/settings` 为准，`localStorage` 不保存已确认配置；F0 UI Lab只在当前预览内存中记录并导出未提交候选，不能冒充gateway已保存值。

**Theme与Appearance Profile交换 `[P4.6/F1]`**：Theme Palette与个人布局配置是两个独立对象，切换或导入Theme不得覆盖字体、字号、气泡或窗口边距。

```json
{
  "schemaVersion": 1,
  "kind": "vera-theme",
  "name": "Catppuccin Mocha",
  "colors": {
    "background": "#1e1e2e",
    "surface": "#313244",
    "text": "#cdd6f4",
    "mutedText": "#a6adc8",
    "border": "#45475a",
    "accent": "#89b4fa",
    "success": "#a6e3a1",
    "warning": "#f9e2af",
    "error": "#f38ba8"
  },
  "terminal": {
    "foreground": "#cdd6f4",
    "background": "#1e1e2e",
    "cursor": "#f5e0dc",
    "selection": "#585b70",
    "ansi": ["#45475a", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#bac2de", "#585b70", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#a6adc8"]
  }
}
```

- `GET /api/themes` → `{ themes: [{ id, name, schemaVersion, createdAt, updatedAt }] }`，只返摘要。
- `GET /api/themes/:id` → `{ theme: Theme }`；不存在返回404 `not_found`。
- `POST /api/themes/import` body `{ format, content, name? }`，`format`首批为`vera-json` / `vera-css` / `itermcolors` / `terminal-profile`；只解析并返回`{ preview, warnings }`，不持久化。
- `POST /api/themes` body `{ theme: Theme }`，保存已经确认的归一化Theme；成功返回`{ theme }`。
- `PATCH /api/themes/:id`只更新`name`或归一化`colors`/`terminal`；`DELETE`若被当前`appearance.themeId`引用则409 `conflict`，否则删除Theme记录，不改变消息或其他配置。
- `GET /api/themes/:id/export?format=vera-json|vera-css`导出Theme Palette；第三方终端格式先只承诺导入，不承诺无损导出。
- `GET /api/settings/appearance-profile/export`导出`{ schemaVersion: 1, kind: "vera-appearance-profile", appearance }`，其中不含`theme`、`themeId`、`themeColor`、`accentColor`；`POST /api/settings/appearance-profile/import`校验同一形状并只返回`{ preview, warnings }`，不保存。用户确认后仍用`PATCH /api/settings`写入，恢复默认仍对相应字段传`null`。

`vera-css`只允许`:root`或受支持的`[data-theme]`中的白名单`--vera-color-*`/`--vera-terminal-*`声明。gateway必须拒绝任意选择器、未知变量、`@import`、`url()`、外部字体和非声明规则，再将合法值归一化为Theme对象；不得保存或回传原始可执行CSS。终端转换器只读取前景/背景/光标/选区与16色ANSI调色板，缺失的Vera语义色返回`warnings`并按确定性默认规则派生。

Space/Agent 设置由各自现有 API 管（`/api/spaces` / `/api/agents`），不进 settings；响应规则 per-agent per-Space 挂在 seat 上（`responseMode` / `respondTo` / `blockAgentIds`，见 Space 段），不进 settings；Account 的 `authorizedAgentIds` 由 `/api/accounts` 管（Phase 5.5 落地）。

**持久化语义**：`<dataPath>/settings.json` 保存设置override，`<dataPath>/themes.json` 保存归一化Theme对象，均走store防抖落盘（与 store 同 200ms 节流）。config.js 仍是启动默认 source（env 派生），settings.json 是运行时覆盖；只 persist overrides，不 persist 默认值或导入原文。consumer 接入（bubble-stream / view-compiler / memory 整理、Appearance token loader等）在 Phase 4.6 及以后；没有实际consumer和实测记录的字段不得在 `plan/index.md` 指向的对应功能计划中标成闭环完成。

### Memory（P5-M1–M4；Provider、权威层、Digest与Dream）

M1–M3已冻结的Markdown、Digest与retrieval细节继续有效；本轮在M4实现前先冻结active Memory Provider、Data配置、Digest/Dream任务模型与Dream job外部契约。自定义Provider的Extension Package安装/卸载和driver ABI仍属Phase 6，但本节先固定它进入Vera所必须满足的产品/API边界，不得先做任意第三方MCP直连或自动数据转换。

#### Active Memory Provider 与 Data 配置 `[P5-M4契约，Provider安装在P6]`

每个Agent恰有一个active Memory Provider。未显式配置时返回内置`vera.markdown`；它使用下文现有per-Agent Markdown/Obsidian-compatible vault。只有已安装、manifest显式声明`memory-provider`能力并通过gateway契约校验的扩展才进入候选；普通第三方MCP即使暴露memory命名工具也不进入。自定义Provider可以把文件、数据库或远程服务作为原生事实来源，不要求复制或转换成Markdown。

Provider的核心契约是稳定的per-Agent身份绑定、稳定条目标识以及`list/fetch/search`安全投影；自定义Provider可把原生稳定ID映射为Vera facade使用的稳定slug/key，而不改变或复制原生存储。`create/update/archive/delete/sources/versioning/pin/links/usage/externalEdit`均由`capabilities`显式声明；模型整理能力另分为`digest.ingest`与`dream.maintenance`，并分别列出支持的`create/update/supersede/archive/merge/structureRewrite` operation。Digest至少要求可验证sources及create/update/archive；Dream只可使用其声明且符合下文窄化边界的maintenance operation。gateway始终掌握Agent身份、Message可见性、水位、调度、executor隔离、最终校验与无fallback；Provider driver只提供安全逻辑投影并把校验后的operation翻译成原生事务。缺失能力必须禁用相应UI/任务并返回`memory_provider_unsupported`，不能伪造实现。

```json
{
  "agentId": "agt_x1y2",
  "provider": {
    "providerId": "vera.markdown",
    "config": {}
  },
  "digest": {
    "executorAgentId": "agt_helper",
    "modelMode": "fixed",
    "model": "gpt-5.3",
    "trigger": { "mode": "realtime", "thresholdChars": 20000 }
  },
  "dream": {
    "executorAgentId": null,
    "modelMode": "fixed",
    "model": "gpt-5.4",
    "schedule": {
      "mode": "weekly",
      "timezone": "Asia/Tokyo",
      "weekday": 1,
      "time": "03:00"
    }
  },
  "version": "sha256:opaque"
}
```

上例故意展示Digest委托给另一个执行Agent、Dream由owner自身执行，并分别选择两个`fixed`低成本模型的显式配置，不代表系统默认值；默认仍是两者`executorAgentId:null`、`modelMode:"inherit"`、`model:null`。

- 产品UI把active Provider显示为“Memory结构”；默认项文案为`Vera（兼容 Obsidian）`，内部`providerId`仍为`vera.markdown`。`config`只接受该Provider公开schema中的非敏感值或`secretRef`，不接受明文secret。切换active Provider不触发导入、复制或迁移；旧Provider数据保持原位但立即退出该Agent的检索、MCP写入、Digest和Dream事实来源。新Provider不可用时明确报错，不得回退到旧Provider或`vera.markdown`
- Digest与Dream不绑定Hook，但分别在Data配置保存可选`executorAgentId`；`null`表示owner Agent自身，非空必须是owner可选择且对该任务可用的现存Agent。job的`ownerAgentId`始终是URL中的`agentId`，proposal只能写入owner active Provider；执行Agent只提供其Home Account连接/runtime与已验证task model。`modelMode`只允许`inherit/fixed`：`inherit`要求`model:null`并使用入队时执行Agent Home Account的聊天默认模型；`fixed`要求`model`精确匹配同一连接下对当前任务真实可用且已验证的候选，不接受任意自由文本。`PATCH .../memory/_config`不接受`executorBinding/enabled/accountId`。Digest `trigger.mode=manual`与Dream `schedule.mode=manual`只关闭各自自动触发，手动任务仍可执行
- Digest与Dream资格分开记录和查询；同一model的Digest verification不能用于Dream。fixed并不是失败fallback；入队后所选模型不可用时任务返回`memory_task_unavailable`，不得静默切回聊天默认模型、其他模型、其他Agent、其他Account或其他Provider
- Phase 5.5完成Home Account迁移前，M4进程内任务只在某执行Agent恰好存在一条历史`owningAgentId` Account时把它视为过渡Home Account；零条或多条都明确`memory_task_unavailable`，不得按数组第一条、最近使用或provider猜选。Phase 5.5迁移后删除这条过渡解析并只读正式Home Account绑定
- Digest `trigger.mode`沿用`manual/scheduled/realtime`互斥语义；`scheduled`为`{mode:"scheduled",cron,timezone}`，`realtime`为`{mode:"realtime",thresholdChars}`，`manual`不带附加字段。待整理上下文统计的是已完整保存、对该Agent可见且尚未被成功incremental Digest覆盖的Message，不是供应商context window，也不是Digest后删除的短时缓存
- Dream `schedule.mode`只允许`manual/daily/weekly/custom`。`manual`不带时间字段；`daily`要求IANA `timezone`与`HH:mm` `time`；`weekly`再要求ISO weekday `1..7`；`custom`要求受校验的五段`cron`与`timezone`。修改调度只影响新job；last/next/current状态是派生状态，不写进config
- 新Agent默认创建并启用`vera.memory`、`vera.memory.recall`、`vera.memory.write` binding；三者都是gateway runtime且没有执行Agent。Digest/Dream的`executorAgentId`默认`null`，`modelMode`默认`inherit`且`model=null`；两者自动策略均默认`manual`，不在用户未选择频率前产生后台模型费用。现有Agent的Digest trigger按M4一次迁移规则初始化

最小Data配置与状态端点：

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/agents/:agentId/memory/_config` | 返回`{config,version}`，version是配置规范JSON的opaque hash且不嵌入config；agent不存在404 |
| PATCH | `/api/agents/:agentId/memory/_config` | body严格为`{provider?,digest?,dream?,ifMatch}`，`ifMatch`必填；出现的`provider/digest/dream`对象各自是**整段替换**而非递归merge，省略的顶层段保持不变。digest/dream可保存`executorAgentId/modelMode/model/trigger|schedule`，但不接受binding/enabled/account字段；按Provider schema、可选执行Agent及其Home Account任务候选完整校验后原子保存，返回`{config,version}`。version冲突409。普通执行Agent/模型/调度修改只影响新job；切换Provider时若Digest或Dream有active job则409 `memory_job_active`，不得让旧Provider快照在切换后继续apply |
| GET | `/api/agents/:agentId/memory/_options` | 返回`{providers:[{providerId,name,source,kind,availability,capabilities,configSchema?,locationKind}],tasks:{digest:{executors:[{agentId,name,availability,models:[...]}]},dream:{executors:[{agentId,name,availability,models:[...]}]}}}`；Provider只列内置或已安装且声明`memory-provider`的候选。每类任务只列owner可选择的执行Agent安全摘要，以及该执行Agent Home Account同一连接下真实可用且已验证的模型；Digest与Dream资格不复用。`locationKind`为`file/database/remote/none`；不返回Account连接、secret、宿主路径或验证夹具正文 |
| GET | `/api/agents/:agentId/memory/_status` | 返回`{provider:{providerId,state,capabilities,location?},longTerm:{activeCount,archivedCount,logicalBytes?,estimatedTokens:{estimator,value}},pendingContext:{messageCount,charCount,estimatedTokens:{estimator:"vera-utf8-v1",value},spaces:[{spaceId,spaceSessionId,messageCount,charCount,estimatedTokens,currentContext?}]},digest:{status,lastJob?,nextRunAt?},dream:{status,lastJob?,nextRunAt?,currentJobId?}}`。每个SpaceSession的`estimatedTokens`表示未Digest Message若仍作为原始对话随当前窗口携带时造成的额外上下文量级；`currentContext`另投影对应active AgentSession的`agentSessionId/generation/estimatedInputTokens/effectiveLimitTokens/pressureRatio/measurement`，用于判断这份积压在当前窗口中的相对压力。两者都是估算，不冒充provider账单；跨Space汇总更不得宣称为下一轮精确消耗。`logicalBytes`或估算不可得时为null，不伪造。Memory状态不返回Recall/Write binding；Hooks页直接读取唯一unit binding事实来源。`location`仅对file Provider返回安全展示值，默认Provider可含只读`vaultRoot/agentPath`，修改位置跳全局受控路径迁移 |

`PATCH _config`切换Provider若目标未安装/未声明/缺少核心能力，返回422 `memory_provider_unsupported`并保持旧绑定；Provider已合法绑定但健康检查失败不阻止保存，状态显示`unavailable`，随后的操作返回503 `memory_provider_unavailable`。切换成功后清空该Agent的Provider-scoped cursor/检索sidecar；已经开始的AgentSession generation保留其冻结常驻前缀，下一次按正常compact或`/new`产生的generation才注入新Provider常驻前缀，切换Provider本身不得偷增generation。旧Provider数据不删除。响应不得声称数据已迁移；前端必须明确提示“原记忆保留在原Provider，当前不会读取”。所有`_config/_options/_status/_digest/_dream`保留段必须先于`:slug`注册，避免与合法slug冲突。

**默认`vera.markdown`文件库**：默认 `~/.vera/memory/`（配置项，env `VERA_MEMORY_VAULT_PATH`），Obsidian 兼容 vault，在仓库外。**长期 Memory 随 agent 身份跨 Space、跨 Account/Execution**：vault 根目录下按 agentId 分子目录 `~/.vera/memory/<agentId>/`，每个 agent 的记忆隔离，slug 在 agent 内唯一且建立后不可普通改名。不存在隐式“所有 Agent 可读”的全局池；未来若需要共享，必须另定义显式作用域、授权和来源契约，不得把 per-Agent 目录合并扫描。以下文件/frontmatter/外部编辑规则只约束`vera.markdown`，不要求自定义Provider转换物理存储。每条记忆一个 `.md` 文件：

- 文件名 = 语义化 kebab-case slug（如 `bubble-split-rule.md`）。slug 即公共指针，一经建立不改名（R2）。
- frontmatter（YAML）：

```yaml
schemaVersion: 1
type: decision        # 枚举可扩展，起步集：project_rule / architecture / workflow / preference / correction / bug / decision / open_question
description: 一行钩子——常驻索引只展示这一行
scope:                # M1 只允许当前 Agent；目录与 agentId 必须一致
  type: agent
  agentId: agt_x1y2
status: active        # active / archived（过时先归档不删除）
stains:               # 可选，哑墨（R5）：agentId -> 裸 hex。四不：不注入、不解释、不引用、不作为判断依据
  agt_x1y2: "#7A8FA6"  # 为空时序列化为 `stains: {}`，键不省略
sources:              # 非空；只冻结下述两种 SourceRef
  - kind: message
    spaceId: spc_a1b2
    messageId: msg_m1n2
createdAt: 2026-07-13T00:00:00.000Z
updatedAt: 2026-07-13T00:00:00.000Z
```

- 正文为 markdown，`[[slug]]` 双链；指向尚不存在的 slug 合法（标记待写，不是错误）。
- `schemaVersion` 当前只能为 `1`；`scope` 当前只能是 `{ type: "agent", agentId }` 且必须与目录一致，禁止 `global` / `perSpace` 兼容值。`type` 是可扩展的小写 token（允许现行 `project_rule` / `open_question` 与 kebab-case 扩展），不做固定枚举分支；`description` 必须是非空单行字符串；`status` 只允许 `active` / `archived`；`stains` 必须是 `agt_... -> #RRGGBB` 对象；权威时间戳统一为带毫秒的 UTC ISO 8601（`YYYY-MM-DDTHH:mm:ss.sssZ`）。
- `SourceRef` 只允许 `{ kind: "message", spaceId, messageId }`、`{ kind: "deleted-message", spaceId, messageId, deletedAt }`或`{ kind: "manual", actor: "user" | "legacy", capturedAt }`。message ref 必须能在 gateway store 找到同 id Message 且 `message.spaceId === spaceId`；只保存引用，不复制 Message 正文。`deleted-message`只允许由永久删除Space的gateway流程从既有message ref生成，表示原文已按用户确认删除、不可再展开，不接受HTTP/MCP/model伪造。Activity、Run、工具过程和任意自由`kind`均不合法。手动POST不接受客户端伪造`sources`，由gateway补`{kind:"manual",actor:"user",capturedAt:now}`。
- F1 旧格式曾是合法数据，不能静默消失：仅当旧文件严格符合当时的 `type/description/status/stains/createdAt/updatedAt` 形状时，gateway 经同一 per-Agent 队列原子补齐 M1 字段，来源写为 `{ kind:"manual", actor:"legacy", capturedAt:createdAt }`，明确表示没有可追溯 Space；其他缺字段或畸形文件保持原位并进入坏文件错误，不猜测归属、不覆盖修复。
- API 的 `version` 是最终完整文件字节的 opaque `sha256:<hex>`，不写回 frontmatter（避免 hash 自引用）；`ifMatch` 与该值比较。`updatedAt` 是展示元数据，不再承担并发版本职责。

**常驻索引注入**：gateway memory 模块扫描该 agent 的 vault 子目录（`<vaultPath>/<agentId>/`），生成至多 N 行（配置，默认 25）`[[slug]] — 钩子行` 索引，在每个AgentSession generation的**首条Run**头部注入，并提示「相关时调用Vera Memory MCP展开slug」。不向Agent暴露宿主vault绝对路径，也不让它用文件工具直读。索引**批量换版**：只随AgentSession generation换代，不逐条消息刷新（缓存纪律——它属于稳定前缀，不是逐条变化的检索注入）。M3历史实现的挑选顺序为置顶项按`pinnedAt,slug`稳定排序优先，非置顶项因`derivedWeight=0`按slug稳定排序，archived排除；M4只替换非置顶的长期派生权重。

**读写与单写者**：Agent runtime（主Agent、subagent、CLI、daemon及未来Hook/Dream）的Memory读写统一进入gateway第一方Vera Memory MCP，再由Memory facade路由到active Provider；不得绕过Provider用文件/数据库工具直读直写。owner前端保留HTTP管理API。对`vera.markdown`，HTTP与MCP写入最终翻译成内部`MemoryOperation`：`{ operationId, agentId, origin, kind, slug, ifMatch, value|patch, requestedAt }`。origin为`user-api`/`agent-mcp`/`memory-hook`/`memory-dream`/`external-scan`，kind为`create`/`update`/`archive`/`delete`。自定义Provider接收等价driver operation并负责原生存储事务；MemoryOperation不是公网API。

同一 Agent 的 operation 进入 FIFO，前一项失败不得毒死后续队列；不同 Agent 可并行。create 的重复检查以及 update/archive/delete 的 `ifMatch` 检查必须在队列内完成。create/update 先在目标文件同目录写唯一临时文件并 flush 文件，再以不覆盖 create / 原子替换 update 的方式提交，最后尽可能 flush 目录；失败清理临时文件，旧文件保持完整。成功提交权威文件后才能更新派生索引。vault 热切换必须等待在途 operation 排空，不能让一次写跨两个根目录。

用户通过 Obsidian 所做的外部新增、编辑、删除由 gateway 重扫后进入同一 Agent 队列刷新派生状态；它保留原 `sources`，不伪造成 gateway 写入，也不自动修补一般坏文件。

**Agent 作用域**（F1修订）：owner Memory管理API以`/api/agents/:agentId/memory`为前缀；Vera Memory MCP tool参数中**禁止出现`agentId`**，gateway从可信调用上下文注入身份。两条入口都按`agentId`隔离同一active Provider facade——agent A无法读写agent B的记忆。前端Agent使用管理的Data → Memory进入`#/agents/:agentId/data/memory`时才加载配置与状态，再按需进入长期Memory管理，不预取所有agent的Memory正文。

**派生索引与坏文件隔离**：索引放在 `<vaultPath>/.vera-index/<agentId>.json`，M3提升为形状 `{ schemaVersion:2, generation, builtAt, agentId, entries, errors }`；entry 至少含 `slug/version/type/description/status/sourceRefs/links/updatedAt`，明确不含`stains`。索引只是缓存：缺失、JSON 损坏、版本不支持或文件指纹变化时，只读 vault + store SourceRef 全量重建，经临时文件原子替换索引；不得反向覆盖 markdown。每次 scan 返回 `{ agentId, scannedAt, created, updated, removed, unchangedCount, invalid, index:{ generation, builtAt, status } }`，其中 status 为 `current` / `rebuilt` / `degraded`；索引写失败只令 status=`degraded`，不混进 MemoryFileError。坏文件保留原位、排除列表/常驻索引，并产生 `{ code, relativePath, slug, issues:[{ field, code, message }] }`；对外不得泄露 vault 绝对路径。单个坏文件不影响其他记忆；直接 GET 坏文件返回 422 `invalid_memory_file`。

**旧根目录文件处理**（F1 一次收口）：历史版本若在 vault 根目录留有未分 agent 的 `*.md`，gateway 不得猜测归属、不得删除，也不提供旧 `/api/memory/*` 双路由。这些文件保持原地，`/api/paths` 与 `/api/status` 显式返回 `legacyUnscopedCount`；存在未归属文件时拒绝 vault 迁移（409），由用户先人工移入明确的 `<agentId>/` 后重试。

#### Vera Memory MCP（第一方Agent接口）

MCP工具名是Vera契约，不宣称存在行业标准Memory tool集合。当前Phase 5先实现协议无关dispatcher，调用方必须传入gateway内部已绑定的`{ agentId, sourceRefs, runId? }`可信上下文；tool schema不含`agentId/scope/origin/sources`。Phase 5.5 agent token落地后，gateway再把同一dispatcher绑定到Tailscale私网Streamable HTTP transport；Bearer token解析出的agentId就是唯一Memory身份。此前不得注册允许网络调用者自选agentId的临时`/mcp`端点，也不得用owner身份冒充agent身份。

`vera.memory` unit只允许启用状态、可用性和工具清单；unit binding与所有tool schema都不得出现`executorAgentId/semanticAgentId/model/embedder`。Recall/search的粗召回、embedding、筛选、去重、排序和token预算由gateway固定执行，不调用聊天Agent。未来小模型语义增强必须另立版本化阶段与失败语义；本阶段不预留假字段、不自动选Agent、不静默调用模型。

| 阶段 | Tool | 输入（均不含agentId） | 行为 |
|---|---|---|---|
| M1增量 | `memory_list` | `{ status?, type? }` | 列出当前Agent的Memory摘要与坏文件诊断 |
| M1增量 | `memory_fetch_detail` | `{ slug }` | 按已知slug读取权威正文；M1不记录正文展开统计，M3在同一工具上增强一跳链接与使用统计 |
| M1增量 | `memory_create` | `{ slug,type,description,content,stains? }` | gateway从可信Execution上下文注入SourceRefs，再提交`agent-mcp/create` operation；无可验证来源时拒绝 |
| M1增量 | `memory_update` | `{ slug,ifMatch,type?,description?,content?,stains? }` | 保留原sources并走opaque version并发控制；归档只走`memory_archive`，不留同义入口 |
| M1增量 | `memory_archive` | `{ slug,ifMatch }` | 归档而非物理删除；Agent MCP不开放不可逆delete |
| M2 | `memory_digest` | `{ fromMessageId,toMessageId,mode }` | 只引用gateway已保存的Message范围创建digest job；不重复ingest或复制Raw Message |
| M3 | `memory_search` | `{ query,tokenBudget? }` | query NFKC后1..4096 code points；tokenBudget默认1200、范围64..1200。不接受scope/status/type/session/identity filter；检索、图扩散、去重、软配额和预算均由gateway固定执行 |
| M3 | `memory_fetch_more` | `{ cursor,direction,tokenBudget? }` | cursor由server snapshot产生；direction只能是该snapshot返回的`all`或`directionId`，选定后后续cursor绑定该分支；tokenBudget同search |
| M3增强 | `memory_fetch_detail` | `{ slug }` | 保持M1工具名与参数不变，增加一跳链接并记录使用统计 |

M2实现`memory_digest`前必须冻结跨job、跨slug的确定性事实身份或等价匹配规则。slug仅是公共指针，不能作为唯一语义去重键；同一事实以不同措辞或建议slug再次出现时必须命中既有Memory并update/merge，纠错或新事实取代旧事实时必须supersede/archive且保留双方SourceRefs。该身份属于可重建的程序派生数据，不成为Agent可手写的Memory frontmatter字段；精确名称和算法留在M2契约先行步骤一次定稿。

#### M2 digest job、触发与事实匹配

per-Agent Digest配置中的`trigger`是单选自动策略：`scheduled`与`realtime`不同时运行；选`manual`只关闭自动策略。`vera.memory.write`是自动Digest总开关：关闭时不按scheduled/realtime enqueue，但owner HTTP与可信Agent MCP手动Digest始终可用。`realtime`的唯一水位是`(agentId, spaceSessionId)`下、上次成功增量job之后已完整保存Message正文的Unicode code point数；Digest范围不得跨SpaceSession，`/new`不丢弃旧窗口未整理水位。达到阈值只异步enqueue，聊天请求、Run结束与context compact均不等待整理。pending token只用`vera-utf8-v1`表达整理积压，不能冒充provider精确计费或触发context compact。Write Hook不参与Dream调度。

范围首尾inclusive，必须属于同一SpaceSession，按store `_seq`顺序解析，只引用gateway已保存的`status=completed` Message；job不持久化Message正文副本。Agent可见谓词保持不变。`mode`为`incremental`或`range`：automatic trigger只创建incremental；manual两者都可用。incremental成功（包括全skip）才推进该`(agentId,spaceSessionId)`自动水位，failed/cancelled不推进；manual range不推进，manual incremental推进。同一`(agentId,spaceSessionId)`最多一个active job，后续Message留给下一冻结窗口。

持久job安全摘要：`{id,agentId,spaceId,spaceSessionId,mode,trigger,range:{fromMessageId,toMessageId,messageCount,charCount,estimatedTokens},pipelineVersion,idempotencyKey,status,attempt,createdAt,startedAt?,finishedAt?,error?,result?}`；其中公开`agentId`始终是Memory owner Agent。其余状态、快照、幂等、错误与无fallback规则保持不变；冻结快照不得含AgentSession checkpoint、API history、CLI provider binding、connection/secret或Workspace。

status为`queued/running/applying/succeeded/failed/cancelled`；公开错误只使用本节冻结的Memory job安全code。`idempotencyKey`必须包含owner agent、spaceSession、range、mode、pipelineVersion及冻结任务/Provider指纹。入队冻结`memoryTaskSnapshot={ownerAgentId,executorAgentId,accountId,kind,provider,modelMode,taskModel,verificationId}`与`memoryProviderSnapshot={providerId,bindingVersion,configVersion}`；retry复用原快照，设置变化只影响新job。每个proposal与MemoryOperation使用稳定派生id并持久applications receipt，重试只继续未应用项或识别已达状态为noop。

程序按可见Message顺序切分：每块最多8000 Unicode code points，不重叠，不拆单个Message；单条超限Message独占一块。gateway内部可保留chunk id、边界和计数用于确定性调度，但送给executor/model的`chunks`只允许是`[{messages:[{messageId,author,target,content,createdAt}]}]`；不得暴露chunk id/from/to/count等可被误认成证据ID的内部元数据，proposal的`evidenceMessageIds`只能逐字复制其中的`messageId`。SourceRef仍由gateway另行生成。executor同时收到当前Agent全部fact catalog的 `{factId,slug,type,description,status,addressSlots,valueHash,version}`；尚无M2 receipt的手动/legacy/Obsidian Memory以`{factId:null,slug,type,description,status,version,unmapped:true}`进入同一catalog，供模型提议一次adopt，不得收到stains、vault路径或provider连接。`type`让executor在update/supersede时看到现有结构化分类，避免无意改类；它不进入fact identity。proposal数组最多32项。

`memory_digest`的HTTP/MCP输入永远不接受executorAgentId、accountId、provider、model或fallbackModel；这些只能从owner Agent已保存的Memory配置解析。gateway入队时读取Digest的`executorAgentId/modelMode/model`：null解析成owner Agent，非空解析成所选执行Agent；inherit冻结该执行Agent Home Account当时的聊天默认模型，fixed必须精确命中该执行Agent的Digest已验证候选。gateway调用`digestMemory({account,taskModel,payload,signal})`：`account`只给可信adapter控制层提供执行Agent Home Account连接与聊天默认模型，`taskModel`是本job冻结的实际任务模型；adapter不得读取unit binding、自行换执行Agent/Account/model或把Account connection/secret送进prompt。即使执行Agent是B，payload也只含owner A本次冻结的可见Message chunks、A的fact catalog安全投影和固定Digest指令，不得包含B的AgentSession、checkpoint、API history、CLI provider binding、Memory、普通system prompt、Workspace或Tools；proposal必须按A的scope校验并只写A的active Provider。`kind=api, provider=ollama`的Gemma Account由原生Ollama adapter直接调用`connection.baseUrl`并使用`taskModel`、固定digest `temperature=0`及实测transport schema；`kind=cli, provider=codex`的Codex Account使用`taskModel`和非交互`codex exec`。Codex digest每个job都在新临时cwd执行`--ephemeral --ignore-user-config --ignore-rules`，不resume聊天thread、不读取任何聊天AgentSession或CLI provider binding、不传Account Workspace，使用read-only sandbox和`approval_policy=never`，强制通过`--output-schema`传schema且显式传任务模型；任何tool JSONL item都使executor失败，输出还须经过gateway完整validator。Ollama与Codex路径不共享Account、AgentSession/API history/CLI provider binding或连接，均不得fallback。OpenCode聊天与digest代码保留，但OpenCode digest当前不参与生产dispatch，明确`executor_unavailable`且不得退化调用聊天`run(ctx)`。公共job不返回memoryTaskSnapshot、endpoint、命令、provider原文、宿主路径或secret。

Digest资格不是“adapter存在”或`presence=online`。gateway为Data → Memory生成执行Agent与任务模型候选时，必须使用真实Digest资格夹具生成的不可伪造内部记录，绑定精确执行Agent Home Account连接/远程runtime修订、kind/provider、adapter profile与model不可变标识；本地模型的不同tag/量化变体分别验证。Account连接、runtime、provider或model改变使旧资格失效；同一模型搬宿主只可复用语义资格，仍须重新验证容量、超时与性能。Data → Memory通过`GET .../memory/_options`按执行Agent读取已验证model候选，不展示Account连接、secret、宿主路径或夹具细节。失败不得改投owner Agent、其他执行Agent、其他Account或其他模型。

模型只可返回严格 proposal：`{ action,evidenceMessageIds,targetFactId?,targetMemorySlug?,fact?,suggestedSlug?,type?,description?,content?,stains?,skipReason? }`。`fact={ subject:string,relation:string,qualifiers:string[],value:string }`，qualifiers去重排序后参与规范化。禁止提交 `agentId/scope/sources/origin/operationId/ifMatch/importance/confidence/targetSlug`，未知字段即整个 job 在 apply 前失败。create 必须有fact/suggestedSlug/type/description/content且不得有既有target；update/supersede/archive必须且只能二选一提交已存在`targetFactId`，或对catalog中`unmapped:true`条目提交`targetMemorySlug`完成首次adopt。update必须有同一事实fact/type/description/content；supersede必须有同地址不同value的fact/type/description/content；archive只需target与证据；skip只允许`skipReason=no_reusable_fact|unsupported_inference|ambiguous_match|duplicate_in_job`且不得带写字段。除skip外 evidenceMessageIds 必须为1..64个冻结范围内唯一可见Message id。gateway 必须先验证全部 proposal 的 schema、证据范围、Agent/Space scope、slug、单行description、双链、stain裸`#RRGGBB`与复用价值；任一非法则job在apply前失败、vault不变。模型/executor 不得到 store、vaultPath、Account connection、secret 或写接口。

程序把 `NFKC + 大小写折叠 + 空白折叠` 后的 `(agentId,subject,relation,排序后的qualifiers)` 哈希为新事实初始factId/address hash，把规范化value哈希为valueHash。自由文本hash本身不宣称解决同义词：executor必须优先从既有fact catalog选择opaque targetFactId；gateway只接受精确存在且slug/version仍对应的targetFactId。首次create才生成新factId；同义改写、不同suggestedSlug与跨job新证据通过复用targetFactId命中原slug。fact catalog由succeeded/partial job applications审计 + 当前vault版本重放重建，不写入frontmatter；Obsidian外部编辑导致version不符时该项标stale，下一次不能自动supersede，须executor重新提议update并由gateway以当前版本复核。地址相同而值冲突时，只有supersede且evidence含明确纠错文本才更新原slug；更新保留旧+新SourceRefs，并记录oldVersion→newVersion。仅当旧事实彻底失效且无替代正文时才archive。M2不合并两个既有文件、不rename；多候选或模糊匹配必须skip/reject。

整批proposal先验证后apply，因此非法proposal保证vault零变化。验证通过的原始proposal与当时catalog versions先持久化并flush，重试不得重新调用模型；apply阶段以proposal为恢复单元：每条proposal经M1队列保证单Memory原子，成功receipt随即flush；后续IO/版本失败可令job `failed` 且result保留已应用项，retry只继续未应用项。若进程恰在vault原子提交后、receipt flush前退出，持久proposal重放必须以当前权威内容+SourceRefs识别目标已达状态并no-op。M2不承诺多个Memory文件的跨文件原子事务，但任何时刻都不得出现半个markdown文件或重复创建；这就是“hook失败不产生半条记忆”的精确边界。

MCP `memory_digest` 的`mode=range`要求from/to；`mode=incremental`可省from，to缺省取可信run的trigger Message。tool schema仍不含agentId/spaceId/spaceSessionId/sources，三者从可信上下文绑定，成功返回安全job摘要。owner：`POST /api/agents/:agentId/memory/_digest` body `{spaceId,spaceSessionId,mode,fromMessageId?,toMessageId?}` → 202 `{job}`；其余幂等、查询、retry/cancel和SSE规则不变。

#### M4 Dream job与调度

Dream只读取入队时active Provider的长期Memory快照、安全usage派生与图/版本元数据，提出明确重复项合并、不改变事实含义的结构/描述/双链整理和冗余归档operation；它不监听实时对话，也不接收原始Message正文、AgentSession、Account Workspace或provider binding。没有冻结Message证据时，Dream不得纠正或supersede事实值、凭模型常识宣布事实过时、删除来源或直接写派生权重；事实变化必须回到有Message证据的Digest或owner手动编辑。gateway负责调度、冻结范围、验证proposal并通过同一active Provider facade提交；执行模型没有直接写存储权限。

**派生权重冻结**：Dream/derivedWeight子阶段本身不新增seed渠道，也不改变当前retrieval pipeline的scope/status/AgentSession generation过滤、BM25/vector召回、图扩散、交汇置信、类型适配、两阶段去重、软配额或token预算。它只对已经进入候选集的Memory计算`derivedWeight`，输入必须能从权威Provider与gateway store完全复算：双链唯一入度25%、安全usage 30%、owner编辑15%、置顶20%、按type时间衰减10%。每个分量先归一化到`0..1`再加权并clamp；`stains`不进入任一输入。usage中`detail_opened`权重为4，`auto_injected/search_returned/fetch_more_returned`权重为1；计数用同Agent候选中的`log1p`最大值归一化，最近使用按30天半衰期衰减，两者在usage分量内按`0.7/0.3`合成。owner通过HTTP创建或修改`type/description/status/content`、以及Obsidian外部编辑有效文件，写持久`user_edited` signal；仅改`stains`、pin、sources或程序Digest/Dream写入不产生该signal。owner编辑按180天半衰期衰减。置顶分量只读owner pin signal；常驻索引仍先完整排置顶项，再对非置顶项按derivedWeight降序、slug升序稳定排序。

type时间衰减是数据驱动表而非业务枚举分支：默认半衰期天数为`project_rule:3650, preference:1825, correction:1095, architecture:730, decision:730, workflow:365, bug:180, open_question:90`，未知type使用365；时间基准为权威Memory的`createdAt`，不得用混合自动写入的`updatedAt`冒充用户重要性。为避免完全确定的尾部饿死，derivedWeight可加入不超过`0.02`的确定性探索量；它只由gateway配置seed与slug派生，同seed可复算，不能把候选外Memory带进本轮，也不能改变其他四项分数。派生算法版本随retrieval pipeline冻结；清空派生索引后必须从vault+signals得到相同结果。

入队冻结`memoryTaskSnapshot={ownerAgentId,executorAgentId,accountId,kind,provider,modelMode,taskModel,verificationId}`和`memoryProviderSnapshot={providerId,bindingVersion,configVersion,indexGeneration?}`。`executorAgentId/modelMode/model`来自Data → Memory的Dream配置；null执行者在入队时解析成owner id，accountId固定为执行Agent的Home Account，taskModel是解析后的实际模型。即使执行者为B，Dream payload也只含owner A active Provider中本次冻结的长期Memory安全投影、允许的派生统计和固定Dream指令，不包含B的AgentSession、checkpoint、API history、CLI provider binding、Memory、普通system prompt、Workspace或Tools；proposal只允许写A的active Provider。Dream使用独立verification，不能复用Digest资格；retry复用原快照，配置变更只影响新job。任一冻结依赖在spawn前失效时返回`memory_task_unavailable`或`memory_provider_unavailable`，不静默fallback。

安全job摘要固定为`{id,agentId,trigger,requestId?,status,attempt,createdAt,startedAt?,finishedAt?,result?,error?}`；`trigger`为`manual/scheduled`，status为`queued/running/applying/succeeded/failed/cancelled`，result只含`{scannedCount,updatedCount,mergedCount,archivedCount,noopCount}`，error只含稳定code与安全message。不得返回prompt、Memory正文、proposal、stain、executor/provider snapshot、Account/provider连接、模型原始输出或宿主路径。

M4起Digest与Dream公共job错误码统一为`memory_task_unavailable/memory_provider_unavailable/executor_failed/invalid_range/invalid_proposal/write_conflict/write_failed/cancelled`，都落`failed`或`cancelled`终态；0.0.1不引入未定义恢复条件的`paused`状态。adapter内部`executor_unavailable`在job边界折叠成`memory_task_unavailable`，Provider健康/绑定失效折叠成`memory_provider_unavailable`。HTTP配置校验使用同名稳定code并按本节指定的409/422/503返回。

Dream executor payload严格为`{agent:{id,name},memories,proposalSchema}`。`memories`按slug稳定排序，每项只含`{slug,version,type,description,status,content,sources,links,derived}`；`links`是正文中唯一slug集合，`derived`只含上述可复算分量的数值安全摘要，不含query、stain、vault路径、Account、Provider config或任一Agent提示。单job最多冻结256条active/archived Memory；超过时按置顶、derivedWeight、slug稳定分批，当前M4一个job只处理冻结批次且结果明示`scannedCount`，不得让模型自行翻页或读vault。

Dream输出是严格`{proposals:[...]}`，最多64项，只允许下列四种proposal，所有target都必须逐字命中冻结快照且携带对应version；未知字段整批拒绝、apply前vault零变化：

- `keep`：`{action:"keep",targetSlug,targetVersion}`，只记noop receipt，不写Memory。
- `update`：`{action:"update",targetSlug,targetVersion,type?,description?,content?}`，只允许不改变事实命题和值的结构化重写、描述压缩或双链整理；至少一个可写字段。不得提交`stains/sources/status/slug/importance/confidence/fact/value`。gateway保留原sources，并以现有fact identity/valueHash与Provider能力校验；无法证明不改变事实时整批拒绝，等待Digest或owner处理。
- `merge`：`{action:"merge",targetSlug,targetVersion,sourceSlugs:[...],sourceVersions:{...},type,description,content}`。source为2..16条唯一active Memory且包含target；gateway把所有sources去重并入target，要求proposal content包含各成员原有出链的并集（排除组内自链），然后归档除target外的成员但不删除、不rename。指向这些已归档slug的既有入链不批量改写，因此仍可追溯；归档成员保留自身sources/content/version历史。
- `archive`：`{action:"archive",targetSlug,targetVersion,replacementSlug}`。Dream只允许归档已有明确active替代项的冗余Memory，因此`replacementSlug`必填且必须指向同一冻结批次的active Memory；只改status并保留sources/content，不写兼容别名。没有替代项的“过时/错误”判断不属于Dream。

同一slug在一个job中最多被一个非`keep` proposal写入；merge成员不得再被独立update/archive。全部proposal先做版本、能力、链接、来源与冲突预检，再进入同一Agent单写者的**批量维护临界区**：批内可逐文件原子提交与持久receipt恢复，但常驻/派生索引只在批次结束后重建并一次发布新generation。新的AgentSession generation只能看到旧整版或新整版常驻索引，不能看到半批；已经开始的generation及已冻结cursor始终保持原版本。进程在部分文件写入后退出时，retry按receipt与当前权威版本识别applied/noop并继续，不能重复merge或丢sources/双链。

| Method | Path | 说明 |
|---|---|---|
| POST | `/api/agents/:agentId/memory/_dream` | body严格为`{requestId}`，requestId为客户端每次点击生成的opaque幂等键；立即返回202`{job,coalesced}`。同一`(agentId,requestId)`重试返回同一job；该Agent已有active Dream时返回当前job且`coalesced:true`，不并发创建第二个 |
| GET | `/api/agents/:agentId/memory/_dream/jobs?limit=` | 返回安全job摘要列表，默认20、最大100 |
| GET | `/api/agents/:agentId/memory/_dream/jobs/:jobId` | 返回`{job}`；不存在404 |
| POST | `/api/agents/:agentId/memory/_dream/jobs/:jobId/cancel` | 仅queued/running可取消；applying或终态返回409 |
| POST | `/api/agents/:agentId/memory/_dream/jobs/:jobId/retry` | 仅failed/cancelled可重试并复用原冻结快照；其他状态409 |

daily/weekly/custom调度到点后用`sha256(agentId|schedule-slot|configVersion|providerBindingVersion)`生成幂等键；gateway重启只补最近一个错过的slot，不追跑全部历史。聊天Run与页面请求不等待Dream。job更新发布`memory.dream-job.updated {agentId,job:<safe summary>}`；Data页按该事件刷新`.../memory/_status`。Dream内部proposal/schema与merge事务必须在M4实现前另按现有Memory版本/来源/单写者规则冻结，但不得改变上述HTTP、幂等、快照和无fallback语义。

M3的`memory_search`返回项统一叫**召回节点**：它是某一条Memory的可独立理解语义投影，必须足以让Agent判断直接使用或调用`memory_fetch_detail`展开同一条Memory的权威正文；不得只返回无语义slug/分数。沿正文中的`SourceRef`读取Message才是溯源到**来源原文**。派生检索结构统一叫**索引**，不作为纵向内容层名称。写入`type`只是结构化分层：召回仍跨type开放扩散，type不成为默认filter或图边界。

M3物理顺序固定为：

1. 以当前Agent scope、`active`状态和当前`agentSessionId + generation`已注入集合做资格过滤；提取query，以关键词、向量及其他冻结渠道产生出发节点。
2. 从出发节点沿Memory图做有界多hop开放扩散，逐命中记录一级方向、路径和hop距离；不得先按type切池或截断。最大hop、逐跳衰减和候选上限必须可复现并在M3契约冻结；内部扩散只遍历索引，不递归注入正文，`memory_fetch_detail`显式关联仍只返回一跳。
3. 按稳定slug做**命中归并**：同一节点只保留一份候选，但合并全部独立方向与路径。该步骤为后续计分汇总证据，不是结果名额去重；同一方向内重复路径不增加置信。
4. 对归并候选计算五项归一化后的加权和：`baseScore = wq·queryRelevance + wg·graphProximity + wl·derivedWeight + wc·intersectionConfidence + wt·typeFit`。`queryRelevance`来自query关键词/向量等直接语义匹配；`graphProximity`由候选相对出发节点的hop距离与冻结边强度经单调衰减得到，同节点多路径采用最有利的有效距离，独立方向并集另进入`intersectionConfidence`。无图路径的直接语义命中其`graphProximity`取中性值，不得被排除；本轮图接近度不得与长期权重中的图中心性混为一项。`typeFit`只表示当前query和所需抽象粒度对候选type的适配，不是硬过滤。
5. 按确定性事实身份和语义簇做**结果去重**，合并近重复候选的独立方向置信，选择最符合当前query粒度的代表节点；`type`只辅助判断语义簇是否兼容，置信只来自独立一级方向并集，不得把只是同type但事实不同的节点当重复项。
6. 在去重结果上按`marginalScore = baseScore - redundancyPenalty - boundedSoftQuotaPenalty`逐项重排；type软目标必须随本轮query需求调整，并只影响有界的`boundedSoftQuotaPenalty`。先在召回节点契约允许范围内选择更短但仍可独立理解的投影，再按总token预算确定性截断，未装入项进入稳定cursor。软配额是可借用的目标token占比/边际惩罚，不是每类数量上限，也不保留不可借用槽位；超过目标时惩罚随超额单调增加但必须封顶，使该类后续边际收益递减。当其他类型没有更高边际收益、query对该类需求强或该类候选基础分明显更高时，允许继续选取该类。

单轮交汇的原始方向数对任何已命中候选至少为1，再由冻结函数转换为归一化的`intersectionConfidence`贡献；该贡献随独立一级方向数单调增加、边际递减且封顶，不能把原始值1当作归一化满分。语义簇合并取方向并集，不得由重复副本或type本身刷分。它只进入本轮ranking，不进入Memory frontmatter、长期派生权重或使用统计；正文展开和SourceRef溯源不计为横向方向。type软配额不得单独淘汰候选：例如当前query需要5条彼此独立的规则类Memory时，即使该类软目标为3，只要它们的重排边际收益仍领先且总token预算容纳，就必须允许返回5条。只有语义重复、综合边际收益不足、session去重或总token预算可令结果少于5条。未知扩展type进入默认软配额组，不得丢弃。

目标retrieval pipeline固定为`m4-r2`，取代当前已实现的`m4-r1`字符trigram查询召回；所有分数先clamp到`[0,1]`再四舍五入保留6位小数。直接召回两个等宽渠道各取前24个大于0的seed：关键词渠道继续使用NFKC、Unicode case-fold与空白折叠后的BM25（`k1=1.2,b=0.75`），本轮以最大raw BM25归一；vector渠道改为真实embedding cosine，`queryRelevance=max(keywordNorm,clamp(embeddingCosine,0,1))`。char-trigram不再产生query seed，但继续作为独立的确定性duplicate vector服务下文去重和冗余惩罚。

首版embedder由gateway直接管理，不经过Agent、Account、MCP unit或provider registry：只调用loopback Ollama`http://127.0.0.1:11434/api/embed`，模型精确为`qwen3-embedding:0.6b`、`dimensions:1024`、`truncate:false`。索引身份必须同时记录`modelName + Ollama完整modelDigest + dimensions + documentProjectionVersion`，不得使用`latest`、自动pull、自动换模型、远程fallback或聊天Agent。query文本固定为版本化英文instruction加当前`memory_search.query`或自动Recall的trigger Message；document固定为`Type: {type}\nDescription: {description}\nContent:\n{content}`，不含scope、sources、stains、时间戳、Agent id、frontmatter或路径。每条Memory一个向量，不切chunk；单条超限只缺该条vector并继续keyword/graph。

对`vera.markdown`，sidecar为`<vaultPath>/.vera-index/<agentId>.embedding.json`，索引头至少含`schemaVersion,agentId,memoryGeneration,embeddingGeneration,modelName,modelDigest,dimensions,documentProjectionVersion`，entry只含`slug,memoryVersion,vector`。不得保存正文、query、stain、sources、Account、AgentSession、provider connection或secret。`.vera-index/`必须被vault Git忽略；vault迁移不把它当用户数据复制，而是在新位置从权威Markdown重建。新建或`type/description/content`版本变化仅重建该条，archive/delete移除；model digest、维度或投影版本变化全量重建。搜索只使用`memoryVersion`仍匹配权威Memory且维度/数值合法的向量；发布使用临时文件、flush和原子rename。不引入SQLite、向量数据库或ANN，首版线性cosine扫描。

图扩散最大hop为2，slug归并前候选上限128。正向`[[slug]]`边强度1.0，反向边0.85，`pathStrength=product(edgeStrength) * 0.70^(hop-1)`，`graphProximity`取最强有效路径；无图路径的直接语义命中取0.5。一级方向身份由seed slug派生，同seed被两个直接渠道命中仍只计一个方向；BFS顺序固定为seed `queryRelevance desc, slug asc`，邻接slug升序。`intersectionConfidence = log2(1 + min(directionCount,4)) / log2(5)`，单方向不是满分，4方向封顶。

五项权重冻结为`0.45 queryRelevance + 0.20 graphProximity + 0.15 derivedWeight + 0.15 intersectionConfidence + 0.05 typeFit`；M3的`derivedWeight=0`，不得用`updatedAt`或其他临时信号冒充。type token经`_/-`拆分和英文单数化后，若其中任一token在query中出现则`typeFit=1`并使用该exact type软配额组，否则`typeFit=0.5`并进入`other`组；未知扩展type因此始终可进入且取中性值。

第二阶段去重的贪心leader顺序为`baseScore desc, slug asc`，不做连锁传递闭包。同一M2 `factId`、归一化projection完全相同，或独立duplicate char-trigram vector cosine>=0.92且token Jaccard>=0.75并且type相同/一方为中性未知时聚为同簇；不得使用query embedding相似度判定同一事实。代表节点按`typeFit desc, baseScore desc, standardTokenCost asc, slug asc`选择，方向取并集后重算交汇和base score。一次页面成功交付代表节点时，代表slug及其全部`mergedSlugs`必须共同写入当前`agentSessionId + generation`的delivered集合，防止重复副本在后续请求重新出现。投影两级和预算降级规则保持不变。

语义冗余惩罚使用候选与已选节点的最大duplicate char-trigram cosine `s`，不使用query embedding：`s<=0.75`为0，否则`min(0.20, 0.20 * ((s-0.75)/(0.92-0.75))^2)`。匹配type组的demand为1，`other`为0；`rawTarget=1+2*demand`并在本轮存在的组内归一为`targetShare`。候选加入后该组token占比超出目标的部分为`quotaExcess`，`boundedSoftQuotaPenalty=min(0.12,0.25*quotaExcess)`。边际分为`baseScore-redundancyPenalty-boundedSoftQuotaPenalty`；tie-break固定为`marginalScore desc, baseScore desc, queryRelevance desc, graphProximity desc, compactTokenCost asc, slug asc`。

token估算器固定为`vera-utf8-v1(text)=max(1,ceil(byteLength(NFKC(text),utf8)/3))`，按最终序列化块的header、节点包装与cursor提示一并计费。自动注入使用`memory.injectionBudgetRetrievalTokens`默认384；MCP page默认1200、最小64、最大1200。自动块格式固定为`=== Vera 相关记忆 ===\n- [[slug]] [type] projection\n…\n仅在相关时使用；需要正文调用 memory_fetch_detail。`；存在未装入项时再追加`更多：memory_fetch_more(cursor="<opaque>", direction="all")`。返回节点形状固定为`{rank,slug,version,type,projection,projectionLevel,reasons,directionIds,primaryDirectionId}`，reasons只公开`keyword/vector/graph`类型、有限hop与opaque directionId，不公开具体分数、惩罚或信心解释。响应是`{retrievalId,nodes,cursor,directions,budget:{estimator,limitTokens,usedTokens,omittedCount,minimumNextNodeTokens},degradedChannels}`。

cursor是server侧持久snapshot的随机opaque id，绑定`agentId + agentSessionId + generation + retrievalId + pipelineVersion + memoryIndexGeneration + embeddingGeneration`，保存冻结排序的无stain投影、offset、分支和已缓存page，24小时TTL，AgentSession generation换代立即失效。普通Memory或embedding索引换代不重排已有snapshot；其余分支、幂等与删除authority规则保持不变。cursor不保存query明文、正文、stain、Account连接、provider信息、AgentSession checkpoint或CLI binding。

持久化安全usage事件`{agentId,agentSessionId,generation,runId?,retrievalId?,slug,kind,createdAt}`，kind只允许`auto_injected/search_returned/fetch_more_returned/detail_opened`；不保存query/projection/正文/stain/Account/provider/AgentSession history或provider binding。页面成功返回后才记，同一页面重试不重记，`detail_opened`同generation+slug只记一次。

`memory_fetch_detail`读当前权威Memory，Agent-safe返回`{memory:{slug,version,type,description,status,content,sources,links,linksCursor},usageRecorded}`，不含stains。links只返回一跳、最多32条，每条为`{slug,state,type,description}`，按边强度降序、slug升序；剩余链接进入links cursor并仍通过`memory_fetch_more`继续。archived的已知slug可展开但必须明示状态；SourceRef与正文展开都不增加横向交汇。

自动检索失败时聊天继续；显式MCP错误继续使用稳定安全code。模型缺失/Ollama离线、query embed超时、model digest变化待重建、维度或数值错误、sidecar损坏及重建中都只令vector渠道不可用，继续返回keyword+graph并公开`degradedChannels:["vector"]`；不自动换模型或调用Agent。只有整个retrieval facade不可用才返回`memory_retrieval_unavailable`。retrieval不新增SSE事件，不把query/slug/usage注入Activity。

owner HTTP管理API继续承担人工创建、编辑、删除与前端错误展示；它不是Agent runtime的第二套Memory能力。MCP dispatcher、owner HTTP routes、write hook和dream必须复用同一Memory facade/queue。

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/agents/:agentId/memory` | 先重扫该 Agent，返回 `{ memories:[{ slug,type,description,status,stains,pinned,sourceCount,createdAt,updatedAt,version }], errors:MemoryFileError[], index:{ generation,builtAt,status } }`，memories 按 updatedAt 降序。agent 不存在 → 404 |
| POST | `/api/agents/:agentId/memory` | 手动保存。body 严格为 `{ slug,type,description,content,stains? }`；gateway 补 scope/manual source 后进入队列。成功 201 `{ memory }`；slug 已存在 → 409 `conflict`，`error.details={ reason:"slug_exists", current:{ memory:<summary> } }`；非法/未知字段 → 400 |
| GET | `/api/agents/:agentId/memory/:slug` | 取完整 `{ memory:{ slug,type,description,scope,status,stains,sources,createdAt,updatedAt,version,content } }`；不存在 → 404；文件存在但非法 → 422 |
| PATCH | `/api/agents/:agentId/memory/:slug` | body 严格为 `{ type?,description?,status?,content?,stains?,ifMatch }`，`ifMatch` 必填；slug/newSlug/sources/未知字段均 400。成功 200 `{ memory }`；版本不符 → 409，`error.details={ reason:"version_mismatch", current:{ memory:<完整权威版本> } }` |
| PUT | `/api/agents/:agentId/memory/:slug/pin` | owner signal；body严格为`{pinned:boolean}`，返回`{pin:{slug,pinned,pinnedAt?}}`。不改markdown或Memory version，不对Agent MCP开放 |
| DELETE | `/api/agents/:agentId/memory/:slug?ifMatch=<version>` | 不可逆，前端二次确认；`ifMatch` 必填并走同一版本冲突形状。成功 204；不存在 404。删除后的历史 prompt 快照不追溯修改 |

## 四、SSE 事件流

### 通道

```
GET /api/events            # 全局唯一流，Accept: text/event-stream
GET /api/events?since=<seq>  # 断线重连，从 seq 之后重放
```

单一全局流、事件自带 `spaceId` 路由信息——手机端经 Tailscale 私网 HTTPS 只维护一条长连接。

### 帧格式

每个事件一帧：

```
id: 1042
data: { "seq": 1042, "type": "message.delta", "ts": "…", "data": { … } }

```

- `seq` 单调递增，gateway 维护环形缓冲（默认最近 2000 条）。
- `seq` **跨重启单调**：gateway 持久化 seq 水位，重启后从"水位 + 缓冲长度"跳跃续增。因此客户端带重启前的 `since` 重连必然落入缺口 → 收到 `stream.reset` → 重新 bootstrap，不会静默漏掉重启前后的事件。
- 重连时带 `?since=<最后收到的 seq>`（或标准 `Last-Event-ID` 头，两者等价）；缓冲已滚过 → gateway 发 `stream.reset`，客户端丢弃本地状态、重走 `/api/bootstrap`。

### 事件类型

| type | data | 说明 |
|---|---|---|
| `message.created` | `{ message }` | 新消息记录。用户消息即时；agent 回复**每个气泡各发一次**（run 内多次） |
| `message.delta` | `{ messageId, spaceId, spaceSessionId, delta }` | 当前气泡的流式增量，客户端只追加到匹配的窗口 |
| `message.completed` | `{ message }` | 当前气泡定稿，content 为该气泡权威全文（客户端以此覆盖累积值） |
| `run.started` | `{ run }` | |
| `run.ended` | `{ run }` | status 为 completed/failed/cancelled；failed 时带 `error.code/message` |
| `activity.created` | `{ activity }` | 新时间线过程条目（思考链、工具执行开始…） |
| `activity.updated` | `{ activity }` | 同一条目状态/内容更新（工具 pending→completed 等） |
| `approval.requested` | `{ approval }` | 提权申请卡片入时间线，等待用户答复 |
| `approval.answered` | `{ approval }` | 已答复或过期（多端同步：手机答了，电脑上的卡片也变灰） |
| `agent.state.updated` | `{ agentState }` | per-Space AgentState 现 `agentId/spaceId/status/detail/lastActiveAt` 五字段（联邦形态精化） |
| `account.presence.updated` | `{ accountId, presence, lastSeenAt }` | Account 所绑定 Workspace 宿主 daemon 的可执行性广播；不表示 Account 已被某 Agent 登录或独占。活跃控制权以 Execution 租约为准 |
| `space.updated` / `agent.updated` / `account.upserted` | `{ space }` / `{ agent }` / `{ account }` | 配置变更广播；`account.upserted` 覆盖 account 创建与修改，前端按 `id` 合并联系人 |
| `space.deleted` | `{ spaceId }` | 已归档Space永久删除且Memory与store清理全部提交后发布；客户端移除活跃与归档投影 |
| `space-session.archived` / `space-session.created` `[P5-C1]` | `{spaceId,spaceSession}` | `/new`的存储事务完整提交后才依次广播旧窗口归档与新active窗口；事件之间不存在可写的中间状态，归档窗口不会再产生写事件 |
| `agent-session.compaction.updated` `[P5-C1]` | `{spaceId,spaceSessionId,jobId,agentSession:{id,agentId,generation,context,status}}` | 自动或手动compact进度/结果；不含checkpoint、history或provider binding |
| `agent-session.compact.requested` `[P5-C1/Phase 5.5 daemon-only]` | `{jobId,target:{agentId,agentSessionId,fromGeneration,mode},account,input}` | 只发给目标daemon。`mode`为`native/checkpoint_new_binding/gateway_history`；native input只含当前安全CLI binding，后两者只含gateway裁剪的compaction source与checkpoint schema。daemon以专用result端点回报，不生成聊天delta/Message |
| `agent.heartbeat` `[Phase 5.5]` | `{ ts }` | gateway 每 15s（`agentDaemon.heartbeatIntervalMs`）在 daemon SSE 通道发的存活信号；daemon 连续 3 次未收到即 `exit(0)` 防止反复撞网关烧 token |
| `run.requested` `[Phase 5.5]` | 公共外壳`{run,triggerMessage,agent,account,workspace,input}`；CLI `input={kind:"cli",sessionMode:"main"|"isolated",promptText,providerBinding?}`，API `input={kind:"api",sessionMode:"main"|"isolated",messages,historyVersion?}` | main Run冻结`spaceSessionId/agentSessionId/contextGeneration`；isolated subagent的session字段为null且不带持久binding/historyVersion。CLI只续当前generation绑定；API messages由gateway按容量裁好，daemon不得另存canonical history或回头读store。两种input互斥 |
| `stream.reset` | `{}` | 客户端必须重新 bootstrap |

**一次 agent 回复的完整事件序列示例**（思考链、工具执行与气泡按实际发生时间穿插，前端照事件顺序排时间线即可）：

```
run.started
activity.created   (thinking：开始想)
message.created    (气泡1, streaming)
message.delta ×N   (气泡1)
message.completed  (气泡1)
activity.created   (tool: bash npm test, pending)
activity.updated   (tool: completed，带输出摘要)
approval.requested (要 rm -rf ./dist，等用户点按钮)
approval.answered  (allow)
message.created    (气泡2, streaming)
message.delta ×N   (气泡2)
message.completed  (气泡2)
run.ended          (completed)
```

### 客户端义务

- 以 `message.completed` 的全文为准，delta 累积仅用于渲染中间态。
- 收到未知 `type` 必须静默忽略（向前兼容）。
- 断连后指数退避重连，携带 `since`。

## 五、与 Tailscale Serve 私网入口的兼容性约束

- SSE 响应必须逐帧 flush，不得依赖缓冲；Tailscale Serve 到回环 gateway 的转发必须实测逐帧到达，见 `reference/vps-tunnel-deploy.md`。
- gateway 每 25s 发 SSE 注释帧 `: ping` 保活，防止中间层超时断连。
- gateway 只监听 `127.0.0.1:3210`，唯一生产入口是 Tailscale Serve；不得同时启用 Funnel、公网反向代理或公网端口映射。
- gateway 只信任来自本机 Serve 代理的 Tailscale identity headers；直接从客户端收到的同名头不得作为身份。普通 API 校验 owner login，agent API 校验 agent token。

## 六、页面接口矩阵 `[F1]`

> ground truth 5.1 页面清单逐页落地：每页声明「SSE 事件输入 / API 读取 / API 写入 / 空错态」。
> 此矩阵是 F2+ 前端实现的唯一接口闸门——任何 view 不得调用未在此列出的 endpoint，也不得在此列出但后端未实现的 endpoint 上构建可交互控件（不得做假控件）。
> 标 `[P5]` / `[P5.5]` / `[Phase 6]` 的项当前阶段不实现，但形状在此钉死。

### App Shell（全局，无路由）

- **SSE 事件输入**：`stream.reset`（重连后丢弃本地状态、重走 `/api/bootstrap`）；`account.presence.updated`（顶栏在线指示）；`agent.state.updated`（顶栏省略，仅在当前 Space 内消费）。
- **API 读取**：`GET /api/bootstrap`（启动 / `stream.reset` 后）；`GET /api/settings`（顶栏主题色 / Appearance token loader 初始化；F2 起前置）。
- **API 写入**：无（Shell 不持有写流程；用户写操作都进具体 view）。
- **空错态**：bootstrap 失败 → 顶栏显示「断开」+ 重试按钮；SSE 长断连 → 同上；`/api/settings` 失败 → token loader 回落 config 默认（不阻塞 Shell 渲染）；离线（navigator.offline）→ 顶栏「离线」标记。

### 全屏聊天主页 `#/spaces/:spaceId`

- **SSE 事件输入**：既有Message/Activity/Approval/Run事件必须同时匹配当前`spaceSessionId`；新增`space-session.archived`、`space-session.created`切换active窗口，`agent-session.compaction.updated`刷新per-Agent generation/压力与手动job结果。归档历史页不消费写事件。
- **API 读取**：`GET /api/bootstrap`（首屏）；`GET /api/spaces/:id/timeline?before=&limit=50`（向上翻页加载更早历史）。
- **API 写入**：普通正文走`POST /api/spaces/:id/messages`；精确`/compact`与`/new`分别走`POST .../session/_compact`与`POST .../session/_new`，不落Message；取消Run和Approval回答沿用既有端点。
- **空错态**：Space 不存在（404）→ 主区显示「Space 不存在或已归档」+ 返回导航入口；时间线空 → 「还没有消息，发一条开始」；时间线长 → DOM 上限 200 items，更早走 `?before=` 分页；approval 失效（409）→ 卡片灰化；发送失败（4xx/5xx）→ composer 内联错误 + 保留草稿；SSE 断连 → 时间线冻结 + 顶部「重连中」；已归档 Space 通过此路由进入 → 消息发送返回 409，主区显示「已归档，去设置恢复」入口。

### SpaceSession历史 `#/spaces/:spaceId/history`、`#/spaces/:spaceId/history/:spaceSessionId` `[P5-C1]`

- **API读取**：`GET /api/spaces/:id/sessions?status=archived`与指定Session timeline；只读分页。
- **API写入**：无。归档SpaceSession不提供restore、composer、Run、compact或编辑。
- **空错态**：无归档窗口显示“还没有历史对话”；当前SpaceSession不得混入归档列表。

### Space导航 `#/spaces`（右滑 / 顶栏开关 / 打开期间常驻）

- **SSE 事件输入**：`space.updated`（重命名 / Seat / notifications 变更回显）；`agent.updated` / `account.upserted`（左栏联系人投影）；`account.presence.updated`（在线指示）。
- **API 读取**：`GET /api/bootstrap`（复用 Shell 拉取的 agents/accounts/spaces；进导航页不再发额外请求，纯客户端派生左栏联系人 / 右栏 Space 列表）；`GET /api/spaces?archived=true`（展开「已归档 Spaces」分段时按需拉取已归档列表）。
- **API 写入**：`POST /api/spaces`（新增；body 继承当前左栏选中成员集合作为 seats）；`PATCH /api/spaces/:id`（重命名 / topic / seats / notifications）；`POST /api/spaces/:id/archive`（二次确认后归档，归档成功后切换到另一活跃 Space）；`POST /api/spaces/:id/restore`（从「已归档」分段恢复）；`GET /api/spaces/:id/deletion-preview`后`DELETE /api/spaces/:id`永久删除。
- **空错态**：无 Space → 左栏联系人可点但右栏空 + 「新建 Space」CTA；左栏无选中 → 右栏显示「选一个联系人或群组」，同时禁用新建入口；归档失败（409 有未结束 Run）→ toast「有进行中的对话，等结束或取消后再归档」；新增失败 → 内联错误；归档二次确认 → 弹层 only（不替换主区）。已归档Space显示恢复与删除；删除弹层必须显示Message与Memory影响计数，并提供默认不勾选的“同时删除全部来源均属于该Space的Memory”，确认按钮明确写“永久删除”；删除失败保留归档记录并内联报错。

### 当前Space设置 `#/spaces/:spaceId/settings`

- **SSE 事件输入**：`space.updated`（外部改动回显，多端同步）；`agent.updated` / `account.upserted` / `account.presence.updated`（参与 Agent 列表状态）。
- **API 读取**：`GET /api/bootstrap`（参与 Agent + seats 组合）；Phase 6 前不读取或显示 Space Module，契约落地后再读取独立 binding API。
- **API 写入**：`PATCH /api/spaces/:id`（一次提交 seats / notifications / name / topic；Seat 字段 `agentId` / `responseMode` / `respondTo` / `blockAgentIds` 全在此）。
- **空错态**：Space 不存在 → 整页「Space 不存在」+ 返回；历史/异常记录无 seats → 「还没有 Agent 参与」并允许选择至少一个Agent修复，保存时不得仍为空；保存失败 → 字段级错误回显，不整页崩溃；Phase 6 契约落地前不显示 Space Module 区；离开未保存改动 → 浏览器原生 confirm。

### Setting目录 `#/settings`

- **SSE 事件输入**：无（不订阅；进页拉一次即可）。
- **API 读取**：无（不预取子页数据；只渲染当前已有的静态平铺入口）。
- **API 写入**：无。
- **空错态**：纯静态页；未到阶段或没有真实契约的入口不显示。Phase 6 契约与页面落地后，再加入真实的 Extension Packages 入口。

### Appearance `#/settings/appearance`

- **SSE 事件输入**：无（外观是本地预览 + 保存，不订阅事件）。
- **API 读取**：`GET /api/settings`（初始外观字段）；`GET /api/themes`（Theme 列表摘要，进页时拉一次）；`GET /api/themes/:id`（选中某 Theme 预览时按需拉取完整对象）。
- **API 写入**：`PATCH /api/settings`（保存外观字段；按组恢复默认对该组已知 key 一次 PATCH `null`）；`POST /api/themes/import`（导入预览，不持久化）；`POST /api/themes`（确认保存归一化 Theme）；`PATCH /api/themes/:id`（重命名 / 编辑 colors/terminal）；`DELETE /api/themes/:id`（被 `appearance.themeId` 引用时 409）；`GET /api/themes/:id/export?format=vera-json|vera-css`（导出 Theme Palette）；`GET /api/settings/appearance-profile/export`（导出非 Theme 的 Appearance Profile）；`POST /api/settings/appearance-profile/import`（预览 Appearance Profile，不保存，确认后仍 PATCH `/api/settings`）。
- **空错态**：settings 加载失败 → 回落 config 默认 + 顶部「无法读取已保存配置，展示默认值」；Theme 列表空 → 「还没有保存的 Theme，导入一份试试」；导入失败 → 预览区显示 `warnings` + 不写入；导出失败 → toast；预览只改内存 CSS 变量，刷新或离页未保存 → 丢弃；实时预览与「已保存」之间须有明确视觉区分（按钮态 / 标记）。

### Account系统管理 `#/settings/accounts`、`#/settings/accounts/:agentId`

- **SSE 事件输入**：`agent.updated`（Agent名称回显）；`account.upserted`（Account创建/修改回显）；`account.presence.updated`（系统连接状态与`runtimeCapabilities`快照可用性）。
- **API 读取**：`GET /api/bootstrap`（列表页用agents + accounts组合）；`GET /api/accounts?agentId=…`（详情页按需刷新该Agent的唯一Home Account）。可供subagent使用的其他Account从`authorizedAgentIds`显式派生并标成“已授权”，不得显示成该Agent名下Account。页面不读取AgentState、当前所在Space、unit binding或Memory配置/正文。
- **API 写入**：`POST /api/agents`（新建 Agent；响应含自动派生的 Home Account）；`PATCH /api/agents/:id`（只改`name`）；`DELETE /api/agents/:id`（删除身份 + Home Account；有历史、活跃 Execution、其他Agent unit binding、其他Agent的Digest/Dream executor配置或未完成Memory job引用时返回409）；`PATCH /api/accounts/:id`（改连接字段或 `authorizedAgentIds`）。不提供“为同一 Agent 新增 Account”或单独删除 Home Account 的 UI 动作。
- **空错态**：无 Agent → 「还没有 Agent，新建一个」CTA；Agent 缺 Home Account → 视为数据完整性错误，提示修复/迁移，不提供“再添加 Account”；删除二次确认只针对 Agent + Home Account 整体；删除失败（409）→ toast 显示历史/活跃 Execution 原因；Account 被其他 Execution 占用（409 `account_busy`）→ 明示当前不可派发 subagent；`runtimeCapabilities` 为 `null`（宿主离线）→ 详情页「未连接，能力未知」而非虚构数据。

### Agent使用管理 `#/agents`、`#/agents/:agentId`

- **入口与顺序**：聊天时间线中点击发言Agent头像进入`#/agents/:agentId`，以该Agent为当前页；Space导航左下角联系人图标进入`#/agents`，从`GET /api/bootstrap`的`agents`现有默认顺序首位开始。页面不得自行重排该数组；两个入口使用同一页面和同一顺序，前后翻页只改变当前`agentId`，不得维护两份列表状态。
- **页面结构**：上半部分展示当前Agent像素形象，左右两侧提供上一位/下一位箭头；下半部分展示Agent当前状态、当前所在Space及Skills / Hooks / MCP / Data四个平级入口。现阶段像素形象复用现有Agent视觉投影，不新增Avatar或Contact持久字段；未来若允许编辑必须先扩展Agent契约。
- **SSE事件输入**：`agent.updated`（名称与视觉投影刷新）；`agent.state.updated`（当前工作相与所在Space，按当前`agentId`过滤）；`account.presence.updated`只用于说明当前Agent的Home Account连接可用性，不把连接表单带入本页。
- **API读取**：`GET /api/bootstrap`取得Agent默认顺序，并只用accounts摘要解析当前Agent的Home Account presence/runtime可用性；`GET /api/agent-states?agentId=…`按当前页读取AgentState。主页面不读取Account secret/连接表单，不预取unit列表、Memory配置或正文。
- **能力与Data目录 `[P5前端与内置binding；Phase 5.5/6通用runtime]`**：四入口分别进入`#/agents/:agentId/skills|hooks|mcp|data`。Hooks默认内置无执行Agent/模型的Recall/Write；MCP默认内置`vera.memory`，只显示启用状态、可用性与工具清单，不出现semantic Agent或模型。Agent Plugin不作为第五入口且不混入四目录。Digest/Dream配置只在Data → Memory。
- **首轮前端接口**：Skills / Hooks / MCP复用上文标准化目录投影和同一个无HTTP view；顶栏右侧固定“添加”“管理”。首轮纯前端交付验收两个入口、分页、路由、Shell动作槽、空态、loading/error和夹具列表行，生产Skills为空且所有未接通动作disabled。该交付通过后，Hooks/MCP controller才读取/修改`unit-bindings`；Skills继续为空，直到真实Skill接口完成。Data目录当前只列Memory并按需进入子路由，不使用unit binding。
- **空错态**：无Agent → 整页提示「还没有Agent，去Vera Settings的Account管理创建」并跳转`#/settings/accounts`；指定Agent不存在 → 整页「Agent不存在」并提供返回`#/agents`；只有一个Agent时隐藏或禁用左右箭头，不制造循环翻页假象；AgentState暂不可用时保留Agent页面并显示状态未知。

### Agent Data → Memory `#/agents/:agentId/data/memory` `[P5-M4]`

- **SSE事件输入**：`memory.digest-job.updated`与`memory.dream-job.updated`；只按当前`agentId`刷新安全job摘要和`GET .../memory/_status`，不通过SSE传正文、proposal或配置。
- **API读取**：`GET /api/agents/:agentId/memory/_config`、`GET .../_options`、`GET .../_status`；长期Memory摘要只在用户进入管理页时另取，不随本页首屏预取正文。
- **API写入**：`PATCH .../memory/_config`保存Memory结构及Digest/Dream各自的executor/model/trigger|schedule；手动Digest走`POST .../_digest`，立即Dream走`POST .../_dream`。本页不读取、不显示、不修改Recall/Write binding。
- **空错态**：只有内置Provider时显示`Vera（兼容 Obsidian）`，不渲染“自定义”假选项；位置只读并跳受控路径页；长期Memory显示条数/逻辑大小/token估算，待整理内容显示Message/字符/token与per-SpaceSession当前上下文压力，明确标注估算质量。Provider/executor/model不可用时保留选择并禁止新job，不fallback；在途Dream合并重复点击。

### Agent Memory管理 `#/agents/:agentId/data/memory/library`

- **SSE 事件输入**：无（Memory 编辑是请求-响应，不订阅实时事件）。
- **API 读取**：若active Provider支持`list/fetch`，使用`GET /api/agents/:agentId/memory`与`GET .../:slug`按需读取；默认`vera.markdown`返回索引、坏文件errors与权威正文。
- **API 写入**：按active Provider的`create/update/delete` capabilities启用对应`POST/PATCH/DELETE`；默认`vera.markdown`沿用slug、ifMatch与per-Agent单写队列。Provider不支持的动作禁用并返回`memory_provider_unsupported`，不得伪造成功。
- **空错态**：agent 不存在（404）→ 返回Agent使用管理默认入口`#/agents` + toast；vault 子目录不存在 / 空 → 「这个 Agent 还没有记忆，用一次就慢慢攒起来了」+ 「手动保存一条」CTA；slug 不存在（404）→ 返回列表 + toast；列表含坏文件 → 正常展示其余 Memory 并提示 errors；编辑/删除冲突 → 使用加载时的 `version` 做 `ifMatch`，409 的 `details.current.memory` 用于重载，前端提示「这条刚被 agent 改过，请重新加载」；删除二次确认 → 弹层。

### Extension管理 `#/settings/extensions` `[Phase 6]`

- **SSE 事件输入**：`[Phase 6]` 待定（extension.install / uninstall / permission.request 等事件）。
- **API 读取**：`[Phase 6]` `GET /api/extensions`（已安装 Extension Package 摘要列表）。
- **API 写入**：`[Phase 6]` `POST /api/extensions/install` / `DELETE /api/extensions/:id` / `PATCH /api/extensions/:id/permissions` 等。
- **空错态**：当前阶段（F1–F5）整页显示「`[Phase 6]` Extension 体系尚未开放」，不渲染任何假按钮或假列表。

### 路径管理 `#/settings/paths`

- **SSE 事件输入**：无。
- **API 读取**：`GET /api/paths`（返回 memory.vaultPath 当前值 + 是否存在 + 记忆条数；`gateway.dataPath` 当前值只读展示 + 大小估算；env-only 参数如 port/SSE 心跳不在本接口，去 `/api/status`）。
- **API 写入**：`POST /api/paths/validate`（body `{ key, value }`，预检目标路径：绝对路径 / 可写或可创建 / 不在仓库内 / 磁盘空间足够；返回 `{ ok, errors[], warnings[], normalized }`，不写盘）；`POST /api/paths/migrate`（body `{ key, target }`：对 `memory.vaultPath` 走「校验 → mv → 改 config → 返回新值」；对 `gateway.dataPath` 走「校验 → 备份 → 复制 → 验证 → 改 config override → 返回 `{ restartRequired: true }`」，实际切换需 gateway 重启；旧路径留 `.legacy` 备份不自动删）。
- **空错态**：路径校验失败 → 字段下方红字 + 不允许进入 migrate；migrate 失败 → toast 显示错误 + 路径不动（回滚已内置）；gateway.dataPath migrate 成功 → 「重启 gateway 后生效」+ 重启按钮（仅本地开发 / systemd manage 场景可用；VPS 部署后由 systemd 自重启）；memory.vaultPath 改完 → 直接生效（memory 模块重开）+ 不需要重启。

### 中控台 `#/settings/control-center`

- **SSE 事件输入**：无（中控台是轮询，不订阅；离开页面立即停止 poller）。
- **API 读取**：`GET /api/status`（gateway/SSE/store/vault/daemon 状态摘要 + 最近错误；字段清单见章节八；进页时取一次，之后 5s 轮询，离页清理）。
- **API 写入**：无（中控台只读；任何「重启 / 清理」操作走专门接口或运维，不在本页提供按钮）。
- **空错态**：`/api/status` 失败 → 「gateway 不可达」+ 重试；store 显示当前 file store 状态（文件大小、记录数），不虚构数据库连接；vault 不存在 → 「vault 路径无效」+ 跳 `#/settings/paths`；无 daemon 在线 → 「当前没有 agent daemon 连接」（联邦形态 Phase 5.5 落地后才有 presence 数据；当前阶段显示「联邦形态未启用」而非假数据）。

### 系统设置 `#/settings/system`

- **SSE 事件输入**：无（系统设置是表单 + 保存，不订阅实时事件）。
- **API 读取**：`GET /api/settings`（加载系统字段当前合并视图：`isolation.*` / `memory.*` / `presentation.*`）。
- **API 写入**：`PATCH /api/settings`（部分字段覆盖；按组恢复默认对该组已知 key 一次 PATCH `null`）。
- **空错态**：settings 加载失败 → 表单回落默认值 + 顶部错误条；保存失败（400 invalid_request）→ 字段级错误回显；保存失败（5xx）→ toast + 保留改动；未保存离页 → 浏览器原生 confirm。

## 七、Path 管理与受控迁移 API `[P4.6/F1]`

ground truth 4.1 末段把可配置路径分两类：用户数据位置（Memory vault、Account Workspace 绑定、Files/附件路径）走普通保存；gateway 数据目录等影响事实来源的高风险路径必须走「校验 → 迁移 → 验证 → 回滚」独立流程。端口、SSE 心跳/缓冲、store 落盘节流、daemon 回收、run 看门狗仍走 env，不进本接口。

### 字段清单

| key | 作用 | 当前可编辑 | 风险等级 |
|---|---|---|---|
| `memory.vaultPath` | Obsidian 兼容 vault 根目录 | 是 | 普通（仅 markdown 文件，失败不危及事实来源） |
| `gateway.dataPath` | gateway 持久化数据根目录 | 是（仅 migrate，无直接文本框） | 高（含agents/spaces/SpaceSessions/AgentSessions/messages/runs全部事实来源） |
| `accounts.*.workspace` `[P5.5]` | per-Account Workspace 绑定（`hostId/path/status/policy`）；实际文件在 daemon 宿主 | 否（daemon 报告，gateway 校验并存绑定） | 普通 |
| `files.attachmentsPath` `[P5]` | Space 内附件存储根 | 否 | 普通 |

### 端点

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/paths` | 返回当前路径摘要：`{ paths: { memory: { vaultPath, exists, memoryCount, legacyUnscopedCount }, gateway: { dataPath, sizeBytes, restartRequired: false } } }`。`memoryCount` 统计所有 `<agentId>/` 子目录中的记忆，不包含根目录未归属文件。`gateway.dataPath.sizeBytes` 是目录递归大小估算（du 等价），用于路径管理页展示。**不返回** port / SSE / store 节流等 env 配置（去 `/api/status`）。 |
| POST | `/api/paths/validate` | body `{ key, value }`，`key` ∈ `memory.vaultPath` / `gateway.dataPath`；`value` 为绝对路径字符串（相对路径规范化为相对 cwd 的绝对）。返回 `{ ok: bool, errors: string[], warnings: string[], normalized: string }`，**不写盘**。校验项：绝对路径；路径可写或可创建（父目录存在且可写）；不在仓库工作树内（防止用户把 vault 指到 `~/projects/Vera-0.0.1/`）；对 `gateway.dataPath` 额外校验：目标目录为空或仅含可识别的 Vera store 文件（防覆盖陌生数据）；磁盘剩余空间 ≥ 当前 dataPath 大小（迁移用）。 |
| POST | `/api/paths/migrate` | body `{ key, target }`；migrate 是 validate + 实际搬移 + 改 config override 的合动作。返回 `{ ok, key, from, to, restartRequired }`。失败时路径不动（已搬移的部分回滚），返回 400/409 + `{ errors }`。 |

**migrate 各 key 行为**：

- `memory.vaultPath`：
  1. 检查根目录未归属 `*.md`（存在则 409）→ 2. validate target → 3. `mkdir -p target` → 4. 把当前 vault 下**所有 agent 子目录**整体移到 target（保留 `<agentId>/` 子目录结构）→ 5. 验证 target 内子目录数与文件数一致 → 6. `PATCH /api/settings` 写 `paths.memoryVaultPath = target` override 并等待落盘 → 7. **gateway 热替换 memory 模块的 vaultPath**（memory 模块提供 `reopen({ vaultPath })` 方法，paths-routes 调用后立即生效；后续`listMemories/getMemory`与检索facade的`residentIndex/search/fetch_detail`都经该memory实例读取新路径）→ 8. 返回 `{ restartRequired: false }`。原 vault 目录留空不删（用户自行清理）。失败任一步回滚：恢复 setting override、把已搬到 target 的子目录 mv 回原 vault。
- `.vera-index/`是可重建派生缓存，不属于vault迁移的用户数据；上一步“所有agent子目录”只匹配合法`<agentId>/`，不得复制`.vera-index/`。切换后在新vault从权威Markdown全量重建普通索引和embedding sidecar；旧sidecar不得继续标current。
- `gateway.dataPath`：
  1. validate target → 2. 复制当前 dataPath 全部内容到 target（rsync 等价，保留文件权限）→ 3. 在 target 上启动一个临时 store loader 试加载（只读模式，确认无损坏）→ 4. 通过后，`PATCH /api/settings` 写 `paths.gateway.dataPath = target` override——**注意 override 写入的是当前运行中的 settingsStore（仍在旧 dataPath）**，旧 dataPath 的 `settings.json` 因此获得 `paths.gateway.dataPath = target` override → 5. 旧 dataPath 不动（保留作回滚锚点），返回 `{ restartRequired: true }`。**gateway 实际切换到 target 在下次重启后生效**：server.js 启动时先从 env 默认 dataPath 读 `settings.json`，发现 `paths.gateway.dataPath` override → 用 override 路径建 store（见下「启动顺序」）。
- **回滚**：migrate 失败任一步：已复制到 target 的内容删除；settings.json 不写 override；旧路径不动。重启后若 store 在新 path 加载失败 → gateway 启动报错（不做静默回滚——dataPath 是事实来源，路径错误必须响亮失败让用户介入）。

**gateway.dataPath 启动顺序**（server.js boot，F1 修订）：
1. `loadConfig(env)` → 得到 env 默认 `config.dataPath`（如 `./data` 或 `VERA_DATA_PATH`）
2. **先读 `<config.dataPath>/settings.json`** 中的 `paths.gateway.dataPath` override（一次性轻量读，不走完整 settingsStore 构造）
3. 若 override 存在且指向不同路径 → **将 `config.dataPath` 替换为 override 值**，后续 store / settingsStore / memory 全部用新路径
4. 若 override 不存在或读取失败 → 用 env 默认 `config.dataPath`（当前行为不变）
5. 同理读 `paths.memoryVaultPath` override 替换 `config.memory.vaultPath`

这一步消除「settings 在 dataPath 内」的 chicken-and-egg：启动只做一次轻量 JSON 读（不是完整 settingsStore），拿到 override 后再用真实路径建 store / settingsStore。

**字段新增到 settings 白名单**：`paths.memoryVaultPath`（string）、`paths.gateway.dataPath`（string）。两个 key 都支持 `null` 恢复 config 默认（即 env `VERA_MEMORY_VAULT_PATH` / `VERA_DATA_PATH` 当前值）。**`paths.gateway.dataPath = null` 不会自动回滚已迁移的数据**——只是把 override 清掉，gateway 仍读 env 当前值；已迁移到 target 的数据需要用户手动 rsync 回 env 路径或在 env 改路径后重启。

### 持久化

`paths.*` 与 `appearance.*` / 系统字段一样落 `<dataPath>/settings.json` override；consumer 是 server.js boot 时读 settingsStore override 决定实际 dataPath / vaultPath（**注意**：gateway.dataPath 是 chicken-and-egg——settings 文件本身在 dataPath 内，迁移后 settings.json 也会随 dataPath 一起搬走，不冲突）。

## 八、中控台 Status API `[P4.6/F1]`

中控台只读，字段严格按当前真实可观测的状态，**不虚构未来的数据库连接或联邦 presence 数据**。

### 端点

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/status` | 200 `{ status: {...} }`。无查询参数。 |

### 字段清单

```json
{
  "status": {
    "gateway": {
      "version": "0.0.1",
      "pid": 12345,
      "startedAt": "…",
      "uptimeMs": 123456,
      "dataPath": "/…/data",
      "dataPathRollbackPending": false
    },
    "sse": {
      "currentSeq": 1042,
      "bufferSize": 2000,
      "connectedClients": 1
    },
    "store": {
      "kind": "file",
      "collections": { "agents": 2, "accounts": 2, "spaces": 1, "messages": 47, "activities": 12, "approvals": 3, "runs": 8 },
      "spaceSessions": 4,
      "agentSessions": 6,
      "themesCount": 0,
      "lastFlushAt": "…"
    },
    "memory": {
      "vaultPath": "/…/memory",
      "vaultExists": true,
      "memoryCount": 5,
      "legacyUnscopedCount": 0
    },
    "agents": {
      "federation": "disabled",
      "onlineAccounts": 0,
      "accounts": [{ "accountId": "acc_…", "agentId": "agt_…", "presence": "offline", "lastSeenAt": null }]
    },
    "recentErrors": [
      { "ts": "…", "scope": "adapter", "code": "adapter_unavailable", "message": "…" }
    ]
  }
}
```

- `gateway.version` 来自 package.json；`startedAt` / `uptimeMs` 进程启动时记一次；`dataPath` 同 `/api/paths` 返回值；`dataPathRollbackPending` 见章节七回滚段。
- `sse.connectedClients` 是 hub 当前活跃 SSE 连接数；`currentSeq` 同 `hub.currentSeq()`。
- `store.kind` 永远是 `"file"`（Phase 5 前）；`collections` 是各 JSON 文件 `data[name].length`，无坏文件容错掉的不计；`lastFlushAt` 是最近一次 doFlush 完成 ISO 时间。
- `memory.memoryCount` 是所有 agent 子目录中的可作用域记忆总数；`legacyUnscopedCount` 是 vault 根目录待人工归属的旧 `*.md` 数，不计入 `memoryCount`。
- `memory` 同 `/api/paths` 的 memory 字段。
- `agents.federation` 当前阶段固定 `"disabled"`（联邦 Phase 5.5 落地后改 `"enabled"`）；`onlineAccounts` 当前阶段固定 `0`；`accounts` 列出每条 account 的 presence/lastSeenAt（当前阶段 presence 全 `"offline"`、lastSeenAt 全 `null`）。
- `recentErrors` 是进程内环形缓冲（默认 20 条），收集 `ApiError` 抛出与 adapter / store / memory 模块的告警；超过 N 条滚动覆盖。只读，无写入端点。

## 九、客户端 platform adapter 接口 `[P4.6/F1]`

三端共享同一份 `frontend/src` 业务代码；平台差异只允许通过统一 platform adapter 调用。adapter 必须明确返回 `unsupported` 而非静默失效。Web fallback 在契约中可表达，原生壳在 F2/F3 阶段不实现，但 F1 必须钉接口形状。

### 接口形状（`src/state/platform.js`）

```js
{
  id: "web" | "android" | "ios",
  // gateway URL：Web 由同源伺服（location.origin）；原生壳从 secureStorage 读用户配置
  async getGatewayUrl(): string,
  async setGatewayUrl(url): void | unsupported,
  // fetch 与 SSE：Web 直接用 window.fetch + EventSource；原生壳用原生 http + 长连接
  fetch(url, init): Promise<Response>,
  createEventSource(url, opts): EventSource,
  // 安全存储：Tailscale设备身份由系统Tailscale客户端持有，Vera不复制；本接口只供其他原生secret，localStorage仍只允许未提交预览
  secureStorage: {
    async get(key): string | null,
    async set(key, value): void,
    async remove(key): void,
  },
  // 通知：ground truth 4.2.6 / Space.notifications 消费
  notifications: {
    async requestPermission(): "granted" | "denied" | "unsupported",
    async notify({ title, body, spaceId, messageId }): "shown" | "unsupported",
  },
  // 文件选择：Space Files / 路径校验回执
  async pickFile({ accept? }): { path, name, mime } | unsupported,
  async pickDirectory(): { path } | unsupported,
  // 键盘 / 返回：原生壳决定是否拦截
  keyboard: { insets: { bottom, top }, onInsetChange(cb): unsubscribe },
  backButton: { onBack(cb): unsubscribe, consume(): void },
  haptics: { async tap(mode): void | unsupported, async notify(type): void | unsupported },
  // 外部认证 / 链接：Vera自身依赖系统Tailscale身份；第三方外部认证仍用系统浏览器回跳
  externalAuth: {
    async open(url, opts?): { redirected: url } | unsupported,
    onRedirect(cb): unsubscribe,
  },
  externalLink: { async open(url): "opened" | "unsupported" },
}
```

每个方法在缺失能力时返回 `{ unsupported: true }` 或抛 `UnsupportedError`，业务调用方必须显式检查，不静默 fallback 到 Web 行为——若需 fallback，在调用点显式声明。

### Web fallback 形状

Web 实现位于 `src/platform/web.js`，对原生能力返回 `unsupported`：
- `notifications.notify` → Web Notification API（permission denied 时返 `unsupported`）
- `pickFile` / `pickDirectory` → `<input type="file">` / `showDirectoryPicker()`（不支持时返 `unsupported`）
- `haptics` → 返 `unsupported`
- `keyboard.insets` → 始终 `{ bottom: 0, top: 0 }`（视口尺寸变化由 viewport meta 处理）
- `backButton` → Web 用 `popstate`；`consume()` 调 `history.back()`
- `externalAuth.open` → Web 直接 `window.location` 跳转第三方认证页；`onRedirect` 用 `window` 的 `hashchange` / `popstate`。Vera 自身不走此接口登录
- `secureStorage` → Web 用 `localStorage`，仅限未提交预览（ground truth 4.4），不存已确认配置

### 原生壳认证路径（Tailscale 纯私网 / CORS / SSE）

- **前置条件**：手机先安装/启用 Tailscale 并加入与 VPS 相同的 tailnet；“不走 VPN”只表示不同时运行 v2rayNG 等其他 VPN。Vera 不负责登录 Tailscale，也不内嵌 tailnet auth key。
- **gateway URL**：原生壳不内置固定 URL/IP/tailnet 名；首启弹“配置 gateway URL”视图，用户输入 VPS 的 `https://<machine>.<tailnet>.ts.net`。保存后调用 `/api/health`；不可达时明确提示检查 Tailscale，而不是尝试公网 fallback。Web 由 `location.origin` 派生。
- **Owner 身份**：请求经 Tailscale Serve 后由 gateway校验可信 identity login是否属于 `config.security.ownerTailscaleLogins`；Vera App不保存第二份owner token。设备撤销在tailnet管理台完成。
- **公网分流**：手机不得启用 Vera VPS 作为 Exit Node。只有 tailnet目标走Tailscale，其他App继续使用Wi-Fi/蜂窝公网；Android如遇个别应用识别VPN，可在Tailscale客户端中排除该应用，但Vera必须保留在Tailscale路径。
- **CORS**：Web同源伺服天然无CORS；原生壳跨域时gateway只回显`config.security.cors.allowedOrigins`中的精确Origin，并加`Vary: Origin`，禁止`Access-Control-Allow-Origin: *`。允许方法为`GET,POST,PATCH,DELETE,OPTIONS`，允许头为`Authorization,Content-Type,Last-Event-ID`，预检`OPTIONS`返回204。
- **SSE 长连接**：原生壳使用原生HTTP长连接，断线重连带`Last-Event-ID`并按`?since=`重放；蜂窝/Wi-Fi切换、锁屏恢复和Tailscale重连必须真机验收。

### 根节点标记与 safe-area

- HTML 根节点设置 `data-platform="web|android|ios"`（由 platform adapter 根据自身 `id` 在 boot 时写入），CSS 通过 `[data-platform="…"]` 选择器做小范围平台适配，**不 fork 页面**。
- safe-area 由 CSS env 变量 `env(safe-area-inset-*)` + platform adapter 的 `keyboard.insets` 共同驱动，组件层只读 CSS 变量。
- 平台差异唯一允许的体现：安全区、键盘、返回手势、通知、文件选择、触感、外部认证/链接、本地安全存储。颜色、排版、页面职责、业务流程不分叉（ground truth 6.2）。
