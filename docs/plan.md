# Vera 0.0.1 总体计划

> 设计基准见 [ground-truth.md](ground-truth.md)。本文档回答"按什么顺序做、每步做到什么程度算完"。
> 状态标记：`[ ]` 未开始 / `[~]` 进行中 / `[x]` 完成。阶段推进时更新本文档，不另开新计划文档。

---

## 指导原则

1. **契约文档管方向，垂直切片管风险。** 先写接口契约再写代码；每个阶段打通一条端到端的窄路，而不是横向铺完某一层。
2. **旧 Vera（`~/projects/Vera`）是只读参考答案，不是依赖。** 它已验证过的东西（CLI 驱动、SSE、隧道、APK）直接抄经验；它没解决的（会话连续性）是本项目的靶心。
3. **可配置 ≠ 抽象层。** ground truth 要求的每个可配置项，第一版实现为配置文件中的字段 + 默认值。抽象等第二个真实用例出现再提。
4. **一个概念一个名字，贯穿代码、存储、API、UI。** 旧 repo 的 accounts/agents、conversations/channels 双名兼容层是混乱的最大来源，本项目从第一行起杜绝。

---

## Phase 0 — 旧 repo 榨取盘点

**目标**：把旧 Vera 里花真金白银换来的经验知识提取成文档，之后写代码不再回头翻旧仓库。

- [x] 逐模块过一遍 `~/projects/Vera/src`，输出 `docs/salvage-notes.md`：
  - 可直接搬运的资产（重点：`adapters/opencode-daemon.js`、`opencode-daemon-adapter.js`、`cli-shared.js` 的 spawn/PATH 处理）
  - 实测得来的协议知识（OpenCode daemon 的 SSE 事件协议、launchd 环境 PATH 坑、tmux 处理）
  - 明确不搬的部分及原因（兼容层、seed 体系、App.jsx）
- [x] 旧 `docs/specs/` 里仍然成立的长期事实（如有）摘入 salvage-notes

**完成标准**：salvage-notes.md 存在，Phase 1–2 写代码期间不需要再读旧 repo 源码。

## Phase 1 — 接口契约

**目标**：前后端、以及未来所有打工 agents 共同对齐的唯一接口基准。

- [x] `docs/api-contract.md`：HTTP endpoints、SSE 事件类型与字段、Agent / Space / Message / Agent State 的数据形状、错误格式、断线重连语义
- [x] `docs/adapter-interface.md`：adapter 层接口。**必须同时给出两个映射示例**：
  - OpenCode（daemon 型：会话活在常驻 HTTP 服务里）
  - Claude Code（resume 型：进程一次一命，靠 `--resume` 续会话）
  - 接口只承诺"adapter 自己负责会话连续性"，不得泄漏任何一种生命周期假设

**完成标准**：两份文档经 Theta 过目认可。此后接口变更遵循"文档先于代码"。

## Phase 2 — 垂直切片（核心阶段）

**目标**：新架构 + OpenCode 持续会话 + 一个 Space 的消息流，端到端打通。

- [x] gateway 骨架：Node 20+ ESM、薄路由、SSE 通道、JSON 文件存储（够用即可，形状按契约）+ mock adapter
- [x] OpenCode daemon adapter（搬运旧代码 + 按新接口收口）
- [x] Agent 注册：一个 OpenCode agent，身份字段按 ground truth 2.2
- [x] 一个默认 Space，消息收发
- [x] 最简网页：一个输入框 + 一条消息流，能看到流式输出即可，不做任何视觉打磨
- [x] `scripts/verify.mjs`：把验收清单固化成脚本（起临时 gateway → 逐项断言 → 退出码报告），此后所有打工 agent 交活前必跑

**完成标准**（全部满足，2026-07-03 真机验收通过）：
1. [x] 浏览器发消息，OpenCode 流式回复渲染到页面
2. [x] 连发多条消息，会话上下文连续（agent 记得前文）
3. [x] gateway 重启后，会话能恢复或明确降级（不静默丢失）——真机验证会话跨重启真恢复（零 session-reset）；另补 SSE seq 水位持久化 + 重启跳跃，客户端带旧 since 重连必触发 stream.reset，不静默漏事件

