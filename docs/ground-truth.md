# Vera 设计文档 · Ground Truth

> 本文档是Vera的唯一设计基准。所有开发决策以此为准。文档变更先于代码变更。

---

## 一、Vera是什么

Vera是单用户、自部署的多agent协作空间。

用户通过任意设备（主要是手机）实时观察和指挥运行在本地或云端的多个agent。每个agent有独立的连续身份和长期记忆，可以加入不同的Space处理不同的任务，但始终是同一个"人"——性格一致，记忆连续，只是面对不同的窗口环境处理不同的工作。

用户可以广播、@定向、授权agent之间互相调度。前端是控制台与聊天室的结合体。

---

## 二、核心概念

### 2.1 Space

有主题和上下文的房间。可以是项目、阅读、游戏、闲聊等任意场景，由用户创建和管理。

- Space内的数据按层隔离（见第三节）
- Agent可以加入多个Space，跨Space保持同一身份
- Agent知道其他Space的存在，可通过Agent State查看其他Space的活动元信息，但无法实时读取其他Space的内容
- **私聊与群聊都是Space，联系人可以是单个账户也可以是群**（2026-07-03补）：UI的联系人列表里，单个账户是联系人，一组账户的固定组合（群）同样是联系人。点联系人开Space；同一个联系人——无论单账户还是群——都可以开多个不同目的的Space：默认的、加载了插件的、某个话题单独用的，相当于chat端的多个窗口。后端只有Space一种容器，不另设会话类型。

### 2.2 Agent 与 Account（2026-07-03修订：拆成两个概念）

**Agent**：Vera内的独立身份实体 = 命名 + 私有记忆。

| 字段 | 说明 |
|------|------|
| 命名 | 用户定义的身份标识，永久绑定记忆和历史 |
| 记忆 | 私有，随身份走（见3.1） |
| 当前窗口 | 动态状态，当前所在Space（属Agent State层） |

**Account（账户）**：供应商连接 + 项目与窗口上下文。

| 字段 | 说明 |
|------|------|
| 来源 | API / CLI |
| 位置 | API → 供应商 + Key；CLI → 供应商 + 调用路径 |
| 模型名 | 当前使用的底层模型 |
| 会话/项目上下文 | 供应商侧的会话连续性与项目数据，随账户不随agent |

**说明：**
- 每个agent注册时自带一个账户，日常一对一使用
- 必要时一个agent可登录别人的账户管理其项目：项目/会话上下文随账户走，记忆随驾驶的agent走；换驾驶员开新会话，记忆索引按驾驶者注入（不产生双份注入，无token浪费）
- 换Key、换供应商、换模型改的是账户，agent身份与记忆不变
- CLI供应商示例：Claude Code、Codex、OpenCode等；调用路径示例：build路径、`opencode go`
- 命名纪律：Account与Agent是两个不同概念各占一名，不是同一事物的别名（旧repo的accounts↔agents双名教训）。Phase 2–3的实现两者合在一条agent记录里，拆分随Phase 4落地

### 2.3 消息

用户和agent在消息层是对等的——都可以在Space内广播或@定向发消息。

**响应规则（per-agent per-Space配置）：**

| 模式 | 行为 |
|------|------|
| 默认 | 收到所有消息，都响应 |
| 静默 | 只接收指定来源的@，其他消息收到但不响应 |
| 专注 | 只响应@自己的消息，广播忽略 |

