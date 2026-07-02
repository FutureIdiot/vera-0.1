# Vera Memory Hook 搭建方案

> **整合注记（2026-07-02，Phase 5 动工前生效）**：本文档成文早于接口契约，落地时按下列映射对齐，正文暂不改写——
> 1. 术语：`room_id` → `spaceId`（Space，见 api-contract.md 命名纪律）；`session_id` 语义由 run / sessionState 承载，Phase 5 统一。
> 2. API 路径：`/memory/*` 落地为 `/api/memory/*`，形状收编进 api-contract.md 后以契约为准。
> 3. 存储：第 8 节 SQL schema 是逻辑模型；实际引擎（JSON store 是否够用、embedding 存哪）Phase 5 开工时定。
> 4. 缓存纪律（ground truth 技术约束）：记忆注入段必须放 prompt **尾部**（靠近当前消息），不得插入稳定前缀——检索结果逐条消息变化，放前面会打穿 prompt cache。

## 0. 核心原则

Vera 的记忆系统不把用户压缩成人设标签，也不把一次对话里的局部状态扩写成长期画像。

记忆系统只做三件事：

1. 保存可复用的项目事实、约束、偏好、纠错和上下文。
2. 在合适的时候把必要记忆注入给 agent，减少重复错误和上下文丢失。
3. 在前端记忆库中展示记忆内容及其颜色痕迹，方便用户审阅和编辑。

颜色字段只作为记忆 chunk 的元数据和前端显示元素存在。颜色不进入普通回复 prompt，不要求 agent 解释，不作为标签、强度、置信度、重要性或过期规则使用。

---

## 1. Memory 架构分层

Vera memory 分为四层：

### 1.1 Raw Event Layer

保存原始事件或对话片段，用于溯源。

来源包括：

- 用户消息
- agent 回复
- 工具调用结果
- 代码修改记录
- 用户纠正
- 系统状态变化
- 项目配置变化

这一层尽量少加工。

示例：

```json
{
  "event_id": "evt_20260622_001",
  "room_id": "vera_main",
  "session_id": "session_memory_design",
  "speaker": "user",
  "content": "颜色只存在两个地方，1是元数据，2是前端记忆库显示给我看，此外不在任何地方提起，也不要agent做解释。",
  "created_at": "2026-06-22T12:00:00Z"
}
```

---

### 1.2 Memory Chunk Layer

从 Raw Event 中提炼出的可复用记忆。

每条 chunk 是 Vera 真正用于检索、维护和展示的基本单位。

```json
{
  "id": "mem_001",
  "type": "interaction_rule",
  "scope": "global",
  "text": "颜色字段只作为记忆元数据和前端显示元素存在。普通回复和普通记忆调取不得向 agent 注入颜色字段，也不得要求 agent 解释颜色。",
  "source_event_ids": ["evt_20260622_001"],
  "created_by": "vera_memory_hook",
  "updated_by": "vera_memory_hook",
  "created_at": "2026-06-22T12:00:00Z",
  "updated_at": "2026-06-22T12:00:00Z",
  "status": "active",
  "agent_stains": {
    "vera": "#7A8FA6"
  }
}
```

其中 `agent_stains` 是颜色字段。

颜色字段规则：

```json
{
  "agent_stains": {
    "agent_id": "#RRGGBB"
  }
}
```

只存 hex color。不要额外存：

- color_meaning
- reason
- strength
- mood
- confidence
- importance
- priority
- decay
- emotional_label

---

### 1.3 Index Layer

用于检索，不直接给 agent 看。

建议至少维护这些索引：

```json
{
  "memory_id": "mem_001",
  "embedding": [0.01, 0.24, "..."],
  "keywords": ["颜色", "stain", "metadata", "frontend", "memory hook"],
  "type": "interaction_rule",
  "scope": "global",
  "room_id": "vera_main",
  "session_id": "session_memory_design",
  "status": "active",
  "created_at": "2026-06-22T12:00:00Z",
  "updated_at": "2026-06-22T12:00:00Z"
}
```

