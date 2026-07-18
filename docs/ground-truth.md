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
- Account可以加入多个Space，跨Space保持同一对外身份和项目数据边界；Phase 5.5实际执行者固定为该Account的owner Agent。
- Agent只通过当前已登录Account取得该Account可见的Space与项目上下文；不得据此读取其他Agent的Memory。
- **私聊与群聊都是Space；联系人是Account或Account组合的UI投影**（2026-07-17修订）：左侧联系人头像栏里，单个Account是联系人，一组固定Account（群）同样显示为联系人。选中联系人后，右侧列出该成员集合下已有的Space；同一联系人/群可以有多个不同目的的Space。后端只有Space一种容器，不新增Contact或Conversation实体。单人联系人的稳定key为`accountId`，群的稳定key由排序后的成员`accountId`集合派生。
- **Space始终绑定至少一个Account**：创建Space前必须先选中单人联系人或固定Account组合，`seats`不得为空；已有Space也不得通过成员编辑移除最后一个seat。历史空记录只作为异常恢复态保留读取能力，必须先补回成员才能继续正常使用。

#### 2.1.1 SpaceSession、AgentSession 与上下文

- **Space是房间，SpaceSession是房间内的一段对话窗口**。每个Space始终恰有一个`active` SpaceSession，并可有零到多个`archived` SpaceSession；私聊与群聊遵守同一规则。SpaceSession归档后永久只读，不恢复、不追加Message、不再创建Run；它与可恢复的Space归档是两种不同操作。
- **AgentSession是某个实际Agent代表某个Account在某个SpaceSession中的主聊天模型上下文**。唯一键为`(spaceSessionId, accountId, agentId)`；Phase 5.5的`agentId`必须等于Account的`ownerAgentId`。三元键保留未来非owner执行时另建独立上下文的空间，但任何情况下都不得resume另一Agent的供应商history、CLI thread或API模型上下文。subagent Execution仍是Run级隔离任务，其Run的`agentSessionId/contextGeneration`为`null`。
- AgentSession由Vera持有逻辑真值，至少包括`generation`、上下文检查点、最近完整轮次、容量估算与provider binding元数据。Account只提供本次主Execution使用的Space/Workspace/项目数据授权，provider连接与runtime来自实际Agent；CLI的thread/resume id只是某一AgentSession generation的外部绑定，API Agent的规范history/checkpoint由Vera保存并提供，不能把opaque provider state当成API会话真值。
- **自动压缩与`/compact`只换上下文代次，不新建SpaceSession**。成功压缩令目标AgentSession的`generation + 1`，以稳定身份/规则、上代checkpoint和最近完整轮次建立新窗口；旧provider binding与Recall交付状态只读冻结，新generation首次Run重新注入常驻Memory索引并建立新的Recall sidecar。压缩不创建Message、不进入Digest/Dream、不生成或修改长期Memory。
- 自动压缩按各AgentSession自己的容量独立触发；群聊中一个Agent到达水位不连带压缩其他Agent。默认容量水位为warning 70%、auto-compact 80%、hard 95%，三者可按已验证provider/model profile配置且必须严格递增。达到auto水位在安全点异步压缩；下一Run前已达hard水位必须先压缩，失败则明确`context_capacity`，不得丢当前消息或依赖provider静默截断。真实provider usage优先，其次使用已验证tokenizer，只有保守估算时必须标`estimate`。
- 裸`/compact`是当前SpaceSession的手动控制命令：私聊作用于唯一Account seat当前的AgentSession，群聊默认作用于当前全部Account seat的活跃AgentSession；各AgentSession独立成功或失败，不要求跨provider原子回滚。命令本身不保存为Message、不触发普通Run、不进入Digest。压缩期间仅目标AgentSession的新Run排队。
- 裸`/new`是SpaceSession级控制命令：必须一次作用于当前Space全部Account seat的活跃AgentSession，当前有未结束Run或压缩时返回`session_busy`而不暗中取消。成功时归档当前SpaceSession及其全部AgentSession/provider bindings，创建新的active SpaceSession；各Account在其当前实际Agent下一次响应前建立generation 1 AgentSession。旧窗口只读可查。新窗口继承Space成员/规则、Account身份与各实际Agent的长期Memory能力，不继承旧checkpoint、最近轮次、Recall交付/cursor、CLI thread或API history。`/new`本身不自动Digest、Dream或compact；尚未Digest的旧Message仍可按明确的单一Account + SpaceSession范围整理。

### 2.2 Account、Agent 与 Execution（2026-07-17重冻结）

**Account（账户）**：某个固定owner Agent在Space中的持久对外身份 + Space/项目数据与Workspace权限边界。除首次接入前的短暂待绑定状态外，Account与owner Agent严格1:1。Phase 5.5当前只允许owner Agent登录自己的Account；非owner代上线留作后续能力，当前不得建立会话。

| 字段 | 说明 |
|------|------|
| 命名 | Space中展示的账号名；历史Message冻结发送时名称快照 |
| Space与项目数据 | Seat记录Account的成员身份与响应规则；Space时间线和Space-owned Files由gateway按Space共享管理。Account自己的Workspace与项目执行权限当前只授权其owner Agent使用 |
| 所属Agent | `ownerAgentId`；首次成功接入时建立，之后不可普通修改，且一个Agent只能拥有一个Account |
| 接入Key | `accessKeyState`为`active/revoked`，version单调递增；User生成、轮换、撤销，明文只返回一次，gateway只保存不可逆校验值 |
| 当前上线者 | `activeAgentId`是登录会话/租约派生状态；Phase 5.5当前只允许为`ownerAgentId`或`null`，字段保留未来代上线扩展 |

**Agent**：实际执行者 = 稳定Agent身份 + 私有Memory + 自己的provider/runtime/model能力。

| 字段 | 说明 |
|------|------|
| 命名 | 实际Agent身份，例如Codex；用于审计和Agent使用管理，不替代Account对外名称 |
| Memory | 始终按`agentId`私有；物理Provider可位于该Agent daemon宿主、gateway宿主或明确配置的远程服务，不随Account移动 |
| provider/runtime/model | 属于Agent daemon的真实执行能力；Account不再保存或决定模型 |
| 能力与Data设置 | Skills / Hooks / MCP / Data四个平级目录继续属于Agent |

**Execution（执行）**：一次实际运行的绑定关系。每个Execution创建时固定`agentId + accountId + runtimeRevision + effectiveModel + delegated`；Agent贡献自己的Memory与模型能力，Account贡献本次Space Seat身份、Account Workspace与相应项目执行权限。Space时间线和附件仍是gateway持有的Space共享数据，不移入Workspace。

**说明：**
- 创建入口固定为Account；不得要求User先创建空Agent再补连接。新Account首次且仅首次`enroll`时原子创建owner Agent并写入`ownerAgentId`；该绑定建立后不可再用此Account创建第二个Agent。
- Account与owner Agent严格1:1：一个Account只有一个`ownerAgentId`，一个Agent也只能被一个Account引用为owner。owner关系不是“默认选择”，不提供普通改绑或多Account经营入口。
- 协议必须分别证明“实际Agent身份”和“Account访问权”：agent token绑定`agentId`，Account access key绑定`accountId`。前端可把首次接入包装为一份接入凭据，但gateway不得用同一个共享Key冒充Agent身份，否则无法隔离Memory或可靠校验owner关系。
- Phase 5.5当前登录必须满足`agentId === account.ownerAgentId`；非owner即使持有Account Key也返回`delegation_unavailable`，不得建立会话、读取Account数据或创建Execution。
- `delegated`字段作为未来兼容位保留，但当前所有Execution与Message固定为`false`。未来只有在`vera.workspace` MCP完成跨宿主Workspace授权、工具隔离与审计后，才能另行开放非owner登录；不得先开放“只能聊天”的半套代上线。
- 一个Agent同一时刻只能维持自己的一个Account登录会话；重复或竞争会话遵守Account租约，不得形成多Account经营入口。
- **每个Account同一时刻只允许一个活跃登录/Execution租约**。owner重复登录不得以接管参数强制撤销旧会话或取消在飞Execution；普通竞争请求返回`account_busy`，由正常退出、超时或明确的owner会话管理流程释放租约。
- `effectiveModel`必须是本次Execution实际使用的可展示模型名，由Agent runtime在Run创建前解析并冻结；不得为空、写成`default`或回退显示Account名/provider名。
- Memory始终按`agentId`隔离；Workspace与项目执行权限按`accountId`隔离；Space时间线按`spaceId`共享、成员关系和响应规则落在Account Seat；AgentSession按`spaceSessionId + accountId + agentId`建模。
- MCP或第三方Hook是否需要额外执行者由该unit自己的契约声明，不把`executorAgentId`设为所有Hook的强制公共字段。gateway内置的确定性Hook直接由gateway程序执行，不展示执行Agent或模型选择。需要模型的领域任务在自身Data配置中指定任务模型，不把模型选择扩张成所有MCP/Hook单元的通用字段
- Gateway、Agent daemon、Workspace与Memory Provider可部署在不同机器；每个能解释同一组本地绝对路径并直接执行其Workspace的Vera宿主命名空间以稳定`hostId`登记。daemon重启不得改变`hostId`；同机但文件系统互相隔离的容器视为不同宿主命名空间。gateway只保存路由、绑定、策略、状态与校验信息，不把任一宿主绝对路径当成跨设备可用数据。
- Phase 5.5当前Workspace必须与owner Agent daemon位于同一`hostId`；实际文件留在该宿主，gateway不复制项目内容。跨宿主挂载与远程Workspace执行均不在当前闭环，宿主不匹配明确`workspace_unavailable`。
- Phase 5.5现在建立gateway内的唯一`Vera Control Service`：统一负责Agent/Account重新授权、进程内Account Session、Workspace宿主准入与Execution权限判定。它与gateway共用事实来源和HTTP入口，不另建第二套账号、Key或权限数据库。
- Workspace宿主后续以稳定`hostId`接入Control Service并执行实际文件/Git/进程操作；Control Service只决定“谁可在何次Execution访问哪个Workspace”，不读取、代理保存或备份宿主正文。第一方Workspace Node协议是权威内部协议，未来`vera.workspace` MCP只能作为该协议的适配入口，不能成为身份或授权事实来源。
- 换Account Key不改变owner；换provider/model改的是Agent runtime；改变Memory Provider placement或Workspace宿主必须走各自显式迁移，不能随登录静默移动数据。
- Control Service为每个Account持久保存有界登录审计：`enroll/login/reconnect/logout`记录成功或拒绝结果，`session_revoked`只记录成功及枚举化撤销原因。审计只记录稳定Agent id、事件、结果、枚举化安全reason code与时间，不保存Account Key、任一Token及hash/fingerprint、boot id、原始身份头、IP、Workspace路径或provider连接；Account详情只返回最近20条安全投影。
- CLI供应商示例：Claude Code、Codex、OpenCode等；调用路径示例：build路径、`opencode go`
- API/CLI provider连接都由Agent runtime承载。当前过渡期的gateway-local执行也只从Agent的`runtimeProfile/runtimeBinding`解析Ollama/Codex连接，不得再读取Account兼容字段；Phase 5.5后续只迁移执行载体到daemon，不改变归属。
- adapter按provider协议与运行生命周期划分，不按Agent、Account、endpoint或模型划分；同一Ollama adapter可服务多个Agent runtime和模型。新增adapter先遵守`adapter-interface.md` 1.2的行为与三层验收规范，server保持显式import和普通provider map，不引入基类、动态注册表或无第二真实用例的兼容抽象。
- 命名纪律：Agent、Account、Execution、Workspace各占一名，不得互作别名。Phase 4的`Agent 1:N Account`、可变`defaultAgentId`与独立Account池均为已完成迁移的历史形态，不得作为兼容层恢复。