- 规则是per-agent per-Space的，不影响agent本身，不影响其在其他Space的行为
- Agent获得用户授权后可发起对其他agent的调度
- 用户拥有最终决策权
- **群聊的发言归属**（2026-07-03补）：每个agent的会话里只有自己的话是"自己说的"（assistant角色）；用户和其他agent的发言注入时必须带署名、以对方发言的形式呈现（不得用assistant角色转达别人的话），否则模型重放历史会把全群发言当成自己说的。触发某agent时，把它上次发言之后错过的其他参与者消息一并转达。（Phase 4多agent广播的前置规则；Phase 2–3单响应者下gateway只传触发消息，agent看不到其他agent的发言，属已知欠缺）
- **发言与过程的边界**（2026-07-04补）：Message（气泡）是对外发言，是 agent 在 Space 内唯一能被其他成员看见的输出，经编译层署名注入他人的下次 prompt；Activity（思考链/工具链）只服务于同期观察的用户，**不进任何 agent 的下次 prompt**——包括 agent 本人（其工具历史由 adapter 自身的 sessionState 携带，gateway 不二次注入；其他 agent 想要细节只能靠 Phase 5 的 `fetch_detail`/`fetch_more` 主动调阅，按需、带预算，不是默认注入）。这是"时间线对用户全展开、prompt 层只看气泡"的产品语义边界。
- **群聊视角的注入形态**（2026-07-04补）：其他成员的气泡以"群内最近发言"这一明确声告的上下文段注入下次 prompt，**不伪装成一对一对话的 user 历史轮次**——模型在自己的历史里看到的 assistant 永远是自己、user 永远是用户的直接提问，群状态是每轮临时刷新的 volatile context（符合缓存纪律"动态信息注入尾部"）。编译层在该 agent 上次发言之后到当前触发之间派生这段 delta，无状态（不维护"已投递水位"）。CLI 与 API 型 adapter 共享同一份编译层输出（`ctx.prompt.text`），各自翻译成自己的协议帧：CLI 复用的外部 session 已携带稳定历史 + 本轮投递新 delta；API 每次 run 重建 messages 数组，但同样只把本人气泡放为 assistant、用户直接提问放为 user，旧群状态不进稳定历史，本轮群状态只落在新 user 消息尾部。
- **响应规则的统一语义**（2026-07-04补）：silent / focused / 屏蔽某 agent，本质都是"过滤进入该 agent 群聊视角 prompt 段的事件流"——被过滤的事件不进 prompt 段，等价于不触发该 agent 的 run（不进 → 不响应）。`silent` 的来源过滤靠 `respondTo`、屏蔽某 agent 靠 seat 上的 `blockAgentIds`（Phase 4.3 落地）。

### 2.4 Agent 联邦（2026-07-04 定稿）

**核心形态**：Vera gateway 与每个 agent **进程独立、位置独立、生命周期独立**。gateway 在 VPS 上 7×24 常驻，作为消息中枢 + 状态库；agent daemon 在任意机器（本机 Mac / 另一台 VPS / 云函数 / API 型无进程）上常驻或按需上线，**通过 HTTPS + 双层 token 主动连入 gateway**。Gateway 不 spawn 任何 agent 进程。

**形态决策（与 Theta 四问四答对齐）**：

1. **Gateway 搬 VPS**。Vera 中枢不在本机，根治"本机 sleeps / 切网 / cloudflared 边缘漂移就让 vera 失联"。
2. **Agent 只监听、被动响应**：agent daemon SSE 订阅 gateway，gateway 的反馈即 prompt——没有 prompt agent 不动。CLI 进程由 daemon 在 agent 那一侧自己 spawn 并保活，gateway 不知道也不关心 CLI 在哪。
3. **离线被 @ 直接跳过**：发一条 `phase:"error"` 的 Activity 进时间线作离线提示（不发明新 itemType），前端 Agent 信息页可看 presence=offline。下次 agent 上线不补发漏过的 @（无副作用历史）。
4. **多 agent 同时干活冲突由工作流约定**：Vera 不做锁。用户指派一个 agent 负责分配任务 + 验收 + commit；GitHub 用一个 vera 机器账号，issue 描述/label 标指派对象（`@agent-X` + label `agent=x`），agent 自己 `gh issue/PR/commit`。Vera 只做决策对话。

**Account 字段扩张**（联邦形态必需）：

| 字段 | 说明 |
|------|------|
| presence | `online` / `offline`，agent daemon 与 gateway 是否在通信（二态） |
| lastSeenAt | 上次心跳或 SSE 收到时刻 |
| sessionState 归属 | 仍在 gateway 持久化（`/api/agent/sync-state` 备份），agent daemon 在线时本地持有最新副本 |
| connection.command | **从 Account 形状里移除**——gateway 不 spawn，CLI 路径是 agent daemon 的事 |
| kind/provider/model | 保留，但只对 agent daemon 自己有意义（决定怎么 spawn/调 API），gateway 只是元信息 |