注意：`agent_stains` 不进入检索排序规则。颜色只保存在 Memory Chunk Layer 和前端显示中。

---

### 1.4 Injection Layer

真正注入 agent prompt 的记忆片段。

这一层必须经过清洗。

允许注入：

```json
{
  "id": "mem_001",
  "type": "interaction_rule",
  "text": "颜色字段只作为记忆元数据和前端显示元素存在。普通回复和普通记忆调取不得向 agent 注入颜色字段，也不得要求 agent 解释颜色。",
  "source": "user_confirmed"
}
```

禁止注入：

```json
{
  "agent_stains": {
    "vera": "#7A8FA6"
  }
}
```

普通回复阶段，agent 不应该知道被调取的记忆是什么颜色。

---

## 2. Hook 总览

Vera memory 使用四个 hook：

1. `memory_write_hook`
2. `memory_retrieve_hook`
3. `memory_injection_hook`
4. `memory_maintenance_hook`

其中：

- write hook 负责从新对话中生成或更新记忆。
- retrieve hook 负责从记忆库中查找相关 chunk。
- injection hook 负责清洗和压缩检索结果，注入 agent。
- maintenance hook 负责合并、修正、归档、重染。

颜色只出现在 write hook 和 maintenance hook 的 schema 中，以及前端 UI 读取的完整 memory chunk 中。

---

## 3. Memory Write Hook

### 3.1 触发时机

write hook 由 context 容量触发，不在每轮对话后运行。

当 context 容量达到阈值时，自动将本次 session 的 raw events 送入 write hook。

输入只包含 speaker 为 user 和 assistant 的部分，文档、代码块、工具调用结果等排除在外，避免噪声写入。

dream subagent 在 session 结束后异步做集中写入，是 write hook 的兜底机制。

不建议写入的情况：

1. 普通闲聊。
2. 短期情绪波动。
3. 没有复用价值的临时表达。
4. agent 自己的发挥、比喻、称呼、猜测。
5. 无来源依据的用户画像。

---

### 3.2 Write Hook 输入

```json
{
  "agent_id": "vera",
  "room_id": "vera_main",
  "session_id": "session_memory_design",
  "recent_events": [
    {
      "event_id": "evt_001",
      "speaker": "user",
      "content": "颜色只存在两个地方，1是元数据，2是前端记忆库显示给我看，此外不在任何地方提起，也不要agent做解释。"
    },
    {
      "event_id": "evt_002",
      "speaker": "assistant",
      "content": "可以，而且这是目前最干净的版本。"
    }
  ],
  "existing_related_memories": [
    {
      "id": "mem_old_001",
      "text": "颜色字段可以由 agent 在记忆写入时设置。",
      "agent_stains": {
        "vera": "#8A7CCF"
      }
    }
  ]
}
```

write hook 可以看到旧颜色，因为它需要决定是否保留或覆盖。但普通回复 agent 不看颜色。

---

### 3.3 Write Hook 输出

```json
{
  "new_memories": [
    {
      "type": "interaction_rule",
      "scope": "global",
      "text": "颜色字段只存在于记忆 chunk 元数据和前端记忆库显示中。普通回复和普通记忆调取不得注入颜色，也不得要求 agent 解释颜色。",
      "source_event_ids": ["evt_001"],
      "agent_stains": {
        "vera": "#7A8FA6"
      }
    }
  ],
  "updates": [
    {
      "id": "mem_old_001",
      "text": "颜色字段可以由 agent 在记忆写入或维护阶段设置或覆盖，但不得进入普通回复 prompt。",
      "source_event_ids_append": ["evt_001"],
      "agent_stains": {
        "vera": "#7A8FA6"
      }
    }
  ],
  "archive": []
}
```

---

### 3.4 Write Hook Prompt

