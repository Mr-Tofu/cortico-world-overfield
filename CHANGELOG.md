# Changelog

## 0.8.0 — 2026-10-31

把「记录聊天」从主 World 拆出去，主 World 只保留实时事件与回复。

- **记录搬家**：`memoryDir` / 按频道和私聊归档 / `names.json` / 历史合并 / md 副本全部移到独立的
  「开放空间聊天」World；主 World 不再写聊天文件，也不再迁移/整理归档。
- **聊天推送改成开关制**：默认只推私聊 + 提到我；新增 `pushChatNearby`、`pushChatWorld`、
  `pushChatTeam`、`pushChatGuild`、`pushChatSystem` 和 `pushChatKeywords`，事件 `meta.reasons`
  说明为什么推。原来的 `wakeOnMention` / `wakeOnPrivate` / `wakeKeywords` / `memory*` 配置不再使用。
- **位置推送**：新增 `of.position` 事件和 `pushPosition`（默认关）。支持移动距离 / 移动间隔 /
  定时心跳；`auto` 模式下连续没动会拉长心跳间隔（上限可配），移动后恢复。第一次定位只建基准不推。
- **位置查询**：新增 `of_position` 工具，可读本人或指定 `playerId` / `name` 的最后已知坐标、
  场景和距你多远；只读，不移动任何人。
- **环境提示词**：新增 `src/ENV_PROMPT.md`，告诉桌宠先查状态、按场景选工具、回消息前先读上下文，
  以及 capture / relay 的能力边界和禁止用途；动态值只放模式、本人、场景、未读、位置。
- **场景/好友/资料默认开**：`pushScene`、`pushFriends`、`pushProfile` 默认改为开启；仍可单独关闭。
- **移除传送**：`of_teleport` 删除。协议传送即使服务器回执成功也不会真正换场景，保留只会误导。
- **保留两种取数方式**：capture 与 relay 都保留；relay 只用于读聊天/回消息，README 和免责声明
  写清楚它改流量、改的目的和账号风险。
- **打包**：版本 0.8.0；仍是 `src/`、`bridge/`、`relay/`、表情表/图标和文档，不带测试、开发脚本、
  家具资源；聊天记录相关的代码不再出现在主包里。
- 测试：bridge 9、feed 19、window 4、world-integration 2、relay 1；聊天插件 archive 7、legacy 1。

## 0.7.0 — 2026-10-31

首个面向扩展市场的公开版本。本包只有「开放空间」一个 World；「开放空间聊天」「开放空间家具」是独立的 World，不在本包内。

- **两种取数方式写清楚**：README 补充 capture / relay 的原理、优缺点、适用场景和风险对照；默认仍是 `capture`。
- **历史聊天归档**：进场景/开私聊时服务器补发的历史也会落盘，只归档不唤醒；同秒同人同文去重，按时间插入，跨文件也只留一份。
- **私聊/花园文件名带名字**：`私聊-<id>-<名字>.jsonl`、`<花园id>-<主人名>.jsonl`；名字后到也会补上；`names.json` 重启后还原。
- **记忆目录**：默认改到 `<部署目录>/workspace/开放空间聊天`，换 `memoryDir` 自动搬家、同名文件按行合并；每条消息另写一份 `.md` 供人读。
- **默认不唤醒**：聊天只落盘，`wakeOnMention` / `wakeOnPrivate` / `wakeKeywords` 默认全关；`autoHideMinutes` 默认 20 分钟。
- **记录过滤**：`memorySkipChannels` 默认排除世界频道，启动时也清理已有文件里的这些频道。
- **文档与合规**：补免责声明、仅供学习说明、AI 生成声明；补充隐私边界（聊天只在开启唤醒/推送时才进入模型上下文）。
- **打包**：npm 包只带运行所需的 `src/`、`bridge/`、`relay/`、表情表/图标和文档，不带开发脚本、测试和家具资源。
- **已知限制**：`of_teleport` 仍只完成服务器接受、客户端不切场景；空好友请求被拒；中转实机端到端未完全验证。
- 测试：bridge 9、feed 32、window 4、world-integration 2、relay 1，共 48 项通过。

