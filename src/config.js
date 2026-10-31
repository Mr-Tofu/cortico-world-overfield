/** `worlds.overfield` configuration and its WebUI form groups. */

import { CHANNEL_NAMES } from './feed.js';

export const OVERFIELD_ID = 'overfield';

/**
 * The only things a person actually has to choose. Everything the extension can
 * read by itself — the game window, the chat data directory, gateway ports,
 * emotes, the player's own name, input timing — lives in FIXED below and is not
 * a setting.
 */
export const DEFAULTS = {
  enabled: false,
  chatMode: 'capture',
  // Master switch for every proactive event.
  pushEnabled: true,
  // Chat pushes: private + mention are on by default; each channel has its own switch.
  pushChatPrivate: true,
  pushChatMention: true,
  pushChatKeywords: '',
  pushChatNearby: false,
  pushChatWorld: false,
  pushChatTeam: false,
  pushChatGuild: false,
  pushChatSystem: false,
  // State pushes.
  pushScene: true,
  pushFriends: true,
  pushProfile: true,
  // Position pushes: off by default; every knob is configurable.
  pushPosition: false,
  positionMoveMeters: 10,
  positionMoveSeconds: 5,
  positionGlobalSeconds: 120,
  positionGlobalMode: 'auto',
  positionGlobalMaxSeconds: 600,
  respectCuaGate: true,
  // 没动作多久就自动「对 agent 隐藏」（0 = 不自动）。
  autoHideMinutes: 20,
};

// Fixed internals: transport ports follow relay/setup-hosts.cmd, timings are
// the ones the clipboard fallback was calibrated with, and the chat window is
// found from the process itself (see window.js).
const FIXED = {
  baseSize: [1280, 720],
  chatInput: [205, 692],
  focusDelayMs: 120,
  channelDelayMs: 350,
  clickDelayMs: 120,
  pasteDelayMs: 120,
  sendDelayMs: 180,
  holdMs: 80,
  restoreClipboard: true,
  bridgePorts: '11000-11100',
  bridgeDevice: '',
  relayDispatchPort: 18881,
  relayGatePort: 18882,
  relayControlPort: 18883,
  relayDispatchIp: '',
  pushRatePerMinute: 20,
  unreadDelaySeconds: 30,
  unreadRepeatMinutes: 5,
  unreadMaxAgeMinutes: 120,
  channelNames: CHANNEL_NAMES,
  selfName: '',
};