注：开发期 gateway 用 `PORT=3210`（旧 Vera 常驻进程占着 3000，Phase 6 launchd 迁移时再收回）。

注 2（2026-07-03，与 Theta 确认）：store 持久化拆为 `data/` 目录按集合分文件（agents / spaces / messages / activities / approvals / runs / session-states / meta），防 memory、profile 等数据增长后混存一个大 JSON。`dataPath` 语义由文件改为目录，旧单文件 `store.json` 启动时自动迁移。store 对外 API 不变。

## Phase 3 — 隧道上手机

**目标**：手机在蜂窝网络下跑通同一条切片。

- [x] cloudflared 隧道（照 `docs/reference/vps-tunnel-deploy.md` Option A，个人隧道可跳过 VPS）——`vera.futureidiot.com` → `127.0.0.1:3210`，LaunchAgent 常驻（`com.cloudflare.cloudflared`，plist 需手补 `tunnel run vera` 参数）。本地网络屏蔽 UDP 7844，config.yml 钉死 `protocol: http2`。SSE 过隧道实测逐条到达（ping 间隔 25s 不结块）
- [x] Cloudflare Access 认证（Zero Trust 面板手工配：email OTP → Theta 邮箱；team `plain-silence-4358`，session 1 week，实测未登录请求 302 到 Access 登录页）
- [x] 手机浏览器实测（2026-07-03 真机验收）：蜂窝网络下流式逐字、锁屏/切后台重连、上下文连续均通过。附带教训：gateway 静态文件此前不发缓存头，Cloudflare 默认边缘缓存 .js/.css 导致前端改动手机拿不到——已改为 `Cache-Control: no-store`（api-contract.md 系统表），Phase 6 换 ETag。首测曾卡在 api.navy 免费日额度耗尽（UTC 午夜重置；超限时流式请求挂 60s 被掐、opencode 无限重试、run 挂 working 直到 30min 看门狗——provider 错误尽早浮出 UI 是后续待修项）。已加第二个 agent `Gemma`（本地 ollama `gemma4:e4b`，tmux 会话 `ollama` 常驻）绕开额度依赖；GLM 席位临时 silent，额度恢复后改回 default

**完成标准**：手机蜂窝网络下发消息、看流式回复，体验与本地一致。✅ 2026-07-03 达成。

注（运维现状）：gateway 与 ollama 各跑在 tmux 会话里（`vera-gateway` / `ollama`，Phase 6 迁 launchd）；cloudflared 为用户级 LaunchAgent；重启 gateway 时 store 已自动迁移为 data/ 分集合文件（旧文件留 `store.json.legacy`），Gemma 会话跨重启复用同一 external session 验证通过。

## Phase 4 — 横向铺开

**目标**：ground truth 第五节的功能模块成形。UI 从此阶段起认真做，**mobile-first**。

> **推进次序（2026-07-04，接 codex 审查意见）**：Phase 4 条目间有硬依赖，按依赖序推进，不并行铺。
> 1. Agent/Account 拆分是其余一切的地基——prompt 编译器要按 seat 当前驾驶哪个 account 取 model/connection/sessionState，前端联系人管理要拿 accounts 建模。先拆，不让合并模型渗进更多代码（ground-truth.md:28、`src/agents/agents.js:19`）。
> 2. 多 agent 前，prompt/message 编译层须独立成形。现 `postMessage` 只 fan-out，`run-controller` 只把触发消息交给 adapter，最多首轮前置 resident memory；ground truth 2.3 的"署名注入、不占 assistant 角色、补发错过发言"塞不进 `messages.js` / `run-controller.js`，应抽出清晰的 Space→Agent 视角编译层（ground-truth.md:69、`src/spaces/messages.js:50`、`src/spaces/run-controller.js:64`）。编译层是 4.1 之后、前端之前的纯后端步骤，可 curl/`verify.mjs` 验收，不依赖 UI。
> 3. 前端当前是合格的 Phase 3 控制台（默认拿第一个 Space、只发 broadcast、状态围绕单条时间线组织），不是 Phase 4 壳子。Space 管理、联系人/群、@定向、mobile-first 正式布局当成正式页面架构做，不在最简页上局部加按钮（`frontend/src/views/space-view.js:100`）。前端重构放最后，用一次性页面架构把 4.2–4.5 已就绪的后端能力收进 UI。
>
> 即：`4.1 拆分 → 4.2 编译层 → 4.3 响应规则/AgentState → 4.4 Space 管理 → 4.5 系统配置 → 4.6 前端正式布局`。4.2–4.5 期间所有新增字段用 curl/`verify.mjs` 验收，前端最后一次性重构。