**心跳与退出协议（防 token 烧穿）**：

- **gateway → agent**：每 15s（可配 `agentDaemon.heartbeatIntervalMs`）在 agent SSE 通道发 `agent.heartbeat` 事件。复用 SSE keepalive 之外的额外帧。
- **agent 失联判定**：daemon 连续 3 次未收到心跳（~45s）→ 立即停所有在飞 run、不再消耗 token、`exit(0)`。launchd/systemd 设 `SuccessfulExit=false` 不自动拉起。
- **gateway 挂了**：所有 agent 各自在心跳缺失后被自杀，**不存在 agent 反复撞 gateway 烧 token 场景**；唯一可能烧的是"心跳缺失瞬间正在跑的那一条 run"，损失被框死在毫秒到几毛钱。
- **daemon 主动下线**：`DELETE /api/agent/sessions` 显式登出，gateway 把 Account.presence 置 offline 并保留 lastSeenAt。
- **未来 `missionMode` 扩展位**：gateway 给 agent 发特殊 prompt "你被授权做 X 直到 gateway 恢复" → daemon 进入 mission 模式，心跳缺失不自杀，按任务自己跑完为止。MVP 不做，接口留位（`daemon.missionMode = false`）。

**双层认证**（外部 + 身份）：

- **外部**：Cloudflare Access Service Token（`CF-Access-Client-Id` / `CF-Access-Client-Secret` 头），所有 agent 复用一对，过 Cloudflare 那道门不走邮件 OTP。Zero Trust 面板只放行 `vera.futureidiot.com/api/agent/*` 路径前缀。
- **身份**：Vera agent token（长随机串，VPS 上 `~/.vera/agent-tokens.json`，gateway 启动加载校验），per-agent 一条，daemon 请求带 `Authorization: Bearer <token>` 通过 `/api/agent/*` 时 gateway 识别"我是 agt_xxx 在说话"。Service Token 泄漏不会越权——还得有 agent token 才能冒充具体 agent。

**AgentState 改 per-Space**（联邦形态必需的精化）：

- 同一 agent 同时在多个 Space 有 run 时，每个 Space 各自的状态独立，前端按"当前 Space"取数。
- AgentState 形状：`{ agentId, spaceId, status, detail, lastActiveAt }`，扩展态枚举：`idle` / `thinking` / `typing` / `reading` / `coding` / `reviewing` / `on_task` / `away`。
- 状态由 agent daemon 自己声明（它最清楚 opencode 此刻在 think / tool / final typing），gateway 不猜，agent 说啥显示啥。
- Account.presence 与 AgentState 正交：presence 是 agent daemon ↔ gateway 的通信二态，AgentState 是该 agent 在某 Space 内的细颗粒工作相。

**GitHub 单账号分活方案**（联邦期间代码协作的政治约定，不进 Vera 实现）：

- 所有 agent 用同一个 vera 机器 GitHub 账号提交、开 issue、开 PR。
- 分配任务：issue 标 `label: agent=X` + 正文 `@agent-X 你来`；`gh issue list --label agent=X` 取活。
- 收尾：commit message 带 `Closes #N`，merge PR 自动关 issue。
- Vera 只做决策对话（谁干啥、验收意见）；GitHub 只做活和 PR 流。两者职责不混。

---

## 三、数据层

数据分三层，各自独立，隔离规则分开配置。

### 3.1 Memory
对话记录、长期记忆。Agent的认知层。

- 默认：Space内原始对话记录隔离
- 长期记忆经定时整理后写入全局，所有Space的agent共享