### 2.3 消息

用户和Account在Space消息层是对等的——都可以广播或@定向发消息；每条Account消息另记录实际执行Agent与模型。

**响应规则（per-account per-Space配置）：**

| 模式 | 行为 |
|------|------|
| 默认 | 收到所有消息，都响应 |
| 静默 | 只接收指定来源的@，其他消息收到但不响应 |
| 专注 | 只响应@本Account的消息，广播忽略 |

- 规则是per-account per-Space的；Phase 5.5只作用于该Account的owner Agent，不产生跨Account登录行为
- Agent获得用户授权后可发起对其他agent的调度
- 用户拥有最终决策权
- **群聊的发言归属**（2026-07-17按Account固定归属修订）：实际Agent的provider会话里，只有它当前代表Account生成的输出是assistant角色；用户和其他Account的发言注入时必须带Account署名、以对方发言的形式呈现，不得用assistant角色转达，否则模型重放历史会把全群发言当成自己说的。触发某`accountId + agentId`组合时，把该组合上次发言之后错过的其他参与者Message一并转达。
- **发言与过程的边界**（2026-07-17按Account固定归属修订）：Message（气泡）是Account对外发言，是实际Agent在Space内唯一能被其他成员看见的输出，经编译层以Account署名注入其他实际Agent的下次prompt；Activity（思考链/工具链）只服务于同期观察的User，**不进任何Agent的下次prompt**——包括执行者本人。API Agent的必要tool call/result由gateway写入对应AgentSession规范history；CLI工具历史由该generation的外部provider binding持有，gateway不把Activity二次注入。其他Agent想要细节只能靠Phase 5的`fetch_detail`/`fetch_more`主动调阅，按需、带预算，不是默认注入。这是“时间线对User全展开、prompt层只看气泡”的产品语义边界。
- **群聊视角的注入形态**（2026-07-04补，2026-07-15按API history修订）：其他Account成员的气泡以"群内最近发言"这一明确声告段进入本轮volatile输入，不伪装成当前实际Agent自己说过的话。编译层在当前`accountId + agentId`组合上次发言之后到当前触发之间派生这段delta，无独立投递水位。CLI与API共享同一语义编译结果，但wire分型：CLI只收`promptText + providerBinding?`，API只收`messages + historyVersion`。API规范history按每个main Run原子保存一对turn：输入侧只保留当前trigger Message的带来源署名信封，输出侧保留当前实际Agent代表Account生成的回复及provider确需的安全tool transcript；累计群聊声告、常驻Memory块和Recall投影不写入稳定turn。这样由其他Account发言触发的回复也有明确前因，不产生孤立assistant轮次。CLI provider thread可能按供应商能力保留已投递文本，但gateway不把它冒充API规范history；compact后两者都只继承checkpoint与最近完整轮次。
- **响应规则的统一语义**（2026-07-17修订）：silent / focused / 屏蔽某Account，本质都是过滤进入当前`accountId + executingAgentId`群聊视角prompt段的事件流。`silent`靠`respondTo`，屏蔽靠seat上的`blockAccountIds`；定向@仍穿透。

### 2.4 Agent 联邦与纯私网网络（2026-07-11 修订）

**核心形态**：Vera gateway 与每个 agent **进程独立、位置独立、生命周期独立**。gateway 在 VPS 上 7×24 常驻，作为消息中枢 + 状态库；手机、Mac 与其他 Vera 客户端/agent daemon 全部加入同一 Tailscale tailnet，**只通过 Tailscale 私网 HTTPS 访问 gateway**。Gateway 不 spawn 任何 agent 进程，也不向公网暴露 Vera 入口。

**形态决策（与 Theta 四问四答对齐）**：

1. **Gateway 搬 VPS**。Vera 中枢不在本机，根治“本机 sleeps / 切网就让 Vera 整体失联”；Cloudflare Tunnel 与公网反向代理都不再是运行链路依赖。
2. **Agent 只监听、被动响应**：agent daemon SSE 订阅 gateway，gateway 的反馈即 prompt——没有 prompt agent 不动。CLI 进程由 daemon 在 agent 那一侧自己 spawn 并保活，gateway 不知道也不关心 CLI 在哪。
3. **离线Account被 @ 直接跳过**：发一条 `phase:"error"` 的 Activity 进时间线作离线提示（不发明新 itemType），前端Account详情可看`presence=offline`与所属Agent。该Account下次上线不补发漏过的@（无副作用历史）。
4. **多 agent 同时改代码的仓库冲突由工作流约定**：Vera不做文件级或Git级锁。用户指派一个agent负责分配任务 + 验收 + commit；GitHub用一个vera机器账号，issue描述/label标指派对象（`@agent-X` + label `agent=x`），agent自己`gh issue/PR/commit`。这不取消Account的单活跃Execution租约：前者防代码协作踩文件，后者防同一Account的CLI provider binding与Workspace被并发驾驶。

**纯私网网络边界**：

- **唯一入口**：VPS、手机、Mac 与其他 daemon 宿主加入同一 tailnet；客户端统一使用 VPS 的 MagicDNS / `*.ts.net` HTTPS 地址。VPS 上用 Tailscale Serve 把私网 HTTPS 转到只监听 `127.0.0.1:3210` 的 gateway。
- **手机语义**：手机“不走 VPN”特指不运行 v2rayNG 等会与 Tailscale 抢占系统 VPN 槽的其他 VPN；手机仍运行 Tailscale 并加入 Vera 私网。未启用 Exit Node 时，只有 tailnet 目标走 Tailscale，其他 App 的普通公网流量继续走 Wi-Fi/蜂窝网络。
- **Mac 语义**：Mac 可通过小火箭承载 Tailscale 配置；这是接入实现细节。验收以 tailnet 路由、MagicDNS 与 SSE 长连接真实可达为准，Vera 不依赖小火箭特有 API。
- **公网关闭**：不为 Vera 配公网 DNS，不运行 Tailscale Funnel、cloudflared 或公网反向代理，不开放公网 Vera 端口；VPS 公网 IP 即使存在，也无法直接访问 Vera。
- **访问控制**：tailnet ACL 只允许 owner 的客户端设备和明确授权的 daemon 设备/tag 访问 VPS Vera 服务。普通客户端身份取 Tailscale Serve 注入的可信身份，只允许部署配置中的 owner Tailscale login；`/api/agent/*` 另加 per-agent token 识别具体 agent。

**开源默认与可选公网**：开源版本默认、文档默认和验收默认都只支持上述纯私网部署。未来其他部署者若确实需要公网连接，可以在不改变 Space/Message/Run/SSE 业务契约的前提下另加公网 TLS 入口与 owner 认证；但它必须独立补齐登录/设备撤销、CSRF/CORS、限速、审计、DDoS 与代理信任边界，属于单独的安全部署功能，不是“改一个 URL”或当前阶段预建的开关。

**Account 与 Agent runtime 字段边界**（联邦形态必需）：