- [x] **4.1 Agent/Account 拆分**（最先，无 UI 依赖）：契约先行（见 api-contract.md 二「Agent」「Account」「Space」）；`docs` 改 Agent 形状收敛为 `{id, name, createdAt, updatedAt}`，新增 Account 形状（owningAgentId + kind/provider/connection/model），Seat 增 `accountId`（驾驶关系，缺省 = agent 自有 account），`sessionState` 键由 `(agentId, spaceId)` 改 `(accountId, spaceId)`——外部会话随 account 走、记忆随 agent 走。store 启动一次性迁移把旧 agents 记录的连接字段拆出派生 owning account、session-states 键重映射；旧文件留 `.legacy`，一次改干净不留双名（ground truth 2.2 末段）。`resolveAdapter(agent)` 改 `resolveAdapter(account)`，adapter ctx 分开 `agent`/`account`。
- [ ] **4.2 Speaker view 编译层**：新模块 `src/spaces/view-compiler.js`，输入 `(store, space, agentId, account, triggerMessage)` 输出 prompt 文本；`run-controller.runAsync` 调它替换手拼 promptText，`messages.js` 触发 fan-out 不变。按 ground truth 2.3（2026-07-04 补三条）实现：
  - **只 inject message，不 inject activity**——思考链/工具链不进任何 agent 的下次 prompt（包括本人，本人工具历史由 adapter sessionState 携带）。这是"发言 ≠ 过程"的边界。Phase 5 的 `fetch_detail`/`fetch_more` 主动调阅是这边的逃生口（按需、带预算），Phase 4 不实现但接口留位。
  - **群聊视角以声告段注入，不伪装一对一 user 历史轮次**：派生该 agent 上次本人发言（按其最后一次 assistant 气泡的 createdAt）到当前触发之间的他人气泡，聚合成"=== 群内最近发言 ===\n- <name>: <气泡>…"声告段，塞进 `ctx.prompt.text` 头部；CLI 型直送新轮、API 型落在新 user 消息尾部（不进稳定历史）。模型历史里 assistant 永远是自己、user 永远是用户的直接提问，旧群状态每轮过期作废。
  - **编译层无状态**：每次 run 临时查 `messages.json` 派生 delta，不维护"已投递水位"；幂等。注入段配置上限（最近 N 条/总字数上限，超了提示"更早的见 fetch_detail"）放 `src/core/config.js`，不硬编码。常驻索引块仅随新 (account, Space) 首次注入，逻辑从 run-controller 搬来——它与群聊 delta 同属 prompt 头部但是两段（索引是稳定前缀、群状态是 volatile tail 不混淆）。
