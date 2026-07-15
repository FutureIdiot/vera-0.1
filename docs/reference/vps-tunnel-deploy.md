# Vera 部署指南（VPS gateway + Tailscale Serve 纯私网）

> 2026-07-11 修订，与 `docs/ground-truth.md` 2.4 一致。本文档是部署唯一真相。
> 开源版本默认纯私网。旧 Cloudflare Tunnel / Access 方案只作为 `docs/salvage-notes.md` 中的历史经验，不再用于部署。

## 0. 目标形态

```text
手机（启用 Tailscale，不同时运行 v2rayNG）
Mac（小火箭承载 Tailscale 配置，或官方 Tailscale 客户端）
其他授权 daemon 宿主
  -> 同一 tailnet
  -> https://<vps-machine>.<tailnet>.ts.net
  -> Tailscale Serve（HTTPS，只在 tailnet 内可达）
  -> http://127.0.0.1:3210
  -> Vera gateway（VPS，systemd 常驻）
     - 唯一进程、唯一 store、唯一 SSE seq 水位
     - 不 spawn agent
```

Vera 不配置公网入口：不使用公开域名、Cloudflare Tunnel、Tailscale Funnel或公网反向代理，不把 gateway 监听到 `0.0.0.0`。手机、Web、原生客户端与 agent daemon 全部通过同一个私网 URL 访问同一个 gateway。

Tailscale 仍依赖其协调服务，无法点对点直连时可能使用 DERP relay；“纯私网”指 Vera 服务不向公网开放，不等于整套组网控制面完全自托管。

## 1. 网络与身份边界

| 层 | 责任 |
|---|---|
| VPS 防火墙 | 不开放 Vera 公网端口；SSH建议也限制源地址或改走tailnet |
| Tailscale | 设备入网、加密传输、MagicDNS、HTTPS、ACL和设备撤销 |
| Tailscale Serve | 私网HTTPS转发到`127.0.0.1:3210`，清理伪造身份头并注入可信identity |
| Vera owner校验 | 普通页面/API/SSE只允许`config.security.ownerTailscaleLogins`中的login |
| Vera agent token | `/api/agent/*`在tailnet门禁之外再识别具体agent |

- gateway 只监听 `127.0.0.1:3210`，不直接信任来自网络的 Tailscale identity headers；只有请求确实来自本机 Serve 转发时才信任。
- `ownerTailscaleLogins` 是部署必填项。生产环境为空时应拒绝普通业务 API，而不是把整个 tailnet 当作 owner。
- tailnet ACL 只允许 owner 设备与明确授权的 daemon 设备/tag访问 Vera 节点。
- 撤销手机或 Mac 访问通过 tailnet 管理台移除设备/用户或修改 ACL；Vera 不再复制一套 owner 配对码和 device session。
- 撤销 agent 时同时撤销 Vera agent token；若整台宿主不再可信，再撤销其 tailnet 设备/tag。

## 2. 手机行为

“手机不走 VPN”的项目语义固定为：**不同时运行 v2rayNG 等其他 VPN，手机仍启用 Tailscale加入 Vera 私网**。

- 不选择任何 Exit Node。这样只有 `100.64.0.0/10`、MagicDNS/`*.ts.net` 与其他明确私网路由走 Tailscale。
- 浏览器、视频、银行、消息等其他 App 的普通公网请求仍使用手机自己的 Wi-Fi/蜂窝出口，不经过 Vera VPS。
- Android 如有个别 App 因检测到 VPN 而拒绝工作，可在 Tailscale 的应用分流中排除该 App；Vera App不能排除，否则无法访问私网 gateway。
- Vera App 首次启动让用户输入 `https://<vps-machine>.<tailnet>.ts.net`；不可达时提示检查 Tailscale，不尝试公网 fallback。
- 必须实测蜂窝/Wi-Fi切换、锁屏恢复、Tailscale自动重连和SSE `since`重放。

## 3. Mac 与小火箭

Vera 不依赖小火箭的配置格式，只依赖它最终正确承载 Tailscale：

- tailnet地址段路由正确，不被普通代理规则接管；
- `*.ts.net` / MagicDNS解析正确；
- HTTP、POST与SSE走同一条私网路径；
- 睡眠唤醒、切网和规则重载后能恢复；
- 不再同时启动第二个会抢占系统Packet Tunnel的VPN。

如果小火箭配置不能提供真正的tailnet设备身份、路由和MagicDNS，就不等价于加入Tailscale；此时用官方Tailscale客户端对照验证，不能让daemon改走公网补洞。

## 4. VPS 部署顺序

1. 安装Node、Tailscale与systemd所需基础包。
2. 把VPS加入tailnet，设置不含邮箱或secret的machine name，启用MagicDNS与tailnet HTTPS。
3. 配置tailnet ACL：owner设备可访问Vera；daemon设备/tag只按既定授权访问。
4. 部署Vera代码与依赖，把data、vault、secrets和agent tokens迁到VPS；不迁移`~/.cloudflared`。
5. 配置`vera-gateway.service`：`PORT=3210`、data/vault路径、heartbeat配置、`ownerTailscaleLogins`；gateway只绑定回环。
6. 使用Tailscale Serve把私网HTTPS地址转到`http://127.0.0.1:3210`，保持后台运行；不得启用Funnel。
7. 手机与Mac分别通过`*.ts.net`地址验证health、页面、API和SSE。
8. agent daemon配置同一私网URL + per-agent token，验证登录、run、流式回传、心跳和CLI provider binding恢复；API Agent的规范history由gateway恢复。
9. 验收完成后停止旧Mac gateway和cloudflared自启；旧文件只留冷备份。

