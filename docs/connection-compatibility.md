# 1.15.02.004 连接兼容升级

参考 [liyangpengs/qq-farm-bot 的连接更新](https://github.com/liyangpengs/qq-farm-bot/commit/cc78f2b6a4d7dc871e5c5c9746c863940cc1114e)，保留本项目的每账号 Worker、请求队列与应用宝换码重连。

## 版本与协议

系统配置增加 `wxClientVersion`，与 QQ 的 `clientVersion` 分别保存。两者默认均为 `1.15.0.2_20261001`。旧配置缺少微信字段时补微信默认值，QQ 自定义版本不会被复制给微信。旧面板保存时省略微信字段会保留已有微信配置。

Worker 启动消息先携带完整配置快照；连接建立时固定账号平台、版本与设备参数。WebSocket 的 `ver`、登录的 `device_info.client_version`、心跳的 `client_version` 保持一致，在线修改配置仅作用于下次使用新 Code 的连接。

| 客户端版本 | 登录流程 | 自动化启动条件 |
| --- | --- | --- |
| QQ / 微信 1.15 及之后 | `UserService.PlayerLogin` → `GlobalSceneService.PlayerSceneLogin` | 有效玩家 GID、`global_scene_id=1` 且 `farm_scene_ext_data` 非空 |
| 自定义 1.14 等旧版本 | `UserService.Login` | 登录返回有效玩家信息 |

QQ 入口使用 `scene_id=1234567`、渠道 `other-qq`；微信渠道为 `other`，没有入口上下文时省略 `scene_id`。不再硬编码 iPhone / iOS 26 / 7672 MB；只有启用设备协议且明确配置的微信设备信息才写入可选字段。

## 资源与连接生命周期

| 资源 | 版本 | SHA-256 |
| --- | --- | --- |
| QQ `tsdk.wasm` | v3.9.0.1792070537 | `837bd271557dc9a21d5cd28b66076ea012eb39a4f4cbe298f529716469c087fc` |
| 微信 `tsdk-wx.wasm` | v3.9.0.1792070005 | `1a9416db8b328e8957a079c583ffc5fc7e48d6af8c45aa40d9969dd68157beca` |

启动前校验实际文件，成功后诊断返回实际加载路径与 SHA-256。WebSocket 握手限时 20 秒，整个登录初始化限时 60 秒，玩家 / 场景 RPC 分别限时 20 秒。登录失败、握手错误、关闭和心跳超时统一清理当前连接，只上报一次断线；过期连接的初始化、事件和回包不会影响新连接。

心跳无响应时间、请求队列年龄及空闲等待使用 `performance.now()`；展示时间戳与服务端时间同步仍使用墙钟。Worker 不自动复用旧 Code；应用宝重连由主进程重新取得 Code 后启动 Worker。

## 验证与部署

```bash
pnpm -C core test
pnpm -C web test
pnpm build:web
pnpm -C web test:e2e --reporter=line
```

核心回归使用真实 Protobuf 编解码覆盖 QQ、微信别名、现代 / 旧登录、场景失败、配置广播、旧回包、握手错误去重、初始化超时和系统时间跳变。TSDK 测试执行实际 QQ / 微信 WASM 的初始化、加解密、身份绑定和实例隔离。部署还须检查实际版本、健康、前端资源、账号与用户数据、持久化任务，以及已有账号是否恢复游戏连接。

升级前保留旧镜像、源码和持久卷备份，失败时恢复旧镜像与原 Compose 配置。ACEVM 等浏览器专用能力仍受 Node.js 宿主限制；离线回归与短时在线观察不能证明长期稳定，也不能保证解决所有掉线。本次未合入上游土地选地界面改造。