这段 prompt 只给 memory write hook 使用，不放进普通对话 prompt。

```
You are Vera's memory write hook.

Read the recent events and decide whether any memory chunks should be created or updated.

Return JSON only.

Memory chunk schema:
- type: one of ["project_rule", "architecture", "ui_rule", "workflow", "interaction_rule", "preference", "correction", "bug", "decision", "open_question"]
- scope: one of ["global", "project", "room", "session", "agent"]
- text: string
- source_event_ids: string[]
- agent_stains: optional object mapping agent_id to hex color string

Rules:
- Save only reusable information.
- Do not create personality labels from one-off events.
- Do not treat assistant-created metaphors, names, or motifs as user preferences.
- When the user corrects an agent, preserve the correction mechanism, not a broad user trait.
- You may set or update `agent_stains`.
- Do not add fields outside the schema.
- Do not explain `agent_stains`.
```

---

## 4. Memory Retrieve Hook

### 4.1 目标

retrieve hook 负责找出"可能对当前任务有用"的记忆。

它不负责生成回复，也不负责解释记忆。

输入当前上下文，输出候选 memory ids。

---

### 4.2 Retrieve Hook 输入

```json
{
  "agent_id": "codex",
  "room_id": "vera_main",
  "session_id": "session_console_ui",
  "current_user_message": "Console 页不要 last error，错误一律右上角悬浮通知。",
  "current_task": "update_ui_design",
  "active_project": "vera",
  "recent_context_summary": "用户正在调整 Vera Console 页设计。",
  "retrieval_limits": {
    "max_candidates": 20,
    "max_injected": 10
  }
}
```

---

### 4.3 检索策略

记忆池是一张按权重×关联度降序排列的表。检索结果按标签聚合成若干方向，每个方向独立展开。

展开规则：

- 关联度×权重高于阈值：多放几条
- 关联度×权重低于阈值：少放几条
- 每次默认从全量记忆池随机抽取至少一条，防止高权重记忆永远遮蔽边缘条目

默认注入上限为 **10 条**，其中至少 **1 条为随机**。

检索顺序：

```
当前消息
→ 提取 query
→ 按 project / room / session / agent scope 过滤
→ embedding 召回
→ keyword 召回
→ 合并去重
→ 排除 archived / deprecated
→ 按标签聚合方向
→ 每方向按权重×关联度排序截断
→ 补入随机条目
→ 输出候选 memory ids
```

颜色不参与任何一步。

---

### 4.4 Agent 主动扩展记忆

agent 在回复阶段可以主动扩展记忆池，有两个方向：

**广度扩展**——在某个方向上增加条目数量：

```
memory.fetch_more(direction, offset)
```

**深度扩展**——从摘要钻取到原文：

```
memory.fetch_detail(memory_id)
```

这两个接口在系统 prompt 或 tool description 中告知 agent，由 agent 自行判断是否调用。记忆池本身就是排好序的表，fetch_more 只是往后读几行，不需要额外 hook。

---

### 4.5 Retrieve Hook 输出

```json
{
  "candidates": [
    {
      "id": "mem_console_001",
      "score": 0.92,
      "match_reason": "console ui rule"
    }
  ]
}
```

`match_reason` 仅内部日志使用，不注入普通 agent prompt。

---

## 5. Memory Injection Hook

### 5.1 目标

injection hook 负责把 retrieve hook 找到的 memory chunk 转换成普通 agent 可以安全使用的上下文。

这一层必须剥离颜色。

---

### 5.2 Injection 输入

