# API 契约

> 前后端唯一接口基准。接口变更先改本文档再动代码。
> 覆盖 Phase 2–4 所需；标注 `[P4]` / `[P5]` 的条目在对应阶段前不实现，但形状现在定死。

---

## 一、通用约定

- 所有接口挂在 `/api/` 下，请求与响应均为 JSON（SSE 除外）。
- 时间一律 ISO 8601 UTC 字符串（`2026-07-02T03:00:00.000Z`）。
- ID 带类型前缀的随机串：`agt_` / `spc_` / `msg_` / `run_`。
- 错误统一形状，HTTP 状态码配合语义：

```json
{ "error": { "code": "not_found", "message": "space spc_xxx does not exist" } }
```

`code` 枚举：`invalid_request`(400) / `not_found`(404) / `conflict`(409) / `adapter_unavailable`(502) / `internal`(500)。

- Secret 永不出现在任何响应中。API 型 agent 的 key 存 `~/.vera/secrets.json`，接口只引用键名（`secretRef`）。
- `/api/agent/*`（联邦接入通道，Phase 5.5）走**双层认证**：Cloudflare Access Service Token 头过 Cloudflare 那道门（不弹邮件 OTP），`Authorization: Bearer <vera-agent-token>` 由 gateway 校验识别 token 持有者为哪个 agent（token 文件 `~/.vera/agent-tokens.json`）。其余 `/api/*` 路径不动用 agent token，浏览器/HTTP 客户端仍走 Cloudflare Access 邮件 OTP。详见 ground truth 2.4。

## 二、数据形状

### Agent（ground truth 2.2）

Agent = Vera 内独立身份实体。**只有命名 + 时间戳**，不携带连接类字段。连接、供应商、模型、外部会话上下文一律随 Account 走。

```json
{
  "id": "agt_x1y2",
  "name": "Iota",
  "createdAt": "…",
  "updatedAt": "…"
}
```

- 身份 = `name`，永久绑定记忆与历史。
- 每个 agent 注册时自动派生一条**自有 account**（`owningAgentId` 指回自身），日常一对一使用；必要时 agent 可驾驶别人的 account 管理其项目（见 Account / Seat）。
- 改连接/供应商/模型改的是 account，agent 身份与记忆不变。

### Account（ground truth 2.2 2026-07-03 修订）

Account = 供应商连接 + 项目/会话上下文，随账户不随 agent。

```json
{
  "id": "acc_a1b2",
  "owningAgentId": "agt_x1y2",
  "name": "Iota 的 opencode",
  "kind": "cli",
  "provider": "opencode",
  "connection": {
    "command": "/Users/theta/.opencode/bin/opencode",
    "args": [],
    "secretRef": null
  },
  "model": "zai/glm-5.2",
  "presence": "offline",
  "lastSeenAt": "2026-07-04T10:58:00.000Z",
  "runtimeCapabilities": null,
  "authorizedAgentIds": ["agt_x1y2"],
  "createdAt": "…",
  "updatedAt": "…"
}
```

- `owningAgentId`：该账户的主人 agent。**agent 当前驾驶哪个 account 由 agent daemon 登录时显式声明**（联邦形态 ground truth 2.4）；默认走自己的 owning account，要换账户=daemon 重登一次。**Seat 不再携带 `accountId` 字段**（账户归属是登录级而非 Space 级，见 Space 段）。`run` 仍记 `agentId`（记忆随 agent 身份走，外部会话随被驾驶的 account 走）。
- `authorizedAgentIds: ["agt_…"]` `[P5.5]`：授权哪些 agent 以明文密钥使用该账户与供应商通信（默认仅 `[owningAgentId]`）。CLI 型账户 key 不经 gateway 持有故不适用。daemon 用 agent token 向 gateway 换 key 时 gateway 按 `agentId ∩ authorizedAgentIds` 判定，不在名单的 token 拿不到 key（403）。在前端配置此名单=用户决定哪些 agent 可互用哪些账户。
- `kind: "cli"` 时 `connection.command/args` 有效；`kind: "api"` 时 `connection.secretRef` 有效。
- `model` 为空串 = 使用该供应商默认模型（CLI 型 adapter 不传 `-m` 类参数）。
- secret 永不出现在响应里；`connection` 里只用 `secretRef` 引用 `~/.vera/secrets.json` 中的键名。
- `presence: "online"` 由 agent daemon 通过 `/api/agent/*` 心跳维持（ground truth 2.4 联邦形态）；daemon 主动登出或心跳缺失后由 gateway 置 `offline`。`lastSeenAt` 是上一次心跳或最后一次 SSE 收到时刻。
- `runtimeCapabilities` `[P5.5]` 是当前daemon登录时报告的临时公开快照，形状见 `adapter-interface.md` 2.1；只用于Account组合页显示Tools/扩展运行支持。离线时返回 `null`，不写入accounts集合。能力可用不等于已获授权，执行仍按workspace/tool policy/Approval判定。
- **联邦形态遗留说明**：`connection.command` 字段在 ground truth 2.4 联邦形态下从语义上已无意义（gateway 不 spawn CLI，路径是 agent daemon 的事），但 v1 形状保留以兼容 4.1 已落代码；Phase 5.5 联邦实现时该字段不再被任何代码读取，可在前端管理界面隐藏。

