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
  - 2026-07-14补充provider adapter创建规范：按协议/生命周期复用而非按模型建文件；固定run/digest、schema下沉、错误/取消/secret边界与stub→临时gateway→真实provider三层闸门，不增加BaseAdapter或动态注册表

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
> 1. Agent/Account 拆分是其余一切的地基——聊天联系人按Agent/Agent成员集合建模，Account只提供背后连接与运行上下文，不让“Account=联系人”渗进代码。**历史说明（2026-07-13）**：本阶段当时按 `Agent 1:N Account` / seat或登录选择Account推进；当前ground truth已改为 `Agent 1:1 Home Account` + per-Execution Account绑定，旧形态保留为完成记录并待Phase 5.5一次迁移，不再作为新实现依据。
> 2. 多 agent 前，prompt/message 编译层须独立成形。现 `postMessage` 只 fan-out，`run-controller` 只把触发消息交给 adapter，最多首轮前置 resident memory；ground truth 2.3 的"署名注入、不占 assistant 角色、补发错过发言"塞不进 `messages.js` / `run-controller.js`，应抽出清晰的 Space→Agent 视角编译层（ground-truth.md:69、`src/spaces/messages.js:50`、`src/spaces/run-controller.js:64`）。编译层是 4.1 之后、前端之前的纯后端步骤，可 curl/`verify.mjs` 验收，不依赖 UI。
> 3. 前端当前是合格的 Phase 3 控制台（默认拿第一个 Space、只发 broadcast、状态围绕单条时间线组织），不是 Phase 4 壳子。新版不保留底部标签：主页是全屏聊天，左上进当前Space设置、右上进全局Settings、右滑进“联系人头像 → Space列表”导航。前端先一次替换全局Shell，随后按领域纵向落地；不把所有页面堆进一次大改，也不在旧页上边用边长。
>
> 即：`4.1 拆分 → 4.2 编译层 → 4.3 响应规则/AgentState → 4.4 Space 管理 → 4.5 系统配置 → 4.6 前端契约/Shell/领域页面/验收`。4.2–4.5 期间所有新增字段用 curl/`verify.mjs` 验收；4.6 每个子阶段保持可运行，禁止先造巨石再回头拆。

- [x] **4.1 Agent/Account 拆分**（历史完成形态，2026-07-13起待迁移）：契约先行（见 api-contract.md 二「Agent」「Account」「Space」）；当时新增 Account 形状（`owningAgentId` + kind/provider/connection/model），并把 `sessionState` 键由 `(agentId, spaceId)` 改为 `(accountId, spaceId)`，完成Agent与Account对象分域。此条如实记录Phase 4已完成代码，**其中 `Agent 1:N Account`、seat/登录选择Account及 `owningAgentId` 旧语义不再是当前设计**；Phase 5.5须迁移为每Agent一个Home Account、每Execution显式绑定一个Account，且不得伪称此处已经完成新模型。
- [x] **4.2 Speaker view 编译层**：新模块 `src/spaces/view-compiler.js`，输入 `(store, space, agentId, account, triggerMessage)` 输出 prompt 文本；`run-controller.runAsync` 调它替换手拼 promptText，`messages.js` 触发 fan-out 不变。按 ground truth 2.3（2026-07-04 补三条）实现：
  - **只 inject message，不 inject activity**——思考链/工具链不进任何 agent 的下次 prompt（包括本人，本人工具历史由 adapter sessionState 携带）。这是"发言 ≠ 过程"的边界。Phase 5 的 `fetch_detail`/`fetch_more` 主动调阅是这边的逃生口（按需、带预算），Phase 4 不实现但接口留位。
  - **群聊视角以声告段注入，不伪装一对一 user 历史轮次**：派生该 agent 上次本人发言（按其最后一次 assistant 气泡的 createdAt）到当前触发之间的他人气泡，聚合成"=== 群内最近发言 ===\n- <name>: <气泡>…"声告段，塞进 `ctx.prompt.text` 头部；CLI 型直送新轮、API 型落在新 user 消息尾部（不进稳定历史）。模型历史里 assistant 永远是自己、user 永远是用户的直接提问，旧群状态每轮过期作废。
  - **编译层无状态**：每次 run 临时查 `messages.json` 派生 delta，不维护"已投递水位"；幂等。注入段配置上限（最近 N 条/总字数上限，超了提示"更早的见 fetch_detail"）放 `src/core/config.js`，不硬编码。常驻索引块仅随新 (account, Space) 首次注入，逻辑从 run-controller 搬来——它与群聊 delta 同属 prompt 头部但是两段（索引是稳定前缀、群状态是 volatile tail 不混淆）。
