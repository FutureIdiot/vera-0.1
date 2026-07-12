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

注：开发期与本机手测gateway固定用 `PORT=3210`（旧 Vera 常驻进程占着3000）；迁VPS后端口由部署配置决定，本仓库手测规约仍保持3210，不“收回”3000。

注 2（2026-07-03，与 Theta 确认）：store 持久化拆为 `data/` 目录按集合分文件（agents / spaces / messages / activities / approvals / runs / session-states / meta），防 memory、profile 等数据增长后混存一个大 JSON。`dataPath` 语义由文件改为目录，旧单文件 `store.json` 启动时自动迁移。store 对外 API 不变。

## Phase 3 — 隧道上手机（历史验收；目标网络已由 2026-07-11 纯私网设计取代）

**目标**：手机在蜂窝网络下跑通同一条切片。

- [x] cloudflared 隧道（历史方案，当前部署指南已不再保留该Option）——`vera.futureidiot.com` → `127.0.0.1:3210`，LaunchAgent 常驻（`com.cloudflare.cloudflared`，plist 需手补 `tunnel run vera` 参数）。本地网络屏蔽 UDP 7844，config.yml 钉死 `protocol: http2`。SSE 过隧道实测逐条到达（ping 间隔 25s 不结块）
- [x] Cloudflare Access 认证（Zero Trust 面板手工配：email OTP → Theta 邮箱；team `plain-silence-4358`，session 1 week，实测未登录请求 302 到 Access 登录页）
- [x] 手机浏览器实测（2026-07-03 真机验收）：蜂窝网络下流式逐字、锁屏/切后台重连、上下文连续均通过。附带教训：gateway 静态文件此前不发缓存头，Cloudflare 默认边缘缓存 .js/.css 导致前端改动手机拿不到——当时先改为 `Cache-Control: no-store`，后由F2 production build完成hash资源immutable与HTML ETag/协商缓存，F5只做发布复核。首测曾卡在 api.navy 免费日额度耗尽（UTC 午夜重置；超限时流式请求挂 60s 被掐、opencode无限重试、run挂working直到30min看门狗——provider错误尽早浮出UI是后续待修项）。已加第二个agent `Gemma`（本地ollama `gemma4:e4b`，tmux会话`ollama`常驻）绕开额度依赖；GLM席位临时silent，额度恢复后改回default

**完成标准**：手机蜂窝网络下发消息、看流式回复，体验与本地一致。✅ 2026-07-03 达成。

注（运维现状）：gateway与ollama各跑在tmux会话里（`vera-gateway` / `ollama`）；gateway常驻迁移已改由Phase 5.5落VPS systemd，agent daemon再按宿主使用launchd/systemd。cloudflared当前仍为用户级LaunchAgent；重启gateway时store已自动迁移为data/分集合文件（旧文件留`store.json.legacy`），Gemma会话跨重启复用同一external session验证通过。

> 2026-07-11 网络修订：以上 Cloudflare Tunnel / Access 条目只保留为 Phase 3 已完成的历史证据，不再是目标部署。Phase 5.5 改为 VPS 单一 gateway + Tailscale Serve 纯私网；手机与 Mac 都加入 tailnet，Vera 不保留公网入口。

## Phase 4 — 横向铺开

**目标**：ground truth 第五节的功能模块成形。UI 从此阶段起认真做，**mobile-first**。

> **推进次序（2026-07-04，接 codex 审查意见）**：Phase 4 条目间有硬依赖，按依赖序推进，不并行铺。
> 1. Agent/Account 拆分是其余一切的地基——prompt 编译器要按 seat 当前驾驶哪个 account 取 model/connection/sessionState；聊天联系人则按Agent/Agent成员集合建模，Account只补背后连接与presence。先拆，不让合并模型或“Account=联系人”渗进更多代码（ground-truth.md:28、`src/agents/agents.js:19`）。
> 2. 多 agent 前，prompt/message 编译层须独立成形。现 `postMessage` 只 fan-out，`run-controller` 只把触发消息交给 adapter，最多首轮前置 resident memory；ground truth 2.3 的"署名注入、不占 assistant 角色、补发错过发言"塞不进 `messages.js` / `run-controller.js`，应抽出清晰的 Space→Agent 视角编译层（ground-truth.md:69、`src/spaces/messages.js:50`、`src/spaces/run-controller.js:64`）。编译层是 4.1 之后、前端之前的纯后端步骤，可 curl/`verify.mjs` 验收，不依赖 UI。
> 3. 前端当前是合格的 Phase 3 控制台（默认拿第一个 Space、只发 broadcast、状态围绕单条时间线组织），不是 Phase 4 壳子。新版不保留底部标签：主页是全屏聊天，左上进当前Space设置、右上进全局Settings、右滑进“联系人头像 → Space列表”导航。前端先一次替换全局Shell，随后按领域纵向落地；不把所有页面堆进一次大改，也不在旧页上边用边长。
>
> 即：`4.1 拆分 → 4.2 编译层 → 4.3 响应规则/AgentState → 4.4 Space 管理 → 4.5 系统配置 → 4.6 前端契约/Shell/领域页面/验收`。4.2–4.5 期间所有新增字段用 curl/`verify.mjs` 验收；4.6 每个子阶段保持可运行，禁止先造巨石再回头拆。

