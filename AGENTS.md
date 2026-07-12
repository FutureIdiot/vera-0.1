# AGENTS.md

本文件是所有参与 Vera 0.0.1 开发的 agents 的长期工作规约。只写稳定规则；设计在 `docs/ground-truth.md`，计划在 `docs/plan.md`，不要把设计方案复制进来。

## 文档秩序（最高优先级）

- `docs/ground-truth.md` 是唯一设计基准。代码与它冲突时，停下来问用户，不要自行取舍。
- **文档变更先于代码变更**：改接口先改 `docs/api-contract.md` / `docs/adapter-interface.md`，再动代码。
- `docs/` 保持扁平，固定成员：`ground-truth.md`、`plan.md`、`api-contract.md`、`adapter-interface.md`、`salvage-notes.md`、`memory-hook.md`、`reference/`。**不得新建文档目录或另开计划文档**；阶段进展直接更新 `plan.md` 的状态标记。旧 Vera 的 docs 分了六个目录互相引用失效，是前车之鉴。

## 文件结构（不得自行扩张）

```
Vera-0.0.1/
├── AGENTS.md / README.md / package.json / package-lock.json / .gitignore
│                          # 当前根文件；新增其他根成员必须先问用户
├── capacitor.config.*     # [F6] 唯一Capacitor配置（按工具实际格式选一种）
├── android/               # [F6] Capacitor生成的Android原生壳
├── ios/                   # [F6] Capacitor生成的iOS原生壳
├── docs/                  # 固定成员见「文档秩序」，唯一允许放 .md 的地方
│   └── reference/         # 外部参考资料
├── src/                   # 后端 gateway
│   ├── server.js          # 唯一入口：路由组合与参数读取
│   ├── core/              # 配置加载、id、日志、spawn 封装等通用件
│   ├── api/               # HTTP 路由处理、SSE 通道、路由权限
│   ├── adapters/          # 各供应商 adapter，一个供应商一个文件
│   ├── agents/            # Agent 注册与身份
│   ├── spaces/            # Space 与消息域逻辑
│   ├── memory/            # 数据层（Memory/Files/AgentState，Phase 5 前保持空）
│   └── store/             # 持久化（JSON 文件存储）
├── frontend/
│   ├── vite.config.js
│   └── src/
│       ├── views/         # 页面级组件
│       ├── components/    # 可复用组件
│       ├── hooks/
│       ├── state/         # 前端 UI 状态
│       ├── styles/        # CSS 变量、主题；所有视觉参数的唯一来源
│       └── api/           # gateway client（HTTP + SSE）
├── scripts/               # 运维脚本（launchd、verify 等）
└── test/                  # 镜像 src/ 的目录结构
```

- 上图是允许的长期结构，不是要求把目录提前建满。**任何未列出的根目录文件或目录都必须先问用户，并先更新本规约再新增**；不得把“工具惯例”当成默认授权。
- `capacitor.config.*`、`android/`、`ios/` 只在 `docs/plan.md` 的 F6 被标为进行中、且用户在当前任务明确授权进入 F6 后才可生成。新窗口即使看到本规约已列出它们，也不得直接运行 `cap init`、`cap add`、`npx cap ...` 或同类生成命令；必须先检查 `plan.md` 阶段状态与当前授权。
- 现有子目录也不是无限堆放区。新文件必须进入职责最接近的既有目录；觉得哪里都不合适，或需要新的领域子目录时，先停下来问用户。不得为了少建文件把多个职责继续塞进一个文件，也不得为了形式整齐预建空目录。
- `.md` 文件只允许出现在 `docs/`（根目录的 AGENTS.md、README.md 除外）。**任何工作产出的报告、总结、TODO、设计草稿一律不写成新文档**——进展更新到 `plan.md`，经验回写 `salvage-notes.md`，接口变更改契约文档，其余直接在对话里说。
- 临时文件、实验脚本、抓包输出等不进 repo，用系统临时目录。
- 手写文件名一律 kebab-case；工具生成且无法配置的原生工程文件遵循对应平台惯例。一个文件一个职责，接近 ~300 行或已经出现两个职责时及时拆分，不能等文件明显膨胀后再处理；拆分仍沿既有页面、领域和平台边界，不顺手发明抽象层。

