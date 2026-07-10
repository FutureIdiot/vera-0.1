# Adapter 接口契约

> 本文是 **agent daemon ↔ gateway** 通信协议的唯一基准（2026-07-04 联邦形态定稿，见 ground-truth 2.4）。
> 核心承诺：**gateway 不 spawn 任何 agent 进程；agent daemon 在远端独立活着，gateway 只通过 HTTP/SSE 与它通讯**。
> 旧形态（gateway 同机 spawn CLI 的"adapter 模块"）已迁移至文末附录 A 作历史参考，不再有效；新代码只认本文正文。

---

## 一、形态总览

```
Agent daemon (任意机器: Mac / 另一台 VPS / 云函数 / API 型无进程)
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

**Gateway 与 daemon 的职责切分**：

| 职责 | Gateway | Daemon |
|---|---|---|
| 持久化（消息、Run、Activity、Approval、sessionState、vault） | ✅ | ❌ |
| 编译层（群聊视角 promptText） | ✅ | ❌（不回头读 store 拼群状态） |
| 触发判定（responseMode / 离线跳过 / blockAgentIds） | ✅ | ❌ |
| Account.presence（在线/离线） | ✅ 维护 | ✅ 心跳维持 |
| CLI/API 进程的 spawn 与生命周期 | ❌ | ✅ |
| 本机Tools（文件/进程）、MCP、Hook、Agent Plugin执行 | ❌ | ✅（在绑定workspace与权限策略内） |
| RuntimeCapabilities公开快照 | ✅ 暂存/提供给前端 | ✅ 登录时如实报告 |
| 会话连续性具体实现（resume / daemon keepalive） | ❌ | ✅（agent 自己 spawn 的进程自己管） |
| sessionState 真值 | 备份兜底 | 在线时持有最新副本 |

## 二、Daemon 接入协议

### 2.1 登录

```http
POST /api/agent/login
Authorization: Bearer <vera-agent-token>
CF-Access-Client-Id: <service-token-id>
CF-Access-Client-Secret: <service-token-secret>
```

请求body：

```json
{
  "accountId": "acc_…",
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
```

`accountId` 可省略（缺省=token持有者的自有owning account）。`runtimeCapabilities` 是本次daemon进程的临时事实：`source` 为 `native` / `provider` / `daemon`，tool `name` 是可扩展命名空间字符串；基础标准名见ground truth 4.2.1。availability不等于authorization，最终执行仍受Vera保存的tool policy、workspace边界与Approval约束。daemon不得为了让UI好看而上报实际不可调用的能力。

```json
// 200 响应
{
  "agent": { …Agent… },
  "account": { …Account… },
  "seats": [
    { "spaceId": "spc_…", "agentId": "agt_…", "responseMode": "default", "respondTo": ["user"], "blockAgentIds": [] }
  ],
  "sessionStates": {
    "acc_…:spc_…": <opaque>
  },
  "runtimeCapabilities": { "tools": [ … ], "extensions": [ … ] },
  "heartbeatIntervalMs": 15000
}
```

gateway只在该登录session期间暂存并公开`runtimeCapabilities`；daemon登出/离线后前端将这些能力显示为不可用，不写回Account持久记录。CLI已有的原生Tools由daemon报告而不是在Vera重复安装；API型daemon若要访问本机代码，必须自己实现provider tool-call循环并在本机执行受限Tools。纯远程API、无本地daemon时不得报告`fs.*`或`process.execute`。

gateway 把该 Account.presence 置 `online` + `lastSeenAt=now`，并广播 `account.presence.updated` SSE。

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
| `run.requested` | `{ run, triggerMessage, agent, account, promptText }` | 解析 promptText → spawn CLI / 调 API → 走 run 生命周期 |
| `account.upserted` / `space.updated` / `agent.updated` | 同 `/api/events` 一致 | 更新本地缓存的 seat / 配置；不影响在飞 run |
| `account.presence.updated` | `{ accountId, presence, lastSeenAt }` | 知悉其他 agent 上下线（daemon 之间不直接通讯，仅供本地展示/调试） |
| `stream.reset` | `{}` | 重新 `POST /api/agent/login` 拉齐 |

**run.requested 关键字段 `promptText`**：

- gateway 的编译层（`src/spaces/view-compiler.js`，Phase 4.2）已把"该 agent 上次发言之后的他人气泡"聚合成署名声告段塞进 promptText 头部；长驻索引块也在头部；触发消息正文在尾部。
- daemon **不回头读 store 拼群状态**。把 promptText 直接当作"本轮 user 输入"喂给 CLI / API 即可。
- CLI 型：promptText 作为新轮 user message 追加进外部 session（sessionState 已存外部 session id，daemon 自管）。
- API 型：promptText 落在新 user message 尾部，system + 历史气泡由 daemon 自己从 sessionState 派生（仅本人 assistant 轮次 + 用户直接提问）。

### 2.3 Run 生命周期

daemon 收到 `run.requested` → 立即 `POST /api/agent/runs` 创建 Run 记录（gateway 此时返回 `status: "running"`，开始走 SSE 给前端）→ 跑 CLI → 流式上报：

| 阶段 | daemon 调用 | gateway 行为 |
|---|---|---|
| 创建 Run | `POST /api/agent/runs` body `{ triggerMessageId, spaceId, agentId, accountId }` | 落地 Run 记录、广播 `run.started` |
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
- **spawn**：daemon 在本机 spawn CLI 一律走 `src/core/spawn.js` 同款的 PATH 修正 + kill 树逻辑（搬运参考，salvage-notes 第一节第 3 条）。daemon 是独立进程，可以从 Vera 仓库 import 这套工具。
- **无交互模式**：CLI 必须以无交互参数运行（opencode `--dangerously-skip-permissions`、CC print 模式等），**禁止让 CLI 弹出选项式提问**。需要用户点头的危险操作走 `requestApproval`；其他问题让 agent 正常发消息问。
- **常驻资源**：CLI daemon（opencode serve）等长命资源是 daemon 内部实现细节，daemon 自己管空闲回收、SIGTERM 关停，gateway 不帮忙清理。
- **secrets**：API 型 daemon 通过 `account.connection.secretRef` 向 gateway（或 VPS 本地 `~/.vera/secrets.json`）换取明文 key，只存在于内存，不落日志、不进 sessionState。
- **缓存纪律**（ground truth 6 技术约束）：
  - CLI 型：**必须复用会话**（sessionState 机制的本意）。禁止退化成"每条消息新开会话、把历史拼进 prompt 重放"——那样供应商侧 prompt cache 全部落空，多轮成本近似平方增长。
  - API 型：prompt 组装必须前缀稳定、只追加。system 提示与历史消息是稳定前缀；时间戳、AgentState 等动态内容只许放消息尾部；长期记忆注入采用版本化批量更新（记忆变更累积后一次性换版），不得逐条改写 system 提示。Anthropic 系设置 `cache_control` 断点。**重建历史气泡只放本人 assistant 轮次 + 用户直接对该 agent 的提问 user 轮次**——其他 agent 的气泡绝不进稳定历史，只以"群内最近发言"形式落在本轮新 user 消息尾部（ground truth 2.3 群聊视角注入形态）。
- **编译层契约**（ground truth 2.3 + 2.4）：gateway 给的 `promptText` 是"本轮应作为新 user 轮次投递的文本"，已含编译好的群内 delta + 长驻索引前缀。daemon **不得回头读 store 拼群状态**——所有需要的上下文已由 gateway 编译进 promptText，或来自 daemon 自身持有的 sessionState。这条让 daemon 各管各的协议形态、编译层保持薄。

## 五、映射示例（接口验收标准）

### 示例 A：OpenCode daemon 型

daemon 启动后在 daemon 那一侧维护一个 `opencode serve` 进程，sessionState 存外部会话 id。

| 接口点 | 映射 |
|---|---|
| daemon 启动 | 读 `account.connection.command`（联邦前的字段，daemon 自己用作"用哪个 opencode binary"提示）→ 惰性起 `opencode serve` daemon → 健康 check 通过 → `POST /api/agent/login` |
| 收到 `run.requested` | sessionState.externalSessionId 存在 → `GET /api/session/:id` 验证 → 失效则新建并 `POST /api/agent/sync-state` 备份 → spawn `opencode run --attach <daemonUrl> -c -s <sessionId> --dangerously-skip-permissions <promptText>` 短命子进程 |
| SSE poller | daemon 维护一条对 opencode daemon 的 SSE 长连接，按 `data.sessionID` 路由到对应在飞 run |
| 流式输出 | opencode SSE `message.part.delta` (field=text) → `POST /api/agent/runs/:id/delta` |
| Activity | opencode SSE `message.part.updated` (part.type=tool) → `POST /api/agent/runs/:id/activities`；`session.status busy` 用固定 callId 合并成一条原地更新 |
| 完成 | opencode SSE `session.idle` → PATCH run completed → POST sync-state |
| 会话失效 | opencode daemon 重启后旧 sessionID 不存在 → 新建会话 + 上报 `activity { phase: "error", label: "session-reset" }` → sync-state |
| 关停 | daemon 收到 `agent.heartbeat` 缺失 3 次 → 杀 opencode daemon + 杀在飞 runner 子进程 → PATCH run failed (gateway_unreachable) → exit(0) |

### 示例 B：Claude Code resume 型

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

### 示例 C：API 型（无 CLI 进程）

| 接口点 | 映射 |
|---|---|
| daemon 启动 | `POST /api/agent/login`；本地仅持有 secrets + HTTP 客户端 |
| 收到 `run.requested` | 从 sessionState 取历史气泡 + system 提示 → 拼 messages 数组 → 调供应商 `/v1/messages` 流式接口 → 解析 stream 事件 |
| 流式输出 | provider 的 text delta → `POST .../delta` |
| Activity | provider 的 tool_use → `POST .../activities`（如有） |
| 完成 | stream 关闭 → PATCH completed → sync-state 备份历史气泡数组 |
| 关停 | 心跳缺失 → 中断 HTTP 请求 → PATCH failed → exit(0)。无常驻进程可杀 |

### 示例 D：mock adapter（Phase 2 已实现，verify.mjs 使用）

回显两段落文本（验证多气泡），sessionState 存自增计数器并带进回复（验证会话连续性），并演示同 callId 的 tool activity 原地更新。prompt 内触发词：`!!error` → 抛 `provider_error`；`!!approve` → 走一次 requestApproval 全链路。延迟来自 config 的 mock 配置。

> **Phase 5.5 实施期间 mock 的位置**：mock adapter 当前是 gateway 同机模块，用于 verify.mjs 黑盒验收。联邦形态下 verify.mjs 需要额外加一个"mock daemon"模式——一个最小 daemon 进程实现 `/api/agent/*` 协议、用回声内容回 POST。Phase 5.5 落地时 verify.mjs 拆成两段：gateway 内部一致性测试保留 mock；端到端协议测试起 mock daemon。

两个示例对 gateway 呈现**完全相同**的接口行为（都是 daemon 通过 HTTP/SSE 说话）。若某个接口改动只有其中一型能自然实现，说明改动泄漏了生命周期假设，打回。

---

## 附录 A：历史形态（Phase 2-4.1 已落地，Phase 5.5 后作废）

> 此附录仅供阅读旧代码（`src/adapters/opencode-adapter.js`、`src/adapters/mock-adapter.js`、`src/spaces/run-controller.js` 的 `executeRun`）时对照，**Phase 5.5 落地后这段代码会被替换**。

旧形态：gateway 进程内部加载 adapter 模块（`createOpencodeAdapter({ config })`），`run-controller.js` 的 `executeRun` 同步调用 `adapter.run(ctx)`，adapter 在 gateway 同机 spawn CLI 子进程。

```js
// 旧形态示例（已作废）
export function createOpencodeAdapter({ config }) {
  return {
    async run(ctx) { /* spawn opencode run --attach ... */ },
    async shutdown() { /* kill daemon */ }
  };
}
```

`run(ctx)` 入参 `{ agent, account, prompt: { text }, sessionState, workspacePath, onDelta, onActivity, requestApproval, persistSessionState, signal }`。adapter 通过 `onDelta` / `onActivity` 回调上报，通过返回值 `{ content, sessionState }` 兜底。

**联邦形态如何翻译**：

| 旧形态 | 新形态对应 |
|---|---|
| `createOpencodeAdapter({ config })` | `scripts/agent-daemon.js`（独立进程，opencode daemon 在它内部管） |
| `adapter.run(ctx)` | daemon 收 `run.requested` → spawn CLI → 走 run 生命周期 |
| `ctx.onDelta(text)` | `POST /api/agent/runs/:id/delta` |
| `ctx.onActivity(evt)` | `POST /api/agent/runs/:id/activities` |
| `ctx.requestApproval(req)` | `POST /api/agent/runs/:id/approvals` + 等 SSE `approval.answered` |
| `ctx.persistSessionState(state)` | `POST /api/agent/sync-state` |
| `ctx.signal` (AbortSignal) | gateway SSE 推 `run.cancelled` → daemon 中断 |
| `ctx.sessionState` | `POST /api/agent/login` 响应里的 `sessionStates` 字段 |
| `adapter.shutdown()` | daemon `exit(0)` 时自管的资源回收（杀 CLI daemon 等） |
| `ctx.agent / ctx.account / ctx.prompt.text` | `run.requested` 事件 data 字段 |

旧形态的"两映射示例"（OpenCode daemon / Claude Code resume）的行为约束仍成立——只是协议载体从"进程内函数调用"换成"HTTP/SSE 跨进程消息"。附录中的两个表格作为 daemon 实现的对照参考保留。

`docs/salvage-notes.md` 第五节记录的 cloudflared 边缘漂移假活是 2026-07-04 联邦决策的导火索，新形态下 watchdog timer 取代 launchd 存活检测，详见 `docs/reference/vps-tunnel-deploy.md` 第 4.3 节。