- [x] **4.1 Agent/Account 拆分**（最先，无 UI 依赖）：契约先行（见 api-contract.md 二「Agent」「Account」「Space」）；`docs` 改 Agent 形状收敛为 `{id, name, createdAt, updatedAt}`，新增 Account 形状（owningAgentId + kind/provider/connection/model），Seat 增 `accountId`（驾驶关系，缺省 = agent 自有 account），`sessionState` 键由 `(agentId, spaceId)` 改 `(accountId, spaceId)`——外部会话随 account 走、记忆随 agent 走。store 启动一次性迁移把旧 agents 记录的连接字段拆出派生 owning account、session-states 键重映射；旧文件留 `.legacy`，一次改干净不留双名（ground truth 2.2 末段）。`resolveAdapter(agent)` 改 `resolveAdapter(account)`，adapter ctx 分开 `agent`/`account`。
- [x] **4.2 Speaker view 编译层**：新模块 `src/spaces/view-compiler.js`，输入 `(store, space, agentId, account, triggerMessage)` 输出 prompt 文本；`run-controller.runAsync` 调它替换手拼 promptText，`messages.js` 触发 fan-out 不变。按 ground truth 2.3（2026-07-04 补三条）实现：
  - **只 inject message，不 inject activity**——思考链/工具链不进任何 agent 的下次 prompt（包括本人，本人工具历史由 adapter sessionState 携带）。这是"发言 ≠ 过程"的边界。Phase 5 的 `fetch_detail`/`fetch_more` 主动调阅是这边的逃生口（按需、带预算），Phase 4 不实现但接口留位。
  - **群聊视角以声告段注入，不伪装一对一 user 历史轮次**：派生该 agent 上次本人发言（按其最后一次 assistant 气泡的 createdAt）到当前触发之间的他人气泡，聚合成"=== 群内最近发言 ===\n- <name>: <气泡>…"声告段，塞进 `ctx.prompt.text` 头部；CLI 型直送新轮、API 型落在新 user 消息尾部（不进稳定历史）。模型历史里 assistant 永远是自己、user 永远是用户的直接提问，旧群状态每轮过期作废。
  - **编译层无状态**：每次 run 临时查 `messages.json` 派生 delta，不维护"已投递水位"；幂等。注入段配置上限（最近 N 条/总字数上限，超了提示"更早的见 fetch_detail"）放 `src/core/config.js`，不硬编码。常驻索引块仅随新 (account, Space) 首次注入，逻辑从 run-controller 搬来——它与群聊 delta 同属 prompt 头部但是两段（索引是稳定前缀、群状态是 volatile tail 不混淆）。
