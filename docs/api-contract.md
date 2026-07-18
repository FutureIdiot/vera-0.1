# API 契约

> 前后端唯一接口基准。接口变更先改本文档再动代码。
> 覆盖 Phase 2–4 所需；标注 `[P4]` / `[P5]` 的条目在对应阶段前不实现，但形状现在定死。

---

## 一、通用约定

- 所有接口挂在 `/api/` 下；除SSE与Files原始二进制上传/下载外，请求与响应均为JSON。
- 时间一律 ISO 8601 UTC 字符串（`2026-07-02T03:00:00.000Z`）。
- ID 带类型前缀的随机串：`agt_` / `spc_` / `sps_`（SpaceSession）/ `ags_`（AgentSession）/ `msg_` / `fil_` / `run_`。
- 错误统一形状，HTTP 状态码配合语义：

```json
{ "error": { "code": "not_found", "message": "space spc_xxx does not exist" } }
```

`code` 枚举：`invalid_request`(400) / `control_command_required`(400) / `memory_cursor_invalid`(400) / `unauthorized`(401) / `account_reauthentication_required`(401) / `forbidden`(403) / `delegation_unavailable`(403) / `not_found`(404) / `memory_cursor_expired`(410) / `conflict`(409) / `account_busy`(409) / `workspace_unavailable`(409) / `session_busy`(409) / `context_capacity`(409) / `history_conflict`(409) / `memory_job_active`(409) / `memory_task_unavailable`(409) / `file_too_large`(413) / `unsupported_file_type`(415) / `invalid_file`(422) / `invalid_memory_file`(422) / `memory_provider_unsupported`(422) / `adapter_unavailable`(502) / `memory_retrieval_unavailable`(503) / `memory_provider_unavailable`(503) / `internal`(500)。`account_reauthentication_required`表示Account Session Token缺失、失效或与当前daemon/gateway boot、Agent Token fingerprint、Account Key version不匹配，daemon必须用Account Key重新授权；`delegation_unavailable`表示已认证Agent不是目标Account的owner，当前版本不开放代上线；`account_busy`表示目标Account已有owner会话或Execution，重复登录不得强制接管；`workspace_unavailable`表示owner runtime与Workspace宿主不匹配或对应宿主当前不可用；`session_busy`表示SpaceSession仍有未结束Run或compact，不能执行`/new`；`context_capacity`表示目标AgentSession在hard水位前未能完成安全压缩；`history_conflict`表示API Run以过期`historyVersion`提交结果；`control_command_required`表示精确`/new`或`/compact`被错误提交到Message端点。`file_too_large`表示请求声明或流式读取已超过配置上限；`unsupported_file_type`表示扩展名不在白名单或声明MIME与扩展冲突；`invalid_file`表示附件物理文件缺失、hash不符、是符号链接或不完整。`memory_job_active`表示Provider切换被该Agent在途Digest/Dream阻止；`memory_task_unavailable`表示已保存的执行Agent、runtime revision、任务模型或对应资格当前不可用；`memory_provider_unsupported`表示候选未声明/未通过Memory Provider契约或不支持所需操作；`memory_provider_unavailable`表示active Provider已绑定但当前不可达。不得用泛化的`unauthorized/forbidden/conflict`隐去这些原因。错误对象可带领域专用的`details.reason`等安全字段，但不得包含Key、token、secret、provider原文、宿主路径或改变`code/message`的通用包络。

- Workspace首次绑定若发现规范化`hostId/path`已属于另一Account，同样返回409 `workspace_unavailable`；错误响应不得包含冲突Account id或绝对路径。
- Secret默认不出现在响应中。唯一例外是契约明确的一次性签发响应：Account Key创建/轮换、首次enroll的Agent Token、Key模式login的AccountSession Token；这些响应必须`Cache-Control: no-store`且不得进入日志、SSE或后续GET。daemon本机`~/.vera/secrets.json`中的`agentCredentials[agentId]={agentToken,accountKeys:{[accountId]:accountKey}}`只保存持久Agent Token及User选择保存的低频Account Key；AccountSession Token不得落盘。该文件必须是`0600`普通文件且不得为符号链接；实现只更新`agentCredentials`并保留其他顶层secretRef数据。
- 未带限定词的“Session”不得用于协议说明：登录授权写作Account授权会话（`AccountSession`），Space窗口写作`SpaceSession`，模型上下文写作`AgentSession`，CLI/provider连续性写作provider thread/session。AccountSession失效不删除后三者或Memory/Workspace数据。
- 生产部署的全部 `/api/*` 只允许经 Tailscale Serve 私网入口到达。普通客户端请求校验 Serve 注入的 owner Tailscale identity；`/api/agent/*` 在 tailnet 门禁之外再用 `Authorization: Bearer <vera-agent-token>` 识别具体 agent（token 文件 `~/.vera/agent-tokens.json`）。不定义公网匿名入口。详见 ground truth 2.4。

## 二、数据形状

### Agent（ground truth 2.2）

Agent = 实际执行者。稳定身份、私有Memory及Skills / Hooks / MCP / Data配置按`agentId`归属；provider/runtime/model由该Agent daemon登记。每个Agent固定拥有一个owner Account；未来可以临时代表其他Account，但代表关系只存在于Account Session、`activeAgentId`与Execution，不写回Agent对象或`ownerAgentId`。Workspace与项目执行权限以相应`accountId`建模；Space时间线和附件以`spaceId`共享，Account通过Seat参与。它们均不并入Agent对象；Agent不得读取另一Agent的Memory。

```json
{
  "id": "agt_x1y2",
  "name": "Codex",
  "runtimeProfile": {
    "schemaVersion": 1,
    "kind": "cli",
    "provider": "codex",
    "model": "gpt-5.6-sol"
  },
  "createdAt": "…",
  "updatedAt": "…"
}
```

- Agent由daemon首次接入时登记；普通前端不提供“新建空Agent”动作。
- `runtimeProfile`是版本化、纯JSON、可稳定序列化的便携配置；当前形状严格为`{schemaVersion:1,kind,provider,model}`。它不含Account/owner归属、Workspace、`hostId`、session、presence、lease、token、Key、secret、`secretRef`或绝对路径，也不包容provider原始配置。同一归一化profile必须产生稳定JSON，以便直接导出；本步不新增导入/导出endpoint。
- `revision/runtimeCapabilities/connectionFingerprint`、`hostId`和在线状态属于daemon派生的runtime snapshot，不属于导出profile；真实执行时仍须匹配本次报告的runtime revision。
- Agent token唯一绑定`agentId`，用于证明实际执行者并绑定Memory；它不授予任一Account访问权。
- 改provider/model改的是Agent runtime；不得迁移或复制Memory。

`[P5-M4内置unit；Phase 5.5/6通用运行时]` MCP/Hook unit binding是独立资源，最小公共语义为`{agentId,unitId,kind,name,enabled,runtime,version}`。`runtime`至少区分`gateway/daemon`；执行Agent不是所有Hook的强制公共字段，只有unit manifest明确声明需要代理执行时才可附带可选`executorAgentId`及候选。gateway内置确定性unit没有该字段。Digest/Dream的`modelMode/model/schedule`属于Data → Memory领域配置，不是Hook字段。内置unit固定为MCP `vera.memory`、Hook `vera.memory.recall`与Hook `vera.memory.write`，名称分别展示为`Vera Memory MCP`、`Vera Memory Recall Hook`和`Vera Memory Write Hook`；三者均为`runtime:"gateway"`且无执行Agent/模型。Digest与Dream由Memory Orchestrator创建隔离模型任务，不注册为unit；Hooks目录仍可包含任意其他领域Hook。

