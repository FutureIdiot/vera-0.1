# 原生发布与三端回归

## 开始条件

- [ ] [`native-clients.md`](native-clients.md) 已完成
- [ ] [`runtime-capabilities.md`](runtime-capabilities.md) 已完成
- [ ] [`extensions.md`](extensions.md) 已完成

## 发布准备

- [ ] 完成Android release构建与产物校验。
- [ ] 完成iOS archive与TestFlight准备。
- [ ] 签名、Provisioning和商店正式发布作为独立发布步骤，不混入UI实现。

## 三端回归

- [ ] Web、Android、iOS跑同一聊天、Space、Settings、Approval、Files与断线恢复矩阵。
- [ ] F5 production缓存、bundle、route隔离、DOM上限和性能预算只做回归，不重建第二套标准。
- [ ] Extension安装、禁用、升级、权限变化和卸载在三端行为一致。
- [ ] 任一平台或Extension失败不拖垮gateway与其他客户端。

## 完成标准

- [ ] 三端共享业务代码和gateway唯一事实来源。
- [ ] 核心场景、性能预算、断线恢复与安全边界全部通过。
- [ ] 冻结可回退版本并记录构建环境与真实设备矩阵。
