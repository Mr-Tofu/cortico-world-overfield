# 开放空间 / OverField · Coopanion World

给 [Coopanion](https://github.com/Pal-AI-Lab/Coopanion) 桌宠用的《开放空间 / OverField》扩展。

> 源码：<https://github.com/Mr-Tofu/cortico-world-overfield>

它做三件事：

1. **读聊天**：从游戏自己的 TCP / protobuf 协议里读，不截图、不做 OCR、不注入游戏进程。
2. **推事件**：把私聊、提到你、关键词、场景变化、位置变化、好友上下线、本人资料变化推给桌宠，让桌宠知道游戏里发生了什么。
3. **回消息**：桌宠可以用 `of_chat_send` 回附近 / 世界 / 私聊。

> **按频道 / 私聊的聊天归档不在这里。** 那部分已经移到同家族的
> **开放空间聊天** World；它跟着本 World 的抓包 feed 写归档，并提供只读查询。
> 本 World 只保留实时事件和回复（原始 `chat.jsonl` 仍由抓包/中转进程产生）。

---

## 目录

- [它解决什么](#它解决什么)
- [先选模式](#先选模式)
- [工作原理](#工作原理)
- [两种聊天读取方式：利弊](#两种聊天读取方式利弊)
- [能拿到什么](#能拿到什么)
- [安装](#安装)
- [快速开始：被动抓包](#快速开始被动抓包)
- [本地中转：可读 + 可发](#本地中转可读--可发)
- [事件推送](#事件推送)
- [聊天记录：去「开放空间聊天」](#聊天记录去开放空间聊天)
- [配置](#配置)
- [安全与隐私](#安全与隐私)
- [已知限制](#已知限制)
- [免责声明 / 仅供学习 / AI 生成](#免责声明--仅供学习--ai-生成)
- [开发与测试](#开发与测试)
- [English](#english)
- [License](#license)

---

## 它解决什么

桌宠平时只能看见屏幕，或者靠你转述。这个扩展让它在**不截图、不 OCR** 的前提下，直接知道：

- 谁在附近 / 世界 / 队伍 / 公会说话，谁私聊了你；
- 有没有人提到你的角色名，或者说了你关心的关键词；
- 你换了场景 / 频道，现场有几个人；
- 你自己走到哪了（可选，默认关）；
- 好友谁上线 / 下线；
- 你自己的等级、世界等级、签名有没有变。

桌宠可以按这些事件决定要不要回一句。回复走游戏协议（relay 模式）或剪贴板（capture 模式下只能回附近频道）。

**只支持 Windows + 官服 PC 客户端。** 不碰模拟器、不碰主机、不碰国际服的其他版本。

### 这个仓库不包含什么

同家族的另外两个 World 是独立项目，本包不依赖、也不包含它们：

- `开放空间聊天`：接手本 World 的聊天记录 / 归档查询；
- `开放空间家具`：家具摆放实验，不属于本包。

---

## 先选模式

| 你想要的 | 选什么 |
|---|---|
| 只让桌宠知道游戏里发生了什么，不改网络 | `capture`（默认） |
| 还要让桌宠回世界 / 私聊消息 | `relay` |
| 不想装 Npcap / 不想给抓包权限 | 这个扩展暂时不适合你 |

`capture` 是**被动抓包**：只读网卡上已经存在的包，不改 hosts、不改游戏连接。
`relay` 是**本地中转**：把区服下发劫持到本机，再转发给真实网关，因此可以往游戏连接里写聊天请求。

---

## 工作原理

### 1. 游戏侧

游戏客户端和区服之间是一条 TCP 连接，消息是：

```
uint16 BE headLen | PacketHead(protobuf) | body
```

`PacketHead.flag == 1` 时 body 是 snappy 压缩。聊天、场景、好友、资料、位置同步都在同一条连接上，按 `msgId` 区分。

### 2. 两条取数链路

**capture（默认）**

```
游戏 <-> 网关 TCP
        |
        |  Npcap 被动复制（只读）
        v
bridge/main.mjs  ->  chat.jsonl + status.json
        |
        v
Coopanion World  ->  事件推送 / 工具
```

- 通过 Npcap 打开网卡，BPF 只留网关端口段（默认 `11000-11100`）；
- 自己重组 TCP、解帧、解 protobuf；
- 不发送任何包，不写 hosts，不碰游戏进程内存。

**relay（可选）**

```
游戏 -> 127.0.0.1:18881 (dispatch) -> 改写 gate 地址 -> 127.0.0.1:18882 -> 真实网关
                                      |
                                      +-> 控制端口 18883：发送 / 好友 / 私聊历史
```

- `relay/setup-hosts.cmd` 把 `dsp-prod-of.inutan.com` 指到 `127.0.0.1`；
- 本地 dispatch 收到区服下发后，把 gate 地址改写成 `127.0.0.1:18882`；
- 18882 做 TCP 转发，同时解析双向帧；
- 需要发送时，向客户端→服务器方向注入 `SendChatMsgReq`（好友 / 私聊历史也是注入请求）。

**relay 会改流量。** 改的目的只有一个：让桌宠能读、能回聊天。它不改战斗数值、不改资源、不改掉落，也不自动操作角色。但它确实改动了网络链路，存在账号风险；不能接受就不要用 relay。

### 3. World 侧

`src/world.js` 只做：

- 启动 / 停止 capture 或 relay 进程；
- tail `chat.jsonl`，维护最近消息、场景、好友、资料、位置；
- 按开关推事件；
- 提供工具给桌宠。

### 4. 明确不做

- 不截图、不做 OCR；
- 不读写游戏进程内存；
- 不注入 DLL / 不调试游戏；
- 不自动打怪、自动采集、自动任务；
- 不伪造战斗 / 资源 / 掉落；
- 不把按频道 / 私聊的聊天归档写进本 World；抓包/中转仍会产出原始 `chat.jsonl`，供事件和
  `开放空间聊天` 使用。

---

## 两种聊天读取方式：利弊

### 共同点

- 都从游戏协议读，频道、时间、昵称、正文、表情都是结构化的；
- 都不需要截图或 OCR；
- 都能触发同一套事件推送；
- 都能用 `of_chat_read` 按需读最近消息。

### capture 被动抓包

**优点**

- 只读，不改 hosts、不改游戏连接；
- 装好 Npcap 就能用，不需要每次配置；
- 游戏更新只要协议没大改，通常还能用；
- 账号风险最低。

**缺点**

- 只能读，不能发世界 / 私聊；
- 需要 Npcap（安装时建议不勾“限制普通用户”的选项，否则要管理员）；
- 网卡选错、VPN / 加速器 / 双网卡时可能抓不到；
- 看不到没有经过本机网卡的流量。

### relay 本地中转

**优点**

- 可读可发：附近 / 世界 / 私聊都能回；
- 可以主动拉好友列表、私聊历史；
- 不依赖 Npcap 的网卡选择，走本地 TCP；
- 抓到的内容和 capture 基本一致。

**缺点**

- **会改流量**：hosts + dispatch 改写 + TCP 转发 + 聊天注入；
- 需要一次 hosts 配置，并且每次先启动 relay 再登录；
- 游戏更新可能改 dispatch / gate 协议，relay 会先坏；
- 账号风险高于 capture；
- 传送（`TransmitSceneReq`）即使服务器回执成功，也不会真正换场景，所以本版本不提供传送工具。

### 对照表

| | capture | relay |
|---|---|---|
| 读聊天 | ✅ | ✅ |
| 回附近 | 剪贴板（模拟按键） | 协议发送 |
| 回世界 / 私聊 | ❌ | ✅ |
| 改 hosts | ❌ | ✅ |
| 改游戏流量 | ❌ | ✅ |
| 需要 Npcap | ✅ | ❌ |
| 账号风险 | 较低 | 较高 |

### 怎么切换

在 World 设置里改「聊天取数方式」，或直接改 `config.json`：

```json
{ "worlds": { "overfield": { "chatMode": "capture" } } }
```

从 relay 切回 capture 前，先运行 `relay/remove-hosts.cmd`，否则游戏登录会失败（因为 hosts 还指着本机）。

---

## 能拿到什么

### 已经解出来的

| 数据 | 来源 | 说明 |
|---|---|---|
| 聊天 | 1936 `ChatMsgNotice` | 频道、玩家 id、昵称、正文、表情、发送时间 |
| 历史聊天 | 1938 / 2014 | 进场景 / 开私聊时服务器附带的那批 |
| 自己发出的聊天 | 1933 `SendChatMsgReq` | relay 注入或客户端自己发 |
| 场景 | 1016 `SceneDataNotice` | 场景 id、频道、玩家名单 |
| 换频道 | 1202 `ChangeSceneChannelRsp` | 频道 id / 标签 |
| 位置 | 1206 / 1208 `PlayerSceneSyncDataNotice` | 玩家 id、char、坐标、朝向 |
| 好友 | 1740 `FriendRsp` | 好友资料、在线状态 |
| 本人资料 | 1004 / 1006 | 昵称、等级、世界等级、签名 |
| 私聊未读 | 本地统计 | 谁还没回、几条、最后一句 |

### 工具

| 工具 | 作用 |
|---|---|
| `of_chat_read` | 读最近聊天，按频道过滤 |
| `of_chat_send` | 回消息：relay 走协议；capture 只能剪贴板回附近 |
| `of_chat_bridge` | 查看 / 启动 / 停止聊天进程 |
| `of_scene` | 当前场景、频道、人数、每个人的距离 |
| `of_position` | 本人或某个玩家最后已知的位置、场景、距你多远 |
| `of_friends` | 好友列表、在线状态、等级、签名 |
| `of_player_info` | 本人 / 好友 / 同场景 / 最近说话的人的资料 |
| `of_chat_history` | 与某个玩家的私聊记录（relay 可现拉） |
| `of_unread` | 还没回的私聊，默认标记已读 |
| `of_send_keys` | 发一组按键给游戏窗口（移动 / 交互用） |
| `of_state` | 窗口是否前台、client 尺寸、聊天进程状态 |

### 事件

| 事件 | 默认 | 说明 |
|---|---|---|
| `of.chat` | 私聊 + 提到我 | 聊天；`meta.reasons` 说明为什么推 |
| `of.privateUnread` | 开 | 私聊一直没回时的提醒 |
| `of.scene` | 开 | 换场景 / 频道 |
| `of.position` | 关 | 位置推送，规则见下 |
| `of.friend` | 开 | 好友上线 / 下线 |
| `of.profile` | 开 | 本人等级 / 世界等级 / 签名变化 |

### 明确不碰的

- 战斗伤害、怪物血量、掉落、背包、货币；
- 自动寻路、自动打怪、自动采集；
- 游戏内存、DLL 注入、调试器；
- 其他玩家的账号密码、设备信息。

---

## 安装

### 1. 装 Npcap（capture 模式需要）

到 <https://npcap.com/> 下载安装。安装时：

- 勾选 **Install Npcap in WinPcap API-compatible Mode**（可选，但兼容性更好）；
- **不要**勾选 “Restrict Npcap driver's access to Administrators only”，除非你愿意每次用管理员启动 Coopanion。

装完重启一次。

### 2. 安装 World

在 Coopanion 的扩展市场 / 本地扩展目录安装 `cortico-world-overfield`。也可以手动：

```bash
npm pack
# 把生成的 cortico-world-overfield-0.8.0.tgz 放进 Coopanion 的 World 安装入口
```

### 3. 打开 World

在 Coopanion 设置里启用「开放空间」。首次启动会：

- 找到游戏窗口（进程 / 类名 / 标题）；
- 以 capture 模式启动 `bridge/main.mjs`；
- 在聊天目录（默认 `<部署目录>/overfield-chat/`，部分部署是 `<部署目录>/data/overfield-chat/`）下写 `chat.jsonl`、`status.json`。

---

## 快速开始：被动抓包

1. 先启动游戏，登录到有聊天的场景；
2. 启用「开放空间」World；
3. 让桌宠调用 `of_chat_bridge(action="status")`，确认「被动抓包 运行中」；
4. 在游戏里说一句话，再调用 `of_chat_read`，应该能看到；
5. 需要事件时，在设置里打开对应的推送开关。

如果 `status` 说「未运行」：

- 看 `overfield-chat/bridge.log` 的最后几行；
- 确认 Npcap 已安装、Coopanion 有权限打开网卡；
- 多网卡 / VPN / 加速器时，在 `of_chat_bridge` 的 `device` 参数里指定网卡描述片段。

---

## 本地中转：可读 + 可发

### 1. 加 hosts（一次性）

以管理员身份运行：

```bat
relay\setup-hosts.cmd
```

它会在 hosts 里加一行：

```
127.0.0.1 dsp-prod-of.inutan.com # coopanion-overfield-relay
```

### 2. 切到中转模式

在 World 设置里把「聊天取数方式」改成 `relay`，或改 `config.json`：

```json
{ "worlds": { "overfield": { "chatMode": "relay" } } }
```

### 3. 重新登录游戏

relay 必须先起来，否则游戏连不上区服。启用 World 后确认：

```text
of_chat_bridge(action="status")
```

看到「本地中转 运行中」再登录。

### 4. 发送

```text
of_chat_send(text="晚上好", channel=0)                 # 附近
of_chat_send(text="晚上好", channel=1)                 # 世界
of_chat_send(text="在吗", channel=2, target=12345678)  # 私聊
```

回执只代表服务器收下，不代表对方一定看到。

### 中转的限制

- 传送请求即使 `status=1` 也不会真的换场景，所以没有 `of_teleport`；
- 好友列表请求目前可能返回空列表（服务器 `status=2`），空结果不代表你没好友；
- 私聊历史请求是否成功取决于服务器是否回 `status=1`，失败时只能读抓包缓存；
- 游戏更新可能让 relay 的 dispatch / gate 改写失效，需要更新协议；
- 用完想回 capture，先运行 `relay\remove-hosts.cmd` 并重新登录。

---

## 事件推送

总开关是 `pushEnabled`。关掉后桌宠不会收到任何主动消息，只能靠工具按需读。

### 聊天

默认只推两类：

- **私聊**：有人私聊你；
- **提到我**：公共频道里出现你的角色名。

每个频道还有独立开关：

| 开关 | 默认 | 作用 |
|---|---|---|
| `pushChatPrivate` | 开 | 私聊 |
| `pushChatMention` | 开 | 提到我的角色名 |
| `pushChatKeywords` | 空 | 自定义关键词，逗号 / 空格分隔 |
| `pushChatNearby` | 关 | 附近频道每条都推 |
| `pushChatWorld` | 关 | 世界频道每条都推 |
| `pushChatTeam` | 关 | 队伍频道每条都推 |
| `pushChatGuild` | 关 | 公会频道每条都推 |
| `pushChatSystem` | 关 | 系统 / 公告 / 喇叭每条都推 |

事件 `meta.reasons` 会是 `private` / `mention` / `keyword` / `nearby` / `world` / `team` / `guild` / `system` 的组合，`meta.keywords` 是命中的关键词。桌宠可以据此决定要不要回、回到哪。

所有推送共享每分钟 20 条的上限，避免世界频道刷屏烧上下文。

### 位置

默认关。打开 `pushPosition` 后：

- **移动触发**：一次移动超过 `positionMoveMeters`（默认 10m）立即推；
- **移动间隔**：持续移动时，距上次推送至少 `positionMoveSeconds`（默认 5s）才再推；
- **定时心跳**：没怎么移动时，也会隔 `positionGlobalSeconds`（默认 120s）推一次；
- **自动模式**（`positionGlobalMode="auto"`）：连续两次心跳位置几乎没变，就把心跳间隔乘以 1.5，最多到 `positionGlobalMaxSeconds`（默认 600s）；一旦真的移动，恢复基础间隔；
- **固定模式**（`fixed`）：始终按 `positionGlobalSeconds` 推。

位置事件带 `sceneId`、`channelId`、`x/y/z`、`moved`、`reason`（`move` / `heartbeat`）。第一次拿到坐标只建立基准，不推。

要查其他玩家，用 `of_position(playerId=...)` 或 `of_position(name="...")`。坐标来自场景同步包，约 2 秒更新一次；工具只读，不会移动任何人。桌宠应该只在真的需要时调用，不要轮询。

### 场景 / 好友 / 资料

- `of.scene`：换场景 / 频道时推，带场景 id、频道、人数；
- `of.friend`：好友上线 / 下线时推；第一次拿到列表不推；
- `of.profile`：本人等级 / 世界等级 / 签名变化时推。

### 环境提示词

启动时会给桌宠一段简短的 `ENV_PROMPT.md`：先查状态、按场景选工具、回消息前先读上下文、
哪些不能做。动态值只放当前模式 / 本人 / 场景 / 未读 / 位置，不把聊天正文塞进系统前缀。
模板在 `src/ENV_PROMPT.md`，可以在 WebUI 的提示词页整份覆盖。

---

## 聊天记录：去「开放空间聊天」

本 World **不再写** `<memoryDir>/<频道>.jsonl` 这种按频道 / 私聊的归档；它仍然会产出抓包/中转的原始事件流 `chat.jsonl`（`status.json` 旁边），这是实时推送和聊天插件归档的共同数据源。归档由 `开放空间聊天` 接手：

1. 它 tail 本 World 的 `chat.jsonl`；
2. 按频道 / 按私聊写 `<memoryDir>/<频道id>-<名字>.jsonl` + `.md`；
3. 提供 `of_chat_archive` 按频道、玩家、关键词、时间查询；
4. 它不抓包、不推送、不叫醒、不发消息。

所以：

- 只想让桌宠知道事件、不关心历史 → 只装本 World；
- 想保留 / 查询聊天记录 → 再装 `开放空间聊天`；
- 两个都装时，本 World 必须开着（隐藏也算开着），聊天插件才有 feed 可读。

`开放空间聊天` 的归档目录默认是 `<部署目录>/workspace/开放空间聊天`，可以在它的设置里改；它也会读旧的 `worlds.overfield.memoryDir`，方便接手已有记录。

---

## 配置

所有配置都在 `config.json` 的 `worlds.overfield` 下，也可以在 World 面板里改。

| 键 | 默认 | 说明 |
|---|---|---|
| `chatMode` | `capture` | `capture` / `relay` |
| `pushEnabled` | `true` | 事件推送总开关 |
| `pushChatPrivate` | `true` | 私聊推送 |
| `pushChatMention` | `true` | 提到我 |
| `pushChatKeywords` | `""` | 自定义关键词 |
| `pushChatNearby` | `false` | 附近每条 |
| `pushChatWorld` | `false` | 世界每条 |
| `pushChatTeam` | `false` | 队伍每条 |
| `pushChatGuild` | `false` | 公会每条 |
| `pushChatSystem` | `false` | 系统 / 公告 / 喇叭每条 |
| `pushScene` | `true` | 场景 / 频道变化 |
| `pushFriends` | `true` | 好友上下线 |
| `pushProfile` | `true` | 本人资料 |
| `pushPosition` | `false` | 位置推送 |
| `positionMoveMeters` | `10` | 移动多少米立即推 |
| `positionMoveSeconds` | `5` | 移动中最小推送间隔 |
| `positionGlobalSeconds` | `120` | 心跳间隔 |
| `positionGlobalMode` | `auto` | `auto` / `fixed` |
| `positionGlobalMaxSeconds` | `600` | auto 模式心跳上限 |
| `autoHideMinutes` | `20` | 多久没调用工具就自动对 agent 隐藏；0 = 不自动 |
| `respectCuaGate` | `true` | 遵守「电脑操作」开关 |

隐藏的调试项：`chatEnabled`（false = 不启动抓包/中转）、`chatDir`（自定义 feed 目录）、`selfName`（角色名兜底）。

---

## 安全与隐私

- **会读其他玩家的聊天。** 附近 / 世界 / 私聊的昵称、玩家 id、正文都会进入桌宠上下文（按你的推送开关）。
- **记录由你决定。** 本 World 不写按频道 / 私聊的归档，但抓包/中转会在 `chat.jsonl` 里保留原始事件流（供事件和聊天插件使用）；`开放空间聊天` 默认把归档写到工作区，可以在它的设置里关掉 `archiveEnabled`，或把 `memoryDir` 指到你控制的位置。
- **relay 会改流量。** 它只改聊天链路，不改战斗 / 资源；但仍然可能违反游戏 ToS，存在封号风险。
- **不要把本工具用于**：骚扰、人肉、跨平台关联账号、监视特定玩家、绕过游戏限制、商业代练/打金。
- **不要把 `chat.jsonl` / 归档 / 日志发给不信任的人**：里面有玩家 id、昵称、聊天内容。
- **不要在公共电脑上长期登录**：relay 的 hosts 行和本地端口只绑定 `127.0.0.1`，但本机其他程序仍可能访问控制端口。

---

## 已知限制

- 只支持 Windows + 官服 PC 客户端；
- capture 需要 Npcap；relay 需要一次 hosts 配置；
- 游戏更新可能改协议，导致读不到或 relay 失效；
- 位置同步约 2 秒一次，`of_position` 不是实时坐标；
- 传送协议不可用（服务器接受请求但不下发场景切换）；
- 好友列表 / 私聊历史的主动拉取依赖服务器回执，可能返回空；
- 剪贴板回复只支持附近频道，并且会短暂占用剪贴板（默认会恢复）；
- 世界频道人多时，即使开了推送也会被每分钟 20 条限流；
- `of_send_keys` 会抢焦点，使用前确认游戏窗口在前台。

---

## 免责声明 / 仅供学习 / AI 生成

**非官方项目。** 与《开放空间 / OverField》的开发商、发行商、Coopanion 官方均无关联。

**仅供学习与个人研究。** 使用本扩展可能违反游戏服务条款，导致账号被限制或封禁；也可能因为协议变化、抓包错误、relay 配置错误而影响游戏登录。风险由使用者自己承担。

**不要用于盈利、代练、打金、骚扰、监视他人或绕过游戏限制。**

**AI 生成披露：** 本项目的代码、文档和测试大量由 AI 辅助生成，并经过人工整理与测试。它不保证没有错误，也不构成任何形式的担保。使用前请阅读 [`DISCLAIMER.md`](DISCLAIMER.md)。

---

## 开发与测试

```bash
# 语法 / 单元测试（在仓库根目录）
node test/bridge.test.mjs
node test/feed.test.mjs
node test/window.test.mjs
node test/world-integration.test.mjs

# 实机抓包（需要 Npcap + 游戏在跑）
node bridge/main.mjs --out .\tmp\capture --ports 11000-11100

# 实机中转（需要 hosts 已配置）
node relay/main.mjs --out .\tmp\relay
```

`scripts/` 里还有协议探测 / 家具实验脚本，不属于本 World 的运行时；打包时不会带进去。

---

## English

A Coopanion World for **开放空间 / OverField** (Windows, official PC client).

It reads the game's own TCP/protobuf chat through either passive Npcap capture (read-only) or a local relay (read + send), pushes game events to the pet (private messages, mentions, keywords, scene, position, friend online state, own profile), and lets the pet reply with `of_chat_send`.

Chat **recording** is not in this World anymore: the separate **OverField Chat** World tails this World's feed and writes the per-channel / per-private archive.

- No screenshots, no OCR, no game-process memory access, no DLL injection.
- `capture` does not touch the network path; `relay` redirects the dispatch domain to localhost and forwards it, only for chat. It does modify traffic and carries account risk.
- Unofficial, for learning only; read [`DISCLAIMER.md`](DISCLAIMER.md).

---

## License

MIT. See [`LICENSE`](LICENSE).