- [x] **4.3 响应规则收口**：`silent` 的 `respondTo` 字段从 `[P4]` 落地——seat 形 `{agentId, responseMode, respondTo?, blockAgentIds?}`，`respondTo` 成员为 `"user"` 或 `agt_...`；新增 `blockAgentIds: ["agt_..."]` 屏蔽名单（ground truth 2.3 2026-07-04 补"响应规则统一语义"）。判定逻辑两层：`messages.js` 的 `shouldRespond` 看 responseMode/respondTo/target 决定要不要建 run；编译层 `compilePrompt` 内按 `blockAgentIds` 过滤声告段（被 block 的 agent 气泡不进段，但定向 @ 仍穿透 blockAgentIds 创建 run——不穿透 silent/focused）。AgentState 层确认 bootstrap/GA 已完整返回（Phase 2–3 已建 tracker，对勾即可）。
- [x] **4.4 Space 管理**：`normalizeSeat` **去掉** `accountId`（账户归属改为登录级或默认 owning account，见 ground truth 2.2 修订 / api-contract Seat 段）；store 启动一次性清理 4.1 backfill 到 spaces 下 seats 上的 `accountId` 字段（`migrateAgentAccountsIfNeeded` 里的 seat.accountId backfill 逻辑撤掉），session-states 键不动。
- [x] **4.5 系统配置**：新增 `GET/PATCH /api/settings`，字段以 ground truth 4.1 为唯一清单（数据隔离规则、记忆整理触发/注入预算、消息呈现等），严格遵守不扩；运维参数仍走 env 不进前端（ground truth 4.1 末段边界注记）。持久化进 `data/settings.json`（store 新集合），config 作启动默认、settings 作运行时覆盖。
- [ ] **4.6 前端正式布局**：按 ground truth 5.1–5.4 分阶段推进，手机竖屏第一公民；使用简单hash路由，不为路由引入UI框架。
  - [x] **4.6.0 文档契约（2026-07-10）**：ground truth 已定全屏聊天主页、当前Space设置、右滑双栏Space导航、全局Settings、Account组合管理、配置闭环、提前拆分与页面完成标准；API契约已补 Appearance（含Theme/Profile边界与安全导入导出）、Space提醒、Space归档/恢复及Account组合读取边界。本步不改前端代码。
  - [x] **4.6.1 可调雏形 + Shell（2026-07-11）**：可调雏形与默认tokens由F0完成，F2落全局app runtime、route lifecycle与旧时间线挂载；F3已完成无底部标签、左上当前Space设置、右上全局Settings及手机/桌面Shell交互并通过真实浏览器验收。
  - [x] **4.6.2 基础层提前拆分（2026-07-11）**：已移除 `api/gateway-client.js`，按领域拆成 `http` / `spaces` / `agents` / `accounts` / `settings` / `memory` / `extensions` / `status` / `events` clients；state 已拆 router、全局app runtime、platform、Space导航/时间线、Account、Settings、Extension边界；样式已拆 `tokens.css`（变量唯一来源）/ `base.css` / `shell.css` / `chat.css`，旧巨型 `theme.css` 已移除。聊天route显式mount/unmount，全局runtime唯一持有SSE并处理reset水位，timeline state与DOM同步限制200项。
  - [x] **4.6.3 全屏聊天 + Space导航/设置闭环（2026-07-11）**：F3已拆分聊天、导航与Space设置职责；手机右滑或点顶栏Space名称打开导航，桌面图钉切换覆盖/常驻；已完成Space切换、新增、重命名、二次确认归档与恢复，以及参与Agent、Seat响应规则和notifications。Space Module区继续等Phase 6契约/后端就绪后再显示，不建假开关；composer只属于聊天主页，设置路由替换聊天主区而不与时间线纵向叠放。
  - [x] **4.6.4 Account组合管理 + Agent Memory闭环（2026-07-12）**：只有 `#/settings/accounts` 一个管理入口；`account-list-view.js`、`account-detail-view.js`、`agent-memory-view.js` 分开。详情组合显示Agent身份/状态/Memory与其一个或多个Account连接，但API/state仍按Agent和Account分域；删除连接与删除Agent是两个明确动作。Memory只在进入对应Agent子路由时加载正文。
  - [x] **4.6.5 Setting子页闭环（2026-07-12）**：`settings-index-view.js`、`system-settings-view.js`、`appearance-view.js`、`path-settings-view.js`、`control-center-view.js` 分开；设置首页只显示普通分组列表，不预取子页数据。Appearance预览只改内存CSS变量，保存走gateway，按组恢复默认传 `null`。中控台进入时才取状态/轮询，离开即停止；当前file store显示存储状态，不虚构数据库连接。Extension Package管理等Phase 6契约落地后加入。
  - [ ] **4.6.6 真实运行与性能验收**：补路由/state单测和 `scripts/verify.mjs` 端到端；启动临时gateway于3210实测API与逐条SSE，再在390px中档Android/WebView和桌面宽屏验证deep-link刷新、前进后退、虚拟键盘、安全区、loading/empty/error/offline/长内容与最新消息可见。记录bundle/Performance trace：首屏自有JS+CSS gzip目标≤200 KiB，缓存后聊天可交互≤1.5s、模拟4G冷启动≤3s、时间线DOM≤200 items、无连续>50ms long task；路由离页后timer/poller/listener归零。不得以静态文件检查或build成功代替验收。

**前端配置覆盖表**（每行必须打通“默认值 → API → 控件 → 持久化 → consumer → 恢复默认 → 实测”才可标完成）：