```json
{
  "agent_id": "codex",
  "candidate_memories": [
    {
      "id": "mem_console_001",
      "type": "ui_rule",
      "scope": "project",
      "text": "Console 页上半部分展示 server 状态方块，下半部分展示终端样式 log。",
      "agent_stains": {
        "vera": "#7A8FA6",
        "codex": "#A66B5B"
      },
      "source_event_ids": ["evt_100"]
    },
    {
      "id": "mem_error_toast_001",
      "type": "ui_rule",
      "scope": "project",
      "text": "系统 error 不常驻展示。没有 error 时不出现 last error 区域；有 error 时使用右上角悬浮通知方框，可以向下叠放。",
      "agent_stains": {
        "vera": "#6E7B8B"
      },
      "source_event_ids": ["evt_101"]
    }
  ],
  "max_tokens": 800
}
```

---

### 5.3 Injection 输出

```json
{
  "memory_context": [
    {
      "id": "mem_console_001",
      "type": "ui_rule",
      "text": "Console 页上半部分展示 server 状态方块，下半部分展示终端样式 log。"
    },
    {
      "id": "mem_error_toast_001",
      "type": "ui_rule",
      "text": "系统 error 不常驻展示。没有 error 时不出现 last error 区域；有 error 时使用右上角悬浮通知方框，可以向下叠放。"
    }
  ]
}
```

注意：这里没有 `agent_stains`。

---

### 5.4 注入格式

给普通 agent 的 prompt：

```
Relevant Vera memories:

1. [ui_rule] Console 页上半部分展示 server 状态方块，下半部分展示终端样式 log。
2. [ui_rule] 系统 error 不常驻展示。没有 error 时不出现 last error 区域；有 error 时使用右上角悬浮通知方框，可以向下叠放。

Use these only when relevant to the current task.

If you need more memories in a specific direction, call memory.fetch_more(direction, offset).
If you need the full detail of a specific memory, call memory.fetch_detail(memory_id).
```

不要写：

```
This memory has color #7A8FA6.
This color indicates caution.
The agent previously stained this memory blue.
```

---

## 6. Memory Maintenance Hook（Dream）

### 6.1 目标

dream 是独立的 memory maintenance subagent，不参与普通聊天，不接入 Vera 的 channel 系统。

它是批处理任务：异步启动，只读写记忆数据库，不发消息，不占用主流程 context。

dream 可以做：

1. 合并重复记忆
2. 修正旧记忆
3. 归档过时记忆
4. 保留来源
5. 重写过长 chunk
6. 重染 agent_stains
7. 标记冲突记忆
8. 删除错误推断

---

### 6.2 触发时机

建议：

1. session 结束后异步启动（同时作为 write hook 的兜底）
2. 用户手动点击"整理记忆"
3. 项目阶段完成时
4. 某条记忆被用户编辑后
5. 检索命中冲突时
6. 每周或每 N 次对话做低频维护

不要每轮对话都跑完整 dream，太贵。

---

### 6.3 Maintenance 输入

```json
{
  "agent_id": "vera",
  "memory_ids": ["mem_001", "mem_002", "mem_003"],
  "memories": [
    {
      "id": "mem_001",
      "text": "颜色字段可以由 agent 在记忆写入时设置。",
      "agent_stains": {
        "vera": "#8A7CCF"
      },
      "source_event_ids": ["evt_001"]
    },
    {
      "id": "mem_002",
      "text": "颜色字段只存在于元数据和前端显示中，不进入普通回复 prompt。",
      "agent_stains": {
        "vera": "#7A8FA6"
      },
      "source_event_ids": ["evt_002"]
    }
  ],
  "recent_events": [
    {
      "event_id": "evt_003",
      "speaker": "user",
      "content": "没必要跟agent强调颜色的性质吧，我还是觉得保持不解释"
    }
  ]
}
```

---

### 6.4 Maintenance 输出

```json
{
  "merge": [
    {
      "target_id": "mem_002",
      "merged_from": ["mem_001"],
      "text": "颜色字段只存在于记忆 chunk 元数据和前端显示中。agent 只在记忆写入或维护阶段通过 schema 设置或覆盖颜色；普通回复和普通记忆注入不得包含颜色字段。",
      "source_event_ids_append": ["evt_001", "evt_003"],
      "agent_stains": {
        "vera": "#7A8FA6"
      }
    }
  ],
  "archive": ["mem_001"],
  "delete": [],
  "keep": []
}
```