| 字段 | 说明 |
|------|------|
| ownerAgentId | 首次接入后永久确定的所属Agent；与Account严格1:1，代上线不改它 |
| presence | `online` / `offline`，当前是否有Agent代表该Account在线 |
| lastSeenAt | 上次心跳或 SSE 收到时刻 |
| activeAgentId | 当前Account登录会话派生值；Phase 5.5当前只允许等于`ownerAgentId`，离线为null；保留未来代上线扩展 |
| accessKeyState / accessKeyVersion / accessKeyHash | 公开状态为`active/revoked`，version单调递增；Key只用于建立/重新建立Account授权，hash仅active时存在，明文不落gateway store |
| 会话归属 | Vera持有SpaceSession及`(spaceSessionId,accountId,agentId)`AgentSession；不同Agent代表同一Account时不共享provider binding/history |
| workspace | gateway持久化该Account唯一Workspace的宿主标识、绑定、策略、状态与校验时间；实际文件只在daemon宿主 |
| Agent runtimeProfile | 版本化、纯JSON且可稳定序列化的便携配置；当前严格为`{schemaVersion:1,kind,provider,model}` |
| Agent runtime snapshot | `hostId/revision/connectionFingerprint/runtimeCapabilities`和在线状态由实际Agent daemon派生登记，不属于导出profile |

Account与owner Agent严格1:1表示永久归属：每个Agent固定拥有一个owner Account。未来Agent可以临时代表其他Account，但只改变`activeAgentId`、AgentSession与Execution绑定，不改`ownerAgentId`，也不复制或混用任一Agent的Memory、runtimeProfile或provider binding/history。

`runtimeProfile`不得包含Account/owner归属、Workspace、`hostId`、session、presence、lease、token、Key、secret、`secretRef`或绝对路径。`revision`、`runtimeCapabilities`、`connectionFingerprint`和在线状态均是daemon派生的runtime snapshot，不写回可导出profile。Phase 5.5只要求该profile可直接做稳定JSON导出，不因此新增导入/导出endpoint。

**Execution租约**（联邦形态必需）：

- daemon首次登录或重新授权以agent token + Account access key建立Account Session；普通断线重连及`run.requested`只校验agent token + 当前Account Session Token，再原子取得目标Account租约
- Account的`presence/activeAgentId`表示当前由谁代表上线；Execution租约仍是具体Run控制权的唯一事实
- Execution结束、取消、超时或daemon失联时释放租约；释放前其他Execution不得并发驾驶该Account当前CLI provider binding或Workspace
- Phase 5.5非owner登录固定拒绝`delegation_unavailable`；owner重复登录遇到旧会话时返回`account_busy`，不得用“接管”绕过在飞Execution与Workspace租约

**心跳与退出协议（防 token 烧穿）**：

- **gateway → agent**：每 15s（可配 `agentDaemon.heartbeatIntervalMs`）在 agent SSE 通道发 `agent.heartbeat` 事件。复用 SSE keepalive 之外的额外帧。
- **agent 失联判定**：daemon 连续 3 次未收到心跳（~45s）→ 立即停所有在飞 run、不再消耗 token、`exit(0)`。launchd/systemd 设 `SuccessfulExit=false` 不自动拉起。
- **gateway 挂了**：所有 agent 各自在心跳缺失后被自杀，**不存在 agent 反复撞 gateway 烧 token 场景**；唯一可能烧的是"心跳缺失瞬间正在跑的那一条 run"，损失被框死在毫秒到几毛钱。
- **daemon 主动下线**：`DELETE /api/agent/sessions/:accountId`显式退出自己的Account，gateway释放租约、把presence置offline、保留lastSeenAt并立即销毁Account Session Token；再次上线必须重新验证Account Key。
- **未来 `missionMode` 扩展位**：gateway 给 agent 发特殊 prompt "你被授权做 X 直到 gateway 恢复" → daemon 进入 mission 模式，心跳缺失不自杀，按任务自己跑完为止。MVP 不做，接口留位（`daemon.missionMode = false`）。

**认证与密钥边界**：

- **网络门禁**：Tailscale 身份 + tailnet ACL 是全部 Vera 请求的外层网络门禁，不再使用 Cloudflare Access。
- **Agent 身份**：Vera agent token（长随机串，gateway在`~/.vera/agent-tokens.json`加载校验，daemon在本机secret store持有），per-Agent一条，回答“实际是谁在执行”，并绑定该Agent的Memory。加入tailnet不等于获得Agent身份。
- **Account访问权**：Account access key由User在Account页生成/轮换/撤销，是低频重新授权凭证，不是每次HTTP/SSE连接都发送的会话凭证。Phase 5.5当前仅与owner Agent token组合建立自己的Account Session；持有其他Account Key仍固定拒绝`delegation_unavailable`。未来开放代上线时，其他Agent也必须以自己的Agent Token + 目标Account Key建立临时Session，Key不改变其Agent身份或Memory。
- **Account Session Token**：首次登录或需要重新授权时，gateway验证Agent Token + Account Key并签发高熵opaque Session Token；两端每次启动生成不落盘的`daemonBootId/gatewayBootId`，Token绑定`agentId + accountId + agentTokenFingerprint + accessKeyVersion + daemonBootId + gatewayBootId`。每次Session另有非秘密、可审计的`accountSessionId`；它可写入Run但不能替代Token做认证。gateway只在内存保存Token hash，daemon只在当前进程持有明文，不落store、不进日志。此后同一daemon进程的SSE/HTTP重连及Account范围请求使用Agent Token + Session Token，不再重复验证Account Key。daemon重启后重验依赖受信daemon遵守Session Token不落盘；宿主失陷不属于该机制能掩盖的边界。
- **Session命名不得混用**：本条登录态统一称“Account授权会话（`AccountSession`）”。它不同于Space聊天窗口`SpaceSession`、per-Agent模型上下文`AgentSession`及CLI/provider自己的thread/session。AccountSession失效只撤销登录与Execution授权，不删除或换代后三者、Memory、Workspace绑定或provider binding。
- **重新授权条件**：gateway任一进程重启、daemon任一进程重启、显式登出、Account Key轮换/撤销或安全撤销都会令Session Token无效；下一次登录必须重新验证Account Key。普通网络抖动、SSE断线、presence因心跳暂时转offline、runtime配置刷新都不触发Key重验，也不设置周期性Key重验。
- **无人值守重启**：Account Key可以只在daemon宿主的`~/.vera/secrets.json`中以`0600`权限保存，用于上述重新授权；Agent Token同样由daemon从该文件的Agent凭证命名空间加载。该文件不得是符号链接，daemon只读写自己的`agentCredentials`命名空间并保留其他secretRef数据；AccountSession Token绝不允许进入文件。若User选择不保存Account Key，则daemon重启后需要重新输入Key。
- 登录、心跳、SSE重连、Workspace/Execution授权都只运行Vera控制逻辑，不调用provider或模型，因此不产生模型token消耗。只有聊天/工作Run及明确启用的Digest、Dream、compact或模型型扩展任务调用模型；Recall等确定性投影本身不调用模型，但会增加后续Run输入上下文。
- **Owner 身份**：普通客户端请求只接受 Tailscale Serve 从回环代理注入且已去伪造的身份头；login 必须命中部署级 `config.security.ownerTailscaleLogins`。该列表默认空，生产启动时为空则拒绝普通业务 API 并报配置错误，不能因“单用户”退化成 tailnet 内任意设备均可管理。
- **客户端撤销**：撤销手机/Mac访问通过tailnet管理台移除设备或ACL；Vera当前不再自建owner配对码、device session或第二套设备目录。daemon的进程内Account Session Token不属于owner客户端device session，也不授予普通管理API权限。

`config.security.ownerTailscaleLogins` 与原生客户端 `config.security.cors.allowedOrigins` 是部署级字段，不进入普通 Settings UI；实现时支持对应 env override，但不得在路由中硬编码 owner 邮箱或 Origin。
- **双凭证授权闸门**（Phase 5.5）：Account Session的建立/重新建立先以Agent Token固定`agentId`，再以Account Key固定`accountId`；二者都通过且`agentId === ownerAgentId`后才签发Session Token。普通续连只接受与两端boot id、当前Key version和Agent Token fingerprint匹配的Session Token。每条Execution还必须匹配当前owner Session并取得唯一租约。不存在`authorizedAgentIds`、共享Key或takeover旁路。
- **Execution租约**（Phase 5.5）：daemon承载的pending Run在创建时冻结当前`accountSessionId`，只有同一Session可原子取得`executionLeaseId`并转为running；其他pending Run可以排队，但同一Account只有一个running租约。旧Session创建的Run不得被新Session重新认领。当前进程内adapter过渡链路显式标为`gateway-local`且不伪造Session/lease；迁入daemon后删除该过渡形态。
- User显式轮换/撤销Account Key、显式logout或触发安全撤销时，旧Account Session立即失效；gateway把关联pending/running Run及其流式Message、Activity、Approval按`account_session_revoked`安全终态化并释放租约，随后拒绝daemon对旧Run的任何迟到上报。普通重复登录仍不得借此takeover。

**AgentState 改为 per-Agent + Account + Space**（联邦形态必需的精化）：

- 当前每个Agent只代表自己的owner Account；在多个Space有Run时，每个`agentId + accountId + spaceId`组合的状态独立。三元键为未来代上线保留Account维度，但Phase 5.5不得据此接受非owner会话。
- AgentState 形状：`{ agentId, accountId, spaceId, status, detail, lastActiveAt }`，扩展态枚举：`idle` / `thinking` / `typing` / `reading` / `coding` / `reviewing` / `on_task` / `away`。
- 状态由 agent daemon 自己声明（它最清楚 opencode 此刻在 think / tool / final typing），gateway 不猜，agent 说啥显示啥。
- Account.presence 与 AgentState 正交：presence 表示哪个Agent当前代表Account在线，AgentState 表示这个Agent + Account pair在某Space内的细颗粒工作相。

