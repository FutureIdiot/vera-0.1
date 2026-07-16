# Vera 0.0.1 计划索引

本目录只回答“下一步做什么、依赖什么、完成后看哪里”。产品语义以 [`../ground-truth.md`](../ground-truth.md) 为准，接口与运行边界以对应契约文档为准。

## 新窗口读取规则

执行一个功能时只读：

1. `AGENTS.md`
2. 本索引
3. 目标功能文件
4. 目标功能明确引用的契约章节

除非任务是追溯、回归或迁移，不读 `completed-*.md`。目标文件与契约无法给出唯一解释时，先问用户，不得从历史记录自行补全产品语义。

状态标记：`[ ]` 未开始 / `[~]` 进行中。完成后从执行文件删除，证据移入对应完成记录。

## 当前依赖顺序

1. [~] [Agent使用管理、目录壳与内置Hooks/MCP接线（阶段A–B浏览器闸门）](runtime-capabilities.md)
2. [~] [Data → Memory 页面浏览器闸门](memory-ui.md)
3. [~] [Phase 5 收口：真实embedding与最终冻结](phase-5-closeout.md)
4. [ ] [Home Account / Execution / Workspace 迁移](federation-account.md)
5. [ ] [联邦状态、身份与权限](federation-security.md)
6. [ ] [Agent daemon 与跨进程运行链路](federation-runtime.md)
7. [ ] [VPS 私网部署与旧链路清理](federation-deployment.md)
8. [ ] [原生客户端](native-clients.md)
9. [ ] [运行时能力真实闭环（阶段C）](runtime-capabilities.md)
10. [ ] [Extension 体系](extensions.md)
11. [ ] [原生发布与三端回归](native-release.md)

不得从前项未完成处跳过依赖直接生成原生工程。某一文件内部若有更细依赖，以该文件为准。

## 执行文件

| 文件 | 唯一职责 |
|---|---|
| [`memory-ui.md`](memory-ui.md) | Data → Memory 状态与配置页面 |
| [`files.md`](files.md) | Files完成记录入口；当前无未完成事项 |
| [`phase-5-closeout.md`](phase-5-closeout.md) | Memory / Files 端到端验收与 Phase 5 冻结 |
| [`federation-account.md`](federation-account.md) | Home Account、Execution、Workspace与租约迁移 |
| [`federation-security.md`](federation-security.md) | AgentState、presence、agent token、owner identity |
| [`federation-runtime.md`](federation-runtime.md) | `/api/agent/*`、调度器、daemon、mock daemon |
| [`federation-deployment.md`](federation-deployment.md) | VPS、Tailscale Serve、数据迁移、本机清理与真实模型复验 |
| [`native-clients.md`](native-clients.md) | Capacitor共享平台、Android壳与iOS壳 |
| [`runtime-capabilities.md`](runtime-capabilities.md) | Agent使用管理双入口与分页、Skills / Hooks / MCP / Data前端目录、内置binding接线与后续运行时闭环 |
| [`extensions.md`](extensions.md) | Extension Package、Agent Plugin、Space Module与Memory Provider扩展 |
| [`native-release.md`](native-release.md) | Android release、iOS archive与三端最终回归 |

## 完成记录

| 文件 | 内容 |
|---|---|
| [`completed-foundation.md`](completed-foundation.md) | Phase 0–4 的基础、消息、配置与历史网络切片 |
| [`completed-web.md`](completed-web.md) | F0–F5 Web共享核心、最终Shell语义与验收 |
| [`completed-memory.md`](completed-memory.md) | P5-D0、M1、M1.5、M2、M3、C1、M3.1、M4后端、F1与X1自动化验收切片 |

## 0.0.1 明确不做

- 多用户与独立账号体系
- 无明确授权边界的 agent 间自主调度
- 独立桌面客户端；Mac 使用Web版