| 配置组 | 作用域 / API | 前端入口 | consumer | 当前状态 |
|---|---|---|---|---|
| 数据隔离 | 全局 `/api/settings` | `#/settings/system` | Memory / Files / AgentState各自模块 | F4控件、持久化与恢复默认已落；模块consumer按计划待Phase 5 |
| 记忆整理与注入预算 | 全局 `/api/settings` | `#/settings/system` | memory整理器 / resident index | F4控件与resident index热更新已闭环；完整整理器待Phase 5 |
| 消息呈现 | 全局 `/api/settings` | `#/settings/system` | bubble-stream / bubble-splitter | F4已完成运行时热更新、恢复默认与黑盒实测 |
| Seat响应规则 | per-Space `/api/spaces/:id` | `#/spaces/:spaceId/settings` | shouldRespond / view-compiler | 4.6.3已完成并于2026-07-11验收 |
| Space消息提醒 | per-Space `/api/spaces/:id` `[P4.6]` | `#/spaces/:spaceId/settings` | 客户端通知桥 | 4.6.3已完成Web控件与持久化；Android/iOS原生通知桥归Phase 6 |
| Agent / Account | 各对象API | `#/settings/accounts/...` | adapter / 联邦登录 / Memory | F4组合管理与Agent Memory已闭环；联邦能力快照待Phase 5.5 |
| Tools与运行时能力 | per-Agent daemon login + policy `[Phase 5.5/6]` | Account详情Capabilities | CLI/provider/daemon tool host | 命名和执行边界已定，capability上报与policy待实现 |
| Appearance | 全局 `/api/settings` `[P4.6]` | `#/settings/appearance` | CSS token loader | F4已完成预览/保存/null恢复、Theme/Profile交换与响应式实测 |
| Skill | per-Agent `[Phase 6]` | `#/settings/accounts/:agentId/skills` | agent daemon | 未到阶段，不建空壳 |
| Agent Plugin | per-Agent `[Phase 6]` | Account详情Plugins | agent daemon | 分类已定，manifest/API待Phase 6契约 |
| Space Module | per-Space `[Phase 6]` | `#/settings/extensions` + 当前Space设置 | 沙箱Module host | 分类已定，manifest/API待Phase 6契约 |

**完成标准**：手机蜂窝网络下，主页无底部标签且当前Space聊天占满主区；右滑双栏可按Agent/群切换、新增、重命名、归档和恢复Space，历史与sessionState不丢；桌面图钉常驻切换正确；左上当前Space设置与右上全局Settings职责不串且设置页替换聊天主区；≥2 agents 的 Space 完成一次广播 + 一次定向，被 @ 的 agent 回复prompt含他人署名发言且无误用assistant角色；4.6范围内配置项前端可达且consumer真实生效。`scripts/verify.mjs` 加对应端到端。

## Phase 4.6 Web交付路线（新窗口执行入口）

> 当前起点（2026-07-12）：F0–F4已完成，Web端已有全屏聊天Shell、双栏Space导航、当前Space设置，以及按路由拆分的Settings、Account、Agent Memory、Appearance、Paths与Control Center；下一步进入F5 Web发布与性能基线。F0–F5只细化Phase 4.6的Web交付，不再跨入Phase 5/5.5/6；每个F独立commit并更新本节状态，上一项未验收不进入下一项。Android/iOS壳统一留到Phase 6，至少等F5冻结Web外观、交互和性能基线后再生成。

### F0 — 参考图与可调UI Lab

- [x] 收齐用户已有示意图（2026-07-10：4张手机参考图，用户未提供单独桌面图），已在本轮UI Lab逐张标注“保留结构 / 只借视觉 / 不采用”；桌面形态由同一雏形响应式推演，不另造业务实现。
- [x] 在Codex可视化制作可交互雏形（2026-07-10，按用户反馈修订）：全屏聊天、右滑双栏Space导航、当前Space设置、Settings目录、Account组合页；手机无边缘常驻按钮，顶栏Space名称提供非手势入口；桌面导航可由左下图钉切换覆盖/常驻；设置路由替换聊天主区。支持390px手机与桌面宽屏切换。
- [x] UI Lab可调theme/font/font-size/bubble-radius/bubble-gap/window-margin，并可在本轮状态中记录/导出未提交候选tokens；font-size/window-margin按`phone/desktop × chat/management`分域，bubble-radius/gap按phone/desktop分域且只作用聊天。当前候选：手机chat/management字号14px、聊天gap 4px、margin 12px；桌面聊天margin先取64px、management margin取8px继续调。未写入正式前端。
- [x] 用户已确认信息架构与默认视觉（2026-07-10）；响应式Appearance默认值已回写ground truth与API契约。F0完成，下一步从F1契约/后端闸门开始，不把UI Lab源码直接搬进正式前端。

**验收**：关键页面、打开/返回/右滑流程和默认tokens有明确结论；不存在需要实现者继续猜的主导航或页面归属。

### F1 — 前端契约与后端就绪闸门

- [x] 逐页面列"事件输入 / API读取 / API写入 / 空态与错误态"；接口缺失先改 `api-contract.md` 再写后端。
- [x] 补齐4.6所需后端：Space notifications与archive/restore（只写`archivedAt`，不删除记录）、Appearance字段/null恢复默认、Account组合读取所需摘要、Agent Memory编辑、路径校验/迁移入口、中控台status摘要；未完成的Extension/Agent Plugin/Space Module不做假控件。
- [x] 落Theme/Profile契约：Theme对象与列表/预览导入/保存/导出API，`vera-json`与白名单`vera-css`，iTerm2 `.itermcolors`与Terminal.app `.terminal`导入转换；Theme切换不得覆盖字体、响应式字号、气泡和窗口边距，导入原文不得直接持久化或执行。
- [x] 定义客户端平台adapter接口：gateway URL、fetch/SSE、secure storage、notification、file picker、keyboard/back、haptics、external auth/link；Web fallback必须在契约中可表达。
- [x] 明确原生壳通过Tailscale连接VPS gateway的私网URL、精确Origin CORS、可信owner identity与SSE恢复路径；2026-07-11 已替换原Cloudflare Access/公网登录设计。

