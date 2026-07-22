# VPS 私网直接部署与后续引导适配

## 开始条件

[`federation-runtime.md`](federation-runtime.md) 已完成；本文件现为进行中。

## 阶段边界

- 当前唯一目标是完成我们自己的私网直接部署，让Vera以真实gateway、daemon、Workspace、Memory和客户端链路进入日常使用。
- 直接部署允许由Codex与User按已确认的主机事实逐步执行明确命令，不等待完整`npm run setup`、全新环境向导、从零tailnet引导或开源文案；不得为绕过向导而降低备份、secret、私网入口、逐步验证和可恢复性要求。
- 已实现的setup只读preflight、计划指纹、角色/路径校验与operation接口保留为可复用基础，但当前不继续扩展交互确认或通用apply编排。缺少向导能力不得被报告为自用部署阻塞项。
- 自用链路通过并实际投入使用后，再恢复开源友好的安装、幂等重跑、通用宿主适配和恢复体验；这些工作移到本文件最后的后置里程碑。

## 当前自用控制端约定

- 本机到当前Gateway VPS只使用SSH别名`vera-gateway`；HostName、端口与密钥选择只保存在本机`~/.ssh/config`，不得写入repo、部署摘要或对话命令。新窗口先用`ssh vera-gateway`做只读health与release核对，不从聊天历史还原连接参数。
- 前后端源码仍以本机repo为开发事实来源。UI与gateway改动先在本机完成、验证并提交，再把精确commit部署到Gateway的`/opt/vera/releases/<commit>`，原子切换`/opt/vera/current`并重启`vera-gateway.service`；不得在VPS release内直接编辑源码。
- 真实私网URL只用于发布后手机/Mac回归。前端问题先用当前真实Account/Agent链路复现，修复按commit成批发布，避免每改一处就SSH热改生产文件。

## 自用直接部署与投入使用

### 直接部署顺序

1. [~] 核对实际gateway、daemon、Workspace与Memory宿主、路径、稳定`hostId`、tailnet与owner login；可复用现有setup只读preflight，但以逐宿主复核后的事实为准。
2. [ ] 对将替换、迁移或停用的Vera数据、配置、service和旧公网链路完成可定位冷备份，并验证备份可读；未知或不属于Vera的对象保持不动。
3. [ ] 在选定VPS直接配置gateway数据路径与systemd service，使gateway只监听`127.0.0.1:3210`；逐项验证回环health、重启恢复和日志无secret。
4. [ ] 直接配置Tailscale Serve、ACL与精确owner login，验证私网HTTPS、owner身份、SSE逐帧及since恢复；确认未启用Funnel、公网IP与公网443/3210均无Vera入口。
5. [ ] 直接接入至少一个独立daemon宿主及其Workspace/Memory路径，完成凭证落盘、自动重连、离线失败、gateway停止后daemon约45秒退出和重启恢复验收。
6. [ ] 按placement边界完成必要的Memory首次绑定或显式迁移；既有gateway placement不因daemon login静默改挂，迁移失败不形成第二个可写真值。
7. [ ] 配置并实测各宿主一致性备份与恢复入口，排除secrets、运行锁、临时文件和`.vera-index/`；私有GitHub副本只作冷恢复来源。
8. [ ] 用真实daemon重跑`gemma4:e4b`固定raw语义夹具，并完成PC、手机蜂窝网络、在线流式回复、离线Agent错误Activity及端到端重启验收。
9. [ ] 将客户端日常入口切换到gateway私网URL，停止旧Mac gateway与cloudflared自启；连续实际使用Vera并处理阻塞性部署问题后，确认自用部署里程碑完成。

直接部署可以使用逐条确认的终端操作；临时探针或实验输出只放系统临时目录，不为本次自用部署在repo中维护另一套一次性安装器。每一步都必须先解析精确目标，再执行并立即验证；涉及停用、替换、迁移或网络收紧时，必须先有可读备份和仍可用的管理连接。

### 自用投入使用完成标准