- [ ] **4.3 响应规则收口**：`silent` 的 `respondTo` 字段从 `[P4]` 落地——seat 形 `{agentId, accountId, responseMode, respondTo?, blockAgentIds?}`，`respondTo` 成员为 `"user"` 或 `agt_...`；新增 `blockAgentIds: ["agt_..."]` 屏蔽名单（ground truth 2.3 2026-07-04 补"响应规则统一语义"）。判定逻辑归并进 4.2 编译层（被过滤的事件不进 prompt 段，等价不触发 run；定向 @ 穿透 blockAgentIds 不穿透 silent/focused）。AgentState 层确认 bootstrap/GA 已完整返回（Phase 2–3 已建 tracker，对勾即可）。
- [ ] **4.4 Space 管理**：`normalizeSeat` 加 `accountId`（缺省取该 agent 自有 account）；API 已支持 create/update，契约补 seat.accountId 语义一句。
- [ ] **4.5 系统配置**：新增 `GET/PATCH /api/settings`，字段以 ground truth 4.1 为唯一清单（数据隔离规则、记忆整理触发/注入预算、消息呈现等），严格遵守不扩；运维参数仍走 env 不进前端（ground truth 4.1 末段边界注记）。持久化进 `data/settings.json`（store 新集合），config 作启动默认、settings 作运行时覆盖。
- [ ] **4.6 前端正式布局**（最后，一次性替换最简页）：mobile-first 页面 shell——顶栏（当前 Space 名/状态）+ 抽屉（Space 列表、Agent/联系人、设置入口）+ 主聊天区 + 输入栏；手机竖屏第一公民，桌面宽屏自适应。hash 路由（`#/spaces/:id` 等），无构建步骤约束下不引框架。`views/` 拆 `shell.js` / `space-list.js` / `space-view.js`（重写为聊天主区）/ `agent-contacts.js` / `settings.js`；`components/` 增 `space-switcher.js` / `contact-item.js` / `seat-editor.js` / `composer-modes.js`。composer 支持 @定向（payload `target.type=direct`）。联系人 = account 视图：点开 = 私聊 Space，多选 = 建群聊 Space；私聊群聊后端都是 Space，前端按 `seats.length` 渲染样式。CSS 变量按 ground truth 4.3 全套一次建齐，组件零硬编码。

**完成标准**：手机蜂窝网络下，≥2 agents 的 Space，完成一次广播 + 一次定向，被 @ 的 agent 回复 prompt 含他人署名发言且无误用 assistant 角色；账户即联系人入口可用；任意可配置项在前端可达。`scripts/verify.mjs` 加端到端（建 2 agents 2 accounts → Space 两 seat → broadcast → 两 run 都发 → @ 单方 → 只单方响应 → 被点 agent 的 prompt 含另一 agent 署名发言）。

## Phase 5 — Memory 与数据层

**目标**：ground truth 第三节的三层数据落地。设计依据：`memory-hook.md`——以《修订：文件库架构》（R1–R6）为准，按第 16 节 MVP 顺序推进。

> 提前量（2026-07-03，与 Theta 确认）：**最小闭环提前落地**——vault 骨架 + 文件格式 + 常驻索引会话首消息注入 + agent 文件工具直读直写 + 手动保存入口（API），形状已收编进 api-contract.md「Memory（最小闭环）」。目的：Phase 3–4「边用边修」阶段长期记忆已可用。检索注入、派生权重、dream 不提前，仍按本阶段推进。
>
> **Vault 位置策略**（2026-07-04，与 Theta 确认 + 联邦形态对齐）：vault 热数据**只在 VPS**（`/home/theta/.vera/memory/`，联邦后 gateway 跑在 VPS），所有 agent daemon 通过 Vera memory API 远程读写，本地不再有"原版"——避免双写冲突/双读漂移，保持 single source of truth。**备份走 git 镜像**：把 VPS vault init 成 git repo，每次整理后 `git push` 到一个私有 GitHub repo；Mac 上 `git pull` 即得只读备份，还能看版本历史（Obsidian vault 全 markdown，git 友好）。rsync 冷备份作次要手段（崩了需要快速回滚时用），不替代 git 镜像的版本维度。Phase 3-4 期间 vault 还在本机 Mac `~/.vera/memory/`，Phase 5.5 联邦落地时随数据 rsync 一起搬 VPS，搬完即切 git 镜像备份流。

- [~] 动工前：memory-hook.md 术语/API 对齐契约（按文档头部整合注记），形状收编进 api-contract.md（最小闭环部分已收编；其余 `/api/memory/*` 届时再补）
- [~] 文件库（Obsidian 兼容 vault）+ Raw Event 留 store + 手动"保存到记忆"入口（R1–R2，MVP Step 1–3）（vault + 手动保存提前做；Raw Event 溯源链留本阶段）
- [ ] memory_write_hook（context 容量触发；slug/钩子行质量为第一验收项）+ stain frontmatter 与前端色块（Step 4–5）
- [ ] 三渠道注入：常驻索引（批量换版）、token 计价检索注入（哑墨、同会话去重、尾部放置）、fetch_more / fetch_detail 钻取（R3、R5，Step 6）
- [ ] 派生索引与权重（双链入度、使用统计、置顶；无手工标注）+ dream 维护 subagent（R4，Step 7–8）；整理任务用便宜模型跑批
- [ ] Files 层：Space 内隔离的附件存储
- [ ] 数据层分类实现为可扩展结构，不硬编码枚举

