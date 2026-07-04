# Vera 部署指南（VPS gateway + 远程 agent daemon 联邦形态）

> 形态定稿于 2026-07-04（见 `docs/ground-truth.md` 2.4）。本文档是部署唯一真相。
> 旧形态（Mac 跑 gateway + Mac 上 cloudflared 把本机反推出去）作废，原因见末尾「历史教训」。旧 Mac CLI 同机 spawn 形态作废，新形态见 `docs/adapter-interface.md` 正文。

## 0. 目标形态

```
Phone/Browser (任意网络)
  └─► https://vera.futureidiot.com
        └─► Cloudflare Access（邮件 OTP，team plain-silence-4358）
              └─► cloudflared dial-out（VPS 进程，systemd 守护 + watchdog）
                    └─► http://127.0.0.1:3210   Vera gateway（VPS 进程，systemd 守护）
                          - 消息中枢 + 状态库 + vault + secrets
                          - 编译层（view-compiler）给 daemon 现成 promptText
                          - Account.presence 维护
                          - 离线 @ 直接发 error activity 跳过
                          - 不 spawn 任何 agent 进程

Agent daemon (各 agent 上线时跑；位置任意)
  例 1: 本机 Mac 上跑 opencode daemon (agent A) → cwd 本机代码仓库 / vault
  例 2: 另一台 Linux 机跑 claude-code daemon (agent B) → cwd 那台机的 repo
  例 3: API 型 agent C → 跑在某云函数上，无 CLI 进程

  协议: HTTPS + 双层 token 主动连入 gateway
    外层: Cloudflare Access Service Token (过 Cloudflare 门)
    身份层: Vera agent token (Authorization: Bearer, gateway 校验)
  通道: POST /api/agent/login + GET /api/agent/events (SSE) + 各业务 POST
  心跳: gateway 每 15s 发 agent.heartbeat, daemon 3 次漏收 → exit(0)
```

设计要点：
- **Gateway 在 VPS**：7×24 不睡眠，网络稳定，本机状态与 Vera 解耦。
- **Agent daemon 在远端**：CLI 进程由 daemon 自己 spawn、自己 cwd、自己管会话连续性。gateway 不知道也不关心 CLI 在哪台机器上、跑什么二进制。
- **cloudflared 也在 VPS**：tunnel UUID 没换、DNS 不动、Access app 不动；VPS 网络稳定，边缘漂移由 systemd watchdog 主动探活根治。
- **VPS 不暴露任何公网端口**：所有进入流量经 cloudflared tunnel。
- **Mac 不再常驻任何 Vera 进程**：cloudflared / gateway 都搬走。Mac 上只有 agent daemon（按需起）。

## 1. 前置条件

- 一台 VPS，规格下限 2 vCPU / 2 GB RAM / 20 GB SSD（gateway ~80MB、cloudflared ~50MB、systemd ~100MB；agent daemon 不在 VPS 上，不占 VPS 资源）。
- 域名已托管 Cloudflare，且已创建 tunnel `vera`、Access app 已配 `vera.futureidiot.com` 邮件 OTP（Phase 3 已就位，本次搬迁不动 DNS / Access）。
- 本机有 SSH 私钥能登 VPS、`rsync` 可用。
- VPS OS：systemd Linux（Debian 11+ / Ubuntu 22.04+ / 类似）。

## 2. VPS 初始化（gateway 宿主）

部署用户 `theta`、工作区 `/opt/vera`、家目录 `/home/theta` 示例。

### 2.1 基础包

```sh
sudo apt update
sudo apt install -y rsync curl ca-certificates git ufw

# Node 20+（用 NodeSource 仓库，避免 apt 自带的过老版本）
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node --version   # 应 >= 20

# 防火墙：只留 SSH；cloudflared 不需要入站端口
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw enable
```

### 2.2 Vera 代码

```sh
sudo mkdir -p /opt/vera
sudo chown theta:theta /opt/vera
cd /opt/vera
git clone <your-vera-repo-url> .
npm ci
```

### 2.3 cloudflared

```sh
sudo mkdir -p -- /etc/apt/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /etc/apt/keyrings/cloudflare-main.gpg > /dev/null
echo 'deb [signed-by=/etc/apt/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main' | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt update
sudo apt install -y cloudflared
cloudflared --version
```

### 2.4 Cloudflare Access Service Token（联邦接入必需）