- [x] **4.3 响应规则收口**：`silent` 的 `respondTo` 字段从 `[P4]` 落地——seat 形 `{agentId, responseMode, respondTo?, blockAgentIds?}`，`respondTo` 成员为 `"user"` 或 `agt_...`；新增 `blockAgentIds: ["agt_..."]` 屏蔽名单（ground truth 2.3 2026-07-04 补"响应规则统一语义"）。判定逻辑两层：`messages.js` 的 `shouldRespond` 看 responseMode/respondTo/target 决定要不要建 run；编译层 `compilePrompt` 内按 `blockAgentIds` 过滤声告段（被 block 的 agent 气泡不进段，但定向 @ 仍穿透 blockAgentIds 创建 run——不穿透 silent/focused）。AgentState 层确认 bootstrap/GA 已完整返回（Phase 2–3 已建 tracker，对勾即可）。
- [x] **4.4 Space 管理**（历史完成形态）：`normalizeSeat`去掉`accountId`；当时按登录级或默认owning account解释，store已清理4.1 backfill到seat上的`accountId`，session-states键不动。当前账户选择已改为per-Execution绑定；旧“登录级选择Account”只记录当时实现，不再指导新代码。
- [x] **4.5 系统配置**：新增 `GET/PATCH /api/settings`，字段以 ground truth 4.1 为唯一清单（数据隔离规则、记忆整理触发/注入预算、消息呈现等），严格遵守不扩；运维参数仍走 env 不进前端（ground truth 4.1 末段边界注记）。持久化进 `data/settings.json`（store 新集合），config 作启动默认、settings 作运行时覆盖。
- [x] **4.6 前端正式布局**：按 ground truth 5.1–5.4 分阶段推进，手机竖屏第一公民；使用简单hash路由，不为路由引入UI框架。
  - [x] **4.6.0 文档契约（2026-07-10）**：ground truth 已定全屏聊天主页、当前Space设置、右滑双栏Space导航、全局Settings、Account组合管理、配置闭环、提前拆分与页面完成标准；API契约已补 Appearance（含Theme/Profile边界与安全导入导出）、Space提醒、Space归档/恢复及Account组合读取边界。本步不改前端代码。
  - [x] **4.6.1 可调雏形 + Shell（2026-07-11）**：可调雏形与默认tokens由F0完成，F2落全局app runtime、route lifecycle与旧时间线挂载；F3已完成无底部标签、左上当前Space设置、右上全局Settings及手机/桌面Shell交互并通过真实浏览器验收。
  - [x] **4.6.2 基础层提前拆分（2026-07-11）**：已移除 `api/gateway-client.js`，按领域拆成 `http` / `spaces` / `agents` / `accounts` / `settings` / `memory` / `extensions` / `status` / `events` clients；state 已拆 router、全局app runtime、platform、Space导航/时间线、Account、Settings、Extension边界；样式已拆 `tokens.css`（变量唯一来源）/ `base.css` / `shell.css` / `chat.css`，旧巨型 `theme.css` 已移除。聊天route显式mount/unmount，全局runtime唯一持有SSE并处理reset水位，timeline state与DOM同步限制200项。
  - [x] **4.6.3 全屏聊天 + Space导航/设置闭环（2026-07-11，2026-07-13简化导航状态）**：F3已拆分聊天、导航与Space设置职责；手机右滑或点顶栏左上开关打开导航，打开期间切换Space保持展开，不再提供图钉或持久化固定状态；已完成Space切换、新增、重命名、二次确认归档与恢复，以及参与Agent、Seat响应规则和notifications。Space Module区继续等Phase 6契约/后端就绪后再显示，不建假开关；composer只属于聊天主页，设置路由替换聊天主区而不与时间线纵向叠放。
  - [x] **4.6.4 Account组合管理 + Agent Memory闭环（2026-07-12，旧形态待迁移）**：只有 `#/settings/accounts` 一个管理入口；`account-list-view.js`、`account-detail-view.js`、`agent-memory-view.js` 分开。详情当时按一个Agent展示一个或多个Account连接，API/state仍按Agent和Account分域；该 `1:N` 展示是已完成历史形态，须在Phase 5.5随契约改为Home Account + 其他Account授权策略。Memory只在进入对应Agent子路由时加载正文，且继续归Agent。
  - [x] **4.6.5 Setting子页闭环（2026-07-12，2026-07-13移除无依据分组）**：`settings-index-view.js`、`system-settings-view.js`、`appearance-view.js`、`path-settings-view.js`、`control-center-view.js` 分开；设置首页只平铺入口，不预取子页数据。Appearance预览只改内存CSS变量，保存走gateway，按组恢复默认传 `null`。中控台进入时才取状态/轮询，离开即停止；当前file store显示存储状态，不虚构数据库连接。Extension Package管理等Phase 6契约落地后加入。
  - [x] **4.6.6 真实运行与性能验收（2026-07-13）**：路由/state单测和 `scripts/verify.mjs` 端到端已补齐；临时gateway实测API与逐条SSE通过。Chrome/Safari桌面与Android Chrome/iOS Safari Web人工矩阵已由用户确认结束，覆盖deep-link刷新、前进后退、虚拟键盘、安全区、loading/empty/error/offline/长内容与最新消息可见；Android WebView/iOS WKWebView留Phase 6原生壳回归。bundle/Performance trace达到ground truth 6.1预算，时间线DOM保持≤200 items，路由离页资源清理已纳入测试。

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

**完成标准**：手机蜂窝网络下，主页无底部标签且当前Space聊天占满主区；右滑双栏可按Agent/群切换、新增、重命名、归档和恢复Space，打开期间切换Space不收起，历史与sessionState不丢；左上目录开关、中间当前Space设置与右上全局Settings职责不串且设置页替换聊天主区；≥2 agents 的 Space 完成一次广播 + 一次定向，被 @ 的 agent 回复prompt含他人署名发言且无误用assistant角色；4.6范围内配置项前端可达且consumer真实生效。`scripts/verify.mjs` 加对应端到端。

## Phase 4.6 Web交付路线（新窗口执行入口）

> 交付状态（2026-07-13）：F0–F5已完成，Web共享核心已冻结；下一步回到总体主线进入Phase 5。Android/iOS壳统一留到Phase 6，须继续遵守Phase 5 → Phase 5.5 → Phase 6的阶段顺序。

### F0 — 参考图与可调UI Lab

