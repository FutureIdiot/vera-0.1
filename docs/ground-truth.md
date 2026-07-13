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
- **私聊与群聊都是Space；联系人是Agent或Agent组合的UI投影**（2026-07-10修订）：左侧联系人头像栏里，单个Agent是联系人，一组固定Agent（群）同样显示为联系人。选中联系人后，右侧列出该成员集合下已有的Space；同一联系人/群可以有多个不同目的的Space：默认的、加载了Space Module的、某个话题单独用的。后端只有Space一种容器，不新增Contact或Conversation实体。单人联系人的稳定key为 `agentId`，群的稳定key由排序后的成员 `agentId` 集合派生；Account是Agent背后的供应商连接，不是聊天联系人。

### 2.2 Agent、Account 与 Execution（2026-07-13修订）

**Agent**：Vera内的独立身份实体 = 命名 + 私有记忆。

| 字段 | 说明 |
|------|------|
| 命名 | 用户定义的身份标识，永久绑定记忆和历史 |
| 记忆 | 私有，随身份走（见3.1） |
| Home Account | 每个Agent恰有一个日常主账户；这是身份的默认执行连接，不代表Agent拥有一组可同时驾驶的账户 |
| 当前窗口 | 动态状态，当前所在Space（属Agent State层） |

**Account（账户）**：供应商连接 + 项目与窗口上下文。

| 字段 | 说明 |
|------|------|
| 来源 | API / CLI |
| 位置 | API → 供应商 + Key；CLI → 供应商 + 调用路径 |
| 模型名 | 当前使用的底层模型 |
| 会话/项目上下文 | 供应商侧的会话连续性与项目数据，随账户不随agent |
| Workspace | 每个Account恰有一个Workspace；项目文件与执行边界随Account，不随Agent |
| 执行授权 | `authorizedAgentIds`：除Home Agent外，该Account还允许哪些Agent创建绑定它的subagent Execution。API型Account据此决定是否可换取明文key；CLI型key虽不由Vera持有，也必须先通过同一授权判定，daemon宿主的文件权限是额外物理边界而不是替代品。Phase 5.5落地 |
| 运行时能力 | `runtimeCapabilities`：daemon登录时报告的临时快照（Tools及是否承载Skill/MCP/Hook/Agent Plugin）；不持久化进Account真值，离线即视为不可用 |

**Execution（执行）**：一次实际运行的绑定关系。每个Execution创建时固定 `agentId + accountId`；Account不是Agent可长期挂载的连接列表，跨账户使用只存在于具体Execution中。

**说明：**
- 每个Agent注册时建立一个Home Account，主Execution始终使用Home Account；旧的 `Agent 1:N Account` 所有权模型取消
- 主Execution无需退出Home Account。获得用户授权后，它可以派subagent创建绑定其他Account的Execution；授权资格由目标Account的 `authorizedAgentIds` 决定。subagent只接收父Execution明确传入的任务包和必要上下文，不继承父Account的供应商会话历史
- **每个Account同一时刻只允许一个活跃Execution租约**，无论执行者是Home Agent还是获授权的其他Agent；竞争请求必须排队或明确返回 `account_busy`，不得让多个Agent/daemon并发驾驶同一sessionState与Workspace
- Memory始终按 `agentId` 隔离并跟随该Agent的所有Execution；供应商侧 `sessionState`、Workspace与运行数据始终按 `accountId` 隔离。Seat不携带 `accountId`，具体账户只由Execution绑定
- Workspace实际文件位于承载该Account的daemon宿主；gateway只保存Account到Workspace的绑定、策略、状态与校验信息，不复制项目内容，也不把宿主绝对路径当成跨设备可用数据
- 换Key、换供应商、换模型改的是账户，agent身份与记忆不变
- CLI供应商示例：Claude Code、Codex、OpenCode等；调用路径示例：build路径、`opencode go`
- 命名纪律：Agent、Account、Execution、Workspace各占一名，不得互作别名。Phase 4已经完成Agent/Account对象拆分，但当时落地的 `Agent 1:N Account` 管理形态现为待迁移旧形态，不代表当前设计

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

### 2.4 Agent 联邦与纯私网网络（2026-07-11 修订）

**核心形态**：Vera gateway 与每个 agent **进程独立、位置独立、生命周期独立**。gateway 在 VPS 上 7×24 常驻，作为消息中枢 + 状态库；手机、Mac 与其他 Vera 客户端/agent daemon 全部加入同一 Tailscale tailnet，**只通过 Tailscale 私网 HTTPS 访问 gateway**。Gateway 不 spawn 任何 agent 进程，也不向公网暴露 Vera 入口。

**形态决策（与 Theta 四问四答对齐）**：

