# 已完成：基础与Phase 0–4

本文只保存完成事实和迁移证据，不定义当前产品语义。发生冲突时以Ground Truth和现行契约为准。

## Phase 0–1：旧repo经验与契约

- 已将旧Vera可复用经验整理进 `docs/salvage-notes.md`；旧repo继续只读。
- 已建立 `docs/api-contract.md` 与 `docs/adapter-interface.md`。
- adapter只承诺自身负责会话连续性，不把daemon常驻或CLI resume生命周期泄露给gateway。

## Phase 2：核心垂直切片

- 已完成Node ESM gateway、SSE、分集合JSON store、mock adapter、OpenCode adapter、Agent、默认Space和最简流式网页。
- `scripts/verify.mjs`已成为黑盒验收入口。
- store的`dataPath`从单文件迁移为目录，旧`store.json`可一次迁移；对外store API不变。
- 本机开发与手测固定`PORT=3210`。旧Vera占用3000；除`verify.mjs`自动选择空闲端口外，不自行换端口。
- 2026-07-03真机验收确认消息流、会话连续性、gateway重启恢复与SSE reset语义。

## Phase 3：历史公网切片

- 2026-07-03曾用Cloudflare Tunnel与Access完成蜂窝网络、锁屏/后台重连和SSE逐帧验收。
- 该方案已被Tailscale纯私网目标取代，只作为历史证据，不再指导部署。
- Cloudflare静态资源缓存导致手机拿不到新JS/CSS的教训已由Web production hash资源与HTML协商缓存收口。

## Phase 4：消息、配置与管理基础

- 已完成Agent与Account对象分域、Speaker view编译层、响应规则、Space管理和系统设置。
- Speaker view只注入Message，不注入Activity；他人消息以署名声告进入volatile输入，不伪装成目标Agent的assistant历史。
- seat已支持`responseMode/respondTo/blockAgentIds`。
- `GET/PATCH /api/settings`、运行时override和配置consumer基础已完成。
- Phase 4当时实现的`Agent 1:N Account`与可变连接Account现为待迁移历史形态；Phase 5.5将`owningAgentId`一次迁为严格1:1、不可普通改绑的`ownerAgentId`，迁移任务见 `federation-account.md`。