**验收**：每个将要实现的控件都有真实API/consumer；`npm test`、`scripts/verify.mjs`与`git diff --check`通过。

### F2 — 共享Web基础与提前拆分

- [x] 保持原生ES Modules，不引入React/Vue等UI框架；加入Vite仅负责dev/build、动态import和bundle报告，输出到 `frontend/dist/`。
- [x] 建立 `npm run dev:web` / `build:web` / `analyze:web`；gateway开发期仍用3210，Vite代理或runtime gateway配置不得写死地址。
- [x] 按4.6.2拆 `views/api/state/styles`；`tokens.css`唯一视觉参数源，建立route lifecycle（mount/unmount）和platform adapter Web实现。
- [x] 旧时间线完整迁入新store/route，保留keyed局部更新、SSE reset/reconnect和Approval，不在重构中重写业务语义。
- [x] 添加路由、store、timeline上限、cleanup单测；生成首份bundle基线。

**验收（2026-07-11完成）**：`npm test` 92/92、`scripts/verify.mjs` 62/62、`build:web`、`git diff --check`通过；Vite→3210真实代理下页面/API与SSE `stream.reset`逐帧通过。默认聊天首屏（Shell + Web platform + chat route + CSS）gzip 9,758 bytes / 200 KiB；首屏无Settings/Memory/Extension主体代码，production gateway仅伺服`frontend/dist/`，hash资源immutable且HTML走ETag协商缓存。

### F3 — Web核心体验：聊天、Space导航、当前Space设置

- [x] 全屏聊天Shell：无底部标签；左上当前Space设置、右上全局Settings；composer、最新消息可见、Activity/Approval状态正确。
- [x] 右滑双栏导航：左侧Agent/群头像投影，右侧对应活跃Space列表；手机右滑+顶栏Space名称入口，桌面左下图钉切换覆盖/常驻；支持切换、新增、重命名、二次确认归档及从“已归档Spaces”恢复，不提供永久删除。
- [x] 当前Space设置：参与Agent、Seat responseMode/respondTo/blockAgentIds、消息提醒；Space Module区在Phase 6前不显示。
- [x] 真实gateway/SSE运行验证手机浏览器与桌面浏览器；处理loading/empty/error/offline/长时间线。

**验收（2026-07-11完成）**：完整单测96/96、gateway/SSE黑盒65/65通过；subagent最终审查后的竞态/reset/多Run修正另跑前端与Space纯单测37/37、`analyze:web`与`git diff --check`通过，默认聊天16,854 / 204,800 bytes gzip。真实浏览器完成390×844与1280×900验收：无横向溢出，消息发送、Space设置保存回显、新建/改名/归档/恢复且历史不丢、桌面固定导航、前进后退、断开启动错误与重试恢复均通过。最终修正后的整套端口测试复跑因Codex授权额度耗尽未获执行许可；不是测试失败，增量路径已由上述纯单测与构建覆盖。

### F4 — Web管理体验：Settings、Account、Memory、Appearance

- [x] Settings根页只做轻量分组列表；子页动态import、进页取数、离页清理。
- [x] Account组合页：Agent身份/状态/Memory摘要 + 1:N Account连接；删除Agent与删除连接分开；Memory正文只在Agent Memory路由加载。`runtimeCapabilities`真实快照归Phase 5.5，F4只按现有契约实现`null`时的“未连接，能力未知”空态，不虚构能力数据。
- [x] System/Appearance/Paths/Control Center分别独立；配置逐项闭环，Appearance实时预览/保存/null恢复默认，Theme Palette与Appearance Profile分别导入导出；中控台离页停止轮询。
- [x] 路径高风险迁移使用校验/迁移/验证/回滚流程，不提供直接生效文本框。

**验收（2026-07-12完成）**：`npm test` 104/104、gateway/SSE黑盒68/68、`analyze:web`与`git diff --check`通过；默认聊天18,511 / 204,800 bytes gzip，所有F4主体保持独立route chunk。真实浏览器以390×844与1280×900检查全部管理入口，无横向溢出；Account创建→详情、Agent Memory创建、System与Appearance保存后刷新回显、Path受控迁移闸门、Control Center真实file store/联邦未启用空态均通过，浏览器console无error/warn。配置覆盖表中非Phase5/6项已闭环；Agent Memory只验收当前已提前落地的最小编辑闭环，检索注入、Files与派生整理仍归Phase 5；无无效入口或假状态。

### F5 — Web发布与性能基线