1. **Gateway 搬 VPS**。Vera 中枢不在本机，根治“本机 sleeps / 切网就让 Vera 整体失联”；Cloudflare Tunnel 与公网反向代理都不再是运行链路依赖。
2. **Agent 只监听、被动响应**：agent daemon SSE 订阅 gateway，gateway 的反馈即 prompt——没有 prompt agent 不动。CLI 进程由 daemon 在 agent 那一侧自己 spawn 并保活，gateway 不知道也不关心 CLI 在哪。
3. **离线被 @ 直接跳过**：发一条 `phase:"error"` 的 Activity 进时间线作离线提示（不发明新 itemType），前端 Agent 信息页可看 presence=offline。下次 agent 上线不补发漏过的 @（无副作用历史）。
4. **多 agent 同时改代码的仓库冲突由工作流约定**：Vera不做文件级或Git级锁。用户指派一个agent负责分配任务 + 验收 + commit；GitHub用一个vera机器账号，issue描述/label标指派对象（`@agent-X` + label `agent=x`），agent自己`gh issue/PR/commit`。这不取消Account的单活跃Execution租约：前者防代码协作踩文件，后者防同一Account的sessionState与Workspace被并发驾驶。

**纯私网网络边界**：

- **唯一入口**：VPS、手机、Mac 与其他 daemon 宿主加入同一 tailnet；客户端统一使用 VPS 的 MagicDNS / `*.ts.net` HTTPS 地址。VPS 上用 Tailscale Serve 把私网 HTTPS 转到只监听 `127.0.0.1:3210` 的 gateway。
- **手机语义**：手机“不走 VPN”特指不运行 v2rayNG 等会与 Tailscale 抢占系统 VPN 槽的其他 VPN；手机仍运行 Tailscale 并加入 Vera 私网。未启用 Exit Node 时，只有 tailnet 目标走 Tailscale，其他 App 的普通公网流量继续走 Wi-Fi/蜂窝网络。
- **Mac 语义**：Mac 可通过小火箭承载 Tailscale 配置；这是接入实现细节。验收以 tailnet 路由、MagicDNS 与 SSE 长连接真实可达为准，Vera 不依赖小火箭特有 API。
- **公网关闭**：不为 Vera 配公网 DNS，不运行 Tailscale Funnel、cloudflared 或公网反向代理，不开放公网 Vera 端口；VPS 公网 IP 即使存在，也无法直接访问 Vera。
- **访问控制**：tailnet ACL 只允许 owner 的客户端设备和明确授权的 daemon 设备/tag 访问 VPS Vera 服务。普通客户端身份取 Tailscale Serve 注入的可信身份，只允许部署配置中的 owner Tailscale login；`/api/agent/*` 另加 per-agent token 识别具体 agent。

**开源默认与可选公网**：开源版本默认、文档默认和验收默认都只支持上述纯私网部署。未来其他部署者若确实需要公网连接，可以在不改变 Space/Message/Run/SSE 业务契约的前提下另加公网 TLS 入口与 owner 认证；但它必须独立补齐登录/设备撤销、CSRF/CORS、限速、审计、DDoS 与代理信任边界，属于单独的安全部署功能，不是“改一个 URL”或当前阶段预建的开关。

**Account 字段扩张**（联邦形态必需）：

| 字段 | 说明 |
|------|------|
| presence | `online` / `offline`，agent daemon 与 gateway 是否在通信（二态） |
| lastSeenAt | 上次心跳或 SSE 收到时刻 |
| sessionState 归属 | 仍在 gateway 持久化（`/api/agent/sync-state` 备份），agent daemon 在线时本地持有最新副本 |
| connection.command | **从 Account 形状里移除**——gateway 不 spawn，CLI 路径是 agent daemon 的事 |
| kind/provider/model | 保留，但只对 agent daemon 自己有意义（决定怎么 spawn/调 API），gateway 只是元信息 |
| workspace | gateway持久化该Account唯一Workspace的宿主标识、绑定、策略、状态与校验时间；实际文件只在daemon宿主 |

**Execution租约**（联邦形态必需）：

- daemon登录和 `run.requested` 必须携带明确的 `agentId`、`accountId` 与Execution标识；gateway先校验Home Account或 `authorizedAgentIds`，再原子取得目标Account的活跃租约
- Account的 `presence` 表示其承载daemon是否可用，不等于有权并发运行；活跃租约才是“当前由谁控制此Account”的唯一事实
- Execution结束、取消、超时或daemon失联时释放租约；释放前其他Execution不得复用该Account的sessionState或Workspace

**心跳与退出协议（防 token 烧穿）**：

- **gateway → agent**：每 15s（可配 `agentDaemon.heartbeatIntervalMs`）在 agent SSE 通道发 `agent.heartbeat` 事件。复用 SSE keepalive 之外的额外帧。
- **agent 失联判定**：daemon 连续 3 次未收到心跳（~45s）→ 立即停所有在飞 run、不再消耗 token、`exit(0)`。launchd/systemd 设 `SuccessfulExit=false` 不自动拉起。
- **gateway 挂了**：所有 agent 各自在心跳缺失后被自杀，**不存在 agent 反复撞 gateway 烧 token 场景**；唯一可能烧的是"心跳缺失瞬间正在跑的那一条 run"，损失被框死在毫秒到几毛钱。
- **daemon 主动下线**：`DELETE /api/agent/sessions` 显式登出，gateway 把 Account.presence 置 offline 并保留 lastSeenAt。
- **未来 `missionMode` 扩展位**：gateway 给 agent 发特殊 prompt "你被授权做 X 直到 gateway 恢复" → daemon 进入 mission 模式，心跳缺失不自杀，按任务自己跑完为止。MVP 不做，接口留位（`daemon.missionMode = false`）。