function splitKeywords(value) {
  if (typeof value !== 'string') return [];
  return value
    .split(/[,，;；、\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 50);
}

function numberIn(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

/** Read every setting with a clamp; the live `cfg` object is safe to edit. */
export function settings(cfg = {}) {
  const globalSeconds = numberIn(cfg.positionGlobalSeconds, 10, 3600, DEFAULTS.positionGlobalSeconds);
  const globalMaxSeconds = Math.max(
    globalSeconds,
    numberIn(cfg.positionGlobalMaxSeconds, 30, 7200, DEFAULTS.positionGlobalMaxSeconds),
  );
  return {
    ...FIXED,
    chatMode: cfg.chatMode === 'relay' ? 'relay' : 'capture',

    pushEnabled: cfg.pushEnabled !== false,

    // 聊天推送：默认私聊 + 提到我；每个频道一个独立开关。
    pushChatPrivate: cfg.pushChatPrivate !== false,
    pushChatMention: cfg.pushChatMention !== false,
    pushChatKeywords: splitKeywords(cfg.pushChatKeywords),
    pushChatNearby: cfg.pushChatNearby === true,
    pushChatWorld: cfg.pushChatWorld === true,
    pushChatTeam: cfg.pushChatTeam === true,
    pushChatGuild: cfg.pushChatGuild === true,
    pushChatSystem: cfg.pushChatSystem === true,

    pushScene: cfg.pushScene !== false,
    pushFriends: cfg.pushFriends !== false,
    pushProfile: cfg.pushProfile !== false,

    pushPosition: cfg.pushPosition === true,
    positionMoveMeters: numberIn(cfg.positionMoveMeters, 1, 1000, DEFAULTS.positionMoveMeters),
    positionMoveSeconds: numberIn(cfg.positionMoveSeconds, 1, 300, DEFAULTS.positionMoveSeconds),
    positionGlobalSeconds: globalSeconds,
    positionGlobalMode: cfg.positionGlobalMode === 'fixed' ? 'fixed' : 'auto',
    positionGlobalMaxSeconds: globalMaxSeconds,

    autoHideMinutes: cfg.autoHideMinutes === undefined
      ? DEFAULTS.autoHideMinutes
      : numberIn(cfg.autoHideMinutes, 0, 1440, DEFAULTS.autoHideMinutes),
    respectCuaGate: cfg.respectCuaGate !== false,

    // Hidden escape hatches: tests skip the bridge, and a custom chat directory
    // stays supported for debugging. Neither is shown on the World page.
    chatEnabled: cfg.chatEnabled !== false,
    chatDir: typeof cfg.chatDir === 'string' ? cfg.chatDir.trim() : '',
  };
}

/** Config groups for the World page; keys are paths inside `worlds.overfield`. */
export function overfieldConfigGroups(language = 'zh') {
  const zh = language !== 'en';
  const title = zh
    ? {
      chat: '聊天读取',
      mode: '聊天取数方式',
      modeHint: 'capture=被动抓包（只读，装好 Npcap 即用）；relay=本地中转（可读可发，需要一次 hosts 配置）。relay 会把区服下发劫持到本机再转发，目的是读写聊天/回消息，不碰战斗和资源；不想改流量就用 capture。',

      chatPush: '聊天推送',
      chatPushHint: '抓到的聊天哪些要主动告诉桌宠。默认只推私聊和提到你的内容；世界频道默认不推，避免刷屏。',
      private: '私聊',
      privateHint: '有人私聊你时推一条；默认开。',
      mention: '提到我',
      mentionHint: '公共频道里出现你的角色名时推一条；默认开。',
      keywords: '自定义关键词',
      keywordsHint: '聊天里出现这些词就推（公共频道和私聊都算）；逗号或空格分隔，留空 = 不按关键词推。',
      nearby: '附近频道',
      nearbyHint: '附近频道每条都推；默认关（提到你时仍会推）。',
      world: '世界频道',
      worldHint: '世界频道每条都推；默认关，人多时很容易刷屏。',
      team: '队伍频道',
      teamHint: '队伍频道每条都推；默认关。',
      guild: '公会频道',
      guildHint: '公会频道每条都推；默认关。',
      system: '系统/公告/喇叭',
      systemHint: '系统、公告、喇叭频道每条都推；默认关。',

      push: '状态推送',
      pushOn: '允许状态推送',
      pushOnHint: '总开关。关掉后桌宠不会收到任何主动消息，只能靠工具按需读。',
      scene: '场景变化',
      sceneHint: '换场景或换频道时推一条（谁在场、几个人）；频道切换频繁时可能吵。',
      friends: '好友上下线',
      friendsHint: '好友上线/下线时推一条；第一次拿到好友列表不会推。',
      profile: '本人资料',
      profileHint: '登录或升级、改签名时推一条自己的等级/世界等级/签名。',

      position: '位置推送',
      positionOn: '推送位置',
      positionOnHint: '默认关。打开后按下面的规则推自己的坐标，桌宠不用一直轮询 of_position。',
      moveMeters: '移动距离（米）',
      moveMetersHint: '一次移动超过这个距离就立即推一条。',
      moveSeconds: '移动间隔（秒）',
      moveSecondsHint: '持续移动时，至少隔这么久才再推一条。',
      globalSeconds: '定时心跳（秒）',
      globalSecondsHint: '没怎么移动时，也会隔这么久推一次，让桌宠知道你还在这里。',
      globalMode: '心跳模式',
      globalModeHint: 'auto = 连续多次心跳位置没变就逐渐拉长间隔；fixed = 始终按上面的固定间隔。',
      globalMax: '心跳上限（秒）',
      globalMaxHint: 'auto 模式下拉长的上限；不会超过这个间隔。',

      gate: '操作许可',
      cua: '遵守「电脑操作」开关',
      cuaHint: '关闭后即使「电脑操作」关着也允许本扩展发按键/鼠标。',

      general: '其他',
      autoHide: '自动隐藏（分钟）',
      autoHideHint: '这么久没调用本 World 的工具，就自动对它隐藏，回到 0 token。0 = 不自动。隐藏后抓包/中转照常跑，游戏不受影响。',
    }
    : {
      chat: 'Chat transport',
      mode: 'Chat transport',
      modeHint: 'capture = passive Npcap capture (read only). relay = local relay (read + send, one-time hosts setup); it redirects the dispatch response to localhost and forwards it, for chat only — no combat or resource changes. Use capture if you do not want traffic touched.',

      chatPush: 'Chat pushes',
      chatPushHint: 'Which captured chat lines should reach the pet. Private and mention are on by default; world is off to avoid spam.',
      private: 'Private messages',
      privateHint: 'Push when someone private-messages you; on by default.',
      mention: 'Mentions',
      mentionHint: 'Push when your character name appears in a public channel; on by default.',
      keywords: 'Custom keywords',
      keywordsHint: 'Push when one of these words appears (public or private); comma/space separated, empty = off.',
      nearby: 'Nearby channel',
      nearbyHint: 'Push every nearby line; off by default (mentions still push).',
      world: 'World channel',
      worldHint: 'Push every world line; off by default, easily noisy.',
      team: 'Team channel',
      teamHint: 'Push every team line; off by default.',
      guild: 'Guild channel',
      guildHint: 'Push every guild line; off by default.',
      system: 'System / notice / horn',
      systemHint: 'Push every system, notice and horn line; off by default.',

      push: 'State pushes',
      pushOn: 'Allow state pushes',
      pushOnHint: 'Master switch for scene/friend/profile/position pushes. Chat has its own group.',
      scene: 'Scene changes',
      sceneHint: 'Push when the scene or channel changes (who is here, how many).',
      friends: 'Friend online state',
      friendsHint: 'Push when a friend comes online or goes offline.',
      profile: 'Own profile',
      profileHint: 'Push your level/world level/signature on login or when it changes.',

      position: 'Position pushes',
      positionOn: 'Push position',
      positionOnHint: 'Off by default. When on, push your coordinates on movement and on a heartbeat; the pet does not have to poll of_position.',
      moveMeters: 'Move distance (m)',
      moveMetersHint: 'Push immediately when one move exceeds this distance.',
      moveSeconds: 'Move interval (s)',
      moveSecondsHint: 'While moving continuously, push at most this often.',
      globalSeconds: 'Heartbeat (s)',
      globalSecondsHint: 'When barely moving, still push once per this interval.',
      globalMode: 'Heartbeat mode',
      globalModeHint: 'auto = lengthen the interval after repeated unchanged heartbeats; fixed = always use the interval above.',
      globalMax: 'Heartbeat cap (s)',
      globalMaxHint: 'Upper bound for the auto-lengthened interval.',

      gate: 'Input permission',
      cua: 'Respect the computer-use switch',
      cuaHint: 'When off, this World may inject input even if computer use is disabled.',

      general: 'Other',
      autoHide: 'Auto hide (minutes)',
      autoHideHint: 'Hide this World from the agent after this long without a tool call, back to 0 tokens. 0 = never. The bridge/relay keeps running.',
    };
  const at = (key) => `worlds.${OVERFIELD_ID}.${key}`;
  const bool = (label, description, warning = false) => ({
    type: 'boolean',
    title: label,
    description,
    'x-hot': true,
    ...(warning ? { 'x-warning': true } : {}),
  });
  const int = (label, description, minimum, maximum, suffix = '') => ({
    type: 'integer',
    title: label,
    description,
    minimum,
    maximum,
    ...(suffix ? { 'x-suffix': suffix } : {}),
    'x-hot': true,
  });
  return [
    {
      id: `world:${OVERFIELD_ID}.chat`,
      owner: `world:${OVERFIELD_ID}`,
      schema: {
        type: 'object',
        title: title.chat,
        properties: {
          [at('chatMode')]: {
            type: 'string',
            title: title.mode,
            description: title.modeHint,
            enum: ['capture', 'relay'],
            'x-hot': true,
            'x-warning': true,
          },
        },
      },
    },
    {
      id: `world:${OVERFIELD_ID}.chatPush`,
      owner: `world:${OVERFIELD_ID}`,
      schema: {
        type: 'object',
        title: title.chatPush,
        description: title.chatPushHint,
        properties: {
          [at('pushChatPrivate')]: bool(title.private, title.privateHint),
          [at('pushChatMention')]: bool(title.mention, title.mentionHint),
          [at('pushChatKeywords')]: {
            type: 'string',
            title: title.keywords,
            description: title.keywordsHint,
            'x-hot': true,
          },
          [at('pushChatNearby')]: bool(title.nearby, title.nearbyHint),
          [at('pushChatWorld')]: bool(title.world, title.worldHint),
          [at('pushChatTeam')]: bool(title.team, title.teamHint),
          [at('pushChatGuild')]: bool(title.guild, title.guildHint),
          [at('pushChatSystem')]: bool(title.system, title.systemHint),
        },
      },
    },
    {
      id: `world:${OVERFIELD_ID}.push`,
      owner: `world:${OVERFIELD_ID}`,
      schema: {
        type: 'object',
        title: title.push,
        properties: {
          [at('pushEnabled')]: bool(title.pushOn, title.pushOnHint),
          [at('pushScene')]: bool(title.scene, title.sceneHint),
          [at('pushFriends')]: bool(title.friends, title.friendsHint),
          [at('pushProfile')]: bool(title.profile, title.profileHint),
        },
      },
    },
    {
      id: `world:${OVERFIELD_ID}.position`,
      owner: `world:${OVERFIELD_ID}`,
      schema: {
        type: 'object',
        title: title.position,
        properties: {
          [at('pushPosition')]: bool(title.positionOn, title.positionOnHint),
          [at('positionMoveMeters')]: int(title.moveMeters, title.moveMetersHint, 1, 1000, 'm'),
          [at('positionMoveSeconds')]: int(title.moveSeconds, title.moveSecondsHint, 1, 300, 's'),
          [at('positionGlobalSeconds')]: int(title.globalSeconds, title.globalSecondsHint, 10, 3600, 's'),
          [at('positionGlobalMode')]: {
            type: 'string',
            title: title.globalMode,
            description: title.globalModeHint,
            enum: ['auto', 'fixed'],
            'x-hot': true,
          },
          [at('positionGlobalMaxSeconds')]: int(title.globalMax, title.globalMaxHint, 30, 7200, 's'),
        },
      },
    },
    {
      id: `world:${OVERFIELD_ID}.gate`,
      owner: `world:${OVERFIELD_ID}`,
      schema: {
        type: 'object',
        title: title.gate,
        properties: {
          [at('respectCuaGate')]: bool(title.cua, title.cuaHint, true),
        },
      },
    },
    {
      id: `world:${OVERFIELD_ID}.general`,
      owner: `world:${OVERFIELD_ID}`,
      schema: {
        type: 'object',
        title: title.general,
        properties: {
          [at('autoHideMinutes')]: int(title.autoHide, title.autoHideHint, 0, 1440, 'min'),
        },
      },
    },
  ];
}