## 0.6.1 — 2026-10-29

- **重启不再重放旧私聊**：`ChatFeed` 第一次扫描 `chat.jsonl` 时只装载旧消息供 `of_chat_read` 使用，
  不再推送 `of.chat`、不再把旧私聊算成未读；只有进程启动前后 2 分钟内的消息才推送。
- **hosts 状态不再冻结**：relay 每 30 秒重新解析一次 `dsp-prod-of.inutan.com`，`/status` 也实时刷新，
  `hosts：未配置` 不会再是启动时的旧值。
- **坐标支持负数**：protobuf varint 保留 64 位；`Vector3` 的负 int32 不再溢出成 `18446744073709552000`。
- **`of_scene` 带 id 和快照时间**：每个玩家显示 `playerId`，报快照时间与“多少分钟前”，并区分
  “自己坐标未同步/多少人没有坐标”；名单仍只在换场景时更新。
- **回执不再当成功**：`of_chat_send` 改为“已发出”，明确回执不代表对方收到；
  `of_teleport` 解析 `TransmitSceneRsp.status`，status=2 报拒绝，status=1 报“服务器接受但客户端不切场景、人物没动”。
- **历史真的可用**：实测 `PrivateChatMsgRecordRsp` 返回 `status=1` + 40 多条真实私聊；解码器保留直接布局，
  并兼容 `MsgRecord` 再包一层的情况。
- **好友是请求问题不是解码问题**：空 `FriendReq` 收到 `FriendRsp{status=2}`、0 人；解码器保留
  直接/嵌套两种布局，工具会显示服务器 status。
- **原始回包落盘**：relay 把 `1739/1740/2013/2014/2315/2316` 的 body hex 追加到
  `overfield-chat/protocol-raw.jsonl`，方便下次直接对 schema。
- 新增 `scripts/inspect-proto.mjs`（从游戏元数据找 protobuf 描述符）和 `scripts/dump-frames.mjs`
  （被动抓指定 msgId 的原始帧）。

## 0.6.0 — 2026-10-28

- **设置瘦身**：从 ~35 个键删到 11 个，只保留真正需要人选的（取数方式 + 每类数据开关 + 电脑操作）。
  删掉可以自动填/内置的键：`windowTitle`、`processName`、`baseSize`、`chatInput`、各 `*DelayMs`、
  `holdMs`、`restoreClipboard`、`chatEnabled`、`chatDir`、`bridgePorts`、`bridgeDevice`、
  `relayDispatchPort/GatePort/ControlPort`、`relayDispatchIp`、`pushChannels`、`mentionChannels`、
  `pushRatePerMinute`、`unreadDelaySeconds/RepeatMinutes/MaxAgeMinutes`、`selfName`、
  `channelNames`、`emotionMap`。旧配置里的这些键会被忽略。
- **窗口检测按实际游戏来**：进程 `launcher.exe` / `OverField.exe`、窗口类 `UnityWndClass`、标题含
  「开放空间 / OverField」；排除浏览器和 Coopanion 自己的窗口。`native.js` 的窗口枚举多了
  `className`，`window.js` 打分逻辑可单测。
- **每种数据一个推送开关**：`pushMentions`、`pushPrivate`、`pushUnread`、`pushScene`、
  `pushFriends`、`pushProfile`，外加总开关 `pushEnabled`。
- **新增推送事件**：`of.scene`（换场景/频道）、`of.friend`（好友上下线）、`of.profile`（本人资料变化），
  默认关闭；`feed.js` 用 `onState` 只在真的变化时发。
- 表情完全内置（不再有 `emotionMap` 输入框）。

## 0.5.0 — 2026-10-28

- **表情表**：从游戏的 YooAsset 静态配置里解出 `Chat.bytes`（表情 id）和 `String_Simplified.bytes`
  （文本表），生成 `assets/emotions.json`，249/310 个表情有了名字，显示成 `[表情:吃瓜]`、`[表情:菲·憧憬]`。
  新增 `scripts/emotions.mjs`：读清单找到配置包 → 解 UnityFS → 抽 TextAsset → 重新生成，游戏更新后可重跑。
