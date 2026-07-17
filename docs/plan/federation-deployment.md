# VPS 私网部署与旧链路清理

## 开始条件

- [ ] [`federation-runtime.md`](federation-runtime.md) 已完成

## VPS部署

- [ ] 在选定的小VPS部署gateway控制面与gateway placement数据；不要求Workspace、CLI daemon或全部Memory与gateway同机。
- [ ] gateway由systemd常驻，只监听`127.0.0.1:3210`。
- [ ] gateway VPS、PC与其他daemon VPS都加入tailnet并登记稳定`hostId`；用Tailscale Serve提供gateway私网HTTPS。
- [ ] 配置ACL与owner login；未加入tailnet的设备不能访问Vera。
- [ ] 不安装公网反向代理，不启用Funnel，不开放公网Vera端口。
- [ ] PC可运行轻量Agent，较大VPS可运行项目Workspace与能力较强的CLI Agent；当前每个owner Workspace必须与自己的daemon同`hostId`。
- [ ] 手机蜂窝网络、不同宿主daemon、SSE逐帧与since恢复通过真实验收。

## Memory placement

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

- [ ] gateway重启后daemon自动重连，CLI binding与API history按契约恢复。
- [ ] gateway停止后daemon约45秒内退出，不反复撞网关。
- [ ] 在线Agent正常流式回复；离线Agent只产生错误Activity且不创建Run。
- [ ] 公网IP、3210和443均没有Vera公网入口。