**v0 / v1 兼容说明（仅限 Phase 4 一次迁移）**：v0 agent 记录里内嵌的 `kind/provider/connection/model` 由 store 启动时迁移到新建的 owning account；v0 的 `session-states.json` 键 `${agentId}:${spaceId}` 重映射为 `${accountId}:${spaceId}`（用各 agent 的自有 account）。迁移幂等，旧文件留 `.legacy`。此后 Agent 与 Account 是两条独立路径，不再有"内嵌字段"形态。

**v1 → Seat 去 accountId 一次性迁移（Phase 4.4）**：4.1 落地的 `seat.accountId` 字段废弃——账户归属改为 daemon 登录级（联邦）或 owning account（Phase 4 期间）。store 启动时清理所有 spaces 下 seats 上的 `accountId` 字段，session-states 键**不动**（仍按 `(accountId, spaceId)`，默认 accountId = 派生 owning account id）。4.1 那条 backfill `seat.accountId` 的迁移逻辑同时撤掉。

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
  "archivedAt": null,
  "createdAt": "…"
}
```

- `seat.agentId`：在该 Space 上以哪个身份出席。
- `seat.responseMode`（per-agent per-Space，ground truth 2.3）：`default`（都响应）/ `silent`（只响应指定来源的 @）/ `focused`（只响应 @自己）。定向 @ 到的 agent 一律响应，不受 responseMode 影响。
- **Seat 不携带 `accountId`**（Phase 4.4 调整）：agent 驾驶哪个 account 是登录级决定（联邦 daemon login 声明，见 Account 段）或默认 owning account（Phase 4 期间），不再 per-Space 覆盖。
- `silent` 的来源过滤字段 `respondTo: ["user", "agt_..."]` 挂在 seat 上（成员为 `"user"` 或 `agt_` id）；Phase 4 落地，落地前 silent 对定向 @ 等价 focused。
- `seat.blockAgentIds: ["agt_…"]`（Phase 4.3，可选）：屏蔽名单——名单里 agent 的气泡不进该 agent 的群聊视角 prompt 段，等价于对它单向静默。定向 @ 仍穿透屏蔽（用户拥有最终决策权，ground truth 2.3）。
- `notifications` `[P4.6]`：当前Space的提醒策略。`mode` 为 `all`（agent消息与Activity均提醒）/ `agentMessages`（只提醒agent消息，默认）/ `off`；`includeActivityErrors` 控制error Activity是否即使在 `agentMessages` 下也提醒。这里是gateway持久的Space策略；浏览器/系统通知权限仍由各客户端自己申请，二者不得混成一个开关。
- `archivedAt` `[P4.6]`：`null` 表示活跃；ISO时间戳表示已归档。归档只把Space移出活跃导航并禁止新消息/新Run，Space自身及Message/Activity/Approval/Run/sessionState全部保留，时间线仍可读取，恢复后继续使用原Space id与外部会话。Space没有永久删除接口。
- Space Module绑定不直接塞任意脚本进Space记录。Phase 6先定义全局Extension Package与per-Space Module binding的独立集合/API，再由Space设置页读取；契约未补全前不得在 `seats` 或任意自由字段里偷放Module配置。

**Speaker view 编译层输出契约**（ground truth 2.3「群聊视角注入形态」）：触发某 agent 的 run 时，gateway 的编译层（`src/spaces/view-compiler.js`，Phase 4.2）从 `messages.json` 临时派生 `ctx.prompt.text`——该 agent 上次本人发言（找其最后一次 assistant 气泡的 createdAt）之后到当前触发之间的他人 message 气泡，按时间穿插聚合成署名声告段（不伪装一对一 user 历史轮次）；Activity 不进任何 prompt（ground truth 2.3 发言与过程边界）。`silent/focused/blockAgentIds` 统一在此层过滤：被过滤的气泡不进段，等价于不触发 run。编译层无状态——每次 run 临时查 store 派生，不维护"已投递水位"。CLI 与 API adapter 共享同一份 promptText 输出，各自翻译成协议帧（见 adapter-interface.md「编译层契约」）。

**prompt.text 物理拼装顺序**：`[常驻索引块]?\n\n[群聊声告段]?\n\n[触发消息正文]`，三段以 `\n\n` 分隔，缺哪段哪段连同其后的空行一起省略，不留前导/尾部空行；最终 text 永远至少含触发消息正文（非空字符串）。常驻索引块与群聊声告段是**两段严格分开的头部**：常驻索引是稳定前缀（仅在该 (account, Space) 尚无 sessionState 即首次新会话时注入一次，换代时不逐条刷新），群聊声告是每轮刷新的 volatile 段（仅在该 agent 上次本人发言之后到当前触发之间存在他人气泡时出现；无候选则整段连同 header 省略）。群聊声告段内格式固定 `=== 群内最近发言 ===\n- <署名>: <气泡正文>\n…`，署名取 `config.viewCompiler.groupDeltaUserLabel`（用户）或 agent.name（agent）；段内条数/总字符数达上限时从最早开始截断，发生截断时在 header 行后插一行 `config.viewCompiler.groupDeltaOmittedHint`。配置项默认值见 `src/core/config.js` 的 `viewCompiler` 节点：`groupDeltaMaxMessages: 20`、`groupDeltaMaxChars: 4000`、`groupDeltaHeader: "=== 群内最近发言 ==="`、`groupDeltaUserLabel: "用户"`、`groupDeltaOmittedHint: "（更早的发言数量已达上限，可用 fetch_detail 主动调阅）"`，env 对应 `VERA_VIEW_COMPILER_GROUP_DELTA_*`。

### Message

```json
{
  "id": "msg_m1n2",
  "spaceId": "spc_a1b2",
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
  "spaceId": "spc_a1b2",
  "triggerMessageId": "msg_m1n2",
  "replyMessageIds": ["msg_p3q4", "msg_p3q5"],
  "status": "running",
  "createdAt": "…",
  "endedAt": null
}
```

`status`：`running` / `completed` / `failed` / `cancelled`。`failed` 时 Run 带 `error: { code, message }` 字段（挂在 Run 对象上，其余状态无此字段）。

同一 (agent, Space) 上的 run **串行执行**：前一个未结束时，后续触发的 run 排队等待（外部会话是同一条，并发投递会串线）。排队对外不暴露单独状态，Run 记录即时创建、一律显示 `running`；排队中被取消同样收 `cancelled`。不同 agent 或不同 Space 之间照常并行。

### Activity（时间线成员）

思考链、工具执行记录等过程信息。**不是独立面板，是 Space 时间线的正式成员**：与消息气泡按时间穿插排列，历史记录里同样保留。

```json
{
  "id": "act_t1u2",
  "spaceId": "spc_a1b2",
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
- AgentState 是**运行时派生状态**，不持久化；gateway 重启后全部归 `idle`、所有 `away` 复位。与 `Account.presence` 正交：presence 是 daemon ↔ gateway 的通信二态，AgentState 是该 agent 在某 Space 内的具体工作相。

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
| POST | `/api/agents` | 创建。body 至少 `{ "name": "…" }`；可一次性带 `{ name, kind, provider, connection?, model? }` 一并初始化其自有 account（ground truth 2.2「注册时自带账户」）。响应 `{ "agent": Agent, "account": Account }`（account 为自动派生的那一条 owning account） |
| PATCH | `/api/agents/:id` | 更新 `name`。换模型/供应商/连接改的是 account，不去这个接口 |
| DELETE | `/api/agents/:id` | 删除身份（记忆与历史的处置 `[P5]` 再定，Phase 2–4 直接拒绝删除有历史的 agent）。删除时连带删其自有 account |

### Account

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/accounts` | 列表；支持 `?agentId=<agt_…>` 过滤该 agent 名下所有账户 |
| POST | `/api/agents/:id/accounts` | 为 agent `:id` 新增一条 account（多账户/驾驶他人账户场景）。body 为 Account 形状去掉 `id/owningAgentId/时间戳`。响应 `{ "account": Account }` |
| PATCH | `/api/accounts/:id` | 更新 `name` / `kind` / `provider` / `connection` / `model`（换 key/供应商/模型不换身份——身份仍是 owningAgentId 指向的 agent） |
| DELETE | `/api/accounts/:id` | 删除账户。其自有的 owning account（即 `owningAgentId` 对应的 agent 尚存在且这是唯一 account）不可删，返回 409；删除前若有未结束的 session 状态一并清掉 |

前端只有一个 `#/settings/accounts` 管理入口：按Agent聚合其身份、Memory摘要、AgentState及名下Account连接；这只是读取时组合，响应形状仍保持独立 `agents` / `accounts`，不得新增内嵌双写形状。

### Space

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/spaces` | 默认只列活跃Space；`?archived=true`只列已归档，`?archived=all`列全部。`/api/bootstrap`只返回活跃Space |
| POST | `/api/spaces` | 创建 |
| PATCH | `/api/spaces/:id` | 更新 name/topic/seats/notifications（席位增删、responseMode/提醒策略调整） |
| POST | `/api/spaces/:id/archive` `[P4.6]` | 归档Space。存在未结束Run时返回409；成功写入`archivedAt`，不删除或级联清理任何记录。重复归档幂等返回当前Space。前端显示Space名称并二次确认，归档后切换到另一活跃Space |
| POST | `/api/spaces/:id/restore` `[P4.6]` | 恢复已归档Space：把`archivedAt`置回`null`并保留原id、历史与sessionState。重复恢复幂等返回当前Space |
| GET | `/api/spaces/:id/timeline?before=<itemId>&limit=50` | 时间线历史，倒序分页。返回 `{ "items": [...] }`，成员为 Message / Activity / Approval 三种，各带 `"itemType"` 字段区分，按时间排序 |
| POST | `/api/spaces/:id/messages` | 发消息（见下）；已归档Space返回409 `conflict`，必须先恢复 |

**发消息**（用户或 agent 均走此接口；agent 发消息 `[P4]`）：

```json
// 请求
{ "author": { "type": "user" }, "target": { "type": "broadcast" }, "content": "…" }
// 响应 201
{ "message": { …Message… }, "runs": [ { …Run… } ] }
```

gateway 依据每个 seat 的 responseMode 决定哪些 agent 产生 run，同步返回创建的 runs；后续进展全部走 SSE。

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

> 这是联邦形态（ground truth 2.4）的 agent daemon ↔ gateway 通道。所有路径以 `/api/agent/` 为前缀，走 Cloudflare Access Service Token（外层，过 Cloudflare 门）+ Vera agent token（身份层，`Authorization: Bearer <token>`，gateway 校验）双层认证（见 ground truth 2.4）。MVP 期间用户视角仍走原 `/api/agents/*` / `/api/spaces/*`，不混用。

| Method | Path | 说明 |
|---|---|---|
| POST | `/api/agent/login` | daemon启动时报到。body带可选`accountId`与必需`runtimeCapabilities`（Tools + extension runtime支持，见adapter-interface 2.1）；响应返回agent/account/seats/sessionStates/runtimeCapabilities/heartbeatIntervalMs。gateway把Account.presence置`online`并只在登录session内暂存capabilities |
| DELETE | `/api/agent/sessions` | 主动登出。gateway 置 presence=`offline`、`lastSeenAt=now`，保留 sessionState 不动词 |
| GET | `/api/agent/events` | SSE 订阅，daemon 单一长连接收 *(1)* `agent.heartbeat` 帧维持在线判定、*(2)* 该 agent 所在所有 Space 的 `run.requested` 事件（含编译好的 `promptText`）、*(3)* 全局 `account.upserted` / `space.updated` 等配置变更 |
| POST | `/api/agent/runs` | daemon 收到 `run.requested` 后创建 Run 并跑。body `{ "triggerMessageId": "msg_…", "spaceId": "spc_…", "agentId": "agt_…", "accountId": "acc_…" }`，响应 201 `{ "run": Run }`（status=running） |
| PATCH | `/api/agent/runs/:id` | 在飞 run 的状态/属性更新（pending → running → completed/failed/cancelled）；body 可带 `status`、`error`、`agentState`（该 Space 的 AgentState 顺带更新）|
| POST | `/api/agent/runs/:id/messages` | agent 发言气泡。body 为 Message 形状去掉 `id/runId/createdAt/status`。每条气泡各发一次，落地进 Space 时间线 + 走 SSE `message.created` |
| POST | `/api/agent/runs/:id/delta` | 当前气泡的流式增量。gateway 转 `message.delta` SSE 事件给前端 |
| POST | `/api/agent/runs/:id/activities` | 创建/更新 activity（带 `callId` 合并同一条），落地 + `activity.created`/`activity.updated` SSE |
| POST | `/api/agent/runs/:id/approvals` | 提权申请，gateway 转 `approval.requested` 给前端 |
| POST | `/api/agent/sync-state` | sessionState 同步备份。body `{ "accountId": "acc_…", "spaceId": "spc_…", "sessionState": <opaque>\ }`。gateway 原样持久化（per `(account, Space)`键） |

**离线 @ 行为**（ground truth 2.4 决策第 3 条）：`POST /api/spaces/:id/messages` 处理时，若 `shouldRespond` 命中某 seat 但其 agent 的 `Account.presence=offline`，gateway **不创建 Run**、不发 `run.requested`，而是在该 Space 时间线发一条 Activity：

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
| `isolation.memory` | enum: `isolated` / `globalReadable` / `perSpace` | `isolated` |
| `isolation.files` | enum: `isolated` / `specifiedShared` / `globalReadable` | `isolated` |
| `isolation.agentState` | enum: `isolated` / `globalVisible` | `globalVisible` |
| `memory.digestTrigger` | enum: `scheduled` / `realtime` / `manual` | `scheduled` |
| `memory.digestSchedule` | string（cron 表达式） | `0 3 * * *` |
| `memory.injectionBudgetResidentLines` | number | `config.memory.residentIndexMaxLines`（默认 25） |
| `presentation.bubbleBoundaryPattern` | string（正则源） | `config.bubbles.boundaryPattern` |
| `presentation.bubbleMinLength` | number | `config.bubbles.minLength` |
| `presentation.bubbleMaxLength` | number | `config.bubbles.maxLength` |

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

**持久化语义**：`<dataPath>/settings.json` 保存设置override，`<dataPath>/themes.json` 保存归一化Theme对象，均走store防抖落盘（与 store 同 200ms 节流）。config.js 仍是启动默认 source（env 派生），settings.json 是运行时覆盖；只 persist overrides，不 persist 默认值或导入原文。consumer 接入（bubble-stream / view-compiler / memory 整理、Appearance token loader等）在 Phase 4.6 及以后；没有实际consumer和实测记录的字段不得在 `plan.md` 标成闭环完成。

### Memory（最小闭环，2026-07-03 提前进场）

全量设计见 `memory-hook.md`（R1–R6，Phase 5）；本轮只落地下述最小闭环，**其余 `/api/memory/*`（检索注入、fetch_more / fetch_detail、write hook、dream、派生权重）继续冻结**，形状届时先补本文档。

**文件库**：默认 `~/.vera/memory/`（配置项，env `VERA_MEMORY_VAULT_PATH`），Obsidian 兼容 vault，在仓库外。每条记忆一个 `.md` 文件：

- 文件名 = 语义化 kebab-case slug（如 `bubble-split-rule.md`）。slug 即公共指针，一经建立不改名（R2）。
- frontmatter（YAML）：

```yaml
type: decision        # 枚举可扩展，起步集：project_rule / architecture / workflow / preference / correction / bug / decision / open_question
description: 一行钩子——常驻索引只展示这一行
status: active        # active / archived（过时先归档不删除）
stains:               # 可选，哑墨（R5）：agentId -> 裸 hex。四不：不注入、不解释、不引用、不作为判断依据
  agt_x1y2: "#7A8FA6"  # 为空时序列化为 `stains: {}`，键不省略
createdAt: 2026-07-03T00:00:00.000Z
updatedAt: 2026-07-03T00:00:00.000Z
```

- 正文为 markdown，`[[slug]]` 双链；指向尚不存在的 slug 合法（标记待写，不是错误）。

**常驻索引注入**：gateway memory 模块扫描 vault，生成至多 N 行（配置，默认 25）`[[slug]] — 钩子行` 索引，在 (agent, Space) 外部会话的**首条消息**头部注入，附 vault 路径和一句「相关时用你的文件工具展开 [[slug]]」。索引**批量换版**：只随新会话换代，不逐条消息刷新（缓存纪律——它属于稳定前缀，不是逐条变化的检索注入）。MVP 期挑选规则 = 按 `updatedAt` 降序截断，archived 排除；权重排序 Phase 5 再来。

**读写**：读取不限——CLI 型 agent 用自身文件工具直接读 vault。MVP 期 agent 也可按本格式直接写文件（R1 单写者排队在 write hook 进场时收紧）。

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/memory` | 索引列表 `{ "memories": [{ slug, type, description, status, stains, createdAt, updatedAt }] }`，按 updatedAt 降序。给前端记忆库用，允许含 stains（前端可显示，R5） |
| POST | `/api/memory` | 手动「保存到记忆」。body `{ "slug", "type", "description", "content", "stains"? }`；gateway 落盘为上述文件格式。成功 → 201 `{ "memory": { slug, type, description, status, stains, createdAt, updatedAt } }`（与 GET 列表条目同形）；slug 已存在 → 409 `conflict`；slug 不合法（非 kebab-case）→ 400 |
| GET | `/api/memory/:slug` `[P4.6/F1]` | 取单条完整正文 `{ "memory": { slug, type, description, status, stains, createdAt, updatedAt, content } }`；slug 不存在 → 404 |
| PATCH | `/api/memory/:slug` `[P4.6/F1]` | 编辑已有记忆。body 任一可选 `{ "type", "description", "status", "content", "stains", "newSlug", "ifMatch" }`：`status` 取 `active` / `archived`（归档不删除，文件保留）；`newSlug` 触发文件 mv（重命名后双链不自动更新——Obsidian 等工具会在下次打开时回写，gateway 不扫描全文替换，保持薄封装）；`ifMatch`（ISO updatedAt）做乐观并发控制，与磁盘 `updatedAt` 不一致 → 409 `conflict` 并附 `{ current: {...} }` 让前端重新加载。成功 → 200 `{ "memory": {...} }`，`updatedAt` 由 gateway 重写。slug 不存在 → 404；`newSlug` 非 kebab-case 或已占用 → 400 / 409 |
| DELETE | `/api/memory/:slug` `[P4.6/F1]` | 删除记忆文件。**不可逆**，前端必须二次确认。成功 → 204；slug 不存在 → 404。删除后历史时间线中已注入的索引不受追溯影响（索引是当时快照） |

## 四、SSE 事件流

### 通道

```
GET /api/events            # 全局唯一流，Accept: text/event-stream
GET /api/events?since=<seq>  # 断线重连，从 seq 之后重放
```

单一全局流、事件自带 `spaceId` 路由信息——手机端穿隧道只维护一条长连接。

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
| `message.delta` | `{ messageId, spaceId, delta }` | 当前气泡的流式增量，客户端追加渲染 |
| `message.completed` | `{ message }` | 当前气泡定稿，content 为该气泡权威全文（客户端以此覆盖累积值） |
| `run.started` | `{ run }` | |
| `run.ended` | `{ run }` | status 为 completed/failed/cancelled；failed 时带 `error.code/message` |
| `activity.created` | `{ activity }` | 新时间线过程条目（思考链、工具执行开始…） |
| `activity.updated` | `{ activity }` | 同一条目状态/内容更新（工具 pending→completed 等） |
| `approval.requested` | `{ approval }` | 提权申请卡片入时间线，等待用户答复 |
| `approval.answered` | `{ approval }` | 已答复或过期（多端同步：手机答了，电脑上的卡片也变灰） |
| `agent.state.updated` | `{ agentState }` | per-Space AgentState 现 `agentId/spaceId/status/detail/lastActiveAt` 五字段（联邦形态精化） |
| `account.presence.updated` | `{ accountId, presence, lastSeenAt }` | Agent daemon 上下线广播，前端更新联系人在线状态指示 |
| `space.updated` / `agent.updated` / `account.upserted` | `{ space }` / `{ agent }` / `{ account }` | 配置变更广播；`account.upserted` 覆盖 account 创建与修改，前端按 `id` 合并联系人 |
| `agent.heartbeat` `[Phase 5.5]` | `{ ts }` | gateway 每 15s（`agentDaemon.heartbeatIntervalMs`）在 daemon SSE 通道发的存活信号；daemon 连续 3 次未收到即 `exit(0)` 防止反复撞网关烧 token |
| `run.requested` `[Phase 5.5]` | `{ run, triggerMessage, agent, account, promptText }` | gateway 推给 daemon 的 run 触发；`promptText` 已由编译层拼好群聊 delta + 索引前缀，daemon 直接喂 CLI 即可不回头读 store（编译层契约见 adapter-interface.md） |
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

## 五、与隧道的兼容性约束

- SSE 响应必须逐帧 flush，不得依赖缓冲（Cloudflare 隧道 `disableChunkedEncoding: false`、nginx `proxy_buffering off`，见 `reference/vps-tunnel-deploy.md`）。
- gateway 每 25s 发 SSE 注释帧 `: ping` 保活，防止中间层超时断连。

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

- **SSE 事件输入**：`message.created` / `message.delta` / `message.completed`（时间线渲染）；`activity.created` / `activity.updated`（思考链 / 工具卡片穿插）；`approval.requested` / `approval.answered`（提权卡片）；`run.started` / `run.ended`（agent 状态指示）；`agent.state.updated`（仅 `spaceId` 匹配当前 Space 的条目，驱动 composer 上方 agent 工作相）；`space.updated`（当前 Space name / topic 变更回显顶栏）；`account.presence.updated`（联系人在线指示）。
- **API 读取**：`GET /api/bootstrap`（首屏）；`GET /api/spaces/:id/timeline?before=&limit=50`（向上翻页加载更早历史）。
- **API 写入**：`POST /api/spaces/:id/messages`（广播 / `@` 定向，body 含 `author`/`target`/`content`）；`POST /api/runs/:id/cancel`（取消在飞 run）；`POST /api/approvals/:id/answer`（`allow` / `deny`）。
- **空错态**：Space 不存在（404）→ 主区显示「Space 不存在或已归档」+ 返回导航入口；时间线空 → 「还没有消息，发一条开始」；时间线长 → DOM 上限 200 items，更早走 `?before=` 分页；approval 失效（409）→ 卡片灰化；发送失败（4xx/5xx）→ composer 内联错误 + 保留草稿；SSE 断连 → 时间线冻结 + 顶部「重连中」；已归档 Space 通过此路由进入 → 消息发送返回 409，主区显示「已归档，去设置恢复」入口。

### Space导航 `#/spaces`（右滑 / 抽屉 / 桌面图钉常驻）

- **SSE 事件输入**：`space.updated`（重命名 / Seat / notifications 变更回显）；`agent.updated` / `account.upserted`（左栏联系人投影）；`account.presence.updated`（在线指示）。
- **API 读取**：`GET /api/bootstrap`（复用 Shell 拉取的 agents/accounts/spaces；进导航页不再发额外请求，纯客户端派生左栏联系人 / 右栏 Space 列表）；`GET /api/spaces?archived=true`（展开「已归档 Spaces」分段时按需拉取已归档列表）。
- **API 写入**：`POST /api/spaces`（新增；body 继承当前左栏选中成员集合作为 seats）；`PATCH /api/spaces/:id`（重命名 / topic / seats / notifications）；`POST /api/spaces/:id/archive`（二次确认后归档，归档成功后切换到另一活跃 Space）；`POST /api/spaces/:id/restore`（从「已归档」分段恢复）。
- **空错态**：无 Space → 左栏联系人可点但右栏空 + 「新建 Space」CTA；左栏无选中 → 右栏显示「选一个联系人或群组」；归档失败（409 有未结束 Run）→ toast「有进行中的对话，等结束或取消后再归档」；新增失败 → 内联错误；归档二次确认 → 弹层 only（不替换主区）。

### 当前Space设置 `#/spaces/:spaceId/settings`

- **SSE 事件输入**：`space.updated`（外部改动回显，多端同步）；`agent.updated` / `account.upserted` / `account.presence.updated`（参与 Agent 列表状态）。
- **API 读取**：`GET /api/bootstrap`（参与 Agent + seats 组合）；不预取 Space Module 列表（`[Phase 6]` 契约未落）。
- **API 写入**：`PATCH /api/spaces/:id`（一次提交 seats / notifications / name / topic；Seat 字段 `agentId` / `responseMode` / `respondTo` / `blockAgentIds` 全在此）。
- **空错态**：Space 不存在 → 整页「Space 不存在」+ 返回；无 seats → 「还没有 Agent 参与，去 Account 管理添加」+ 跳转 `#/settings/accounts`；保存失败 → 字段级错误回显，不整页崩溃；Space Module 区 → 「`[Phase 6]` 未开放」占位，不渲染假开关；离开未保存改动 → 浏览器原生 confirm。

### Setting目录 `#/settings`

- **SSE 事件输入**：无（不订阅；进页拉一次即可）。
- **API 读取**：无（不预取子页数据；只渲染静态分组列表）。
- **API 写入**：无。
- **空错态**：纯静态页；分组项被 `[Phase 6]` 占位时显示「未开放」灰条，可点但不跳转或弹「待 Phase 6 落地」。

### Appearance `#/settings/appearance`

- **SSE 事件输入**：无（外观是本地预览 + 保存，不订阅事件）。
- **API 读取**：`GET /api/settings`（初始外观字段）；`GET /api/themes`（Theme 列表摘要，进页时拉一次）；`GET /api/themes/:id`（选中某 Theme 预览时按需拉取完整对象）。
- **API 写入**：`PATCH /api/settings`（保存外观字段；按组恢复默认对该组已知 key 一次 PATCH `null`）；`POST /api/themes/import`（导入预览，不持久化）；`POST /api/themes`（确认保存归一化 Theme）；`PATCH /api/themes/:id`（重命名 / 编辑 colors/terminal）；`DELETE /api/themes/:id`（被 `appearance.themeId` 引用时 409）；`GET /api/themes/:id/export?format=vera-json|vera-css`（导出 Theme Palette）；`GET /api/settings/appearance-profile/export`（导出非 Theme 的 Appearance Profile）；`POST /api/settings/appearance-profile/import`（预览 Appearance Profile，不保存，确认后仍 PATCH `/api/settings`）。
- **空错态**：settings 加载失败 → 回落 config 默认 + 顶部「无法读取已保存配置，展示默认值」；Theme 列表空 → 「还没有保存的 Theme，导入一份试试」；导入失败 → 预览区显示 `warnings` + 不写入；导出失败 → toast；预览只改内存 CSS 变量，刷新或离页未保存 → 丢弃；实时预览与「已保存」之间须有明确视觉区分（按钮态 / 标记）。

### Account管理 `#/settings/accounts`、`#/settings/accounts/:agentId`

- **SSE 事件输入**：`agent.updated`（Agent 名称回显）；`account.upserted`（Account 创建 / 修改回显）；`account.presence.updated`（在线指示 + `runtimeCapabilities` 是否有快照）；`agent.state.updated`（Agent 当前工作相，按 `agentId` 过滤）。
- **API 读取**：`GET /api/bootstrap`（列表页用 agents + accounts 组合）；`GET /api/accounts?agentId=…`（详情页按需刷新该 Agent 名下 accounts）；`GET /api/agent-states?agentId=…`（详情页 Agent 当前工作相）。**不预取 Memory 正文**——Memory 在 `#/settings/accounts/:agentId/memory` 子路由按需加载。
- **API 写入**：`POST /api/agents`（新建 Agent；响应含自动派生的 owning account）；`PATCH /api/agents/:id`（仅改 `name`）；`DELETE /api/agents/:id`（删除身份 + 自有 account；有历史的 agent 返回 409）；`POST /api/agents/:id/accounts`（为 Agent 新增非自有 account，多账户 / 驾驶他人账户场景）；`PATCH /api/accounts/:id`（改 `name` / `kind` / `provider` / `connection` / `model`）；`DELETE /api/accounts/:id`（删除连接；自有唯一 account 409）。
- **空错态**：无 Agent → 「还没有 Agent，新建一个」CTA；Agent 无 account → 「这条 Agent 还没有连接，去添加一条 Account」；删除二次确认 → 弹层（删除 Agent 与删除 Account 是两个明确动作，文案区分）；删除失败（409）→ toast 显示原因；`runtimeCapabilities` 为 `null`（离线或未登录）→ 详情页「未连接，能力未知」而非虚构数据。

### Agent Memory `#/settings/accounts/:agentId/memory`

- **SSE 事件输入**：无（Memory 编辑是请求-响应，不订阅实时事件）。
- **API 读取**：`GET /api/memory`（索引列表，按 `updatedAt` 降序，含 stains）；`GET /api/memory/:slug`（选中条目按需拉取完整正文）。
- **API 写入**：`POST /api/memory`（新建；slug 已存在 409）；`PATCH /api/memory/:slug`（编辑 frontmatter 字段 / 正文；可选 `newSlug` 重命名，重命名是文件 mv + 双链更新）；`DELETE /api/memory/:slug`（删除文件；删除前二次确认）。
- **空错态**：vault 不存在 / 空 → 「记忆库为空，agent 用一次就慢慢攒起来了」+ 「手动保存一条」CTA；slug 不存在（404）→ 返回列表 + toast；编辑冲突（同时被 agent 写）→ 加载时记录 `updatedAt`，PATCH 携带 `ifMatch` 校验，不一致返回 409，前端提示「这条刚被 agent 改过，重新加载」；删除二次确认 → 弹层。

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

ground truth 4.1 末段把可配置路径分两类：用户数据位置（Memory vault、Agent 工作路径、Files/附件路径）走普通保存；gateway 数据目录等影响事实来源的高风险路径必须走「校验 → 迁移 → 验证 → 回滚」独立流程。端口、SSE 心跳/缓冲、store 落盘节流、daemon 回收、run 看门狗仍走 env，不进本接口。

### 字段清单

| key | 作用 | 当前可编辑 | 风险等级 |
|---|---|---|---|
| `memory.vaultPath` | Obsidian 兼容 vault 根目录 | 是 | 普通（仅 markdown 文件，失败不危及事实来源） |
| `gateway.dataPath` | gateway 持久化数据根目录 | 是（仅 migrate，无直接文本框） | 高（含 agents/spaces/messages/runs/session-states 全部事实来源） |
| `agents.*.workspacePath` `[P5.5]` | per-agent daemon 工作目录 | 否（联邦 daemon 登录时声明） | 普通 |
| `files.attachmentsPath` `[P5]` | Space 内附件存储根 | 否 | 普通 |

### 端点

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/paths` | 返回当前路径摘要：`{ paths: { memory: { vaultPath, exists, memoryCount }, gateway: { dataPath, sizeBytes, restartRequired: false } } }`。`gateway.dataPath.sizeBytes` 是目录递归大小估算（du 等价），用于路径管理页展示。**不返回** port / SSE / store 节流等 env 配置（去 `/api/status`）。 |
| POST | `/api/paths/validate` | body `{ key, value }`，`key` ∈ `memory.vaultPath` / `gateway.dataPath`；`value` 为绝对路径字符串（相对路径规范化为相对 cwd 的绝对）。返回 `{ ok: bool, errors: string[], warnings: string[], normalized: string }`，**不写盘**。校验项：绝对路径；路径可写或可创建（父目录存在且可写）；不在仓库工作树内（防止用户把 vault 指到 `~/projects/Vera-0.0.1/`）；对 `gateway.dataPath` 额外校验：目标目录为空或仅含可识别的 Vera store 文件（防覆盖陌生数据）；磁盘剩余空间 ≥ 当前 dataPath 大小（迁移用）。 |
| POST | `/api/paths/migrate` | body `{ key, target }`；migrate 是 validate + 实际搬移 + 改 config override 的合动作。返回 `{ ok, key, from, to, restartRequired }`。失败时路径不动（已搬移的部分回滚），返回 400/409 + `{ errors }`。 |

**migrate 各 key 行为**：

- `memory.vaultPath`：
  1. validate target → 2. `mkdir -p target` → 3. 把当前 vault 下所有 `*.md` 移到 target（非 `*.md` 不动）→ 4. 验证 target 文件数 = 原 vault 文件数 → 5. `PATCH /api/settings` 写 `paths.memoryVaultPath = target` override → 6. memory 模块重开（重读 target，热替换）→ 7. 返回 `{ restartRequired: false }`。原 vault 目录留空不删（用户自行清理）。失败任一步回滚：把已搬到 target 的文件 mv 回原 vault。
  2. `gateway.dataPath`：
  1. validate target → 2. 写 `<target>.legacy-migration` 标记 → 3. 复制当前 dataPath 全部内容到 target（rsync 等价，保留文件权限）→ 4. 在 target 上启动一个临时 store loader 试加载（只读模式，确认无损坏）→ 5. 通过后，`PATCH /api/settings` 写 `paths.gateway.dataPath = target` override → 6. 旧 dataPath 不动（保留作回滚锚点），返回 `{ restartRequired: true }`。gateway 实际切换到 target 在下次重启后由 store migrate detect 走「分文件 → 分文件」自愈（不另写迁移代码）。
  3. **回滚**：migrate 失败任一步：已复制到 target 的内容删除并移走 `.legacy-migration` 标记；settings.json 不写 override；旧路径不动。重启后 store 在新 path 加载失败时，gateway 启动 enter crash-safe：检测到 `paths.gateway.dataPath` override 与磁盘不一致 → 回滚 override + 启动用旧路径 + 在 `/api/status` 标记 `dataPathRollbackPending`。

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
      "sessionStates": 3,
      "themesCount": 0,
      "lastFlushAt": "…"
    },
    "memory": {
      "vaultPath": "/…/memory",
      "vaultExists": true,
      "memoryCount": 5
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
  // 安全存储：Web 用 localStorage（仅存未提交预览，ground truth 4.4）；原生壳用 secure enclave/kv
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
  // 外部认证 / 链接：原生壳用系统浏览器回跳；Web 直接 history
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
- `externalAuth.open` → Web 直接 `window.location` 跳转（Cloudflare Access 邮件 OTP）；`onRedirect` 用 `window` 的 `hashchange` / `popstate`
- `secureStorage` → Web 用 `localStorage`，仅限未提交预览（ground truth 4.4），不存已确认配置

### 原生壳认证路径（CORS / SSE / Cloudflare Access）

- **gateway URL**：原生壳不内置固定 URL/IP/token；首启从无 secureStorage 状态弹「配置 gateway URL」视图（用户输入 `https://vera.futureidiot.com`），保存到 secureStorage 后所有请求 APPENDED 该前缀。Web 由 `location.origin` 派生。
- **CORS**：Web 同源伺服天然无 CORS；原生壳跨域请求，gateway `/api/*` 必须 `Access-Control-Allow-Origin: *` + `Allow-Methods: GET,POST,PATCH,DELETE,OPTIONS` + `Allow-Headers: Authorization,Content-Type,Last-Event-ID` + 预检 `OPTIONS` 204。gateway 当前实现仅同源；Phase 5.5 落地时由 `src/api/http.js` 统一加 CORS 头（无 origin 白名单——单用户自部署，凭 Cloudflare Access + agent token 把门）。
- **Cloudflare Access 登录**：浏览器 / 原生壳首次访问 `https://vera.futureidiot.com/api/bootstrap` 未携带 session cookie 时，Cloudflare 边缘 302 到 Access 登录页（邮件 OTP）；浏览器自动跟跳，原生壳同样用系统 WebView 完成登录拿到 session cookie，之后 fetch 带该 cookie 持久化到原生 HTTP 客户端。**Service Token 路径**仅用于 `/api/agent/*` daemon 通道（联邦 Phase 5.5），普通客户端不持有 Service Token。
- **SSE 长连接**：原生壳必须用原生 HTTP 客户端保持长连接（不能依赖 EventSource polyfill）；认证用同一条 session cookie；断线重连带 `Last-Event-ID` 头走 `?since=` 重放规则不变。
- **回跳认证**：Cloudflare Access 登录完成回跳到 gateway 根路径，原生壳需在系统浏览器层捕获 cookie，写回原生 HTTP 客户端的 cookie jar；不支持 cookie 持久化的原生层需 fallback 到「在 App 内 WebView 完成登录，提取 CF_Auth cookie 写回 native client」。Web 不存在此问题。

### 根节点标记与 safe-area

- HTML 根节点设置 `data-platform="web|android|ios"`（由 platform adapter 根据自身 `id` 在 boot 时写入），CSS 通过 `[data-platform="…"]` 选择器做小范围平台适配，**不 fork 页面**。
- safe-area 由 CSS env 变量 `env(safe-area-inset-*)` + platform adapter 的 `keyboard.insets` 共同驱动，组件层只读 CSS 变量。
- 平台差异唯一允许的体现：安全区、键盘、返回手势、通知、文件选择、触感、外部认证/链接、本地安全存储。颜色、排版、页面职责、业务流程不分叉（ground truth 6.2）。