---

### 6.5 Maintenance Prompt

```
You are Vera's memory maintenance hook.

Given existing memory chunks and recent events, return JSON operations only.

Allowed operations:
- keep
- update
- merge
- archive
- delete

Memory chunk schema:
- id
- type
- scope
- text
- source_event_ids
- status
- agent_stains

Rules:
- Preserve source_event_ids.
- Merge duplicated memories.
- Archive outdated memories instead of deleting them unless they are clearly wrong.
- Delete memories that are unsupported guesses or assistant-created motifs mistaken as user preferences.
- Keep memory text concrete and reusable.
- You may set or update `agent_stains`.
- Do not add fields outside the schema.
- Do not explain `agent_stains`.
```

---

## 7. 前端记忆库设计

### 7.1 显示内容

前端记忆卡片显示：

- 记忆正文
- 类型
- scope
- 来源入口
- created_at
- updated_at
- status
- agent stain 色块

示例 UI：

```
┌─────────────────────────────┐
│  ■  interaction_rule         │
│                             │
│  颜色字段只存在于记忆 chunk   │
│  元数据和前端显示中……        │
│                             │
│  source: evt_001            │
│  updated: 2026-06-22        │
└─────────────────────────────┘
```

色块可以显示在卡片左上角、边框、底部细条或背景轻微 tint。

不要在 UI 上自动显示：

```
这个颜色代表……
```

但可以允许用户看到：

```
agent: vera
stain: #7A8FA6
```

---

### 7.2 用户操作

前端建议提供：

1. 手动编辑记忆正文
2. 手动改颜色
3. 手动归档
4. 手动删除
5. 查看来源
6. 合并重复记忆
7. 按 agent 查看颜色
8. 按 type / scope / project 过滤
9. 搜索记忆正文

用户手动改色时，只更新对应 agent 或 user 的 stain：

```json
{
  "agent_stains": {
    "user": "#D6A56D"
  }
}
```

可以保留 user stain，与 agent stain 并列。

---

## 8. 推荐数据库 Schema

### 8.1 memories table