- [x] 收齐用户已有示意图（2026-07-10：4张手机参考图，用户未提供单独桌面图），已在本轮UI Lab逐张标注“保留结构 / 只借视觉 / 不采用”；桌面形态由同一雏形响应式推演，不另造业务实现。
- [x] 在Codex可视化制作可交互雏形（2026-07-10，后续交互以2026-07-13最终边界为准）：全屏聊天、右滑双栏Space导航、当前Space设置、Settings目录、Account组合页；手机无边缘常驻按钮，顶栏左上提供非手势目录开关；目录打开期间常驻，不再提供图钉状态；设置路由替换聊天主区。支持390px手机与桌面宽屏切换。
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
- [x] 右滑双栏导航：左侧Agent/群头像投影，右侧对应活跃Space列表；手机右滑+顶栏左上目录开关，打开期间切换Space保持展开，不再提供图钉或持久化固定状态；支持切换、新增、重命名、二次确认归档及从“已归档Spaces”恢复，不提供永久删除。
- [x] 当前Space设置：参与Agent、Seat responseMode/respondTo/blockAgentIds、消息提醒；Space Module区在Phase 6前不显示。
- [x] 真实gateway/SSE运行验证手机浏览器与桌面浏览器；处理loading/empty/error/offline/长时间线。

**验收（2026-07-11完成；导航固定控件于2026-07-13移除）**：完整单测96/96、gateway/SSE黑盒65/65通过；subagent最终审查后的竞态/reset/多Run修正另跑前端与Space纯单测37/37、`analyze:web`与`git diff --check`通过，默认聊天16,854 / 204,800 bytes gzip。真实浏览器完成390×844与1280×900验收：无横向溢出，消息发送、Space设置保存回显、新建/改名/归档/恢复且历史不丢、目录展开布局、前进后退、断开启动错误与重试恢复均通过。最终修正后的整套端口测试复跑因Codex授权额度耗尽未获执行许可；不是测试失败，增量路径已由上述纯单测与构建覆盖。

### F4 — Web管理体验：Settings、Account、Memory、Appearance

- [x] Settings根页只做轻量分组列表；子页动态import、进页取数、离页清理。
- [x] Account组合页（历史完成形态，待Phase 5.5迁移）：Agent身份/状态/Memory摘要 + 当时的1:N Account连接；删除Agent与删除连接分开；Memory正文只在Agent Memory路由加载。当前设计已取消1:N所有权，页面后续改为一个Home Account + 其他Account的授权策略；`runtimeCapabilities`真实快照仍归Phase 5.5。
- [x] System/Appearance/Paths/Control Center分别独立；配置逐项闭环，Appearance实时预览/保存/null恢复默认，Theme Palette与Appearance Profile分别导入导出；中控台离页停止轮询。
- [x] 路径高风险迁移使用校验/迁移/验证/回滚流程，不提供直接生效文本框。

**验收（2026-07-12完成）**：`npm test` 104/104、gateway/SSE黑盒68/68、`analyze:web`与`git diff --check`通过；默认聊天18,511 / 204,800 bytes gzip，所有F4主体保持独立route chunk。真实浏览器以390×844与1280×900检查全部管理入口，无横向溢出；Account创建→详情、Agent Memory创建、System与Appearance保存后刷新回显、Path受控迁移闸门、Control Center真实file store/联邦未启用空态均通过，浏览器console无error/warn。配置覆盖表中非Phase5/6项已闭环；Agent Memory只验收当前已提前落地的最小编辑闭环，检索注入、Files与派生整理仍归Phase 5；无无效入口或假状态。

### F5 — Web发布与性能基线

- [x] 在F2已有production build与hash/ETag基础上完成发布复核，并补齐错误边界、断线恢复、无障碍和键盘导航；开发期`no-store`与生产缓存策略继续严格分开，不另造第二套缓存实现。
- [x] 主页bundle、route chunks、DOM数量、listener/timer/poller和Performance trace纳入自动/人工验收。自动验收负责bundle预算、route chunk隔离、DOM上限及route lifecycle资源清理；Performance trace保留设备/浏览器人工证据。
- [x] Chrome桌面、Safari桌面、Android Chrome、iOS Safari跑同一核心场景；把平台差异修在adapter/tokens，不fork页面。统一场景为冷启动进入聊天、发送消息、打开/关闭Space导航、进入并返回Settings、断线后恢复；桌面同时验收完整键盘路径，移动端同时验收390px、安全区与虚拟键盘。

> 2026-07-12 执行顺序：用户确认F5先完成电脑端（Chrome桌面 + Safari桌面），再补Android Chrome与iOS Safari。Android WebView / iOS WKWebView不属于F5，统一留到Phase 6原生壳生成后的共享核心回归。

**验收（2026-07-13完成）**：共享Web核心已补页面级可重试错误边界、联网后立即SSE重连、bfcache恢复、导航与dialog焦点闭环、live region、可见键盘焦点，以及取消脏表单离页时的URL回退；管理route动态隔离和时间线200-item DOM上限已纳入`analyze:web`断言。最终自动验收为`npm test` 113/113、gateway/SSE黑盒68/68、默认聊天19,434 / 204,800 bytes gzip、11个dynamic route chunks、`git diff --check`通过；production HTML保持`no-cache` + ETag，hash资源保持一年immutable。Chrome/Safari桌面与Android Chrome/iOS Safari人工矩阵及Performance trace由用户确认验收结束，Web共享核心冻结。

> 2026-07-13 导航/设置最终边界（用户再次确认，前一版“全屏目录页”和pin状态均作废）：Space目录是聊天页内可折叠的左侧双列抽屉，右滑与聊天顶栏左上按钮共用开关；展开时把聊天向右挤窄，打开期间切换Space保持展开，不再提供pin或持久化固定状态。顶栏Space名称进入当前Space设置。目录不进入任何设置路由；当前Space设置与所有全局Settings页面均为独立全屏页，顶栏左上统一放返回、中央放唯一页面标题，正文不再重复标题/返回。

