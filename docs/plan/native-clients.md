# 原生客户端

## F6授权闸门

- [ ] Phase 5与Phase 5.5全部完成
- [ ] F5冻结的Web基线回归通过
- [ ] 本项状态改为`[~]`
- [ ] 用户在当前任务明确授权进入F6

四项同时满足前，禁止运行`cap init`、`cap add`、`npx cap`或生成`android/`、`ios/`。

## 共享平台

- [ ] 引入唯一Capacitor配置，`webDir`指向共享Web产物。
- [ ] 原生工程不复制业务JS/CSS。
- [ ] platform adapter补齐gateway URL、fetch/SSE、secure storage、notification、file picker、keyboard/back、haptics与external auth/link。
- [ ] 平台特有代码只存在于bridge与原生壳。

## Android

- [ ] 生成Android壳并接入安全存储、系统返回、键盘、安全区、前后台SSE恢复、通知与文件选择。
- [ ] 固定debug构建与安装脚本。
- [ ] 真机覆盖蜂窝网络、锁屏/切后台、旋转、字体缩放、冷启动、长时间线与文件传输。

## iOS

- [ ] 生成iOS壳并处理WKWebView safe-area、键盘、返回手势、外部认证回跳、通知、ATS与前后台SSE恢复。
- [ ] 固定模拟器构建与archive校验流程。
- [ ] 模拟器通过后，至少一台真机跑与Android相同核心场景。

## 本功能完成标准

- [ ] Web、Android、iOS加载同一业务产物与gateway事实来源。
- [ ] Android真机与iPhone模拟器/真机通过核心聊天、设置、断线恢复和文件选择场景。
- [ ] 完成后进入 `runtime-capabilities.md`，不在本文件提前做发布收口。
