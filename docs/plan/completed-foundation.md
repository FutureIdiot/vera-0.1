# 已完成：基础、Phase 0–4与Phase 5.5身份迁移切片

本文只保存完成事实和迁移证据，不定义当前产品语义。发生冲突时以Ground Truth和现行契约为准。

## Phase 0–1：旧repo经验与契约

- 已将旧Vera可复用经验整理进 `docs/salvage-notes.md`；旧repo继续只读。
- 已建立 `docs/api-contract.md` 与 `docs/adapter-interface.md`。
- adapter只承诺自身负责会话连续性，不把daemon常驻或CLI resume生命周期泄露给gateway。

## Phase 2：核心垂直切片

- 已完成Node ESM gateway、SSE、分集合JSON store、mock adapter、OpenCode adapter、Agent、默认Space和最简流式网页。
- `scripts/verify.mjs`已成为黑盒验收入口。
- store的`dataPath`从单文件迁移为目录，旧`store.json`可一次迁移；对外store API不变。
- 本机开发与手测固定`PORT=3210`。旧Vera占用3000；除`verify.mjs`自动选择空闲端口外，不自行换端口。
- 2026-07-03真机验收确认消息流、会话连续性、gateway重启恢复与SSE reset语义。

## Phase 3：历史公网切片

- 2026-07-03曾用Cloudflare Tunnel与Access完成蜂窝网络、锁屏/后台重连和SSE逐帧验收。
- 该方案已被Tailscale纯私网目标取代，只作为历史证据，不再指导部署。
- Cloudflare静态资源缓存导致手机拿不到新JS/CSS的教训已由Web production hash资源与HTML协商缓存收口。

## Phase 4：消息、配置与管理基础

- 已完成Agent与Account对象分域、Speaker view编译层、响应规则、Space管理和系统设置。
- Speaker view只注入Message，不注入Activity；他人消息以署名声告进入volatile输入，不伪装成目标Agent的assistant历史。
- seat已支持`responseMode/respondTo/blockAgentIds`。
- `GET/PATCH /api/settings`、运行时override和配置consumer基础已完成。
- Phase 4当时实现的`Agent 1:N Account`与可变连接Account属于历史形态，已由下述Phase 5.5切片一次迁移，不再作为现行兼容层。

## Phase 5.5：Account/Agent联邦基础切片