**验收**：ground truth 6.1预算达成；Web版作为三端共享核心冻结一个可回退commit。

**阶段衔接**：F5验收后结束Phase 4.6，回到总体主线，严格按`Phase 5 → Phase 5.5 → Phase 6`推进。Phase 5完成Memory/Files数据层，Phase 5.5完成VPS gateway、Tailscale纯私网、daemon联邦、owner identity、presence与`runtimeCapabilities`；两阶段均验收后才进入原生壳。不得从F5直接跳到Capacitor或三端交付。

## Phase 5 — Memory 与数据层

**目标**：完成 Memory / Files 数据层闭环，并为 Phase 5.5 的 per-Space AgentState 与远程 daemon 接入提供稳定契约。设计依据：`ground-truth.md` 第三、四节 + `memory-hook.md`《修订：文件库架构》（R1–R6）；旧文中的 SQL、`room_id` / `session_id`、`/memory/*` 只作设计素材，不可直接照抄实现。

> 提前量（2026-07-03，与 Theta 确认）：**最小闭环提前落地**——vault骨架+文件格式+常驻索引会话首消息注入+手动保存入口（API）。**2026-07-13边界修订**：旧“agent文件工具直读直写”已废止，M1起所有程序写入统一提交gateway单写者。**2026-07-13 MCP修订**：Vera Memory自身是gateway第一方per-Agent MCP服务；Agent runtime的读写/检索统一走MCP，owner前端HTTP仅为管理入口。检索注入、派生权重、dream仍按本阶段推进。
>
> **Vault 位置策略**（2026-07-04，与 Theta 确认 + 联邦形态对齐）：vault 热数据**只在 VPS**（`/home/theta/.vera/memory/`，联邦后 gateway 跑在 VPS），所有agent daemon通过gateway第一方Vera Memory MCP远程读写，本地不再有“原版”——避免双写冲突/双读漂移，保持single source of truth。**备份走git镜像**：把VPS vault init成git repo，每次整理后`git push`到私有GitHub repo；Mac上`git pull`只读备份并查看版本历史。rsync冷备份作次要手段，不替代git镜像的版本维度。Phase 3-4期间vault仍在本机Mac，Phase 5.5联邦落地时随数据迁到VPS并接通带agent token的MCP transport。

**执行规则**：依赖顺序固定为 D0 → M1 → M1.5（Memory MCP facade）→ M2 → M3 →（M4 与 F1 可由不重叠文件的 subagent 并行）→ X1；每个切片的细化契约是该切片第一项，先改契约、再实现、再以临时数据目录验收并独立提交。D0只冻结跨切片不应再变化的身份/作用域/写入边界；M1未建立单写者与溯源链前不得接自动写入；M1.5未冻结无agentId工具与可信身份上下文前M2/M3不得另造adapter私有接口；M3未证明预算与哑墨边界前不得接dream；X1必须等待M4/F1都完成后统一收口。

### P5-D0 — 文档与契约冻结

- [x] `memory-hook.md` 已于2026-07-13冻结现行边界：现行路由为per-Agent slug API；旧`room_id/session_id/memory_id`、SQL与`/memory/*`仅保留为显式历史算法素材，SQL只表示可重建派生索引，不是权威Schema。
- [x] 三项产品语义已由用户于2026-07-13确认，契约必须一次改干净：① slug在对应Agent分区内创建后永久不可改名，删除PATCH `newSlug` 与rename别名；② 长期Memory为per-Agent私有、跨Space并跟随该Agent的所有Execution，不存在所有Agent隐式共享池（显式共享须未来另补scope/授权/来源契约）；③ 主Agent、subagent、CLI adapter、hook与dream等所有程序写入统一提交gateway单写者，禁止直写vault，Obsidian用户编辑仅作为外部变更重扫。
- [x] 冻结Agent/Account/Execution/Workspace关系：每个Agent恰有一个Home Account与独立Memory；取消旧 `Agent 1:N Account` 所有权；每个Execution固定绑定一个Account，主Execution保留Home Account，subagent可在 `authorizedAgentIds` 授权后使用其他Account；每个Account同一时刻只允许一个活跃Execution租约。Workspace、`sessionState`和运行数据按 `accountId` 隔离，Account 1:1 Workspace；实际文件在daemon宿主，gateway只保存绑定、策略、状态与校验信息。此项本轮只冻结文档，现有Phase 4代码/UI仍是待迁移旧形态。
- [x] Phase边界已对齐：M1–M4只实现Memory；Files在F1；Home Account/Execution租约/per-Account Workspace、per-Space AgentState、presence、daemon token、VPS/Tailscale均留Phase 5.5。数据层可扩展不等于预建插件注册表。

**D0验收（2026-07-13完成）**：`ground-truth.md`、`api-contract.md`、`adapter-interface.md`、`memory-hook.md`已统一Home Account / Execution / Workspace、Account唯一活跃租约、per-Agent Memory、slug不可改名与gateway单写者；旧1:N代码/UI明确标为待Phase 5.5迁移，没有伪造成已实现。下一窗口直接从M1开始。

### P5-M1 — Memory 权威层、单写者与溯源

