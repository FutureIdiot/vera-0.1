# Adapter 接口契约

> adapter 层唯一基准。核心承诺只有一句：**adapter 自己负责会话连续性，gateway 不知道也不关心会话长什么样。**
> 本文档末尾的两个映射示例（OpenCode daemon 型 / Claude Code resume 型）是接口设计的验收标准：任何接口改动必须同时在两个示例下自洽。

---

## 一、接口形状

每个 adapter 是 `src/adapters/` 下的一个模块，导出工厂函数：

```js
export function createOpencodeAdapter() {
  return {
    // 一次 run：把 prompt 交给该会话，流式返回回复
    async run(ctx) { … },
    // gateway 退出时调用；释放 daemon、子进程等常驻资源。没有则可省略
    async shutdown() { … }
  };
}
```

### `run(ctx)` 入参

```js
{
  agent,          // Agent 对象（api-contract.md 形状），含 connection/model
  prompt: {
    text,         // 本次投递的消息文本（已由 gateway 按 Space 上下文编译）
  },
  sessionState,   // ★ 不透明 JSON 或 null。上次 run 返回的值，gateway 原样持久化并奉还
  workspacePath,  // 本次 run 的工作目录（进程型 adapter 用作 cwd）
  onDelta(text),      // 回复正文的流式增量
  onActivity(evt),    // 过程事件：{ phase, label, detail, toolStatus?, callId? }
                      // 带相同 callId 的多次调用由 gateway 合并为同一条
                      // Activity 原地更新（工具 pending→running→completed）
  requestApproval(req), // -> Promise<answer>。阻塞式提权申请：gateway 生成
                      // Approval 卡片入时间线，resolve 用户的答复；run 结束
                      // 前未答复则 resolve "deny" 并标记 expired
  signal          // AbortSignal，取消信号
}
```

### `run()` 返回

```js
{
  content,        // 回复全文（权威值；gateway 用它定稿 message）
  sessionState    // ★ 新的会话状态，gateway 原样存储，下次 run 传回
}
```

### `sessionState` —— 接口的核心机制

- 对 gateway **完全不透明**：一个可 JSON 序列化的对象，per (agent, Space) 持久化。gateway 只做存取，**禁止读取其内部字段做任何逻辑**。
- 会话形态差异全部被它吸收：
  - daemon 型（OpenCode）：存外部会话 id，会话活在常驻服务里；
  - resume 型（Claude Code / Codex）：存 resume id，进程一次一命，靠 id 复活上下文。
- Space 重置会话（`/new` 类操作）= gateway 把该 (agent, Space) 的 sessionState 清空，仅此而已。
- adapter 必须容忍 sessionState 指向的外部会话已失效（daemon 重启、resume id 过期）：**新建会话继续跑，并通过 `onActivity({ phase: "error", label: "session-reset", … })` 上报降级**，不得静默假装连续，也不得直接失败。这是 plan.md Phase 2 完成标准第 3 条的实现位。

## 二、错误契约

抛出带 `code` 的 `AdapterError`（`src/core/` 提供）：

| code | 语义 | gateway 行为 |
|---|---|---|
| `cancelled` | signal 触发后中止 | run → `cancelled` |
| `timed_out` | adapter 自管的看门狗到期 | run → `failed` |
| `unavailable` | 二进制缺失 / daemon 起不来 / key 无效 | run → `failed`，HTTP 层映射 `adapter_unavailable` |
| `provider_error` | 供应商侧报错（限流、模型不存在…） | run → `failed` |

任何其他异常按 `internal` 处理。**错误必须抛出，不得吞掉后返回空 content。**

## 三、行为规则