**完成标准**：agent 在 A Space 获得的长期记忆，整理后在 B Space 可用。

## Phase 5.5 — Agent 联邦（gateway 搬 VPS + agent daemon 远程接入）

**目标**：把当前"gateway + adapter 同机 spawn CLI"形态改成"gateway 在 VPS、agent daemon 在远端、通过 HTTP/SSE 联邦接入"形态。这是 2026-07-04 与 Theta 五问五答定下来的根本架构转向（ground-truth 2.4），不是单纯运维搬迁。

**为什么必须做**：
- 用户核心需求是"手机随时随地能联系 Mac 上的 agent"。Mac 单机形态下 Mac sleeps / 切网 / 重启就联系不上。
- cloudflared 边缘漂移假活（2026-07-04 实测，salvage-notes 第 5 条）暴露了 launchd 存活检测治不了"进程假活"，光搬 VPS 不够，还要 systemd watchdog。
- Agent 跟 gateway 解耦后，agent daemon 在哪台机器都行（Mac / 另一台 VPS / 云函数 / API 型无进程），用户在手机上能跨机器调度 agent 协作。

**契约先行**（已完成，本阶段代码实施前确认对齐）：
- [x] `docs/ground-truth.md` 2.4 节定稿：4 条决策（gateway 搬 VPS / agent 被动响应 / 离线 @ 跳过 + error activity / 工作流约定冲突协调）+ 心跳退出协议 + 双层认证 + AgentState per-Space + GitHub 单账号分活
- [x] `docs/adapter-interface.md` 重写为 agent daemon 协议（旧 gateway-spawn 形态移附录 A）
- [x] `docs/api-contract.md` 加 `/api/agent/*` 路由前缀 + Account.presence/lastSeenAt + AgentState per-Space 扩展态 + `agent.heartbeat` / `run.requested` / `account.presence.updated` 事件 + 离线 @ Activity 规则 + 双层认证说明
- [x] `docs/reference/vps-tunnel-deploy.md` 重写为 VPS gateway + 远程 agent daemon 部署指南

**代码实施清单**（按依赖序）：