- [x] **M1契约先行**：`api-contract.md`已钉死权威frontmatter/SourceRef、手动来源、gateway operation、外部Obsidian变更、per-Agent写队列、原子替换、409当前版本、坏文件隔离与派生索引重建形状；只补M1实际consumer，未提前定义M2/M3 worker/API。
- [x] 在现有 `src/memory/` 内完成 vault 权威层，未新建领域目录：所有 gateway 写入进入串行队列并使用同目录临时文件 + fsync + 原子提交；读取仍以 markdown 为真相；外部 Obsidian 修改通过可重建扫描/索引刷新进入系统，坏文件隔离报错但不吞掉其他记忆。
- [x] 按冻结契约扩展 frontmatter 与校验，建立 `sources` → store 中原始 Message 的可追溯链；Raw Message继续按Space隔离，M1仅接受`message/manual`两种SourceRef，Activity/工具过程不作为来源。
- [x] vault按 `agentId` 分区；手动 CRUD 已收紧到slug永久不可改名、归档、删除与opaque version并发控制；409返回当前权威版本供前端重载。程序写入统一进入精确`MemoryOperation`与memory单写者，未保留rename/直写兼容别名。
- [x] 已迁移`isolation.memory`旧`globalReadable/perSpace` override为固定`isolated`并移除对应UI选项：Raw Message仍随Space权限隔离，长期Memory固定per-Agent跨Space；旧值写入返回400。
- [x] 已建立派生索引的版本、内容指纹、失效与原子重建机制；缺失、语法/语义损坏的索引可仅凭 vault + store source 重建，索引降级不损坏或遮蔽 markdown 权威数据。

**M1 验收**：并发写同一 slug 不丢数据；进程在写入中断后旧文件或新文件至少一份完整可读；外部编辑能被重扫发现；坏 frontmatter 有可见错误；任一记忆可沿 sources 回到正确 Space 的原始记录；清空派生索引后重建结果等价。

**M1验收（2026-07-13完成）**：`npm test` 113/113、真实临时gateway黑盒68/68、Memory/迁移/中断定向测试17/17、`build:web`、全部改动文件`node --check`与`git diff --check`通过。并发create与同version并发update均一胜一409且败者拿到当前权威版本；exclusive迁移期间新写只落新vault；模拟temp写完、rename前中断后旧文件仍完整；外部create/update/remove、坏文件隔离与前端可见诊断、Message SourceRef→正确Space、索引缺失/语法及语义损坏重建等价均有自动化证据。独立终审未发现剩余阻断或高风险，且确认未进入M2/M3。

### P5-M1.5 — Vera Memory MCP facade（M2前置）

- [x] 契约先行：Vera Memory为gateway第一方per-Agent MCP；tool schema不含`agentId/scope/origin/sources`，身份与SourceRefs只从可信Execution上下文注入；owner HTTP继续管理但与MCP共用Memory facade/queue。
- [x] 实现协议无关MCP dispatcher与M1工具：`memory_list/fetch_detail/create/update/archive`；create无可信Message SourceRefs即拒绝，Agent MCP不开放不可逆delete，不保留文件直读逃生口。
- [x] 当前阶段不注册不安全网络transport；Phase 5.5 agent token落地后再绑定Tailscale私网Streamable HTTP。dispatcher单测已证明agent A不能通过参数选择agent B、MCP写入进入同一version/queue语义。

**M1.5验收**：MCP tool schema无agentId；可信agent上下文下list/fetch_detail/create/update/archive闭环；错误使用标准MCP tool error；HTTP与MCP读取同一权威文件；无来源create拒绝且vault不变；未出现第二份Raw Message或第二套Memory实现。

**M1.5验收（2026-07-13完成）**：新增gateway第一方MCP JSON-RPC dispatcher与5个M1 tools；4项MCP定向测试覆盖无`agentId/source` schema、可信Message SourceRefs、跨Agent参数冒充拒绝、无来源拒绝、create/list/fetch_detail/update/archive及标准tool error。常驻索引不再泄露vault路径并改为提示`memory_fetch_detail`。`npm test` 117/117、`build:web`、相关`node --check`与`git diff --check`通过；未注册无agent token保护的网络transport，未提前进入M2/M3。

### P5-M2 — memory_write_hook 与触发器

- [x] **M2契约先行**：`scheduled/realtime`为互斥自动策略、manual始终可用；realtime统一按已保存completed Message的Unicode字符水位，默认16000；Run结束不冒充session-end dream，兜底归M4。事实地址/值由结构槽规范化后派生且不进frontmatter；同事实保留原slug并合并SourceRefs，明确纠错才允许同slug supersede，模糊匹配跳过。
- [x] M2只从gateway已全量保存的Message范围创建`memory_digest` job，不引入Aelios式重复Raw ingest；MCP tool只提交消息范围/模式，SourceRefs由gateway从可信run/message上下文生成。
- [x] 程序侧已完成确定性分块、per-Agent事实目录、proposal全量预校验、持久proposal/receipt与M1单写者应用；模型只能返回严格proposal，不能接触store/vault。现有OpenCode adapter已完成独立临时目录、全Tools deny、structured session与仅Navy结构化额度机器码触发一次免费V4 Flash的stub闭环，绝不改变聊天或Account模型。
- [x] 已接通 `memory.digestTrigger` 的 `scheduled` / `realtime` / `manual` consumer 与五段cron；实时阈值只用Unicode字符水位，M2不实现session-end dream。无关Settings更新不越过cron触发catch-up，成功watermark使用持久toSeq不因后续可见性变化倒退。
- [x] 新provider adapter规范已冻结：一个adapter对应一套协议/生命周期，同provider多Account/模型复用；生产provider必须有`run(ctx)`，承担M2时再实现隔离`digestMemory`；固定kind/provider fail-fast、会话/stream、schema下沉、错误、取消、secret、资源清理和三层conformance闸门，不预建基类/注册表。
- [ ] 新增完整原生Ollama adapter：只接受`kind=api, provider=ollama`，以Account `connection.baseUrl`直连`/api/chat`，实现聊天stream/history连续性与隔离digest；对0.23.2使用无`oneOf/patternProperties/pattern`的兼容transport schema，返回后仍走gateway完整validator。不得经过OpenCode，也不得做digest-only adapter。
- [ ] 在`test/adapters/`固化行为型conformance夹具并同时回归Ollama/OpenCode：共享的只是kind/provider、stream/session、错误/取消/timeout、secret、cleanup和digest隔离断言，不抽取运行时BaseAdapter；再以临时gateway黑盒和各自显式真实provider smoke完成后两层闸门。
- [ ] slug/钩子行、source、双链、stain裸hex、同事实targetFactId、手动Memory adopt与纠错supersede校验已落地；fact catalog还须把现有`type`提供给executor并验证update/supersede不会因不可见旧分类而无意改类；无复用价值/无来源推断/agent自创偏好的最终语义判断仍等待真实`digestMemory`执行者接入后用固定raw夹具完成生产路径验收。
- [x] hook入队不阻塞聊天；单Memory写入原子，失败/重试/取消有持久可观察job状态、幂等键与安全SSE，重试复用已flush proposal并续跑未应用receipt，不重复创建Memory。