**认证与密钥边界**：

- **网络门禁**：Tailscale 身份 + tailnet ACL 是全部 Vera 请求的外层网络门禁，不再使用 Cloudflare Access。
- **Agent 身份**：Vera agent token（长随机串，VPS 上 `~/.vera/agent-tokens.json`，gateway 启动加载校验），per-agent 一条。daemon 请求带 `Authorization: Bearer <token>`，gateway 识别“我是 agt_xxx 在说话”。加入 tailnet 不等于获得 agent 身份；两层必须同时成立。
- **Owner 身份**：普通客户端请求只接受 Tailscale Serve 从回环代理注入且已去伪造的身份头；login 必须命中部署级 `config.security.ownerTailscaleLogins`。该列表默认空，生产启动时为空则拒绝普通业务 API 并报配置错误，不能因“单用户”退化成 tailnet 内任意设备均可管理。
- **客户端撤销**：撤销手机/Mac访问通过 tailnet 管理台移除设备或 ACL；Vera 当前不再自建 owner 配对码、device session 或第二套设备目录。

`config.security.ownerTailscaleLogins` 与原生客户端 `config.security.cors.allowedOrigins` 是部署级字段，不进入普通 Settings UI；实现时支持对应 env override，但不得在路由中硬编码 owner 邮箱或 Origin。
- **密钥授权闸门**（Phase 5.5）：daemon 用 agent token 为Execution换取目标Account的明文密钥时，gateway按三层判定：*(1)* 主Execution只能使用自己的Home Account，跨账户必须是显式subagent Execution；*(2)* subagent的 `agentId` 必须在目标Account的 `authorizedAgentIds` 中，否则403；*(3)* 目标Account必须取得唯一活跃Execution租约，否则返回 `account_busy` 或排队。CLI型Account的key虽留在daemon宿主，也必须经过相同身份、授权与租约判定后才能启动执行。

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

数据分四个独立领域，隔离规则分别定义。前三类是用户认知、内容和活动数据；Workspace是Account的执行数据边界，不混入Files。

### 3.1 Memory
对话记录、长期记忆。Agent的认知层。

- 默认：Space内原始对话记录隔离
- 长期Memory按 `agentId` 私有，跨该Agent加入的Space和绑定不同Account的Execution连续可用，不随Account复制或切换
- 不存在所有Agent隐式共享的长期Memory池；未来若需要共享，必须新增显式scope、授权与来源契约后才能实现

**记忆整理流程：**
- 各agent由自身subagent负责整理和提炼
- 流程环节：分块（程序）→ 标签（subagent）→ 提炼写入（subagent）
- 各环节执行者可配置，不硬编码
- 触发机制：hook（详见《Memory Hook设计文档》）
- 存储形态（2026-07-02定稿）：**文件即真相**——每条记忆一个markdown文件、语义化slug、`[[双链]]`互联，记忆库即Obsidian vault；数据库仅为派生索引。详见memory-hook.md《修订：文件库架构》
- vault内按 `agentId` 分区；slug在对应Agent分区内创建后永久不可改名，纠错使用正文更新、归档或新建正确slug，不提供rename兼容别名
- slug是Agent可见的稳定公共指针，不是跨job、跨措辞的事实去重身份。M2自动提炼必须先由程序使用独立于slug的确定性事实身份或等价规则匹配既有Memory：同一事实优先update/merge，纠错或新事实取代旧事实时走可追溯的supersede/archive语义，不得仅因模型换了slug就创建平行重复Memory。
- 所有程序写入（主Agent、subagent、CLI adapter、hook与dream）只能向gateway提交proposal/operation，由Memory单写者校验并原子落盘；不得直接写vault。用户通过Obsidian所做的外部编辑由gateway重扫、校验并刷新派生索引，不构成第二个程序写入通道
- **Vera Memory 本身是 gateway 托管的第一方 per-Agent MCP 服务**：Agent runtime 的读取、写入提议、检索、横向扩展和正文展开只走 Vera Memory MCP tools，不使用 `fs.read/fs.write` 直接碰 vault。MCP工具参数不接受 `agentId`，gateway从可信Execution/agent token上下文绑定身份；切换Account不切换Memory。owner前端继续使用HTTP管理API，但HTTP与MCP必须调用同一Memory facade和单写队列，不得复制业务实现。