去 Cloudflare Zero Trust 面板：
1. **Access → Service Tokens → Create Service Token**，取名 `vera-agent-daemon`，保存生成的 `CF-Access-Client-Id` / `CF-Access-Client-Secret` 一对（secret 只显示一次）。
2. **Access → Applications → Edit `vera.futureidiot.com`**，加一条规则：
   - Path：`/api/agent/*`
   - Action：Allow
   - Include：Service Token is `vera-agent-daemon`
   
   这条规则只放行带对应 Service Token 头的请求过 Cloudflare 那道门，不走邮件 OTP。其他路径仍走原有邮件 OTP 规则。
3. 把 Service Token 一对值写进 **本机** 各 agent daemon 配置（不要写进 VPS Vera 仓库）。Vera gateway 不需要这对值——它在 Cloudflare 那一层就消费掉了。

## 3. 数据迁移（Mac → VPS）

在 Mac 上执行。一次性 rsync 本机的 `~/.vera/` 和 `~/.cloudflared/` 到 VPS。

```sh
# 在 Mac 上：

# 1. Vera 数据 + vault + secrets
rsync -avz --progress ~/.vera/data/    theta@<VPS_IP>:/home/theta/.vera/data/
rsync -avz --progress ~/.vera/memory/  theta@<VPS_IP>:/home/theta/.vera/memory/
scp ~/.vera/secrets.json               theta@<VPS_IP>:/home/theta/.vera/secrets.json

# 2. cloudflared 的 tunnel credentials + config
rsync -avz --progress ~/.cloudflared/  theta@<VPS_IP>:/home/theta/.cloudflared/
```

VPS 端收尾：

```sh
# 权限收口：secrets 只对部署用户可读
chmod 700 /home/theta/.vera
chmod 600 /home/theta/.vera/secrets.json

# cloudflared config 检查
cat /home/theta/.cloudflared/config.yml
# 确认 ingress 仍指 127.0.0.1:3210
```

`config.yml` 保留 `protocol: http2`：

```yaml
tunnel: 26bb24d1-5b7a-4bca-b4b0-8454cd15f32b
credentials-file: /home/theta/.cloudflared/26bb24d1-5b7a-4bca-b4b0-8454cd15f32b.json
protocol: http2

ingress:
  - hostname: vera.futureidiot.com
    service: http://127.0.0.1:3210
    originRequest:
      http2Origin: false
      disableChunkedEncoding: false
      connectTimeout: 30s
      keepAliveTimeout: 30s
      keepAliveConnections: 10
      tcpKeepAlive: 30s
  - service: http_status:404
```

## 4. systemd units

### 4.1 `vera-gateway.service`

```ini
# /etc/systemd/system/vera-gateway.service
[Unit]
Description=Vera 0.0.1 gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=theta
WorkingDirectory=/opt/vera
Environment=PORT=3210
Environment=VERA_DATA_PATH=/home/theta/.vera/data
Environment=VERA_MEMORY_VAULT_PATH=/home/theta/.vera/memory
# VERA_OPENCODE_BIN 不再需要（联邦形态 gateway 不 spawn CLI）
Environment=VERA_AGENT_HEARTBEAT_INTERVAL_MS=15000
ExecStart=/usr/bin/node /opt/vera/src/server.js
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal
SyslogIdentifier=vera-gateway

[Install]
WantedBy=multi-user.target
```

部署并起：

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now vera-gateway
sudo systemctl status vera-gateway
sudo journalctl -u vera-gateway -f
curl -s http://127.0.0.1:3210/api/health   # { "app": "vera", "ok": true }
```

### 4.2 `cloudflared.service`

```ini
# /etc/systemd/system/cloudflared.service
[Unit]
Description=cloudflared tunnel (vera)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=theta
ExecStart=/usr/bin/cloudflared tunnel --config /home/theta/.cloudflared/config.yml run vera
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=cloudflared

[Install]
WantedBy=multi-user.target
```

部署并起：

```sh
sudo systemctl enable --now cloudflared
sudo journalctl -u cloudflared -f
# 应在 ~5s 内看到 INF Registered tunnel connection，connIndex 0..3，protocol=http2
```

### 4.3 `cloudflared-watchdog.timer`（治边缘漂移假死）

旧形态 Mac 上 cloudflared 进程「假活」是 1033 的根因（详见末尾「历史教训」）：边缘 IP 漂移后 cloudflared 一直 dial 旧虚拟 IP 超时，进程不退出，launchd 看进程在就不重启。systemd 的 `Restart=always` 治不了这个（进程没退）。**必须主动探活**：定时跑 `cloudflared tunnel info vera`，连接数为 0 就 `systemctl restart cloudflared`。

```ini
# /etc/systemd/system/cloudflared-watchdog.service
[Unit]
Description=Check cloudflared tunnel has active edge connections

