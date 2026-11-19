# 私聊语音与视频通话

在网页或已安装的 PWA 中打开一对一私聊，点电话图标发起语音通话，点摄像机图标发起视频通话。语音只请求麦克风权限。视频会在发起呼叫或点击「接听视频通话」后请求摄像头和麦克风权限。通话中可以独立关闭摄像头或静音麦克风。挂断、退出账号或离开聊天工作区会释放设备。聊天工作区内可以切换会话。

在有前后摄像头的手机上，点通话栏的「切换摄像头」即可换镜头。切换时仍可交谈，麦克风会保留当前的静音设置。

来电保持 45 秒，单次通话最多 1 小时。启用 Web Push 后，接收方可以从系统通知打开私聊，在来电仍有效时接听。通知送达受操作系统和浏览器影响。双方都需要保持聊天页面运行以持续通话。网页和 PWA 支持视频通话，Capacitor Android 客户端沿用原有的通话限制。

## 连接与隐私

私聊顶栏的连接方式适用于语音和视频。默认使用 Cloudflare STUN 建立 P2P 直连。部署已配置 TURN 时，约 12 秒仍无法直连会触发中继重试，也可以手动选择 TURN 强制中继。重新协商期间音视频会短暂中断，采集设备、静音和摄像头开关状态会保留。

浏览器通过 WebRTC 加密传输音视频。Worker 和 VoiceCall DO 负责 SDP、ICE 和通话控制。通话音视频不会写入聊天记录。P2P 通话会向对端提供网络候选地址。希望避免向对方暴露自己的公网地址时，可在呼叫或接听前选择 TURN。只有已接听通话的参与窗口能够获取短期 TURN 凭据。

## Cloudflare TURN 配置

Cloudflare 当前 [Realtime 定价](https://developers.cloudflare.com/realtime/sfu/platform/pricing/)：SFU 与 TURN 每月共享前 1,000 GB 免费出站流量，超出 $0.05/GB；Worker、D1、KV 与 DO 另外计量。该额度不是每个 TURN Key 各自拥有 1,000 GB，也不是无限免费。

在目标账户创建或复用 TURN Key。通过官方 API 创建时，Cloudflare 管理 Token 需要 `Calls Write` 权限。创建接口：`POST /accounts/{account_id}/calls/turn_keys`，请求体 `{"name":"edgechat-voice"}`。保管返回的 `uid` 与 `key`；已有 Key 不能回读长期秘密，丢失时应在面板确认后创建新 Key，不要重复部署就创建 Key。

将两项长期信息注入 Worker Secret，禁止放入前端、源码或 wrangler 明文配置：

```bash
npx wrangler secret put EDGECHAT_TURN_KEY_ID
npx wrangler secret put EDGECHAT_TURN_API_TOKEN
```

`EDGECHAT_TURN_KEY_ID` 是 TURN Key 的 `uid`；`EDGECHAT_TURN_API_TOKEN` 是该 Key 返回的 `key`，不是用于部署的 `CLOUDFLARE_API_TOKEN`。Worker 调用 `https://rtc.live.cloudflare.com/v1/turn/keys/{uid}/credentials/generate-ice-servers` 生成 3,600 秒短期凭据，每个通话参与者复用一次签发，结束后删除 DO 缓存。

本仓库的生产工作流使用 `--keep-vars` 保留已有 Worker Secrets。如需启用 TURN，请在 Cloudflare 为现有 Worker 成对配置以上两项 Secret。未配置时使用 P2P，不能建立直连的通话会提示连接失败。

保留 `wrangler.example.toml` 中的 `VOICE_CALL` binding 与 `v4` / `VoiceCall` SQLite DO 迁移，正常 Actions 自动部署它们；已有 D1 / KV / R2 复用，音视频协议本身沿用原有 DO 存储结构。演示模式不连接通话服务。

## 控制协议

- `GET /api/calls/:roomId/config`：仅 DM 双方，返回 STUN、`turnAvailable` 与 `videoAvailable`。
- `GET /api/calls/:roomId/pending`：仅接听方可取回仍在响铃的邀请，其余情况返回 `{"invite":null}`。客户端打开推送后用它恢复接听界面。
- `POST /api/calls/:roomId/action`：带 `type/callId/clientId`；`start/accept/restart` 带 `mode: auto|relay`；`offer/answer/ice` 带当前 `revision`，以及 `sdp` 或 `candidate`。`start/accept` 还带 `media: audio|video`。旧客户端缺省为 `audio`；视频只能由明确同意视频的客户端接听。其他动作是 `reject/hangup/heartbeat`。
- `GET /api/calls/:roomId/ice?callId=...&clientId=...`：仅已接听且占用该窗口的参与者，返回临时 ICE 配置，响应 `Cache-Control: no-store`。
- Inbox 帧：`call_invite/call_negotiate/call_signal/call_ended`，都有 `callId/roomId/media`；协商与信令带 `revision`。客户端必须按自己的用户与窗口 ID 过滤。

每个 API 动作重新校验会话、DM 两人成员、双方有效状态及双向拉黑。管理员的历史查看权限不赋予参与通话权。Inbox 发送通话帧前重新验证对应会话；旧版无会话元数据连接不接收通话信令，但原聊天推送继续保留。

每个私聊的 DO 串行控制通话，每个用户的 Inbox 以事务维护一个通话席位，避免跨私聊并发。双方约 25 秒心跳一次；缺任意一方心跳 75 秒，或封禁/拉黑后的 alarm 复验失败，会终止通话并释放席位。席位有独立截止时间，异常停止不会永久占用。

## 验收

两个真实账号、不同网络分别检查 P2P 双向音视频、麦克风与摄像头授权/拒绝、接听/拒绝/无人接听、静音、停用与恢复摄像头、挂断、已配置时的自动 TURN 回退与手动双向切换。多窗口只允许一个接听；拉黑双方不得发起或继续协商。手机还需核对浏览器自动播放、PWA 通知进入来电、锁屏和网络切换。
