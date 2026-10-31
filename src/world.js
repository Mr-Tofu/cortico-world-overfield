/**
 * The OverField World.
 *
 * Chat comes from the game's own protocol through one of two transports:
 *   capture - passive Npcap capture of the gateway TCP stream (read only)
 *   relay   - local dispatch/gate relay (read + protocol send)
 *
 * Tools:
 *   of_chat_read   - recent chat as text, channel-tagged
 *   of_chat_bridge - start/stop/status of the chat process
 *   of_chat_send   - send chat over the relay, or clipboard fallback for Nearby
 *   of_scene       - scene roster, channel and distance from you
 *   of_friends     - friend list with online state
 *   of_player_info - what is known about a player
 *   of_chat_history - private history with one player
 *   of_unread      - unanswered private conversations
 *   of_position    - last known position of you / one player
 *   of_send_keys   - one key chord through Win32 SendInput
 *   of_state       - foreground, client size, chat process state
 *
 * Proactive pushes: of.chat (private / mention / keyword / channel switches),
 * of.scene, of.position, of.friend, of.profile and of.privateUnread.
 *
 * Chat recording lives in the separate 开放空间聊天 World. This World keeps the
 * capture/relay transport, pushes events, and can reply; there is no screenshot,
 * no OCR, no memory access and no injection into the game process.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lookup } from 'node:dns/promises';
import { chordLabel, parseChord } from './keys.js';
import { settings, overfieldConfigGroups, DEFAULTS, OVERFIELD_ID } from './config.js';
import { win32 } from './native.js';
import { findGameWindow, raiseWindow, foreground, clientRect, windowCandidates } from './window.js';
import { ChatFeed, parseChannels } from './feed.js';
import {
  describeStatus, readStatus, relayAlive, relayFriends, relayHistory, relaySend,
  startBridge, startRelay, statusAlive, stopBridge,
} from './bridge-control.js';

const ENTER = { name: 'enter', vk: 0x0d, extended: false };
const CTRL_V = [
  { name: 'ctrl', vk: 0x11, extended: false },
  { name: 'v', vk: 0x56, extended: false },
];

const DISPATCH_HOST = 'dsp-prod-of.inutan.com';

/** 环境提示词模板：跟 World 一起打包，WebUI 可以整份覆盖。 */
const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

/** Shipped emotion labels, generated from the game's own static tables. */
let DEFAULT_EMOTIONS = {};
try {
  DEFAULT_EMOTIONS = JSON.parse(readFileSync(new URL('../assets/emotions.json', import.meta.url), 'utf8'));
} catch {
  DEFAULT_EMOTIONS = {};
}

/**
 * When the hosts line points the dispatch domain at 127.0.0.1, the client can
 * only log in if the relay is listening — even if the person chose capture mode.
 */
async function hostsPointsLocal() {
  try {
    const looked = await lookup(DISPATCH_HOST);
    return looked?.address === '127.0.0.1';
  } catch {
    return false;
  }
}

function pause(ms, signal) {
  return new Promise((resolve) => {
    const delay = Math.max(0, Math.round(Number(ms) || 0));
    if (!delay) {
      resolve(!!signal?.aborted);
      return;
    }
    if (signal?.aborted) {
      resolve(true);
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve(!!signal?.aborted);
    };
    const timer = setTimeout(done, delay);
    signal?.addEventListener('abort', done, { once: true });
  });
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function shortError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 120 ? `${message.slice(0, 117)}…` : message;
}

function elapsed(started) {
  return Math.max(0, Date.now() - started);
}

function pointInClient(client, cfg, point) {
  const scaleX = client.width / Math.max(1, cfg.baseSize[0]);
  const scaleY = client.height / Math.max(1, cfg.baseSize[1]);
  return {
    x: clamp(Math.round((Number(point?.[0]) || 0) * scaleX), 0, client.width - 1),
    y: clamp(Math.round((Number(point?.[1]) || 0) * scaleY), 0, client.height - 1),
  };
}

/** Restoring a minimized window can change its client size; take a fresh rect. */
function refreshClient(win) {
  const fresh = clientRect(win);
  if (fresh) win.client = fresh;
}

export class OverfieldWorld {
  constructor(ctx) {
    this.id = OVERFIELD_ID;
    this.ctx = ctx;
    this.cfg = ctx?.cfg ?? {};
    this.host = null;
    this.feed = null;
    this.bridgeStarted = false;
    this.bridgeError = '';
    this.pushTimes = [];
    this.pushDropped = 0;
    this.unreadTimer = null;
    // playerId -> last reminder time, so one nudge does not repeat every tick.
    this.unreadReminded = new Map();
    this.unreadPushes = 0;
    // 最后一次「有人用它」的时刻；自动隐藏按它算。
    this.lastUse = Date.now();
    this.hideTimer = null;
    // 位置推送：上一次推的位置、时间，以及自动模式下当前的心跳间隔。
    this.lastPosition = null;
    this.lastPositionPushAt = 0;
    this.positionBaseMs = 0;
    this.positionGlobalMs = 0;
    this.positionUnchanged = 0;
  }

  /** 任何一次工具调用都算「正在玩」。 */
  touch() {
    this.lastUse = Date.now();
  }

  async start(host) {
    if (process.platform !== 'win32') throw new Error('开放空间扩展只支持 Windows');
    this.host = host ?? null;
    const cfg = settings(this.cfg);
    const dir = this.chatDir(cfg);
    let mode = cfg.chatMode;
    if (mode === 'capture' && await hostsPointsLocal()) {
      // The hosts line is active: serve the dispatch locally or the game cannot log in.
      mode = 'relay';
      this.modeNote = 'hosts 已指向 127.0.0.1，已自动用中转模式保持登录';
      host?.log?.warn?.(this.modeNote);
    }
    this.chatMode = mode;
    if (cfg.chatEnabled) {
      try {
        const existing = readStatus(dir);
        if (statusAlive(existing) && existing.mode !== mode) stopBridge({ dir, log: host?.log });
        const result = mode === 'relay'
          ? startRelay({
            dir,
            dispatchPort: cfg.relayDispatchPort,
            gatePort: cfg.relayGatePort,
            controlPort: cfg.relayControlPort,
            dispatchIp: cfg.relayDispatchIp,
            log: host?.log,
          })
          : startBridge({ dir, ports: cfg.bridgePorts, device: cfg.bridgeDevice, log: host?.log });
        this.bridgeStarted = result.started;
        this.bridgeError = '';
      } catch (error) {
        this.bridgeError = error instanceof Error ? error.message : String(error);
        host?.log?.warn?.('聊天进程启动失败', { err: this.bridgeError });
      }
    }
    this.feed = new ChatFeed({
      dir,
      timezone: this.ctx?.timezone ?? 'Asia/Shanghai',
      channelNames: cfg.channelNames,
      log: host?.log,
    });
    this.feed.onChat((msg) => this.onIncoming(msg));
    this.feed.onState((event) => this.onStateChange(event));
    this.feed.setEmotions(DEFAULT_EMOTIONS);
    this.feed.start();
    this.startUnreadWatch();
    this.startAutoHide();
    this.touch();
  }

  async stop() {
    this.stopAutoHide();
    this.stopUnreadWatch();
    this.feed?.stop();
    this.feed = null;
    // The bridge is ours: leaving it capturing after the World is disabled
    // would surprise both the person and the next session.
    try {
      stopBridge({ dir: this.chatDir(settings(this.cfg)), log: this.host?.log });
    } catch {
      // Already gone; stopping the World must not throw.
    }
    this.bridgeStarted = false;
  }