- [ ] 在F2已有production build与hash/ETag基础上完成发布复核，并补齐错误边界、断线恢复、无障碍和键盘导航；开发期`no-store`与生产缓存策略继续严格分开，不另造第二套缓存实现。
- [ ] 主页bundle、route chunks、DOM数量、listener/timer/poller和Performance trace纳入自动/人工验收。
- [ ] Chrome桌面、Safari桌面、Android Chrome、iOS Safari跑同一核心场景；把平台差异修在adapter/tokens，不fork页面。

**验收**：ground truth 6.1预算达成；Web版作为三端共享核心冻结一个可回退commit。

**阶段衔接**：F5验收后结束Phase 4.6，回到总体主线，严格按`Phase 5 → Phase 5.5 → Phase 6`推进。Phase 5完成Memory/Files数据层，Phase 5.5完成VPS gateway、Tailscale纯私网、daemon联邦、owner identity、presence与`runtimeCapabilities`；两阶段均验收后才进入原生壳。不得从F5直接跳到Capacitor或三端交付。

## Phase 5 — Memory 与数据层

**目标**：ground truth 第三节的三层数据落地。设计依据：`memory-hook.md`——以《修订：文件库架构》（R1–R6）为准，按第 16 节 MVP 顺序推进。

> 提前量（2026-07-03，与 Theta 确认）：**最小闭环提前落地**——vault 骨架 + 文件格式 + 常驻索引会话首消息注入 + agent 文件工具直读直写 + 手动保存入口（API），形状已收编进 api-contract.md「Memory（最小闭环）」。目的：Phase 3–4「边用边修」阶段长期记忆已可用。检索注入、派生权重、dream 不提前，仍按本阶段推进。
>
> **Vault 位置策略**（2026-07-04，与 Theta 确认 + 联邦形态对齐）：vault 热数据**只在 VPS**（`/home/theta/.vera/memory/`，联邦后 gateway 跑在 VPS），所有 agent daemon 通过 Vera memory API 远程读写，本地不再有"原版"——避免双写冲突/双读漂移，保持 single source of truth。**备份走 git 镜像**：把 VPS vault init 成 git repo，每次整理后 `git push` 到一个私有 GitHub repo；Mac 上 `git pull` 即得只读备份，还能看版本历史（Obsidian vault 全 markdown，git 友好）。rsync 冷备份作次要手段（崩了需要快速回滚时用），不替代 git 镜像的版本维度。Phase 3-4 期间 vault 还在本机 Mac `~/.vera/memory/`，Phase 5.5 联邦落地时随数据 rsync 一起搬 VPS，搬完即切 git 镜像备份流。

- [~] 动工前：memory-hook.md 术语/API 对齐契约（按文档头部整合注记），形状收编进 api-contract.md（最小闭环部分已收编；其余 `/api/agents/:agentId/memory/*` 届时再补）
- [~] 文件库（Obsidian 兼容 vault）+ Raw Event 留 store + 手动"保存到记忆"入口（R1–R2，MVP Step 1–3）（vault + 手动保存提前做；Raw Event 溯源链留本阶段）
- [ ] memory_write_hook（context 容量触发；slug/钩子行质量为第一验收项）+ stain frontmatter 与前端色块（Step 4–5）
- [ ] 三渠道注入：常驻索引（批量换版）、token 计价检索注入（哑墨、同会话去重、尾部放置）、fetch_more / fetch_detail 钻取（R3、R5，Step 6）
- [ ] 派生索引与权重（双链入度、使用统计、置顶；无手工标注）+ dream 维护 subagent（R4，Step 7–8）；整理任务用便宜模型跑批
- [ ] Files 层：Space 内隔离的附件存储
- [ ] 数据层分类实现为可扩展结构，不硬编码枚举

**完成标准**：agent 在 A Space 获得的长期记忆，整理后在 B Space 可用。

## Phase 5.5 — Agent 联邦（VPS gateway + Tailscale纯私网）

**目标**：把当前“gateway + adapter 同机 spawn CLI”形态改成“gateway 在 VPS；手机、Mac与agent daemon全部经Tailscale Serve私网HTTPS接入”的纯私网形态。手机“不走VPN”特指不再同时运行v2rayNG等其他VPN，Tailscale仍保持启用。开源版本也默认纯私网。

**为什么必须做**：
- 用户核心需求是"手机随时随地能联系 Mac 上的 agent"。Mac 单机形态下 Mac sleeps / 切网 / 重启就联系不上。
- cloudflared 边缘漂移假活（2026-07-04 实测，salvage-notes 第 5 条）是历史教训；新设计直接移除 cloudflared 运行依赖，不再为它建设 watchdog。
- 全部控制面和用户面收进tailnet：Mac / 手机 / 另一台VPS daemon可接入；纯第三方云函数若不加入tailnet则不能直连`/api/agent/*`。公网暴露不是当前实现范围。

