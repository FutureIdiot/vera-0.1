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

## 二、数据形状

### Agent（ground truth 2.2）

```json
{
  "id": "agt_x1y2",
  "name": "Iota",
  "kind": "cli",
  "provider": "opencode",
  "connection": {
    "command": "/Users/theta/.opencode/bin/opencode",
    "args": [],
    "secretRef": null
  },
  "model": "zai/glm-5.2",
  "createdAt": "…",
  "updatedAt": "…"
}
```

- 身份 = `name`，永久绑定记忆与历史。`kind` / `provider` / `connection` / `model` 均可改而不影响身份。
- `model` 为空串 = 使用该供应商自己的默认模型（CLI 型 adapter 不传 `-m` 类参数）。
- `kind: "cli"` 时 `connection.command/args` 有效；`kind: "api"` 时 `connection.secretRef` 有效。

### Space

```json
{
  "id": "spc_a1b2",
  "name": "vera-dev",
  "topic": "Vera 0.0.1 开发",
  "seats": [
    { "agentId": "agt_x1y2", "responseMode": "default" }
  ],
  "createdAt": "…"
}
```

`responseMode`（per-agent per-Space，ground truth 2.3）：`default`（都响应）/ `silent`（只响应指定来源的 @）/ `focused`（只响应 @自己）。定向 @ 到的 agent 一律响应，不受 responseMode 影响；`silent` 的来源过滤字段 `respondTo: ["user", "agt_..."]` 挂在 seat 上，`[P4]`（落地前 silent 对定向 @ 等价 focused）。

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

### AgentState（全局可见层，ground truth 3.3）

```json
{
  "agentId": "agt_x1y2",
  "status": "idle",
  "currentSpaceId": "spc_a1b2",
  "lastActiveAt": "…"
}
```

`status`：`idle` / `working`。AgentState 是**运行时派生状态**（由 run 生命周期驱动），不持久化；gateway 重启后归 `idle`。

## 三、HTTP Endpoints

### 系统

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/health` | `{ "app": "vera", "ok": true }` |
| GET | `/api/bootstrap` | 一次拉齐前端启动所需：agents + spaces + agentStates + 当前 SSE `seq` 水位 |
| GET | `/`（及其他非 `/api/` 路径） | 静态前端：回退伺服 `frontend/` 目录（无构建步骤，`/` 映射 index.html，带路径穿越防护） |

### Agent

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/agents` | 列表 |
| POST | `/api/agents` | 创建。body 为 Agent 形状去掉 id/时间戳 |
| PATCH | `/api/agents/:id` | 部分更新（换模型/供应商/连接不换身份） |
| DELETE | `/api/agents/:id` | 删除（记忆与历史的处置 `[P5]` 再定，Phase 2–4 直接拒绝删除有历史的 agent） |

### Space

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/spaces` | 列表 |
| POST | `/api/spaces` | 创建 |
| PATCH | `/api/spaces/:id` | 更新 name/topic/seats（席位增删、responseMode 调整） |
| GET | `/api/spaces/:id/timeline?before=<itemId>&limit=50` | 时间线历史，倒序分页。返回 `{ "items": [...] }`，成员为 Message / Activity / Approval 三种，各带 `"itemType"` 字段区分，按时间排序 |
| POST | `/api/spaces/:id/messages` | 发消息（见下） |

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
| GET | `/api/agent-states` | 全部 agent 的状态 |

### 配置 `[P4]` / Memory `[P5]`

- `GET/PATCH /api/settings`：数据隔离规则、记忆整理配置等（ground truth 4.1），字段随 Phase 4 契约增补。
- `/api/memory/*`：Phase 5 前冻结，形状届时先补本文档。

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
| `agent.state.updated` | `{ agentState }` | |
| `space.updated` / `agent.updated` | `{ space }` / `{ agent }` | 配置变更广播 `[P4]` |
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
