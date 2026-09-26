# Vera

[中文](#中文) · [English](#english)

## 中文

**自部署的多 Agent 协作空间，在手机和电脑上连接你自己的 AI Agents。**

Vera 将运行在本地或云端设备上的 Agents 汇集到同一个界面。你可以在不同的 Space 中组织对话和项目，查看流式回复、处理执行审批，并管理文件、上下文和 Agent 的长期 Memory。

> 当前版本：**0.1.0 · 早期开发阶段**。面向单用户私网自部署，尚不提供开箱即用的一键部署。

### 核心能力

- **围绕 Space 工作**：私聊、群聊、流式回复、文件附件与上下文会话。
- **跨设备运行 Agent**：独立 daemon 在拥有运行环境和 Workspace 的设备上执行，由 Gateway 统一协调。
- **接入不同模型运行环境**：包括 Codex CLI、OpenCode 和 Ollama adapter。
- **保持身份与记忆连续**：区分 Account 对外身份与 Agent 执行身份，支持 Agent 独立的长期 Memory、检索、Digest 与 Dream 流程。
- **随时观察与授权**：手机优先的 Web 界面，提供执行审批、活动状态以及 System、Agent、Account 管理。
- **可回滚的 Gateway 更新**：由 owner 主动触发，包含隔离构建、数据冷备、健康检查与失败恢复。

### 如何组成

| 组件 | 职责 |
| --- | --- |
| **Gateway** | HTTP/SSE API、调度与持久状态的唯一事实来源 |
| **Agent daemon** | 在 Agent 所在设备上运行，并使用该设备上的 Workspace |
| **Web client** | 手机与桌面浏览器共享的控制界面 |
| **Tailscale Serve** | 为仅监听 loopback 的 Gateway 提供私网访问入口 |

### 本地开发

需要 **Node.js 20+** 与 **npm**。使用真实 Agent 时，还需要安装相应供应商的运行环境。

在仓库目录安装依赖：

```sh
npm ci
```

启动 Gateway，使用独立的临时开发数据目录：

```sh
PORT=3210 \
VERA_DATA_PATH=/tmp/vera-dev \
VERA_ALLOW_LOOPBACK_DEVELOPMENT=true \
npm start
```

在另一个终端启动 Web 开发服务器：

```sh
npm run dev:web
```

打开 Vite 输出的地址。开发服务器会把 `/api` 请求转发至 `3210` 端口的 Gateway。上述步骤启动 Gateway 与 Web；真实模型回复还需要接入 Agent daemon 并配置对应运行环境。

`VERA_ALLOW_LOOPBACK_DEVELOPMENT` 仅用于本地开发，在 `NODE_ENV=production` 下会被拒绝。`/tmp/vera-dev` 会在重复启动时复用，不适合存放需要长期保留的数据。

### 验证

| 命令 | 检查内容 |
| --- | --- |
| `npm test` | 单元与组件测试 |
| `npm run build:web` | Web 生产构建 |
| `npm run analyze:web` | 生产构建、资源体积预算、路由懒加载与时间线检查 |
| `node scripts/verify.mjs` | Gateway HTTP/SSE 黑盒验收 |

真实供应商冒烟测试需要显式启用，不属于默认测试套件。

### 部署与更新

生产部署面向 **owner 单用户私网使用**，预期环境包含 Tailscale 与 systemd。Gateway 仅监听 loopback，通过 Tailscale Serve 访问；公网端口、Funnel 和公网反向代理不在支持范围内。

`npm run setup` 当前只执行只读环境预检并生成部署计划，结果停在 `planned`、`applied: false`。它不会安装依赖、写入部署文件、修改服务、防火墙或 Tailscale 配置。

安装并配置 root updater 后，可以在 System 页面主动检查和应用 Gateway 更新。更新流程会准备隔离 release、安装依赖、运行测试、构建并检查 Web、冷备数据、原子切换并检查健康状态；启动失败时恢复之前的 release 与数据。

更新范围仅限 Gateway，不包含 Agent daemon、原生客户端、Workspace 或 Memory Provider 数据。

### 项目状态与凭证

Gateway、Web 客户端和核心运行时已有实现与测试。部署引导、原生客户端、Extension 体系及更多 Space 界面仍在开发中。

本仓库包含公开运行代码、测试与部署相关文件；内部设计和计划单独维护，不包含在公开默认分支中。

凭证必须保存在仓库之外。不要提交 `~/.vera/secrets.json`、Account Keys、Agent Tokens 或会话凭证。

### 许可证

[MIT License](LICENSE)

[切换到 English ↓](#english)

---

## English

[中文](#中文) · **English**

**A self-hosted workspace for multiple AI agents, accessible from your phone and computer.**

Vera brings Agents running on local or cloud devices into one interface. Organize conversations and projects in Spaces, follow streamed replies, approve execution, and manage files, context sessions, and each Agent’s long-term Memory.

> Current version: **0.1.0 · Early development**. Built for a single owner on a private network; a turn-key deployment is not yet available.

### Core capabilities

- **Work in Spaces**: direct and group conversations, streamed replies, file attachments, and context sessions.
- **Run Agents across devices**: independent daemons execute on the hosts that own their runtimes and Workspaces, coordinated by the Gateway.
- **Connect different model runtimes**: adapters include Codex CLI, OpenCode, and Ollama.
- **Maintain identity and memory**: separate Account-facing identity from Agent execution identity, with Agent-scoped long-term Memory, retrieval, Digest, and Dream workflows.
- **Observe and authorize**: a mobile-first web interface with approvals, activity status, and System, Agent, and Account management.
- **Update the Gateway with rollback**: owner-triggered updates include isolated builds, cold data backups, health checks, and failure recovery.

### Architecture

| Component | Responsibility |
| --- | --- |
| **Gateway** | Authoritative HTTP/SSE API, coordination, and persistent state |
| **Agent daemon** | Execution on the Agent’s host using that host’s Workspace |
| **Web client** | Shared control interface for phone and desktop browsers |
| **Tailscale Serve** | Private network access to a loopback-only Gateway |

### Local development

Requires **Node.js 20+** and **npm**. Real Agents also require the corresponding provider runtime.

Install dependencies from the repository directory:

```sh
npm ci
```

Start the Gateway with a separate temporary development data directory:

```sh
PORT=3210 \
VERA_DATA_PATH=/tmp/vera-dev \
VERA_ALLOW_LOOPBACK_DEVELOPMENT=true \
npm start
```

In another terminal, start the web development server:

```sh
npm run dev:web
```

Open the URL printed by Vite. The development server proxies `/api` to the Gateway on port `3210`. These steps start the Gateway and web client; real model replies additionally require a connected Agent daemon and its configured runtime.

`VERA_ALLOW_LOOPBACK_DEVELOPMENT` is for local development only and is rejected when `NODE_ENV=production`. The `/tmp/vera-dev` directory is reused across restarts and is unsuitable for data you need to retain long-term.

### Verification

| Command | Coverage |
| --- | --- |
| `npm test` | Unit and component tests |
| `npm run build:web` | Production web build |
| `npm run analyze:web` | Production build, bundle budget, lazy routes, and timeline checks |
| `node scripts/verify.mjs` | Black-box Gateway HTTP/SSE acceptance |

Real provider smoke tests are opt-in and are not part of the default test suite.

### Deployment and updates

Production deployment is intended for **one owner on a private network**, with Tailscale and systemd. The Gateway listens only on loopback and is accessed through Tailscale Serve. Public ports, Funnel, and public reverse proxies are outside the supported deployment model.

`npm run setup` currently performs read-only host preflight and produces a deployment plan, stopping at `planned` with `applied: false`. It does not install dependencies, write deployment files, or change services, firewalls, or Tailscale configuration.

Once the root updater is installed and configured, the System view can explicitly check for and apply Gateway updates. The updater prepares an isolated release, installs dependencies, runs tests, builds and validates the web client, creates a cold data backup, switches atomically, and checks health. If startup fails, it restores the previous release and data.

Updates cover the Gateway only, excluding Agent daemons, native clients, Workspaces, and Memory Provider data.

### Project status and credentials

The Gateway, web client, and core runtime have implementations and tests. Guided deployment, native clients, the Extension system, and additional Space surfaces remain under development.

This repository contains public runtime code, tests, and deployment-related files. Internal design and planning documents are maintained separately and are not included in the public default branch.

Keep credentials outside the repository. Never commit `~/.vera/secrets.json`, Account Keys, Agent Tokens, or session credentials.

### License

[MIT License](LICENSE)

[切换到中文 ↑](#中文)