unit binding统一使用同一资源接口，不为MCP、Hook或Memory另建第二套绑定事实来源：

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/agents/:agentId/unit-bindings?kind=<mcp-or-hook>` | 返回`{bindings:[{agentId,unitId,kind,name,enabled,runtime,availability,executorAgentId?,version}]}`；`kind`必填且只允许`mcp`或`hook`。仅manifest声明需要代理执行的unit可返回`executorAgentId`与安全候选；不暴露Account连接、secret或任务模型 |
| PATCH | `/api/agents/:agentId/unit-bindings/:unitId` | body严格为`{enabled?,executorAgentId?,ifMatch}`；只修改已安装/内置unit的binding。未声明代理执行的unit若收到`executorAgentId`则400；声明该字段的unit必须校验owner有权选择的现存Agent。成功返回`{binding}`，version冲突409，unit或Agent不存在404 |

`unitId`本身全局唯一，因此PATCH不再重复传`kind`；gateway仍按已安装unit清单校验其真实类型。`vera.memory.recall`与`vera.memory.write`的状态只在Hooks目录读取、展示和修改；Data → Memory不得读取、投影或复制它们，也不能把同字段写进`memory/_config`。关闭Recall只停止自动检索/注入；关闭Write停止scheduled/realtime等所有自动Digest enqueue，不影响Message保存、pending context统计、owner手动Digest、MCP手动Memory写入或Dream调度/手动Dream。

Skills不复用unit binding接口，也不为了统一页面外观扩展`kind=skill`。真实Skill列表、导入、加载与卸载仍等待Extension Package/Skill契约；在该契约落地前生产前端使用合法空列表，不调用不存在的HTTP端点。

Skills / Hooks / MCP共用的只是前端目录view接口，不是gateway资源。路由/controller向view注入以下标准化投影；该形状不持久化，也不作为HTTP响应：

```json
{
  "kind": "skill | hook | mcp",
  "items": [{
    "id": "stable-domain-id",
    "name": "display name",
    "summary": "optional truthful summary",
    "enabled": true,
    "availability": "available | unavailable | unknown",
    "version": "optional-write-version",
    "canToggle": true,
    "toggleUnavailableReason": null,
    "canOpen": false
  }],
  "actions": {
    "canAdd": false,
    "addUnavailableReason": "Skill接口尚未接入",
    "canManage": false,
    "manageUnavailableReason": "Skill接口尚未接入"
  }
}
```

`enabled`在该领域没有开关时为`null`，`version`无CAS写入时为`null`；不得用默认值伪造启用状态。`*UnavailableReason`在动作可用时为`null`，不可用时必须提供可展示说明。Hooks/MCP接线阶段从上述unit binding响应映射，Skills在真实接口落地前固定为`items:[]`。目录view只渲染投影并发出`add/manage/toggle/open`意图，不import HTTP client，不知道endpoint。controller没有提供动作处理器时，顶栏“添加/管理”和行内开关必须disabled；视觉夹具只用于测试或UI Lab，不得进入生产路由。

### Account（ground truth 2.2 2026-07-17重冻结）

Account = 某个固定owner Agent在Space中的持久对外身份 + Account Workspace与项目执行权限边界。Space时间线及Space-owned Files由gateway按Space共享管理，Account通过Seat取得参与身份和响应规则，不拥有或复制整份Space数据。除首次接入前的待绑定状态外，Account与owner Agent严格1:1。Phase 5.5当前只允许owner Agent登录自己的Account；非owner代上线等待未来`vera.workspace` MCP闭环后另行开放。

```json
{
  "id": "acc_a1b2",
  "name": "GLM",
  "ownerAgentId": "agt_glm",
  "presence": "offline",
  "lastSeenAt": "2026-07-04T10:58:00.000Z",
  "activeAgentId": null,
  "runtimeCapabilities": null,
  "accessKeyState": "active",
  "accessKeyVersion": 1,
  "workspace": null,
  "createdAt": "…",
  "updatedAt": "…"
}
```

- `ownerAgentId`：该Account固定属于哪个Agent。新Account首次且仅首次`enroll`时若为空则原子写入；建立后不可普通修改，且同一Agent不能成为第二个Account的owner。
- `activeAgentId`：当前实际代表该Account在线的Agent，来自Account登录会话；Phase 5.5当前只允许等于`ownerAgentId`或`null`。字段保留未来代上线扩展，但当前不得写入非owner id。
- Account不保存`kind/provider/model/connection`。这些属于实际Agent runtime；消息展示使用Execution冻结的`effectiveModel`。
- 普通Account投影中的`workspace`只能是`null`或安全摘要`{accountId,hostId,status,lastValidatedAt?,updatedAt?}`；完整Workspace的`path/policy`只留在受控Workspace内部接口，不得进入Account列表、详情、bootstrap或SSE。
- Account access key是可轮换、可撤销的低频重新授权凭证，不是每次连接凭证。公开`accessKeyState`只允许`active/revoked`，`accessKeyVersion`每次创建、轮换或撤销都单调递增；gateway仅在active时保存salted hash，创建或轮换响应中明文只返回一次，普通GET、日志和SSE永不返回明文/hash。无人值守daemon可把明文保存在其本机`~/.vera/secrets.json`，但不得回传到gateway store。
- Account Session Token是高熵opaque随机串、进程内、不可持久化的续连凭证。每次签发同时生成非秘密`accountSessionId`；它只用于Run绑定和审计，不具备认证能力。`daemonBootId`与`gatewayBootId`分别在对应进程每次启动时随机生成且不落盘；gateway以`agentId + accountId + agentTokenFingerprint + accessKeyVersion + daemonBootId + gatewayBootId`绑定，并只在内存保存Token hash与校验记录，daemon只在当前进程内持有明文。它没有周期性过期时间，但gateway或daemon进程重启、显式登出、Key轮换/撤销或安全撤销都会令其失效。该“daemon重启后重验”边界依赖受信daemon遵守Session Token不落盘；宿主已被攻陷时，持久Agent Token与可选持久Account Key也已不再安全，不另伪造远程证明。
- 建立或重新建立Account Session必须同时证明Agent Token与Account Key，并要求token的`agentId === account.ownerAgentId`。普通HTTP/SSE断线重连改用Agent Token + Account Session Token，不再次发送或校验Account Key。唯一例外是Account尚未绑定owner时的首次`enroll`：Account Key可创建且只创建一个全新的owner Agent身份并一次性换取其Agent Token。owner建立后不得再次`enroll`；非owner持有Key仍返回403 `delegation_unavailable`。
- **单活跃Account会话与Execution租约** `[P5.5]`：同一Account同时只能有一个owner Session和一个running Execution。携带当前有效Session Token的普通续连不是重复登录；新boot以Key重新授权时，只有旧Session已离线且无在飞Execution才可替换，否则返回409 `account_busy`。不存在跨Agent takeover。
- **单活跃Agent会话** `[P5.5]`：同一Agent同时只能登录自己的唯一Account，不得持有其他Account会话。
- `runtimeCapabilities`是owner Agent runtime与其Workspace策略的临时能力交集快照，离线为`null`；真实Agent能力仍以daemon报告为准。
- Account登录审计是Control Service持久的安全记录，形状严格为`{id,accountId,agentId,event,result,reasonCode,createdAt}`：`agentId`可为`null`，`event`只允许`enroll/login/reconnect/logout/session_revoked`，`result`只允许`succeeded/rejected`。普通成功的`reasonCode=null`；拒绝时复用本契约稳定API error code；`event=session_revoked`时`result=succeeded`且`reasonCode`只允许`access_key_rotated/access_key_revoked/security_revoked`。每个Account最多保留最近200条，Account详情按`createdAt desc,id desc`只返回最近20条。记录及响应不得包含Account Key、Agent/Account Session Token及hash/fingerprint、daemon/gateway boot id、原始Tailscale身份头、IP、Workspace路径、provider连接或自由文本错误。

**Phase 4/5遗留迁移**：`owningAgentId`已一次改名并收紧为不可变`ownerAgentId`；`kind/provider/connection/model/authorizedAgentIds`已从Account删除，`Agent 1:N Account`存量关系已收敛为严格1:1。迁移预检无法唯一确定owner时必须在写入前阻止启动并要求人工处理；不得复制Memory、静默拆Agent、长期双读双写或保留兼容别名。

### Workspace `[Phase 5.5]`

Workspace = Account 对应的执行环境与项目工作边界；`Account 1:1 Workspace`。Gateway、daemon和Workspace可分布在不同机器，但Phase 5.5当前可执行Workspace必须与owner Agent daemon同宿主。

```json
{
  "accountId": "acc_a1b2",
  "hostId": "host_local_mac",
  "path": "/Users/theta/projects/example",
  "status": "ready",
  "policy": {},
  "lastValidatedAt": "…",
  "updatedAt": "…"
}
```

- gateway 的 data 层只保存 Workspace 的 `accountId` 归属、宿主绑定、路径、校验状态与执行策略；实际项目文件保留在`hostId`宿主，不因gateway位于VPS就复制进gateway store。
- `hostId`标识能解释同一组本地绝对路径并直接执行Workspace的Vera宿主命名空间，不是Agent、Account、Space、Workspace或进程id。它跨daemon重启稳定；同机但文件系统互相隔离的容器使用不同`hostId`。
- `path` 是 `hostId` 上的机器本地路径，只有绑定到同一宿主的 daemon 可解释；不得把绝对路径当作跨设备可用地址。
- 一个规范化后的`(hostId,path)`最多绑定一个Account Workspace。其他Agent未来代表该Account时复用同一授权绑定，不得把同一物理项目目录再次登记成另一Account的Workspace；需要真正共享项目时必须另立显式共享授权模型，不能靠重复注册绕过权限和租约。
- Workspace不承载Space时间线、Message、SpaceSession、AgentSession或附件正文。它们继续由gateway按Space和会话事实来源管理；Workspace登录、注册、授权或迁移不得复制、重写或删除这些记录。
- Phase 5.5登录与Execution均要求`agentId === ownerAgentId`且Agent runtime报告的`hostId === workspace.hostId`；不匹配返回`workspace_unavailable`，不得降级到临时目录、复制项目或远程SSH。
- gateway内的`Vera Control Service`复用Account、Agent与Session事实来源，负责Workspace首次绑定、宿主准入及每次Execution授权；不得另建独立用户表、共享Workspace Key或可绕过Account Session的节点凭证。
- owner首次成功重新授权时，若Account尚无Workspace，Control Service可原子绑定本次报告的`hostId/path`；已有绑定必须精确匹配，普通重连不得改绑。路径或宿主迁移只能走未来显式rebind流程，不能借login静默完成。
- Workspace Node的第一方内部协议不依赖MCP。当前节点只接受`executingAgentId === ownerAgentId`且与Account Session、runtime revision、Workspace binding和Execution租约一致的请求；未来MCP入口只能适配同一授权结果。
- Workspace 重新绑定宿主或路径必须显式校验并更新绑定；不得静默生成同一 Account 的第二个 Workspace。
- `vera.workspace` MCP是后续跨宿主代上线的开发目标；当前不注册该MCP、不开放非owner登录，也不把未来工具名/Schema伪装成已实现接口。
- 本形状、首次绑定及Control Service授权已在Phase 5.5落地；Workspace Node独立进程与远程工具数据面尚未实现，因此不得据控制面完成宣称跨宿主执行已可用。

### Space

```json
{
  "id": "spc_a1b2",
  "name": "vera-dev",
  "topic": "Vera 0.0.1 开发",
  "notifications": {
    "mode": "accountMessages",
    "includeActivityErrors": true
  },
  "seats": [
    { "accountId": "acc_a1b2", "responseMode": "default" }
  ],
  "activeSpaceSessionId": "sps_a1b2",
  "archivedAt": null,
  "createdAt": "…"
}
```

- `seat.accountId`：在该Space中以哪个持久Account身份出席；实际执行Agent由该Account当前登录会话解析。
- `seats`必须至少包含一个有效Account，创建时缺失或为空均返回`400 invalid_request`；更新成员时不得移除最后一个seat。
- `seat.responseMode`是per-account per-Space：`default` / `silent` / `focused`。定向@到该Account一律响应，不受responseMode影响。
- `silent`的来源过滤字段`respondTo:["user","acc_..."]`挂在seat上。
- `seat.blockAccountIds:["acc_…"]`：名单中Account的气泡不进该Account当前实际Agent的群聊视角prompt段；定向@仍穿透。
- `notifications` `[P4.6；P5.5命名迁移]`：当前Space的提醒策略。`mode` 为 `all`（Account消息与Activity均提醒）/ `accountMessages`（只提醒Account消息，默认）/ `off`；`includeActivityErrors` 控制error Activity是否即使在 `accountMessages` 下也提醒。Phase 5.5把存量`agentMessages`一次迁为`accountMessages`并删除旧token，不保留双读别名。这里是gateway持久的Space策略；浏览器/系统通知权限仍由各客户端自己申请，二者不得混成一个开关。
- `activeSpaceSessionId`：该Space唯一可写SpaceSession。创建Space时必须在同一事务创建首个active SpaceSession；任何时刻不得为空或指向archived记录。
- `archivedAt` `[P4.6]`：`null` 表示活跃；ISO时间戳表示已归档。归档只把Space移出活跃导航并禁止新消息/新Run，Space自身、active/archived SpaceSession、时间线和provider bindings全部保留；恢复后继续使用原Space id及原active SpaceSession。只有已归档Space可永久删除；SpaceSession归档仍不可恢复或单独删除。
- Space Module绑定不直接塞任意脚本进Space记录。Phase 6先定义全局Extension Package与per-Space Module binding的独立集合/API，再由Space设置页读取；契约未补全前不得在 `seats` 或任意自由字段里偷放Module配置。

### SpaceSession 与 AgentSession `[P5-C1]`

```json
{
  "id": "sps_a1b2",
  "spaceId": "spc_a1b2",
  "status": "active",
  "createdAt": "…",
  "archivedAt": null,
  "archiveReason": null
}
```

- `Space 1:N SpaceSession`且每个Space恰有一个`active`；其余只能为`archived`。`archiveReason`当前只允许`new_command`。归档SpaceSession永久只读，不提供restore；`/new`是唯一创建下一SpaceSession的产品动作。
- Message、Run、Activity、Approval都必须带`spaceSessionId`；所有时间线、speaker-view、Digest范围和自动触发先按它隔离，禁止只靠时间戳猜窗口边界。用户Message写入时与当前`activeSpaceSessionId`原子绑定；Account发言从Run继承实际`agentId/accountId`及署名快照。

```json
{
  "id": "ags_a1b2",
  "spaceSessionId": "sps_a1b2",
  "accountId": "acc_a1b2",
  "agentId": "agt_x1y2",
  "status": "active",
  "generation": 1,
  "context": {
    "checkpointVersion": 0,
    "estimatedInputTokens": 3200,
    "effectiveLimitTokens": 16384,
    "pressureRatio": 0.195313,
    "measurement": "estimate"
  },
  "createdAt": "…",
  "updatedAt": "…"
}
```

- `SpaceSession 1:N AgentSession`，唯一键`(spaceSessionId,accountId,agentId)`。Account首次由owner Agent上线响应前建立；Phase 5.5的`agentId`必须等于`ownerAgentId`。三元键为未来非owner执行保留独立AgentSession空间，但不得继承另一Agent的history/binding/Recall sidecar。
- `generation`从1开始，只在该AgentSession成功compact或CLI provider binding明确missing/invalid并完成重建后递增。旧generation的checkpoint/provider binding/Recall sidecar只读冻结。
- `measurement`只允许`provider_reported/tokenizer/estimate`。默认容量水位warning/auto/hard为`0.70/0.80/0.95`，可按已验证provider/model profile覆盖且必须严格递增。完成Run后跨auto水位在安全点排队；下一Run前已达hard水位必须先compact，失败返回`context_capacity`且不得丢当前Message。
- Vera持有AgentSession、generation、checkpoint、容量与provider binding元数据真值。API Agent的规范history/checkpoint落gateway store；CLI thread/resume id只作为`(agentSessionId,generation,agentRuntimeFingerprint)`绑定。任何Account或执行身份变化都不得跨Agent复用binding。
- compact保留顺序固定为：稳定Agent身份/规则 → 上代checkpoint → 最近完整轮次 → 当前Message → 当前Recall。旧群聊声告和旧Recall投影不写入稳定history；成功后新generation首次Run重新注入常驻Memory索引并换代Recall sidecar。

**Phase 5.5迁移**：现有`(spaceSessionId,agentId)`AgentSession只有在旧seat与旧Account能唯一对应，且该Agent是Account owner时，才迁成`(spaceSessionId,accountId,agentId)`；无法唯一对应或owner不匹配的provider binding失效并从新generation开始。不得把一个Agent的旧thread交给另一Agent。

**Speaker view 编译层输出契约**：触发某Account owner Agent的Run时，gateway只在当前`spaceSessionId`内，从该`accountId + agentId`组合上次发言之后派生其他Account的署名声告段；`silent/focused/blockAccountIds`统一在此层过滤。prompt开头必须可信说明实际Agent身份与自己的Account；Phase 5.5不生成代上线或切换原因上下文，也不得注入另一Agent Memory。

**prompt.text 物理拼装顺序**：`[常驻索引块]?\n\n[群聊声告段]?\n\n[触发消息正文]\n\n[本轮Memory检索块]?`。常驻索引只在当前AgentSession generation首次Run注入；群聊声告与Recall都是本轮volatile段，不写入API稳定history。群聊声告格式和现有条数/字符配置保持不变，但查询边界必须是当前`spaceSessionId`。

编译层返回`text/turnText/historyUserText/residentBlock/retrievalBlock`及gateway已经裁剪好的`apiMessages`。每个API main Run成功时以一个CAS原子追加完整turn：`input`只取当前trigger Message并保留author/target/sourceMessageId署名信封，`assistant`引用本Run已完成reply Message并可带provider确需的安全tool transcript/usage。即使trigger来自另一个Agent，也必须保存这一个最小输入信封与assistant成对，不能产生孤立assistant轮次。累计群聊声告、Activity、隐藏思维、常驻索引和Recall投影不进稳定turn。CLI adapter继续只消费`text`。旧`historyEnvelopeText`字段在P5-C1迁移后删除，不保留双写兼容。

### Message

```json
{
  "id": "msg_m1n2",
  "spaceId": "spc_a1b2",
  "spaceSessionId": "sps_a1b2",
  "author": { "type": "user" },
  "target": { "type": "broadcast" },
  "content": "大家看一下这个报错",
  "fileIds": ["fil_f1e2"],
  "runId": null,
  "status": "completed",
  "createdAt": "…"
}
```

- `author`：用户为`{"type":"user"}`；Account消息为
  `{"type":"account","accountId":"acc_…","accountNameSnapshot":"GLM","executingAgentId":"agt_glm","effectiveModel":"gpt-5.6-sol","delegated":false}`。
- `delegated`是未来兼容字段；Phase 5.5当前所有Message固定为`false`，且`executingAgentId`必须等于`account.ownerAgentId`。未来开放代上线后才按二者是否相等计算；当前前端不得制造true夹具冒充运行能力。
- `target`：`{"type":"broadcast"}`或`{"type":"direct","accountIds":["acc_…"]}`。
- `accountNameSnapshot/executingAgentId/effectiveModel/delegated`都持久化，防止以后改名、切换代上线状态或换模型导致历史漂移；普通Space UI不额外展示实际Agent名，审计页可读取。
- `fileIds` `[P5-F1]`：可选、默认`[]`，最多`config.files.maxAttachmentsPerMessage`项，必须去重。Message提交时gateway按当前目标Space与`isolation.files`重新校验每个File可读且未删除；非法、重复或不可读File id返回400/403/404，整条Message不落地。`content`与`fileIds`至少一项非空，因此允许纯附件Message。
- 时间线、`message.created`与`message.completed`在Message安全投影旁派生`attachments:[{fileId,name,mime,sizeBytes,state:"available"|"deleted"|"unavailable"}]`；该字段不持久化，不包含物理存储名、hash或绝对路径。共享撤销、删除或owner Space永久删除后，历史Message仍保留`fileIds`，投影状态随当前事实变化。
- `runId`：Account消息关联其产生Run；用户消息为null。

### File `[P5-F1]`

```json
{
  "id": "fil_f1e2",
  "ownerSpaceId": "spc_a1b2",
  "name": "error-log.txt",
  "mime": "text/plain",
  "sizeBytes": 1280,
  "sha256": "sha256:…",
  "sharedSpaceIds": ["spc_b2c3"],
  "version": 1,
  "createdAt": "…",
  "updatedAt": "…",
  "deletedAt": null
}
```

- `ownerSpaceId`创建后不可修改；`sharedSpaceIds`只保存现存且不等于owner的明确Space id，去重并按id稳定排序。读取是否允许由当前`isolation.files`结合这两个字段计算，不把全局策略复制进File记录。
- 对owner HTTP返回的File可带`canManage:true`；共享/全局可读投影带`canManage:false`。公开响应不得含物理`storageName`、临时文件名、附件根路径或宿主真实路径。
- `sha256`只用于gateway完整性与迁移验证；列表可省略，详情仍可返回该摘要。删除把`deletedAt`置为时间戳、version加1并删除二进制；墓碑不出普通列表，历史Message附件投影仍可使用其`name/mime/sizeBytes`。
- 同名或同hash不会覆盖或合并，每次成功上传都创建新id。展示名必须是单个文件名，拒绝`/`、`\`、NUL、`.`、`..`与路径穿越编码。
- 首版扩展/MIME白名单：`.txt text/plain`、`.md text/markdown|text/plain`、`.json application/json`、`.csv text/csv|text/plain`、`.pdf application/pdf`、`.png image/png`、`.jpg|.jpeg image/jpeg`、`.gif image/gif`、`.webp image/webp`、`.zip application/zip`、`.docx application/vnd.openxmlformats-officedocument.wordprocessingml.document`、`.xlsx application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`、`.pptx application/vnd.openxmlformats-officedocument.presentationml.presentation`。空MIME或`application/octet-stream`可按扩展名归一；其他冲突返回415，当前阶段不做病毒扫描或内容智能识别。

**多气泡规则（产品需求，契约级）**：一次 run 的回复**不是一条巨长消息，而是一串短消息**。gateway 在流式输出中按段落边界切分：当前气泡以 `status: "streaming"` 创建、随 delta 增长，检测到切分点即定稿（`completed`）并开下一个气泡。一个 run 产生 N 条 Message 记录，每条是独立气泡，历史记录里也保持切分后的形态。切分策略（边界规则、最小/最大长度）是 gateway 配置项，不硬编码；无段落边界的超长文本按就近空格软切；前端只负责渲染，不做切分。若 adapter 未产生任何 delta 只返回全文，gateway 以全文兜底切气泡（见 adapter-interface「run() 返回」）。

### Run

一次 agent 响应的执行记录。

```json
{
  "id": "run_r1s2",
  "agentId": "agt_x1y2",
  "accountId": "acc_a1b2",
  "runtimeRevision": "sha256:…",
  "executionTransport": "daemon",
  "accountSessionId": "acs_a1b2",
  "executionLeaseId": "exl_c3d4",
  "workspaceHostId": "host_large_vps",
  "leaseAcquiredAt": "…",
  "effectiveModel": "gpt-5.6-sol",
  "delegated": false,
  "parentRunId": null,
  "role": "main",
  "spaceId": "spc_a1b2",
  "spaceSessionId": "sps_a1b2",
  "agentSessionId": "ags_a1b2",
  "contextGeneration": 1,
  "triggerMessageId": "msg_m1n2",
  "replyMessageIds": ["msg_p3q4", "msg_p3q5"],
  "status": "running",
  "createdAt": "…",
  "endedAt": null
}
```

`status`：`pending` / `running` / `completed` / `failed` / `cancelled`。`pending`表示Run已创建但尚未取得Account租约或目标AgentSession正在compact，不得执行、发delta或修改context/provider binding；取得租约且generation仍匹配后原子转`running`并广播`run.started`。`failed`时Run带`error: { code, message }`字段（挂在Run对象上，其余状态无此字段）。

Account Key轮换/撤销、显式logout或安全撤销导致当前Account Session失效时，gateway把该Account全部`pending/running` Run终态化为`failed`，固定`error:{code:"account_session_revoked",message:"Account Session was revoked"}`并释放租约；关联的streaming Message转`failed`，`toolStatus`为`pending/running`的Activity转为`phase:"error",toolStatus:"failed"`，pending Approval转`expired/deny`。随后按对象发布`message.completed`、`activity.updated`、`approval.answered`、`run.ended`与`account.presence.updated`终态事件。该code只用于持久Run安全错误，不作为daemon可自由上报的provider错误；重试必须重新建立Account Session并创建新Run，旧Run不得被新Session认领。

- `executionTransport`只允许`gateway-local/daemon`。Phase 5现有进程内adapter创建的Run固定为`gateway-local`，其`accountSessionId/executionLeaseId/workspaceHostId/leaseAcquiredAt`均为`null`；这是迁移兼容标记，不等于daemon授权。联邦调度创建的Run固定为`daemon`并在pending时写当前非秘密`accountSessionId`，取得租约后才写`executionLeaseId/workspaceHostId/leaseAcquiredAt`并转running。
- `executionLeaseId`是非秘密审计id，不能替代Agent Token + Account Session Token。authorize必须同时匹配Run冻结的`accountSessionId`、`agentId/accountId/runtimeRevision`与Workspace host；旧Session Run不能被新Session认领。同一Account可有多个pending Run排队，但只能有一个带有效租约的running Run。

gateway启动时不得resume上一进程遗留的`pending/running` Run；它们统一终态化为`failed/internal`，关联的streaming Message、pending Activity与Approval也同步安全终态化。SSE按跨重启缺口触发bootstrap重取，不补发伪造的旧进程流事件。这样遗留Run不会永久占住Account或阻塞`/new`。

- `accountId`是本次Execution代表的Space/项目身份，`agentId`是实际执行者；二者必须匹配当前有效Account登录会话。主Run从seat的`accountId`解析当前`activeAgentId`，不存在则离线跳过。
- `runtimeRevision/effectiveModel`来自owner Agent runtime且创建Run时冻结；`effectiveModel`必须是非空的实际可展示模型名，不能是`default`、Account名或provider名。daemon提交结果时仍须匹配该revision。Phase 5.5当前`agentId === account.ownerAgentId`且`delegated:false`。
- `role:"main"`必须带当前active `spaceSessionId/agentSessionId/contextGeneration`。`role:"subagent"`仍继承审计用`spaceId/spaceSessionId`，但`agentSessionId/contextGeneration`必须为`null`；它只消费父Run显式传入的isolated task/context，使用全新临时provider上下文，终态后不保存API history、CLI provider binding、Recall sidecar或checkpoint。
- main Run的session字段在进入provider执行时冻结。唯一例外是CLI provider在尚未产出任何reply Message前明确确认当前binding `missing/invalid`：gateway可为同一Run原子生成checkpoint、令generation+1、更新该Run的`contextGeneration`并重新编译一次prompt；普通provider/network错误、已有reply或API Run均不得中途换代。
- Memory读取与写入目标始终由`agentId`决定；Account切换不得生成、复制或改挂Memory。Workspace与项目执行权限由`accountId`决定；Space时间线与附件由`spaceId`决定，Account通过Seat参与；provider/model/runtime由实际Agent决定。
- Run 是当前 API 中 Execution 的持久记录，`role` 取 `main` / `subagent`。父 Run 与 subagent Run 上下文隔离；父方只显式传递任务包和必要材料，subagent 完成后返回结果，不继承父Run的AgentSession/provider history，也不自动取得其他Account Workspace。

同一Account上的活跃Run串行执行。owner重复登录不得接管或取消旧在飞Run；会话/租约释放前返回`account_busy`。非owner不创建Run。

### Activity（时间线成员）

思考链、工具执行记录等过程信息。**不是独立面板，是 Space 时间线的正式成员**：与消息气泡按时间穿插排列，历史记录里同样保留。

```json
{
  "id": "act_t1u2",
  "spaceId": "spc_a1b2",
  "spaceSessionId": "sps_a1b2",
  "runId": "run_r1s2",
  "accountId": "acc_a1b2",
  "agentId": "agt_x1y2",
  "phase": "tool",
  "label": "bash",
  "detail": "npm test\n…(输出截断)",
  "toolStatus": "completed",
  "createdAt": "…",
  "updatedAt": "…"
}
```

- `phase`：`thinking`（思考链）/ `tool`（工具执行）/ `working` / `usage` / `error`。
- 工具类 activity 是**同一条记录原地更新**（pending → running → completed/error），不是每个状态一条。
- `detail` 截断长度、activity 历史保留策略均为配置项。

### Approval（时间线成员）

agent 的提权申请（执行危险操作前要用户点头）。也进时间线，渲染为带按钮的卡片。

```json
{
  "id": "apr_v1w2",
  "spaceId": "spc_a1b2",
  "spaceSessionId": "sps_a1b2",
  "runId": "run_r1s2",
  "accountId": "acc_a1b2",
  "agentId": "agt_x1y2",
  "prompt": "要执行 rm -rf ./dist，允许吗？",
  "options": ["allow", "deny"],
  "status": "pending",
  "answer": null,
  "createdAt": "…"
}
```

`status`：`pending` / `answered` / `expired`（run 结束仍未答复即过期）。

**交互原则**：Approval 是唯一允许的结构化阻塞提问。**选项式提问（AskUserQuestion 类）一律禁用**——adapter 以无交互模式运行 CLI；agent 有问题就正常发消息用文字问，用户用文字答。

### AgentState（per-Space 活动层，ground truth 3.3 + 2026-07-04 联邦精化）

```json
{
  "agentId": "agt_x1y2",
  "accountId": "acc_a1b2",
  "spaceId": "spc_a1b2",
  "status": "coding",
  "detail": "正在 review PR #42",
  "lastActiveAt": "…"
}
```

- 状态键为`agentId + accountId + spaceId`；Phase 5.5要求该pair满足`agentId === account.ownerAgentId`。Account维度保留未来授权扩展，但当前同一Agent不得登录其他Account。Space时间线按Account展示状态，Agent详情按实际Agent聚合。
- `status` 枚举（agent daemon 自己向 gateway 声明，gateway 不猜）：
  - `idle`：默认/未指派
  - `thinking`：LLM 流式回复中
  - `typing`：tool use 之后再回 final 输出
  - `reading`：工具在读
  - `coding`：工具在 write/git
  - `reviewing`：review PR/issue
  - `on_task`：多步骤跑一个整体活儿
  - `away`：daemon 在线但闲置超 N 分钟未活动
- `detail`：一行人类可读，daemon 自己写。
- AgentState是运行时派生状态，不持久化；与Account presence正交：presence说明哪个Agent当前代表Account在线，AgentState说明该pair在某Space内的工作相。

## 三、HTTP Endpoints

### 系统

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/health` | `{ "app": "vera", "ok": true }` |
| GET | `/api/bootstrap` | 一次拉齐聊天主页所需摘要：accounts + agents安全摘要 + spaces + agentStates + 当前SSE `seq`；联系人栏由Account与Space seats派生 |
| GET | `/`（及其他非 `/api/` 路径） | 静态前端：当前Phase 2–4.5回退伺服`frontend/`源码目录；F2引入Vite后production改为伺服`frontend/dist/`并对hash资源长期缓存、HTML用ETag/协商缓存。开发预览由Vite提供且保持`no-store`。两种模式都需SPA hash路由回退与路径穿越防护，不得让CDN缓存旧HTML指向失效bundle |

