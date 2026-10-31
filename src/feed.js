/**
 * Reads the bridge's append-only chat feed.
 *
 * The bridge writes `chat.jsonl` next to a `status.json`; this module tails the
 * file by byte offset, dedupes retransmitted/echoed messages, and keeps a small
 * in-memory ring the tools and the proactive pusher both read.
 */

import { existsSync, openSync, closeSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const CHANNEL_NAMES = { 0: '附近', 1: '世界', 2: '私聊', 3: '系统', 4: '公告', 5: '队伍', 6: '公会', 7: '喇叭' };

export const CHANNEL_ALIASES = {
  nearby: 0, scene: 0, 附近: 0, 场景: 0,
  world: 1, room: 1, 世界: 1,
  private: 2, dm: 2, 私聊: 2,
  system: 3, 系统: 3,
  notice: 4, 公告: 4,
  team: 5, 队伍: 5,
  guild: 6, 公会: 6,
  horn: 7, 喇叭: 7,
};

const MAX_MESSAGES = 800;

export function parseChannels(value) {
  if (value === undefined || value === null || value === '') return null;
  const list = Array.isArray(value) ? value : String(value).split(/[,，\s]+/);
  const out = new Set();
  for (const item of list) {
    const raw = String(item).trim();
    if (!raw) continue;
    if (raw === 'all' || raw === '全部') return null;
    if (/^\d+$/.test(raw)) {
      out.add(Number(raw));
      continue;
    }
    const id = CHANNEL_ALIASES[raw.toLowerCase()] ?? CHANNEL_ALIASES[raw];
    if (id !== undefined) out.add(id);
  }
  return out.size ? out : null;
}

function shortTime(ms, timeZone) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      hour: '2-digit', minute: '2-digit', hour12: false, timeZone,
    }).format(new Date(ms));
  } catch {
    return '';
  }
}

export function messageKey(msg) {
  return `${msg.channel}|${msg.playerId}|${msg.sendTime}|${msg.text}`;
}

function profileKey(profile) {
  return [profile?.name, profile?.level, profile?.worldLevel, profile?.sign].join('|');
}

function sceneKey(scene) {
  return scene ? `${scene.sceneId ?? ''}|${scene.channelId ?? ''}` : '';
}

/** Online/offline transitions between two friend snapshots (none on the first). */
function friendDelta(previous, next) {
  if (!Array.isArray(previous) || !previous.length) return null;
  const before = new Map();
  for (const friend of previous) {
    const id = friend?.info?.playerId;
    if (id) before.set(id, !!friend?.info?.online);
  }
  const online = [];
  const offline = [];
  for (const friend of next) {
    const info = friend?.info ?? {};
    const id = info.playerId;
    if (!id) continue;
    const now = !!info.online;
    const was = before.get(id);
    if (was === undefined || was === now) continue;
    const entry = { playerId: id, name: info.name ?? '', alias: friend.alias ?? '' };
    if (now) online.push(entry);
    else offline.push(entry);
  }
  return online.length || offline.length ? { online, offline } : null;
}

export class ChatFeed {
  constructor({ dir, timezone = 'Asia/Shanghai', channelNames = CHANNEL_NAMES, log = null } = {}) {
    this.dir = dir;
    this.timezone = timezone;
    this.names = channelNames;
    this.log = log;
    this.feedPath = join(dir, 'chat.jsonl');
    this.statusPath = join(dir, 'status.json');
    this.messages = [];
    this.keys = new Set();
    this.selfName = '';
    this.selfId = 0;
    this.channelId = 0;
    this.offset = 0;
    this.remainder = '';
    this.timer = null;
    this.status = null;
    this.listeners = new Set();
    this.stateListeners = new Set();
    this.historyListeners = new Set();
    this.lastReadAt = 0;
    this.startedAt = Date.now();
    // The first pass over chat.jsonl contains everything from previous
    // sessions. Load it for of_chat_read, but do not re-push it as new chat.
    this.initialScan = true;
    this.stats = { chats: 0, history: 0, sent: 0, dropped: 0 };
    this.state = {
      profile: null,
      friends: [],
      scene: null,
      positions: new Map(),
      private: new Map(),
      // playerId -> pending private conversation the pet has not answered.
      unread: new Map(),
    };
    this.emotions = {};
  }

  setEmotions(map) {
    if (map && typeof map === 'object') this.emotions = { ...map };
  }

  emotionLabel(expression) {
    const name = this.emotions[String(expression)] ?? this.emotions[expression];
    return name ? `[表情:${name}]` : `[表情#${expression}]`;
  }