**M2 验收**：使用固定raw events夹具覆盖create/update/archive/skip/重复重试；同一事实换措辞、换建议slug、跨job再次出现仍只落一条Memory，纠错取代旧事实时双方sources可追溯；定时、容量、手动三种触发走同一pipeline；非法proposal全部拒绝且vault不变；聊天run不等待整理完成；测试日志/API不泄露provider secret或stain解释。

真实executor补充验收分两条独立路径：Ollama/Gemma API Account必须由原生Ollama adapter直连并成功完成chat+digest，OpenCode/Navy CLI Account必须由OpenCode adapter成功完成chat+digest；两条digest请求均无Memory Tools/Workspace且返回再过gateway完整validator，chat则按各provider真实能力与Approval契约执行。Navy primary成功时不调用Flash，结构化额度机器码时恰好用新session重试一次Flash且Account.model不变；单独HTTP 402/403/429、自由文本、timeout、network、auth、model-not-found、invalid structured proposal均不调用Flash；fallback也失败时job安全`executor_failed`且vault不变。两条真实provider smoke显式执行，普通`npm test`不依赖本机模型服务或供应商额度。

- [ ] **真实模型闸门**：原生Ollama adapter以`kind=api, provider=ollama, model=gemma4:e4b`显式跑chat+digest；OpenCode adapter以`kind=cli, provider=opencode, model=navy/deepseek-v4-pro`显式跑chat+digest，且只有结构化机器码明确额度耗尽才允许同job回退`opencode/deepseek-v4-flash-free`。必须断言两条实际transport互不借道，digest返回都再通过gateway权威proposal validator。本项未通过前M2不标完成。

**M2当前验收（2026-07-14，gateway pipeline与OpenCode stub闭环，原生Ollama adapter/Navy真实闸门待完成）**：此前`npm test` 152/152通过、2个旧真实模型smoke默认skip；`build:web`、相关`node --check`与`git diff --check`通过。OpenCode stub已证明独立session/临时目录、session wildcard deny、全部tool id=false、structured response、tool事件即失败、primary成功不fallback、结构化quota机器码恰好fallback一次、单独402/普通429/401/坏结构不fallback，以及取消/超时清理。2026-07-14临时脚本直连Ollama 0.23.2 `/api/chat`与`gemma4:e4b`，简化transport schema后返回1条create proposal并通过Vera完整validator；同时确认完整schema/部分pattern会令Ollama grammar转换崩溃。该smoke只证明兼容路径可行，不等于正式adapter已解决；旧“Gemma通过OpenCode”真实测试语义作废，代码实现时须迁入`ollama-adapter.test.js`。Navy真实请求尚未执行，因此M2未标完成。

### P5-M3 — 三渠道检索、注入预算、横向扩展与正文展开

- [ ] **M3契约先行**：补齐retrieve/fetch_more/fetch_detail、游标、token预算、同session program-owned去重状态、使用统计、置顶、错误与必要SSE形状；冻结召回节点字段、查询相关性/图接近度/长期派生权重/单轮交汇置信度/类型适配五项归一化与权重、距离衰减、两阶段去重、粒度选择、query自适应type软配额、稳定tie-break和游标延续方式；不得污染adapter透明`sessionState`。
- [ ] 常驻索引按 R3 批量换版，只在新外部 session 建立稳定前缀；用户置顶 + 按派生权重选出的top条目合计受 `memory.injectionBudgetResidentLines` 限制，普通编辑不逐条打穿 prompt cache。
- [ ] 顺序固定为scope/status/session过滤 → 关键词/向量等宽召回取得出发节点 → 跨type开放图扩散并记录方向/路径/hop距离 → 按稳定slug归并命中以汇总路径与置信证据 → 五项加权基础分 → 按事实身份/语义簇做结果去重、合并独立方向置信并选择代表粒度 → query自适应、可借用的type软配额边际重排 → 尽量缩短为仍可独立理解的节点投影 → 按全局token预算截断。M4前长期派生权重贡献统一为不改变相对顺序的加法中性值0；结果在当前消息信封尾部追加，未装入项进入稳定cursor。索引/检索/日志都不携带 stain 或其自然语言含义。
- [ ] 落地冻结后的 MCP `memory_search` / `memory_fetch_more`，并增强既有 `memory_fetch_detail`：search内部按冻结的最大hop、逐跳衰减和候选上限做有界图扩散，广度分页游标稳定、方向可复现；fetch_detail显式关联仍只返回一跳，深度按slug取权威文件并记录使用统计。所有adapter只消费同一MCP surface，不直接碰store/vault。
- [ ] 明确物理顺序并做快照测试：adapter 的稳定 system/history 在 `promptText` 之外；本轮 `promptText` 为常驻索引稳定前缀 → 群聊 Message 声告 → 当前触发正文 → 本轮检索块（消息信封尾部）。Activity 永不因 Memory 接入而回流 prompt。