### Agent

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/agents` | 列表 |
| PATCH | `/api/agents/:id` | User更新Agent展示名；provider/model/runtime由daemon登记，不由普通表单自由改写 |
| DELETE | `/api/agents/:id` | 仅无活跃Account会话、无历史/Memory且其owner Account已按Account删除流程处理时允许；不连带删除其他Account、Space或Workspace |

### Account

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/accounts` | 列表；可按`ownerAgentId`或`activeAgentId`过滤，但Account始终是第一层对象 |
| POST | `/api/accounts` | User创建Account。body严格为`{name}`；响应`{account,accessKey}`，其中明文`accessKey`仅此次返回。首次owner登记前`ownerAgentId/activeAgentId`均为null |
| GET | `/api/accounts/:id` | 严格返回`{account,ownerAgent,activeAgent,recentLogins}`。`account.workspace`只允许`null`或`{accountId,hostId,status,lastValidatedAt?,updatedAt?}`；`ownerAgent/activeAgent`为既有Agent安全摘要或`null`；`recentLogins`为本节冻结的最近20条登录审计。不返回Workspace path/policy、Key/hash、Token/fingerprint、boot id、原始身份头、Agent Memory或provider secret |
| PATCH | `/api/accounts/:id` | 只更新`name`；`ownerAgentId`建立后不可由普通API改绑 |
| POST | `/api/accounts/:id/access-key/rotate` | User轮换Account Key并返回一次性明文；`accessKeyVersion`递增，旧Key及全部Account Session Token立即失效，在飞Execution按撤销流程终态化。daemon下次上线必须用新Key重新授权 |
| DELETE | `/api/accounts/:id/access-key` | User撤销Account Key且不生成新Key；`accessKeyVersion`递增，全部Account Session立即撤销、在飞Execution按撤销流程终态化，Account离线。之后只有显式rotate生成新Key才能再次enroll/login |
| DELETE | `/api/accounts/:id` | 仅无活跃会话/Execution且已按Space删除预检解除Seat/项目引用时允许；不得删除任何Agent Memory |

Vera全局Settings中的`#/settings/accounts`以Account为首层：新建Account、显示所属/当前Agent、生成/轮换Key、Workspace和登录审计。不得出现“新建Agent后自动派生Account”“更换owner”“代上线”或“添加第二条连接”动作。Agent使用管理仍是独立的`#/agents/:agentId`。

### Space

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/spaces` | 默认只列活跃Space；`?archived=true`只列已归档，`?archived=all`列全部。`/api/bootstrap`只返回活跃Space |
| POST | `/api/spaces` | 创建Space；body必须包含至少一个Account seat，并在同一事务创建首个active SpaceSession。AgentSession在该Account首次由实际Agent响应时建立 |
| PATCH | `/api/spaces/:id` | 更新 name/topic/seats/notifications（席位增删、responseMode/提醒策略调整；seats不得为空） |
| POST | `/api/spaces/:id/archive` `[P4.6]` | 归档Space。存在未结束Run或compaction时返回409；成功写入`archivedAt`，不删除或级联清理任何SpaceSession/provider binding。重复归档幂等返回当前Space |
| POST | `/api/spaces/:id/restore` `[P4.6]` | 恢复已归档Space：把`archivedAt`置回`null`并继续原active SpaceSession。重复恢复幂等返回当前Space |
| GET | `/api/spaces/:id/deletion-preview` | 仅已归档Space；返回`{preview:{spaceId,messageCount,affectedMemoryCount,exclusiveMemoryCount}}`。`affectedMemoryCount`为至少一个Message来源属于该Space的Memory，`exclusiveMemoryCount`为全部sources均为该Space Message的Memory |
| DELETE | `/api/spaces/:id` | 仅已归档Space；body严格为`{deleteExclusiveMemories:boolean}`。先按预检版本更新Memory：所有保留Memory把该Space的Message SourceRef改为`deleted-message`墓碑；选项为true时额外删除exclusive Memory。Memory全部提交成功后，删除Space及其Message/Activity/Run/Approval/SpaceSession/AgentSession/provider binding/API history/context control与compaction记录；已成功且仍承载Memory事实身份的Digest receipt作为无原文审计保留。返回`200 {deleted:{spaceId,messageCount,affectedMemoryCount,deletedMemoryCount}}`并发布`space.deleted`。active Memory job仍引用该Space或Memory版本冲突时返回409且Space保持已归档 |
| GET | `/api/spaces/:id/timeline?before=<itemId>&limit=50` | 只返回active SpaceSession时间线。返回`{spaceSession,items:[...],runs:[...]}`；`runs`只含与本页item关联的持久Run安全投影，归档窗口不得由该端点隐式混入 |
| POST | `/api/spaces/:id/messages` | 发消息（见下）；已归档Space返回409 `conflict`，必须先恢复 |
| GET | `/api/spaces/:id/sessions?status=active|archived|all` `[P5-C1]` | 默认列archived SpaceSession摘要，按createdAt倒序；`active/all`显式选择。返回`{sessions}`，不含时间线正文 |
| GET | `/api/spaces/:id/sessions/:spaceSessionId/timeline?before=&limit=50` `[P5-C1]` | 只读返回指定SpaceSession时间线及与本页item关联的持久Run状态；归档窗口同样可读，但该路由没有写、restore或新Run能力 |
| POST | `/api/spaces/:id/session/_new` `[P5-C1]` | body严格为`{requestId}`。当前有pending/running Run或compaction则409 `session_busy`；否则单事务归档当前SpaceSession/AgentSessions并创建新active窗口。`(spaceId,requestId)`幂等，返回`{archivedSession,newSession}` |
| POST | `/api/spaces/:id/session/_compact` `[P5-C1]` | body严格为`{requestId}`；每个Account seat按其当前`accountId + ownerAgentId`独立compact并取得Account租约。不同AgentSession不得混压或共享binding；Phase 5.5不接受非owner target |
| GET | `/api/spaces/:id/session/_compact/jobs/:jobId` `[P5-C1]` | 返回`{job:{id,spaceId,spaceSessionId,status,targets:[{agentId,agentSessionId,fromGeneration,toGeneration?,status,error?}],createdAt,finishedAt?}}`；job与target status都只允许`queued/running/succeeded/failed/cancelled`，job按targets派生；不返回checkpoint、history或provider binding |

### Files `[P5-F1]`

所有读取路径都把`:id`解释为“请求读取的Space”，不是File owner。gateway先确认Space存在，再按当前`isolation.files`判定目标File是否对该Space可读；只有`ownerSpaceId === :id`可更新共享范围或删除。

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/spaces/:id/files` | 返回该Space当前可读且未删除的`{files:[File safe summary],policy}`，按`createdAt desc,id asc`。`policy`为当前`isolation.files`；共享/全局读到的条目标`canManage:false`与owner Space安全摘要 |
| POST | `/api/spaces/:id/files` | 上传到该owner Space；已归档Space返回409。请求体是原始二进制，`Content-Type`为客户端声明MIME，`X-Vera-File-Name`为`encodeURIComponent(displayName)`后的ASCII值，`Content-Length`可选。gateway流式写唯一临时文件并同时计数/hash；超过`config.files.maxUploadBytes`立即终止并清理。完整写入、白名单校验、flush与原子rename成功后才插入File元数据，返回201`{file}`并发布`file.created` |
| GET | `/api/spaces/:id/files/:fileId` | 返回`{file}`详情。不可读按404处理，避免把其他Space私有File的存在变成探针；墓碑同样404 |
| GET | `/api/spaces/:id/files/:fileId/download` | 流式返回二进制；响应`Content-Type`取权威MIME，`Content-Length`取权威大小，`Content-Disposition: attachment; filename*=UTF-8''<encoded>`。打开前必须拒绝符号链接、缺失文件、大小/hash不符；不支持Range的首版不得伪造206 |
| PATCH | `/api/spaces/:id/files/:fileId` | 仅owner Space；body严格为`{sharedSpaceIds,ifMatch}`，`ifMatch`为整数version。共享id必须全部是现存Space且不含owner；成功返回`{file}`并发布`file.updated`。版本冲突409，`details.current.file`返回当前安全版本 |
| DELETE | `/api/spaces/:id/files/:fileId?ifMatch=<version>` | 仅owner Space；二次确认由前端负责。成功删除二进制、保留墓碑元数据并返回204，发布`file.deleted {spaceId,fileId}`。不存在/已删除404，版本不符409 |

上传中断、socket错误、大小超限、MIME冲突、flush/rename失败均不得创建File记录；启动时只可清理Files根内gateway命名的过期临时文件，不得删除未知用户文件。附件根布局只使用gateway生成的owner Space目录与storage name，任何显示名都不参与路径拼接。File详情与下载都要在打开后对`lstat`/size/hash做完整性校验，符号链接或替换文件返回422 `invalid_file`。

**发消息**（用户或 agent 均走此接口；agent 发消息 `[P4]`）：

```json
// 请求
{ "author": { "type": "user" }, "target": { "type": "broadcast" }, "content": "…", "fileIds": ["fil_…"] }
// 响应 201
{ "message": { …Message… }, "runs": [ { …Run… } ] }
```

gateway 依据每个 seat 的 responseMode 决定哪些 agent 产生 run，同步返回创建的 runs；后续进展全部走 SSE。

精确去除首尾空白后的`/new`与`/compact`由前端映射到上述控制端点，不调用Message端点；gateway控制端点同样是唯一权威。若客户端仍把这两个精确字符串提交到`POST .../messages`，gateway返回400 `control_command_required`，不得把它保存成普通Message或同时执行控制动作。其他包含斜杠的正文仍是普通Message。

聊天前端不提供独立的发送对象选择器。提交时按当前Space seats中的Account名称解析`@Account名`：命中id写入`target:{type:"direct",accountIds:[...]}`，未命中则broadcast；同名Account全部命中。

### Run

| Method | Path | 说明 |
|---|---|---|
| POST | `/api/runs/:id/cancel` | 取消在飞 run。幂等：已结束返回当前状态 |

### Approval

| Method | Path | 说明 |
|---|---|---|
| POST | `/api/approvals/:id/answer` | body `{ "answer": "allow" }`。幂等；非 pending 返回 409 `conflict` |