- [ ] gateway、至少一个独立daemon、Workspace与对应Memory placement在真实宿主运行，重启后自动恢复，客户端统一使用gateway私网入口。
- [ ] owner私网HTTPS、真实SSE流、PC与手机蜂窝网络均通过；公网IP、3210和443均没有Vera公网入口。
- [ ] 在线Agent正常回复，离线Agent只产生错误Activity且不创建Run；gateway停止后daemon约45秒内退出且不反复撞网关。
- [ ] Memory binding、迁移和离线失败符合契约，备份与恢复入口已实测，secret未进入repo、日志、命令参数或部署摘要。
- [ ] 旧Mac gateway与cloudflared自启已停止并保留冷备；Vera已切换为实际日常使用入口，而不只是完成一次部署演示。

达到以上标准后，[`index.md`](index.md) 的第1项即可完成，Vera已可日常使用；随后再进入下列开源引导适配。

### VPS部署边界

- [ ] 在选定的小VPS直接部署gateway控制面与gateway placement数据；不要求Workspace、CLI daemon或全部Memory与gateway同机。
- [ ] gateway由systemd常驻，只监听`127.0.0.1:3210`。
- [ ] gateway VPS、PC与其他daemon VPS都加入tailnet并登记稳定`hostId`；用Tailscale Serve提供gateway私网HTTPS。
- [ ] 配置ACL与owner login；未加入tailnet的设备不能访问Vera。
- [ ] 不安装公网反向代理，不启用Funnel，不开放公网Vera端口。
- [ ] PC可运行轻量Agent，较大VPS可运行项目Workspace与能力较强的CLI Agent；当前每个owner Workspace必须与自己的daemon同`hostId`。
- [ ] 手机蜂窝网络、不同宿主daemon、SSE逐帧与since恢复通过真实验收。

### Memory placement

- [ ] daemon链路启用后，新登记CLI Agent只在daemon宿主已验证可承载对应Memory Provider时首次原子绑定到daemon placement；此前已登记为gateway placement的Agent保持原位，不借login静默改挂。
- [ ] CLI Agent默认`vera.markdown`可跟随daemon宿主；API Agent可绑定gateway宿主；remote Provider按自身服务位置登记。
- [ ] gateway只保存active Provider binding、placement、版本与安全状态；daemon placement离线返回`memory_provider_unavailable`，不回退gateway副本。
- [ ] placement迁移必须排空写入、复制、逐条验证并原子换绑；旧副本转冷备，不形成第二个可写真值。

### 备份

- [ ] 每个Memory Provider宿主与Workspace宿主按自身数据边界生成一致性快照，排除secrets、运行锁与临时文件，并推送到gateway VPS的备份入口。
- [ ] gateway VPS定期把可版本化快照推送到私有GitHub仓库；GitHub副本只用于恢复，不参与在线读取或写入。
- [ ] `.vera-index/`不进入Git，恢复后从Markdown重建。
- [ ] rsync/推送缓存只作为冷备份传输，不形成第二个可写真值；恢复时按`agentId/accountId/hostId`明确选择来源。

### 真实模型复验

- [ ] 在VPS gateway与真实daemon部署完成后，用同一`gemma4:e4b` runtime/model/tag重跑固定raw语义夹具。
- [ ] 通过前不得登记为已验证Digest executor。
- [ ] 失败继续保持`invalid_proposal`与vault零变化；不得用prompt特判、adapter猜测或放宽validator换取通过。

### 本机清理

- [ ] 停止旧Mac gateway与cloudflared自启。
- [ ] 旧数据与cloudflared配置只保留冷备份。
- [ ] 验证Mac/PC可只运行daemon、Workspace和其daemon placement Memory；客户端统一访问gateway VPS私网入口。

## 后置：开源友好的部署引导适配

本里程碑在自用部署完成并投入使用后再启动。目标是把已经真实运行、反复验证过的部署事实收口成面向其他User的通用体验，不反过来让尚未验证的抽象阻塞我们自己的上线。

### 开源引导式部署