**记忆整理流程：**
- 各agent由自身subagent负责整理和提炼
- 流程环节：分块（程序）→ 标签（subagent）→ 提炼写入（subagent）
- 各环节执行者可配置，不硬编码
- 触发机制：hook（详见《Memory Hook设计文档》）
- 存储形态（2026-07-02定稿）：**文件即真相**——每条记忆一个markdown文件、语义化slug、`[[双链]]`互联，记忆库即Obsidian vault；数据库仅为派生索引。详见memory-hook.md《修订：文件库架构》

### 3.2 Files
附件、原始材料。内容存储层。

- 默认：Space内隔离

### 3.3 Agent State
活动信息、agent当前所在Space、动作时间戳等。状态追踪层。

- 默认：全局可见

**说明：**
- 以上为默认配置，三层的隔离边界均可在前端独立调整
- 数据层分类暂定Memory / Files / Agent State，后续可能增加，实现时此分类须可扩展，不得硬编码为固定枚举

---

## 四、可配置项清单

> **开发原则：所有可配置项必须引用配置变量，不允许硬编码。**

### 4.1 系统配置

**数据隔离规则**
- Memory原始记录：隔离 / 全局可读 / 按Space配置
- Files：隔离 / 指定Space共享 / 全局可读
- Agent State：隔离 / 全局可见
- 长期记忆整理：定时触发 / 实时同步 / 手动触发

**记忆整理**
- 各环节执行者（分块、标签、提炼、写入）
- 触发时机
- 注入预算（2026-07-03补）：常驻索引行数、检索注入token预算（详见memory-hook.md）

**消息呈现**（2026-07-03补）
- 气泡切分规则：段落边界模式、单气泡长度上限

**消息响应规则**
- per-agent per-Space：默认 / 静默 / 专注

**Agent与Account信息**（2026-07-03随2.2拆分更新）
- Agent：命名
- Account：来源、供应商、Key / 调用路径、模型名
- 联系人管理：单账户与群组合的建立/解散

**Space设置**
- 在场agent列表
- 各agent席位配置（响应模式）

> **边界（2026-07-03补）**：gateway运维参数（端口、数据路径、SSE心跳/缓冲、store落盘节流、daemon回收、run看门狗）走环境变量/配置文件（src/core/config.js），**不进前端设置页**——前端只暴露影响使用体验的项，不暴露能把服务配死的项。

### 4.2 Skill配置（per-agent）

- Skill导入（文件 / 路径 / URL）
- 加载 / 卸载
- 已安装Skill列表及状态

**Tool分层说明：**
- 基础Tools（web search、web fetch、文件读写执行）：全局默认开启，不在前端暴露配置入口
- Skill：per-agent，前端可管理

### 4.3 外观配置（Appearance）

- 主题（亮 / 暗 / 自定义）
- 主题色
- 高亮色
- 字体
- 字体大小
- 气泡样式
- 气泡间距
- 窗口边距

> **开发原则：所有视觉参数走CSS变量，组件内不允许硬编码任何颜色、尺寸、字体值。**

---

## 五、前端功能模块

- Agent管理：添加、删除、编辑agent信息；账户以联系人形式呈现，点联系人开私聊Space、多选建群聊Space（2026-07-03补）
- Space管理：创建、配置Space，管理在场agent及席位
- 聊天界面：支持广播、@定向，实时查看agent状态和输出
- Memory管理：查看、编辑长期记忆
- Skill管理：per-agent导入、加载、卸载
- 系统设置：数据隔离规则、记忆整理配置
- Appearance：外观配置

---

## 六、技术约束

- 单用户，自部署
- 手机为主要操控端，Mac为主要执行环境
- 需要可靠的实时通道（agent在Mac上运行，用户在手机上观察和指挥）
- Codex Remote能做的，Vera都能做，并扩展至CC和其他agent
- **上下文必须缓存友好**（2026-07-02补）：会话前缀保持稳定、只追加；动态信息（时间戳、agent状态等）注入尾部；长期记忆更新成批生效，不逐条改写系统提示；CLI型agent必须复用会话而非每条消息重放历史

---

## 七、待定 / 待补充

- ~~Memory Hook机制细节~~ 已就位：`memory-hook.md`（2026-07-02入库）
- 记忆整理各环节执行者的最终分配
- 数据层是否增加第四层