**GitHub 单账号分活方案**（联邦期间代码协作的政治约定，不进 Vera 实现）：

- 所有 agent 用同一个 vera 机器 GitHub 账号提交、开 issue、开 PR。
- 分配任务：issue 标 `label: agent=X` + 正文 `@agent-X 你来`；`gh issue list --label agent=X` 取活。
- 收尾：commit message 带 `Closes #N`，merge PR 自动关 issue。
- Vera 只做决策对话（谁干啥、验收意见）；GitHub 只做活和 PR 流。两者职责不混。

---

## 三、数据层

数据分四个独立领域，隔离规则分别定义。前三类是用户认知、内容和活动数据；Workspace是Account的执行数据边界，不混入Space时间线或Files。

### 3.1 Memory
对话记录、长期记忆。Agent的认知层。

- 默认：Space内原始对话记录隔离
- 长期Memory按`agentId`私有，跨该Agent自己Account中的Space与Execution连续可用，不随Space复制或切换；未来非owner执行若开放，仍沿用执行Agent自己的Memory
- 不存在所有Agent隐式共享的长期Memory池；未来若需要共享，必须新增显式scope、授权与来源契约后才能实现
- 每个Agent恰好绑定一个`active Memory Provider`，该Provider是该Agent长期Memory的唯一事实来源。Provider placement显式区分`gateway`、`daemon`或Provider自己的远程服务；新CLI Agent的默认`vera.markdown`跟随其daemon宿主，新API Agent默认可放在gateway宿主。Phase 5存量Memory先登记为其当前真实位置（现有实现即`gateway`），不得借Phase 5.5迁移静默搬家；之后只能走显式placement迁移。Obsidian兼容是默认Provider的特性，不是Memory抽象的强制格式。
- owner可以选择已安装且显式声明`memory-provider`能力、通过Vera Provider契约校验的自定义Provider。自定义Provider可以继续使用自己的文件、数据库或远程原生存储，**不要求导入、复制或转换为Markdown**；切换Provider不自动迁移旧Provider数据，未选中的Provider数据保持原位但不参与当前检索、写入或Dream
- 普通第三方MCP只是Agent可调用的外部Tools/数据连接，不能因为提供了若干memory命名工具就直接成为Memory Provider。只有实现稳定身份、作用域、版本/冲突及Vera所需读写语义并声明`memory-provider`能力的扩展才会进入Provider候选
- Vera Memory MCP是面向Agent的稳定逻辑入口，gateway按可信`agentId`把调用路由到其active Provider；选择自定义Provider不会要求Agent改用另一套任意MCP工具。active Provider不可用时Memory操作明确失败，不得静默回退到`vera.markdown`或其他Provider

**记忆整理流程：**
- Digest把尚未整理、已完整保存且实际Agent通过某个Account会话可见的Message转成该Agent的长期Memory，并在成功后推进对应`(agentId, accountId, spaceSessionId)`的整理水位；`accountId`只冻结证据可见性与来源上下文，不改变Memory owner。Digest有原始Message证据，负责create/update/supersede/archive/skip。Dream只维护active Provider中已经存在的长期Memory，负责明确重复项合并、结构/描述/双链整理和冗余归档；它没有原始Message正文时不得纠正事实、改变事实值或把猜测升级为事实。两者都不是普通聊天Run，Digest也不等于Dream
- Agent设置的Hooks是面向所有领域的通用目录。Memory只提供两个gateway内置确定性Hook：`Vera Memory Recall Hook`（`vera.memory.recall`）在聊天prompt编译前检索、筛选并安全注入active Provider中的相关Memory；`Vera Memory Write Hook`（`vera.memory.write`）观察completed Message持久化与Digest trigger，在满足Data → Memory配置时请求Memory Orchestrator创建异步Digest job。pending context本身由已保存Message与成功Digest水位确定，不以Hook开启为存在条件。两条Hook都由gateway程序执行，不调用模型、不绑定执行Agent，也不直接修改Provider
- 关闭Recall Hook只停止自动检索/注入，不影响Agent通过Vera Memory MCP主动读取；关闭Write Hook只停止自动Digest，不影响Message保存、pending context统计、owner手动Digest或MCP手动保存Memory。Dream的schedule/manual触发也独立于Write Hook
- Digest与Dream是Memory Orchestrator创建并管理的隔离模型任务，不是Hook unit。Write Hook是自动Digest的总开关和事件入口；手动Digest以及Dream的定时/手动触发由同一Orchestrator直接接收。Data → Memory管理Provider、Digest/Dream执行Agent、任务模型、触发/调度与状态，不复制Recall/Write Hook binding
- 新Agent默认安装并启用`vera.memory`、`vera.memory.recall`与`vera.memory.write`。Digest/Dream分别保存`executorAgentId`与任务模型；默认执行owner自身并inherit该Agent runtime的已验证聊天默认模型。fixed模型也必须来自同一Agent runtime revision的对应任务资格。
- 流程环节：分块（gateway程序）→ 隔离proposal（选定Agent runtime adapter）→ gateway校验与排序 → active Provider宿主物理提交
- Digest与Dream job始终属于Memory owner Agent。选择B执行时只借用B自己的runtime与已验证模型，不涉及B当前登录的Account，也不转移Memory归属。
- 入队冻结`ownerAgentId + executorAgentId + runtimeRevision + provider + taskModel + verification`及owner Memory Provider快照；不含Account。隔离任务包不继承执行Agent的聊天上下文、Memory、Account、Workspace或Tools。
- 所选执行Agent、runtime revision、任务模型或资格不可用时任务明确失败；不得静默改投其他Agent、Account、模型或Provider。
- 可选模型必须按精确provider/runtime版本、adapter profile、任务类型与model（本地模型含不可变模型标识/量化变体）分别通过transport和固定raw语义夹具；同adapter或同模型跑通Digest不自动认证Dream。离线与未验证是两种不同状态；owner不能自行把任意字符串标成已验证
- 当前gateway-local Memory任务已经按执行Agent的runtime revision与已验证任务模型选择Ollama/Codex adapter，不读取Account兼容字段。Phase 5.5后续只把同一隔离执行能力迁到daemon专用Memory task通道；structured-output、无Tools、无fallback与gateway完整validator规则不变。
- M2 digest job不是聊天Run/Execution，不创建subagent、不取得Account lease，也不依赖Phase 5.5的daemon/token/presence/Tailscale/Workspace接线；5.5只迁移同一adapter能力的执行位置，不改变本条语义。
- 自动读取由Recall Hook挂入prompt编译生命周期，自动Digest由Write Hook挂入Message/调度事件；Digest/Dream模型任务由Memory Orchestrator创建和执行（详见《Memory Hook设计文档》）
- 每个Agent的Data → Memory中，`digest.trigger.mode`只选择一种自动策略：`scheduled`与`realtime`互斥，`manual`表示关闭自动整理；无论选择哪种策略，owner与可信Agent都始终可以手动提交整理。`realtime`不是每轮都跑模型，而是按`(agentId, accountId, spaceSessionId)`统计尚未整理、已完整保存且该Agent通过该Account会话可见的Message正文Unicode字符数，达到配置阈值后异步排队；Digest范围不得跨Account或SpaceSession。Activity、流式delta、工具过程与provider token估算都不进入水位。聊天Run不等待整理。
- M2 的 Message 整理与 M4 的 Dream 是两种 job：Run 结束不等于外部 session 结束，M2 不把每次 Run 结束伪装成session-end Dream，也不增加失败后偷偷换模型的兜底开关
- **默认`vera.markdown` Provider存储形态**（2026-07-02定稿）：文件即真相——每条记忆一个markdown文件、语义化slug、`[[双链]]`互联，记忆库即Obsidian vault；数据库仅为派生索引。以下vault、slug、frontmatter、Obsidian外部编辑、gateway逻辑单写入口与Provider宿主物理提交细则只约束该默认Provider，不强迫自定义Provider转换为这种物理格式。详见memory-hook.md《修订：文件库架构》
- vault内按 `agentId` 分区；slug在对应Agent分区内创建后永久不可改名，纠错使用正文更新、归档或新建正确slug，不提供rename兼容别名
- slug是Agent可见的稳定公共指针，不是跨job、跨措辞的事实去重身份。M2自动提炼必须先由程序使用独立于slug的确定性事实身份或等价规则匹配既有Memory：同一事实优先update/merge，纠错或新事实取代旧事实时走可追溯的supersede/archive语义，不得仅因模型换了slug就创建平行重复Memory。
- M2 的事实地址由模型提议的结构槽（subject / relation / qualifiers）经 gateway 规范化后派生；事实值单独规范化。两者都只进入可重建派生索引与 job 审计，不进 Memory frontmatter。地址和值相同即合入既有 slug；地址相同但值冲突时，只有来源中存在明确纠错证据才允许 supersede。模糊或多候选时必须跳过/拒绝，不得靠 suggested slug 猜测。
- 写入时的`type`分层是Memory的结构化元信息，用于后续聚类去重、粒度选择和软配额重排，并只作为语义簇兼容性的辅助信号；单轮置信仍只来自独立一级方向的并集。`type`不进入事实身份，不把召回切成互不相通的类型分区，也不是检索过滤门槛。新类型允许扩展，未配置类型进入默认软配额组，不得因未知类型丢弃Memory。
- 对`vera.markdown`的所有程序写入（主Agent、subagent、CLI adapter、Hook与Dream）只能向gateway提交proposal/operation，由gateway的Memory facade校验、排序并路由到该Agent的active Provider；不得直接写vault。Provider位于daemon宿主时，由该宿主完成物理原子提交与外部编辑扫描，再向gateway返回版本化结果；Provider位于gateway宿主时由gateway本机完成。用户通过Obsidian所做的外部编辑进入对应Provider宿主的重扫、校验与派生索引刷新，不构成第二个程序写入通道。自定义Provider必须在自己的契约边界内提供等价的串行化、版本冲突与原子提交保证，gateway不绕过Provider直碰其原生存储
- **Vera Memory MCP是gateway托管的第一方per-Agent逻辑服务**：Agent runtime的读取、写入提议、检索、横向扩展和正文展开只走Vera Memory MCP tools，由Memory facade按可信`agentId`与Provider placement路由到active Provider。gateway仍是逻辑单写者和验证权威；当Provider位于daemon宿主时，由gateway发送已验证operation并由该Provider完成物理原子提交，宿主离线明确`memory_provider_unavailable`，不得改投gateway副本。对`vera.markdown`不得使用普通`fs.read/fs.write`绕过facade；owner前端HTTP与MCP调用同一Provider facade，不复制业务实现。
- M3的三条渠道——新AgentSession generation的常驻索引、每轮Message尾部的自动检索注入、Agent主动`memory_search/fetch_more/fetch_detail`——共用同一retrieval facade。自动query只取当前`triggerMessage.content`，不包含群聊声告、Activity、历史prompt、AgentSession checkpoint、API history或CLI provider binding。
- 同上下文代次去重由gateway独立sidecar管理，直接以`agentSessionId + generation`为键，持久化已交付slug与有限cursor snapshot；语义簇合并返回一个代表节点时，代表与全部`mergedSlugs`必须在同一次成功交付中共同标记，不能让重复slug在后续召回重新出现。gateway重启不换代；自动/手动compact、`/new`或CLI provider binding明确missing/invalid时换代。该sidecar不得塞进provider binding。
- 用户置顶是retrieval signal，不进Memory frontmatter、不改Memory version，Agent MCP不得写。M3常驻索引先按`pinnedAt, slug`取置顶项，非置顶项因`derivedWeight=0`暂按slug稳定排序；M4只替换非置顶的长期派生权重。置顶、取消置顶和普通Memory编辑都不更换当前AgentSession generation的稳定前缀，只在下一generation批量换版。
- owner HTTP可见stains；Agent侧`memory_search/fetch_more`、自动注入和MCP `memory_fetch_detail`均不返回`stains`字段或自然语言含义。`fetch_detail`仍可返回正文中本来存在的裸hex，但tool描述必须明确不解释、不引用、不作为判断依据。派生检索索引、cursor、使用事件和日志不得携带stain。