  chatDir(cfg = settings(this.cfg)) {
    if (cfg.chatDir) return resolve(cfg.chatDir);
    return join(this.ctx?.dataDir ?? this.ctx?.botDir ?? process.cwd(), 'overfield-chat');
  }

  /** 新消息 → 按开关推给桌宠；记录由「开放空间聊天」World 负责。 */
  onIncoming(msg, cfg = settings(this.cfg)) {
    if (!this.host || !cfg.pushEnabled) return;
    if (msg.self) return;
    const { reasons, keywords } = this.chatPushReasons(msg, cfg);
    if (!reasons.length) return;
    if (!this.reservePush(cfg)) return;

    const now = Date.now();
    const text = this.feed.line(msg);
    const privateMsg = msg.channel === 2;
    this.host
      .pushEvent(
        {
          type: 'of.chat',
          ts: new Date(msg.sendTime || now).toISOString(),
          source: this.id,
          text,
          senderKey: msg.playerId ? String(msg.playerId) : msg.name,
          meta: {
            channel: msg.channel,
            channelName: msg.channelName,
            playerId: msg.playerId,
            name: msg.name,
            sendTime: msg.sendTime,
            private: privateMsg,
            reasons,
            keywords,
          },
        },
        { trigger: privateMsg ? 'flush' : 'debounce' },
      )
      .catch((error) => this.host?.log?.warn?.('聊天推送失败', { err: String(error) }));
  }

  /**
   * 这条消息为什么值得推：私聊 / 提到我 / 自定义关键词 / 某个频道开关。
   * 返回的 reasons 会写进事件 meta，方便桌宠判断要不要回。
   */
  chatPushReasons(msg, cfg) {
    const channel = Number(msg.channel);
    const body = String(msg.text ?? '');
    const reasons = [];
    const keywords = [];
    if (channel === 2 && cfg.pushChatPrivate) reasons.push('private');
    const publicChannel = channel === 0 || channel === 1 || channel === 5 || channel === 6;
    if (publicChannel && cfg.pushChatMention && this.mentionsMe(body, cfg)) reasons.push('mention');
    if (cfg.pushChatKeywords.length && body) {
      for (const word of cfg.pushChatKeywords) {
        if (body.includes(word)) keywords.push(word);
      }
      if (keywords.length) reasons.push('keyword');
    }
    if (channel === 0 && cfg.pushChatNearby) reasons.push('nearby');
    if (channel === 1 && cfg.pushChatWorld) reasons.push('world');
    if (channel === 5 && cfg.pushChatTeam) reasons.push('team');
    if (channel === 6 && cfg.pushChatGuild) reasons.push('guild');
    if ((channel === 3 || channel === 4 || channel === 7) && cfg.pushChatSystem) reasons.push('system');
    return { reasons: [...new Set(reasons)], keywords: [...new Set(keywords)] };
  }


  /* ---------- 自动隐藏：没动作就退出 agent 的上下文 ---------- */

  startAutoHide() {
    this.stopAutoHide();
    this.hideTimer = setInterval(() => {
      void this.maybeHide();
    }, 60_000);
    this.hideTimer.unref?.();
  }

  stopAutoHide() {
    if (this.hideTimer) clearInterval(this.hideTimer);
    this.hideTimer = null;
  }

  /** 端口跟着部署的 config.json 走，和 worlds-knob 一样。 */
  webPort() {
    try {
      const raw = JSON.parse(readFileSync(join(this.ctx?.botDir ?? '.', 'config.json'), 'utf8'));
      const port = Number(raw?.web?.port);
      if (Number.isInteger(port) && port > 0) return port;
    } catch {
      // 读不到就用默认端口
    }
    return 17788;
  }

