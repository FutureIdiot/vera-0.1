# 旧 Vera 榨取盘点（salvage notes）

> 来源：`~/projects/Vera`（只读参考，不得修改、不得 import）。
> 本文档的目的：Phase 1–2 写代码时不需要再回头翻旧仓库源码。发现遗漏时读旧源码后把结论**回写到这里**。
> 盘点日期：2026-07-02，基于旧 repo 最后一次提交 `39c6086`。

---

## 一、可直接搬运的资产（按价值排序）

### 1. OpenCode daemon 双文件 ★核心资产

- `src/adapters/opencode-daemon.js`（202 行）：daemon 生命周期管理。惰性启动 `opencode serve`、随机端口、随机密码、健康检查轮询、引用计数 + 5 分钟空闲自杀、SIGTERM→SIGKILL 优雅关停。整体架构可直接搬。
- `src/adapters/opencode-daemon-adapter.js`（352 行）：全局单一 SSE poller 按 `data.sessionID` 分发给多个在飞 run；`opencode run --attach` 子进程跑 LLM loop；`Promise.race(子进程退出, session.idle, 30 分钟看门狗)` 的完成判定。可搬，但按新 adapter 接口收口（见第四节"搬运时要改的"）。

### 2. OpenCode 协议实测知识（旧 `docs/plans/adapter/opencode-adapter-design.md`，实测于 opencode 1.17.9）

**架构要点（最重要、最反直觉）**：`opencode serve` 只是状态 + 事件枢纽，**不是 LLM 运行器**。POST prompt 只入队不执行；LLM loop 必须由 `opencode run --attach <url>` 客户端进程驱动。所以模式是：daemon 常驻管状态和 SSE，每条消息起一个短命 `run --attach` 子进程。

**关键 endpoint**（Basic auth，用户名 `opencode`，密码走 `OPENCODE_SERVER_PASSWORD` 环境变量）：

| Endpoint | 用途 |
|---|---|
| `POST /api/session` `{}` | 建会话，返回 `{data:{id}}` |
| `GET /api/event`（SSE） | 全局事件流，`data.sessionID` 是路由键 |
| `GET /api/session/{id}` | 会话元信息（tokens、cost、model） |

**`run --attach` 关键参数**：`-u <user> -p <pw>`（basic auth）、`-m <providerID/modelID>`、`--variant <v>`（思考强度）、`-c -s <sessionID>`（**必须显式传 `-s`**，否则 opencode 用"本项目最后一个会话"，多 channel 并发下会串线）、`--dangerously-skip-permissions`（否则 question/plan 类工具默认拒绝，长跑会卡死）。

**SSE 事件映射（实测 68 个事件、11 种类型）**：

| opencode 事件 | 含义 / 处理 |
|---|---|
| `message.part.delta`（`field:"text"`）| 流式 token，转发 delta 即可 |
| `message.part.updated`（`part.type:"tool"`）| 工具调用；`state.status`: pending→running（多次）→completed/error；`state.input/output/title` 可做活动面板 |
| `message.part.updated`（`part.type:"text"`）| 非流式文本部件，可能是 reasoning |
| `session.status`（busy/idle）| 状态转换 |
| `session.idle` | **run 完成信号** |
| `session.updated` | tokens/cost 变化 |
| `server.connected` / `session.created` / `session.diff` / `session.next.*` | 可忽略 |
| `session.error` / `message.error` / `tool.error` / `session.compacted` | 未实测捕获，按终止/错误处理 |

最终回复文本：优先用 `message.part.delta` 累积值（无 ANSI 污染），子进程 stdout 做兜底。

### 3. launchd/GUI 环境 PATH 坑（`cli-shared.js` `buildProcessEnv`）

从 Finder / launchd 启动时 `process.env.PATH` 可能只有 `/usr/bin:/bin`，spawn 任何 Homebrew 安装的 CLI 都 ENOENT。解法：spawn 前把 `/opt/homebrew/bin`、`/opt/homebrew/sbin`、`/usr/local/bin` 前置进 PATH。**新 gateway 的 spawn 封装第一天就要带上这个**。

同类坑：opencode 二进制解析用三级 fallback——account 配置的 command → `VERA_OPENCODE_BIN` 环境变量 → `~/.opencode/bin/opencode`。

### 4. 运维脚本经验（`scripts/`）

- `install-launch-agent.mjs` / `uninstall-launch-agent.mjs`（launchd 常驻 + 崩溃自愈）、`verify-gateway.mjs`：Phase 6 时搬运参考。
- 子进程管理细节：`timer.unref()` 防止定时器阻塞 gateway 退出；`process.on("exit")` + SIGINT/SIGTERM 三处挂关停钩子。

