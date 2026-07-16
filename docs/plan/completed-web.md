# 已完成：Web共享核心 F0–F5

本文保存Web完成证据。当前页面语义以Ground Truth与API页面矩阵为准。

## F0–F2：设计基线与共享基础

- 已确认mobile-first、全屏聊天、Space导航、当前Space设置与全局Settings的页面边界。
- Web保持原生ES Modules，Vite只负责dev/build、动态import和bundle分析。
- API、state、views和styles已按职责拆分；`tokens.css`是视觉参数唯一来源。
- 全局runtime唯一持有SSE；route具备mount/unmount；timeline DOM上限为200项。

## F3：聊天与Space

- 已完成全屏聊天、Space导航、Space切换/新增/改名/归档/恢复、当前Space设置和响应规则。
- 最终导航语义：Space目录是聊天页内左侧双列抽屉；右滑与聊天顶栏左上按钮共用开关；打开期间切换Space保持展开；无pin和持久固定状态。
- 顶栏Space名称进入当前Space设置。
- 当前Space设置和所有全局Settings均为独立全屏页；设置路由不显示Space目录。

## F4：管理体验

- Settings根页只做轻量入口；子页动态加载并在离页时清理。
- System、Appearance、Paths、Control Center和Account/Memory管理已拆分。
- Appearance支持预览、保存、按组恢复默认与Theme/Profile交换。
- Path迁移使用校验→迁移→验证→回滚。
- 旧Account组合页仍展示历史`1:N`形态，等待 `federation-account.md` 一次迁移。

## F5：发布与性能冻结

- production HTML使用`no-cache` + ETag；hash资源一年immutable。
- 已补页面级重试错误、联网立即SSE重连、bfcache恢复、键盘与dialog焦点闭环、live region和脏表单URL回退。
- 2026-07-13最终自动验收：`npm test` 113/113、gateway/SSE黑盒68/68、默认聊天19,434/204,800 bytes gzip、11个动态route chunks、`git diff --check`通过。
- Chrome、Safari、Android Chrome与iOS Safari人工矩阵及Performance trace已由用户确认完成。
- Android WebView与iOS WKWebView回归留给 `native-clients.md`。
