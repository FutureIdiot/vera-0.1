# VPS 私网部署与旧链路清理

## 开始条件

- [ ] [`federation-runtime.md`](federation-runtime.md) 已完成

## VPS部署

- [ ] 将gateway数据与默认`vera.markdown` vault迁移到VPS。
- [ ] gateway由systemd常驻，只监听`127.0.0.1:3210`。
- [ ] VPS加入tailnet，用Tailscale Serve提供私网HTTPS。
- [ ] 配置ACL与owner login；未加入tailnet的设备不能访问Vera。
- [ ] 不安装公网反向代理，不启用Funnel，不开放公网Vera端口。
- [ ] 手机蜂窝网络、Mac daemon、SSE逐帧与since恢复通过真实验收。

## 备份

- [ ] 默认vault在VPS保持唯一热数据源。
- [ ] vault使用私有Git镜像备份；Mac只读pull。
- [ ] `.vera-index/`不进入Git，恢复后从Markdown重建。
- [ ] rsync只作为冷备份，不形成第二个可写真值。

## 真实模型复验

- [ ] 在VPS gateway与真实daemon部署完成后，用同一`gemma4:e4b` runtime/model/tag重跑固定raw语义夹具。
- [ ] 通过前不得登记为已验证Digest executor。
- [ ] 失败继续保持`invalid_proposal`与vault零变化；不得用prompt特判、adapter猜测或放宽validator换取通过。

## 本机清理

- [ ] 停止旧Mac gateway与cloudflared自启。
- [ ] 旧数据与cloudflared配置只保留冷备份。
- [ ] 验证Mac只运行daemon，客户端统一访问VPS私网入口。

## 完成标准

- [ ] gateway重启后daemon自动重连，CLI binding与API history按契约恢复。
- [ ] gateway停止后daemon约45秒内退出，不反复撞网关。
- [ ] 在线Agent正常流式回复；离线Agent只产生错误Activity且不创建Run。
- [ ] 公网IP、3210和443均没有Vera公网入口。