**召回术语与纵横边界：**
- **召回节点**：粗召回后最先交给Agent的、可独立理解的最小语义卡片；每个节点是某一条长期Memory的简略投影，至少包含足以判断“直接使用还是展开”的核心命题，而不是只有slug、关键词或分数的无语义目录项。
- **记忆正文**：召回节点所代表的同一条长期Memory的权威markdown全文。`memory_fetch_detail`只是把该节点从简略投影展开为正文，不创建第二个节点，也不是原文溯源。
- **来源原文**：由Memory的`SourceRef`指向、保存在gateway store中的原始Message。沿`SourceRef`读取Message才叫溯源；来源原文不是横向关联图中的下一级节点。
- **索引**：关键词、embedding、双链图、派生权重等可重建的程序结构；索引帮助程序选出召回节点，不是Agent纵向深入时看到的内容层。
- 横向扩展只发生在同层长期Memory之间：节点可沿关联方向召回其他节点；纵向只有“召回节点 → 记忆正文 → 来源原文”。纵向展开和溯源都不参与横向路径数计算。

**召回顺序与ranking依据：**
- 顺序固定为：scope/status/AgentSession generation过滤 → BM25与真实embedding等宽召回取得出发节点 → 沿Memory图做有界多hop开放扩散并记录方向、路径与hop距离 → 按稳定slug归并同一节点的重复命中 → 计算候选基础分 → 按事实/语义簇做结果去重、合并独立方向置信并选择合适粒度 → 按query自适应的type软配额做边际重排 → 先尝试更短但仍可独立理解的节点投影，再按token预算确定性截断并输出；未装入项进入稳定`fetch_more`游标。前段slug归并只为汇总同一节点的路径证据，不是最终结果截断；内部扩散必须有最大hop、逐跳衰减和候选上限，且不得递归注入正文；`fetch_detail`显式关联仍只返回一跳。正文展开和SourceRef溯源不参与横向扩散或计分。
- 候选基础分的形状固定为五项归一化后的加权和：`baseScore = wq·queryRelevance + wg·graphProximity + wl·derivedWeight + wc·intersectionConfidence + wt·typeFit`。最终选择使用`marginalScore = baseScore - redundancyPenalty - boundedSoftQuotaPenalty`逐项重排；精确权重、距离衰减、惩罚函数和封顶值在M3契约先行时冻结，不得临时改成硬过滤或乘法门槛。
- **查询相关性（queryRelevance）**：当前query与候选的关键词、向量等直接语义匹配程度，只服务本轮。
- **图接近度（graphProximity）**：候选相对出发节点的hop距离和冻结的边关系强度经单调衰减后的本轮信号；直接关联优于等条件的远跳节点，同一节点多路径取最有利的有效距离，但其他独立方向仍保留给置信度。关键词/向量直接命中却没有图路径时取中性值，不得因此被排除。它不同于长期派生权重中的图中心性。
- **长期派生权重（derivedWeight）**：该Memory跨轮稳定的长期权重，由图结构、使用统计、用户信号和按type的时间衰减派生；不得由Agent手工填写。
- **单轮交汇置信度（intersectionConfidence）**：同一候选节点或同一语义簇在本轮被多少个相互独立的一级召回方向共同命中。合并时取独立方向并集，同一方向内的重复路径只计一次；增益递减且封顶。它不表示内容真假，不写入frontmatter、不写回长期权重，本轮结束即丢弃。
- **类型适配（typeFit）**：只表示候选`type`与当前query意图、所需抽象粒度的匹配程度；它是软排序信号，不是可见性规则、事实身份或类型白名单。
- type配额是最终重排的**可借用软目标**，优先用token占比和边际增益表达，不设“某类最多N条”的硬上限，也不预留不可借用槽位。某类超过目标后只施加随超额单调增加但封顶的边际惩罚，使其后续边际收益递减；其他类型没有更高边际收益、当前query对该类需求强或候选基础分明显更高时，该类可继续借用剩余预算。因而5条彼此独立且当前确实需要的规则类Memory不得仅因软目标为3而被截成3条；只有语义重复合并、当前AgentSession generation已注入、综合边际收益不足或总token预算才可减少它们。

**真实embedding召回 `[P5-M3.1]`：**
- embedding是gateway管理的可重建派生检索能力，不是Agent、Account、MCP/Hook unit或Memory Provider，也不配置语义处理Agent。自动Recall与Vera Memory MCP显式搜索共用同一retrieval facade；MCP参数、可信`agentId`绑定、节点形状、cursor与token预算不因embedding改变
- 首版只调用gateway所在主机loopback Ollama `http://127.0.0.1:11434/api/embed`，固定模型tag `qwen3-embedding:0.6b`和1024维；实际索引身份同时绑定Ollama返回的完整model digest。不得使用`latest`，不得自动下载、自动换模型、调用远程服务或借聊天Agent补算
- 每条active Memory只生成一个向量，文档投影固定为`Type + Description + Content`，不含scope、sources、stains、时间戳、Agent id、路径或frontmatter；query使用版本化英文检索instruction加当前trigger Message/query。请求必须`truncate:false`，单条过长只令该条缺向量并保留关键词/图召回，不能静默截断
- `vera.markdown`的向量sidecar位于`<vaultPath>/.vera-index/<agentId>.embedding.json`，只保存模型/维度/投影/Memory版本和Float32向量，不保存正文或query；它必须被vault Git忽略，可删除重建，迁移vault时不当用户数据复制。自定义Provider只需向facade提供安全Memory投影，不被强迫采用该物理路径
- 新建或`type/description/content`版本变化只重建该条，archive/delete移出active索引；model digest、维度或投影版本变化必须全量重建。搜索只使用`memoryVersion`仍匹配当前权威Memory的向量，构建通过临时文件和原子rename发布完整generation
- embedding只负责query召回，不作为“同一事实”或“重复Memory”的真值。事实身份、规范化全文、char-trigram cosine与token Jaccard继续负责确定性去重/冗余惩罚，不能把embedding相似阈值直接用于合并或归档
- Ollama离线、模型缺失、超时、维度错误、索引损坏或重建中均fail-open为BM25 + graph；公开响应沿既有兼容词表返回`degradedChannels:["vector"]`。只有整个retrieval facade不可用才报`memory_retrieval_unavailable`