### 5. cloudflared 边缘漂移假活（2026-07-04 实测）★

**症状**：浏览器访问 `vera.futureidiot.com` 返回 Cloudflare 错误页 **1033**（"Edge IP restricted" / tunnel 没注册到任何边缘）。本机 `curl 127.0.0.1:3210/api/health` 正常 200，cloudflared 进程 `pgrep` 在跑不退。launchd 看进程存活所以不重启。

**根因**：Cloudflare 边缘区域会漂移——7月3日 13:14 前连东京 NRT 边缘（198.18.0.96/97 是 cloudflared 内部对边缘的虚拟 IP），之后区域切走但 cloudflared 一直 dial 旧虚拟 IP 超时、不退出（log 里满屏 `dial tcp 198.18.0.x:7844: i/o timeout` + `there are no free edge addresses left to resolve to`）。Tunnel UUID 没变、DNS 没变，但 tunnel 后端没注册到任何边缘 → Cloudflare 给浏览器 1033。

**手动恢复**：`launchctl kickstart -k gui/$(id -u)/com.cloudflare.cloudflared` 强杀重启 cloudflared，4 条 http2 连接立刻注册到新边缘（本次是 LAX），恢复。

**永久防治**：
- launchd 的 `KeepAlive` 看进程是否**存活**，不看是否**健康**——任何「连上才健康」的服务（cloudflared、ssh tunnel、frpc、wg-quick）都需要**外部探活 + 主动重启**，不能只依赖存活检测。
- Phase 5.5 VPS 部署里用 systemd `Restart=always` + 一个 2 分钟 `cloudflared-watchdog.timer`（跑 `cloudflared tunnel info vera` 看连接数，0 就 `systemctl restart cloudflared`）把这个收敛到分钟级。
- VPS 网络稳定且 7×24 不睡眠，本身漂移概率比 Mac 低，叠加 watchdog 双保险。

**相关坑**：
- `protocol: http2` 必须显式配。cloudflared 默认会先尝试 quic/UDP 7844，UDP 7844 被中间网络屏蔽时会卡在 `dial udp 198.18.0.x:7844: i/o timeout`。HTTP/2 走 TCP 443 出去，被屏蔽概率低。
- 浏览器报 1033 ≠ 本机 gateway 挂。先看本机 127.0.0.1 直接 curl gateway 健康（200 → gateway 活），再 `cloudflared tunnel info <name>` 看连接数（0 → 边缘断了，重启 cloudflared）。两步排查法此后所有 1033 类故障都对。

## 二、实测环境事实（会漂移，用前核对）

- opencode 协议实测版本 1.17.9；协议若变，失败模式是 fallback，不是崩溃。
- Claude Code 集成时版本 2.1.183；print 模式默认参数 `["-p", "--output-format", "text"]`；`--resume`/`--continue` 续接**从未实现**，只留了扩展点——这是新项目 Phase 6 的正题。
- Codex：`exec -` 从 stdin 读 prompt，`-C <rootPath>` 指定 workspace，`--output-last-message` 读最终回复；用量窗口 `5h`/`7d` 是 Codex 专属概念。

## 三、明确不搬的部分及原因

| 不搬 | 原因 |
|---|---|
| accounts↔agents、conversations↔channels 兼容别名体系 | 混乱主因，新项目命名纪律直接禁止 |
| `src/db/` 的 seed/migration/catalog 体系 | 为兼容层服务的复杂度；新项目 JSON 文件存储从契约形状起步 |
| `frontend/src/App.jsx` 巨石组件 | 反面教材 |
| tmux 传输 + 终端提示扫描审批桥 | 复杂且脆弱；审批模型等契约阶段重新设计 |
| 旧 `docs/` 六目录体系 | 交叉引用已烂；有用事实已摘入本文档 |
| mock / ollama / api adapter | 量小，需要时对着新接口重写更快 |

## 四、搬运时要改的（旧代码已知问题）

- `opencode-daemon.js` 是模块级单例（`cachedDaemon`/`refCount` 全局变量），搬运时收进一个类或工厂，便于测试和多实例。
- daemon-adapter 里 `if (sawAnyTextPart || true)` 这种废弃条件、abort listener 清理不对称（`removeEventListener` 传了新箭头函数，等于没移除）——重写时修掉。
- SSE poller 断线后靠"下一次 acquire 重启"，没有主动重连；新版契约里断线重连语义要明确。
- 旧设计文档中 `POST /api/session/{id}/prompt` 队列路径存在但未使用；新版也不用，保持 `run --attach` 模式。