**召回术语与纵横边界：**
- **召回节点**：粗召回后最先交给Agent的、可独立理解的最小语义卡片；每个节点是某一条长期Memory的简略投影，至少包含足以判断“直接使用还是展开”的核心命题，而不是只有slug、关键词或分数的无语义目录项。
- **记忆正文**：召回节点所代表的同一条长期Memory的权威markdown全文。`memory_fetch_detail`只是把该节点从简略投影展开为正文，不创建第二个节点，也不是原文溯源。
- **来源原文**：由Memory的`SourceRef`指向、保存在gateway store中的原始Message。沿`SourceRef`读取Message才叫溯源；来源原文不是横向关联图中的下一级节点。
- **索引**：关键词、embedding、双链图、派生权重等可重建的程序结构；索引帮助程序选出召回节点，不是Agent纵向深入时看到的内容层。
- 横向扩展只发生在同层长期Memory之间：节点可沿关联方向召回其他节点；纵向只有“召回节点 → 记忆正文 → 来源原文”。纵向展开和溯源都不参与横向路径数计算。

**召回ranking三项依据：**
- **派生权重**：该Memory跨轮稳定的长期权重，由图结构、使用统计、用户信号和按type的时间衰减派生；不得由Agent手工填写。
- **本轮相关性**：当前query与该Memory的关键词、向量等匹配程度，只服务本轮。
- **单轮交汇置信度**：同一候选节点在本轮被多少个相互独立的一级召回方向共同命中。程序按Agent分区内的稳定slug去重，节点只返回和计费一次，但保留独立方向集合并给予递减、封顶的本轮排序增益；同一一级方向内的多条路径只计一次。它不表示Memory内容真假，不写入frontmatter、不写回派生权重，本轮结束即丢弃。

### 3.2 Files
附件、原始材料。内容存储层。

- 默认：Space内隔离

### 3.3 Agent State
活动信息、agent当前所在Space、动作时间戳等。状态追踪层。

- 默认：全局可见

### 3.4 Workspace
Account的项目与执行数据边界。

- 每个Account恰有一个Workspace；`sessionState`、Workspace绑定和运行数据均以 `accountId` 隔离
- 实际项目文件位于daemon宿主，gateway只保存绑定、策略、状态和校验信息；VPS不复制、不索引Workspace正文
- Execution只能访问其绑定Account的Workspace；同一Agent的Memory可随Execution读取，但不能借此读取Home Account或其他Account的Workspace

**说明：**
- Memory / Files / Agent State的隔离边界可按各自契约配置；Workspace的Account边界是安全约束，不作为可放宽的普通隔离选项
- 数据层分类当前为Memory / Files / Agent State / Workspace，后续可能增加；实现时须可扩展，不得硬编码为固定枚举

---

## 四、可配置项清单

> **开发原则：所有可配置项必须引用配置变量，不允许硬编码。**

### 4.1 系统配置

**数据隔离规则**
- Memory原始记录随Space权限隔离；长期Memory固定per-Agent、跨该Agent参与的Space可用，不提供全局可读或per-Space切换开关
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
- 前端统一为 Account 管理入口：一张组合页面同时展示Agent身份/Memory/状态与其Account连接；底层Agent与Account仍是独立对象，页面不得复制字段

**Space设置**
- 在场agent列表
- 各agent席位配置（响应模式、respondTo、屏蔽规则）
- 当前Space的消息提醒策略
- 当前Space启用/停用及配置哪些已安装Space Module

**全局设置入口**
- Appearance
- Account管理（包含Agent信息、Account连接、Agent Memory）
- Extension Package安装、卸载、版本、信任与权限管理
- 路径管理
- 中控台信息（gateway、SSE、文件store、Memory vault、Agent daemon/presence、最近错误）
- 其他系统级可配置内容

> **边界（2026-07-10修订）**：普通路径管理只开放Agent工作路径、Memory vault、Files/附件路径等用户数据位置。gateway数据目录等会影响事实来源的高风险路径不得做成直接生效的普通文本框；如需开放，必须走“校验权限 → 迁移 → 验证 → 重启/回滚”的独立流程。端口、SSE心跳/缓冲、store落盘节流、daemon回收、run看门狗仍走环境变量/配置文件，不进普通前端设置。

### 4.2 扩展配置

扩展体系遵守“统一安装入口，不统一运行时”。禁止用一个万能 `plugin.run()` 同时承载Tools、Skill、MCP、Hook、Agent Plugin和Space Module。

#### 4.2.1 Tools（运行时基础能力，不属于扩展）

- 逻辑能力名统一为 `web.search` / `web.fetch` / `fs.read` / `fs.write` / `process.execute` / Vera Memory/Files/消息工具；其中Vera Memory工具固定由gateway第一方MCP提供，不映射成`fs.read/fs.write`，其余能力可来自CLI原生工具、供应商API工具或agent daemon的tool host。
- CLI已有原生Tools时Vera不重复安装；agent daemon登录时报告实际capabilities，前端只展示“可用/不可用/权限策略”。不能假设所有CLI能力相同。
- API模型本身不能触及本地代码。只有承载该API Account的本地agent daemon实现tool-call循环并绑定runtime workspace后，API agent才能读写/执行本机代码；无本地daemon的纯API Account不能访问Mac文件。
- `web.search` / `web.fetch` 可默认允许；`fs.read` 默认只限绑定workspace；`fs.write` / `process.execute` 必须受workspace边界、审批策略和审计约束。工具权限不由Space Module或第三方扩展自行扩大。
- gateway在VPS时不代替agent daemon执行本机文件/进程Tools，也不持有本地workspace路径的事实内容。