- [ ] 仓库根目录提供单一`npm run setup`入口；User在控制端clone仓库后即可选择本机或SSH可达宿主并完成部署，不要求手工编辑repo文件、systemd unit或JSON配置。
- [ ] setup先做只读preflight并展示执行计划，再等待User确认：检查本机与目标宿主的Node、SSH、Tailscale、Linux/systemd、端口、目录权限、既有Vera/代理service及公网监听；明确列出节点、角色、路径、备份、宿主准备、将安装或停止的service及网络变更，失败项不得自动绕过。
- [ ] Tailscale分为“使用已有tailnet”和“从零搭建”两条引导路径。已有网络检测登录状态、目标设备、MagicDNS/HTTPS、ACL与owner login；从零路径引导User完成官方安装、登录、设备加入和管理台授权，Vera不接管Tailscale账号凭证、不把auth key写入repo、日志或命令输出。
- [ ] User为每个宿主确认角色；gateway宿主只询问gateway data、附件与gateway placement Memory路径，daemon宿主只询问该宿主的Workspace与daemon placement Memory路径，纯客户端不询问服务端路径。每个Vera宿主生成并持久化稳定`hostId`，重跑不得因进程、SSH连接或Tailscale设备名变化而改号。
- [ ] 部署顺序固定为只读preflight与计划确认 → 备份 → VPS宿主准备 → tailnet前置确认 → 网络固化 → gateway安装 → Tailscale Serve与owner私网访问验收 → daemon/Workspace/Memory宿主接入 → 端到端验收与备份；gateway未通过私网入口验收时不得继续签发或接入daemon。
- [ ] 交互向导与可单独验证、可重复执行的底层部署操作共用实现；以已经通过的自用直接部署步骤、故障和验收为输入，不维护另一份与真实链路分叉的部署逻辑。
- [ ] setup重跑必须幂等：已正确完成的步骤只验证，不重复创建service、Serve入口、Agent身份或凭证；配置漂移显示精确差异并重新确认，失败明确停在哪一步及安全重试方式，不把半完成状态报告为成功。
- [ ] setup输出不含secret的部署摘要、gateway私网URL、节点角色/`hostId`、已确认路径、验收结果和后续重跑入口；Agent Token、Account Key与Account Session不得进入终端回显、进程参数、部署摘要或repo。

## setup交互状态机

状态按下列顺序单向推进；任一阶段失败都停在当前阶段，不得把后续阶段标成已完成：

1. `target_collected`：只收集控制端、SSH目标、宿主角色、部署路径、tailnet路径及owner login；尚未改动目标宿主。
2. `preflighted`：只读探测目标宿主并生成事实快照；不调用`sudo`、不写文件、不安装包、不重启或停止service、不修改防火墙/Tailscale/SSH。
3. `planned`：把每项检查归类为`ready`、`blocked`或`remediation_required`，展示精确操作、目标、风险、备份与验证方法。存在`blocked`时不得确认执行。
4. `confirmed`：User确认本次计划；确认只绑定当前事实快照与计划，目标状态变化后必须重新preflight并确认，不复用旧确认。
5. `backed_up`：对将替换、迁移或停用的Vera数据、配置和service定义完成可定位的冷备份；无可验证备份时不得执行破坏性清理。
6. `host_prepared`：完成Vera直接需要的宿主清理、运行用户/目录和权限准备，并逐项复验；未知或不属于Vera的service与数据保持不动。
7. `tailnet_ready`：已有tailnet路径已验证，或User完成从零路径的外部授权；SSH与Tailscale至少保留一条已实测的管理连接。
8. `network_hardened`：关闭Vera旧公网入口并验证公网不可达；任何SSH或防火墙收紧都必须在新连接实测成功后才确认完成。
9. `gateway_applied`：幂等安装gateway配置与systemd service，但尚不代表部署成功。
10. `gateway_verified`：依次通过回环health、Tailscale Serve、owner身份、私网HTTPS、SSE逐帧及公网不可达验收。
11. `daemon_applied`：接入daemon、Workspace和对应Memory宿主；gateway未到`gateway_verified`不得进入本状态。
12. `completed`：端到端、重启恢复、备份与部署摘要全部通过。

`cancelled`与`failed`是停止结果，不是成功阶段。setup必须报告最后完成阶段、失败操作及安全重跑入口；取消或失败不自动回滚已经验证完成的步骤，也不得继续执行未确认步骤。