- **取消**：监听 `signal`，SIGTERM 子进程 / 中断请求，收尾后抛 `cancelled`。abort listener 必须正确移除（旧 repo 在这里有 bug，见 salvage-notes 第四节）。
- **超时**：adapter 自带看门狗（默认 30 分钟，配置项 per-provider），gateway 不设外层超时。
- **隔离**：adapter 不得读写 store、不得直接发 SSE、不得读其他 agent 的任何数据。与外界的全部通道就是 ctx 的回调和返回值。
- **spawn**：一律走 `src/core/` 的 spawn 封装（内含 launchd PATH 修正与 kill 树逻辑），禁止直接 `child_process.spawn`。
- **无交互模式**：CLI 必须以无交互参数运行（opencode `--dangerously-skip-permissions`、CC print 模式等），**禁止让 CLI 弹出选项式提问**。需要用户点头的危险操作走 `requestApproval`；其他问题让 agent 正常发消息问。Phase 2 的 OpenCode 先全跳过审批（skip-permissions），`requestApproval` 的真实桥接随 CC adapter 在 Phase 6 落地——但接口现在就在，adapter 不得自造第二种问询通道。
- **常驻资源**：daemon 等长命资源是 adapter 内部实现细节，但必须实现 `shutdown()` 且自带空闲回收，不得依赖 gateway 帮忙清理。
- **secrets**：api 型 adapter 通过 `agent.connection.secretRef` 向 `src/core/` 的 secrets 读取器换取明文，只存在于内存，不落日志、不进 sessionState。
- **缓存纪律**（ground truth 技术约束）：
  - CLI 型：**必须复用会话**（sessionState 机制的本意）。禁止退化成"每条消息新开会话、把历史拼进 prompt 重放"——那样供应商侧 prompt cache 全部落空，多轮成本近似平方增长。
  - API 型：prompt 组装必须前缀稳定、只追加。system 提示与历史消息是稳定前缀；时间戳、AgentState 等动态内容只许放消息尾部；长期记忆注入采用版本化批量更新（记忆变更累积后一次性换版），不得逐条改写 system 提示。Anthropic 系设置 `cache_control` 断点。

## 四、映射示例（接口验收标准）

### 示例 A：OpenCode —— daemon 型

会话活在常驻 `opencode serve` 里（协议细节见 salvage-notes.md）。

| 接口点 | 映射 |
|---|---|
| `sessionState` | `{ "externalSessionId": "ses_xxx" }` |
| 首次 run | 惰性起 daemon → `POST /api/session` 建会话 → **先通过返回值持久化 id 再跑**（防崩溃重建）|
| 每次 run | spawn `opencode run --attach <daemonUrl> -c -s <externalSessionId> …` 短命子进程 |
| `onDelta` | daemon SSE 的 `message.part.delta`（`field:"text"`）转发 |
| `onActivity` | `message.part.updated`（tool 部件）→ `phase:"tool"`；`session.status busy` → `phase:"working"` |
| 完成 | SSE `session.idle`；content 优先取 delta 累积值，子进程 stdout 兜底 |
| 会话失效 | daemon 重启后旧 sessionID 不存在 → 新建会话 + 上报 `session-reset` |
| `shutdown()` | SIGTERM daemon，5s 后 SIGKILL |

### 示例 B：Claude Code —— resume 型（Phase 6 实现，接口现在就要容得下）

会话不常驻：每条消息一个 `claude -p` 进程，靠 `--resume` 复活上下文。

| 接口点 | 映射 |
|---|---|
| `sessionState` | `{ "resumeSessionId": "…" }` |
| 首次 run | `claude -p --output-format stream-json <prompt>`，从输出流中捕获 session id 存入 sessionState |
| 后续 run | `claude -p --resume <resumeSessionId> --output-format stream-json <prompt>` |
| `onDelta` | stream-json 的 assistant 文本增量事件 |
| `onActivity` | stream-json 的 tool_use / tool_result 事件 → `phase:"tool"` |
| 完成 | 进程正常退出；content 取结果事件全文 |
| 会话失效 | resume 报错（id 过期/被清理）→ 去掉 `--resume` 重跑 + 上报 `session-reset` |
| `shutdown()` | 无常驻资源，省略 |

两个示例对 gateway 呈现**完全相同**的接口行为。若某个接口改动只有其中一型能自然实现，说明改动泄漏了生命周期假设，打回。

### 示例 C：mock adapter（Phase 2 一并实现）

回显固定文本、可注入延迟与错误，供 gateway 与前端在无真实 CLI 时测试。`sessionState` 存一个自增计数器，用于测试会话连续性语义。