**M3 验收**：跨 Space 命中符合 D0 scope 决定，图扩散可跨type且直接语义命中不因无图路径被排除；同一节点由多个独立一级方向命中时只返回/计费一次、保留方向证据并获得有界交汇增益，同一方向的重复路径不刷分，跨slug近重复在基础评分后聚类且只合并独立方向，fetch_detail与SourceRef溯源不增加交汇；同 session 不重复注入。专门固定“当前需要5条彼此独立的规则类Memory、该类软目标为3”的夹具：总token预算容纳且其边际收益领先时必须返回5条，不能按type硬截；未知type取中性适配并进入默认软配额组。预算不足时先选更短但可独立理解的节点投影，再确定性截断并把剩余项放入稳定cursor；stain 在push、排序、日志和最终回复中均不可见，fetch_detail深读即使返回裸hex也不得解释/引用/参与判断；fetch_more游标不重不漏、fetch_detail返回权威正文；逐帧SSE仍正常且prompt cache稳定前缀不因单条记忆编辑变化。

### P5-M4 — 派生权重与 dream 维护

- [ ] 用可重建的真实派生权重替换M3加法中性贡献0；派生权重只来自双链入度、展开/最近使用、用户编辑与置顶、按type的时间衰减。M4只替换五项基础分中的长期权重贡献，不改变查询相关性、图接近度、单轮置信、类型适配、两阶段去重或软配额语义。agent无手工importance字段，stain永不参与排序；保留有界随机探索且测试可注入seed。
- [ ] dream 是聊天外异步维护 job，复用 M1 单写者与 M2 proposal 校验，只执行 keep/update/merge/archive 等冻结操作；默认不物理删除，保留 sources 和双链，失败不影响聊天与现有索引。
- [ ] dream 后统一重建派生索引并批量发布新的常驻索引版本；整理模型、批量大小、频率、超时和重试均引用配置，使用便宜模型但不把供应商写死。

**M4 验收**：重复 dream 幂等；merge 后 source/双链不丢；错误推断归档可恢复；权重可由输入完全复算；索引批量换版不会改变正在进行的 session；dream 失败有明确状态且不阻塞主流程。

### P5-F1 — Files：Space 附件层

- [ ] **F1契约先行**：定义File对象、Space归属/指定共享、上传/列表/详情/下载/删除、大小/MIME/重名/路径/权限、SSE与页面空错态，并钉死`fileId`如何进入Message、时间线如何呈现、Message归档后的附件生命周期；契约未完成前不建模块或页面。
- [ ] 按 D0 契约在职责最接近的现有目录中新增 Files 领域模块；二进制文件与 store 元数据分离，gateway 是唯一事实来源，前端只缓存列表/上传进度。不得把 Files 写成 Memory 的附件字段，也不得把任意本机路径暴露给客户端。
- [ ] 实现 Space 作用域上传、列表、详情/下载、删除与隔离策略 consumer；默认 isolated，specifiedShared 只接受显式 Space id 集合，globalReadable 仍只改变读取范围，不改变 owner Space 与删除权限。
- [ ] 文件落盘使用安全生成的存储名，保留展示名；拒绝路径穿越、符号链接逃逸、超限 body、非法 MIME/扩展组合和不完整临时文件。迁移附件根目录复用 Path 管理的校验→搬移→验证→回滚模式，但不得与 gateway dataPath 混成同一迁移语义。
- [ ] 前端只在契约开放后加入 `#/spaces/:spaceId/files` 与 composer 附件入口；移动端选择文件继续经 platform adapter，Web 使用受限 file input，不新增假按钮或提前进入 Phase 6 原生权限。

**F1 验收**：两个 Space 的默认隔离、指定共享、全局可读三种读取矩阵通过；上传中断不留可见脏记录；同名/重复、删除、404/409、大小限制、路径穿越、迁移回滚均有黑盒测试；下载支持真实二进制校验且不泄露服务器绝对路径。

### P5-X1 — 可扩展分类、端到端闭环与阶段冻结

- [ ] isolation 设置的 Memory / Files consumer 全部真实生效；AgentState 只验证现有设置不被破坏，per-Space 结构仍留 Phase 5.5。分类扩展使用数据驱动的 capability/policy 描述，不在业务代码散落固定三分支，也不提前造 Extension/存储插件框架。
- [ ] 端到端场景：A Space 产生有来源事实 → write hook 整理 → 新 session 的 B Space 按 scope 召回 → agent 可 fetch_detail → 使用统计进入下次权重；另跑 Files 的隔离/共享/删除/迁移完整场景。
- [ ] 手测服务以 `VERA_DATA_PATH=/tmp/... PORT=3210` 和独立临时 vault/files 根目录启动；3210 被占先查占用。`scripts/verify.mjs` 继续按规约使用 `getFreePort()` 随机空闲端口，避免与手测实例冲突。所有后端改动 `node --check`，全量 `npm test`，黑盒 verify，涉及新 SSE 事件则用 curl 实测逐帧；再跑 `npm run build:web` / `npm run analyze:web` 确认 F5 冻结基线未回退。
- [ ] 更新 `plan.md` 状态与验收证据并形成 Phase 5 可回退 commit；完成后开新任务窗口进入 Phase 5.5，不顺手生成 Capacitor、Android/iOS 工程或迁移 VPS。