[Service]
Type=oneshot
User=theta
ExecStart=/bin/bash -c '\
  CONNS=$(/usr/bin/cloudflared tunnel --config /home/theta/.cloudflared/config.yml info vera \
          | awk "/^[0-9a-f]{8}-/{print NF-3; exit}"); \
  if [ -z "$CONNS" ] || [ "$CONNS" = "0" ]; then \
    echo "no active connection, restarting cloudflared"; \
    systemctl restart cloudflared; \
  else \
    echo "active connections: $CONNS"; \
  fi'
```

```ini
# /etc/systemd/system/cloudflared-watchdog.timer
[Unit]
Description=Run cloudflared watchdog every 2 minutes

[Timer]
OnBootSec=90s
OnUnitInactiveSec=120s

[Install]
WantedBy=timers.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now cloudflared-watchdog.timer
systemctl list-timers cloudflared-watchdog.timer
```

## 5. Agent daemon 部署（在每台要接入 Vera 的机器上）

### 5.1 在 Mac 上跑 opencode daemon

```sh
# 1. 装 opencode CLI binary（保持本机已有的 ~/.opencode/bin/opencode 即可）
ls -la ~/.opencode/bin/opencode

# 2. 拉 Vera 仓库（daemon 代码在 scripts/agent-daemon.js，Phase 5.5 落地后才有）
cd ~/projects/Vera-0.0.1
git pull

# 3. 写 daemon 配置（不进 repo，单独放 ~/.vera/daemon/<agentId>.env）
mkdir -p ~/.vera/daemon
cat > ~/.vera/daemon/agt_<your-id>.env <<'EOF'
VERA_GATEWAY_URL=https://vera.futureidiot.com
VERA_AGENT_TOKEN=<your-vera-agent-token>           # gateway 颁发
CF_ACCESS_CLIENT_ID=<service-token-id>             # Cloudflare 颁发
CF_ACCESS_CLIENT_SECRET=<service-token-secret>
VERA_OPENCODE_BIN=/Users/theta/.opencode/bin/opencode
VERA_AGENT_WORKSPACE=/Users/theta/projects          # agent 默认 cwd 根
EOF
chmod 600 ~/.vera/daemon/agt_<your-id>.env

# 4. 起 daemon（前台先跑一次看日志）
node scripts/agent-daemon.js --config ~/.vera/daemon/agt_<your-id>.env

# 5. 跑通后写成 launchd 常驻
cat > ~/Library/LaunchAgents/com.vera.agent-daemon.agt_<your-id>.plist <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.vera.agent-daemon.agt_<your-id></string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/theta/projects/Vera-0.0.1/scripts/agent-daemon.js</string>
    <string>--config</string>
    <string>/Users/theta/.vera/daemon/agt_<your-id>.env</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>/Users/theta/Library/Logs/vera-agent-daemon.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/theta/Library/Logs/vera-agent-daemon.err</string>
</dict>
</plist>
EOF
launchctl load -w ~/Library/LaunchAgents/com.vera.agent-daemon.agt_<your-id>.plist
```

`KeepAlive.SuccessfulExit=false` 的语义：daemon `exit(0)` 视为正常退出不自动拉起（心跳缺失自杀走这条）；非 0 退出（崩溃）才自动起。这避免"gateway 挂了 daemon 反复撞网关烧 token"。

### 5.2 在 Linux 机器上跑 claude-code daemon

类似 5.1，差异：
- 不装 opencode，装 `claude` CLI
- `VERA_AGENT_WORKSPACE` 指向那台机器的工作区根
- 用 systemd unit 而非 launchd（路径 `/etc/systemd/system/vera-agent-daemon@.service` 模板化，每个 agent 一个实例文件）

```ini
# /etc/systemd/system/vera-agent-daemon@.service
[Unit]
Description=Vera agent daemon (%i)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=theta
EnvironmentFile=/home/theta/.vera/daemon/%i.env
ExecStart=/usr/bin/node /opt/vera/scripts/agent-daemon.js --config /home/theta/.vera/daemon/%i.env
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=vera-agent-daemon

