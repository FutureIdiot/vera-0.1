# Extension 体系

## 开始条件

- [ ] [`runtime-capabilities.md`](runtime-capabilities.md) 已完成
- 必须先补Ground Truth与API契约；本文件不预先替代Extension设计

## Extension Package

- [ ] 定义manifest、安装、卸载、版本、升级、权限和统一事实来源。
- [ ] Settings负责全局安装/卸载；Agent与Space只做unit绑定。
- [ ] 不建立第二套包格式或万能Plugin runtime。

## Runtime类型

- [ ] 实现Skill、MCP、Hook各自runtime。
- [ ] Agent Plugin由daemon承载，但不成为Agent设置第五个顶层目录。
- [ ] Space Module使用可销毁sandbox，并提供Web/Android/iOS一致bridge。
- [ ] 未启用扩展零加载；扩展崩溃不影响聊天Shell或gateway。
- [ ] 第三方代码不得直接进入主DOM或持有gateway secret与宿主文件权限。

## Memory Provider扩展

- [ ] 定义`memory-provider`能力、安装状态、配置、健康检查和driver ABI。
- [ ] 自定义Provider可使用自身文件、数据库或服务，不强制转换为Obsidian Markdown。
- [ ] 普通第三方MCP即使提供memory命名工具，也不得自动登记为Provider。
- [ ] 只有已安装、声明并通过Memory Provider契约验证的unit进入Data → Memory列表。

## 验收

- [ ] 安装、绑定、禁用、升级、权限变化和卸载均可回滚。
- [ ] 任一扩展失败不拖垮其他扩展、客户端或gateway。
- [ ] 三端共享同一Extension安装与权限事实来源。
