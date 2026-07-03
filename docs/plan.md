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

- [ ] Space 管理：创建、配置、在场 agent 席位
- [ ] 多 agent 共存，广播 / @定向；转达消息带署名且不占 assistant 角色，补发 agent 错过的他人发言（ground truth 2.3 发言归属）
- [ ] 响应规则：默认 / 静默 / 专注（per-agent per-Space）
- [ ] Agent State 层（全局可见的活动状态）
- [ ] Agent/Account 拆分（ground truth 2.2 2026-07-03 修订）：连接类字段与会话上下文挪入 Account，Agent 保留命名+记忆，席位记录驾驶关系；一次迁移改干净，不留双名
- [ ] Agent 管理界面：增删改、换模型/供应商不换身份；账户即联系人，点开私聊/多选建群（ground truth 五）
- [ ] 系统配置：数据隔离规则落成配置文件字段
- [ ] 前端正式布局：手机竖屏优先，所有视觉参数走 CSS 变量

**完成标准**：手机上完成一次真实的多 agent 协作会话（≥2 agents，一次广播 + 一次定向）。

## Phase 5 — Memory 与数据层

**目标**：ground truth 第三节的三层数据落地。设计依据：`memory-hook.md`——以《修订：文件库架构》（R1–R6）为准，按第 16 节 MVP 顺序推进。

> 提前量（2026-07-03，与 Theta 确认）：**最小闭环提前落地**——vault 骨架 + 文件格式 + 常驻索引会话首消息注入 + agent 文件工具直读直写 + 手动保存入口（API），形状已收编进 api-contract.md「Memory（最小闭环）」。目的：Phase 3–4「边用边修」阶段长期记忆已可用。检索注入、派生权重、dream 不提前，仍按本阶段推进。

- [~] 动工前：memory-hook.md 术语/API 对齐契约（按文档头部整合注记），形状收编进 api-contract.md（最小闭环部分已收编；其余 `/api/memory/*` 届时再补）
- [~] 文件库（Obsidian 兼容 vault）+ Raw Event 留 store + 手动"保存到记忆"入口（R1–R2，MVP Step 1–3）（vault + 手动保存提前做；Raw Event 溯源链留本阶段）
- [ ] memory_write_hook（context 容量触发；slug/钩子行质量为第一验收项）+ stain frontmatter 与前端色块（Step 4–5）
- [ ] 三渠道注入：常驻索引（批量换版）、token 计价检索注入（哑墨、同会话去重、尾部放置）、fetch_more / fetch_detail 钻取（R3、R5，Step 6）
- [ ] 派生索引与权重（双链入度、使用统计、置顶；无手工标注）+ dream 维护 subagent（R4，Step 7–8）；整理任务用便宜模型跑批
- [ ] Files 层：Space 内隔离的附件存储
- [ ] 数据层分类实现为可扩展结构，不硬编码枚举

**完成标准**：agent 在 A Space 获得的长期记忆，整理后在 B Space 可用。

## Phase 6 — 收尾与扩展

- [ ] Claude Code adapter（`--resume` 会话连续）、Codex adapter
- [ ] Skill 配置（per-agent 导入/加载/卸载）
- [ ] Appearance 全套配置项
- [ ] Capacitor APK 打包
- [ ] gateway launchd 常驻 + 崩溃自愈（搬运旧 scripts 经验）

**完成标准**：ground truth 第四节可配置项清单逐项对勾。

---

## 明确不做（0.0.1 范围外）

- 多用户、账号体系
- agent 间自主调度的复杂授权模型（先做最简开关）
- 桌面客户端（网页在 Mac 浏览器里就是桌面版）