**Dream `[Phase 5 M4]`：**
- Dream只维护active Provider中的既有长期Memory，不观察实时对话，也不决定普通聊天何时读取或写入；触发由gateway确定性调度或owner手动提交，模型只在冻结的任务包内提出维护proposal，最终由gateway和Provider校验执行
- Dream可以合并语义相同的既有条目、整理不改变事实含义的type/description/content结构与双链、归档已有明确替代项的冗余条目；不得在没有冻结Message证据的情况下纠错、supersede事实值、凭模型常识宣布内容过时或删除来源。需要事实变化时必须由后续Digest携带原始Message证据，或由owner手动编辑
- 每个Agent的Dream调度支持`manual / daily / weekly / custom`；除`manual`外必须显式保存IANA时区，daily/weekly保存本地执行时间，custom使用受校验的五段cron。状态至少公开上次运行、下次运行、当前job及安全错误摘要
- “立即Dream”创建异步幂等job；同一request重试返回同一job，同一Agent已有active Dream时合并到该job而不并发启动第二个。Dream不得阻塞聊天或页面请求
- Dream与Digest共享“job固定属于Memory owner、只借用执行Agent runtime、入队冻结快照、隔离上下文、proposal只回写owner active Provider、失败不fallback”的规则；二者资格独立。

### 3.2 Files
附件、原始材料。内容存储层。

- File始终有唯一`ownerSpaceId`，二进制正文与gateway store中的File元数据分离；gateway是唯一事实来源，客户端只缓存列表、上传进度与Message附件投影。展示名保持用户原名，物理存储名只由gateway安全生成，API与日志不得返回附件根绝对路径
- File读取按全局`isolation.files`策略解释：`isolated`只允许owner Space；`specifiedShared`允许owner Space与该File明确保存的`sharedSpaceIds`；`globalReadable`允许所有现存Space读取。`sharedSpaceIds`只接受明确Space id集合，不支持成员、Agent、标签、通配符或隐式“相关Space”
- 扩大读取范围不改变`ownerSpaceId`、删除权或生命周期。只有owner Space可以修改共享列表或删除File；其他Space即使可读也不能转授、改名或删除
- Message只保存稳定`fileIds`引用；时间线与SSE按当前读取策略派生安全附件投影`{fileId,name,mime,sizeBytes,state}`。二进制正文不会自动塞进聊天prompt、Memory、Activity或API history；当前Phase 5只冻结引用与owner HTTP读取链路，未来Agent侧Vera Files工具必须另补可信身份、预算与审计契约
- Space归档保留其owner Files、共享关系与Message引用，恢复后继续可用。单独删除File会删除二进制并保留最小墓碑元数据，使历史Message仍能显示原附件名但状态为`deleted`；下载返回404。永久删除已归档Space时，必须级联删除其owner Files和二进制；其他Space中的共享引用随之变为不可用，不得转移owner
- 同名与相同内容上传都创建新的File id，不覆盖旧附件，也不做内容寻址合并。上传只有在临时文件完整写入、大小/MIME校验、hash计算和原子提交全部成功后才创建可见元数据；中断或失败不得留下列表记录或可下载半文件

### 3.3 Agent State
实际Agent代表某Account在某Space中的活动信息与动作时间戳。状态键包含`agentId + accountId + spaceId`。

- 默认：全局可见

### 3.4 Workspace
Account的项目与执行数据边界。

- 每个Account恰有一个Workspace；Workspace绑定以`accountId`隔离。provider/runtime属于Agent；AgentSession同时引用Account与实际Agent
- 实际项目文件位于`workspace.hostId`宿主，gateway只保存绑定、策略、状态和校验信息；gateway宿主不因承担控制面而自动复制或索引Workspace正文
- Phase 5.5当前要求`workspace.hostId === owner Agent runtime.hostId`，Execution只访问自己的Account Workspace；宿主不匹配明确`workspace_unavailable`
- gateway内的`Vera Control Service`是Workspace绑定、节点准入和Execution授权的唯一权威。Workspace Node只能在有效Agent Token与Account Session对应的owner Execution下接入；当前`executingAgentId`必须等于`ownerAgentId`，因此服务边界落地不等于开放代上线
- Control Service和Workspace Node使用第一方内部协议；协议必须能被同机函数调用或私网HTTP承载，不依赖MCP。未来MCP适配层只能把获准工具调用翻译到同一Execution授权，不能绕过Session、租约或Workspace策略
- 未来开发目标是第一方`vera.workspace` MCP：由Workspace宿主执行受Execution租约约束的文件、Git与进程工具，使非owner Agent可在不复制项目、不SSH遥控的前提下跨宿主代上线。该MCP只是受租约约束的Workspace工具平面，不是Agent身份替换、Account授权旁路或owner改绑机制。该MCP、远程工具隔离与非owner登录当前均不实现，也不阻塞owner-only闭环

**说明：**
- Memory / Files / Agent State的隔离边界可按各自契约配置；Workspace的Account边界是安全约束，不作为可放宽的普通隔离选项
- 数据层分类当前为Memory / Files / Agent State / Workspace，后续可能增加；实现时须可扩展，不得硬编码为固定枚举

---

## 四、可配置项清单

> **开发原则：所有可配置项必须引用配置变量，不允许硬编码。**

### 4.1 系统配置

本节是完整配置目录，不表示所有字段都是全局Settings字段；Memory Provider、Digest与Dream为per-Agent Data配置，Space规则为per-Space，只有明确标为全局的预算/呈现/隔离默认进入`/api/settings`。

**数据隔离规则**
- Memory原始证据随Account对Space的权限隔离；长期Memory固定per-Agent、跨该Agent被授权代表的Account/Space可用，不提供全局可读或per-Space切换开关
- Files：隔离 / 指定Space共享 / 全局可读
- Agent State：隔离 / 全局可见
- 长期记忆整理：定时触发 / 实时同步 / 手动触发

**Files**
- 附件根目录与单文件大小上限由gateway运行配置提供；默认根目录在仓库外，迁移必须走路径管理的校验→搬移→逐文件hash验证→切换→失败回滚流程
- 首版支持的扩展名/MIME组合由Files契约白名单固定，不提供任意可执行文件上传，也不把MIME探测伪装成安全扫描。客户端声明为空或`application/octet-stream`时可按已知扩展名归一到白名单MIME；声明与扩展冲突时拒绝
- 单条Message可引用的附件数量由gateway配置限制；File id必须去重并在提交Message时按目标Space当前读取策略重新校验

**记忆整理**
- active Memory Provider、placement及其Provider特有配置；路径只对文件型Provider展示，默认`vera.markdown`显示所在宿主的安全位置摘要，不把任一宿主的绝对路径当作跨设备地址
- Digest与Dream各自的执行Agent、任务模型策略与状态；执行Agent只提供自己的runtime，任务与Memory归属仍固定为owner Agent
- 长期Memory大小显示active/archived条数、Provider可提供的逻辑字节数与估算token；这是占用统计，不是quota。文件型Provider还显示只读位置并跳转受控路径迁移，不在per-Agent页保存第二份路径
- 待整理内容按已完整保存且尚未Digest的Message统计，显示Message数、字符数和`vera-utf8-v1`估算token，并按SpaceSession分组。它表示整理积压和可能仍驻留在当前AgentSession中的上下文压力，不等同provider精确计费；UI必须同时标示当前active AgentSession的估算/实测质量、容量和压力比例，不能把多个Space的总量说成“下一轮一定额外消耗”
- 注入预算（2026-07-03补）：常驻索引行数、检索注入token预算（详见memory-hook.md）

**消息呈现**（2026-07-03补）
- 气泡切分规则：段落边界模式、单气泡长度上限
- Account发言固定展示`Account名 · 实际模型名`。Account名使用普通身份样式；Phase 5.5的`executingAgentId`始终等于`ownerAgentId`且不使用“代上线”颜色。未来开放非owner执行后，可仅把模型名改用统一语义颜色而不增加代理文字标签；该保留样式必须来自`styles/tokens.css`中的CSS变量，不得在消息组件硬编码。
- Message必须冻结`accountNameSnapshot/executingAgentId/effectiveModel/delegated`，以后改Account名、会话状态或模型不得改写历史展示；Phase 5.5的`delegated`固定为`false`。

**消息响应规则**
- per-account per-Space：默认 / 静默 / 专注

**Account与Agent信息**（2026-07-17随2.2重冻结）
- Account系统管理：创建、删除、命名、所属/当前Agent、Workspace、接入Key生成/轮换/撤销
- Agent：由daemon接入登记，持有自己的Memory与provider/runtime/model能力；Account页只显示其绑定和接入状态
- Vera全局Settings中的Account管理不得承载Agent的Skills / Hooks / MCP / Data或Memory正文

**Agent使用管理**
- Agent像素形象、当前状态与当前代表的Account/Space会话属于Agent使用层；像素形象现阶段是现有Agent视觉身份的展示，不因此新增第二套Avatar/Contact持久对象
- Agent使用管理固定提供Skills / Hooks / MCP / Data四个平级目录，Memory位于Data之下
- Account详情中的所属/当前Agent与聊天消息的模型名可进入对应Agent使用页；Account头像/名称始终进入Account详情。Phase 5.5不显示非owner Agent；未来也不得把执行Agent伪装成Space联系人

**Space设置**
- 在场Account列表
- 各Account席位配置（响应模式、respondTo、屏蔽规则）
- 当前Space的消息提醒策略
- 当前Space启用/停用及配置哪些已安装Space Module

**全局设置入口**
- Appearance
- Account管理（创建Account、接入Key、所属/当前Agent、Workspace与登录审计；不作为Agent使用设置入口）
- Extension Package安装、卸载、版本、信任与权限管理
- 路径管理
- 中控台信息（gateway、SSE、文件store、各Agent Memory Provider placement、Agent daemon/presence、最近错误）
- 其他系统级可配置内容