[Install]
WantedBy=multi-user.target
```

`Restart=on-failure` 等价于 launchd 的 `SuccessfulExit=false`：`exit(0)` 不自动起，崩溃才起。

```sh
sudo systemctl enable --now vera-agent-daemon@agt_<id>.service
sudo journalctl -u vera-agent-daemon@agt_<id>.service -f
```

### 5.3 API 型 agent

API 型 agent 无 CLI 进程，daemon 是个轻量 Node 脚本，可跑在任何能访问 `https://vera.futureidiot.com` 的环境（云函数、另一台 VPS、甚至本机）。它只在收到 `run.requested` 时调供应商 API。部署同 5.2，差异：daemon 内部不 spawn CLI、`VERA_AGENT_KIND=api` + `VERA_SECRET_REF=<key 名>` 指向 VPS 上的 `~/.vera/secrets.json`。

## 6. 验证

### 6.1 VPS 上 verify.mjs（gateway 内部一致性，临时数据目录）

```sh
cd /opt/vera
VERA_DATA_PATH=/tmp/vera-verify VERA_MEMORY_VAULT_PATH=/tmp/vera-verify-mem \
  PORT=4000 node scripts/verify.mjs
rm -rf /tmp/vera-verify /tmp/vera-verify-mem
```

> Phase 5.5 落地后 verify.mjs 会拆成两段：gateway 内部一致性（mock adapter 保留）+ 端到端协议（mock daemon）。当前 verify.mjs 仍是旧形态，用 mock adapter 测 gateway 自身。

### 6.2 Agent daemon 单独冒烟

```sh
# 在 Mac 上手动起 daemon，看登录响应
node scripts/agent-daemon.js --config ~/.vera/daemon/agt_<id>.env
# 应输出：
#   [info] login ok: agentId=agt_… accountId=acc_… seats=[…] heartbeatIntervalMs=15000
#   [info] SSE subscribed, waiting for run.requested
```

### 6.3 浏览器真机端到端

1. 手机蜂窝网络下打开 `https://vera.futureidiot.com`，过 Access 登录
2. 进 Space，发条消息 @ 在线的 agent
3. 看 agent 状态从 `idle` 变 `thinking` / `typing` / `coding` 等
4. 看流式逐字到气泡、看 Activity 入时间线
5. 收 `run.ended` 后 agent 状态回 `idle`

### 6.4 离线 @ 跳过验证

1. 停 Mac 上 agent daemon：`launchctl unload ~/Library/LaunchAgents/com.vera.agent-daemon.*.plist`
2. 等 ~50s（gateway 心跳超时把 presence 置 offline）
3. 浏览器发条消息 @ 该 agent
4. 应看到时间线一条 `phase: "error", label: "agent-offline"` 的 Activity，**不创建 Run**
5. 重启 daemon，登录后 presence 恢复 online；**漏过的 @ 不补发**（确认无副作用）

### 6.5 Gateway 重启会话连续性

```sh
sudo systemctl restart vera-gateway
# daemon SSE 应收 stream.reset → 重新 POST /api/agent/login → sessionState 取回 → 跑新消息零 session-reset
```

### 6.6 心跳缺失 daemon 自杀

```sh
sudo systemctl stop vera-gateway
# 等 ~45s
# Mac 上 daemon 应 exit(0)，日志写 "gateway unreachable 45s, exiting"
# launchctl 看 daemon 不自动重启（SuccessfulExit=false 生效）
sudo systemctl start vera-gateway
# gateway 恢复后 daemon 不会自己回来——你手动 launchctl load 一下重新登录
```

## 7. 本机清理

```sh
# 停本机 cloudflared（已迁 VPS）
launchctl unload ~/Library/LaunchAgents/com.cloudflare.cloudflared.plist
# 删 plist 避免开机自启
rm ~/Library/LaunchAgents/com.cloudflare.cloudflared.plist

# 停本机 gateway tmux 会话（已迁 VPS）
tmux kill-session -t vera-gateway 2>/dev/null

# ~/.vera/ 与 ~/.cloudflared/ 留着当冷备份（VPS 上的才是热数据）
# 但 ~/.vera/daemon/ 是新加的——保留，daemon 配置走这里
```

## 8. 日常维护

| 操作 | 命令 |
|---|---|
| 看 gateway 日志 | `sudo journalctl -u vera-gateway -f` |
| 看 cloudflared 日志 | `sudo journalctl -u cloudflared -f` |
| 看 daemon 日志（Mac） | `tail -f ~/Library/Logs/vera-agent-daemon.log` |
| 看 daemon 日志（Linux） | `sudo journalctl -u vera-agent-daemon@agt_<id> -f` |
| 更新 gateway 代码 | `cd /opt/vera && git pull && sudo systemctl restart vera-gateway` |
| 更新 daemon 代码 | 各机器上 `git pull` 后重启 daemon（launchctl unload+load / systemctl restart） |
| 添加新 agent | 在 VPS gateway 上 `POST /api/agents` 建身份+account → 生成 agent token 写入 `~/.vera/agent-tokens.json` → 在新机器上配 daemon env → 起 daemon |
| 撤 agent | 停该 daemon → `DELETE /api/agents/:id`（有历史的拒绝删除，先 `[P5]` 处理记忆） |
| 数据备份 | `rsync -avz theta@<VPS>:/home/theta/.vera/data/ ~/.vera-backup-$(date +%F)/` |