#### 4.2.2 Skill（per-agent）

- Skill导入（文件 / 路径 / URL）
- 加载 / 卸载
- 已安装Skill列表及状态
- Skill以Markdown/提示词/工作流为主，不拥有常驻进程、持续状态或UI挂载点。

#### 4.2.3 MCP（per-agent runtime）

- 第三方MCP是外部Tools/数据连接；CLI已有原生MCP配置时由daemon复用或映射，API agent由daemon内的MCP client转成provider tool calls。其连接、凭据与进程运行在agent daemon一侧；gateway只保存非敏感元信息/授权状态，不代理本机MCP进程。
- **Vera Memory MCP是唯一明确的第一方例外**：因为Memory真值和单写队列都在gateway，MCP server/dispatcher也由gateway持有，daemon只做MCP client或把tools映射给CLI/provider。不得把这个例外扩张成gateway代跑任意第三方MCP。

#### 4.2.4 Hook（per-agent runtime）

- Hook监听明确的生命周期事件（run开始/结束、tool调用前后等），运行在agent daemon；必须声明触发点、权限和失败策略。
- Hook不得阻塞gateway或直接修改主前端；高风险命令仍走Tools审批。

#### 4.2.5 Agent Plugin（per-agent）

- Agent Plugin是拥有持续状态、事件订阅或行为逻辑的Agent扩展，例如心情、五感、日记、成长系统。
- Agent Plugin运行在该Agent的daemon，不运行在gateway或浏览器主线程；可选的小型状态卡只读其公开view model。
- 如果Agent Plugin需要完整Space界面，必须同时提供一个Space Module，不能直接修改聊天Shell。

#### 4.2.6 Space Module（per-Space）

- Space Module为Space提供独立UI与Space级数据，例如任务看板、资料大纲、游戏、共读面板。
- Settings负责安装其所属Extension Package；当前Space设置只负责从已安装库中启用/停用Space Module并写该Space的配置。
- Space Module运行在浏览器隔离容器中，不得直接访问主页面DOM、gateway内部对象、secrets、宿主文件系统或任意网络；能力通过manifest与受限bridge授予。

#### 4.2.7 Extension Package 与 SDK

- Extension Package是唯一可安装包，可包含Skills、MCP配置、Hooks、Agent Plugins、Space Modules和资源；共享的只允许是包id/name/version/source/author/权限摘要，不强迫内部单元共享运行接口。
- Vera SDK只给扩展作者定义manifest、事件、bridge、UI挂载点、数据接口和兼容检查；SDK不是用户安装项。
- 社区Extension Package默认不可信。未启用的单元零执行、零轮询；未进入使用它的Space、未打开对应UI时不得加载Space Module主体。任一扩展失败不得拖垮聊天主页、SSE或其他Agent。
- manifest、权限、各单元数据隔离与升级/卸载协议在实现前先补 `api-contract.md`；不得把任意脚本路径直接拼进主应用执行。

### 4.3 外观配置（Appearance）

- 主题（亮 / 暗 / 自定义）
- 主题色
- 高亮色
- 字体
- 字体大小（phone / desktop × chat / management分别配置）
- 气泡样式
- 气泡间距（phone / desktop分别配置，只作用于聊天）
- 窗口边距（phone / desktop × chat / management分别配置）

外观作用域不是“一把尺子管全站”：主题、主题色、高亮色、字体族是全局；字体大小与窗口边距按`phone/desktop × chat/management`四种表面保存；气泡样式与气泡间距按`phone/desktop`保存且只进入聊天时间线。`chat`仅为全屏聊天主页，`management`包含Space导航、当前Space设置、Settings及Account/Memory等管理页。运行时由token loader按媒体宽度和当前路由选择源token并映射到组件消费的通用别名，组件不得各自发明断点。

**F0确认默认值（2026-07-10）**：主题与字体族默认跟随系统；phone的chat/management字号均为14px、窗口边距均为12px，phone聊天气泡圆角16px、间距4px；desktop的chat/management字号均为16px，desktop聊天窗口边距64px、管理页窗口边距8px，desktop聊天气泡圆角16px、间距10px。以上值进入`config.appearance`作为唯一默认源，后续仍可在Appearance页按作用域调整并由gateway保存。

Appearance明确分为三层，导入主题时不得混写：