- [ ] **5.5.1 AgentState per-Space 改造**（最浅，先做）：`src/agents/agent-state.js` 跟踪键 `agentId` → `agentId:spaceId`；形状加 `spaceId` + `detail` 字段；`status` 枚举扩到 `idle/thinking/typing/reading/coding/reviewing/on_task/away`；`/api/agent-states` 支持 `?spaceId` / `?agentId` 过滤；契约 + 4.1 已建跟踪器同步改。verify.mjs 加 per-Space 测试。
- [ ] **5.5.2 Account.presence + 离线 @ 行为**：Account 形状加 `presence` / `lastSeenAt` 字段；`src/agents/accounts.js` 暴露 `setPresence`；`src/spaces/messages.js` 的 `shouldRespond` 加在线判定：offline 则不创建 run，改在 Space 时间线 insert 一条 `phase:"error", label:"agent-offline"` 的 Activity；SSE 加 `account.presence.updated` 事件。verify.mjs 加离线 @ 测试。
- [ ] **5.5.3 Agent token 体系**：`src/core/agent-tokens.js` 新建——加载 `~/.vera/agent-tokens.json`，校验 Bearer token → 返回 agentId；token 文件格式 `{ "agt_xxx": "<long-random>", … }`，新建 agent 时自动生成一条；gateway 启动加载、不进 repo。
- [ ] **5.5.4 `/api/agent/*` 路由层**：`src/api/agent-routes.js` 新建——所有 `/api/agent/*` 走 Bearer token 中间件识别身份；`POST /api/agent/login`（返回 agent/account/seats/sessionStates/heartbeatIntervalMs）、`DELETE /api/agent/sessions`、`GET /api/agent/events`（SSE，daemon 单一长连接，复用 hub 但按 agentId 过滤推送 + 加 `agent.heartbeat` 定时帧）、`POST /api/agent/runs` / `PATCH /api/agent/runs/:id` / `POST /api/agent/runs/:id/{delta,messages,activities,approvals}` / `POST /api/agent/sync-state`。
- [ ] **5.5.5 Run 触发链路改造**：`src/spaces/messages.js` 不再 sync 调 `executeRun`；改成"对每个应该响应的 seat：在线 → 创建 Run 记录（status=running）+ 通过 daemon SSE 通道推 `run.requested` 事件（含编译层 promptText）；离线 → 走 5.5.2 离线 activity 路径"。`run-controller.js` 的 `executeRun` 拆掉，编译层抽出独立模块 `src/spaces/view-compiler.js`（Phase 4.2 本来要做，联邦形态下它直接服务于 `run.requested` 的 promptText 字段）。mock adapter 保留给 verify.mjs gateway 内部一致性测试用。
- [ ] **5.5.6 `scripts/agent-daemon.js`**：新进程，独立于 gateway。启动读 env（gateway URL / agent token / Service Token / CLI binary path / workspace），`POST /api/agent/login` 拉回 sessionState → `GET /api/agent/events` SSE 订阅 → 收 `run.requested` 后内部走"spawn CLI / 调 API"逻辑（搬运 `src/adapters/opencode-adapter.js` 的 daemon 管理 + runner 子进程逻辑，但 ctx.* 回调改成对 gateway 的 POST）→ 流式输出回 POST → 心跳缺失 3 次后 exit(0)。
- [ ] **5.5.7 mock daemon + verify.mjs 拆分**：verify.mjs 加一段端到端协议测试——起一个 mock daemon 子进程，对 `/api/agent/*` 全协议走一遍（login → run.requested → delta → activity → message → run completed → sync-state → logout）；gateway 内部一致性测试保留旧 mock adapter 路径。
- [ ] **5.5.8 VPS 部署落地**：按 `docs/reference/vps-tunnel-deploy.md` 顺序：VPS 初始化 → 数据 rsync → systemd units（gateway / cloudflared / watchdog timer）→ Service Token 在 Cloudflare 面板配 → 验证。
- [ ] **5.5.9 本机清理**：`tmux kill-session vera-gateway`、`launchctl unload com.cloudflare.cloudflared`；本机 `~/.vera/` 与 `~/.cloudflared/` 留冷备份不删；本机起 agent daemon 验证 Mac → VPS → 手机端到端通。

**完成标准**：
1. `scripts/verify.mjs` 全过（含 mock daemon 端到端协议测试 + 离线 @ error activity + per-Space AgentState + 心跳缺失 daemon 自杀）
2. VPS 上 gateway + cloudflared + watchdog systemd unit 全部 active
3. 手机蜂窝网络下 @ 在线 agent（daemon 在 Mac）→ 流式回复正常到达；@ 离线 agent → 时间线一行 error 提示 + 不创建 Run
4. 重启 VPS gateway → Mac daemon 自动重连 + sessionState 取回 + 后续消息零 session-reset
5. 停 VPS gateway → Mac daemon 在 ~45s 内 exit(0)，不反复撞网关；恢复 gateway 后手动起 daemon 重新登录正常

## Phase 6 — 收尾与扩展

- [ ] Claude Code adapter（`--resume` 会话连续性）—— 联邦形态下等于实现 `scripts/agent-daemon.js` 的 Claude Code 适配层（`adapter-interface.md` 示例 B）
- [ ] Codex adapter —— 同上，示例 B 的变体
- [ ] Skill 配置（per-agent 导入/加载/卸载）
- [ ] Appearance 全套配置项
- [ ] Capacitor APK 打包
- [ ] ~~gateway launchd 常驻 + 崩溃自愈（搬运旧 scripts 经验）~~ —— **提前到 Phase 5.5，形态改为 VPS systemd + agent daemon launchd/systemd 双层**

**完成标准**：ground truth 第四节可配置项清单逐项对勾。

---

## 明确不做（0.0.1 范围外）

- 多用户、账号体系
- agent 间自主调度的复杂授权模型（先做最简开关）
- 桌面客户端（网页在 Mac 浏览器里就是桌面版）