## 9. 故障排查

| 现象 | 排查 |
|---|---|
| 浏览器报 1033 | `journalctl -u cloudflared -n 50` 看 edge 漂移；`cloudflared tunnel info vera` 看连接数；watchdog 应已自动重启，没生效就 `sudo systemctl restart cloudflared`（两步排查法见 salvage-notes 第 5 条） |
| Gateway 崩 | `journalctl -u vera-gateway -n 100`；`systemctl status` 看 Restart 计数；data.json 损坏看 store 启动日志 |
| Agent daemon 频繁 exit(0) | gateway 不稳或 cloudflared 不稳；先看 gateway 与 cloudflared 日志，daemon 自杀是症状不是根因 |
| Agent daemon 崩溃循环（非 0 退出） | 看 daemon 日志，多半是配置错（token / Service Token / binary 路径）；`launchctl unload` 暂停，改对再 load |
| opencode run 限流报 provider_error | 供应商额度（如 api.navy UTC 午夜重置）；切到 ollama local 或换 provider |
| SSE 流结块不逐字 | cloudflared config 必须 `disableChunkedEncoding: false`；VPS 侧无 nginx 中间层，无 `proxy_buffering` 风险 |
| 重启后会话失连续性 | 检查 `/home/theta/.vera/data/session-states.json` 是否在；看 `journalctl -u vera-gateway \| grep -i migrate`；daemon 登录响应里的 `sessionStates` 字段是否带回 |
| 离线 @ 没出 error activity | 看 daemon 是否真的 offline（`/api/bootstrap` 该 account 的 presence 字段）；看 `shouldRespond` 是否命中；看 `agentStates` 跟踪器是否正确 |

## 10. 历史教训

### 10.1 cloudflared 边缘漂移假活（2026-07-04 实测）

Mac 上 cloudflared 7月3日 13:14 后开始 `dial tcp 198.18.0.97:7844: i/o timeout` 反复失败——edge 区域从东京（NRT）漂移走，cloudflared 进程一直在原地 dial 旧虚拟 IP、不退出。`launchctl` 看进程仍存活所以不重启。`vera.futureidiot.com` 域名解析到了 tunnel 但 tunnel 后端没注册到任何边缘 → Cloudflare 给浏览器返回 1033。

`launchctl kickstart -k gui/$UID/com.cloudflare.cloudflared` 强制重启 cloudflared 后，4 条 http2 连接立刻注册到 LAX，恢复。

**根治**：VPS 上用 systemd `Restart=always` + 一个 2 分钟 `cloudflared-watchdog.timer`（跑 `cloudflared tunnel info vera` 看连接数，0 就 `systemctl restart cloudflared`）把这个收敛到分钟级。VPS 网络稳定且 7×24 不睡眠，本身漂移概率比 Mac 低，叠加 watchdog 双保险。

**launchd 假活启示**：`KeepAlive` 看进程是否存活，不看进程是否健康。任何「连上才健康」的服务（cloudflared、ssh tunnel、frpc、wg-quick、agent daemon）都需要**外部探活 + 主动重启**，不能只依赖存活检测。Agent daemon 的心跳机制同理——gateway 通过心跳让 daemon 主动判定"gateway 还活着"，而不是 daemon 自己看进程。

### 10.2 为什么从 Mac 单机形态搬到 VPS 联邦形态

Phase 3 验收时 Vera 跑在 Mac tmux 里、cloudflared 在 Mac 上把 Mac 反推出去。这个形态的根本问题：

- Mac sleeps / 切网 / 重启 → Vera 整体挂
- cloudflared 边缘漂移 → 1033，且 launchd 不自愈
- 用户想要"手机随时随地能联系 Mac 上的 agent"——Mac 不在就联系不上

VPS 联邦形态把 gateway 与 agent daemon 解耦：gateway 在 VPS 永远在；agent daemon 在哪台机器都行，下线不影响 gateway 与其他 agent。这才是用户最初需求"手机 → Vera → Mac agent"的正确架构。