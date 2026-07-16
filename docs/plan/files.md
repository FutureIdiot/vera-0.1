# Files：Space 附件

## 状态与依赖

- [~] 契约已冻结，后端、前端与验收进行中
- Data → Memory页面与四目录内置binding已有真实实现；X1收口时补齐计划记录与浏览器证据
- 设计与接口只读 `docs/ground-truth.md` 3.2/4.1/5.1 和 `docs/api-contract.md` File、Files路由、页面矩阵、Path章节

## 后端

- [ ] 在现有 `src/memory/` 内以独立`files-*`模块建立Files领域实现，不新增根目录或领域目录。
- [ ] 二进制文件与store元数据分离；gateway是唯一事实来源，前端只缓存列表和上传进度。
- [ ] `isolation.files`三个策略的真实读取consumer生效；显式共享只接受明确Space id集合，扩大读取范围不改变owner与删除权限。
- [ ] 存储名安全生成，展示名原样保留。
- [ ] 拒绝路径穿越、符号链接逃逸、超限body、非法MIME/扩展组合和不完整临时文件。
- [ ] 附件根目录迁移复用校验→搬移→验证→回滚流程，不与gateway dataPath迁移混为一种语义。
- [ ] Message保存`fileIds`，时间线/SSE派生安全附件投影；Space归档保留，File删除墓碑化，永久删除owner Space级联清理。

## 前端

- [ ] 契约和后端完成后加入 `#/spaces/:spaceId/files`。
- [ ] composer附件入口只在真实API可用后出现。
- [ ] Web使用受限file input；移动端选择文件继续通过platform adapter，不提前实现原生权限。

## 验收

- [ ] 两个Space的默认隔离、显式共享和全局可读矩阵通过。
- [ ] 上传中断不留下可见脏记录。
- [ ] 同名、重复、删除、404/409、大小限制、路径穿越和迁移回滚有黑盒测试。
- [ ] 下载内容做真实二进制校验，API不泄露服务器绝对路径。