- 2026-07-17完成严格`Account 1:1 owner Agent`迁移；预检发现1:N或冲突数据时在任何写入/备份前阻止启动，不复制Memory、不静默拆Agent。
- Space Seat、定向目标、respondTo/block名单、消息展示身份和通知模式统一迁为Account；AgentSession使用`spaceSessionId + accountId + agentId`，Run冻结`accountId/agentId/runtimeRevision/effectiveModel/delegated`，为未来非owner代上线保留独立执行维度但当前不开放。
- Agent的公开`runtimeProfile`固定为稳定纯JSON `{schemaVersion,kind,provider,model}`；本机connection独立保存在非公开runtime binding，Account、Workspace、凭证、secret/secretRef、绝对路径和daemon派生状态均不进入profile。
- Account成为前端首层创建与Space联系人；消息持久化Account名称快照、实际执行Agent、实际模型与delegated标志。
- Account Key创建/轮换/撤销基础已实现：明文只在创建或轮换响应出现一次且响应为`no-store`，持久化仅保存salted scrypt材料和单调版本。
- 2026-07-18完成gateway内唯一`Vera Control Service`：`enroll/login/logout`实现Agent Token + Account Key低频重新授权和Agent Token +进程内Account Session普通续连；gateway的Agent Token文件只保存SHA-256校验摘要，Account Session只保存进程内hash并绑定两端boot、Agent Token fingerprint与Key version。daemon/gateway重启、登出、Key轮换或撤销均使旧Session失效；非owner固定`delegation_unavailable`，重复owner竞争固定`account_busy`。
- Workspace控制面已实现首次原子绑定、精确匹配register及逐Run authorize；普通Account和Workspace投影不返回绝对路径或policy原文，失败login不留下runtime/Workspace部分写入。当前仍不包含Workspace Node独立进程、远程文件/Git/process、MCP或非owner代上线。
- 2026-07-18收口Workspace数据边界：`hostId`固定表示可解释同一组绝对路径的Vera宿主命名空间；Workspace只承载Account项目执行边界，不吸收Space时间线、会话或附件。在线绑定与存量store统一规范化路径，规范化`(hostId,path)`最多属于一个Account；重复存量绑定在任何写入前阻止启动，迁移幂等。Space/Message/File纯性与普通投影不泄露path/policy均有独立回归测试。
- 2026-07-18完成Account Session与Execution租约闭环：每次Session签发非秘密`accountSessionId`，daemon Run必须预先绑定同一Session并原子取得唯一`executionLeaseId`后才能running；同Account pending可排队、running只能一个，幂等authorize不重复发`run.started`，旧Session和`gateway-local` Run不能认领daemon租约。过渡期两种transport也做对称互斥，旧Run幂等补为`gateway-local`且不重跑身份迁移。
- Control Service公开后续SSE/Run端点可复用的Account Session鉴权能力，但只返回去除Token hash的内部安全上下文；`accountSessionId/executionLeaseId`均不能替代Agent Token + Session Token认证。
- 2026-07-18完成daemon本机凭证存储基础：`config.agentDaemon.secretsPath`默认`~/.vera/secrets.json`，`agentCredentials[agentId]`只持久化Agent Token与User选择保存的per-Account Key；严格拒绝符号链接、非`0600`文件及任意AccountSession字段，原子更新时保留其他顶层secretRef数据。AccountSession继续只存在于daemon/gateway当前进程；登录、心跳与授权控制面不调用模型。
- 2026-07-18完成Memory Provider placement持久形状与存量登记：provider严格保存`providerId + placement + config`，独立v2迁移把Phase 5现存`vera.markdown`幂等登记为`gateway`且不触碰Memory正文；binding version包含placement，普通PATCH不能偷换宿主。非gateway placement在daemon driver接线前明确unavailable，HTTP Memory读写与新整理任务均在触碰gateway vault前拒绝，状态投影不返回绝对路径。新CLI的daemon默认绑定留给后续真实daemon首次login，既有gateway数据不静默改挂。
- gateway-local Digest/Dream已按Memory owner与executor分离：任务从执行Agent的`runtimeProfile/runtimeBinding`冻结runtime revision和对应任务已验证模型，不读取Account兼容字段；Recall/Write仍是无executor的gateway确定性Hook。执行Agent、runtime、模型或资格失效时固定`memory_task_unavailable`且不fallback。
- 2026-07-18完成Account登录审计闭环：Control Service对可安全归属的`enroll/login/reconnect/logout`成功与拒绝写入严格七字段记录，Key轮换/撤销写枚举化`session_revoked`成功记录；每Account按`createdAt desc,id desc`只保留最近200条并持久化，普通Account投影完全剥离审计。`GET /api/accounts/:id`严格返回Account、所属/当前Agent与最近20条安全记录，Workspace只含安全摘要；Account详情页只消费冻结字段并有专项空态/禁字段测试。显式logout与Key变更保持Account离线、释放租约且不改AgentSession、Workspace或Memory。
- 2026-07-18完成Data → Memory配置与手动Digest收口：`_options`按Digest/Dream和精确`runtimeRevision`投影已验证模型及唯一默认模型；页面以CAS保存完整Digest/Dream配置，保留失效选择并禁止fallback，展示Provider、长期Memory、待整理token估算与当前窗口压力，支持零/一/多待整理范围和Dream合并请求。手动Digest的`accountId + spaceId + spaceSessionId`从HTTP、自动调度与可信MCP贯穿到可见范围、job `sourceAccountId`、watermark、幂等、活跃冲突和执行tail；旧job只在owner与Space Seat唯一可证明时回填，歧义不猜测。
- 2026-07-19完成Account详情与Session安全收口：Account详情只从共享bootstrap按Seat派生active Space，不复制接口或开放owner改绑/接管。Key轮换、Key撤销、logout与内部security revoke统一中止并终态化该Account全部pending/running Run、streaming Message、在途Activity和Approval，固定持久错误`account_session_revoked`并按契约发布五类终态事件；迟到delta、Activity、Approval及adapter finish不能覆盖撤销终态。控制面mutation队列改为per-Account，不同owner Session与Execution可并行，同一Account的单Session/单running约束保持；凭证负面矩阵、非owner与Memory/provider隔离回归通过。
- 2026-07-19完成联邦状态与owner入口安全边界：AgentState改为daemon声明的`agentId + accountId + spaceId`三元运行态，严格限制八种英文状态并按三维过滤/合并，gateway-local Run不再猜测`working`；同一owner pair在不同Space互不覆盖，非owner和伪造维度均拒绝。Account login/reconnect、logout及Session撤销发布完整`account.presence.updated`，离线定向@不创建Run而写`agent-offline` Activity，上线后不补发。
- Owner入口只接受loopback Tailscale Serve注入的`Tailscale-User-Login`并精确匹配部署allowlist；`/api/health`最小豁免，`/api/agent/*`保持独立Agent凭证链，其余API、SSE和静态页面统一fail closed。原生CORS只接受同源或配置化精确Origin，严格校验预检方法/头并拒绝通配符、credentials、近似Origin及身份头伪造；显式本地开发豁免只允许loopback且生产禁止。
- 2026-07-19完成Agent daemon与跨进程Run链路：Space消息只为在线owner Agent创建pending daemon Run，冻结Account/Agent/Workspace/runtime/model与CLI/API分型input，取得Execution租约后经独立`/api/agent/events`分发；`messages.js`不再调用gateway进程内adapter执行真实消息Run。daemon用本机Agent Token与可选Account Key重新授权，普通重连只使用进程内Account Session，连续心跳失败终止在飞任务且不回退公网入口。
- daemon Run覆盖CLI增量与binding CAS、API bounded input与history CAS、isolated subagent、Activity、Approval、取消和安全终态；迟到结果不能越过Session、lease、generation、history或binding版本。compact使用独立request/result且不发布聊天Message；Digest/Dream使用仅接受Agent凭证的独立Memory task SSE/result通道，携带冻结runtime指纹、安全任务摘要及取消/超时语义，不复用聊天Run、AgentSession、Message、Activity或provider binding。迁移验收前仍保留显式可选的进程内Memory task transport，同一任务失败不跨transport fallback。
- Runtime完成不等于Memory正文已经跨宿主：daemon placement Provider的首次绑定、正文搬迁、逐条验证与原子换绑仍由VPS/Tailscale部署阶段完成；既有gateway placement保持原位，login不会静默改挂。
- 截至runtime收口时验收：`npm test`为383通过、3个显式opt-in跳过，`npm run build:web`通过，`node scripts/verify.mjs`为95/95；黑盒Codex/Ollama路径均通过真实daemon HTTP/SSE而非gateway-local执行。固定`PORT=3210`临时gateway启动成功，`GET /api/health`返回200。
- 2026-07-23完成Account所属Agent与聊天模型选择拆分：Account持久保存独立`model + modelVersion`，候选只来自owner Agent最新安全`runtimeCapabilities.models`；存量Account从owner默认模型幂等迁移，当前选择失效时保留原值并阻止新Run，不静默fallback、改owner、迁移Memory或改Workspace。模型更新使用严格候选校验、CAS与Account busy防护，成功后轮换该Account全部active AgentSession generation；后续Run冻结`effectiveModel + modelVersion`，subagent沿用父Run快照，daemon拒绝未接入模型并把冻结模型传给adapter。
- Account详情把“所属 Agent”和“模型”作为独立词条，模型下拉只消费详情接口的`modelOptions`，presence更新后重新读取权威候选；无owner、无候选、失效选择和写入冲突均保持真实不可用状态。最新验收为`npm test`416通过、3个显式opt-in跳过，`npm run build:web`通过，`node scripts/verify.mjs`95/95；固定`PORT=3210`临时gateway实测健康、独立模型投影、owner候选及409 `model_unavailable`全部通过。