  start() {
    if (this.timer) return;
    this.poll();
    this.timer = setInterval(() => this.poll(), 600);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  onChat(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * 历史聊天（进场景 / 开私聊时服务器附带的那批）：只给归档用，不叫醒、不推送。
   */
  onHistory(listener) {
    this.historyListeners.add(listener);
    return () => this.historyListeners.delete(listener);
  }

  emitHistory(msg) {
    for (const listener of this.historyListeners) {
      try {
        listener(msg);
      } catch (error) {
        this.log?.warn?.('聊天历史归档回调失败', { err: String(error) });
      }
    }
  }

  /** Scene/friends/profile changes, for the per-kind push switches. */
  onState(listener) {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  poll() {
    this.readStatus();
    this.readFeed();
  }

  readStatus() {
    try {
      if (!existsSync(this.statusPath)) return;
      const raw = statSync(this.statusPath);
      if (this._statusMtime === raw.mtimeMs) return;
      this._statusMtime = raw.mtimeMs;
      const text = readFileSync(this.statusPath, 'utf8');
      const status = JSON.parse(text);
      this.status = status;
      if (status.self?.name) this.selfName = status.self.name;
      if (status.self?.playerId) this.selfId = Number(status.self.playerId) || 0;
      if (typeof status.channel?.channelId === 'number') this.channelId = status.channel.channelId;
    } catch {
      // A status file being replaced atomically is normal; retry next tick.
    }
  }

  readFeed() {
    try {
      if (!existsSync(this.feedPath)) return;
      const st = statSync(this.feedPath);
      const size = st.size;
      const fileId = `${st.dev}:${st.ino}`;
      const replaced = (this.fileId !== undefined && this.fileId !== fileId)
        || (this.fileBirth !== undefined && st.birthtimeMs !== this.fileBirth)
        || size < this.offset;
      this.fileId = fileId;
      this.fileBirth = st.birthtimeMs;
      if (replaced) {
        // Rotated: start the new file from the beginning.
        this.offset = 0;
        this.remainder = '';
      }
      if (size === this.offset) return;

      const fd = openSync(this.feedPath, 'r');
      try {
        const length = size - this.offset;
        const buf = Buffer.alloc(length);
        readSync(fd, buf, 0, length, this.offset);
        this.offset = size;
        this.consume(buf);
      } finally {
        closeSync(fd);
      }
      this.lastReadAt = Date.now();
    } catch (error) {
      this.log?.warn?.('读取聊天桥接文件失败', { err: String(error) });
    }
  }

  consume(buf) {
    const text = this.remainder + buf.toString('utf8');
    const lines = text.split('\n');
    this.remainder = lines.pop() ?? '';
    if (this.remainder.length > 1_000_000) this.remainder = '';
    let sawAny = false;
    for (const line of lines) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        this.stats.dropped += 1;
        continue;
      }
      sawAny = true;
      this.accept(record);
    }
    if (sawAny) this.initialScan = false;
  }

  /** A message that was sent close to this process start, i.e. not replay. */
  isFresh(msg) {
    const at = Number(msg?.sendTime) || Date.parse(msg?.ts ?? '') || 0;
    return at > 0 && at >= this.startedAt - 120_000;
  }

  accept(record) {
    if (!record || record.v !== 1) return;
    if (record.kind === 'chat') {
      const msg = this.normalize(record);
      if (!msg) return;
      if (this.push(msg)) {
        // Old records still land in the ring (so of_chat_read can see them),
        // but only genuinely recent ones are pushed/unread-counted.
        if (!this.initialScan || this.isFresh(msg)) {
          this.trackUnread(msg);
          this.emit(msg);
        }
      }
      return;
    }
    if (record.kind === 'history') {
      const list = Array.isArray(record.messages) ? record.messages : [];
      for (const item of list) {
        const msg = this.normalize({ ...item, channel: record.channel, ts: record.ts });
        if (msg) {
          msg.history = true;
          this.push(msg);
          this.emitHistory(msg);
        }
      }
      return;
    }
    if (record.kind === 'sent') {
      const msg = this.normalize({
        channel: record.channel,
        playerId: 0,
        name: this.selfName || '我',
        text: record.text,
        expression: record.expression,
        sendTime: 0,
        ts: record.ts,
        privateTarget: record.target,
      });
      if (msg) {
        msg.self = true;
        msg.sent = true;
        this.push(msg);
        // Answering a private conversation clears its unread counter.
        if (msg.channel === 2 && record.target) this.markPrivateRead(record.target);
      }
      return;
    }
    if (record.kind === 'self') {
      if (record.name) this.selfName = String(record.name);
      if (record.playerId) this.selfId = Number(record.playerId) || 0;
      return;
    }
    if (record.kind === 'profile') {
      const previous = this.state.profile;
      this.state.profile = record;
      if (record.name) this.selfName = String(record.name);
      if (record.playerId) this.selfId = Number(record.playerId) || 0;
      if (!previous || profileKey(previous) !== profileKey(record)) {
        this.emitState({ kind: 'profile', profile: record, previous });
      }
      return;
    }
    if (record.kind === 'friends') {
      const previous = this.state.friends;
      const next = Array.isArray(record.friends) ? record.friends : [];
      this.state.friends = next;
      const delta = friendDelta(previous, next);
      if (delta) this.emitState({ kind: 'friends', ...delta, total: next.length });
      return;
    }
    if (record.kind === 'scene') {
      const previous = this.state.scene;
      this.state.scene = record;
      if (sceneKey(previous) !== sceneKey(record)) {
        this.emitState({ kind: 'scene', scene: record, previous });
      }
      return;
    }
    if (record.kind === 'sceneChannel') {
      const previous = this.state.scene;
      this.state.scene = { ...(this.state.scene ?? {}), ...record };
      if (sceneKey(previous) !== sceneKey(this.state.scene)) {
        this.emitState({ kind: 'scene', scene: this.state.scene, previous });
      }
      return;
    }
    if (record.kind === 'positions') {
      for (const player of record.players ?? []) {
        if (player?.playerId) this.state.positions.set(player.playerId, { ...player, updatedAt: record.updatedAt });
      }
      // The World decides whether a push is due; the feed only reports the batch.
      this.emitState({ kind: 'positions', players: record.players ?? [] });
      return;
    }
    if (record.kind === 'privateHistory') {
      const target = Number(record.target) || 0;
      const list = Array.isArray(record.messages) ? record.messages : [];
      this.state.private.set(target, list);
      // The conversation was opened (in game or through the relay): seen.
      if (target) this.markPrivateRead(target);
      for (const item of list) {
        const msg = this.normalize({ ...item, channel: 2, privateTarget: target });
        if (msg) {
          msg.history = true;
          msg.privateTarget = target;
          this.push(msg);
          this.emitHistory(msg);
        }
      }
      return;
    }
    if (record.kind === 'channel') {
      if (typeof record.channelId === 'number') this.channelId = record.channelId;
    }
  }

  normalize(record) {
    const rawText = typeof record.text === 'string' ? record.text : '';
    const expression = Number(record.expression) || 0;
    // Expression-only messages (stickers) carry no text; label them instead.
    const text = rawText.trim() ? rawText : expression ? this.emotionLabel(expression) : '';
    if (!text) return null;
    const channel = Number(record.channel) || 0;
    const sendTime = Number(record.sendTime) || 0;
    const ts = typeof record.ts === 'string' ? record.ts : '';
    const name = typeof record.name === 'string' ? record.name : '';
    const playerId = Number(record.playerId) || 0;
    const msg = {
      channel,
      channelName: this.names[channel] ?? `频道${channel}`,
      playerId,
      name,
      text,
      rawText,
      expression,
      sendTime,
      ts,
      time: shortTime(sendTime || Date.parse(ts) || 0, this.timezone),
      self: this.isSelf(playerId, name),
      history: false,
      sent: false,
      privateTarget: Number(record.privateTarget) || 0,
    };
    msg.key = messageKey(msg);
    return msg;
  }

  isSelf(playerId, name) {
    if (this.selfId && playerId && playerId === this.selfId) return true;
    return !!this.selfName && name === this.selfName;
  }

  push(msg) {
    if (this.keys.has(msg.key)) return false;
    this.keys.add(msg.key);
    this.messages.push(msg);
    if (this.messages.length > MAX_MESSAGES) {
      const removed = this.messages.shift();
      this.keys.delete(removed.key);
    }
    if (msg.history) this.stats.history += 1;
    else if (msg.sent) this.stats.sent += 1;
    else this.stats.chats += 1;
    return true;
  }

  emit(msg) {
    for (const listener of this.listeners) {
      try {
        listener(msg);
      } catch (error) {
        this.log?.warn?.('聊天推送回调失败', { err: String(error) });
      }
    }
  }

  emitState(event) {
    for (const listener of this.stateListeners) {
      try {
        listener(event);
      } catch (error) {
        this.log?.warn?.('状态推送回调失败', { err: String(error) });
      }
    }
  }

  /* ---------- unread private conversations ---------- */

  /** Remember a private message from someone else until we answer or see it. */
  trackUnread(msg) {
    if (msg.channel !== 2 || msg.self) return;
    const id = Number(msg.playerId) || 0;
    if (!id) return;
    const now = Date.now();
    let entry = this.state.unread.get(id);
    if (!entry) {
      entry = {
        playerId: id,
        name: msg.name || '',
        count: 0,
        firstAt: now,
        lastAt: now,
        firstSendTime: 0,
        lastSendTime: 0,
        lastText: '',
        lastExpression: 0,
      };
      this.state.unread.set(id, entry);
    }
    const first = entry.count === 0;
    entry.count += 1;
    if (msg.name) entry.name = msg.name;
    entry.lastAt = now;
    entry.lastSendTime = msg.sendTime || 0;
    entry.lastText = msg.rawText || msg.text || '';
    entry.lastExpression = msg.expression || 0;
    if (first) entry.firstSendTime = msg.sendTime || 0;
  }

  /** Clear one player's unread counter, or every one when playerId is 0. */
  markPrivateRead(playerId = 0) {
    const id = Number(playerId) || 0;
    if (id) {
      const had = this.state.unread.delete(id);
      return had ? 1 : 0;
    }
    const count = this.state.unread.size;
    this.state.unread.clear();
    return count;
  }

  /** Oldest conversation first, so reminders do not starve anyone. */
  unreadList() {
    return [...this.state.unread.values()].sort((a, b) => a.lastAt - b.lastAt);
  }

  unreadTotal() {
    let total = 0;
    for (const entry of this.state.unread.values()) total += entry.count;
    return total;
  }

  /** Recent messages, oldest first, optionally filtered by channel ids. */
  recent({ n = 20, channels = null } = {}) {
    const list = this.messages.filter((m) => !channels || channels.has(m.channel));
    return list.slice(-Math.max(1, Math.min(50, n)));
  }

  line(msg) {
    const tag = msg.channelName || '聊天';
    const who = msg.self ? '我' : msg.name || String(msg.playerId || '?');
    const when = msg.time ? `${msg.time} ` : '';
    return `[${tag} ${when}]${who}: ${msg.text}`.replace(' ]', ']');
  }

  /** Scene roster merged with the latest positions. */
  scenePlayers() {
    const players = this.state.scene?.players ?? [];
    return players.map((p) => {
      const sync = this.state.positions.get(p.playerId);
      const char = sync?.chars?.[0];
      return { ...p, pos: char?.pos ?? null, rot: char?.rot ?? null };
    });
  }

  /** Last known position of one player, or null when no sync has arrived. */
  positionOf(playerId) {
    const id = Number(playerId) || 0;
    if (!id) return null;
    const sync = this.state.positions.get(id);
    const pos = sync?.chars?.[0]?.pos ?? sync?.pos;
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.z)) return null;
    return { x: pos.x, y: pos.y ?? 0, z: pos.z, rot: sync?.chars?.[0]?.rot ?? null, updatedAt: sync.updatedAt ?? '' };
  }

  selfPosition() {
    return this.positionOf(this.selfId);
  }

  /** Resolve a display name to a player id from profile / friends / scene / recent chat. */
  findPlayerByName(name) {
    const wanted = String(name ?? '').trim();
    if (!wanted) return 0;
    const holders = [
      this.state.profile,
      ...this.state.friends.map((friend) => friend?.info),
      ...(this.state.scene?.players ?? []),
      ...[...this.messages].reverse(),
    ];
    for (const person of holders) {
      if (person?.name === wanted && person.playerId) return Number(person.playerId);
    }
    return 0;
  }

  friendById(playerId) {
    const id = Number(playerId) || 0;
    return this.state.friends.find((f) => f?.info?.playerId === id) ?? null;
  }

  /** A short profile for a person we have seen in chat, friends or scene. */
  playerById(playerId) {
    const id = Number(playerId) || 0;
    if (!id) return null;
    if (this.state.profile?.playerId === id) return this.state.profile;
    const friend = this.friendById(id);
    if (friend) return { ...friend.info, alias: friend.alias, intimacy: friend.intimacy, friend: true };
    const scenePlayer = this.state.scene?.players?.find((p) => p.playerId === id);
    if (scenePlayer) return { playerId: id, name: scenePlayer.name, avatarFrame: scenePlayer.avatarFrame };
    for (const msg of [...this.messages].reverse()) {
      if (msg.playerId === id && msg.name) return { playerId: id, name: msg.name };
    }
    return null;
  }

  bridgeAlive(now = Date.now()) {
    const status = this.status;
    if (!status || !status.pid) return false;
    const updated = Date.parse(status.updatedAt ?? status.startedAt ?? '');
    if (!Number.isFinite(updated)) return false;
    if (now - updated > 8000) return false;
    try {
      process.kill(status.pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}