**Phase 5 完成标准**：Memory 的文件权威、来源、自动整理、三渠道召回、派生维护和 isolation 均闭环；Files 的 Space 隔离、共享、生命周期和路径迁移闭环；agent 在 A Space 获得的长期事实按冻结 scope 在 B Space 新 session 可用，预算内不重复且可追溯；清空所有派生索引仍能从 vault + store 重建。Phase 5.5 的 AgentState/presence/daemon/VPS/Tailscale 项保持未提前实现。

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

- [ ] **5.5.0 Home Account / Execution / Workspace迁移**（其余联邦运行项的前置）：先按更新后的契约把现有 `Agent 1:N Account` 数据和Account组合UI一次迁移为每Agent一个Home Account；建立每Execution固定 `agentId + accountId`、主Execution只用Home Account、subagent按 `authorizedAgentIds` 使用其他Account的授权关系。Account增加唯一活跃Execution租约，竞争时排队或返回 `account_busy`，结束/取消/超时/失联必须释放。每Account建立唯一Workspace绑定，gateway只保存daemon宿主、绑定、策略、状态与校验时间；`sessionState`、Workspace和运行数据继续按 `accountId` 隔离，实际项目文件不迁入VPS store。迁移前后的旧字段与UI不得并存为兼容双名。
- [ ] **5.5.1 AgentState per-Space 改造**（最浅，先做）：`src/agents/agent-state.js` 跟踪键 `agentId` → `agentId:spaceId`；形状加 `spaceId` + `detail` 字段；`status` 枚举扩到 `idle/thinking/typing/reading/coding/reviewing/on_task/away`；`/api/agent-states` 支持 `?spaceId` / `?agentId` 过滤；契约 + 4.1 已建跟踪器同步改。verify.mjs 加 per-Space 测试。
- [ ] **5.5.2 Account.presence + 离线 @ 行为**：Account 形状加 `presence` / `lastSeenAt` 字段；`src/agents/accounts.js` 暴露 `setPresence`；`src/spaces/messages.js` 的 `shouldRespond` 加在线判定：offline 则不创建 run，改在 Space 时间线 insert 一条 `phase:"error", label:"agent-offline"` 的 Activity；SSE 加 `account.presence.updated` 事件。verify.mjs 加离线 @ 测试。
- [ ] **5.5.3 Agent token 体系**：`src/core/agent-tokens.js` 新建——加载 `~/.vera/agent-tokens.json`，校验 Bearer token → 返回 agentId；token 文件格式 `{ "agt_xxx": "<long-random>", … }`，新建 agent 时自动生成一条；gateway 启动加载、不进 repo。tailnet ACL只做网络门禁，不替代此token；同一解析结果也绑定Vera Memory MCP transport，tool参数不得覆盖agentId。
- [ ] **5.5.4 Tailscale owner identity + 入口权限**：gateway只信任本机Tailscale Serve注入并去伪造的identity headers；普通API/SSE要求login命中`config.security.ownerTailscaleLogins`；生产列表为空时拒绝业务API。原生CORS使用配置化精确Origin白名单，不自建配对码/device session。
- [ ] **5.5.5 `/api/agent/*` 路由层**：`src/api/agent-routes.js`新建——Bearer token识别Agent；login只登记daemon、per-Account Workspace/runtimeCapabilities与候选授权Account，不选择Account或取得租约。gateway创建主Run或父Run调用`POST /api/agent/runs/:id/subagents`时生成pending Execution；调度器取得目标Account唯一租约后转running、广播`run.started`并发`run.requested`。daemon不得重复创建/认领Run；终态/登出/超时释放租约，sync-state只接受租约持有者。
- [ ] **5.5.6 Run触发与调度链路改造**：`src/spaces/messages.js`不再sync调用`executeRun`；主Execution固定Home Account，subagent才可绑定其他授权Account。触发先创建pending Run；Account空闲且Workspace宿主在线时由调度器原子取租约并下发，忙则内部排队，明确要求立即执行的请求返回`account_busy`，离线走error Activity。编译层复用`src/spaces/view-compiler.js`，mock adapter保留给gateway内部一致性测试。
- [ ] **5.5.7 `scripts/agent-daemon.js`**：新进程，启动读Tailscale私网gateway URL / agent token，并按Account报告唯一Workspace、CLI binary/runtimeCapabilities；收到已获租约的`run.requested`后只执行与回传，不创建Run或自行切Account。迁移M2前必须先在`adapter-interface.md`冻结并实现专用digest request/result内部通道、取消/超时、安全摘要和fallback配置传递；不得复用聊天Run/Message/Activity/sessionState，迁移验收前不退役进程内digest adapter。心跳缺失3次后exit(0)，不得私网失败后fallback到公网域名。
- [ ] **5.5.8 mock daemon + verify.mjs 拆分**：起mock daemon走login → run.requested → delta → activity → message → completed → sync-state → logout；gateway内部一致性测试保留旧mock adapter路径。
- [ ] **5.5.9 VPS纯私网部署落地**：完成数据迁移、gateway systemd、VPS加入tailnet、Tailscale Serve、ACL、owner login配置、SSE逐帧和公网不可达验收；不安装公网反向代理，不启用Funnel。
- [ ] **5.5.10 本机清理**：停旧Mac gateway与cloudflared自启；旧数据和cloudflared配置只留冷备份；验证Mac daemon与手机客户端均经Tailscale访问VPS，其他手机App仍直连公网。

**完成标准**：
1. `scripts/verify.mjs` 全过（含Home Account迁移、subagent跨Account授权、Account唯一活跃Execution租约/释放、Workspace隔离、mock daemon端到端协议、离线@ error activity、per-Space AgentState与心跳缺失daemon自杀）
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