> **边界（2026-07-17修订）**：普通路径管理只操作当前宿主能直接校验的用户数据位置；gateway页面不得把daemon或remote Provider的绝对路径当成本机路径。Memory placement、Workspace宿主与路径迁移均需由数据所在宿主执行“校验权限 → 排空 → 迁移 → 验证 → 原子换绑/回滚”。gateway数据目录等高风险路径不得做成直接生效的普通文本框。端口、SSE心跳/缓冲、store落盘节流、daemon回收、run看门狗仍走环境变量/配置文件，不进普通前端设置。

### 4.2 扩展配置

扩展体系遵守“统一安装入口，不统一运行时”。禁止用一个万能 `plugin.run()` 同时承载Tools、Skill、MCP、Hook、Agent Plugin和Space Module。

Agent使用设置固定为Skills / Hooks / MCP / Data四个平级目录，对应路由固定为`#/agents/:agentId/skills`、`#/agents/:agentId/hooks`、`#/agents/:agentId/mcp`与`#/agents/:agentId/data`。它们不得放回Vera全局`#/settings`层级。Skills只管理可加载/卸载的Skill；Hooks只管理Hook unit；MCP只管理MCP unit；Data管理该Agent的数据领域，当前首先提供Memory。Data → Memory只配置Memory结构（技术层为active Provider）、位置/状态、长期占用、待整理内容、Digest、Dream与长期Memory管理，不显示、不投影、不保存Recall/Write binding。MCP和Hook目录中的单元都展示启用开关；是否还需要其他控件由unit契约决定，不能给所有Hook强塞`executorAgentId`。gateway内置的Vera Memory MCP、Recall Hook和Write Hook均不展示执行Agent或模型。Digest/Dream的执行Agent与任务模型是Memory领域配置，只在Data → Memory中按真实执行资格候选展示，不扩张成所有MCP/Hook单元的字段。

Skills / Hooks / MCP三个目录使用同一前端页面骨架：Shell顶栏左侧返回、中间只显示一次目录名，右侧依次提供“添加”和“管理”两个动作；正文只放单列条目列表及loading/empty/error状态。条目主行显示名称，副行只显示接口真实返回的摘要或可用性，不凭前端猜测能力。可切换的真实binding在行尾显示开关；没有写接口的条目不得显示可操作假开关。Skills为空时显示“还没有 Skill”，Hooks/MCP为空时使用各自同义空态。按钮在对应动作接口未接通时仍保留稳定位置但必须为disabled并给出不可用说明，不弹出不能完成的假表单。

该统一只发生在前端view model与视觉组件，不新增“万能 capability”后端实体。Skills、Hooks、MCP继续使用各自事实来源；前端目录view不直接发HTTP，由路由/controller注入标准化条目和动作。首轮可以先完成纯前端页面、路由、空态和夹具驱动的列表行验收；生产页面不得硬编码内置unit或虚构已安装Skill。纯前端验收通过后，再把Hooks/MCP接到现有unit binding，把Skills接到后续真实Skill列表/安装契约。

Agent Plugin仍是Extension Package可包含的独立runtime类型，但0.0.1不把它做成Agent设置第五个顶层目录，也不得偷塞进Skills/Hooks/MCP/Data。其管理入口、状态与权限在Phase 6实现前另行冻结

各目录可以发起导入/加载，但底层仍归一到同一Extension Package安装与校验流程；安装完成后只把包内对应unit绑定到当前Agent。不得因多个前端入口复制包格式、安装记录、权限或运行时。

#### 4.2.1 Tools（运行时基础能力，不属于扩展）

- 逻辑能力名统一为 `web.search` / `web.fetch` / `fs.read` / `fs.write` / `process.execute` / Vera Memory/Files/消息工具；其中Vera Memory工具固定由gateway第一方MCP提供，不映射成`fs.read/fs.write`，其余能力可来自CLI原生工具、供应商API工具或agent daemon的tool host。
- CLI已有原生Tools时Vera不重复安装；agent daemon登录时报告实际capabilities，前端只展示“可用/不可用/权限策略”。不能假设所有CLI能力相同。
- API模型本身不能触及本地代码。只有承载该API Agent runtime的本地agent daemon实现tool-call循环，并在Execution中绑定当前Account Workspace后，API Agent才能读写/执行本机代码；无本地daemon/tool host的纯API runtime不能访问Mac文件。
- `web.search` / `web.fetch` 可默认允许；`fs.read` 默认只限绑定workspace；`fs.write` / `process.execute` 必须受workspace边界、审批策略和审计约束。工具权限不由Space Module或第三方扩展自行扩大。
- gateway在VPS时不代替agent daemon执行本机文件/进程Tools，也不持有本地workspace路径的事实内容。

#### 4.2.2 Skill（per-agent）

- Skill导入（文件 / 路径 / URL）
- 加载 / 卸载
- 已安装Skill列表及状态
- Skill以Markdown/提示词/工作流为主，不拥有常驻进程、持续状态或UI挂载点。
- Skill目录首轮允许真实空列表；“添加”和“管理”按钮只有在Extension Package/Skill接口落地后才启用。不得为了验收列表样式在生产代码中放示例Skill。

#### 4.2.3 MCP（per-agent runtime）

- 第三方MCP是外部Tools/数据连接；CLI已有原生MCP配置时由daemon复用或映射，API agent由daemon内的MCP client转成provider tool calls。其连接、凭据与进程运行在agent daemon一侧；gateway只保存非敏感元信息/授权状态，不代理本机MCP进程。
- **Vera Memory MCP是唯一明确的第一方例外**：Memory逻辑身份、active Provider绑定、operation校验/排序与MCP server/dispatcher都由gateway持有；物理Provider可按placement位于gateway、daemon宿主或远程服务。daemon除作为MCP client或把tools映射给CLI/provider外，也可承载自己Agent的Provider存储执行器，但不能绕过gateway接受程序写入。不得把这个例外扩张成gateway代跑任意第三方MCP
- Agent设置的MCP目录必须把`Vera Memory MCP`（unit id=`vera.memory`）作为内置unit展示；它与第三方MCP共用启用开关外壳，但作为gateway第一方服务只展示启用状态、可用性与工具清单，不提供`executorAgentId`、`semanticAgentId`、模型或语义增强开关。Recall/search的候选生成、embedding、筛选、去重、排序和token预算由gateway程序执行。未来小模型语义增强必须作为独立阶段重新冻结契约，在此之前不得预留假字段或静默调用模型。普通第三方MCP不会出现在Data → Memory的Provider候选；只有安装包中另行声明并通过`memory-provider`契约的unit才可被选择

#### 4.2.4 Hook（per-agent runtime）

- Hook是通用事件自动化目录，可以服务Memory、通知、审批、同步、日志等不同领域；它不由Digest或Dream定义。Hook必须声明触发点、运行位置、权限和失败策略；第三方runtime Hook通常运行在agent daemon，gateway内置确定性Hook按第一方契约运行
- Hook不得阻塞gateway或直接修改主前端；高风险命令仍走Tools审批。
- Agent设置的Hooks目录必须把`Vera Memory Recall Hook`（unit id=`vera.memory.recall`）和`Vera Memory Write Hook`（unit id=`vera.memory.write`）作为两个内置unit展示。Recall Hook在prompt编译前完成自动检索与安全注入；Write Hook观察completed Message和Digest调度事件，按Data配置向Memory Orchestrator提交自动Digest触发，但pending context仍由已保存Message与成功Digest水位独立派生。两者都是gateway程序Hook，不运行模型、不提供执行Agent选择、不直接写Provider。Digest与Dream是Orchestrator执行的隔离模型任务，不作为Hook unit安装或展示

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
- `plan/index.md` 只维护功能状态与入口；每个功能自己的计划文件记录该功能的 API、前端入口、消费者与验收状态。新增可配置项先补 ground truth 与契约，再更新对应功能计划并实现。

---

## 五、前端功能模块

### 5.1 页面职责与路由

Vera不再使用底部固定标签。主页就是当前Space的全屏聊天；低频管理通过当前Space设置、右滑Space导航和全局Settings进入。