- **私聊未读提醒**：`feed.js` 按玩家记录未回的私聊（收到 +1；回复、打开历史清零）；
  World 定期检查并推 `of.privateUnread`（谁、几条、最后一句），带冷却与过期。
- 新增工具 `of_unread`：列出未读私聊，默认标记已读，可 `markRead=false` 只偷看或只处理一个人。
- 新增配置：`unreadReminder`、`unreadDelaySeconds`、`unreadRepeatMinutes`、`unreadMaxAgeMinutes`。
- `of_state` 增加「私聊未读：N 人 / M 条」；`of_chat_send` / `of_chat_history` 会清掉对应未读。
- `describe.json` 增加 `of_unread` 与 `of.privateUnread` 事件说明。

## 0.4.0 — 2026-10-28

- 解码场景与位置：`SceneDataNotice`（场景/频道/在场玩家）、`PlayerSceneSyncDataNotice`（`pos/rot` 定点数）。
- 解码玩家资料：`PlayerBriefInfo`、`PlayerMainDataRsp` 的等级/签名/世界等级/性别。
- 解码好友：`FriendRsp → FriendBriefInfo`（备注、亲密度、在线、等级、签名、公会）。
- 解码私聊记录：`PrivateChatMsgRecordReq/Rsp`，抓包时按最近一次请求的目标归属。
- 新增工具：`of_scene`、`of_friends`、`of_player_info`、`of_chat_history`、`of_teleport`。
- 中转新增请求注入与控制接口：`/friends`、`/history`、`/teleport`（`FriendReq`、`PrivateChatMsgRecordReq`、`TransmitSceneReq`）。
- 表情：`emotionMap` 配置 + `assets/emotions.json`，`[表情:名称]`；未映射显示 `[表情#id]`。
- 位置同步最多每 2 秒落盘一次，避免刷爆 feed。

## 0.3.0 — 2026-10-28

- **删除截图/OCR 聊天读取**：不再截屏、不再 OCR、不再读面板坐标。`of_chat_read` 只读协议。
  同时删除了 `panel.js` / `ocr.js` / `png.js` / `text.js` / `ocr-win.ps1` 和 `native.js` 里的 GDI 截图代码。
- **新增本地中转模式**（`chatMode=relay`）：本地区服下发改写 + 网关 TCP 中转，
  读取和被动抓包一致，另外支持**协议发送**附近/世界/私聊（`of_chat_send` 的 `channel`/`target`）。
- 新增 `relay/setup-hosts.cmd` / `remove-hosts.cmd`（一次性 hosts 配置）。
- 发送走 `SendChatMsgReq` 注入，处理 seq/packetId 冲突改写，并等待 `SendChatMsgRsp` 回执。
- `of_chat_bridge` 增加 `mode` 参数，状态区分「被动抓包 / 本地中转」。
- `of_state` 去掉聊天面板检测和 HUD 坐标，改为报聊天进程状态。
- 配置重组：窗口/输入、聊天、推送三组；删除 OCR/面板/坐标相关键。
- README 重写，补上「能拿到什么」、两种模式对比、中转限制和隐私边界。

## 0.2.0 — 2026-10-28

- 新增聊天桥接：被动抓取游戏网关 TCP（Npcap），按游戏协议解出 `ChatMsgNotice` /
  `ChatMsgRecordInitNotice` / `SendChatMsgReq`，落成 `chat.jsonl` + `status.json`。
- `of_chat_read` 改为读真实聊天；`of_chat_bridge` 管理桥接。
- 新增 `of:chat` 事件：私聊无条件推送；附近/世界只有提到角色名或关键词才推送。
- 支持表情消息、登录包读取本人角色名、历史消息只入缓存。

## 0.1.0 — 2026-10-28

- 首个版本：`of_send_keys`、`of_chat_send`（剪贴板附近）、`of_chat_read`（聊天面板 OCR）、`of_state`。