## 命名纪律

- 一个概念一个名字，贯穿代码、存储、API、UI：`Space` / `Agent` / `Message` / `Memory` / `Files` / `AgentState`。
- **禁止引入同义词或兼容别名**（旧 repo 的 accounts↔agents、conversations↔channels 双名体系是它烂掉的主因）。要改名就写迁移一次改干净，改不干净就不改。

## 结构约束

- 后端 `src/`：`server.js` 只做路由组合与参数读取；业务逻辑进独立模块（`adapters/`、`core/`、`api/`、`memory/`）。
- adapter 接口只承诺"adapter 自己负责会话连续性"，不得假设会话形态（daemon 常驻 vs 进程 resume 两种生命周期都必须能映射，见 `docs/adapter-interface.md`）。
- adapter 不得直接读写存储层或执行副作用；一切经 gateway 的模块接口。
- 前端：**mobile-first**，手机竖屏是第一公民。逻辑拆进 views / components / hooks / state，不允许出现巨石 App 组件。
- 所有视觉参数走 CSS 变量，组件内不得硬编码颜色、尺寸、字体值（ground truth 4.3）。

## 配置纪律

- ground truth 第四节的可配置项：实现为配置文件字段 + 默认值，代码引用配置变量，**不许硬编码**。
- 但**可配置 ≠ 抽象层**：不要为"未来可能的执行者/存储/协议"预建插件系统或注册表。抽象等第二个真实用例出现再提。
- 数据层分类（Memory / Files / AgentState）须可扩展，不得写成固定枚举分支。

## 旧 Vera（`~/projects/Vera`）

- **只读**。它是参考答案和经验来源，不是依赖，不得修改，也不得从新代码 import 它。
- 需要它的经验时先查 `docs/salvage-notes.md`；notes 里没有的再去读源码，读完把结论补进 notes。

## 工作流程

- 开始前 `git status --short`；不得回退、覆盖用户或其他 agent 的未提交改动。
- 中大型、多模块或长阶段任务默认使用 subagents 分担实现、审查与验证，以控制主窗口上下文压力。主 agent 负责范围控制、按不重叠文件或职责拆分任务、整合结果与最终提交；不得让多个 agent 同时编辑相同文件。小型、单文件或无法安全并行的任务由主 agent 直接完成，不为形式强行拆分。
- 不做与当前任务无关的"顺手整理"或大重构。
- secrets 只存 `~/.vera/secrets.json`，不进 repo，不出现在日志与 API 返回中。
- 后端改动至少验证：`node --check` 改动文件；起服务用临时数据目录（`VERA_DATA_PATH=/tmp/... PORT=3210`），不污染真实数据。**端口固定 3210**（旧 Vera 常驻进程占 3000；见 `docs/plan.md` Phase 2 注记）；3210 被占时先 `lsof -i :3210` 查谁在占，不绕过换号——攒一堆端口记录就是没规约的征兆。要换 3210 必须先改 `plan.md` 那条注记，一次改干净。`scripts/verify.mjs` 用 `getFreePort()` 随机挑空闲端口是例外，固定端口反而会和手测实例打架。
- 涉及 SSE 的改动必须实测流式（curl 看事件逐条到达），不能只看单元测试。
- 禁止破坏性 git 命令；提交信息说清楚做了什么、动了哪层。

## 单一事实来源

- 后端 gateway 与其存储是唯一事实来源；前端只缓存 UI 状态。
- 新功能动工前必须能回答：接收什么事件、产生什么事件、读写哪层数据。答不上来先补契约文档。