1. **Theme Palette（可导入/导出）**：只包含语义颜色token，以及可选的代码/终端ANSI调色板。Catppuccin Mocha这类终端主题属于这一层；导入后可映射为Vera的背景、表面、文字、弱化文字、边框、accent及success/warning/error等token。
2. **Appearance Profile（主题外配置）**：字体族、响应式字号、气泡圆角/间距、窗口边距等个人布局偏好。导入或切换Theme Palette不得覆盖这一层，用户可单独导入、导出或恢复Appearance Profile。
3. **固定产品规则（不可主题化）**：页面职责、路由、导航方式、权限/Approval、安全区、无障碍下限、数据归属与响应式断点语义。主题文件不能改变这些规则，也不能注入组件行为。

Vera原生交换格式是带版本号的Theme JSON，CSS交换只接受白名单自定义属性声明：允许的选择器限`:root`和Vera声明支持的`[data-theme]`，解析后先归一化为内部Theme对象再持久化；拒绝任意组件选择器、`@import`、`url()`、脚本、外部字体与其他可执行/联网规则。终端主题兼容通过显式转换器完成：首批目标为iTerm2 `.itermcolors`与Terminal.app `.terminal`，读取前景/背景/光标/选区及16色ANSI调色板；无法一一映射的Vera语义token按内置规则派生并在保存前预览，不承诺无损往返第三方格式。

Theme与Appearance Profile的已保存值都以gateway为唯一事实来源；文件导入先进入内存预览，只有确认保存才写入。导出不得包含gateway地址、账户、路径、secret或其他非外观配置。

> **开发原则：所有视觉参数走CSS变量，组件内不允许硬编码任何颜色、尺寸、字体值。** `styles/tokens.css` 是变量定义的唯一来源；其余样式文件只消费变量，不得重新定义另一套视觉常量。

### 4.4 配置闭环

一个项目只有同时打通以下链路，才算“已支持配置”，不能因为设置页出现了控件就标完成：

`默认值 → API契约 → 前端控件 → gateway持久化 → 实际消费者 → 恢复默认 → 实测生效`

- 每项配置必须声明作用域：全局 / per-Agent / per-Space。作用域不同的项不得挤进同一个通用 settings 对象。
- gateway 与持久化 store 是配置的唯一事实来源；浏览器 `localStorage` 只允许保存未提交的临时预览，不得成为跨客户端配置源。
- Appearance 必须支持实时预览、按组恢复默认；确认保存后由 gateway 持久化，使手机与桌面读取同一结果。
- UI Lab允许在当前预览内存中记录并导出未提交候选，便于跨页面对照；它仍不是已保存配置。正式Appearance页点击保存后必须PATCH gateway，不能把UI Lab状态当成配置闭环。
- 页面关系、数据归属、权限边界不是用户外观配置；可调整的是视觉与使用体验，不把架构责任转嫁给设置页。
- `plan.md` 维护配置覆盖表，逐项记录 API、前端入口、消费者与验收状态；新增可配置项先补 ground truth 与契约，再实现。

---

## 五、前端功能模块

### 5.1 页面职责与路由

Vera不再使用底部固定标签。主页就是当前Space的全屏聊天；低频管理通过当前Space设置、右滑Space导航和全局Settings进入。

| 页面 | 路由 | 唯一职责 | 不得承载 |
|---|---|---|---|
| App Shell | 全局 | 路由、顶栏、safe-area、gateway连接状态、页面容器 | 底部主标签、业务表单、对象CRUD、页面专属数据 |
| 全屏聊天主页 | `#/spaces/:spaceId` | 当前Space时间线、广播、正文内@定向、实时AgentState、输入栏 | 常驻发送对象选择器、Space列表管理、Account编辑、全局设置 |
| Space导航 | 聊天页左侧可折叠目录（`#/spaces`只作为可恢复的打开态深链） | 左侧Agent/群头像投影；右侧所选成员集合的Space目录；切换、新增、重命名、归档/恢复Space | 固定选项或第二套持久状态；当前Space Seat/组件/提醒配置、Account连接配置 |
| 当前Space设置 | `#/spaces/:spaceId/settings` | 当前Space参与Agent、Seat响应规则、消息提醒、Space Module启用与配置 | 切换/新建其他Space、全局扩展安装、Account连接信息 |
| Setting目录 | `#/settings` | 轻量平铺入口；不预加载各子页数据 | 无实际层级依据的分组标题；把所有设置表单和状态面板渲染在同一页 |
| Appearance | `#/settings/appearance` | 外观实时预览、保存、恢复默认 | 业务行为或页面数据配置 |
| Account管理 | `#/settings/accounts`、`#/settings/accounts/:agentId` | 组合展示Agent身份/状态/Memory、Home Account及授权策略 | 把Agent字段复制进Account；把授权账户展示成该Agent拥有的Account列表 |
| Agent Memory | `#/settings/accounts/:agentId/memory` | 查看、编辑当前Agent私有Memory | 列表页预加载所有Agent的Memory正文 |
| Extension管理 | `#/settings/extensions` | Extension Package全局安装、卸载、来源、版本、信任、权限 | 直接替当前Agent/Space决定启用状态 |
| 路径管理 | `#/settings/paths` | 用户数据路径与受控迁移入口 | 直接暴露可把gateway配死的运行参数 |
| 中控台 | `#/settings/control-center` | gateway/SSE/store/vault/daemon状态和最近错误 | 后台永久轮询、虚构当前不存在的数据库连接 |
| 系统设置 | `#/settings/system` | 数据隔离、记忆整理、消息呈现等全局配置 | Space Seat、Account详情、Appearance |

