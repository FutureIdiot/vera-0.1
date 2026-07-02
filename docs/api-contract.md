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

`responseMode`（per-agent per-Space，ground truth 2.3）：`default`（都响应）/ `silent`（只响应指定来源的 @）/ `focused`（只响应 @自己）。`silent` 的来源过滤字段 `respondTo: ["user", "agt_..."]` 挂在 seat 上，`[P4]`。

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
- agent 回复的消息在 run 开始时即创建（`status: "streaming"`，content 随 delta 增长），run 结束转 `completed` / `failed`。
- `runId`：agent 消息关联其产生 run；用户消息为 null。

### Run

一次 agent 响应的执行记录。

```json
{
  "id": "run_r1s2",
  "agentId": "agt_x1y2",
  "spaceId": "spc_a1b2",
  "triggerMessageId": "msg_m1n2",
  "replyMessageId": "msg_p3q4",
  "status": "running",
  "createdAt": "…",
  "endedAt": null
}
```

`status`：`running` / `completed` / `failed` / `cancelled`。

### AgentState（全局可见层，ground truth 3.3）

```json
{
  "agentId": "agt_x1y2",
  "status": "idle",
  "currentSpaceId": "spc_a1b2",
  "lastActiveAt": "…"
}
```

`status`：`idle` / `working`。

## 三、HTTP Endpoints

### 系统

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/health` | `{ "app": "vera", "ok": true }` |
| GET | `/api/bootstrap` | 一次拉齐前端启动所需：agents + spaces + agentStates + 当前 SSE `seq` 水位 |

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
| GET | `/api/spaces/:id/messages?before=<msgId>&limit=50` | 历史消息，倒序分页 |
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
| `message.created` | `{ message }` | 新消息记录（用户消息即时；agent 回复在 run 开始时以空 content 创建） |
| `message.delta` | `{ messageId, spaceId, delta }` | agent 回复的流式增量，客户端追加渲染 |
| `message.completed` | `{ message }` | 回复定稿，content 为权威全文（客户端以此覆盖累积值） |
| `run.started` | `{ run }` | |
| `run.ended` | `{ run }` | status 为 completed/failed/cancelled；failed 时带 `error.code/message` |
| `agent.activity` | `{ runId, agentId, spaceId, phase, label, detail, toolStatus? }` | 非回复类过程事件。`phase`：`routing` / `working` / `thinking` / `tool` / `usage` / `error` |
| `agent.state.updated` | `{ agentState }` | |
| `space.updated` / `agent.updated` | `{ space }` / `{ agent }` | 配置变更广播 `[P4]` |
| `stream.reset` | `{}` | 客户端必须重新 bootstrap |

### 客户端义务

- 以 `message.completed` 的全文为准，delta 累积仅用于渲染中间态。
- 收到未知 `type` 必须静默忽略（向前兼容）。
- 断连后指数退避重连，携带 `since`。

## 五、与隧道的兼容性约束

- SSE 响应必须逐帧 flush，不得依赖缓冲（Cloudflare 隧道 `disableChunkedEncoding: false`、nginx `proxy_buffering off`，见 `reference/vps-tunnel-deploy.md`）。
- gateway 每 25s 发 SSE 注释帧 `: ping` 保活，防止中间层超时断连。