| 页面 | 路由 | 唯一职责 | 不得承载 |
|---|---|---|---|
| App Shell | 全局 | 路由、顶栏、safe-area、gateway连接状态、页面容器 | 底部主标签、业务表单、对象CRUD、页面专属数据 |
| 全屏聊天主页 | `#/spaces/:spaceId` | 当前Space的active SpaceSession时间线、广播、正文内@定向、实时AgentState、输入栏；精确`/compact`与`/new`作为控制命令提交 | 把归档SpaceSession混入可写时间线；常驻发送对象选择器、Space列表管理、Account编辑、全局设置 |
| SpaceSession历史 | `#/spaces/:spaceId/history`、`#/spaces/:spaceId/history/:spaceSessionId` | 列出该Space由`/new`产生的归档对话窗口，并只读查看其时间线 | 恢复归档Session、composer、新Run、compact或修改历史 |
| Space导航 | 聊天页左侧可折叠目录（`#/spaces`只作为可恢复的打开态深链） | 左侧Account/群头像投影；右侧所选成员集合的Space目录；切换、新增、重命名、归档/恢复Space | 固定选项或第二套持久状态；当前Space Seat/组件/提醒配置；Contact实体或Contact CRUD |
| 当前Space设置 | `#/spaces/:spaceId/settings` | 当前Space参与Account、Seat响应规则、消息提醒、Space Module启用与配置 | 切换/新建其他Space、全局扩展安装、Agent Memory或runtime配置 |
| Setting目录 | `#/settings` | 轻量平铺入口；不预加载各子页数据 | 无实际层级依据的分组标题；把所有设置表单和状态面板渲染在同一页 |
| Appearance | `#/settings/appearance` | 外观实时预览、保存、恢复默认 | 业务行为或页面数据配置 |
| Account系统管理 | `#/settings/accounts`、`#/settings/accounts/:accountId` | 新建/删除/命名Account，生成/轮换/撤销接入Key，查看所属/当前Agent、Workspace、Space与最近20条安全登录审计 | Agent Memory正文、Skills/Hooks/MCP/Data；provider/model表单；直接创建空Agent；原始身份头、boot id、Token/fingerprint或宿主路径 |
| Agent使用管理 | `#/agents`、`#/agents/:agentId` | 展示已登记Agent的实际runtime、当前代表Account及Skills/Hooks/MCP/Data四个平级入口 | Account Key、Space Seat、Workspace归属；从此页新建Account |
| Agent Skills / Hooks / MCP | `#/agents/:agentId/skills`、`.../hooks`、`.../mcp` | 共用单列目录骨架、真实空态和顶栏“添加/管理”；按各自controller注入条目，Hooks/MCP后续接unit binding，Skills后续接Skill契约 | 建万能capability后端资源；在生产代码硬编码示例条目；接口未接通时提供可完成假动作 |
| Agent Data | `#/agents/:agentId/data` | 列出该Agent的数据领域入口，当前只有Memory；沿用目录列表视觉但不是Skill/MCP/Hook unit资源 | 把Data域伪装成扩展unit；在索引页预取Memory配置、状态或正文 |
| Agent Data → Memory | `#/agents/:agentId/data/memory` | 以“Memory结构”展示active Provider，查看位置/状态、长期占用与待整理token压力；分别配置Digest和Dream执行Agent、任务模型、触发/调度；失效选择原样保留并警告。手动Digest必须从待整理列表选择一个明确的Account + SpaceSession范围，不能把跨窗口汇总直接提交；页面另提供立即Dream与长期Memory管理 | 显示或复制Recall/Write Hook binding；把跨Space总量说成下一轮精确消耗；展示未安装Provider假选项；静默改投其他Agent/模型或猜测Digest窗口 |
| Agent Memory管理 | `#/agents/:agentId/data/memory/library` | 查看、编辑当前Agent active Provider支持的长期Memory；作为Data → Memory的下一级目录按需进入 | 列表页预加载所有Agent的Memory正文；在Provider不支持编辑时伪造CRUD |
| Extension管理 | `#/settings/extensions` | Extension Package全局安装、卸载、来源、版本、信任、权限 | 直接替当前Agent/Space决定启用状态 |
| 路径管理 | `#/settings/paths` | gateway placement Memory vault、Files附件根与gateway数据根的受控迁移入口；远端位置跳对应Agent Data | 把远端路径当本机路径，或直接暴露可把gateway配死的运行参数 |
| 中控台 | `#/settings/control-center` | gateway/SSE/store、各Agent Provider placement、daemon状态和最近错误 | 后台永久轮询、虚构当前不存在的数据库连接 |
| 系统设置 | `#/settings/system` | 数据隔离、全局注入预算、消息呈现等全局配置 | per-Agent Provider/Digest/Dream、Space Seat、Account详情、Appearance |

- 联系人只存在于Space导航的展示层：单个Account或Account成员集合。允许组件使用`contact-rail`等UI命名，但store/API不得出现Contact CRUD或Contact持久记录。
- Account是Space对外身份和项目数据边界；Agent是可替换的实际执行者。Memory与provider/runtime/model归Agent，Space/Workspace/Files可见性归Account。
- Files 属于 Space 作用域，契约落地后使用 `#/spaces/:spaceId/files`；在此之前不建空壳页面。
- Terminal 等未来功能必须先进入 ground truth 与 API 契约，再决定从Settings还是当前Space进入；现有页面不得提前吞下它的职责。

### 5.2 页面之间如何协作

- 聊天顶栏左上按钮与右滑共用同一个Space目录开关；中间当前Space名称进入`#/spaces/:spaceId/settings`；右上按钮进入全局Settings。目录、当前Space设置与全局Settings不得复用页面或入口语义。
- 手机右滑或点击左上按钮展开Space目录，不显示占用聊天边缘的额外常驻按钮；展开后目录从左侧把聊天主区向右挤窄，而不是覆盖、替换聊天或导航到设置页。桌面使用同一目录view和开关。打开期间切换Space不收起目录；只由顶栏开关或离开聊天页收起，不提供“固定”选项或持久化固定状态。
- Space导航左栏选中Account/群后，右栏只列出成员集合匹配的活跃Space。新增Space继承当前Account成员集合并创建首个active SpaceSession；重命名、归档操作只作用于选中的Space记录。Space归档仅写`archivedAt`并保留Space、active SpaceSession、历史与provider bindings；已归档Space从活跃列表移出，在导航的“已归档Spaces”入口查看、恢复或永久删除。永久删除只允许已归档Space，必须二次确认并清除Space、Message、Activity、Run、Approval、SpaceSession、AgentSession及其上下文记录。确认框提供默认不勾选的“同时删除全部来源均属于该Space的Memory”：不勾选时保留所有Memory，并把被删Message的SourceRef改成明确不可溯源的`deleted-message`墓碑；勾选时额外永久删除唯一来源Space为当前Space的Memory，混合来源Memory仍保留并墓碑化当前Space来源。任一Memory预检或写入失败时不得删除Space。`/new`产生的SpaceSession归档另从当前Space的“历史对话”入口只读查看，绝不提供恢复。
- 聊天时间线中Account头像/名称进入`#/settings/accounts/:accountId`；实际模型名可进入`#/agents/:executingAgentId`。Phase 5.5只有owner执行；未来非owner执行也不得改变Account头像、名称或Space成员。
- 跨页面只传稳定ID和筛选条件。Agent使用管理先进入Skills / Hooks / MCP / Data任一平级目录；Data先列出Memory，再进入`#/agents/:agentId/data/memory`查看配置与状态，最后按需进入`#/agents/:agentId/data/memory/library`管理长期Memory。Memory两页复用同一Memory领域client，但不得把Provider配置、job状态和正文编辑塞回Account系统管理或同一个巨型页面。
- 当前Space的Files页面只从聊天composer附件入口或当前Space设置进入，固定返回该Space聊天页；页面列出该Space当前可读Files，并仅对owner Files开放共享范围编辑和删除。共享进来的File必须明确标出owner Space且保持只读。
- 持久对象的详情与编辑使用可重载、可前进后退的路由；弹层只用于确认、选择和短暂输入，不用弹层藏完整页面。
- Space目录只属于聊天页，不得带入当前Space设置、全局Settings、Agent使用管理或其子页。所有管理页都是独立全屏页面，顶栏左上统一为返回、中央只显示一次页面标题，正文不得再重复返回入口或`h1`标题。Skills / Hooks / MCP可在同一Shell顶栏右侧声明“添加/管理”两个页面动作；其他页面没有契约时不得顺手增加。必须复用同一路由和同一份状态，不另造桌面业务实现。
- 聊天输入栏只属于 Space 页面。其他页面不得借用主聊天区作为自己的布局容器。
- 聊天输入栏不显示“全部”或Account下拉选择器：普通消息默认广播；正文中直接写当前Space内的`@Account名`时，由前端解析为定向消息，正文保留该署名。

### 5.3 提前拆分规则

前端不等文件膨胀后再拆。下列边界已经有真实用例，首轮实现就必须分开：

- `views/`：Shell、Space导航、Space聊天、当前Space设置、Settings目录、Account系统管理、Agent使用管理、Agent capability目录、Agent Data/Memory配置、长期Memory管理、Extension、路径、中控台、系统设置、Appearance分别独立。Skills / Hooks / MCP三个路由可复用一个无HTTP职责的capability目录view；一个view不得同时拥有两个对象的写流程。
- `api/`：保留一个只负责HTTP基础行为的client；按 `spaces` / `agents` / `accounts` / `settings` / `memory` / `extensions` / `status` / `events` 分领域文件，不把所有请求继续堆进 `gateway-client.js`。
- `state/`：路由、Space导航、Space/时间线、Account系统管理、Agent使用分页、Settings/Appearance、Extension分开；前端只缓存UI状态，不复制gateway事实来源。
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
- **上下文必须缓存友好且有界**（2026-07-15修订）：同一AgentSession generation内稳定前缀保持不变，动态群聊视角与Recall只进入本轮volatile信封；长期记忆更新成批生效。CLI型agent复用外部thread直到compact/new/失效换代；API型agent由Vera保存规范history/checkpoint并按容量重建有界messages。任何provider都不得以静默截断代替Vera的自动压缩或明确`context_capacity`错误

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
- `AGENTS.md` 已预先列出Capacitor配置文件及生成的 `android/`、`ios/` 目录，但这只是结构放行，不是立即生成授权。只有 `plan/native-clients.md` 的F6标为进行中且用户在当前任务明确授权进入F6后，才可执行Capacitor初始化/平台生成命令；新窗口必须重新核对这两个条件。

---

## 七、待定 / 待补充

- ~~Memory Hook机制细节~~ 已就位：`memory-hook.md`（2026-07-02入库）
- 记忆整理各环节执行者的最终分配
- 数据层是否增加第四层