- 联系人只存在于Space导航的展示层：单个Agent或Agent成员集合。允许组件使用 `contact-rail` 等UI命名，但store/API不得出现Contact CRUD或Contact持久记录。
- Account管理是组合页面，但底层为 `Agent 1:1 Home Account`；其他Account只通过 `authorizedAgentIds` 授权具体subagent Execution使用，不成为该Agent的所有物。Memory归Agent，连接、Workspace、sessionState与运行数据归Account。
- Files 属于 Space 作用域，契约落地后使用 `#/spaces/:spaceId/files`；在此之前不建空壳页面。
- Terminal 等未来功能必须先进入 ground truth 与 API 契约，再决定从Settings还是当前Space进入；现有页面不得提前吞下它的职责。

### 5.2 页面之间如何协作

- 聊天顶栏左上按钮与右滑共用同一个Space目录开关；中间当前Space名称进入`#/spaces/:spaceId/settings`；右上按钮进入全局Settings。目录、当前Space设置与全局Settings不得复用页面或入口语义。
- 手机右滑或点击左上按钮展开Space目录，不显示占用聊天边缘的额外常驻按钮；展开后目录从左侧把聊天主区向右挤窄，而不是覆盖、替换聊天或导航到设置页。桌面使用同一目录view和开关。打开期间切换Space不收起目录；只由顶栏开关或离开聊天页收起，不提供“固定”选项或持久化固定状态。
- Space导航左栏选中Agent/群后，右栏只列出成员集合匹配的活跃Space。新增Space继承当前成员集合；重命名、归档操作只作用于选中的Space记录。归档仅写`archivedAt`并保留Space及完整时间线/sessionState；已归档Space从活跃列表移出，在导航的“已归档Spaces”入口查看并恢复，不提供永久删除。
- 跨页面只传稳定ID和筛选条件。例如Account详情查看Memory进入 `#/settings/accounts/:agentId/memory`；实现复用独立Memory领域模块，不把Memory请求和编辑逻辑写进Account view。
- 持久对象的详情与编辑使用可重载、可前进后退的路由；弹层只用于确认、选择和短暂输入，不用弹层藏完整页面。
- Space目录只属于聊天页，不得带入当前Space设置、全局Settings或其子页。所有设置页都是独立全屏页面，顶栏左上统一为返回、中央只显示一次页面标题，正文不得再重复返回入口或`h1`标题。必须复用同一路由和同一份状态，不另造桌面业务实现。
- 聊天输入栏只属于 Space 页面。其他页面不得借用主聊天区作为自己的布局容器。
- 聊天输入栏不显示“全部”或Agent下拉选择器：普通消息默认广播；正文中直接写当前Space内的`@Agent名`时，由前端解析为定向消息，正文保留该署名。

### 5.3 提前拆分规则

前端不等文件膨胀后再拆。下列边界已经有真实用例，首轮实现就必须分开：

- `views/`：Shell、Space导航、Space聊天、当前Space设置、Settings目录、Account列表/详情、Agent Memory、Extension、路径、中控台、系统设置、Appearance分别独立。一个view不得同时拥有两个路由或两个对象的写流程。
- `api/`：保留一个只负责HTTP基础行为的client；按 `spaces` / `agents` / `accounts` / `settings` / `memory` / `extensions` / `status` / `events` 分领域文件，不把所有请求继续堆进 `gateway-client.js`。
- `state/`：路由、Space导航、Space/时间线、Account组合页、Settings/Appearance、Extension分开；前端只缓存UI状态，不复制gateway事实来源。
- `components/`：聊天时间线、导航、表单字段、对象行项分别组织。组件只有出现真实复用或拥有独立交互状态时才抽取，不建立“以后也许会用”的组件注册表。
- `styles/`：`tokens.css` 唯一定义视觉变量；`base.css`、`shell.css` 和按页面/领域拆开的样式文件只引用变量。禁止再次形成一个同时包含主题变量、全局布局和所有页面规则的巨型CSS。

出现以下任一情况必须在写主体前拆分，而不是等到约300行后补救：计划承载多个路由、同时读写两个领域对象、同时负责数据请求+路由+大段DOM、或已经可以明确预见列表/详情/编辑将独立增长。拆分沿现有对象与页面边界进行；没有第二个真实用例时不得顺手发明插件层或通用框架。

### 5.4 页面完成标准