```sql
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  scope TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  room_id TEXT,
  session_id TEXT,
  project_id TEXT,
  created_by TEXT,
  updated_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

---

### 8.2 memory_sources table

```sql
CREATE TABLE memory_sources (
  memory_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  PRIMARY KEY (memory_id, event_id)
);
```

---

### 8.3 memory_stains table

```sql
CREATE TABLE memory_stains (
  memory_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  stain TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (memory_id, owner_id)
);
```

`owner_id` 可以是：

- vera
- codex
- claude
- gemma
- user

---

### 8.4 memory_embeddings table

```sql
CREATE TABLE memory_embeddings (
  memory_id TEXT PRIMARY KEY,
  embedding BLOB NOT NULL,
  model TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

---

### 8.5 memory_events table

```sql
CREATE TABLE memory_events (
  event_id TEXT PRIMARY KEY,
  room_id TEXT,
  session_id TEXT,
  speaker TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

---

### 8.6 memory_relations table

```sql
CREATE TABLE memory_relations (
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  relation_score REAL NOT NULL DEFAULT 1.0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (from_id, to_id)
);
```

`direction` 对应标签聚合的方向（如 project、agent、topic 等）。

`relation_score` 用于 fetch_more 时在方向内排序。

关联展开深度固定为一跳，不递归。

---

## 9. API 设计

### 9.1 写入记忆

```
POST /memory/write
```

输入：

```json
{
  "agent_id": "vera",
  "room_id": "vera_main",
  "session_id": "session_memory_design",
  "events": ["evt_001", "evt_002"]
}
```

输出：

```json
{
  "created": ["mem_001"],
  "updated": ["mem_002"],
  "archived": []
}
```

---

### 9.2 检索记忆

```
POST /memory/retrieve
```

输入：

```json
{
  "agent_id": "codex",
  "room_id": "vera_main",
  "session_id": "session_console_ui",
  "query": "Console 页错误提示怎么展示？",
  "limit": 10
}
```

输出：

```json
{
  "memories": [
    {
      "id": "mem_error_toast_001",
      "type": "ui_rule",
      "text": "系统 error 不常驻展示。没有 error 时不出现 last error 区域；有 error 时使用右上角悬浮通知方框，可以向下叠放。"
    }
  ]
}
```

注意：retrieve API 给 agent 用时默认不返回 stain。

---

### 9.3 广度扩展

```
POST /memory/fetch_more
```

输入：

```json
{
  "agent_id": "codex",
  "direction": "console_ui",
  "offset": 10,
  "limit": 5
}
```

输出同 retrieve，不含 stain。

---

### 9.4 深度扩展

```
POST /memory/fetch_detail
```

输入：

```json
{
  "memory_id": "mem_console_001"
}
```

输出：

```json
{
  "id": "mem_console_001",
  "type": "ui_rule",
  "text": "Console 页上半部分展示 server 状态方块，下半部分展示终端样式 log。",
  "source_events": [
    {
      "event_id": "evt_100",
      "speaker": "user",
      "content": "原始对话内容……"
    }
  ]
}
```

---

### 9.5 前端读取记忆库

```
GET /memory/list?project_id=vera&include_stains=true
```

输出：

```json
{
  "memories": [
    {
      "id": "mem_001",
      "type": "interaction_rule",
      "text": "颜色字段只存在于记忆 chunk 元数据和前端显示中。",
      "status": "active",
      "agent_stains": {
        "vera": "#7A8FA6",
        "user": "#D6A56D"
      },
      "created_at": "2026-06-22T12:00:00Z",
      "updated_at": "2026-06-22T12:00:00Z"
    }
  ]
}
```

这个 API 给前端用，可以返回颜色。

---

### 9.6 更新颜色

```
PATCH /memory/:id/stain
```

输入：

```json
{
  "owner_id": "user",
  "stain": "#D6A56D"
}
```

输出：

```json
{
  "ok": true
}
```

---

## 10. Agent 普通调用流程

```
用户消息
→ session context
→ memory_retrieve_hook
→ memory_injection_hook 清洗
→ agent prompt（含 fetch_more / fetch_detail 工具说明）
→ agent 回复（按需调用 fetch_more / fetch_detail）
→ raw event 保存
→ context 容量达到阈值时触发 memory_write_hook
→ session 结束后异步启动 dream
```

关键点：

- memory_retrieve_hook 可以访问完整 memory 数据库
- memory_injection_hook 必须剥离 stain
- agent 普通回复阶段不得看到 stain
- agent 可主动调用 fetch_more / fetch_detail 扩展记忆，不需要经过 hook

---

## 11. Memory 写入流程

```
context 容量达到阈值
→ 过滤非对话内容（文档、代码块、工具结果排除）
→ 拉取相关旧 memories
→ memory_write_hook
→ schema 校验
→ 写入 memories / memory_sources / memory_stains / memory_relations
→ 更新 embedding
→ 前端记忆库刷新

session 结束
→ dream subagent 异步启动
→ 集中写入 + 维护
```

校验失败时，不写入数据库，记录系统 log。

---

## 12. Schema 校验规则

写入前必须校验：

1. `text` 不能为空。
2. `type` 必须在枚举内。
3. `scope` 必须在枚举内。
4. `source_event_ids` 至少有一个。
5. `agent_stains` 可为空。
6. `agent_stains` 的 value 必须是合法 hex color。
7. 不允许出现 schema 外字段。
8. 不允许出现 `color_meaning`、`reason`、`strength`、`importance` 等颜色解释字段。

```javascript
const forbiddenFields = [
  "color_meaning",
  "stain_meaning",
  "reason",
  "strength",
  "importance",
  "priority",
  "confidence",
  "mood",
  "emotion",
  "decay"
]
```

---

## 13. 颜色字段规则

stain 是可选 hex color metadata。
stain 可由 memory write hook 或 maintenance hook 写入或覆盖。
stain 可由前端显示和用户手动编辑。
stain 不进入普通 agent prompt。
stain 不需要解释。

---

## 14. 防止标签化的规则

记忆正文要避免：

```
用户是……
用户总是……
用户很敏感……
用户喜欢某个 assistant 自创意象……
用户讨厌所有……
```

更适合写成：

```
用户指出：assistant 不应把自己临时创造的意象反复使用成固定符号，也不应把 assistant 自己创造的东西归因为用户偏好。
```

记录"可执行纠错"，不要记录"人格标签"。

---

## 15. 成本控制

1. **不每轮写记忆**——普通聊天只存 raw event，write hook 由 context 容量触发。
2. **dream 异步兜底**——session 结束后集中处理，不卡主流程。
3. **检索轻量**——retrieve hook 先走本地向量和关键词检索，不先调用大模型。
4. **注入少量**——每次默认注入不超过 10 条，agent 按需 fetch_more。
5. **颜色零解释**——颜色不生成解释，不进入普通 prompt，token 增量极低。
6. **关联一跳**——双链展开深度固定为一跳，不递归，不撑爆 context。

---

## 16. MVP 实施顺序

**Step 1**: 建表
- memories
- memory_sources
- memory_stains
- memory_events
- memory_embeddings
- memory_relations

**Step 2**: 保存 raw events
所有对话先能落盘。

**Step 3**: 手动保存记忆
前端加一个"保存到记忆"入口，先不做自动写入。

**Step 4**: memory_write_hook
接入写入 hook，由 context 容量触发。

**Step 5**: stain 字段
给记忆 chunk 增加 `agent_stains`，前端显示色块。

**Step 6**: retrieve + injection
实现检索和注入，确保注入结果不含 stain。
告知 agent fetch_more / fetch_detail 接口。

**Step 7**: memory_relations
实现双链关联结构，支持方向展开和一跳截断。

**Step 8**: dream subagent
独立进程，session 结束后异步启动，做集中写入和维护。

---

## 17. 最终约束清单

Vera memory 必须满足：

1. 普通 agent 回复阶段看不到 stain。
2. stain 只在 metadata 和前端显示中存在。
3. write hook 和 maintenance hook 可以写入或覆盖 stain。
4. agent 不需要解释 stain。
5. 数据库不保存 stain 的自然语言含义。
6. retrieval 不用 stain 排序。
7. injection 必须剥离 stain。
8. 前端可以显示和编辑 stain。
9. memory text 必须有来源。
10. 记忆正文避免用户画像化。
11. assistant 自创意象不得写成用户偏好。
12. 用户纠正优先写成可执行规则。
13. 过时记忆先 archive，不直接删除。
14. 记忆系统服务项目连续性，不追求人格建模。
15. agent 可主动调用 fetch_more / fetch_detail 扩展记忆。
16. 双链关联展开深度固定为一跳，不递归。
17. 默认注入上限 10 条，至少 1 条随机。
18. write hook 由 context 容量触发，过滤非对话内容。
19. dream 是独立异步 subagent，不接 channel。

---

## 18. 一句话版

Vera memory 的颜色字段是一滴只存在于数据库和前端的沉默墨迹：agent 可以在写入和维护记忆时留下它，但普通调取时看不见它，也不能解释它；记忆池是一张排好序的表，agent 默认拿前几条，需要更多时沿方向横向扩展，需要细节时纵向钻取原文；dream 在 session 结束后独立运行，做集中整理，不打扰主流程；Vera 只把真正有用的记忆正文注入给 agent，用来减少遗忘和重复错误，而不是制造新的标签。
