# Files：Space 附件

## 状态与依赖

- [ ] 本功能未开始
- 必须在Data → Memory页面完成后开始
- 先改 `docs/ground-truth.md` 与 `docs/api-contract.md`，再实现代码

## 契约

- [ ] 定义File对象、owner Space、显式共享范围和权限。
- [ ] 定义上传、列表、详情、下载、删除、大小、MIME、重名和错误。
- [ ] 定义`fileId`如何进入Message、时间线如何展示、Message或Space归档后的附件生命周期。
- [ ] 定义SSE事件与 `#/spaces/:spaceId/files` 的loading/empty/error/offline状态。

契约完成前不新增Files模块、页面或composer假按钮。

## 后端

- [ ] 在现有 `src/memory/` 职责边界旁建立Files领域实现；如现有目录无法承载，先问用户，不自行新增领域目录。
- [ ] 二进制文件与store元数据分离；gateway是唯一事实来源，前端只缓存列表和上传进度。
- [ ] 默认按Space隔离。显式共享只接受明确Space id集合；扩大读取范围不改变owner Space与删除权限。
- [ ] 存储名安全生成，展示名原样保留。
- [ ] 拒绝路径穿越、符号链接逃逸、超限body、非法MIME/扩展组合和不完整临时文件。
- [ ] 附件根目录迁移复用校验→搬移→验证→回滚流程，不与gateway dataPath迁移混为一种语义。

## 前端

- [ ] 契约和后端完成后加入 `#/spaces/:spaceId/files`。
- [ ] composer附件入口只在真实API可用后出现。
- [ ] Web使用受限file input；移动端选择文件继续通过platform adapter，不提前实现原生权限。

## 验收

- [ ] 两个Space的默认隔离、显式共享和全局可读矩阵通过。
- [ ] 上传中断不留下可见脏记录。
- [ ] 同名、重复、删除、404/409、大小限制、路径穿越和迁移回滚有黑盒测试。
- [ ] 下载内容做真实二进制校验，API不泄露服务器绝对路径。