### AgentState

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/agent-states` | 全部 per-Agent + Account + Space AgentState 列表；可带 `?spaceId=<spc_…>` / `?accountId=<acc_…>` / `?agentId=<agt_…>` 过滤 |

### Agent daemon 联邦接入 `[Phase 5.5]`

> 这是联邦形态（ground truth 2.4）的 agent daemon ↔ gateway 通道。所有路径以 `/api/agent/` 为前缀，只从 Tailscale Serve 私网入口开放；tailnet ACL 提供网络门禁，Vera agent token（`Authorization: Bearer <token>`）提供 agent 身份。用户视角仍走原 `/api/agents/*` / `/api/spaces/*`，不混用。

`enroll/login/logout/events`重连、心跳、Workspace register/authorize均为控制面操作，不得调用adapter/provider/model，也不产生模型token使用。Agent Token与AccountSession Token中的“Token”只表示认证随机串，不是模型计费token。

| Method | Path | 说明 |
|---|---|---|
| POST | `/api/agent/enroll` | Account首次owner登记。`Authorization: Bearer <account-access-key>`，body`{accountId,agent:{name},runtimeProfile}`；仅当`ownerAgentId:null`时创建唯一owner Agent、原子写入`ownerAgentId`并一次性返回agent token。已绑定Account返回409；既有Agent不能通过本端点认领第二个Account |
| POST | `/api/agent/login` | body`{accountId,daemonBootId,runtime,workspace,memoryProvider?}`。建立/重新授权模式发送`Authorization: Bearer <agent-token>`与`X-Vera-Account-Key`；成功返回一次`accountSession:{id,token,gatewayBootId}`，普通续连返回同一`id/gatewayBootId`但不再返回token。同一daemon进程普通重连改发`Authorization`与`X-Vera-Account-Session`，不得同时发送Key；gateway校验两端boot、Agent Token fingerprint与Key version后复用Session。仅当`agentId === ownerAgentId`、runtime host与Workspace host匹配且Provider placement可用时上线；非owner返回403 `delegation_unavailable`，Session失效返回401 `account_reauthentication_required`，宿主不匹配返回409 `workspace_unavailable`。不接受`takeover/reason` |
| POST | `/api/agent/workspace/register` | Control Service内部节点准入。发送Agent Token + Account Session，body严格为`{accountId,daemonBootId,runtimeRevision,workspace:{hostId,path,status,policy}}`；只允许owner、同Session和同runtime宿主。首次绑定可落盘，已有绑定仅做匹配与状态刷新，不允许普通请求改绑 |
| POST | `/api/agent/workspace/authorize` | 为已创建的owner daemon Execution原子取得租约。发送Agent Token + Account Session，body严格为`{accountId,runId,workspaceHostId,runtimeRevision}`；Run必须为`executionTransport:"daemon"`、pending且已冻结同一`accountSessionId`。成功写`executionLeaseId/workspaceHostId/leaseAcquiredAt`并转running，幂等重试返回同一安全摘要`{execution:{runId,accountId,agentId,accountSessionId,executionLeaseId,workspaceHostId,runtimeRevision}}`；不返回Workspace绝对路径、Key、token、token hash或secret。其他Session、`gateway-local` Run及同Account第二个running租约均拒绝 |
| DELETE | `/api/agent/sessions/:accountId` | 要求Agent Token + Account Session Token。当前Agent退出自己的Account；gateway释放租约、把Account置offline并销毁Session Token，保留AgentSession历史、Workspace与所属Agent。再次上线必须用Account Key重新授权 |
| GET | `/api/agent/events` | 要求Agent Token + Account Session Token。daemon单一SSE长连接收 *(1)* `agent.heartbeat`，*(2)* 分型`run.requested`：CLI只含`input:{kind:"cli",promptText,providerBinding?}`，API只含`input:{kind:"api",messages,historyVersion}`，subagent的input另标`sessionMode:"isolated"`且无持久binding/history，*(3)* CLI/API compact所需的`agent-session.compact.requested`，*(4)* 配置变更。普通断线以同一Session Token重连，不要求Account Key；不得同时发送两种input或在API payload夹带`promptText/providerBinding` |
| POST | `/api/agent/runs/:id/subagents` | 当前Run请求派生isolated Execution，只能沿用父Run冻结的`agentId + accountId`；不得跨Account派生或借用另一Account Key |
| PATCH | `/api/agent/runs/:id` | 在飞run的状态/属性更新；body可带`status/error/agentState`。daemon不得自行提交pending→running，该转换只属gateway调度器。API main Run未先成功提交`api-result`时，`completed`返回409 `history_conflict`；CLI main与isolated subagent无此门槛 |
| POST | `/api/agent/runs/:id/messages` | 实际Agent代表Account提交发言气泡。body 为 Message 形状去掉 `id/runId/createdAt/status/author`；gateway从Run冻结`accountId/accountNameSnapshot/agentId/effectiveModel/delegated`生成author。每条气泡各发一次，落地进 Space 时间线 + 走 SSE `message.created` |
| POST | `/api/agent/runs/:id/delta` | 当前气泡的流式增量。gateway 转 `message.delta` SSE 事件给前端 |
| POST | `/api/agent/runs/:id/activities` | 创建/更新 activity（带 `callId` 合并同一条），落地 + `activity.created`/`activity.updated` SSE |
| POST | `/api/agent/runs/:id/approvals` | 提权申请，gateway 转 `approval.requested` 给前端 |
| PUT | `/api/agent/provider-bindings/:agentSessionId` `[P5-C1]` | 仅同步CLI外部会话绑定。body严格为`{generation,accountId,agentId,runtimeRevision,providerState,ifVersion}`；`providerState`只允许该Agent runtime revision对应adapter已声明的thread/resume id安全形状，不得含API history、secret、路径或Memory。gateway校验agent token、当前Execution租约及AgentSession/generation/account/agent/runtime匹配并以CAS保存；旧generation、runtime或version返回409。API Agent不调用此端点 |
| PUT | `/api/agent/runs/:id/api-result` `[P5-C1]` | 仅API main Run在终态前调用。body严格为`{agentSessionId,generation,baseHistoryVersion,assistantMessageIds,toolTranscript?,usage?}`；gateway要求ids逐一属于该Run且已completed，用当前trigger Message构造最小署名input信封，与assistant/tool结果作为一个完整turn以CAS追加。toolTranscript只允许adapter profile声明的安全`{callId,name,arguments,result,status}`数组，不含隐藏思维、secret、路径或provider原文。成功返回`{historyVersion}`；版本/generation不符返回409 `history_conflict`并原子保持history不变。未成功提交该结果的API main Run不得标completed，冲突后必须failed且不重调provider。CLI与subagent不得调用 |
| PUT | `/api/agent/compactions/:jobId/targets/:agentId` `[P5-C1]` | daemon回报一个compact target。body严格为`{agentSessionId,fromGeneration,status:"succeeded"|"failed"|"cancelled",checkpoint?,providerBinding?,error?}`并匹配gateway已下发request。`native`成功必须返回同一CLI thread压缩后的安全providerBinding；`checkpoint_new_binding`或`gateway_history`成功必须返回checkpoint且不得返回binding，新generation首次Run再建CLI binding或由gateway构造API history。gateway CAS提交`generation+1`、冻结旧sidecar/binding并更新job；旧generation/重复不同结果409，完全相同重试幂等。compact输出不创建Message/Activity/Digest/Dream |

除`enroll`、`login`重新授权模式及不绑定Account的Memory MCP/Memory task通道外，所有携带或操作`accountId/runId/agentSessionId`的`/api/agent/*`请求都必须同时验证Agent Token与`X-Vera-Account-Session`，并匹配当前内存Session记录；只验证Agent Token不足以取得Account数据或Execution控制权。Session Token只允许在Key模式login成功响应中返回一次，此后仅放请求header；不得进入query、请求body、SSE data、日志或持久化错误详情。

### Owner Tailscale 身份 `[Phase 5.5]`

普通客户端不使用Vera自建配对码或device session。这里不包含daemon ↔ gateway之间的进程内Account Session Token；后者只授权Agent访问自己的Account，不代表owner客户端设备。Tailscale Serve必须覆盖/清除客户端伪造的身份头后，把已认证的Tailscale login转给回环gateway；gateway只在请求来源为本机Serve代理时信任该身份，并要求login精确命中`config.security.ownerTailscaleLogins`。未命中返回403；生产配置列表为空时除最小health外全部普通业务API拒绝服务并记录配置错误。

设备加入、过期与撤销由 tailnet 管理；Vera 不复制一套设备目录。`/api/agent/*` 不把 owner login 当成 agent 身份，仍必须验证 per-agent Bearer token。开发期直接访问 `127.0.0.1:3210` 的测试豁免只能由显式 development 配置开启，生产默认关闭。

**离线 @ 行为**：`POST /api/spaces/:id/messages`处理时按seat `accountId`查当前`activeAgentId`；Account离线时不创建Run，并在时间线写error Activity：

```json
{
  "itemType": "activity",
  "id": "act_…",
  "spaceId": "spc_…",
  "runId": null,
  "accountId": "acc_离线账号",
  "agentId": null,
  "phase": "error",
  "label": "agent-offline",
  "detail": "X Account当前离线，已跳过此条",
  "createdAt": "…"
}
```

前端渲染成一行普通 error 提示（无 `runId` 关联，无引爆 card）。下次该 agent 上线不补发这条触发消息（无副作用历史）。

### 配置 `[P4]`

- `GET /api/settings` → 200 `{ settings: <object> }`：返回合并视图（overrides 叠 config 启动默认）。字段清单严格按 ground truth 4.1 / 4.3；运维参数（端口、数据路径、SSE 心跳/缓冲、store 落盘、daemon 回收、run 看门狗）走 env 不进，前端可读可写。
- `PATCH /api/settings` body `{ settings: <patch> }`：部分字段覆盖，成功 → 200 `{ settings: <object> }`（合并后视图）。未知 key 或值类型不合（enum 非 valid member / number 非 finite number / string 非 string）→ 400 `invalid_request`；body 形状非 `{ settings: <object> }` → 400。
- `[P4.6]` 对已知 key 传 `null` 表示删除该 override、恢复 config 默认值；响应仍返回恢复后的合并视图。`null` 不能创建未知 key。设置页“按组恢复默认”即对该组已知 key 一次 PATCH `null`，不另造 reset API。

**系统字段清单**（ground truth 4.1，严格遵守不扩）：

| key | 类型 | 默认值（config 派生） |
|---|---|---|
| `isolation.memory` | enum: `isolated` | `isolated`；Phase 5 起长期 Memory 固定 per-Agent、跨 Space，旧 `globalReadable` / `perSpace` 值不再是合法写入值 |
| `isolation.files` | enum: `isolated` / `specifiedShared` / `globalReadable` | `isolated` |
| `isolation.agentState` | enum: `isolated` / `globalVisible` | `globalVisible` |
| `memory.injectionBudgetResidentLines` | number | `config.memory.residentIndexMaxLines`（默认 25） |
| `memory.injectionBudgetRetrievalTokens` | integer `0..4096` | `384`；`0`只关闭自动消息尾部注入，不关闭Agent主动MCP拉取 |
| `presentation.bubbleBoundaryPattern` | string（正则源） | `config.bubbles.boundaryPattern` |
| `presentation.bubbleMinLength` | number | `config.bubbles.minLength` |
| `presentation.bubbleMaxLength` | number | `config.bubbles.maxLength` |

旧`memory.digestTrigger`、`memory.digestSchedule`与`memory.digestRealtimeThresholdChars`只作为M4一次性迁移输入，不属于当前`GET/PATCH /api/settings`白名单。gateway为每个迁移前现存Agent生成`memory/_config`中的Digest配置；旧`schedule`没有时区，固定使用运行配置`memory.scheduleTimezone`（env `VERA_MEMORY_SCHEDULE_TIMEZONE`，默认`UTC`），不得猜宿主本地时区。迁移记录版本`memory-config-v1`，先把原settings与待写per-Agent配置保存为store migration marker并flush，再逐Agent幂等写入，最后删除settings旧键并完成marker，崩溃重启按marker继续。迁移完成后新Agent使用per-Agent默认：Digest `manual`、Dream `manual`，不再继承历史全局模板；不得保留“全局默认 + per-Agent override”的双读优先级或第二个可写UI入口。两项injection budget仍是gateway全局预算。

**Appearance字段 `[P4.6]`**（ground truth 4.3；默认值统一由 `config.appearance` 派生，代码不得另写第二份）：

| key | 类型 | CSS变量消费者 |
|---|---|---|
| `appearance.theme` | enum: `system` / `light` / `dark` / `custom` | 根节点 `data-theme` + token组 |
| `appearance.themeId` | string或`null`；`theme: custom`时指向已保存Theme | token loader加载Theme Palette |
| `appearance.themeColor` | string（合法CSS color） | `--vera-color-theme` |
| `appearance.accentColor` | string（合法CSS color） | `--vera-color-accent` |
| `appearance.fontFamily` | string | `--vera-font-family`（全局） |
| `appearance.fontSize.phone.chat` / `.management` | number（px，正数） | `--vera-font-size-phone-chat` / `--vera-font-size-phone-management` |
| `appearance.fontSize.desktop.chat` / `.management` | number（px，正数） | `--vera-font-size-desktop-chat` / `--vera-font-size-desktop-management` |
| `appearance.bubbleRadius.phone` / `.desktop` | number（px，非负） | `--vera-bubble-radius-phone` / `--vera-bubble-radius-desktop`（只用于聊天气泡） |
| `appearance.bubbleGap.phone` / `.desktop` | number（px，非负） | `--vera-bubble-gap-phone` / `--vera-bubble-gap-desktop`（只用于聊天时间线） |
| `appearance.windowMargin.phone.chat` / `.management` | number（px，非负） | `--vera-window-margin-phone-chat` / `--vera-window-margin-phone-management` |
| `appearance.windowMargin.desktop.chat` / `.management` | number（px，非负） | `--vera-window-margin-desktop-chat` / `--vera-window-margin-desktop-management` |

`chat`只指全屏聊天主页；`management`覆盖Space导航、当前Space设置、Settings及其子页、Account/Memory等管理页面。主题、主题色、高亮色和字体族保持全局；字体大小与窗口边距按“phone/desktop × chat/management”分域，气泡圆角/间距按phone/desktop分域且只影响聊天。前端按当前媒体宽度与路由把这些源token映射到`--vera-font-size-base`、`--vera-window-margin`、`--vera-bubble-radius`、`--vera-bubble-gap`四个运行时别名，组件只消费别名，不自行判断设备或页面。

F0确认默认值：`theme: "system"`、`themeId: null`、`fontFamily: "system"`；`fontSize.phone.{chat,management}: 14`、`fontSize.desktop.{chat,management}: 16`；`bubbleRadius.{phone,desktop}: 16`；`bubbleGap.phone: 4`、`bubbleGap.desktop: 10`；`windowMargin.phone.{chat,management}: 12`、`windowMargin.desktop.chat: 64`、`windowMargin.desktop.management: 8`。实现时这些值只定义在`config.appearance`，本文不形成第二份运行时默认。

前端允许在内存中覆盖这些CSS变量做实时预览；只有用户确认保存才 PATCH gateway。刷新、换设备或取消预览后，以 `GET /api/settings` 为准，`localStorage` 不保存已确认配置；F0 UI Lab只在当前预览内存中记录并导出未提交候选，不能冒充gateway已保存值。

**Theme与Appearance Profile交换 `[P4.6/F1]`**：Theme Palette与个人布局配置是两个独立对象，切换或导入Theme不得覆盖字体、字号、气泡或窗口边距。

```json
{
  "schemaVersion": 1,
  "kind": "vera-theme",
  "name": "Catppuccin Mocha",
  "colors": {
    "background": "#1e1e2e",
    "surface": "#313244",
    "text": "#cdd6f4",
    "mutedText": "#a6adc8",
    "border": "#45475a",
    "accent": "#89b4fa",
    "success": "#a6e3a1",
    "warning": "#f9e2af",
    "error": "#f38ba8"
  },
  "terminal": {
    "foreground": "#cdd6f4",
    "background": "#1e1e2e",
    "cursor": "#f5e0dc",
    "selection": "#585b70",
    "ansi": ["#45475a", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#bac2de", "#585b70", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#a6adc8"]
  }
}
```

- `GET /api/themes` → `{ themes: [{ id, name, schemaVersion, createdAt, updatedAt }] }`，只返摘要。
- `GET /api/themes/:id` → `{ theme: Theme }`；不存在返回404 `not_found`。
- `POST /api/themes/import` body `{ format, content, name? }`，`format`首批为`vera-json` / `vera-css` / `itermcolors` / `terminal-profile`；只解析并返回`{ preview, warnings }`，不持久化。
- `POST /api/themes` body `{ theme: Theme }`，保存已经确认的归一化Theme；成功返回`{ theme }`。
- `PATCH /api/themes/:id`只更新`name`或归一化`colors`/`terminal`；`DELETE`若被当前`appearance.themeId`引用则409 `conflict`，否则删除Theme记录，不改变消息或其他配置。
- `GET /api/themes/:id/export?format=vera-json|vera-css`导出Theme Palette；第三方终端格式先只承诺导入，不承诺无损导出。
- `GET /api/settings/appearance-profile/export`导出`{ schemaVersion: 1, kind: "vera-appearance-profile", appearance }`，其中不含`theme`、`themeId`、`themeColor`、`accentColor`；`POST /api/settings/appearance-profile/import`校验同一形状并只返回`{ preview, warnings }`，不保存。用户确认后仍用`PATCH /api/settings`写入，恢复默认仍对相应字段传`null`。

`vera-css`只允许`:root`或受支持的`[data-theme]`中的白名单`--vera-color-*`/`--vera-terminal-*`声明。gateway必须拒绝任意选择器、未知变量、`@import`、`url()`、外部字体和非声明规则，再将合法值归一化为Theme对象；不得保存或回传原始可执行CSS。终端转换器只读取前景/背景/光标/选区与16色ANSI调色板，缺失的Vera语义色返回`warnings`并按确定性默认规则派生。

Space/Agent设置由各自API管理；响应规则per-account per-Space挂在seat上（`responseMode/respondTo/blockAccountIds`）。Account Key、所属/当前Agent和Workspace只在Account系统管理。

**持久化语义**：`<dataPath>/settings.json` 保存设置override，`<dataPath>/themes.json` 保存归一化Theme对象，均走store防抖落盘（与 store 同 200ms 节流）。config.js 仍是启动默认 source（env 派生），settings.json 是运行时覆盖；只 persist overrides，不 persist 默认值或导入原文。consumer 接入（bubble-stream / view-compiler / memory 整理、Appearance token loader等）在 Phase 4.6 及以后；没有实际consumer和实测记录的字段不得在 `plan/index.md` 指向的对应功能计划中标成闭环完成。

### Memory（P5-M1–M4；Provider、权威层、Digest与Dream）

M1–M3已冻结的Markdown、Digest与retrieval细节继续有效；本轮在M4实现前先冻结active Memory Provider、Data配置、Digest/Dream任务模型与Dream job外部契约。自定义Provider的Extension Package安装/卸载和driver ABI仍属Phase 6，但本节先固定它进入Vera所必须满足的产品/API边界，不得先做任意第三方MCP直连或自动数据转换。

#### Active Memory Provider 与 Data 配置 `[P5-M4契约，Provider安装在P6]`

每个Agent恰有一个active Memory Provider。Provider binding必须同时保存`providerId + placement + config`：`placement.runtime`只允许`gateway/daemon/remote`；`daemon`必须绑定该Agent runtime的稳定`hostId`，`gateway`表示数据在gateway宿主，`remote`表示Provider自己管理远程事实来源且连接信息只通过`config.secretRef`引用。Phase 5存量Agent按当前真实vault幂等登记为`gateway` placement，即使它是CLI Agent也不得在模型迁移中自动搬到daemon；迁移只改绑定元数据，不移动或重写Memory正文。daemon运行链路完成后，新CLI Agent在首次daemon login时以已验证`memoryProvider`报告原子建立daemon placement，新API Agent默认可放gateway；在daemon尚未接线的当前切片不得预先把CLI改挂到一个不可达宿主。默认值一经落盘就是显式绑定，不随下一次登录静默迁移。只有已安装、manifest显式声明`memory-provider`能力并通过gateway契约校验的扩展才进入候选；普通第三方MCP即使暴露memory命名工具也不进入。自定义Provider可以把文件、数据库或远程服务作为原生事实来源，不要求复制或转换成Markdown。

Provider的核心契约是稳定的per-Agent身份绑定、稳定条目标识以及`list/fetch/search`安全投影；自定义Provider可把原生稳定ID映射为Vera facade使用的稳定slug/key，而不改变或复制原生存储。`create/update/archive/delete/sources/versioning/pin/links/usage/externalEdit`均由`capabilities`显式声明；模型整理能力另分为`digest.ingest`与`dream.maintenance`，并分别列出支持的`create/update/supersede/archive/merge/structureRewrite` operation。Digest至少要求可验证sources及create/update/archive；Dream只可使用其声明且符合下文窄化边界的maintenance operation。gateway始终掌握Agent身份、Message可见性、水位、调度、executor隔离、最终校验与无fallback；Provider driver只提供安全逻辑投影并把校验后的operation翻译成原生事务。缺失能力必须禁用相应UI/任务并返回`memory_provider_unsupported`，不能伪造实现。

```json
{
  "agentId": "agt_x1y2",
  "provider": {
    "providerId": "vera.markdown",
    "placement": { "runtime": "daemon", "hostId": "host_large_vps" },
    "config": {}
  },
  "digest": {
    "executorAgentId": "agt_helper",
    "modelMode": "fixed",
    "model": "gpt-5.3",
    "trigger": { "mode": "realtime", "thresholdChars": 20000 }
  },
  "dream": {
    "executorAgentId": null,
    "modelMode": "fixed",
    "model": "gpt-5.4",
    "schedule": {
      "mode": "weekly",
      "timezone": "Asia/Tokyo",
      "weekday": 1,
      "time": "03:00"
    }
  },
  "version": "sha256:opaque"
}
```

上例故意展示Digest委托给另一个执行Agent、Dream由owner自身执行，并分别选择两个`fixed`低成本模型的显式配置，不代表系统默认值；默认仍是两者`executorAgentId:null`、`modelMode:"inherit"`、`model:null`。

- 产品UI把active Provider显示为“Memory结构”；默认项文案为`Vera（兼容 Obsidian）`，内部`providerId`仍为`vera.markdown`。`placement`是该Agent数据位置契约，不是可自动尝试的候选列表；改变placement必须走显式迁移并验证完成后原子换绑。`config`只接受该Provider公开schema中的非敏感值或`secretRef`，不接受明文secret。切换active Provider不触发导入、复制或迁移；旧Provider数据保持原位但立即退出该Agent的检索、MCP写入、Digest和Dream事实来源。新Provider或其宿主不可用时明确报错，不得回退到旧Provider、gateway副本或`vera.markdown`
- Digest与Dream分别保存可选`executorAgentId`；执行Agent只提供自己的runtime与已验证task model，不借用任何Account。`inherit`取该Agent当前已验证聊天默认模型，`fixed`精确命中同一runtime revision下该任务已验证模型。
- Digest与Dream资格分开；模型不可用时返回`memory_task_unavailable`，不得改投其他Agent、Account、模型或Provider。
- gateway-local任务已经只从执行Agent的`runtimeProfile/runtimeBinding`与当前`runtimeRevision`解析provider/model，不读取旧Account字段或Home Account兼容层；迁到daemon时保持同一解析与资格语义。
- Digest `trigger.mode`沿用`manual/scheduled/realtime`互斥语义；`scheduled`为`{mode:"scheduled",cron,timezone}`，`realtime`为`{mode:"realtime",thresholdChars}`，`manual`不带附加字段。待整理上下文统计的是已完整保存、对该Agent可见且尚未被成功incremental Digest覆盖的Message，不是供应商context window，也不是Digest后删除的短时缓存
- Dream `schedule.mode`只允许`manual/daily/weekly/custom`。`manual`不带时间字段；`daily`要求IANA `timezone`与`HH:mm` `time`；`weekly`再要求ISO weekday `1..7`；`custom`要求受校验的五段`cron`与`timezone`。修改调度只影响新job；last/next/current状态是派生状态，不写进config
- 新Agent默认创建并启用`vera.memory`、`vera.memory.recall`、`vera.memory.write` binding；三者都是gateway runtime且没有执行Agent。Digest/Dream的`executorAgentId`默认`null`，`modelMode`默认`inherit`且`model=null`；两者自动策略均默认`manual`，不在用户未选择频率前产生后台模型费用。现有Agent的Digest trigger按M4一次迁移规则初始化

最小Data配置与状态端点：

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/agents/:agentId/memory/_config` | 返回`{config,version}`，version是配置规范JSON的opaque hash且不嵌入config；agent不存在404 |
| PATCH | `/api/agents/:agentId/memory/_config` | 按Provider schema、执行Agent及其runtime任务候选校验；不接受Account字段。Agent runtime/model修改只影响新job |
| GET | `/api/agents/:agentId/memory/_options` | 返回`{providers,tasks:{digest:{executors},dream:{executors}}}`；每个executor严格为`{agentId,name,runtimeRevision,availability:"available"|"unavailable",models:[{model,verificationId,isDefault}]}`，`runtimeRevision`不可用时为`null`，`isDefault:true`只标当前聊天默认模型且最多一个。列表只含当前revision下该任务真实可用、已验证模型，Digest与Dream资格不复用。`inherit`必须命中`isDefault:true`，`fixed`必须命中同名model；已保存配置若不再匹配，`_config`仍原样返回，前端显示通用不可用警告并禁止新job，不删除选择、不自动改投。不返回Account、secret、宿主路径或夹具正文 |
| GET | `/api/agents/:agentId/memory/_status` | 返回`{provider:{providerId,placement:{runtime,hostId?},state,capabilities,location?},longTerm:{activeCount,archivedCount,logicalBytes?,estimatedTokens:{estimator,value}},pendingContext:{messageCount,charCount,estimatedTokens:{estimator:"vera-utf8-v1",value},spaces:[{accountId,spaceId,spaceSessionId,messageCount,charCount,estimatedTokens,currentContext?}]},digest:{status,lastJob?,nextRunAt?},dream:{status,lastJob?,nextRunAt?,currentJobId?}}`。每个Account + SpaceSession的`estimatedTokens`表示未Digest Message若仍作为原始对话随该AgentSession窗口携带时造成的额外上下文量级；`currentContext`另投影对应active AgentSession的`agentSessionId/generation/estimatedInputTokens/effectiveLimitTokens/pressureRatio/measurement`，用于判断这份积压在当前窗口中的相对压力。两者都是估算，不冒充provider账单；跨Account/Space汇总更不得宣称为下一轮精确消耗。`logicalBytes`或估算不可得时为null，不伪造。Memory状态不返回Recall/Write binding；Hooks页直接读取唯一unit binding事实来源。`location`仅对file Provider返回所在宿主生成的安全展示值，不返回绝对路径；位置修改进入对应placement的受控迁移 |

`PATCH _config`切换Provider若目标未安装/未声明/缺少核心能力，返回422 `memory_provider_unsupported`并保持旧绑定；Provider已合法绑定但健康检查失败不阻止保存，状态显示`unavailable`，随后的操作返回503 `memory_provider_unavailable`。切换成功后清空该Agent的Provider-scoped cursor/检索sidecar；已经开始的AgentSession generation保留其冻结常驻前缀，下一次按正常compact或`/new`产生的generation才注入新Provider常驻前缀，切换Provider本身不得偷增generation。旧Provider数据不删除。响应不得声称数据已迁移；前端必须明确提示“原记忆保留在原Provider，当前不会读取”。所有`_config/_options/_status/_digest/_dream`保留段必须先于`:slug`注册，避免与合法slug冲突。

**默认`vera.markdown`文件库**：每个承载该Provider的宿主默认使用本机 `~/.vera/memory/`（配置项，宿主本地env `VERA_MEMORY_VAULT_PATH`），Obsidian兼容且在仓库外；该路径只对该宿主有意义。gateway placement由gateway进程管理，daemon placement由对应daemon的Provider执行器管理。vault根目录下仍按agentId分子目录 `<vaultPath>/<agentId>/`，每个Agent的记忆隔离，slug在Agent内唯一且建立后不可普通改名。同一Agent只有其active placement中的目录是热事实来源；备份或旧placement副本不得参与读写。不存在隐式“所有Agent可读”的全局池；未来若需要共享，必须另定义显式scope、授权和来源契约，不得把per-Agent目录合并扫描。以下文件/frontmatter/外部编辑规则只约束`vera.markdown`，不要求自定义Provider转换物理存储。每条记忆一个`.md`文件：

- 文件名 = 语义化 kebab-case slug（如 `bubble-split-rule.md`）。slug 即公共指针，一经建立不改名（R2）。
- frontmatter（YAML）：

```yaml
schemaVersion: 1
type: decision        # 枚举可扩展，起步集：project_rule / architecture / workflow / preference / correction / bug / decision / open_question
description: 一行钩子——常驻索引只展示这一行
scope:                # M1 只允许当前 Agent；目录与 agentId 必须一致
  type: agent
  agentId: agt_x1y2
status: active        # active / archived（过时先归档不删除）
stains:               # 可选，哑墨（R5）：agentId -> 裸 hex。四不：不注入、不解释、不引用、不作为判断依据
  agt_x1y2: "#7A8FA6"  # 为空时序列化为 `stains: {}`，键不省略
sources:              # 非空；只冻结下述两种 SourceRef
  - kind: message
    spaceId: spc_a1b2
    messageId: msg_m1n2
createdAt: 2026-07-13T00:00:00.000Z
updatedAt: 2026-07-13T00:00:00.000Z
```

- 正文为 markdown，`[[slug]]` 双链；指向尚不存在的 slug 合法（标记待写，不是错误）。
- `schemaVersion` 当前只能为 `1`；`scope` 当前只能是 `{ type: "agent", agentId }` 且必须与目录一致，禁止 `global` / `perSpace` 兼容值。`type` 是可扩展的小写 token（允许现行 `project_rule` / `open_question` 与 kebab-case 扩展），不做固定枚举分支；`description` 必须是非空单行字符串；`status` 只允许 `active` / `archived`；`stains` 必须是 `agt_... -> #RRGGBB` 对象；权威时间戳统一为带毫秒的 UTC ISO 8601（`YYYY-MM-DDTHH:mm:ss.sssZ`）。
- `SourceRef` 只允许 `{ kind: "message", spaceId, messageId }`、`{ kind: "deleted-message", spaceId, messageId, deletedAt }`或`{ kind: "manual", actor: "user" | "legacy", capturedAt }`。message ref 必须能在 gateway store 找到同 id Message 且 `message.spaceId === spaceId`；只保存引用，不复制 Message 正文。`deleted-message`只允许由永久删除Space的gateway流程从既有message ref生成，表示原文已按用户确认删除、不可再展开，不接受HTTP/MCP/model伪造。Activity、Run、工具过程和任意自由`kind`均不合法。手动POST不接受客户端伪造`sources`，由gateway补`{kind:"manual",actor:"user",capturedAt:now}`。
- F1 旧格式曾是合法数据，不能静默消失：仅当旧文件严格符合当时的 `type/description/status/stains/createdAt/updatedAt` 形状时，gateway 经同一 per-Agent 队列原子补齐 M1 字段，来源写为 `{ kind:"manual", actor:"legacy", capturedAt:createdAt }`，明确表示没有可追溯 Space；其他缺字段或畸形文件保持原位并进入坏文件错误，不猜测归属、不覆盖修复。
- API 的 `version` 是最终完整文件字节的 opaque `sha256:<hex>`，不写回 frontmatter（避免 hash 自引用）；`ifMatch` 与该值比较。`updatedAt` 是展示元数据，不再承担并发版本职责。

**常驻索引注入**：active Provider所在宿主扫描该Agent的数据并通过Memory facade返回安全索引投影，gateway生成至多N行（配置，默认25）`[[slug]] — 钩子行`，在每个AgentSession generation的**首条Run**头部注入，并提示「相关时调用Vera Memory MCP展开slug」。不向Agent暴露宿主vault绝对路径，也不让它用文件工具直读。索引**批量换版**：只随AgentSession generation换代，不逐条消息刷新（缓存纪律——它属于稳定前缀，不是逐条变化的检索注入）。M3历史实现的挑选顺序为置顶项按`pinnedAt,slug`稳定排序优先，非置顶项因`derivedWeight=0`按slug稳定排序，archived排除；M4只替换非置顶的长期派生权重。

**逻辑单写入口与物理提交**：Agent runtime（主Agent、subagent、CLI、daemon及未来Hook/Dream）的Memory读写统一进入gateway第一方Vera Memory MCP，再由Memory facade路由到active Provider；不得绕过Provider用文件/数据库工具直读直写。owner前端保留HTTP管理API。对`vera.markdown`，HTTP与MCP写入最终翻译成内部`MemoryOperation`：`{ operationId, agentId, origin, kind, slug, ifMatch, value|patch, requestedAt }`。origin为`user-api`/`agent-mcp`/`memory-hook`/`memory-dream`/`external-scan`，kind为`create`/`update`/`archive`/`delete`。gateway是身份、校验、排序和路由权威，active Provider宿主是物理提交权威；自定义Provider接收等价driver operation并负责原生存储事务。MemoryOperation不是公网API。

同一Agent的operation在gateway逻辑队列与目标Provider宿主的物理队列中保持相同顺序，前一项失败不得毒死后续队列；不同Agent可并行。create的重复检查以及update/archive/delete的`ifMatch`检查必须在目标Provider的提交队列内完成。对`vera.markdown`，Provider执行器先在目标文件同目录写唯一临时文件并flush文件，再以不覆盖create/原子替换update的方式提交，最后尽可能flush目录；失败清理临时文件，旧文件保持完整。成功提交权威文件并向gateway返回版本后才能更新派生索引。placement或vault热切换必须等待在途operation排空，不能让一次写跨两个宿主或根目录。

用户通过Obsidian所做的外部新增、编辑、删除由vault所在宿主重扫，经同一Agent Provider队列刷新派生状态并上报gateway；它保留原`sources`，不伪造成gateway程序写入，也不自动修补一般坏文件。

**Agent 作用域**（F1修订）：owner Memory管理API以`/api/agents/:agentId/memory`为前缀；Vera Memory MCP tool参数中**禁止出现`agentId`**，gateway从可信调用上下文注入身份。两条入口都按`agentId`隔离同一active Provider facade——agent A无法读写agent B的记忆。前端Agent使用管理的Data → Memory进入`#/agents/:agentId/data/memory`时才加载配置与状态，再按需进入长期Memory管理，不预取所有agent的Memory正文。

**派生索引与坏文件隔离**：索引放在 `<vaultPath>/.vera-index/<agentId>.json`，M3提升为形状 `{ schemaVersion:2, generation, builtAt, agentId, entries, errors }`；entry 至少含 `slug/version/type/description/status/sourceRefs/links/updatedAt`，明确不含`stains`。索引只是缓存：缺失、JSON 损坏、版本不支持或文件指纹变化时，只读 vault + store SourceRef 全量重建，经临时文件原子替换索引；不得反向覆盖 markdown。每次 scan 返回 `{ agentId, scannedAt, created, updated, removed, unchangedCount, invalid, index:{ generation, builtAt, status } }`，其中 status 为 `current` / `rebuilt` / `degraded`；索引写失败只令 status=`degraded`，不混进 MemoryFileError。坏文件保留原位、排除列表/常驻索引，并产生 `{ code, relativePath, slug, issues:[{ field, code, message }] }`；对外不得泄露 vault 绝对路径。单个坏文件不影响其他记忆；直接 GET 坏文件返回 422 `invalid_memory_file`。

**旧根目录文件处理**（F1 一次收口）：历史版本若在 vault 根目录留有未分 agent 的 `*.md`，gateway 不得猜测归属、不得删除，也不提供旧 `/api/memory/*` 双路由。这些文件保持原地，`/api/paths` 与 `/api/status` 显式返回 `legacyUnscopedCount`；存在未归属文件时拒绝 vault 迁移（409），由用户先人工移入明确的 `<agentId>/` 后重试。

#### Vera Memory MCP（第一方Agent接口）

MCP工具名是Vera契约，不宣称存在行业标准Memory tool集合。当前Phase 5先实现协议无关dispatcher，调用方必须传入gateway内部已绑定的`{ agentId, sourceRefs, runId? }`可信上下文；tool schema不含`agentId/scope/origin/sources`。Phase 5.5 agent token落地后，gateway再把同一dispatcher绑定到Tailscale私网Streamable HTTP transport；Bearer token解析出的agentId就是唯一Memory身份。此前不得注册允许网络调用者自选agentId的临时`/mcp`端点，也不得用owner身份冒充agent身份。

`vera.memory` unit只允许启用状态、可用性和工具清单；unit binding与所有tool schema都不得出现`executorAgentId/semanticAgentId/model/embedder`。Recall/search的粗召回、embedding、筛选、去重、排序和token预算由gateway固定执行，不调用聊天Agent。未来小模型语义增强必须另立版本化阶段与失败语义；本阶段不预留假字段、不自动选Agent、不静默调用模型。

| 阶段 | Tool | 输入（均不含agentId） | 行为 |
|---|---|---|---|
| M1增量 | `memory_list` | `{ status?, type? }` | 列出当前Agent的Memory摘要与坏文件诊断 |
| M1增量 | `memory_fetch_detail` | `{ slug }` | 按已知slug读取权威正文；M1不记录正文展开统计，M3在同一工具上增强一跳链接与使用统计 |
| M1增量 | `memory_create` | `{ slug,type,description,content,stains? }` | gateway从可信Execution上下文注入SourceRefs，再提交`agent-mcp/create` operation；无可验证来源时拒绝 |
| M1增量 | `memory_update` | `{ slug,ifMatch,type?,description?,content?,stains? }` | 保留原sources并走opaque version并发控制；归档只走`memory_archive`，不留同义入口 |
| M1增量 | `memory_archive` | `{ slug,ifMatch }` | 归档而非物理删除；Agent MCP不开放不可逆delete |
| M2 | `memory_digest` | `{ fromMessageId,toMessageId,mode }` | 只引用当前可信Execution的Account + SpaceSession中gateway已保存的Message范围创建digest job；不重复ingest或复制Raw Message |
| M3 | `memory_search` | `{ query,tokenBudget? }` | query NFKC后1..4096 code points；tokenBudget默认1200、范围64..1200。不接受scope/status/type/session/identity filter；检索、图扩散、去重、软配额和预算均由gateway固定执行 |
| M3 | `memory_fetch_more` | `{ cursor,direction,tokenBudget? }` | cursor由server snapshot产生；direction只能是该snapshot返回的`all`或`directionId`，选定后后续cursor绑定该分支；tokenBudget同search |
| M3增强 | `memory_fetch_detail` | `{ slug }` | 保持M1工具名与参数不变，增加一跳链接并记录使用统计 |

M2实现`memory_digest`前必须冻结跨job、跨slug的确定性事实身份或等价匹配规则。slug仅是公共指针，不能作为唯一语义去重键；同一事实以不同措辞或建议slug再次出现时必须命中既有Memory并update/merge，纠错或新事实取代旧事实时必须supersede/archive且保留双方SourceRefs。该身份属于可重建的程序派生数据，不成为Agent可手写的Memory frontmatter字段；精确名称和算法留在M2契约先行步骤一次定稿。

#### M2 digest job、触发与事实匹配

per-Agent Digest配置中的`trigger`是单选自动策略：`scheduled`与`realtime`不同时运行；选`manual`只关闭自动策略。`vera.memory.write`是自动Digest总开关：关闭时不按scheduled/realtime enqueue，但owner HTTP与可信Agent MCP手动Digest始终可用。`realtime`的唯一水位是`(agentId, accountId, spaceSessionId)`下、上次成功增量job之后已完整保存且该Agent通过该Account会话可见的Message正文Unicode code point数；`accountId`只约束证据授权与来源，不改变Memory owner。Digest范围不得跨Account或SpaceSession，`/new`不丢弃旧窗口未整理水位。达到阈值只异步enqueue，聊天请求、Run结束与context compact均不等待整理。pending token只用`vera-utf8-v1`表达整理积压，不能冒充provider精确计费或触发context compact。Write Hook不参与Dream调度。

范围首尾inclusive，必须属于同一Account授权下的SpaceSession，按store `_seq`顺序解析，只引用gateway已保存的`status=completed` Message；job不持久化Message正文副本。Agent可见谓词按冻结的`agentId + accountId`执行。`mode`为`incremental`或`range`：automatic trigger只创建incremental；manual两者都可用。incremental成功（包括全skip）才推进该`(agentId,accountId,spaceSessionId)`自动水位，failed/cancelled不推进；manual range不推进，manual incremental推进。同一`(agentId,accountId,spaceSessionId)`最多一个active job，后续Message留给下一冻结窗口。

持久job安全摘要：`{id,agentId,sourceAccountId,spaceId,spaceSessionId,mode,trigger,range:{fromMessageId,toMessageId,messageCount,charCount,estimatedTokens},pipelineVersion,idempotencyKey,status,attempt,createdAt,startedAt?,finishedAt?,error?,result?}`；其中公开`agentId`始终是Memory owner Agent，`sourceAccountId`只标记原始Message授权与来源窗口。其余状态、快照、幂等、错误与无fallback规则保持不变；冻结快照不得含AgentSession checkpoint、API history、CLI provider binding、connection/secret或Workspace。

status为`queued/running/applying/succeeded/failed/cancelled`。入队冻结`memoryTaskSnapshot={ownerAgentId,executorAgentId,runtimeRevision,kind,provider,modelMode,taskModel,verificationId}`与Provider快照；不含Account。retry复用原快照。

程序按可见Message顺序切分：每块最多8000 Unicode code points，不重叠，不拆单个Message；单条超限Message独占一块。gateway内部可保留chunk id、边界和计数用于确定性调度，但送给executor/model的`chunks`只允许是`[{messages:[{messageId,author,target,content,createdAt}]}]`；不得暴露chunk id/from/to/count等可被误认成证据ID的内部元数据，proposal的`evidenceMessageIds`只能逐字复制其中的`messageId`。SourceRef仍由gateway另行生成。executor同时收到当前Agent全部fact catalog的 `{factId,slug,type,description,status,addressSlots,valueHash,version}`；尚无M2 receipt的手动/legacy/Obsidian Memory以`{factId:null,slug,type,description,status,version,unmapped:true}`进入同一catalog，供模型提议一次adopt，不得收到stains、vault路径或provider连接。`type`让executor在update/supersede时看到现有结构化分类，避免无意改类；它不进入fact identity。proposal数组最多32项。

`memory_digest`调用输入不接受executorAgentId、provider、model或fallbackModel；执行Agent与任务模型只来自已保存的per-Agent Data配置。MCP不接受可伪造的accountId，gateway从可信Execution绑定`sourceAccountId`，owner HTTP则显式提交并经Account授权校验。gateway解析执行Agent及其runtime revision后调用`digestMemory({runtime,taskModel,payload,signal})`；runtime只向可信adapter提供provider连接，不进入prompt。即使执行Agent是B，payload仍只含owner A在冻结source Account窗口内的安全Message数据，不含B的Memory、聊天上下文、Account凭据、Workspace或Tools。Codex/Ollama既有隔离与无fallback规则不变。

Digest资格绑定精确`executorAgentId + runtimeRevision + kind/provider + adapter profile + model不可变标识`。runtime/provider/model变化使旧资格失效；与Agent当前登录哪个Account无关。失败不得改投其他Agent或模型。

模型只可返回严格 proposal：`{ action,evidenceMessageIds,targetFactId?,targetMemorySlug?,fact?,suggestedSlug?,type?,description?,content?,stains?,skipReason? }`。`fact={ subject:string,relation:string,qualifiers:string[],value:string }`，qualifiers去重排序后参与规范化。禁止提交 `agentId/scope/sources/origin/operationId/ifMatch/importance/confidence/targetSlug`，未知字段即整个 job 在 apply 前失败。create 必须有fact/suggestedSlug/type/description/content且不得有既有target；update/supersede/archive必须且只能二选一提交已存在`targetFactId`，或对catalog中`unmapped:true`条目提交`targetMemorySlug`完成首次adopt。update必须有同一事实fact/type/description/content；supersede必须有同地址不同value的fact/type/description/content；archive只需target与证据；skip只允许`skipReason=no_reusable_fact|unsupported_inference|ambiguous_match|duplicate_in_job`且不得带写字段。除skip外 evidenceMessageIds 必须为1..64个冻结范围内唯一可见Message id。gateway 必须先验证全部 proposal 的 schema、证据范围、Agent/Space scope、slug、单行description、双链、stain裸`#RRGGBB`与复用价值；任一非法则job在apply前失败、vault不变。模型/executor 不得到 store、vaultPath、Account connection、secret 或写接口。

程序把 `NFKC + 大小写折叠 + 空白折叠` 后的 `(agentId,subject,relation,排序后的qualifiers)` 哈希为新事实初始factId/address hash，把规范化value哈希为valueHash。自由文本hash本身不宣称解决同义词：executor必须优先从既有fact catalog选择opaque targetFactId；gateway只接受精确存在且slug/version仍对应的targetFactId。首次create才生成新factId；同义改写、不同suggestedSlug与跨job新证据通过复用targetFactId命中原slug。fact catalog由succeeded/partial job applications审计 + 当前vault版本重放重建，不写入frontmatter；Obsidian外部编辑导致version不符时该项标stale，下一次不能自动supersede，须executor重新提议update并由gateway以当前版本复核。地址相同而值冲突时，只有supersede且evidence含明确纠错文本才更新原slug；更新保留旧+新SourceRefs，并记录oldVersion→newVersion。仅当旧事实彻底失效且无替代正文时才archive。M2不合并两个既有文件、不rename；多候选或模糊匹配必须skip/reject。

整批proposal先验证后apply，因此非法proposal保证vault零变化。验证通过的原始proposal与当时catalog versions先持久化并flush，重试不得重新调用模型；apply阶段以proposal为恢复单元：每条proposal经M1队列保证单Memory原子，成功receipt随即flush；后续IO/版本失败可令job `failed` 且result保留已应用项，retry只继续未应用项。若进程恰在vault原子提交后、receipt flush前退出，持久proposal重放必须以当前权威内容+SourceRefs识别目标已达状态并no-op。M2不承诺多个Memory文件的跨文件原子事务，但任何时刻都不得出现半个markdown文件或重复创建；这就是“hook失败不产生半条记忆”的精确边界。

MCP `memory_digest` 的`mode=range`要求from/to；`mode=incremental`可省from，to缺省取可信run的trigger Message。tool schema仍不含agentId/accountId/spaceId/spaceSessionId/sources，四者从可信Execution上下文绑定，成功返回安全job摘要。owner：`POST /api/agents/:agentId/memory/_digest` body严格为`{accountId,spaceId,spaceSessionId,mode,fromMessageId?,toMessageId?}` → 202 `{job}`；gateway验证该Agent确实通过该Account取得目标SpaceSession可见性，`accountId + spaceId + spaceSessionId`必须属于同一授权窗口。显式`range`可以整理合法历史范围，不要求出现在当前pending列表。Data → Memory的手动incremental操作才从`pendingContext.spaces`选择：零项disabled、一个范围可默认选中、多个范围必须由User显式选择一个，并提交`{accountId,spaceId,spaceSessionId,mode:"incremental"}`；不得从汇总数猜测窗口或跨SpaceSession合并。其余幂等、查询、retry/cancel和SSE规则不变。

#### M4 Dream job与调度

Dream只读取入队时active Provider的长期Memory快照、安全usage派生与图/版本元数据，提出明确重复项合并、不改变事实含义的结构/描述/双链整理和冗余归档operation；它不监听实时对话，也不接收原始Message正文、AgentSession、Account Workspace或provider binding。没有冻结Message证据时，Dream不得纠正或supersede事实值、凭模型常识宣布事实过时、删除来源或直接写派生权重；事实变化必须回到有Message证据的Digest或owner手动编辑。gateway负责调度、冻结范围、验证proposal并通过同一active Provider facade提交；执行模型没有直接写存储权限。

**派生权重冻结**：Dream/derivedWeight子阶段本身不新增seed渠道，也不改变当前retrieval pipeline的scope/status/AgentSession generation过滤、BM25/vector召回、图扩散、交汇置信、类型适配、两阶段去重、软配额或token预算。它只对已经进入候选集的Memory计算`derivedWeight`，输入必须能从权威Provider与gateway store完全复算：双链唯一入度25%、安全usage 30%、owner编辑15%、置顶20%、按type时间衰减10%。每个分量先归一化到`0..1`再加权并clamp；`stains`不进入任一输入。usage中`detail_opened`权重为4，`auto_injected/search_returned/fetch_more_returned`权重为1；计数用同Agent候选中的`log1p`最大值归一化，最近使用按30天半衰期衰减，两者在usage分量内按`0.7/0.3`合成。owner通过HTTP创建或修改`type/description/status/content`、以及Obsidian外部编辑有效文件，写持久`user_edited` signal；仅改`stains`、pin、sources或程序Digest/Dream写入不产生该signal。owner编辑按180天半衰期衰减。置顶分量只读owner pin signal；常驻索引仍先完整排置顶项，再对非置顶项按derivedWeight降序、slug升序稳定排序。

type时间衰减是数据驱动表而非业务枚举分支：默认半衰期天数为`project_rule:3650, preference:1825, correction:1095, architecture:730, decision:730, workflow:365, bug:180, open_question:90`，未知type使用365；时间基准为权威Memory的`createdAt`，不得用混合自动写入的`updatedAt`冒充用户重要性。为避免完全确定的尾部饿死，derivedWeight可加入不超过`0.02`的确定性探索量；它只由gateway配置seed与slug派生，同seed可复算，不能把候选外Memory带进本轮，也不能改变其他四项分数。派生算法版本随retrieval pipeline冻结；清空派生索引后必须从vault+signals得到相同结果。

Dream的`memoryTaskSnapshot`同样冻结`ownerAgentId/executorAgentId/runtimeRevision/kind/provider/modelMode/taskModel/verificationId`，不含Account。执行者B只提供自己的runtime和模型，payload仍只含owner A的Memory安全投影；Dream资格不复用Digest资格。

安全job摘要固定为`{id,agentId,trigger,requestId?,status,attempt,createdAt,startedAt?,finishedAt?,result?,error?}`；`trigger`为`manual/scheduled`，status为`queued/running/applying/succeeded/failed/cancelled`，result只含`{scannedCount,updatedCount,mergedCount,archivedCount,noopCount}`，error只含稳定code与安全message。不得返回prompt、Memory正文、proposal、stain、executor/provider snapshot、Account/provider连接、模型原始输出或宿主路径。

M4起Digest与Dream公共job错误码统一为`memory_task_unavailable/memory_provider_unavailable/executor_failed/invalid_range/invalid_proposal/write_conflict/write_failed/cancelled`，都落`failed`或`cancelled`终态；0.0.1不引入未定义恢复条件的`paused`状态。adapter内部`executor_unavailable`在job边界折叠成`memory_task_unavailable`，Provider健康/绑定失效折叠成`memory_provider_unavailable`。HTTP配置校验使用同名稳定code并按本节指定的409/422/503返回。

Dream executor payload严格为`{agent:{id,name},memories,proposalSchema}`。`memories`按slug稳定排序，每项只含`{slug,version,type,description,status,content,sources,links,derived}`；`links`是正文中唯一slug集合，`derived`只含上述可复算分量的数值安全摘要，不含query、stain、vault路径、Account、Provider config或任一Agent提示。单job最多冻结256条active/archived Memory；超过时按置顶、derivedWeight、slug稳定分批，当前M4一个job只处理冻结批次且结果明示`scannedCount`，不得让模型自行翻页或读vault。

Dream输出是严格`{proposals:[...]}`，最多64项，只允许下列四种proposal，所有target都必须逐字命中冻结快照且携带对应version；未知字段整批拒绝、apply前vault零变化：

- `keep`：`{action:"keep",targetSlug,targetVersion}`，只记noop receipt，不写Memory。
- `update`：`{action:"update",targetSlug,targetVersion,type?,description?,content?}`，只允许不改变事实命题和值的结构化重写、描述压缩或双链整理；至少一个可写字段。不得提交`stains/sources/status/slug/importance/confidence/fact/value`。gateway保留原sources，并以现有fact identity/valueHash与Provider能力校验；无法证明不改变事实时整批拒绝，等待Digest或owner处理。
- `merge`：`{action:"merge",targetSlug,targetVersion,sourceSlugs:[...],sourceVersions:{...},type,description,content}`。source为2..16条唯一active Memory且包含target；gateway把所有sources去重并入target，要求proposal content包含各成员原有出链的并集（排除组内自链），然后归档除target外的成员但不删除、不rename。指向这些已归档slug的既有入链不批量改写，因此仍可追溯；归档成员保留自身sources/content/version历史。
- `archive`：`{action:"archive",targetSlug,targetVersion,replacementSlug}`。Dream只允许归档已有明确active替代项的冗余Memory，因此`replacementSlug`必填且必须指向同一冻结批次的active Memory；只改status并保留sources/content，不写兼容别名。没有替代项的“过时/错误”判断不属于Dream。

同一slug在一个job中最多被一个非`keep` proposal写入；merge成员不得再被独立update/archive。全部proposal先做版本、能力、链接、来源与冲突预检，再进入同一Agent单写者的**批量维护临界区**：批内可逐文件原子提交与持久receipt恢复，但常驻/派生索引只在批次结束后重建并一次发布新generation。新的AgentSession generation只能看到旧整版或新整版常驻索引，不能看到半批；已经开始的generation及已冻结cursor始终保持原版本。进程在部分文件写入后退出时，retry按receipt与当前权威版本识别applied/noop并继续，不能重复merge或丢sources/双链。

| Method | Path | 说明 |
|---|---|---|
| POST | `/api/agents/:agentId/memory/_dream` | body严格为`{requestId}`，requestId为客户端每次点击生成的opaque幂等键；立即返回202`{job,coalesced}`。同一`(agentId,requestId)`重试返回同一job；该Agent已有active Dream时返回当前job且`coalesced:true`，不并发创建第二个 |
| GET | `/api/agents/:agentId/memory/_dream/jobs?limit=` | 返回安全job摘要列表，默认20、最大100 |
| GET | `/api/agents/:agentId/memory/_dream/jobs/:jobId` | 返回`{job}`；不存在404 |
| POST | `/api/agents/:agentId/memory/_dream/jobs/:jobId/cancel` | 仅queued/running可取消；applying或终态返回409 |
| POST | `/api/agents/:agentId/memory/_dream/jobs/:jobId/retry` | 仅failed/cancelled可重试并复用原冻结快照；其他状态409 |

daily/weekly/custom调度到点后用`sha256(agentId|schedule-slot|configVersion|providerBindingVersion)`生成幂等键；gateway重启只补最近一个错过的slot，不追跑全部历史。聊天Run与页面请求不等待Dream。job更新发布`memory.dream-job.updated {agentId,job:<safe summary>}`；Data页按该事件刷新`.../memory/_status`。Dream内部proposal/schema与merge事务必须在M4实现前另按现有Memory版本/来源/单写者规则冻结，但不得改变上述HTTP、幂等、快照和无fallback语义。

M3的`memory_search`返回项统一叫**召回节点**：它是某一条Memory的可独立理解语义投影，必须足以让Agent判断直接使用或调用`memory_fetch_detail`展开同一条Memory的权威正文；不得只返回无语义slug/分数。沿正文中的`SourceRef`读取Message才是溯源到**来源原文**。派生检索结构统一叫**索引**，不作为纵向内容层名称。写入`type`只是结构化分层：召回仍跨type开放扩散，type不成为默认filter或图边界。

M3物理顺序固定为：

1. 以当前Agent scope、`active`状态和当前`agentSessionId + generation`已注入集合做资格过滤；提取query，以关键词、向量及其他冻结渠道产生出发节点。
2. 从出发节点沿Memory图做有界多hop开放扩散，逐命中记录一级方向、路径和hop距离；不得先按type切池或截断。最大hop、逐跳衰减和候选上限必须可复现并在M3契约冻结；内部扩散只遍历索引，不递归注入正文，`memory_fetch_detail`显式关联仍只返回一跳。
3. 按稳定slug做**命中归并**：同一节点只保留一份候选，但合并全部独立方向与路径。该步骤为后续计分汇总证据，不是结果名额去重；同一方向内重复路径不增加置信。
4. 对归并候选计算五项归一化后的加权和：`baseScore = wq·queryRelevance + wg·graphProximity + wl·derivedWeight + wc·intersectionConfidence + wt·typeFit`。`queryRelevance`来自query关键词/向量等直接语义匹配；`graphProximity`由候选相对出发节点的hop距离与冻结边强度经单调衰减得到，同节点多路径采用最有利的有效距离，独立方向并集另进入`intersectionConfidence`。无图路径的直接语义命中其`graphProximity`取中性值，不得被排除；本轮图接近度不得与长期权重中的图中心性混为一项。`typeFit`只表示当前query和所需抽象粒度对候选type的适配，不是硬过滤。
5. 按确定性事实身份和语义簇做**结果去重**，合并近重复候选的独立方向置信，选择最符合当前query粒度的代表节点；`type`只辅助判断语义簇是否兼容，置信只来自独立一级方向并集，不得把只是同type但事实不同的节点当重复项。
6. 在去重结果上按`marginalScore = baseScore - redundancyPenalty - boundedSoftQuotaPenalty`逐项重排；type软目标必须随本轮query需求调整，并只影响有界的`boundedSoftQuotaPenalty`。先在召回节点契约允许范围内选择更短但仍可独立理解的投影，再按总token预算确定性截断，未装入项进入稳定cursor。软配额是可借用的目标token占比/边际惩罚，不是每类数量上限，也不保留不可借用槽位；超过目标时惩罚随超额单调增加但必须封顶，使该类后续边际收益递减。当其他类型没有更高边际收益、query对该类需求强或该类候选基础分明显更高时，允许继续选取该类。

单轮交汇的原始方向数对任何已命中候选至少为1，再由冻结函数转换为归一化的`intersectionConfidence`贡献；该贡献随独立一级方向数单调增加、边际递减且封顶，不能把原始值1当作归一化满分。语义簇合并取方向并集，不得由重复副本或type本身刷分。它只进入本轮ranking，不进入Memory frontmatter、长期派生权重或使用统计；正文展开和SourceRef溯源不计为横向方向。type软配额不得单独淘汰候选：例如当前query需要5条彼此独立的规则类Memory时，即使该类软目标为3，只要它们的重排边际收益仍领先且总token预算容纳，就必须允许返回5条。只有语义重复、综合边际收益不足、session去重或总token预算可令结果少于5条。未知扩展type进入默认软配额组，不得丢弃。

目标retrieval pipeline固定为`m4-r2`，取代当前已实现的`m4-r1`字符trigram查询召回；所有分数先clamp到`[0,1]`再四舍五入保留6位小数。直接召回两个等宽渠道各取前24个大于0的seed：关键词渠道继续使用NFKC、Unicode case-fold与空白折叠后的BM25（`k1=1.2,b=0.75`），本轮以最大raw BM25归一；vector渠道改为真实embedding cosine，`queryRelevance=max(keywordNorm,clamp(embeddingCosine,0,1))`。char-trigram不再产生query seed，但继续作为独立的确定性duplicate vector服务下文去重和冗余惩罚。

首版embedder由gateway直接管理，不经过Agent、Account、MCP unit或provider registry：只调用loopback Ollama`http://127.0.0.1:11434/api/embed`，模型精确为`qwen3-embedding:0.6b`、`dimensions:1024`、`truncate:false`。索引身份必须同时记录`modelName + Ollama完整modelDigest + dimensions + documentProjectionVersion`，不得使用`latest`、自动pull、自动换模型、远程fallback或聊天Agent。query文本固定为版本化英文instruction加当前`memory_search.query`或自动Recall的trigger Message；document固定为`Type: {type}\nDescription: {description}\nContent:\n{content}`，不含scope、sources、stains、时间戳、Agent id、frontmatter或路径。每条Memory一个向量，不切chunk；单条超限只缺该条vector并继续keyword/graph。

对`vera.markdown`，sidecar为`<vaultPath>/.vera-index/<agentId>.embedding.json`，索引头至少含`schemaVersion,agentId,memoryGeneration,embeddingGeneration,modelName,modelDigest,dimensions,documentProjectionVersion`，entry只含`slug,memoryVersion,vector`。不得保存正文、query、stain、sources、Account、AgentSession、provider connection或secret。`.vera-index/`必须被vault Git忽略；vault迁移不把它当用户数据复制，而是在新位置从权威Markdown重建。新建或`type/description/content`版本变化仅重建该条，archive/delete移除；model digest、维度或投影版本变化全量重建。搜索只使用`memoryVersion`仍匹配权威Memory且维度/数值合法的向量；发布使用临时文件、flush和原子rename。不引入SQLite、向量数据库或ANN，首版线性cosine扫描。

图扩散最大hop为2，slug归并前候选上限128。正向`[[slug]]`边强度1.0，反向边0.85，`pathStrength=product(edgeStrength) * 0.70^(hop-1)`，`graphProximity`取最强有效路径；无图路径的直接语义命中取0.5。一级方向身份由seed slug派生，同seed被两个直接渠道命中仍只计一个方向；BFS顺序固定为seed `queryRelevance desc, slug asc`，邻接slug升序。`intersectionConfidence = log2(1 + min(directionCount,4)) / log2(5)`，单方向不是满分，4方向封顶。

五项权重冻结为`0.45 queryRelevance + 0.20 graphProximity + 0.15 derivedWeight + 0.15 intersectionConfidence + 0.05 typeFit`；M3的`derivedWeight=0`，不得用`updatedAt`或其他临时信号冒充。type token经`_/-`拆分和英文单数化后，若其中任一token在query中出现则`typeFit=1`并使用该exact type软配额组，否则`typeFit=0.5`并进入`other`组；未知扩展type因此始终可进入且取中性值。

第二阶段去重的贪心leader顺序为`baseScore desc, slug asc`，不做连锁传递闭包。同一M2 `factId`、归一化projection完全相同，或独立duplicate char-trigram vector cosine>=0.92且token Jaccard>=0.75并且type相同/一方为中性未知时聚为同簇；不得使用query embedding相似度判定同一事实。代表节点按`typeFit desc, baseScore desc, standardTokenCost asc, slug asc`选择，方向取并集后重算交汇和base score。一次页面成功交付代表节点时，代表slug及其全部`mergedSlugs`必须共同写入当前`agentSessionId + generation`的delivered集合，防止重复副本在后续请求重新出现。投影两级和预算降级规则保持不变。

语义冗余惩罚使用候选与已选节点的最大duplicate char-trigram cosine `s`，不使用query embedding：`s<=0.75`为0，否则`min(0.20, 0.20 * ((s-0.75)/(0.92-0.75))^2)`。匹配type组的demand为1，`other`为0；`rawTarget=1+2*demand`并在本轮存在的组内归一为`targetShare`。候选加入后该组token占比超出目标的部分为`quotaExcess`，`boundedSoftQuotaPenalty=min(0.12,0.25*quotaExcess)`。边际分为`baseScore-redundancyPenalty-boundedSoftQuotaPenalty`；tie-break固定为`marginalScore desc, baseScore desc, queryRelevance desc, graphProximity desc, compactTokenCost asc, slug asc`。

token估算器固定为`vera-utf8-v1(text)=max(1,ceil(byteLength(NFKC(text),utf8)/3))`，按最终序列化块的header、节点包装与cursor提示一并计费。自动注入使用`memory.injectionBudgetRetrievalTokens`默认384；MCP page默认1200、最小64、最大1200。自动块格式固定为`=== Vera 相关记忆 ===\n- [[slug]] [type] projection\n…\n仅在相关时使用；需要正文调用 memory_fetch_detail。`；存在未装入项时再追加`更多：memory_fetch_more(cursor="<opaque>", direction="all")`。返回节点形状固定为`{rank,slug,version,type,projection,projectionLevel,reasons,directionIds,primaryDirectionId}`，reasons只公开`keyword/vector/graph`类型、有限hop与opaque directionId，不公开具体分数、惩罚或信心解释。响应是`{retrievalId,nodes,cursor,directions,budget:{estimator,limitTokens,usedTokens,omittedCount,minimumNextNodeTokens},degradedChannels}`。

cursor是server侧持久snapshot的随机opaque id，绑定`agentId + agentSessionId + generation + retrievalId + pipelineVersion + memoryIndexGeneration + embeddingGeneration`，保存冻结排序的无stain投影、offset、分支和已缓存page，24小时TTL，AgentSession generation换代立即失效。普通Memory或embedding索引换代不重排已有snapshot；其余分支、幂等与删除authority规则保持不变。cursor不保存query明文、正文、stain、Account连接、provider信息、AgentSession checkpoint或CLI binding。

持久化安全usage事件`{agentId,agentSessionId,generation,runId?,retrievalId?,slug,kind,createdAt}`，kind只允许`auto_injected/search_returned/fetch_more_returned/detail_opened`；不保存query/projection/正文/stain/Account/provider/AgentSession history或provider binding。页面成功返回后才记，同一页面重试不重记，`detail_opened`同generation+slug只记一次。

`memory_fetch_detail`读当前权威Memory，Agent-safe返回`{memory:{slug,version,type,description,status,content,sources,links,linksCursor},usageRecorded}`，不含stains。links只返回一跳、最多32条，每条为`{slug,state,type,description}`，按边强度降序、slug升序；剩余链接进入links cursor并仍通过`memory_fetch_more`继续。archived的已知slug可展开但必须明示状态；SourceRef与正文展开都不增加横向交汇。

自动检索失败时聊天继续；显式MCP错误继续使用稳定安全code。模型缺失/Ollama离线、query embed超时、model digest变化待重建、维度或数值错误、sidecar损坏及重建中都只令vector渠道不可用，继续返回keyword+graph并公开`degradedChannels:["vector"]`；不自动换模型或调用Agent。只有整个retrieval facade不可用才返回`memory_retrieval_unavailable`。retrieval不新增SSE事件，不把query/slug/usage注入Activity。

owner HTTP管理API继续承担人工创建、编辑、删除与前端错误展示；它不是Agent runtime的第二套Memory能力。MCP dispatcher、owner HTTP routes、write hook和dream必须复用同一Memory facade/queue。

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/agents/:agentId/memory` | 先重扫该 Agent，返回 `{ memories:[{ slug,type,description,status,stains,pinned,sourceCount,createdAt,updatedAt,version }], errors:MemoryFileError[], index:{ generation,builtAt,status } }`，memories 按 updatedAt 降序。agent 不存在 → 404 |
| POST | `/api/agents/:agentId/memory` | 手动保存。body 严格为 `{ slug,type,description,content,stains? }`；gateway 补 scope/manual source 后进入队列。成功 201 `{ memory }`；slug 已存在 → 409 `conflict`，`error.details={ reason:"slug_exists", current:{ memory:<summary> } }`；非法/未知字段 → 400 |
| GET | `/api/agents/:agentId/memory/:slug` | 取完整 `{ memory:{ slug,type,description,scope,status,stains,sources,createdAt,updatedAt,version,content } }`；不存在 → 404；文件存在但非法 → 422 |
| PATCH | `/api/agents/:agentId/memory/:slug` | body 严格为 `{ type?,description?,status?,content?,stains?,ifMatch }`，`ifMatch` 必填；slug/newSlug/sources/未知字段均 400。成功 200 `{ memory }`；版本不符 → 409，`error.details={ reason:"version_mismatch", current:{ memory:<完整权威版本> } }` |
| PUT | `/api/agents/:agentId/memory/:slug/pin` | owner signal；body严格为`{pinned:boolean}`，返回`{pin:{slug,pinned,pinnedAt?}}`。不改markdown或Memory version，不对Agent MCP开放 |
| DELETE | `/api/agents/:agentId/memory/:slug?ifMatch=<version>` | 不可逆，前端二次确认；`ifMatch` 必填并走同一版本冲突形状。成功 204；不存在 404。删除后的历史 prompt 快照不追溯修改 |

## 四、SSE 事件流

### 通道

```
GET /api/events            # 全局唯一流，Accept: text/event-stream
GET /api/events?since=<seq>  # 断线重连，从 seq 之后重放
```

单一全局流、事件自带 `spaceId` 路由信息——手机端经 Tailscale 私网 HTTPS 只维护一条长连接。

### 帧格式

每个事件一帧：

```
id: 1042
data: { "seq": 1042, "type": "message.delta", "ts": "…", "data": { … } }

```

- `seq` 单调递增，gateway 维护环形缓冲（默认最近 2000 条）。
- `seq` **跨重启单调**：gateway 持久化 seq 水位，重启后从"水位 + 缓冲长度"跳跃续增。因此客户端带重启前的 `since` 重连必然落入缺口 → 收到 `stream.reset` → 重新 bootstrap，不会静默漏掉重启前后的事件。
- 重连时带 `?since=<最后收到的 seq>`（或标准 `Last-Event-ID` 头，两者等价）；缓冲已滚过 → gateway 发 `stream.reset`，客户端丢弃本地状态、重走 `/api/bootstrap`。

### 事件类型

| type | data | 说明 |
|---|---|---|
| `message.created` | `{ message }` | 新消息记录。用户消息即时；Account回复**每个气泡各发一次**（run内多次） |
| `message.delta` | `{ messageId, spaceId, spaceSessionId, delta }` | 当前气泡的流式增量，客户端只追加到匹配的窗口 |
| `message.completed` | `{ message }` | 当前气泡定稿，content 为该气泡权威全文（客户端以此覆盖累积值） |
| `run.started` | `{ run }` | |
| `run.ended` | `{ run }` | status 为 completed/failed/cancelled；failed 时带 `error.code/message` |
| `activity.created` | `{ activity }` | 新时间线过程条目（思考链、工具执行开始…） |
| `activity.updated` | `{ activity }` | 同一条目状态/内容更新（工具 pending→completed 等） |
| `approval.requested` | `{ approval }` | 提权申请卡片入时间线，等待用户答复 |
| `approval.answered` | `{ approval }` | 已答复或过期（多端同步：手机答了，电脑上的卡片也变灰） |
| `agent.state.updated` | `{ agentState }` | `agentId/accountId/spaceId/status/detail/lastActiveAt` |
| `account.presence.updated` | `{ accountId, presence, lastSeenAt, activeAgentId }` | 当前哪个Agent代表Account在线；具体Run控制权仍看Execution租约 |
| `space.updated` / `agent.updated` / `account.upserted` | `{ space }` / `{ agent }` / `{ account }` | 配置变更广播；`account.upserted` 覆盖 account 创建与修改，前端按 `id` 合并联系人 |
| `file.created` | `{spaceId,file}` | owner Space上传完整提交后发布；`file`是安全投影，不含storage name、hash或路径 |
| `file.updated` | `{spaceId,file}` | owner修改`sharedSpaceIds`并提交version后发布；Files页按当前请求Space重新拉列表，不把事件本身当读取授权 |
| `file.deleted` | `{spaceId,fileId}` | owner删除二进制并提交墓碑后发布；聊天页把匹配附件标成deleted，Files页重新拉列表 |
| `space.deleted` | `{ spaceId }` | 已归档Space永久删除且Memory与store清理全部提交后发布；客户端移除活跃与归档投影 |
| `space-session.archived` / `space-session.created` `[P5-C1]` | `{spaceId,spaceSession}` | `/new`的存储事务完整提交后才依次广播旧窗口归档与新active窗口；事件之间不存在可写的中间状态，归档窗口不会再产生写事件 |
| `agent-session.compaction.updated` `[P5-C1]` | `{spaceId,spaceSessionId,jobId,agentSession:{id,agentId,generation,context,status}}` | 自动或手动compact进度/结果；不含checkpoint、history或provider binding |
| `agent-session.compact.requested` `[P5-C1/Phase 5.5 daemon-only]` | `{jobId,target:{agentId,agentSessionId,fromGeneration,mode},account,input}` | 只发给目标daemon。`mode`为`native/checkpoint_new_binding/gateway_history`；native input只含当前安全CLI binding，后两者只含gateway裁剪的compaction source与checkpoint schema。daemon以专用result端点回报，不生成聊天delta/Message |
| `agent.heartbeat` `[Phase 5.5]` | `{ ts }` | gateway 每 15s（`agentDaemon.heartbeatIntervalMs`）在 daemon SSE 通道发的存活信号；daemon 连续 3 次未收到即 `exit(0)` 防止反复撞网关烧 token |
| `run.requested` `[Phase 5.5]` | 公共外壳`{run,triggerMessage,agent,account,workspace,input}`；CLI `input={kind:"cli",sessionMode:"main"|"isolated",promptText,providerBinding?}`，API `input={kind:"api",sessionMode:"main"|"isolated",messages,historyVersion?}` | main Run冻结owner `agentId/accountId/effectiveModel/spaceSessionId/agentSessionId/contextGeneration/runtimeRevision`且`delegated:false`；isolated subagent的session字段为null且不带持久binding/historyVersion。CLI只续当前generation绑定；API messages由gateway按容量裁好，daemon不得另存canonical history或回头读store。两种input互斥 |
| `stream.reset` | `{}` | 客户端必须重新 bootstrap |

**一次 agent 回复的完整事件序列示例**（思考链、工具执行与气泡按实际发生时间穿插，前端照事件顺序排时间线即可）：

```
run.started
activity.created   (thinking：开始想)
message.created    (气泡1, streaming)
message.delta ×N   (气泡1)
message.completed  (气泡1)
activity.created   (tool: bash npm test, pending)
activity.updated   (tool: completed，带输出摘要)
approval.requested (要 rm -rf ./dist，等用户点按钮)
approval.answered  (allow)
message.created    (气泡2, streaming)
message.delta ×N   (气泡2)
message.completed  (气泡2)
run.ended          (completed)
```

### 客户端义务

- 以 `message.completed` 的全文为准，delta 累积仅用于渲染中间态。
- 收到未知 `type` 必须静默忽略（向前兼容）。
- 断连后指数退避重连，携带 `since`。

## 五、与 Tailscale Serve 私网入口的兼容性约束

- SSE 响应必须逐帧 flush，不得依赖缓冲；Tailscale Serve 到回环 gateway 的转发必须实测逐帧到达，见 `reference/vps-tunnel-deploy.md`。
- gateway 每 25s 发 SSE 注释帧 `: ping` 保活，防止中间层超时断连。
- gateway 只监听 `127.0.0.1:3210`，唯一生产入口是 Tailscale Serve；不得同时启用 Funnel、公网反向代理或公网端口映射。
- gateway 只信任来自本机 Serve 代理的 Tailscale identity headers；直接从客户端收到的同名头不得作为身份。普通 API 校验 owner login，agent API 校验 agent token。

## 六、页面接口矩阵 `[F1]`

> ground truth 5.1 页面清单逐页落地：每页声明「SSE 事件输入 / API 读取 / API 写入 / 空错态」。
> 此矩阵是 F2+ 前端实现的唯一接口闸门——任何 view 不得调用未在此列出的 endpoint，也不得在此列出但后端未实现的 endpoint 上构建可交互控件（不得做假控件）。
> 标 `[P5]` / `[P5.5]` / `[Phase 6]` 的项当前阶段不实现，但形状在此钉死。

### App Shell（全局，无路由）

- **SSE 事件输入**：`stream.reset`（重连后丢弃本地状态、重走 `/api/bootstrap`）；`account.presence.updated`（顶栏在线指示）；`agent.state.updated`（顶栏省略，仅在当前 Space 内消费）。
- **API 读取**：`GET /api/bootstrap`（启动 / `stream.reset` 后）；`GET /api/settings`（顶栏主题色 / Appearance token loader 初始化；F2 起前置）。
- **API 写入**：无（Shell 不持有写流程；用户写操作都进具体 view）。
- **空错态**：bootstrap 失败 → 顶栏显示「断开」+ 重试按钮；SSE 长断连 → 同上；`/api/settings` 失败 → token loader 回落 config 默认（不阻塞 Shell 渲染）；离线（navigator.offline）→ 顶栏「离线」标记。

### 全屏聊天主页 `#/spaces/:spaceId`

- **SSE 事件输入**：既有Message/Activity/Approval/Run事件必须同时匹配当前`spaceSessionId`；新增`space-session.archived`、`space-session.created`切换active窗口，`agent-session.compaction.updated`刷新per-Agent generation/压力与手动job结果。`file.deleted`命中当前时间线附件时把链接标成deleted；`file.updated`不直接扩大本地授权，必要时重取时间线。归档历史页不消费写事件。
- **API 读取**：`GET /api/bootstrap`（首屏）；`GET /api/spaces/:id/timeline?before=&limit=50`（向上翻页加载更早历史）。
- **API 写入**：普通正文/附件引用走`POST /api/spaces/:id/messages`；composer先通过Files上传端点取得File id，再随Message提交。精确`/compact`与`/new`分别走`POST .../session/_compact`与`POST .../session/_new`，不落Message；取消Run和Approval回答沿用既有端点。
- **空错态**：Space 不存在（404）→ 主区显示「Space 不存在或已归档」+ 返回导航入口；时间线空 → 「还没有消息，发一条开始」；时间线长 → DOM 上限 200 items，更早走 `?before=` 分页；approval 失效（409）→ 卡片灰化；发送失败（4xx/5xx）→ composer 内联错误 + 保留草稿；SSE 断连 → 时间线冻结 + 顶部「重连中」；已归档 Space 通过此路由进入 → 消息发送返回 409，主区显示「已归档，去设置恢复」入口。

### SpaceSession历史 `#/spaces/:spaceId/history`、`#/spaces/:spaceId/history/:spaceSessionId` `[P5-C1]`

- **API读取**：`GET /api/spaces/:id/sessions?status=archived`与指定Session timeline；只读分页。
- **API写入**：无。归档SpaceSession不提供restore、composer、Run、compact或编辑。
- **空错态**：无归档窗口显示“还没有历史对话”；当前SpaceSession不得混入归档列表。

### Space Files `#/spaces/:spaceId/files` `[P5-F1]`

- **SSE事件输入**：`file.created/updated/deleted`与`space.deleted`；事件只触发按当前Space重拉列表，不能绕过读取策略直接把事件里的File插入页面。
- **API读取**：`GET /api/spaces/:id/files`；用户展开详情时`GET .../:fileId`，下载使用`GET .../:fileId/download`。页面可复用bootstrap中的Space列表显示owner与共享目标名称，不额外创建Files专用Space目录。
- **API写入**：上传、owner共享列表PATCH、owner DELETE沿Files端点。上传按钮复用platform `pickFile`；Web是受限`<input type=file>`，原生能力未实现时明确显示unsupported。
- **空错态**：Space不存在→整页“Space不存在”并返回；列表空→“这个Space还没有附件”；共享进来的File明确标“来自X，只读”；上传中显示逐文件状态且中断后重新拉列表确认无脏记录；413/415/422显示稳定原因；SSE断连时冻结列表并显示“重连中”；已归档Space可读/下载但禁用上传、共享修改与删除。

### Space导航 `#/spaces`（右滑 / 顶栏开关 / 打开期间常驻）

- **SSE 事件输入**：`space.updated`、`account.upserted`与`account.presence.updated`；Agent更新不改变联系人身份。
- **API 读取**：`GET /api/bootstrap`，按Account seats派生左栏联系人和右栏Space列表。
- **API 写入**：`POST /api/spaces`（新增；body 继承当前左栏选中成员集合作为 seats）；`PATCH /api/spaces/:id`（重命名 / topic / seats / notifications）；`POST /api/spaces/:id/archive`（二次确认后归档，归档成功后切换到另一活跃 Space）；`POST /api/spaces/:id/restore`（从「已归档」分段恢复）；`GET /api/spaces/:id/deletion-preview`后`DELETE /api/spaces/:id`永久删除。
- **空错态**：无 Space → 左栏联系人可点但右栏空 + 「新建 Space」CTA；左栏无选中 → 右栏显示「选一个联系人或群组」，同时禁用新建入口；归档失败（409 有未结束 Run）→ toast「有进行中的对话，等结束或取消后再归档」；新增失败 → 内联错误；归档二次确认 → 弹层 only（不替换主区）。已归档Space显示恢复与删除；删除弹层必须显示Message与Memory影响计数，并提供默认不勾选的“同时删除全部来源均属于该Space的Memory”，确认按钮明确写“永久删除”；删除失败保留归档记录并内联报错。

### 当前Space设置 `#/spaces/:spaceId/settings`

- **SSE 事件输入**：`space.updated/account.upserted/account.presence.updated`。
- **API 读取**：`GET /api/bootstrap`组合参与Account与seats；页面提供进入`#/spaces/:spaceId/files`的普通导航链接，不在设置页预取File列表。Phase 6前不读取或显示Space Module，契约落地后再读取独立binding API。
- **API 写入**：`PATCH /api/spaces/:id`一次提交`seats/notifications/name/topic`；Seat字段为`accountId/responseMode/respondTo/blockAccountIds`。
- **空错态**：Space不存在→整页“Space不存在”并返回；历史/异常记录无seats→“还没有Account参与”并允许选择至少一个Account修复，保存时不得仍为空；保存失败→字段级错误回显，不整页崩溃；Phase 6契约落地前不显示Space Module区；离开未保存改动→浏览器原生confirm。

### Setting目录 `#/settings`

- **SSE 事件输入**：无（不订阅；进页拉一次即可）。
- **API 读取**：无（不预取子页数据；只渲染当前已有的静态平铺入口）。
- **API 写入**：无。
- **空错态**：纯静态页；未到阶段或没有真实契约的入口不显示。Phase 6 契约与页面落地后，再加入真实的 Extension Packages 入口。

### Appearance `#/settings/appearance`

- **SSE 事件输入**：无（外观是本地预览 + 保存，不订阅事件）。
- **API 读取**：`GET /api/settings`（初始外观字段）；`GET /api/themes`（Theme 列表摘要，进页时拉一次）；`GET /api/themes/:id`（选中某 Theme 预览时按需拉取完整对象）。
- **API 写入**：`PATCH /api/settings`（保存外观字段；按组恢复默认对该组已知 key 一次 PATCH `null`）；`POST /api/themes/import`（导入预览，不持久化）；`POST /api/themes`（确认保存归一化 Theme）；`PATCH /api/themes/:id`（重命名 / 编辑 colors/terminal）；`DELETE /api/themes/:id`（被 `appearance.themeId` 引用时 409）；`GET /api/themes/:id/export?format=vera-json|vera-css`（导出 Theme Palette）；`GET /api/settings/appearance-profile/export`（导出非 Theme 的 Appearance Profile）；`POST /api/settings/appearance-profile/import`（预览 Appearance Profile，不保存，确认后仍 PATCH `/api/settings`）。
- **空错态**：settings 加载失败 → 回落 config 默认 + 顶部「无法读取已保存配置，展示默认值」；Theme 列表空 → 「还没有保存的 Theme，导入一份试试」；导入失败 → 预览区显示 `warnings` + 不写入；导出失败 → toast；预览只改内存 CSS 变量，刷新或离页未保存 → 丢弃；实时预览与「已保存」之间须有明确视觉区分（按钮态 / 标记）。

### Account系统管理 `#/settings/accounts`、`#/settings/accounts/:accountId`

- **SSE事件输入**：`account.upserted/account.presence.updated/agent.updated`，用于所属/当前Agent摘要。
- **API读取**：Account列表与`GET /api/accounts/:accountId`详情；当前active Space成员关系直接使用App Shell已持有的`/api/bootstrap` Space安全摘要按Seat派生，不为Account详情复制第二份Space成员接口。
- **API写入**：`POST /api/accounts`新建、PATCH名称、Key轮换、DELETE。页面不提供新建空Agent、owner改绑、provider/model表单或“添加连接”。
- **页面流程**：新建Account后立即显示一次性接入Key；首次接入原子创建并显示固定owner Agent。此后该Key只与owner Agent token组合登录；详情页按`GET /api/accounts/:accountId`显示所属Agent、当前Agent、Workspace安全摘要与最近20条登录审计，并从共享bootstrap投影当前active Space成员关系；不提供代上线或接管入口。
- **空错态**：无Account→“新建Account”；首次owner尚未接入→“等待所属Agent使用Key完成接入”；离线保留所属Agent；Key明文关闭后不可再次读取，只能轮换。

### Agent使用管理 `#/agents`、`#/agents/:agentId`

- **入口与顺序**：Account详情中的所属/当前Agent及消息模型名可进入`#/agents/:agentId`；Account头像不进入Agent页。
- **页面结构**：上半部分展示当前Agent像素形象，左右两侧提供上一位/下一位箭头；下半部分展示Agent当前状态、当前代表的Account/Space会话及Skills / Hooks / MCP / Data四个平级入口。现阶段像素形象复用现有Agent视觉投影，不新增Avatar或Contact持久字段；未来若允许编辑必须先扩展Agent契约。
- **SSE事件输入**：`agent.updated/agent.state.updated/account.presence.updated`；可显示该Agent当前代表哪个Account。
- **API读取**：Agent安全摘要、runtime profile、当前Account会话与AgentState；不读取Account Key或其他Agent Memory。
- **能力与Data目录 `[P5前端与内置binding；Phase 5.5/6通用runtime]`**：四入口分别进入`#/agents/:agentId/skills|hooks|mcp|data`。Hooks默认内置无执行Agent/模型的Recall/Write；MCP默认内置`vera.memory`，只显示启用状态、可用性与工具清单，不出现semantic Agent或模型。Agent Plugin不作为第五入口且不混入四目录。Digest/Dream配置只在Data → Memory。
- **首轮前端接口**：Skills / Hooks / MCP复用上文标准化目录投影和同一个无HTTP view；顶栏右侧固定“添加”“管理”。首轮纯前端交付验收两个入口、分页、路由、Shell动作槽、空态、loading/error和夹具列表行，生产Skills为空且所有未接通动作disabled。该交付通过后，Hooks/MCP controller才读取/修改`unit-bindings`；Skills继续为空，直到真实Skill接口完成。Data目录当前只列Memory并按需进入子路由，不使用unit binding。
- **空错态**：无Agent→提示“尚无Agent接入，请先新建Account并生成接入Key”；指定Agent不存在→返回Account管理。

### Agent Data → Memory `#/agents/:agentId/data/memory` `[P5-M4]`

- **SSE事件输入**：`memory.digest-job.updated`与`memory.dream-job.updated`；只按当前`agentId`刷新安全job摘要和`GET .../memory/_status`，不通过SSE传正文、proposal或配置。
- **API读取**：`GET /api/agents/:agentId/memory/_config`、`GET .../_options`、`GET .../_status`；长期Memory摘要只在用户进入管理页时另取，不随本页首屏预取正文。
- **API写入**：`PATCH .../memory/_config`保存Memory结构及Digest/Dream各自的executor/model/trigger|schedule；手动Digest必须从`_status.pendingContext.spaces`选择一个明确范围并走`POST .../_digest`，立即Dream走`POST .../_dream`。本页不读取、不显示、不修改Recall/Write binding。
- **空错态**：只有内置Provider时显示`Vera（兼容 Obsidian）`，不渲染“自定义”假选项；位置只读并跳受控路径页；长期Memory显示条数/逻辑大小/token估算，待整理内容显示Message/字符/token与per-SpaceSession当前上下文压力，明确标注估算质量。Provider/executor/model不可用时原样显示已保存选择和通用警告、禁止新job且不fallback；手动Digest无待整理范围时disabled，多个范围时不默认合并或猜选；在途Dream合并重复点击。

### Agent Memory管理 `#/agents/:agentId/data/memory/library`

- **SSE 事件输入**：无（Memory 编辑是请求-响应，不订阅实时事件）。
- **API 读取**：若active Provider支持`list/fetch`，使用`GET /api/agents/:agentId/memory`与`GET .../:slug`按需读取；默认`vera.markdown`返回索引、坏文件errors与权威正文。
- **API 写入**：按active Provider的`create/update/delete` capabilities启用对应`POST/PATCH/DELETE`；默认`vera.markdown`沿用slug、ifMatch与per-Agent单写队列。Provider不支持的动作禁用并返回`memory_provider_unsupported`，不得伪造成功。
- **空错态**：agent 不存在（404）→ 返回Agent使用管理默认入口`#/agents` + toast；vault 子目录不存在 / 空 → 「这个 Agent 还没有记忆，用一次就慢慢攒起来了」+ 「手动保存一条」CTA；slug 不存在（404）→ 返回列表 + toast；列表含坏文件 → 正常展示其余 Memory 并提示 errors；编辑/删除冲突 → 使用加载时的 `version` 做 `ifMatch`，409 的 `details.current.memory` 用于重载，前端提示「这条刚被 agent 改过，请重新加载」；删除二次确认 → 弹层。

### Extension管理 `#/settings/extensions` `[Phase 6]`

- **SSE 事件输入**：`[Phase 6]` 待定（extension.install / uninstall / permission.request 等事件）。
- **API 读取**：`[Phase 6]` `GET /api/extensions`（已安装 Extension Package 摘要列表）。
- **API 写入**：`[Phase 6]` `POST /api/extensions/install` / `DELETE /api/extensions/:id` / `PATCH /api/extensions/:id/permissions` 等。
- **空错态**：当前阶段（F1–F5）整页显示「`[Phase 6]` Extension 体系尚未开放」，不渲染任何假按钮或假列表。

### 路径管理 `#/settings/paths`

- **SSE 事件输入**：无。
- **API 读取**：`GET /api/paths`（返回gateway placement Memory vault、Files附件根的当前值/存在/计数/大小，以及`gateway.dataPath`当前值与大小估算；daemon/remote Provider从Agent Memory状态读取，env-only参数如port/SSE心跳不在本接口）。
- **API 写入**：`POST /api/paths/validate`与`POST /api/paths/migrate`支持gateway宿主的`memory.vaultPath`、`files.attachmentsPath`与`gateway.dataPath`。daemon placement迁移走对应Provider/daemon接口，不把远端路径交给gateway本机文件API。Files迁移走「校验空目标→排空在途上传→搬移owner目录→逐File size/hash验证→写override→热切换」；失败恢复设置与已搬目录。gateway dataPath仍需重启。
- **空错态**：路径校验失败 → 字段下方红字 + 不允许进入migrate；migrate失败 → toast显示错误 + 路径不动；gateway.dataPath成功后提示重启；Memory与Files热迁移成功后立即重读摘要，不需要重启。

### 中控台 `#/settings/control-center`

- **SSE 事件输入**：无（中控台是轮询，不订阅；离开页面立即停止 poller）。
- **API 读取**：`GET /api/status`（gateway/SSE/store、gateway placement vault、daemon与各Agent Provider placement状态摘要 + 最近错误；字段清单见章节八；进页时取一次，之后5s轮询，离页清理）。
- **API 写入**：无（中控台只读；任何「重启 / 清理」操作走专门接口或运维，不在本页提供按钮）。
- **空错态**：`/api/status`失败→「gateway不可达」+重试；store显示当前file store状态，不虚构数据库连接；gateway placement vault不存在→跳`#/settings/paths`，daemon placement Provider不可达→显示对应Agent与hostId的`memory_provider_unavailable`而不跳本机路径页；无daemon在线→「当前没有agent daemon连接」（联邦形态Phase 5.5落地后才有presence数据；当前阶段显示「联邦形态未启用」而非假数据）。

### 系统设置 `#/settings/system`

- **SSE 事件输入**：无（系统设置是表单 + 保存，不订阅实时事件）。
- **API 读取**：`GET /api/settings`（加载系统字段当前合并视图：`isolation.*` / `memory.*` / `presentation.*`）。
- **API 写入**：`PATCH /api/settings`（部分字段覆盖；按组恢复默认对该组已知 key 一次 PATCH `null`）。
- **空错态**：settings 加载失败 → 表单回落默认值 + 顶部错误条；保存失败（400 invalid_request）→ 字段级错误回显；保存失败（5xx）→ toast + 保留改动；未保存离页 → 浏览器原生 confirm。

## 七、Path 管理与受控迁移 API `[P4.6/F1]`

ground truth 4.1 末段把可配置路径分两类：用户数据位置（Memory Provider placement及其宿主本地vault、Account Workspace绑定、Files/附件路径）与gateway数据目录。`/api/paths`只管理gateway宿主能直接校验和迁移的路径；daemon宿主上的Memory与Workspace路径由对应daemon报告并在各自资源API中受控迁移，gateway不得把远端绝对路径当作本机路径操作。gateway数据目录等影响事实来源的高风险路径必须走「校验 → 迁移 → 验证 → 回滚」独立流程。端口、SSE心跳/缓冲、store落盘节流、daemon回收、run看门狗仍走env，不进本接口。

### 字段清单

| key | 作用 | 当前可编辑 | 风险等级 |
|---|---|---|---|
| `memory.vaultPath` | gateway placement的`vera.markdown` vault根目录；不代表daemon宿主vault | 是 | 普通（仅markdown文件，失败不危及gateway其他事实来源） |
| `gateway.dataPath` | gateway 持久化数据根目录 | 是（仅 migrate，无直接文本框） | 高（含agents/spaces/SpaceSessions/AgentSessions/messages/runs全部事实来源） |
| `accounts.*.workspace` `[P5.5]` | per-Account Workspace 绑定（`hostId/path/status/policy`）；实际文件在 daemon 宿主 | 否（daemon 报告，gateway 校验并存绑定） | 普通 |
| `files.attachmentsPath` `[P5-F1]` | Space附件二进制存储根 | 是 | 普通（元数据仍在gateway store，迁移需逐文件验证） |

### 端点

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/paths` | 返回gateway宿主路径摘要：`{paths:{memory:{placement:"gateway",vaultPath,exists,memoryCount,legacyUnscopedCount},files:{attachmentsPath,exists,activeCount,sizeBytes},gateway:{dataPath,sizeBytes,restartRequired:false}}}`。`memoryCount`只统计当前绑定到gateway placement的`<agentId>/`子目录；daemon/remote Provider状态从Agent Memory `_status`读取。Files计数只含未删除File，大小按权威元数据汇总并可与磁盘校验。**不返回**远端宿主绝对路径或port/SSE/store节流等env配置。 |
| POST | `/api/paths/validate` | body `{ key, value }`，`key` ∈ `memory.vaultPath` / `files.attachmentsPath` / `gateway.dataPath`；`value`为路径字符串并规范化为绝对路径。返回 `{ok,errors,warnings,normalized}`，不写盘。公共校验：可写/可创建、不在仓库工作树、源目标不互相包含、目标不是符号链接；Files目标必须为空，且磁盘空间≥当前active附件逻辑字节；gateway目标只允许已识别store文件。 |
| POST | `/api/paths/migrate` | body `{ key, target }`；migrate 是 validate + 实际搬移 + 改 config override 的合动作。返回 `{ ok, key, from, to, restartRequired }`。失败时路径不动（已搬移的部分回滚），返回 400/409 + `{ errors }`。 |

**migrate 各 key 行为**：

- `memory.vaultPath`：
  1. 只选择active placement为`gateway`的`vera.markdown` Agent目录；daemon/remote placement不得进入本流程 → 2. 检查根目录未归属`*.md`（存在则409）→ 3. validate target → 4. `mkdir -p target` → 5. 把选中Agent子目录整体移到target（保留`<agentId>/`结构）→ 6. 验证目录数与文件数一致 → 7. `PATCH /api/settings`写`paths.memoryVaultPath = target` override并等待落盘 → 8. gateway热替换本机Provider执行器的vaultPath → 9. 返回`{restartRequired:false}`。原vault目录留空不删（用户自行清理）。失败任一步回滚setting override与已搬目录。daemon placement的vault迁移由对应daemon执行同等级校验、排空、验证与原子换绑，不能复用本端点假装远程文件是本地文件。
- `.vera-index/`是可重建派生缓存，不属于vault迁移的用户数据；上一步“所有agent子目录”只匹配合法`<agentId>/`，不得复制`.vera-index/`。切换后在新vault从权威Markdown全量重建普通索引和embedding sidecar；旧sidecar不得继续标current。
- `files.attachmentsPath`：
  1. 取得Files领域排他锁并等待在途上传/删除结束 → 2. validate空目标 → 3. 搬移当前根下gateway生成的`<ownerSpaceId>/`目录，未知项导致409而不是顺手移动 → 4. 逐条读取未删除File元数据，在target中验证普通文件、size与sha256，任一缺失/符号链接/不一致都失败 → 5. 写`paths.filesAttachmentsPath` override并flush → 6. Files服务热`reopen`到target → 7. 返回`restartRequired:false`。失败时恢复override、服务根与所有已搬目录；旧根留空不删。
- `gateway.dataPath`：
  1. validate target → 2. 复制当前 dataPath 全部内容到 target（rsync 等价，保留文件权限）→ 3. 在 target 上启动一个临时 store loader 试加载（只读模式，确认无损坏）→ 4. 通过后，`PATCH /api/settings` 写 `paths.gateway.dataPath = target` override——**注意 override 写入的是当前运行中的 settingsStore（仍在旧 dataPath）**，旧 dataPath 的 `settings.json` 因此获得 `paths.gateway.dataPath = target` override → 5. 旧 dataPath 不动（保留作回滚锚点），返回 `{ restartRequired: true }`。**gateway 实际切换到 target 在下次重启后生效**：server.js 启动时先从 env 默认 dataPath 读 `settings.json`，发现 `paths.gateway.dataPath` override → 用 override 路径建 store（见下「启动顺序」）。
- **回滚**：migrate 失败任一步：已复制到 target 的内容删除；settings.json 不写 override；旧路径不动。重启后若 store 在新 path 加载失败 → gateway 启动报错（不做静默回滚——dataPath 是事实来源，路径错误必须响亮失败让用户介入）。

**gateway.dataPath 启动顺序**（server.js boot，F1 修订）：
1. `loadConfig(env)` → 得到 env 默认 `config.dataPath`（如 `./data` 或 `VERA_DATA_PATH`）
2. **先读 `<config.dataPath>/settings.json`** 中的 `paths.gateway.dataPath` override（一次性轻量读，不走完整 settingsStore 构造）
3. 若 override 存在且指向不同路径 → **将 `config.dataPath` 替换为 override 值**，后续 store / settingsStore / memory 全部用新路径
4. 若 override 不存在或读取失败 → 用 env 默认 `config.dataPath`（当前行为不变）
5. 同理读`paths.memoryVaultPath`与`paths.filesAttachmentsPath` override，分别替换gateway宿主`config.memory.vaultPath`与`config.files.attachmentsPath`；daemon宿主配置不从gateway本机settings读取

这一步消除「settings 在 dataPath 内」的 chicken-and-egg：启动只做一次轻量 JSON 读（不是完整 settingsStore），拿到 override 后再用真实路径建 store / settingsStore。

**字段新增到 settings 白名单**：`paths.memoryVaultPath`、`paths.filesAttachmentsPath`、`paths.gateway.dataPath`（均为string）。三个key都支持`null`恢复config默认（env分别为`VERA_MEMORY_VAULT_PATH`、`VERA_FILES_ATTACHMENTS_PATH`、`VERA_DATA_PATH`）。清除override不自动把已经迁移的数据搬回旧根。

### 持久化

`paths.*`与`appearance.*`/系统字段一样落`<dataPath>/settings.json` override；consumer是server.js boot时读settings override决定gateway宿主实际dataPath/vaultPath/attachmentsPath。这里的Memory迁移只作用于gateway placement，Files迁移在当前进程热切换；gateway.dataPath仍在下次重启切换。daemon宿主路径及其迁移结果属于对应runtime/Provider binding，不写成gateway本机路径override。

## 八、中控台 Status API `[P4.6/F1]`

中控台只读，字段严格按当前真实可观测的状态，**不虚构未来的数据库连接或联邦 presence 数据**。

### 端点

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/status` | 200 `{ status: {...} }`。无查询参数。 |

### 字段清单

```json
{
  "status": {
    "gateway": {
      "version": "0.0.1",
      "pid": 12345,
      "startedAt": "…",
      "uptimeMs": 123456,
      "dataPath": "/…/data",
      "dataPathRollbackPending": false
    },
    "sse": {
      "currentSeq": 1042,
      "bufferSize": 2000,
      "connectedClients": 1
    },
    "store": {
      "kind": "file",
      "collections": { "agents": 2, "accounts": 2, "spaces": 1, "messages": 47, "activities": 12, "approvals": 3, "runs": 8 },
      "spaceSessions": 4,
      "agentSessions": 6,
      "themesCount": 0,
      "lastFlushAt": "…"
    },
    "memory": {
      "placement": "gateway",
      "vaultPath": "/…/memory",
      "vaultExists": true,
      "memoryCount": 5,
      "legacyUnscopedCount": 0,
      "providers": [
        { "agentId": "agt_cli", "providerId": "vera.markdown", "placement": { "runtime": "daemon", "hostId": "host_large_vps" }, "state": "available" },
        { "agentId": "agt_api", "providerId": "vera.markdown", "placement": { "runtime": "gateway" }, "state": "available" }
      ]
    },
    "agents": {
      "federation": "disabled",
      "onlineAccounts": 0,
      "accounts": [{ "accountId": "acc_…", "agentId": "agt_…", "presence": "offline", "lastSeenAt": null }]
    },
    "recentErrors": [
      { "ts": "…", "scope": "adapter", "code": "adapter_unavailable", "message": "…" }
    ]
  }
}
```

- `gateway.version` 来自 package.json；`startedAt` / `uptimeMs` 进程启动时记一次；`dataPath` 同 `/api/paths` 返回值；`dataPathRollbackPending` 见章节七回滚段。
- `sse.connectedClients` 是 hub 当前活跃 SSE 连接数；`currentSeq` 同 `hub.currentSeq()`。
- `store.kind` 永远是 `"file"`（Phase 5 前）；`collections` 是各 JSON 文件 `data[name].length`，无坏文件容错掉的不计；`lastFlushAt` 是最近一次 doFlush 完成 ISO 时间。
- `memory.vaultPath/vaultExists/memoryCount/legacyUnscopedCount`只描述gateway placement的本机vault，与`/api/paths`的memory字段一致；daemon/remote Provider不计入该`memoryCount`。
- `memory.providers`按Agent列active Provider的安全placement与可用性，不返回绝对路径、connection或secret；宿主不可达时保留绑定并显示`unavailable`，不回退gateway vault。
- `agents.federation` 当前阶段固定 `"disabled"`（联邦 Phase 5.5 落地后改 `"enabled"`）；`onlineAccounts` 当前阶段固定 `0`；`accounts` 列出每条 account 的 presence/lastSeenAt（当前阶段 presence 全 `"offline"`、lastSeenAt 全 `null`）。
- `recentErrors` 是进程内环形缓冲（默认 20 条），收集 `ApiError` 抛出与 adapter / store / memory 模块的告警；超过 N 条滚动覆盖。只读，无写入端点。

## 九、客户端 platform adapter 接口 `[P4.6/F1]`

三端共享同一份 `frontend/src` 业务代码；平台差异只允许通过统一 platform adapter 调用。adapter 必须明确返回 `unsupported` 而非静默失效。Web fallback 在契约中可表达，原生壳在 F2/F3 阶段不实现，但 F1 必须钉接口形状。

### 接口形状（`src/state/platform.js`）

```js
{
  id: "web" | "android" | "ios",
  // gateway URL：Web 由同源伺服（location.origin）；原生壳从 secureStorage 读用户配置
  async getGatewayUrl(): string,
  async setGatewayUrl(url): void | unsupported,
  // fetch 与 SSE：Web 直接用 window.fetch + EventSource；原生壳用原生 http + 长连接
  fetch(url, init): Promise<Response>,
  createEventSource(url, opts): EventSource,
  // 安全存储：Tailscale设备身份由系统Tailscale客户端持有，Vera不复制；本接口只供其他原生secret，localStorage仍只允许未提交预览
  secureStorage: {
    async get(key): string | null,
    async set(key, value): void,
    async remove(key): void,
  },
  // 通知：ground truth 4.2.6 / Space.notifications 消费
  notifications: {
    async requestPermission(): "granted" | "denied" | "unsupported",
    async notify({ title, body, spaceId, messageId }): "shown" | "unsupported",
  },
  // 文件选择：source是平台私有且只在当前进程使用的上传源；不得持久化或进API JSON
  async pickFile({ accept? }): { name, mime, size, source } | unsupported,
  async pickDirectory(): { path } | unsupported,
  // 键盘 / 返回：原生壳决定是否拦截
  keyboard: { insets: { bottom, top }, onInsetChange(cb): unsubscribe },
  backButton: { onBack(cb): unsubscribe, consume(): void },
  haptics: { async tap(mode): void | unsupported, async notify(type): void | unsupported },
  // 外部认证 / 链接：Vera自身依赖系统Tailscale身份；第三方外部认证仍用系统浏览器回跳
  externalAuth: {
    async open(url, opts?): { redirected: url } | unsupported,
    onRedirect(cb): unsubscribe,
  },
  externalLink: { async open(url): "opened" | "unsupported" },
}
```

每个方法在缺失能力时返回 `{ unsupported: true }` 或抛 `UnsupportedError`，业务调用方必须显式检查，不静默 fallback 到 Web 行为——若需 fallback，在调用点显式声明。

### Web fallback 形状

Web 实现位于 `src/platform/web.js`，对原生能力返回 `unsupported`：
- `notifications.notify` → Web Notification API（permission denied 时返 `unsupported`）
- `pickFile` → 受限`<input type="file">`，返回`source: File`供同源fetch原始body使用；取消时返`unsupported`。`pickDirectory`继续使用`showDirectoryPicker()`
- `haptics` → 返 `unsupported`
- `keyboard.insets` → 始终 `{ bottom: 0, top: 0 }`（视口尺寸变化由 viewport meta 处理）
- `backButton` → Web 用 `popstate`；`consume()` 调 `history.back()`
- `externalAuth.open` → Web 直接 `window.location` 跳转第三方认证页；`onRedirect` 用 `window` 的 `hashchange` / `popstate`。Vera 自身不走此接口登录
- `secureStorage` → Web 用 `localStorage`，仅限未提交预览（ground truth 4.4），不存已确认配置

### 原生壳认证路径（Tailscale 纯私网 / CORS / SSE）

- **前置条件**：手机先安装/启用 Tailscale 并加入与 VPS 相同的 tailnet；“不走 VPN”只表示不同时运行 v2rayNG 等其他 VPN。Vera 不负责登录 Tailscale，也不内嵌 tailnet auth key。
- **gateway URL**：原生壳不内置固定 URL/IP/tailnet 名；首启弹“配置 gateway URL”视图，用户输入 VPS 的 `https://<machine>.<tailnet>.ts.net`。保存后调用 `/api/health`；不可达时明确提示检查 Tailscale，而不是尝试公网 fallback。Web 由 `location.origin` 派生。
- **Owner 身份**：请求经 Tailscale Serve 后由 gateway校验可信 identity login是否属于 `config.security.ownerTailscaleLogins`；Vera App不保存第二份owner token。设备撤销在tailnet管理台完成。
- **公网分流**：手机不得启用 Vera VPS 作为 Exit Node。只有 tailnet目标走Tailscale，其他App继续使用Wi-Fi/蜂窝公网；Android如遇个别应用识别VPN，可在Tailscale客户端中排除该应用，但Vera必须保留在Tailscale路径。
- **CORS**：Web同源伺服天然无CORS；原生壳跨域时gateway只回显`config.security.cors.allowedOrigins`中的精确Origin，并加`Vary: Origin`，禁止`Access-Control-Allow-Origin: *`。允许方法为`GET,POST,PATCH,DELETE,OPTIONS`，允许头为`Authorization,Content-Type,Last-Event-ID`，预检`OPTIONS`返回204。
- **SSE 长连接**：原生壳使用原生HTTP长连接，断线重连带`Last-Event-ID`并按`?since=`重放；蜂窝/Wi-Fi切换、锁屏恢复和Tailscale重连必须真机验收。

### 根节点标记与 safe-area

- HTML 根节点设置 `data-platform="web|android|ios"`（由 platform adapter 根据自身 `id` 在 boot 时写入），CSS 通过 `[data-platform="…"]` 选择器做小范围平台适配，**不 fork 页面**。
- safe-area 由 CSS env 变量 `env(safe-area-inset-*)` + platform adapter 的 `keyboard.insets` 共同驱动，组件层只读 CSS 变量。
- 平台差异唯一允许的体现：安全区、键盘、返回手势、通知、文件选择、触感、外部认证/链接、本地安全存储。颜色、排版、页面职责、业务流程不分叉（ground truth 6.2）。