**契约先行**（已完成，本阶段代码实施前确认对齐）：
- [x] `docs/ground-truth.md` 2.4 节定稿并于2026-07-11修订：4条联邦决策 + Tailscale Serve纯私网 + 手机/Mac接入语义 + owner Tailscale identity + agent token + 心跳退出协议 + AgentState per-Space
- [x] `docs/adapter-interface.md` 重写为 agent daemon 协议（旧 gateway-spawn 形态移附录 A）
- [x] `docs/api-contract.md` 加`/api/agent/*`路由前缀 + Account.presence/lastSeenAt + AgentState per-Space扩展态 + 联邦事件 + 离线@Activity + owner Tailscale identity / agent token边界
- [x] `docs/reference/vps-tunnel-deploy.md` 重写为VPS单一gateway + Tailscale Serve纯私网部署指南

**代码实施清单**（按依赖序）：

- [ ] **5.5.1 AgentState per-Space 改造**（最浅，先做）：`src/agents/agent-state.js` 跟踪键 `agentId` → `agentId:spaceId`；形状加 `spaceId` + `detail` 字段；`status` 枚举扩到 `idle/thinking/typing/reading/coding/reviewing/on_task/away`；`/api/agent-states` 支持 `?spaceId` / `?agentId` 过滤；契约 + 4.1 已建跟踪器同步改。verify.mjs 加 per-Space 测试。
- [ ] **5.5.2 Account.presence + 离线 @ 行为**：Account 形状加 `presence` / `lastSeenAt` 字段；`src/agents/accounts.js` 暴露 `setPresence`；`src/spaces/messages.js` 的 `shouldRespond` 加在线判定：offline 则不创建 run，改在 Space 时间线 insert 一条 `phase:"error", label:"agent-offline"` 的 Activity；SSE 加 `account.presence.updated` 事件。verify.mjs 加离线 @ 测试。
- [ ] **5.5.3 Agent token 体系**：`src/core/agent-tokens.js` 新建——加载 `~/.vera/agent-tokens.json`，校验 Bearer token → 返回 agentId；token 文件格式 `{ "agt_xxx": "<long-random>", … }`，新建 agent 时自动生成一条；gateway 启动加载、不进 repo。tailnet ACL只做网络门禁，不替代此token。
- [ ] **5.5.4 Tailscale owner identity + 入口权限**：gateway只信任本机Tailscale Serve注入并去伪造的identity headers；普通API/SSE要求login命中`config.security.ownerTailscaleLogins`；生产列表为空时拒绝业务API。原生CORS使用配置化精确Origin白名单，不自建配对码/device session。
- [ ] **5.5.5 `/api/agent/*` 路由层**：`src/api/agent-routes.js` 新建——所有 `/api/agent/*` 走 Bearer token 中间件识别身份；`POST /api/agent/login` 接收并暂存 `runtimeCapabilities`、返回 agent/account/seats/sessionStates/runtimeCapabilities/heartbeatIntervalMs，离线清空能力快照；其余为daemon登录、SSE、run回传和sessionState同步接口。
- [ ] **5.5.6 Run 触发链路改造**：`src/spaces/messages.js` 不再 sync 调 `executeRun`；在线seat创建Run并通过daemon SSE推`run.requested`，离线走5.5.2 Activity路径；编译层抽出`src/spaces/view-compiler.js`。mock adapter保留给gateway内部一致性测试。
- [ ] **5.5.7 `scripts/agent-daemon.js`**：新进程，启动读Tailscale私网gateway URL / agent token / CLI binary path / workspace（不再有Cloudflare Service Token），报告runtimeCapabilities并跑完整HTTP/SSE协议；心跳缺失3次后exit(0)，不得私网失败后fallback到公网域名。
- [ ] **5.5.8 mock daemon + verify.mjs 拆分**：起mock daemon走login → run.requested → delta → activity → message → completed → sync-state → logout；gateway内部一致性测试保留旧mock adapter路径。
- [ ] **5.5.9 VPS纯私网部署落地**：完成数据迁移、gateway systemd、VPS加入tailnet、Tailscale Serve、ACL、owner login配置、SSE逐帧和公网不可达验收；不安装公网反向代理，不启用Funnel。
- [ ] **5.5.10 本机清理**：停旧Mac gateway与cloudflared自启；旧数据和cloudflared配置只留冷备份；验证Mac daemon与手机客户端均经Tailscale访问VPS，其他手机App仍直连公网。

**完成标准**：
1. `scripts/verify.mjs` 全过（含 mock daemon 端到端协议测试 + 离线 @ error activity + per-Space AgentState + 心跳缺失 daemon 自杀）
2. VPS上gateway + Tailscale Serve active；未加入tailnet的设备无法访问任何Vera页面/API，公网3210/443均无Vera入口
3. 手机蜂窝网络下 @ 在线 agent（daemon 在 Mac）→ 流式回复正常到达；@ 离线 agent → 时间线一行 error 提示 + 不创建 Run
4. 重启VPS gateway → Mac daemon经Tailscale自动重连并取回sessionState；手机Tailscale身份仍有效且SSE按since恢复
5. 停 VPS gateway → Mac daemon 在 ~45s 内 exit(0)，不反复撞网关；恢复 gateway 后手动起 daemon 重新登录正常