## preflight与计划输入

- 控制端输入只包括部署模式、本机或SSH目标、每个目标的角色、目标路径、已有/新建tailnet路径和精确owner Tailscale login。Agent Token、Account Key与Account Session不属于计划输入。
- SSH preflight只使用User当前提供或系统已配置的连接方式；Vera不复制私钥、不把密码写入参数或部署状态，也不自行改变SSH认证方式。
- 每个目标记录OS/架构、Node版本、systemd、磁盘、时钟、目标路径权限、监听端口、Vera相关service、Tailscale状态和管理连接。检查结果必须区分“未安装”“已正确配置”“存在可修复漂移”“未知冲突”。
- 计划必须逐宿主列出角色、路径、将创建/保留/替换/停用的对象及验证命令；不得用“自动修复全部问题”代替具体差异。

## VPS宿主准备与固化

- 宿主准备只自动处理Vera直接拥有或与本次部署明确冲突的对象：旧Vera gateway/daemon service、旧cloudflared或公网Vera反向代理、Vera占用的公网监听、目标运行用户、systemd unit、数据目录与权限。匹配不唯一时标记`blocked`，不得猜测后删除。
- 停用或替换旧链路前必须先生成冷备份并验证可读取；默认采用停用、改名或迁移等可恢复动作，不直接删除旧数据。清理结果写入不含secret的部署摘要。
- 通用系统固化与Vera部署分开列示。系统安全更新、SSH策略、root登录、fail2ban、提供商防火墙等只有在User明确选择对应操作、setup能检测当前状态并验证恢复路径时才可执行；不支持的发行版或未知策略只报告，不擅自改动。
- 网络固化必须晚于`tailnet_ready`：先实测新的SSH或Tailscale管理连接，再关闭旧公网Vera入口、收紧相关防火墙规则并重新连接验证。任何可能切断唯一管理连接的计划均为`blocked`。
- 每个底层操作统一实现`detect → diff → apply → verify`；重跑时`detect`已命中目标状态则只执行`verify`。破坏性操作还必须声明备份、恢复动作和精确目标，不能依赖模糊进程名、未解析变量或宽泛路径。

## 引导适配实施顺序

1. [ ] 自用部署里程碑完成并投入使用后，重新审计已经验证的宿主事实、命令、故障与恢复边界，再恢复setup实现。当前单目标CLI已使用可扩为多目标的数据形状，完成本机/SSH固定只读探针、白名单事实解析、角色/路径校验、计划指纹、`planned`安全摘要与底层operation接口；CLI明确停在`planned + applied:false`。
2. [ ] 补齐基于事实快照的交互确认、真实backup/apply/verify操作与多目标一次编排，并在全新受支持环境重演gateway及至少一个独立daemon部署。
3. [ ] 完成已有tailnet与从零tailnet两条路径、幂等重跑、漂移提示、错误定位、恢复体验和面向开源User的最终交互文案。

## 开源引导适配完成标准

- [ ] 在全新受支持环境中，从clone仓库到gateway与daemon可用只需运行`npm run setup`并完成明确的外部Tailscale授权；无需复制隐藏命令或手改目标宿主文件。
- [ ] 已有tailnet与从零tailnet两条路径均完成真实演练；setup重跑不产生重复service、Serve入口、Agent身份、凭证或`hostId`。
- [ ] 任一节点不可达、权限不足、路径无效或网络验收失败时，setup安全停止并给出可执行的恢复入口；已存在的数据、配置和凭证不被静默覆盖。
- [ ] preflight在目标宿主上产生零变更；宿主准备不触碰未精确识别的非Vera对象，网络固化不切断唯一管理连接，重跑不会再次清理或覆盖已经验证的备份与目标状态。
- [ ] gateway重启后daemon自动重连，CLI binding与API history按契约恢复。
- [ ] gateway停止后daemon约45秒内退出，不反复撞网关。
- [ ] 在线Agent正常流式回复；离线Agent只产生错误Activity且不创建Run。
- [ ] 公网IP、3210和443均没有Vera公网入口。
