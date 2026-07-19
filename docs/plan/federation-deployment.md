# VPS 私网部署与旧链路清理

## 开始条件

- [ ] [`federation-runtime.md`](federation-runtime.md) 已完成

## 开源引导式部署

- [ ] 仓库根目录提供单一`npm run setup`入口；User在控制端clone仓库后即可选择本机或SSH可达宿主并完成部署，不要求手工编辑repo文件、systemd unit或JSON配置。
- [ ] setup先做只读preflight并展示执行计划，再等待User确认：检查本机与目标宿主的Node、SSH、Tailscale、Linux/systemd、端口和目录权限；明确列出节点、角色、路径、将安装的服务及网络变更，失败项不得自动绕过。
- [ ] Tailscale分为“使用已有tailnet”和“从零搭建”两条引导路径。已有网络检测登录状态、目标设备、MagicDNS/HTTPS、ACL与owner login；从零路径引导User完成官方安装、登录、设备加入和管理台授权，Vera不接管Tailscale账号凭证、不把auth key写入repo、日志或命令输出。
- [ ] User为每个宿主确认角色；gateway宿主只询问gateway data、附件与gateway placement Memory路径，daemon宿主只询问该宿主的Workspace与daemon placement Memory路径，纯客户端不询问服务端路径。每个Vera宿主生成并持久化稳定`hostId`，重跑不得因进程、SSH连接或Tailscale设备名变化而改号。
- [ ] 部署顺序固定为tailnet前置确认 → gateway安装 → Tailscale Serve与owner私网访问验收 → daemon/Workspace/Memory宿主接入 → 端到端验收与备份；gateway未通过私网入口验收时不得继续签发或接入daemon。
- [ ] 交互向导与可单独验证、可重复执行的底层部署操作共用实现；首次真实VPS部署允许用半交互流程逐步确认，但不得维护一份独立的手工部署逻辑。真实链路通过后再收口完整提示、错误定位与恢复体验。
- [ ] setup重跑必须幂等：已正确完成的步骤只验证，不重复创建service、Serve入口、Agent身份或凭证；配置漂移显示精确差异并重新确认，失败明确停在哪一步及安全重试方式，不把半完成状态报告为成功。
- [ ] setup输出不含secret的部署摘要、gateway私网URL、节点角色/`hostId`、已确认路径、验收结果和后续重跑入口；Agent Token、Account Key与Account Session不得进入终端回显、进程参数、部署摘要或repo。

## 实施顺序

1. [ ] 先冻结setup交互状态机、preflight、节点角色/路径输入及底层幂等操作边界。
2. [ ] 用同一setup入口和底层操作完成首个真实gateway VPS及至少一个独立daemon宿主的半交互部署，不另写一次性手工脚本。
3. [ ] 真实部署与故障恢复通过后补齐从零tailnet引导、重跑/漂移提示和面向开源User的最终交互文案。

## VPS部署

- [ ] 通过setup在选定的小VPS部署gateway控制面与gateway placement数据；不要求Workspace、CLI daemon或全部Memory与gateway同机。
- [ ] gateway由systemd常驻，只监听`127.0.0.1:3210`。
- [ ] gateway VPS、PC与其他daemon VPS都加入tailnet并登记稳定`hostId`；用Tailscale Serve提供gateway私网HTTPS。
- [ ] 配置ACL与owner login；未加入tailnet的设备不能访问Vera。
- [ ] 不安装公网反向代理，不启用Funnel，不开放公网Vera端口。
- [ ] PC可运行轻量Agent，较大VPS可运行项目Workspace与能力较强的CLI Agent；当前每个owner Workspace必须与自己的daemon同`hostId`。
- [ ] 手机蜂窝网络、不同宿主daemon、SSE逐帧与since恢复通过真实验收。

## Memory placement

- [ ] daemon链路启用后，新登记CLI Agent只在daemon宿主已验证可承载对应Memory Provider时首次原子绑定到daemon placement；此前已登记为gateway placement的Agent保持原位，不借login静默改挂。
- [ ] CLI Agent默认`vera.markdown`可跟随daemon宿主；API Agent可绑定gateway宿主；remote Provider按自身服务位置登记。
- [ ] gateway只保存active Provider binding、placement、版本与安全状态；daemon placement离线返回`memory_provider_unavailable`，不回退gateway副本。
- [ ] placement迁移必须排空写入、复制、逐条验证并原子换绑；旧副本转冷备，不形成第二个可写真值。

## 备份

- [ ] 每个Memory Provider宿主与Workspace宿主按自身数据边界生成一致性快照，排除secrets、运行锁与临时文件，并推送到gateway VPS的备份入口。
- [ ] gateway VPS定期把可版本化快照推送到私有GitHub仓库；GitHub副本只用于恢复，不参与在线读取或写入。
- [ ] `.vera-index/`不进入Git，恢复后从Markdown重建。
- [ ] rsync/推送缓存只作为冷备份传输，不形成第二个可写真值；恢复时按`agentId/accountId/hostId`明确选择来源。

## 真实模型复验

- [ ] 在VPS gateway与真实daemon部署完成后，用同一`gemma4:e4b` runtime/model/tag重跑固定raw语义夹具。
- [ ] 通过前不得登记为已验证Digest executor。
- [ ] 失败继续保持`invalid_proposal`与vault零变化；不得用prompt特判、adapter猜测或放宽validator换取通过。

## 本机清理

- [ ] 停止旧Mac gateway与cloudflared自启。
- [ ] 旧数据与cloudflared配置只保留冷备份。
- [ ] 验证Mac/PC可只运行daemon、Workspace和其daemon placement Memory；客户端统一访问gateway VPS私网入口。

## 完成标准

- [ ] 在全新受支持环境中，从clone仓库到gateway与daemon可用只需运行`npm run setup`并完成明确的外部Tailscale授权；无需复制隐藏命令或手改目标宿主文件。
- [ ] 已有tailnet与从零tailnet两条路径均完成真实演练；setup重跑不产生重复service、Serve入口、Agent身份、凭证或`hostId`。
- [ ] 任一节点不可达、权限不足、路径无效或网络验收失败时，setup安全停止并给出可执行的恢复入口；已存在的数据、配置和凭证不被静默覆盖。
- [ ] gateway重启后daemon自动重连，CLI binding与API history按契约恢复。
- [ ] gateway停止后daemon约45秒内退出，不反复撞网关。
- [ ] 在线Agent正常流式回复；离线Agent只产生错误Activity且不创建Run。
- [ ] 公网IP、3210和443均没有Vera公网入口。