## Phase 6 — 原生客户端、适配补全与扩展

> 本节是唯一的三端、原生适配与Extension执行清单，不再维护另一套跨Phase的F6–F9时间轴。为保持`AGENTS.md`的授权用语，6.0保留`F6`别名：只有Phase 5与5.5均完成、F5冻结的Web基线仍通过、6.0/F6被标为进行中，且用户在当前任务明确授权进入F6后，才可生成原生工程。按6.0→6.6依赖序推进，不并行跳项。

- [ ] **6.0 / F6 仓库结构与共享平台闸门**：`AGENTS.md`已预先放行单一Capacitor配置及生成的`android/`、`ios/`，但不构成执行授权。获当前任务明确授权并将本项标为进行中后，引入Capacitor，`webDir`指向F5冻结的共享Web产物，原生工程不复制业务JS/CSS；platform adapter补Android/iOS实现，根节点设置`data-platform`，统一gateway URL、fetch/SSE、secure storage、notification、file picker、keyboard/back、haptics与external auth/link；建立共享测试矩阵和构建脚本命名，平台特有代码只在bridge/原生壳。验收同一Web产物可被网页、Android、iOS加载，业务view无Capacitor直接import且Web fallback全过。
- [ ] **6.1 Android**：生成独立Android壳，接入运行时gateway选择/安全存储、系统返回、键盘、安全区、前后台SSE恢复、通知权限与文件选择；真机验证蜂窝网络、锁屏/切后台、旋转/字体缩放、冷启动、长时间线及接口就绪后的上传/下载；固定`build:android:debug`与安装脚本，调试APK产物路径只写入本项验收记录、不进repo。完成标准为真实Android设备跑通登录/选Space/发消息/@/Approval/设置保存/断线重连，达到性能预算且无平台专属业务页面。
- [ ] **6.2 iOS**：生成独立iOS壳，处理WKWebView safe-area、键盘、返回手势、外部认证回跳、通知权限、ATS与前后台SSE恢复；Xcode模拟器先跑共享矩阵，再上真机验证蜂窝网络、锁屏/切后台、字体缩放和文件选择；固定`build:ios:simulator`与archive校验流程，签名、Provisioning及TestFlight/App Store发布留到6.6。完成标准为iPhone模拟器和至少一台真机通过与Android相同核心场景，平台差异只存在于adapter/壳。
- [ ] **6.3 CLI/API daemon适配补全**：Claude Code（`--resume`）、Codex及API tool-call host；全部复用Phase 5.5 daemon协议与RuntimeCapabilities，不回到gateway spawn。
- [ ] **6.4 联邦能力与配置补全**：Skill管理、Tools policy与`runtimeCapabilities`展示逐项闭环；Appearance的产品配置与Web闭环归F4，本项只验证三端读取同一gateway保存值，并处理不可编辑的safe-area/输入法平台叠加，不再重做主题系统。
- [ ] **6.5 Extension体系**：先完成Extension Package manifest/安装/版本/权限契约，再实现Skill/MCP/Hook各自runtime、daemon侧Agent Plugin与隔离Space Module；Settings负责全局安装，Account/Space分别启用，不建万能Plugin runtime。Space Module使用可销毁sandbox并提供Web/Android/iOS一致bridge，未启用时零加载、崩溃不影响聊天Shell；第三方代码不得直接进入主DOM或持有gateway/secrets/宿主文件权限。
- [ ] **6.6 原生发布与三端回归**：F5冻结的Web production缓存与性能基线只做回归，不在本项重建；完成Android release、iOS archive/TestFlight准备、三端共享核心场景与性能矩阵、Extension安装/卸载/升级/权限变更回归，并冻结可回退版本。签名、Provisioning、TestFlight/App Store正式发布作为独立发布步骤，不混进UI实现。
- [ ] ~~gateway launchd常驻 + 崩溃自愈~~ —— **提前到Phase 5.5，形态改为VPS systemd + agent daemon launchd/systemd双层**。

**完成标准**：ground truth第四节可配置项逐项对勾；Web、Android、iOS共享业务代码和gateway事实来源；三端核心场景、性能预算、断线恢复与安全边界全部通过；Appearance共享且扩展按需加载，任一平台或扩展失败不拖垮gateway与其他客户端。

---

## 明确不做（0.0.1 范围外）

- 多用户、账号体系
- agent 间自主调度的复杂授权模型（先做最简开关）
- 桌面客户端（网页在 Mac 浏览器里就是桌面版）
