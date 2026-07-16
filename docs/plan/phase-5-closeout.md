# Phase 5 收口

## 当前阻塞

- [ ] 完成 [`runtime-capabilities.md`](runtime-capabilities.md) 与
  [`memory-ui.md`](memory-ui.md) 保留的手机/桌面真实浏览器闸门。本窗口已加载浏览器
  验收规约，但没有暴露所需的浏览器控制执行面，不能把构建或DOM单测冒充实测。
- [ ] 启动本机Ollama并安装精确模型`qwen3-embedding:0.6b`，显式运行
  `VERA_TEST_OLLAMA_EMBEDDING=1` smoke并记录完整model digest。2026-07-17本机只有
  `gemma4:e4b`；已授权的模型下载在直连时EOF、经本机代理时registry返回503。

## 阻塞解除后的完成动作

- [ ] 重跑`npm test`、`node scripts/verify.mjs`、`npm run analyze:web`与
  `git diff --check`，确保环境闸门没有引入漂移。
- [ ] 更新`index.md`，把下一阶段唯一指向`federation-account.md`。
- [ ] 形成Phase 5可回退commit并开新任务窗口进入Phase 5.5；不得顺手迁移VPS或
  生成Android/iOS工程。

其余X1任务与验证证据已移入 [`completed-memory.md`](completed-memory.md)。