  /** 只撤下 agent 表面：World 继续跑，relay 不断，游戏照常。 */
  async setVisible(visible) {
    const res = await fetch(`http://127.0.0.1:${this.webPort()}/api/worlds/visibility`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: this.id, visible }),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  }

  /** 现在对 agent 可见吗；读不到就返回 null。 */
  async isVisible() {
    try {
      const res = await fetch(`http://127.0.0.1:${this.webPort()}/api/worlds`, { signal: AbortSignal.timeout(5000) });
      const body = await res.json();
      const hit = (body.worlds ?? []).find((world) => world.id === this.id);
      return hit ? hit.visible !== false : null;
    } catch {
      return null;
    }
  }

  async maybeHide() {
    const cfg = settings(this.cfg);
    // 刚被打开（上一拍还看不见）就重新计时，否则「打开 → 一分钟后又自动关」。
    const shown = await this.isVisible();
    if (shown === true && this.wasVisible !== true) this.lastUse = Date.now();
    this.wasVisible = shown;
    if (!cfg.autoHideMinutes) return;
    if (shown === false) return;
    if (Date.now() - this.lastUse < cfg.autoHideMinutes * 60_000) return;
    const ok = await this.setVisible(false).catch(() => false);
    this.wasVisible = false;
    this.host?.log?.info(`开放空间：${cfg.autoHideMinutes} 分钟没动作，已自动对 agent 隐藏${ok ? '' : '（接口没回 ok）'}`);
  }

  /** Global per-minute cap, so a busy world channel cannot burn the context. */
  reservePush(cfg, now = Date.now()) {
    this.pushTimes = this.pushTimes.filter((t) => now - t < 60_000);
    if (this.pushTimes.length >= cfg.pushRatePerMinute) {
      this.pushDropped += 1;
      return false;
    }
    this.pushTimes.push(now);
    return true;
  }

  /** 正文里有没有我的角色名。 */
  mentionsMe(text, cfg) {
    const body = String(text ?? '');
    if (!body) return false;
    const name = this.feed?.selfName || cfg.selfName;
    return Boolean(name) && body.includes(name);
  }

  /* ---------- scene / friends / profile pushes ---------- */

  /** One switch per data kind; the feed only emits on a real change. */
  onStateChange(event, cfg = settings(this.cfg)) {
    if (!this.host || !cfg.pushEnabled) return;
    if (event.kind === 'positions') {
      if (cfg.pushPosition) this.maybePushPosition(event.players ?? [], cfg);
      return;
    }
    if (event.kind === 'scene' && cfg.pushScene) {
      const scene = event.scene ?? {};
      // 换场景后位置基准要重来，否则会拿旧场景的坐标算出一个巨大的“移动”。
      this.lastPosition = null;
      this.positionGlobalMs = Math.max(10, cfg.positionGlobalSeconds) * 1000;
      this.positionUnchanged = 0;
      const label = scene.channelLabel ? `（${scene.channelLabel}）` : '';
      const players = Array.isArray(scene.players) ? scene.players.length : 0;
      this.pushState(cfg, 'scene', {
        type: 'of.scene',
        ts: new Date().toISOString(),
        text: `进入场景 ${scene.sceneId ?? '?'} · 频道 ${scene.channelId ?? '?'}${label} · ${players} 人`,
        meta: {
          sceneId: scene.sceneId ?? 0,
          channelId: scene.channelId ?? 0,
          channelLabel: scene.channelLabel ?? null,
          playerCount: players,
        },
      });
      return;
    }
    if (event.kind === 'friends' && cfg.pushFriends) {
      const label = (friend) => friend.alias || friend.name || String(friend.playerId);
      const online = (event.online ?? []).map(label);
      const offline = (event.offline ?? []).map(label);
      const parts = [];
      if (online.length) parts.push(`${online.join('、')} 上线`);
      if (offline.length) parts.push(`${offline.join('、')} 下线`);
      if (!parts.length) return;
      this.pushState(cfg, 'friends', {
        type: 'of.friend',
        ts: new Date().toISOString(),
        text: `好友动态：${parts.join('；')}（好友 ${event.total ?? 0} 人）`,
        meta: { online: event.online ?? [], offline: event.offline ?? [], total: event.total ?? 0 },
      });
      return;
    }
    if (event.kind === 'profile' && cfg.pushProfile) {
      const profile = event.profile ?? {};
      const bits = [profile.name || '我'];
      if (profile.level) bits.push(`${profile.level} 级`);
      if (profile.worldLevel) bits.push(`世界等级 ${profile.worldLevel}`);
      if (profile.sign) bits.push(`签名：${String(profile.sign).slice(0, 40)}`);
      this.pushState(cfg, 'profile', {
        type: 'of.profile',
        ts: new Date().toISOString(),
        text: `角色资料：${bits.join(' · ')}`,
        meta: {
          playerId: profile.playerId ?? 0,
          name: profile.name ?? '',
          level: profile.level ?? 0,
          worldLevel: profile.worldLevel ?? 0,
          sign: profile.sign ?? '',
        },
      });
    }
  }

  /**
   * 位置推送：默认关。打开后按「移动了」或「定时心跳」推。
   * - 移动 >= positionMoveMeters，或移动过且距上次推送 >= positionMoveSeconds 秒；
   * - 否则距上次推送 >= 当前全局间隔时推一次心跳；
   * - 自动模式：连续多次心跳位置没变就把间隔拉长（最多 positionGlobalMaxSeconds），
   *   一旦真的移动就恢复基础间隔。
   */
  maybePushPosition(players, cfg) {
    const feed = this.feed;
    if (!feed) return;
    const selfId = Number(feed.selfId) || 0;
    if (!selfId) return;
    const sync = players.find((player) => Number(player?.playerId) === selfId)
      ?? feed.state?.positions?.get(selfId);
    const pos = sync?.chars?.[0]?.pos ?? sync?.pos;
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.z)) return;

    const scene = feed.state?.scene ?? {};
    const sceneId = Number(scene.sceneId) || 0;
    const channelId = Number(scene.channelId) || 0;
    const now = Date.now();
    const base = Math.max(10, cfg.positionGlobalSeconds) * 1000;
    if (this.positionBaseMs !== base) {
      // 面板改了心跳间隔：从新的基础间隔重新开始，不要留着旧的自动拉长值。
      this.positionBaseMs = base;
      this.positionGlobalMs = base;
      this.positionUnchanged = 0;
    }
    if (cfg.positionGlobalMode === 'fixed') this.positionGlobalMs = base;

    if (!this.lastPosition || this.lastPosition.sceneId !== sceneId || this.lastPosition.channelId !== channelId) {
      this.lastPosition = { x: pos.x, y: pos.y ?? 0, z: pos.z, sceneId, channelId };
      this.lastPositionPushAt = now;
      this.positionGlobalMs = base;
      this.positionUnchanged = 0;
      return;
    }

    const moved = Math.hypot(pos.x - this.lastPosition.x, pos.z - this.lastPosition.z);
    const since = now - this.lastPositionPushAt;
    const moveDue = moved >= cfg.positionMoveMeters
      || (moved >= 0.5 && since >= cfg.positionMoveSeconds * 1000);
    const globalDue = since >= this.positionGlobalMs;
    if (!moveDue && !globalDue) return;

    const reason = moveDue ? 'move' : 'heartbeat';
    const label = reason === 'move' ? `移动 ${moved.toFixed(1)}m` : '定时心跳';
    const sent = this.pushState(cfg, 'position', {
      type: 'of.position',
      ts: new Date(now).toISOString(),
      text: `位置：场景 ${sceneId || '?'} · 频道 ${channelId || '?'} · (${pos.x.toFixed(1)}, ${pos.z.toFixed(1)}) · ${label}`,
      meta: {
        sceneId,
        channelId,
        x: pos.x,
        y: pos.y ?? 0,
        z: pos.z,
        moved: Number(moved.toFixed(2)),
        reason,
        unchangedHeartbeats: this.positionUnchanged,
        globalSeconds: Math.round(this.positionGlobalMs / 1000),
        playerId: selfId,
        name: feed.selfName || '',
      },
    });
    if (!sent) return;

    this.lastPosition = { x: pos.x, y: pos.y ?? 0, z: pos.z, sceneId, channelId };
    this.lastPositionPushAt = now;
    if (reason === 'move') {
      this.positionUnchanged = 0;
      this.positionGlobalMs = base;
    } else if (moved < 0.5) {
      this.positionUnchanged += 1;
      if (cfg.positionGlobalMode === 'auto' && this.positionUnchanged >= 2) {
        const max = Math.max(base, cfg.positionGlobalMaxSeconds * 1000);
        this.positionGlobalMs = Math.min(max, Math.round(this.positionGlobalMs * 1.5));
      }
    } else {
      this.positionUnchanged = 0;
      this.positionGlobalMs = base;
    }
  }

  pushState(cfg, kind, payload) {
    if (!this.reservePush(cfg)) return false;
    this.host
      .pushEvent({ source: this.id, ...payload }, { trigger: 'debounce' })
      .catch((error) => this.host?.log?.warn?.('状态推送失败', { err: String(error), kind }));
    return true;
  }

  /* ---------- unread private conversations ---------- */

  shortClock(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '';
    try {
      return new Intl.DateTimeFormat('zh-CN', {
        hour: '2-digit', minute: '2-digit', hour12: false, timeZone: this.ctx?.timezone ?? 'Asia/Shanghai',
      }).format(new Date(ms));
    } catch {
      return '';
    }
  }

  startUnreadWatch() {
    if (this.unreadTimer) return;
    this.unreadTimer = setInterval(() => {
      this.checkUnread().catch((error) => this.host?.log?.warn?.('私聊未读提醒失败', { err: String(error) }));
    }, 20_000);
    this.unreadTimer.unref?.();
  }

  stopUnreadWatch() {
    if (this.unreadTimer) clearInterval(this.unreadTimer);
    this.unreadTimer = null;
  }

  /**
   * Nudge the pet about private messages it has not answered. One push per
   * tick at most, and a per-player cooldown so a silence does not spam.
   */
  async checkUnread(cfg = settings(this.cfg), now = Date.now()) {
    const feed = this.feed;
    // 私聊未读提醒本身就是要叫醒人的，所以跟着「私聊叫醒」一起关。
    if (!this.host || !feed || !cfg.pushEnabled || !cfg.pushChatPrivate) return 0;
    const pending = feed.unreadList();
    if (!pending.length) {
      this.unreadReminded.clear();
      return 0;
    }
    const alive = new Set(pending.map((entry) => entry.playerId));
    for (const id of [...this.unreadReminded.keys()]) {
      if (!alive.has(id)) this.unreadReminded.delete(id);
    }
    const due = pending.filter((entry) => {
      const age = now - entry.lastAt;
      if (age < cfg.unreadDelaySeconds * 1000) return false;
      if (cfg.unreadMaxAgeMinutes > 0 && age > cfg.unreadMaxAgeMinutes * 60_000) return false;
      const remindedAt = this.unreadReminded.get(entry.playerId) ?? 0;
      return now - remindedAt >= cfg.unreadRepeatMinutes * 60_000;
    });
    if (!due.length) return 0;

    const picked = due.slice(0, 3);
    const total = feed.unreadTotal();
    const parts = picked.map((entry) => {
      const name = entry.name || String(entry.playerId);
      const when = this.shortClock(entry.lastSendTime);
      const body = entry.lastText
        ? `：${String(entry.lastText).slice(0, 40)}`
        : entry.lastExpression ? '：[表情]' : '';
      return `${name} ${entry.count} 条${when ? `（最后 ${when}）` : ''}${body}`;
    });
    const listed = picked.reduce((sum, entry) => sum + entry.count, 0);
    const text = `私聊未读提醒：${parts.join('；')}${total > listed ? `；另有 ${total - listed} 条` : ''}。还没回的话记得回一下。`;
    try {
      await this.host.pushEvent(
        {
          type: 'of.privateUnread',
          ts: new Date(now).toISOString(),
          source: this.id,
          text,
          senderKey: picked.length === 1 ? String(picked[0].playerId) : 'private-unread',
          meta: {
            private: true,
            total,
            players: picked.map((entry) => ({
              playerId: entry.playerId,
              name: entry.name || '',
              count: entry.count,
              lastText: entry.lastText,
              lastSendTime: entry.lastSendTime,
            })),
          },
        },
        { trigger: 'flush' },
      );
    } catch (error) {
      this.host?.log?.warn?.('私聊未读推送失败', { err: String(error) });
      return 0;
    }
    // Only start the cooldown once the push actually went through, so a failed
    // push is retried on the next tick instead of being silently dropped.
    for (const entry of picked) this.unreadReminded.set(entry.playerId, now);
    this.unreadPushes += 1;
    return picked.length;
  }

  unreadSummary() {
    const feed = this.feed;
    if (!feed) return '';
    const people = feed.unreadList();
    if (!people.length) return '';
    const total = feed.unreadTotal();
    return `私聊未读：${people.length} 人 / ${total} 条${people[0]?.name ? `（最早 ${people[0].name}）` : ''}`;
  }

  /**
   * 环境提示词里的动态值：只放“现在能不能用、我在哪、谁在等我”这类短状态，
   * 不把聊天正文塞进系统前缀（正文走事件/工具）。
   */
  envPromptVars() {
    const cfg = settings(this.cfg);
    const feed = this.feed;
    const status = feed?.status ?? readStatus(this.chatDir(cfg));
    const alive = feed && typeof feed.bridgeAlive === 'function'
      ? feed.bridgeAlive()
      : statusAlive(status);
    const mode = (status?.mode ?? this.chatMode ?? cfg.chatMode) === 'relay' ? 'relay' : 'capture';
    const modeText = alive
      ? mode === 'relay'
        ? 'relay 运行中（可读，可发附近/世界/私聊）'
        : 'capture 运行中（只读；回消息只能用剪贴板发附近）'
      : '聊天进程未运行（先 of_chat_bridge(action="start")）';
    const scene = feed?.state?.scene;
    const sceneText = scene
      ? `场景 ${scene.sceneId ?? '?'} · 频道 ${scene.channelId ?? '?'}${scene.channelLabel ? `（${scene.channelLabel}）` : ''} · ${Array.isArray(scene.players) ? scene.players.length : 0} 人`
      : '还没有场景数据';
    const selfText = feed?.selfName
      ? `${feed.selfName}${feed.selfId ? `（id ${feed.selfId}）` : ''}`
      : '未知（等登录包）';
    const unread = this.unreadSummary() || '没有未读私聊';
    const pos = feed?.selfPosition?.();
    const posText = pos ? `(${pos.x.toFixed(1)}, ${pos.z.toFixed(1)})` : '未同步';
    return {
      'overfield.mode': modeText,
      'overfield.self': selfText,
      'overfield.scene': sceneText,
      'overfield.unread': unread,
      'overfield.position': posText,
    };
  }

  /** The built-in computer-use switch is the person's consent gate for input. */
  cuaProblem(cfg) {
    if (!cfg.respectCuaGate) return null;
    try {
      const raw = JSON.parse(readFileSync(join(this.ctx.botDir, 'config.json'), 'utf8'));
      const cua = raw?.worlds?.['desktop-pet']?.cua;
      if (!cua || typeof cua !== 'object') return null;
      if (cua.enabled !== true) {
        return '电脑操作现在是关闭的：先在设置里打开「电脑操作」，再让开放空间扩展发按键。';
      }
      if (cua.control === false) {
        return '电脑操作现在只允许看屏幕、不允许操作鼠标键盘：先在设置里允许操作。';
      }
      return null;
    } catch {
      return null;
    }
  }

  /* ---------- tools ---------- */

  tools() {
    return [
      {
        name: 'of_send_keys',
        description: [
          'Send one key chord directly to the 开放空间 (OverField) game window through Win32 SendInput, without a screenshot.',
          'It restores and foregrounds the window first, presses the keys, holds for holdMs, then releases them.',
          'Use it for game actions: "w", "shift", "space", "1", "tab", "esc". One chord per call; keys are joined with +.',
          'It returns one text line with success and elapsed time, never an image.',
          'Do not use it to type chat messages; use of_chat_send for that. It obeys the computer-use switch by default.',
        ].join(' '),
        tags: ['act'],
        parameters: {
          type: 'object',
          properties: {
            chord: {
              type: 'string',
              maxLength: 64,
              description: 'One chord joined with +, for example "w", "shift", "space", "1", "ctrl+shift+g". Not a sequence.',
            },
            holdMs: {
              type: 'integer',
              minimum: 0,
              maximum: 10_000,
              description: 'How long to keep the chord down, in milliseconds; defaults to the extension setting (80). 0 taps.',
            },
          },
          required: ['chord'],
        },
        handler: async (args, call) => {
          const started = Date.now();
          const cfg = settings(this.cfg);
          const gate = this.cuaProblem(cfg);
          if (gate) return { text: `失败：${gate}`, failed: true };
          const parsed = parseChord(args?.chord);
          if (parsed.error) return { text: `失败：${parsed.error}。`, failed: true };
          const rawHold = args?.holdMs;
          const hold = rawHold === undefined || rawHold === null || rawHold === ''
            ? cfg.holdMs
            : clamp(Math.round(Number(rawHold) || 0), 0, 10_000);

          const found = findGameWindow();
          if (!found.window) {
            const names = windowCandidates(found.visible);
            return {
              text: `失败：${found.reason}${names ? `。可见窗口：${names}` : ''}（耗时 ${elapsed(started)}ms）`,
              failed: true,
            };
          }
          const win = found.window;
          const raised = raiseWindow(win);
          if (!raised.ok) {
            return { text: `失败：${raised.reason}（耗时 ${elapsed(started)}ms）`, failed: true };
          }
          if (await pause(cfg.focusDelayMs, call?.signal)) {
            return { text: `已取消，没有按键（耗时 ${elapsed(started)}ms）。`, failed: true };
          }
          if (!foreground(win)) {
            return { text: `失败：游戏窗口没有到前台，按键未发（耗时 ${elapsed(started)}ms）。`, failed: true };
          }

          const native = win32();
          const pressed = [];
          let interrupted = false;
          let sendError = null;
          try {
            for (const key of parsed.keys) {
              native.down(key);
              pressed.push(key);
            }
            interrupted = await pause(hold, call?.signal);
          } catch (error) {
            sendError = error;
          } finally {
            for (const key of [...pressed].reverse()) {
              try {
                native.up(key);
              } catch (error) {
                if (!sendError) sendError = error;
              }
            }
          }

          if (sendError) {
            return { text: `失败：发送 ${chordLabel(parsed.keys)} 时出错：${shortError(sendError)}（耗时 ${elapsed(started)}ms）`, failed: true };
          }
          if (interrupted) {
            return { text: `已中断：${chordLabel(parsed.keys)} 已松开（耗时 ${elapsed(started)}ms）。`, failed: true };
          }
          return {
            text: `成功：已把 ${chordLabel(parsed.keys)} 发给「${win.title}」（按住 ${hold}ms，总耗时 ${elapsed(started)}ms）。`,
          };
        },
      },
      {
        name: 'of_chat_send',
        description: [
          'Send one chat message in 开放空间 (OverField).',
          'In relay mode it sends over the game protocol on the existing gateway connection: no window focus, no clipboard, and it works for Nearby (0), World (1) and Private (2, with target player id).',
          'Without the relay it falls back to the clipboard path for the Nearby channel only: bring the game forward, press Enter, click the configured input box, Ctrl+V, Enter.',
          'Use it only for chat messages: no account names, passwords, or multi-line text. For plain game keys use of_send_keys.',
          'A server receipt only means the request was accepted; it does not prove the other player saw the message.',
        ].join(' '),
        tags: ['act'],
        parameters: {
          type: 'object',
          properties: {
            text: {
              type: 'string',
              maxLength: 500,
              description: 'One line of chat text. Newlines are refused so a single call cannot send several messages.',
            },
            channel: {
              type: 'integer',
              minimum: 0,
              maximum: 7,
              description: '0 Nearby (default), 1 World, 2 Private, 5 Team. Relay mode only; the clipboard fallback always uses Nearby.',
            },
            target: {
              type: 'integer',
              minimum: 0,
              description: 'Target player id for private chat (channel 2). Ignored by other channels.',
            },
          },
          required: ['text'],
        },
        handler: async (args, call) => {
          const started = Date.now();
          const cfg = settings(this.cfg);
          const text = typeof args?.text === 'string' ? args.text.trim() : '';
          if (!text) return { text: '失败：聊天内容为空。', failed: true };
          if (text.length > 500) return { text: '失败：聊天内容超过 500 字。', failed: true };
          if (/[\r\n]/.test(text)) return { text: '失败：一次只能发一行，内容里不能有换行。', failed: true };
          const channel = Math.min(7, Math.max(0, Math.round(Number(args?.channel) || 0)));
          const target = Math.max(0, Math.round(Number(args?.target) || 0));
          const dir = this.chatDir(cfg);

          // Relay first: the message goes over the game's own gateway connection.
          if (relayAlive(dir)) {
            try {
              const result = await relaySend({ dir, text, channel, target, controlPort: cfg.relayControlPort });
              // Answering a private message clears its unread reminder.
              if (channel === 2 && target) this.feed?.markPrivateRead?.(target);
              const label = cfg.channelNames[channel] ?? `频道${channel}`;
              const tail = result.note ? `；${result.note}` : '；服务器已回执';
              return {
                text: `已发出：中转到「${label}」${target ? `（目标 ${target}）` : ''}（${text.length} 字${tail}，耗时 ${elapsed(started)}ms）。回执只代表服务器收下，不代表对方收到。`,
              };
            } catch (error) {
              return { text: `失败：中转发送出错：${shortError(error)}（耗时 ${elapsed(started)}ms）。`, failed: true };
            }
          }

          const gate = this.cuaProblem(cfg);
          if (gate) return { text: `失败：${gate}`, failed: true };
          if (channel !== 0) {
            return { text: '失败：没有可用的本地中转；剪贴板发送只支持附近频道。先在设置里把 chatMode 改成 relay。', failed: true };
          }

          const found = findGameWindow();
          if (!found.window) {
            const names = windowCandidates(found.visible);
            return {
              text: `失败：${found.reason}${names ? `。可见窗口：${names}` : ''}（耗时 ${elapsed(started)}ms）`,
              failed: true,
            };
          }
          const win = found.window;
          const raised = raiseWindow(win);
          if (!raised.ok) return { text: `失败：${raised.reason}（耗时 ${elapsed(started)}ms）`, failed: true };
          if (await pause(cfg.focusDelayMs, call?.signal)) {
            return { text: `已取消，没有发消息（耗时 ${elapsed(started)}ms）。`, failed: true };
          }
          refreshClient(win);
          if (!foreground(win)) {
            return { text: `失败：游戏窗口没有到前台，消息未发（耗时 ${elapsed(started)}ms）。`, failed: true };
          }

          const native = win32();
          try {
            native.chord([ENTER], 0);
          } catch (error) {
            return { text: `失败：按回车打开聊天失败：${shortError(error)}（耗时 ${elapsed(started)}ms）`, failed: true };
          }
          if (await pause(cfg.channelDelayMs, call?.signal)) {
            return { text: `已取消，已按回车但没有粘贴（耗时 ${elapsed(started)}ms）。`, failed: true };
          }
          if (!foreground(win)) {
            return { text: `失败：回车后游戏窗口失去前台，消息未发（耗时 ${elapsed(started)}ms）。`, failed: true };
          }

          const point = pointInClient(win.client, cfg, cfg.chatInput);
          try {
            native.click(win.client.x + point.x, win.client.y + point.y);
          } catch (error) {
            return { text: `失败：点击聊天输入框失败：${shortError(error)}（耗时 ${elapsed(started)}ms）`, failed: true };
          }
          if (await pause(cfg.clickDelayMs, call?.signal)) {
            return { text: `已取消，没有粘贴（耗时 ${elapsed(started)}ms）。`, failed: true };
          }
          if (!foreground(win)) {
            return { text: `失败：点击输入框后游戏窗口失去前台，消息未发（耗时 ${elapsed(started)}ms）。`, failed: true };
          }

          let previousText = null;
          let hadText = false;
          try {
            previousText = native.clipboardGetText();
            hadText = previousText !== null;
          } catch {
            // Clipboard is busy; proceeding still works, but there is nothing to
            // restore, so the restore step below clears our own text.
          }

          let changedClipboard = false;
          let failure = null;
          let warning = null;
          let pressedSend = false;
          try {
            native.clipboardSetText(text);
            changedClipboard = true;
            await pause(30, call?.signal);
            native.chord(CTRL_V, 0);
            if (await pause(cfg.pasteDelayMs, call?.signal)) {
              failure = '粘贴后已被取消';
            } else if (!foreground(win)) {
              failure = '粘贴后游戏窗口失去前台';
            } else {
              native.chord([ENTER], 0);
              pressedSend = true;
              if (await pause(cfg.sendDelayMs, call?.signal)) {
                warning = '回车已发，但等待期间被中断；消息可能已经发出';
              }
            }
          } catch (error) {
            failure = shortError(error);
          } finally {
            let restoreError = null;
            if (changedClipboard && cfg.restoreClipboard) {
              try {
                native.clipboardSetText(hadText ? previousText : '');
              } catch (error) {
                restoreError = shortError(error);
              }
            }
            // A failed clipboard restore does not make a sent message unsent;
            // reporting failed would invite a duplicate retry.
            if (restoreError) {
              if (pressedSend) warning = `恢复剪贴板失败：${restoreError}`;
              else if (!failure) failure = `恢复剪贴板失败：${restoreError}`;
            }
          }

          if (failure) {
            return { text: `失败：${failure}（耗时 ${elapsed(started)}ms）。`, failed: true };
          }
          return {
            text: `已发出：已向「${win.title}」附近频道发送（${text.length} 字，回车开面板→点击输入框→Ctrl+V→回车，耗时 ${elapsed(started)}ms）。这是剪贴板路径，没有服务器回执。${warning ? ` 注意：${warning}。` : ''}`,
          };
        },
      },
      {
        name: 'of_chat_read',
        description: [
          'Read recent chat messages from 开放空间 (OverField) as plain text lines.',
          'Messages come from the game protocol itself (channel, time, speaker, content); this extension never screenshots the game.',
          'The optional channels filter accepts ids or names, for example "0,1,2" or "nearby,world,private".',
          'Returns the last n messages, oldest first, shaped as "[channel HH:MM] nick: content".',
          'If the chat process is not running it says so instead of guessing.',
        ].join(' '),
        tags: ['read'],
        parameters: {
          type: 'object',
          properties: {
            n: {
              type: 'integer',
              minimum: 1,
              maximum: 50,
              description: 'How many recent messages to return; defaults to 20.',
            },
            channels: {
              type: 'string',
              maxLength: 120,
              description: 'Channels to include: ids ("0,1,2") or names ("nearby,world,private"). Omit for all.',
            },
          },
          required: [],
        },
        handler: async (args) => {
          const cfg = settings(this.cfg);
          const n = clamp(Math.round(Number(args?.n) || 20), 1, 50);
          const channels = parseChannels(args?.channels);
          if (this.feed) {
            const recent = this.feed.recent({ n, channels });
            if (recent.length) return { text: recent.map((msg) => this.feed.line(msg)).join('\n') };
          }
          const dir = this.chatDir(cfg);
          const status = this.feed?.status ?? readStatus(dir);
          const alive = this.feed ? this.feed.bridgeAlive() : statusAlive(status);
          const label = channels ? [...channels].map((id) => cfg.channelNames[id] ?? id).join('/') : '全部频道';
          if (alive) {
            return { text: `聊天进程在运行，${label}最近没有新消息（已抓到 ${status?.chats ?? 0} 条；游戏里说句话就会进来）。` };
          }
          return {
            text: `聊天进程没在运行，也没有可读的缓存。用 of_chat_bridge(action="start") 启动；status 会给出当前模式和最近错误。${status?.lastError ? ` 最近错误：${status.lastError}` : ''}`,
          };
        },
      },
      {
        name: 'of_chat_bridge',
        description: [
          'Start, stop or inspect the chat process for 开放空间 (OverField).',
          'Two modes: capture reads the gateway TCP stream passively through Npcap (read only); relay runs a local dispatch/gate relay that can also send chat over the protocol.',
          'status reports the mode, adapter or relay ports, counters and the last error; start launches the configured mode in the background; stop terminates it.',
          'Neither mode injects into the game process or reads its memory. Relay mode needs the one-time hosts line from relay/setup-hosts.cmd.',
          'Chat recording lives in the separate 开放空间聊天 World; this process only feeds events and sends.',
        ].join(' '),
        tags: ['read', 'act'],
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['status', 'start', 'stop'],
              description: 'What to do with the chat process. Defaults to status.',
            },
            mode: {
              type: 'string',
              enum: ['capture', 'relay'],
              description: 'Override chatMode for this start. Switching modes stops the other process first.',
            },
            ports: {
              type: 'string',
              maxLength: 64,
              description: 'Capture mode: optional gateway port ranges, e.g. "11000-11100".',
            },
            device: {
              type: 'string',
              maxLength: 200,
              description: 'Capture mode: optional Npcap adapter name or description fragment.',
            },
          },
          required: [],
        },
        handler: async (args) => {
          const cfg = settings(this.cfg);
          const dir = this.chatDir(cfg);
          const action = String(args?.action ?? 'status').toLowerCase();
          const mode = args?.mode === 'relay' || args?.mode === 'capture' ? args.mode : cfg.chatMode;

          if (action === 'start') {
            try {
              if (mode === 'capture' && await hostsPointsLocal()) {
                return {
                  text: '失败：hosts 已把区服域名指向 127.0.0.1，抓包模式会让游戏登录失败。先运行 relay/remove-hosts.cmd，或改用 relay 模式。',
                  failed: true,
                };
              }
              const existing = readStatus(dir);
              if (statusAlive(existing) && existing.mode !== mode) stopBridge({ dir, log: this.host?.log });
              const result = mode === 'relay'
                ? startRelay({
                  dir,
                  dispatchPort: cfg.relayDispatchPort,
                  gatePort: cfg.relayGatePort,
                  controlPort: cfg.relayControlPort,
                  dispatchIp: cfg.relayDispatchIp,
                  log: this.host?.log,
                })
                : startBridge({
                  dir,
                  ports: typeof args?.ports === 'string' && args.ports.trim() ? args.ports.trim() : cfg.bridgePorts,
                  device: typeof args?.device === 'string' ? args.device.trim() : cfg.bridgeDevice,
                  log: this.host?.log,
                });
              this.bridgeStarted = true;
              this.bridgeError = '';
              const what = mode === 'relay' ? '本地中转' : '被动抓包';
              return {
                text: result.started
                  ? `已启动${what}（pid ${result.pid}）。1–3 秒后用 of_chat_bridge(action="status") 看计数。${mode === 'relay' ? '第一次用中转要先运行 relay/setup-hosts.cmd 并重新登录。' : '游戏需要在运行并进入有聊天的场景。'}`
                  : `${what}已经在运行（pid ${result.pid}）。`,
              };
            } catch (error) {
              this.bridgeError = shortError(error);
              return { text: `失败：启动聊天进程时出错：${this.bridgeError}。`, failed: true };
            }
          }

          if (action === 'stop') {
            const result = stopBridge({ dir, log: this.host?.log });
            this.bridgeStarted = false;
            return {
              text: result.stopped ? `已停止聊天进程（pid ${result.pid}）。` : `没有在运行：${result.reason}。`,
            };
          }

          const status = readStatus(dir);
          const actualMode = status?.mode ?? this.chatMode ?? mode;
          const lines = [describeStatus(status), `模式：${actualMode}；数据目录：${dir}`];
          if (this.modeNote) lines.push(`注意：${this.modeNote}`);
          if (this.feed) {
            lines.push(
              `内存里：${this.feed.messages.length} 条（实时 ${this.feed.stats.chats} / 历史 ${this.feed.stats.history} / 我发出 ${this.feed.stats.sent}）`,
            );
            lines.push(`本人角色：${this.feed.selfName || cfg.selfName || '未知（登录包里没读到）'}`);
          }
          if (this.bridgeError) lines.push(`启动错误：${this.bridgeError}`);
          if (status?.lastError) lines.push(`进程错误：${status.lastError}`);
          return { text: lines.join('\n') };
        },
      },
      {
        name: 'of_scene',
        description: [
          'Return the current 开放空间 (OverField) scene roster: scene id, channel, how many players are here, and each player with their player id and distance when both positions are known.',
          'Read-only, from the scene sync packets. The roster is a snapshot that only changes on a real scene/channel change; it is not a live list and does not refresh on movement.',
        ].join(' '),
        tags: ['read', 'snapshot'],
        parameters: { type: 'object', properties: {}, required: [] },
        handler: async () => {
          const feed = this.feed;
          if (!feed) return { text: '聊天进程没在运行，读不到场景。', failed: true };
          const scene = feed.state.scene;
          if (!scene) return { text: '还没有场景数据：换一次场景或重新登录后再看。' };
          const players = feed.scenePlayers();
          const selfPos = feed.state.positions.get(feed.selfId)?.chars?.[0]?.pos ?? null;
          const posCount = players.filter((p) => p.pos).length;
          const label = scene.channelLabel ? `（${scene.channelLabel}）` : '';
          const at = Date.parse(scene.ts ?? '');
          const ageMin = Number.isFinite(at) ? Math.max(0, Math.round((Date.now() - at) / 60_000)) : null;
          const stamp = Number.isFinite(at) ? ` · 快照 ${this.shortClock(at)}${ageMin !== null ? `（${ageMin} 分钟前）` : ''}` : '';
          const lines = [`场景 ${scene.sceneId} · 频道 ${scene.channelId ?? '?'}${label} · ${players.length} 人${stamp}`];
          if (!selfPos) {
            lines.push(`坐标：自己的位置还没同步，算不出距离（${posCount}/${players.length} 人有坐标）`);
          } else if (posCount < players.length) {
            lines.push(`坐标：${posCount}/${players.length} 人有坐标`);
          }
          for (const player of players.slice(0, 30)) {
            let dist = '';
            if (selfPos && player.pos) {
              const dx = player.pos.x - selfPos.x;
              const dz = player.pos.z - selfPos.z;
              dist = ` · 距你 ${Math.hypot(dx, dz).toFixed(1)}m`;
            }
            const me = player.playerId === feed.selfId ? '（我）' : '';
            const id = player.playerId ? `（id ${player.playerId}）` : '';
            lines.push(`- ${player.name || player.playerId}${id}${me}${dist}`);
          }
          if (players.length > 30) lines.push(`…还有 ${players.length - 30} 人`);
          lines.push('（名单只在换场景/频道时更新，不会主动刷新）');
          return { text: lines.join('\n') };
        },
      },
      {
        name: 'of_friends',
        description: [
          'List friends with online state, level and signature.',
          'In relay mode it asks the server for a fresh list; otherwise it returns the last list seen in capture (the client must have opened the friend panel at least once).',
          'The relay currently sends an empty FriendReq and the server answers status=2 with no list, so an empty result means the request was not accepted, not that you have no friends.',
        ].join(' '),
        tags: ['read', 'snapshot'],
        parameters: { type: 'object', properties: {}, required: [] },
        handler: async () => {
          const cfg = settings(this.cfg);
          const dir = this.chatDir(cfg);
          const feed = this.feed;
          let list = feed?.state.friends ?? [];
          let source = '缓存';
          let statusLine = '';
          if (relayAlive(dir)) {
            try {
              const fresh = await relayFriends(dir);
              if (fresh.friends?.length) { list = fresh.friends; source = '中转实时'; }
              else if (fresh.note) source = `缓存（${fresh.note}）`;
              if (fresh.status !== undefined && fresh.status !== null) {
                statusLine = `；服务器回执 status=${fresh.status}`;
              }
            } catch (error) {
              source = `缓存（中转失败：${shortError(error)}）`;
            }
          }
          if (!list.length) {
            return {
              text: `还没有好友列表${statusLine}。回包原文已写进 overfield-chat/protocol-raw.jsonl；抓包模式需要你在游戏里打开一次好友面板。`,
            };
          }
          const lines = [`好友 ${list.length} 人（${source}）`];
          for (const friend of list.slice(0, 60)) {
            const info = friend.info ?? {};
            const alias = friend.alias ? `（${friend.alias}）` : '';
            const sign = info.sign ? ` · ${info.sign}` : '';
            lines.push(`- ${info.name || info.playerId}${alias} · ${info.level ?? '?'}级 · ${info.online ? '在线' : '离线'}${sign} · id ${info.playerId}`);
          }
          if (list.length > 60) lines.push(`…还有 ${list.length - 60} 人`);
          return { text: lines.join('\n') };
        },
      },
      {
        name: 'of_player_info',
        description: [
          'Show what is known about a player: own profile, a friend, someone in the scene, or someone who spoke recently.',
          'Omit playerId for your own character. Relay mode can refresh friends but does not probe arbitrary players.',
        ].join(' '),
        tags: ['read', 'snapshot'],
        parameters: {
          type: 'object',
          properties: {
            playerId: { type: 'integer', minimum: 1, description: 'Player id; omit for yourself.' },
          },
          required: [],
        },
        handler: async (args) => {
          const feed = this.feed;
          if (!feed) return { text: '聊天进程没在运行，读不到资料。', failed: true };
          const id = Number(args?.playerId) || feed.selfId || 0;
          if (!id) return { text: '还不知道你的 player id：重新登录一次，或等登录包被读到。' };
          const person = feed.playerById(id);
          if (!person) return { text: `还没有 ${id} 的资料（好友/场景/聊天里都没出现过）。` };
          const lines = [
            `角色：${person.name || id}${person.alias ? `（${person.alias}）` : ''}${person.friend ? ' · 好友' : ''}`,
            `id：${id}`,
          ];
          if (person.level) lines.push(`等级：${person.level}${person.worldLevel ? ` · 世界等级 ${person.worldLevel}` : ''}`);
          if (person.sign) lines.push(`签名：${person.sign}`);
          if (person.guildName) lines.push(`公会：${person.guildName}`);
          if (person.friend) lines.push(`在线：${person.online ? '是' : '否'}${person.intimacy ? ` · 亲密度 ${person.intimacy}` : ''}`);
          if (person.sceneId) lines.push(`场景：${person.sceneId} · 频道 ${person.channelId ?? '?'}`);
          return { text: lines.join('\n') };
        },
      },
      {
        name: 'of_chat_history',
        description: [
          'Read recent private messages with one player.',
          'In relay mode it asks the server for a fresh record, which works when the server returns status=1; otherwise it returns the last record seen in capture (the client must have opened that private chat).',
        ].join(' '),
        tags: ['read'],
        parameters: {
          type: 'object',
          properties: {
            target: { type: 'integer', minimum: 1, description: 'The other player id.' },
            n: { type: 'integer', minimum: 1, maximum: 50, description: 'How many recent messages; defaults to 20.' },
          },
          required: ['target'],
        },
        handler: async (args) => {
          const cfg = settings(this.cfg);
          const dir = this.chatDir(cfg);
          const feed = this.feed;
          const target = Number(args?.target) || 0;
          if (!target) return { text: '失败：target 为空。', failed: true };
          let list = feed?.state.private.get(target) ?? [];
          let source = '缓存';
          let statusLine = '';
          if (relayAlive(dir)) {
            try {
              const fresh = await relayHistory(dir, target);
              if (fresh.messages?.length) { list = fresh.messages; source = '中转实时'; }
              else if (fresh.note) source = `缓存（${fresh.note}）`;
              if (fresh.status !== undefined && fresh.status !== null) {
                statusLine = `；服务器回执 status=${fresh.status}`;
              }
            } catch (error) {
              source = `缓存（中转失败：${shortError(error)}）`;
            }
          }
          if (!list.length) {
            return {
              text: `没有和 ${target} 的私聊记录${statusLine}。回包原文已写进 overfield-chat/protocol-raw.jsonl。`,
            };
          }
          const n = clamp(Math.round(Number(args?.n) || 20), 1, 50);
          const lines = [];
          for (const raw of list.slice(-n)) {
            const msg = feed.normalize({ ...raw, channel: 2 });
            if (msg) lines.push(feed.line(msg));
          }
          const name = feed.playerById(target)?.name ?? String(target);
          // Opening the conversation counts as seen, so the reminder stops.
          feed?.markPrivateRead?.(target);
          return { text: `与 ${name} 的私聊（${source}）\n${lines.join('\n')}` };
        },
      },
      {
        name: 'of_unread',
        description: [
          'List private messages from other players that are still unanswered, oldest conversation first.',
          'Each line names the player, how many messages are pending, and the last message.',
          'It marks them read by default (the pet has now seen them); pass markRead=false to only peek, or target one player id.',
          'The World also pushes an of.privateUnread reminder on its own when a private message stays unanswered.',
        ].join(' '),
        tags: ['read'],
        parameters: {
          type: 'object',
          properties: {
            markRead: {
              type: 'boolean',
              description: 'Mark the listed conversations read; defaults to true.',
            },
            target: {
              type: 'integer',
              minimum: 1,
              description: 'Only this player id.',
            },
          },
          required: [],
        },
        handler: async (args) => {
          const feed = this.feed;
          if (!feed) return { text: '聊天进程没在运行，读不到未读私聊。', failed: true };
          const target = Math.max(0, Math.round(Number(args?.target) || 0));
          const all = feed.unreadList();
          const list = target ? all.filter((entry) => entry.playerId === target) : all;
          if (!list.length) {
            return { text: target ? `没有来自 ${target} 的未读私聊。` : '没有未读私聊。' };
          }
          const lines = [`未读私聊 ${all.length} 人 / ${feed.unreadTotal()} 条${target ? `（只列 ${target}）` : ''}`];
          for (const entry of list) {
            const who = entry.name ? `${entry.name}（id ${entry.playerId}）` : String(entry.playerId);
            const when = this.shortClock(entry.lastSendTime);
            const body = entry.lastText
              ? `：${String(entry.lastText).slice(0, 60)}`
              : entry.lastExpression ? '：[表情]' : '';
            lines.push(`- ${who} · ${entry.count} 条${when ? ` · 最后 ${when}` : ''}${body}`);
          }
          if (args?.markRead !== false) {
            feed.markPrivateRead(target);
            lines.push('已标记为已读；回复用 of_chat_send(channel=2, target=玩家 id)。');
          } else {
            lines.push('没有标记已读（markRead=false）。');
          }
          return { text: lines.join('\n') };
        },
      },
      {
        name: 'of_position',
        description: [
          'Read the last known position of yourself or one other player in 开放空间 (OverField).',
          'Coordinates come from the scene sync packets and refresh about every 2 seconds. Omit both arguments for yourself; pass `playerId` or `name` for someone else.',
          'Use it only when you actually need a position (for example to walk toward a player); do not poll it in a loop. It is read-only and never moves anyone.',
        ].join(' '),
        tags: ['read', 'snapshot'],
        parameters: {
          type: 'object',
          properties: {
            playerId: { type: 'integer', minimum: 1, description: 'Player id; omit for yourself.' },
            name: { type: 'string', maxLength: 40, description: 'Display name, if the id is not known.' },
          },
          required: [],
        },
        handler: async (args) => {
          const feed = this.feed;
          if (!feed) return { text: '聊天进程没在运行，读不到位置。', failed: true };
          const wantedName = typeof args?.name === 'string' ? args.name.trim() : '';
          let id = Number(args?.playerId) || 0;
          if (!id && wantedName) id = feed.findPlayerByName(wantedName);
          if (!id && !wantedName) id = Number(feed.selfId) || 0;
          if (!id) {
            return {
              text: wantedName
                ? `还没有「${wantedName}」的 player id：等对方在场景/好友/聊天里出现一次，或直接给 playerId。`
                : '还不知道你的 player id：重新登录一次，或等登录包被读到。',
            };
          }
          const pos = feed.positionOf(id);
          const scene = feed.state.scene ?? {};
          if (!pos) {
            return {
              text: `还没有 ${id} 的位置：场景同步包每 2 秒左右来一次，等一会儿或换一次场景再看。`,
            };
          }
          const self = feed.selfPosition();
          const person = feed.playerById(id);
          const who = id === feed.selfId ? '我' : (person?.name || wantedName || String(id));
          const dist = self && id !== feed.selfId
            ? Math.hypot(pos.x - self.x, pos.z - self.z)
            : null;
          const updated = pos.updatedAt ? ` · 同步 ${this.shortClock(Date.parse(pos.updatedAt))}` : '';
          const lines = [
            `${who}（id ${id}）位置：(${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`,
            `场景 ${scene.sceneId ?? '?'} · 频道 ${scene.channelId ?? '?'}${dist !== null ? ` · 距你 ${dist.toFixed(1)}m` : ''}${updated}`,
          ];
          return { text: lines.join('\n') };
        },
      },
      {
        name: 'of_state',
        description: [
          'Return a short text state of the 开放空间 (OverField) window: foreground, client size, chat transport mode and how many messages were captured.',
          'Read-only: it does not bring the game forward, click, type, or send, and it never screenshots the game.',
          'If the window is missing it still reports the chat process state instead of guessing.',
        ].join(' '),
        tags: ['read', 'snapshot'],
        parameters: { type: 'object', properties: {}, required: [] },
        handler: async () => {
          const cfg = settings(this.cfg);
          const status = this.feed?.status ?? readStatus(this.chatDir(cfg));
          const alive = this.feed ? this.feed.bridgeAlive() : statusAlive(status);
          const mode = status?.mode === 'relay' ? '本地中转' : '被动抓包';
          const chatLine = `聊天进程：${mode}${alive ? ' 运行中' : ' 未运行'} · 已收 ${status?.chats ?? this.feed?.stats.chats ?? 0} 条`;
          const found = findGameWindow();
          if (!found.window) {
            const names = windowCandidates(found.visible);
            return {
              text: `窗口：${found.reason}${names ? `。可见窗口：${names}` : ''}\n${chatLine}`,
            };
          }
          const win = found.window;
          const client = clientRect(win);
          const frame = win32().frameRect(win.hwnd) ?? win.frame;
          const isForeground = foreground(win);
          const lines = [
            `窗口：${win.title}${win.process ? ` [${win.process}]` : ''}${win.className ? ` · ${win.className}` : ''} · ${isForeground ? '前台' : '后台'}${win.minimized ? '（最小化）' : ''}`,
            `client：${client ? `${client.width}×${client.height}` : '不可用'}${frame ? `（窗口 ${frame.width}×${frame.height}）` : ''}`,
            chatLine,
          ];
          if (this.feed?.selfName) lines.push(`本人角色：${this.feed.selfName}`);
          const unread = this.unreadSummary();
          if (unread) lines.push(unread);
          return { text: lines.join('\n') };
        },
      },
    ].map((tool) => ({
      // 每次工具调用都刷新「还在玩」的时间，自动隐藏才不会把人踢掉。
      ...tool,
      handler: (...args) => {
        this.touch();
        return tool.handler(...args);
      },
    }));
  }

  webUi(language = 'zh') {
    return {
      label: language === 'en' ? 'OverField' : '开放空间',
      config: overfieldConfigGroups(language),
      promptDocs: [{
        key: `worlds.${OVERFIELD_ID}.envPrompt`,
        title: language === 'en' ? 'OverField environment prompt' : '开放空间环境提示词',
        description: language === 'en'
          ? 'Teaches the pet when to use the OverField tools, how to reply, and what not to do.'
          : '告诉桌宠何时用开放空间工具、怎么回消息、哪些不能做。',
        path: ENV_PROMPT_FILE,
        role: 'envPrompt',
        vars: [
          { name: 'overfield.mode', description: '当前取数模式和运行状态' },
          { name: 'overfield.self', description: '本人角色名和 player id' },
          { name: 'overfield.scene', description: '当前场景 / 频道 / 人数' },
          { name: 'overfield.unread', description: '未读私聊摘要' },
          { name: 'overfield.position', description: '本人最后已知坐标' },
        ],
      }],
    };
  }
}

export { DEFAULTS };