Tailscale Serve 是当前唯一入口实现，不再同时维护Caddy/nginx公网配置。部署命令与systemd整合方式在Phase 5.5实际落地验证后补回本文，不能把未经实测的示例当完成项。

## 5. Daemon 配置边界

```text
VERA_GATEWAY_URL=https://<vps-machine>.<tailnet>.ts.net
VERA_AGENT_TOKEN=<per-agent-token>
VERA_AGENT_WORKSPACE=<local-workspace-root>
VERA_<PROVIDER>_BIN=<local-cli-path>
```

- 不再包含Cloudflare Service Token或公网备用URL。
- 私网不可达时daemon按心跳协议停在飞run并退出，不静默fallback公网。
- API型agent若不在VPS本机，同样必须由加入tailnet的daemon承载；不能让普通第三方云函数直接访问私网agent API。

## 6. 必须完成的验收

### 6.1 纯私网隔离

- 未加入tailnet的设备无法打开Vera URL或任何API。
- VPS公网IP的3210/443没有Vera服务；没有公开Vera DNS记录。
- Tailscale Serve开启、Funnel关闭；gateway监听地址确认为`127.0.0.1`。
- 未在ACL内的tailnet设备访问失败；owner login不匹配时普通业务API返回403。
- agent token错误时，即使设备已加入tailnet，`/api/agent/*`仍返回401/403。

### 6.2 手机链路与公网分流

- 手机只启用Tailscale、不启用v2rayNG时可访问Vera。
- 手机未选择Exit Node；访问普通公网网站时出口不是Vera VPS。
- 其他常用App可正常访问公网；Android排除个别App后不影响Vera。
- 蜂窝/Wi-Fi切换、锁屏与Tailscale重连后SSE按`since`恢复，无静默缺口。

### 6.3 Agent链路

- Mac能解析私网域名并访问health；关闭Tailscale路径后立即失败。
- daemon能login、订阅SSE、接收`run.requested`、回传delta/activity/message；CLI按`agentSessionId + generation`同步provider binding，API不另传opaque会话状态。
- 连续运行至少30分钟确认SSE不结块。
- 停gateway后daemon约45秒内停止在飞run并退出，不反复重连烧token。

### 6.4 单一事实来源与恢复

- 手机、Mac Web和daemon观察到同一个gateway startedAt与SSE seq水位。
- 重启gateway后daemon取回CLI provider bindings，API AgentSession由gateway规范history续接，手机客户端重连无事件缺口。
- 备份恢复演练覆盖data、vault、secrets和agent tokens。

## 7. 日常运维

| 操作 | 要点 |
|---|---|
| 看gateway日志 | systemd journal；不记录Authorization/provider secret |
| 看Serve状态 | 确认只启用Serve、未启用Funnel |
| 看Tailscale状态 | 节点在线、ACL命中、直连/DERP变化；DERP不等于公网暴露 |
| 撤销手机/Mac | tailnet管理台移除设备或调整ACL |
| 撤销agent | 撤agent token；宿主不可信时同时撤tailnet设备/tag |
| 更新gateway | 备份 -> 更新 -> 重启 -> 手机、Web、daemon三路私网验收 |
| 数据备份 | data/vault/secrets/token stores一致性备份，备份本身加密限权 |

## 8. 开源用户改成公网是否复杂

对Vera的Space、Message、Run、SSE和store核心业务而言不复杂：这些协议可以继续使用HTTPS，不需要重写领域层。但对安全和部署而言是**中等复杂度的独立功能**，不能只把`*.ts.net`换成公网域名。

公网模式至少要新增：

- 公网TLS反向代理与证书续期；
- 独立owner登录/设备session/撤销，不再依赖Tailscale identity；
- Web CSRF、原生CORS精确白名单与SSE认证；
- 登录/配对限速、审计、代理可信IP头和路径规范化；
- `/api/agent/*`是否继续私网隔离的明确策略；
- 端口、防火墙、DDoS与备份泄漏的运维边界。

因此当前只保证“核心协议未来可复用”，不预建公网认证抽象、不提供`publicMode`开关。等出现第二个真实部署需求时，再按独立阶段补契约、威胁模型、实现与验收；默认安装始终是纯私网。

## 9. 明确不采用

- 不运行cloudflared或Cloudflare Access。
- 不启用Tailscale Funnel。
- 不配置Vera公网域名或公网反向代理。
- 不让gateway监听`0.0.0.0:3210`。
- 不启用Vera VPS为手机Exit Node。
- 不为当前纯私网实现自建owner配对码/device session。
- 不把小火箭配置写进Vera产品代码。