- 每个页面都必须处理 loading / empty / error / offline / 长列表或长内容 / 危险操作确认，不只实现有数据的理想状态。
- hash深链刷新、浏览器前进后退、Space/Agent切换后状态归属必须正确。
- 手机390px宽度、虚拟键盘、安全区、桌面宽屏均无横向溢出；最新消息在发送与接收后保持可见。
- 聊天主页只加载当前Space摘要、最近时间线和SSE；Settings子页、Agent Memory、中控台与Space Module主体按路由/使用时加载。离开中控台即停止轮询，未启用扩展单元不得执行代码。
- 涉及gateway、SSE、路由或持久配置的页面必须开真实服务预览验收，不能只看静态文件或构建通过。
- Web无障碍最低线：原生交互元素或等价语义与可读label、可见`:focus-visible`、DOM顺序即Tab顺序、状态/错误使用适当的live region；dialog打开后聚焦其首个控件，Tab焦点留在dialog内，Escape关闭并把焦点还给触发点。所有核心流程必须只用键盘完成，并尊重`prefers-reduced-motion`。

---

## 六、技术约束

- 单用户，自部署
- 手机为主要操控端，Mac为主要执行环境
- 需要可靠的实时通道（agent在Mac上运行，用户在手机上观察和指挥）
- Codex Remote能做的，Vera都能做，并扩展至CC和其他agent
- **上下文必须缓存友好**（2026-07-02补）：会话前缀保持稳定、只追加；动态信息（时间戳、agent状态等）注入尾部；长期记忆更新成批生效，不逐条改写系统提示；CLI型agent必须复用会话而非每条消息重放历史

### 6.1 前端性能预算

- 首屏只包含Shell、当前Space最近时间线、composer与SSE；Settings、Memory正文、中控台、Extension管理和Space Module使用动态import与路由后取数，不得因为“以后会用”进入主页bundle。
- 首屏自有JS+CSS压缩后目标不超过200 KiB（字体/图片/第三方Space Module不计入但必须各自懒加载）；超预算先做bundle分析，不凭感觉继续堆。
- 当前时间线DOM最多保留200个item；更早历史分页读取。SSE按item key局部更新，高频delta按animation frame合并，禁止每个token全量重渲染时间线。
- 路由切换必须卸载对应监听、timer、poller与大DOM；中控台离页停止轮询，未启用Agent Plugin/Space Module零执行。
- Space Module运行在可销毁的隔离容器；隐藏或离开Space后暂停/销毁。扩展代码、故障或动画不得占用聊天主线程的常驻预算。
- 移动端避免全屏backdrop blur、大面积连续阴影和无休止动画；支持`prefers-reduced-motion`。头像/图片声明尺寸并懒加载，避免消息滚动时布局跳动。
- 验收基线分阶段执行：F5先以桌面Chrome/Safari和Android Chrome/iOS Safari Web浏览器做Performance trace；Phase 6生成原生壳后，再对390px中档Android WebView与iPhone模拟器/真机WKWebView复跑同一基线。缓存后进入聊天可交互目标≤1.5s，模拟4G冷启动目标≤3s，滚动/抽屉动画无连续>50ms long task。预算调整必须先改本文档。

### 6.2 Web / Android / iOS 客户端边界

- 三端共享同一份 `frontend/src`、同一路由、同一状态/API层和同一套视觉tokens；Android/iOS只提供Capacitor原生壳与平台能力bridge，不复制业务页面。
- Web是功能和可访问性的第一验收面；共享功能先在Web闭环，再进入Android、iOS壳验证。不得三端同时各写一份页面。
- 根节点使用 `data-platform="web|android|ios"` 与CSS safe-area变量做小范围平台适配；平台差异限于安全区、键盘、返回手势、通知、文件选择、触感、外部认证/链接与本地安全存储。颜色、排版、页面职责和业务流程不分叉。
- 平台能力必须经统一adapter调用并提供Web fallback；业务view不得直接import Capacitor插件。缺失能力返回明确的`unsupported`，不能让页面静默失效。
- Web由gateway经 Tailscale Serve 同源伺服；Android/iOS打包本地静态资源并通过用户配置的 `*.ts.net` 私网 HTTPS gateway URL连接。手机必须先加入对应 tailnet；原生壳不得内置固定IP、tailnet名、token或secret。桌面浏览器与原生客户端都只访问同一个私网 gateway URL。
- Appearance的已保存值仍以gateway为唯一事实来源，三端共享；平台只叠加不可编辑的safe-area/输入法适配，不再发展三套主题配置。
- `AGENTS.md` 已预先列出Capacitor配置文件及生成的 `android/`、`ios/` 目录，但这只是结构放行，不是立即生成授权。只有 `plan.md` 的F6标为进行中且用户在当前任务明确授权进入F6后，才可执行Capacitor初始化/平台生成命令；新窗口必须重新核对这两个条件。

---

## 七、待定 / 待补充

- ~~Memory Hook机制细节~~ 已就位：`memory-hook.md`（2026-07-02入库）
- 记忆整理各环节执行者的最终分配
- 数据层是否增加第四层
