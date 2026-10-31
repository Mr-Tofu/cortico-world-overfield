import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync, renameSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChatFeed, parseChannels } from '../src/feed.js';
import { OverfieldWorld } from '../src/world.js';
import { DEFAULTS, settings } from '../src/config.js';

function record(overrides) {
  return { v: 1, ...overrides };
}

function feedDir() {
  return mkdtempSync(join(tmpdir(), 'of-feed-'));
}

test('history chat reaches the history listener but never the live listener', () => {
  const dir = feedDir();
  try {
    writeFileSync(join(dir, 'chat.jsonl'), [
      JSON.stringify(record({ kind: 'chat', channel: 0, playerId: 1, name: '甲', text: '新的', sendTime: Date.now() })),
      JSON.stringify(record({
        kind: 'history',
        channel: 1,
        messages: [
          { playerId: 3, name: '丙', text: '更早', sendTime: 1760990000000 },
          { playerId: 4, name: '丁', text: '稍早', sendTime: 1760995000000 },
        ],
      })),
      JSON.stringify(record({ kind: 'privateHistory', target: 9, messages: [{ playerId: 9, name: '戊', text: '私聊旧消息', sendTime: 1760980000000 }] })),
    ].join('\n') + '\n');

    const feed = new ChatFeed({ dir, timezone: 'Asia/Shanghai' });
    const live = [];
    const history = [];
    feed.onChat((msg) => live.push(msg));
    feed.onHistory((msg) => history.push(msg));
    feed.poll();

    assert.deepEqual(live.map((m) => m.text), ['新的'], '历史不进实时回调');
    assert.deepEqual(history.map((m) => m.text).sort(), ['更早', '稍早', '私聊旧消息'].sort());
    assert.ok(history.every((m) => m.history === true));
    assert.equal(history.find((m) => m.text === '私聊旧消息').privateTarget, 9);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseChannels accepts ids, names and all', () => {
  assert.deepEqual([...parseChannels('0,1,2')], [0, 1, 2]);
  assert.deepEqual([...parseChannels('nearby,world')], [0, 1]);
  assert.deepEqual([...parseChannels('附近,私聊')], [0, 2]);
  assert.equal(parseChannels('all'), null);
  assert.equal(parseChannels(''), null);
});

test('feed tails chat.jsonl, dedupes and keeps channel labels', () => {
  const dir = feedDir();
  try {
    writeFileSync(join(dir, 'status.json'), JSON.stringify({ v: 1, pid: process.pid, updatedAt: new Date().toISOString(), chats: 2 }));
    writeFileSync(join(dir, 'chat.jsonl'), [
      JSON.stringify(record({ kind: 'self', name: '阿桃' })),
      JSON.stringify(record({ kind: 'chat', channel: 0, playerId: 1, name: '甲', text: '在吗', sendTime: 1761000000000 })),
      JSON.stringify(record({ kind: 'chat', channel: 2, playerId: 2, name: '乙', text: '私聊你', sendTime: 1761000060000 })),
      JSON.stringify(record({ kind: 'chat', channel: 0, playerId: 1, name: '甲', text: '在吗', sendTime: 1761000000000 })),
      JSON.stringify(record({ kind: 'sent', channel: 0, text: '我在', ts: new Date().toISOString() })),
      JSON.stringify(record({ kind: 'history', channel: 1, messages: [{ playerId: 3, name: '丙', text: '旧消息', sendTime: 1760990000000 }] })),
    ].join('\n') + '\n');

    const feed = new ChatFeed({ dir, timezone: 'Asia/Shanghai' });
    feed.poll();

    assert.equal(feed.messages.length, 4); // duplicate collapsed, sent + history included
    assert.equal(feed.selfName, '阿桃');
    assert.equal(feed.stats.chats, 2);
    assert.equal(feed.stats.sent, 1);
    assert.equal(feed.stats.history, 1);

    const nearby = feed.recent({ n: 10, channels: parseChannels('nearby') });
    assert.equal(nearby.length, 2); // 甲 + 我
    assert.match(feed.line(nearby[0]), /^\[附近 \d\d:\d\d\]甲: 在吗$/);
    assert.match(feed.line(nearby[1]), /^\[附近 \d\d:\d\d\]我: 我在$/);

    const priv = feed.recent({ n: 10, channels: parseChannels('private') });
    assert.equal(priv.length, 1);
    assert.equal(priv[0].channelName, '私聊');

    appendFileSync(join(dir, 'chat.jsonl'), JSON.stringify(record({ kind: 'chat', channel: 0, playerId: 4, name: '丁', text: '新消息', sendTime: 1761000120000 })) + '\n');
    feed.poll();
    assert.equal(feed.messages.length, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('expression-only chat is kept as a readable placeholder', () => {
  const dir = feedDir();
  try {
    writeFileSync(join(dir, 'chat.jsonl'), JSON.stringify(record({
      kind: 'chat', channel: 1, playerId: 5, name: '戊', text: '', expression: 101, sendTime: 1761000000000,
    })) + '\n');
    const feed = new ChatFeed({ dir, timezone: 'Asia/Shanghai' });
    feed.poll();
    assert.equal(feed.messages.length, 1);
    assert.equal(feed.messages[0].text, '[表情#101]');
    assert.equal(feed.messages[0].expression, 101);
    assert.match(feed.line(feed.messages[0]), /^\[世界 \d\d:\d\d\]戊: \[表情#101\]$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('expression-only chat uses the emotion map when present', () => {
  const dir = feedDir();
  try {
    writeFileSync(join(dir, 'chat.jsonl'), JSON.stringify(record({
      kind: 'chat', channel: 1, playerId: 5, name: '戊', text: '', expression: 101, sendTime: 1761000000000,
    })) + '\n');
    const feed = new ChatFeed({ dir, timezone: 'Asia/Shanghai' });
    feed.setEmotions({ 101: '开心' });
    feed.poll();
    assert.equal(feed.messages[0].text, '[表情:开心]');
    assert.match(feed.line(feed.messages[0]), /^\[世界 \d\d:\d\d\]戊: \[表情:开心\]$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('feed keeps scene roster, positions, friends and private history', () => {
  const dir = feedDir();
  try {
    writeFileSync(join(dir, 'chat.jsonl'), [
      JSON.stringify(record({ kind: 'profile', playerId: 1, name: '我', level: 20 })),
      JSON.stringify(record({ kind: 'friends', friends: [{ alias: '小乙', info: { playerId: 2, name: '乙', level: 30, online: true } }] })),
      JSON.stringify(record({ kind: 'scene', sceneId: 1001, channelId: 7, channelLabel: 3, players: [{ playerId: 1, name: '我' }, { playerId: 2, name: '乙' }] })),
      JSON.stringify(record({ kind: 'positions', updatedAt: new Date().toISOString(), players: [{ playerId: 1, chars: [{ charId: 1, pos: { x: 1, y: 0, z: 2 } }] }, { playerId: 2, chars: [{ charId: 1, pos: { x: 4, y: 0, z: 6 } }] }] })),
      JSON.stringify(record({ kind: 'privateHistory', target: 2, messages: [{ playerId: 2, name: '乙', text: '昨天说的', sendTime: 1761000000000 }] })),
    ].join('\n') + '\n');
    const feed = new ChatFeed({ dir, timezone: 'Asia/Shanghai' });
    feed.poll();
    assert.equal(feed.selfId, 1);
    assert.equal(feed.state.friends.length, 1);
    assert.equal(feed.friendById(2).alias, '小乙');
    const players = feed.scenePlayers();
    assert.equal(players.length, 2);
    assert.equal(players[1].pos.z, 6);
    assert.equal(feed.state.private.get(2).length, 1);
    assert.equal(feed.playerById(2).name, '乙');
    assert.deepEqual(feed.positionOf(2), { x: 4, y: 0, z: 6, rot: null, updatedAt: feed.state.positions.get(2).updatedAt });
    assert.equal(feed.findPlayerByName('乙'), 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('feed recovers after the bridge rotates chat.jsonl', () => {
  const dir = feedDir();
  try {
    writeFileSync(join(dir, 'chat.jsonl'), JSON.stringify(record({ kind: 'chat', channel: 0, playerId: 1, name: '甲', text: '第一', sendTime: 1 })) + '\n');
    const feed = new ChatFeed({ dir });
    feed.poll();
    assert.equal(feed.messages.length, 1);

    renameSync(join(dir, 'chat.jsonl'), join(dir, 'chat.1.jsonl'));
    writeFileSync(join(dir, 'chat.jsonl'), JSON.stringify(record({ kind: 'chat', channel: 0, playerId: 1, name: '甲', text: '第二', sendTime: 2 })) + '\n');
    feed.poll();
    assert.equal(feed.messages.length, 2);
    assert.equal(feed.messages[1].text, '第二');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('feed tracks unanswered private conversations and clears them on reply', () => {
  const dir = feedDir();
  try {
    writeFileSync(join(dir, 'chat.jsonl'), [
      JSON.stringify(record({ kind: 'self', name: '阿桃', playerId: 1 })),
      JSON.stringify(record({ kind: 'chat', channel: 2, playerId: 2, name: '乙', text: '在吗', sendTime: 1761000000000 })),
      JSON.stringify(record({ kind: 'chat', channel: 2, playerId: 2, name: '乙', text: '打个本', sendTime: 1761000060000 })),
      JSON.stringify(record({ kind: 'chat', channel: 2, playerId: 3, name: '丙', text: '晚上好', sendTime: 1761000120000 })),
      JSON.stringify(record({ kind: 'chat', channel: 0, playerId: 4, name: '丁', text: '附近的', sendTime: 1761000130000 })),
      JSON.stringify(record({ kind: 'chat', channel: 2, playerId: 0, name: '阿桃', text: '我发的', sendTime: 1761000140000 })),
    ].join('\n') + '\n');

    const feed = new ChatFeed({ dir, timezone: 'Asia/Shanghai' });
    feed.startedAt = 0;
    feed.poll();

    assert.equal(feed.state.unread.size, 2, 'private from 乙 and 丙 only');
    assert.equal(feed.unreadTotal(), 3);
    const [first] = feed.unreadList();
    assert.equal(first.playerId, 2);
    assert.equal(first.count, 2);
    assert.equal(first.lastText, '打个本');

    appendFileSync(join(dir, 'chat.jsonl'), JSON.stringify(record({
      kind: 'sent', channel: 2, target: 2, text: '来了', ts: new Date().toISOString(),
    })) + '\n');
    feed.poll();
    assert.equal(feed.state.unread.size, 1);
    assert.equal(feed.unreadList()[0].playerId, 3);

    appendFileSync(join(dir, 'chat.jsonl'), JSON.stringify(record({
      kind: 'privateHistory', target: 3, messages: [{ playerId: 3, name: '丙', text: '晚上好', sendTime: 1761000120000 }],
    })) + '\n');
    feed.poll();
    assert.equal(feed.unreadTotal(), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('world reminds about unread private messages once per cooldown', async () => {
  const dir = feedDir();
  try {
    const cfg = structuredClone(DEFAULTS);
    cfg.pushChatPrivate = true;
    const world = new OverfieldWorld({ cfg, dataDir: dir, botDir: dir, timezone: 'Asia/Shanghai' });
    const pushed = [];
    world.host = { pushEvent: async (event, opts) => { pushed.push({ event, opts }); return event; } };
    const now = Date.now();
    world.feed = {
      unreadList: () => [{
        playerId: 7, name: '乙', count: 2, lastAt: now - 60_000, lastSendTime: now - 60_000, lastText: '在吗',
      }],
      unreadTotal: () => 2,
    };
    const s = settings(cfg);

    assert.equal(await world.checkUnread(s, now), 1);
    assert.equal(pushed.length, 1);
    assert.equal(pushed[0].event.type, 'of.privateUnread');
    assert.equal(pushed[0].opts.trigger, 'flush');
    assert.match(pushed[0].event.text, /乙 2 条/);
    assert.equal(pushed[0].event.meta.total, 2);

    assert.equal(await world.checkUnread(s, now + 60_000), 0);
    assert.equal(pushed.length, 1);

    assert.equal(await world.checkUnread(s, now + 6 * 60_000), 1);
    assert.equal(pushed.length, 2);

    world.feed = {
      unreadList: () => [{
        playerId: 8, name: '丙', count: 1, lastAt: Date.now(), lastSendTime: Date.now(), lastText: 'hi',
      }],
      unreadTotal: () => 1,
    };
    assert.equal(await world.checkUnread(s, Date.now()), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('initial scan loads old chat without replaying it as new', async () => {
  const dir = feedDir();
  try {
    const old = Date.now() - 6 * 60 * 60_000;
    writeFileSync(join(dir, 'chat.jsonl'), [
      JSON.stringify(record({ kind: 'chat', channel: 2, playerId: 2, name: '乙', text: '昨晚的私聊', sendTime: old })),
      JSON.stringify(record({ kind: 'chat', channel: 0, playerId: 1, name: '甲', text: '早就说过了', sendTime: old })),
    ].join('\n') + '\n');
    const feed = new ChatFeed({ dir, timezone: 'Asia/Shanghai' });
    const pushed = [];
    feed.onChat((msg) => pushed.push(msg));
    feed.poll();

    assert.equal(feed.recent({ n: 10 }).length, 2, 'old messages stay readable');
    assert.equal(pushed.length, 0, 'old messages are not pushed as new');
    assert.equal(feed.unreadTotal(), 0, 'old private messages do not become unread');

    appendFileSync(join(dir, 'chat.jsonl'), JSON.stringify(record({
      kind: 'chat', channel: 2, playerId: 3, name: '丙', text: '刚发的', sendTime: Date.now(),
    })) + '\n');
    feed.poll();
    assert.equal(pushed.length, 1);
    assert.equal(feed.unreadTotal(), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('of_unread lists pending private chats and marks them read', async () => {
  const dir = feedDir();
  try {
    writeFileSync(join(dir, 'chat.jsonl'), [
      JSON.stringify(record({ kind: 'chat', channel: 2, playerId: 2, name: '乙', text: '在吗', sendTime: 1761000000000 })),
      JSON.stringify(record({ kind: 'chat', channel: 2, playerId: 3, name: '丙', text: '晚上好', sendTime: 1761000120000 })),
    ].join('\n') + '\n');
    const cfg = structuredClone(DEFAULTS);
    const world = new OverfieldWorld({ cfg, dataDir: dir, botDir: dir, timezone: 'Asia/Shanghai' });
    world.feed = new ChatFeed({ dir, timezone: 'Asia/Shanghai' });
    world.feed.startedAt = 0;
    world.feed.poll();

    const tool = world.tools().find((t) => t.name === 'of_unread');
    const peek = await tool.handler({ markRead: false }, {});
    assert.match(peek.text, /未读私聊 2 人 \/ 2 条/);
    assert.match(peek.text, /乙（id 2） · 1 条/);
    assert.equal(world.feed.unreadTotal(), 2, 'markRead=false keeps them pending');

    const read = await tool.handler({}, {});
    assert.match(read.text, /已标记为已读/);
    assert.equal(world.feed.unreadTotal(), 0);
    const empty = await tool.handler({}, {});
    assert.match(empty.text, /没有未读私聊/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shipped emotion map covers the base and character emotes', () => {
  const map = JSON.parse(readFileSync(new URL('../assets/emotions.json', import.meta.url), 'utf8'));
  assert.equal(map['101'], '插刀');
  assert.equal(map['106'], '开心');
  assert.equal(map['611011'], '菲·憧憬');
  assert.ok(Object.keys(map).length >= 200, 'generated from the game tables');
});

test('chat push reasons: private, mention, keyword and per-channel switches', () => {
  const dir = feedDir();
  try {
    const cfg = structuredClone(DEFAULTS);
    cfg.pushChatKeywords = '打本';
    const world = new OverfieldWorld({ cfg, dataDir: dir, botDir: dir, timezone: 'Asia/Shanghai' });
    world.feed = { selfName: '阿桃' };
    const s = settings(cfg);

    assert.deepEqual(world.chatPushReasons({ channel: 2, text: '在吗' }, s).reasons, ['private']);
    assert.deepEqual(world.chatPushReasons({ channel: 0, text: '阿桃来一下' }, s).reasons, ['mention']);
    assert.deepEqual(world.chatPushReasons({ channel: 0, text: '有人打本吗' }, s).reasons, ['keyword']);
    assert.deepEqual(world.chatPushReasons({ channel: 1, text: '世界好吵' }, s).reasons, []);
    assert.deepEqual(world.chatPushReasons({ channel: 5, text: '阿桃' }, s).reasons, ['mention']);

    const all = settings({ ...cfg, pushChatNearby: true, pushChatWorld: true, pushChatTeam: true, pushChatGuild: true, pushChatSystem: true });
    assert.deepEqual(world.chatPushReasons({ channel: 0, text: '随便' }, all).reasons, ['nearby']);
    assert.deepEqual(world.chatPushReasons({ channel: 1, text: '随便' }, all).reasons, ['world']);
    assert.deepEqual(world.chatPushReasons({ channel: 5, text: '随便' }, all).reasons, ['team']);
    assert.deepEqual(world.chatPushReasons({ channel: 6, text: '随便' }, all).reasons, ['guild']);
    assert.deepEqual(world.chatPushReasons({ channel: 3, text: '系统' }, all).reasons, ['system']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('world pushes chat with reasons and skips self', async () => {
  const dir = feedDir();
  try {
    const cfg = structuredClone(DEFAULTS);
    cfg.pushChatKeywords = '打本';
    const world = new OverfieldWorld({ cfg, dataDir: dir, botDir: dir, timezone: 'Asia/Shanghai' });
    world.feed = { selfName: '阿桃', line: (m) => `[${m.channelName}] ${m.name}: ${m.text}` };
    const pushed = [];
    world.host = {
      pushEvent: async (event, opts) => { pushed.push({ event, opts }); return event; },
      log: { warn() {}, info() {} },
    };
    const s = settings(cfg);
    await world.onIncoming({ channel: 2, channelName: '私聊', playerId: 9, name: '乙', text: '在吗', sendTime: 1761000000000, self: false }, s);
    await world.onIncoming({ channel: 0, channelName: '附近', playerId: 9, name: '乙', text: '路过', sendTime: 1761000001000, self: false }, s);
    await world.onIncoming({ channel: 0, channelName: '附近', playerId: 9, name: '乙', text: '阿桃看这里', sendTime: 1761000002000, self: false }, s);
    await world.onIncoming({ channel: 0, channelName: '附近', playerId: 9, name: '乙', text: '来打本', sendTime: 1761000002500, self: false }, s);
    await world.onIncoming({ channel: 2, channelName: '私聊', playerId: 0, name: '阿桃', text: '我发的', sendTime: 1761000003000, self: true }, s);

    assert.equal(pushed.length, 3);
    assert.equal(pushed[0].event.type, 'of.chat');
    assert.equal(pushed[0].event.meta.channel, 2);
    assert.deepEqual(pushed[0].event.meta.reasons, ['private']);
    assert.equal(pushed[0].opts.trigger, 'flush');
    assert.equal(pushed[1].event.meta.channel, 0);
    assert.deepEqual(pushed[1].event.meta.reasons, ['mention']);
    assert.equal(pushed[1].opts.trigger, 'debounce');
    assert.deepEqual(pushed[2].event.meta.reasons, ['keyword']);
    assert.deepEqual(pushed[2].event.meta.keywords, ['打本']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('state pushes follow the per-kind switches', () => {
  const dir = feedDir();
  try {
    const cfg = structuredClone(DEFAULTS);
    cfg.pushScene = true;
    cfg.pushFriends = true;
    cfg.pushProfile = true;
    const world = new OverfieldWorld({ cfg, dataDir: dir, botDir: dir, timezone: 'Asia/Shanghai' });
    const pushed = [];
    world.host = {
      pushEvent: async (event, opts) => { pushed.push({ event, opts }); return event; },
      log: { warn() {} },
    };
    const s = settings(cfg);

    world.onStateChange({ kind: 'scene', scene: { sceneId: 9999, channelId: 1377698, channelLabel: '秋日', players: [{}, {}] } }, s);
    world.onStateChange({ kind: 'friends', online: [{ playerId: 2, name: '乙' }], offline: [], total: 3 }, s);
    world.onStateChange({ kind: 'profile', profile: { name: '阿桃', level: 20, worldLevel: 3, sign: '晚安' } }, s);

    assert.deepEqual(pushed.map((p) => p.event.type), ['of.scene', 'of.friend', 'of.profile']);
    assert.match(pushed[0].event.text, /场景 9999 · 频道 1377698（秋日） · 2 人/);
    assert.match(pushed[1].event.text, /乙 上线/);
    assert.match(pushed[2].event.text, /阿桃 · 20 级 · 世界等级 3/);
    assert.ok(pushed.every((p) => p.opts.trigger === 'debounce'));

    pushed.length = 0;
    const quiet = settings({ ...cfg, pushScene: false, pushFriends: false, pushProfile: false });
    world.onStateChange({ kind: 'scene', scene: { sceneId: 1 } }, quiet);
    world.onStateChange({ kind: 'friends', online: [{ playerId: 2, name: '乙' }], offline: [] }, quiet);
    world.onStateChange({ kind: 'profile', profile: { name: '阿桃' } }, quiet);
    assert.equal(pushed.length, 0);

    const off = settings({ ...cfg, pushEnabled: false });
    world.onStateChange({ kind: 'scene', scene: { sceneId: 2 } }, off);
    assert.equal(pushed.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('feed emits scene/friend/profile changes only when they change', () => {
  const dir = feedDir();
  try {
    writeFileSync(join(dir, 'chat.jsonl'), [
      JSON.stringify(record({ kind: 'scene', sceneId: 1001, channelId: 7, players: [{ playerId: 1, name: '我' }] })),
      JSON.stringify(record({ kind: 'friends', friends: [{ info: { playerId: 2, name: '乙', online: true } }] })),
      JSON.stringify(record({ kind: 'profile', playerId: 1, name: '我', level: 20 })),
    ].join('\n') + '\n');
    const feed = new ChatFeed({ dir, timezone: 'Asia/Shanghai' });
    const events = [];
    feed.onState((event) => events.push(event));
    feed.poll();
    assert.deepEqual(events.map((e) => e.kind), ['scene', 'profile']);

    appendFileSync(join(dir, 'chat.jsonl'), [
      JSON.stringify(record({ kind: 'scene', sceneId: 1001, channelId: 7, players: [{ playerId: 1, name: '我' }] })),
      JSON.stringify(record({ kind: 'friends', friends: [{ info: { playerId: 2, name: '乙', online: false } }] })),
      JSON.stringify(record({ kind: 'profile', playerId: 1, name: '我', level: 20 })),
      JSON.stringify(record({ kind: 'sceneChannel', sceneId: 1001, channelId: 9, channelLabel: '秋日' })),
    ].join('\n') + '\n');
    feed.poll();
    assert.deepEqual(events.map((e) => e.kind), ['scene', 'profile', 'friends', 'scene']);
    assert.equal(events[2].offline[0].name, '乙');
    assert.equal(events[3].scene.channelId, 9);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('position pushes: first fix is silent, movement pushes, heartbeat and auto interval grow', () => {
  const dir = feedDir();
  try {
    const cfg = structuredClone(DEFAULTS);
    cfg.pushPosition = true;
    cfg.positionMoveMeters = 10;
    cfg.positionMoveSeconds = 5;
    cfg.positionGlobalSeconds = 10;
    cfg.positionGlobalMaxSeconds = 30;
    cfg.positionGlobalMode = 'auto';
    const world = new OverfieldWorld({ cfg, dataDir: dir, botDir: dir, timezone: 'Asia/Shanghai' });
    const pushed = [];
    world.host = {
      pushEvent: async (event, opts) => { pushed.push({ event, opts }); return event; },
      log: { warn() {} },
    };
    world.feed = {
      selfId: 1,
      selfName: '阿桃',
      state: { scene: { sceneId: 100, channelId: 7 }, positions: new Map() },
    };
    const s = settings(cfg);
    const at = (x) => [{ playerId: 1, chars: [{ pos: { x, y: 0, z: 0 } }] }];

    world.onStateChange({ kind: 'positions', players: at(0) }, s);
    assert.equal(pushed.length, 0, '没有基准时不推，等第一次移动/心跳');

    world.onStateChange({ kind: 'positions', players: at(12) }, s);
    assert.equal(pushed.length, 1);
    assert.equal(pushed[0].event.type, 'of.position');
    assert.equal(pushed[0].event.meta.reason, 'move');
    assert.equal(pushed[0].event.meta.moved, 12);

    // Same position, but the heartbeat is due.
    world.lastPositionPushAt = Date.now() - 11_000;
    world.onStateChange({ kind: 'positions', players: at(12) }, s);
    assert.equal(pushed.length, 2);
    assert.equal(pushed[1].event.meta.reason, 'heartbeat');
    assert.equal(world.positionUnchanged, 1);
    assert.equal(world.positionGlobalMs, 10_000, '第一次心跳还不拉长');

    // Second unchanged heartbeat: the interval grows.
    world.lastPositionPushAt = Date.now() - 11_000;
    world.onStateChange({ kind: 'positions', players: at(12) }, s);
    assert.equal(pushed.length, 3);
    assert.equal(world.positionUnchanged, 2);
    assert.equal(world.positionGlobalMs, 15_000);

    // A real move resets the interval.
    world.onStateChange({ kind: 'positions', players: at(30) }, s);
    assert.equal(pushed.length, 4);
    assert.equal(pushed[3].event.meta.reason, 'move');
    assert.equal(world.positionGlobalMs, 10_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('of_position reads self and another player without pushing', async () => {
  const dir = feedDir();
  try {
    const cfg = structuredClone(DEFAULTS);
    const world = new OverfieldWorld({ cfg, dataDir: dir, botDir: dir, timezone: 'Asia/Shanghai' });
    const pushed = [];
    world.host = { pushEvent: async (event) => { pushed.push(event); return event; }, log: { warn() {} } };
    world.feed = {
      selfId: 1,
      selfName: '阿桃',
      state: { scene: { sceneId: 100, channelId: 7 } },
      positionOf: (id) => (Number(id) === 1
        ? { x: 0, y: 0, z: 0, updatedAt: new Date().toISOString() }
        : Number(id) === 2 ? { x: 10, y: 0, z: 0, updatedAt: new Date().toISOString() } : null),
      selfPosition: () => ({ x: 0, y: 0, z: 0 }),
      playerById: (id) => (Number(id) === 2 ? { playerId: 2, name: '乙' } : null),
      findPlayerByName: (name) => (name === '乙' ? 2 : 0),
    };
    const tool = world.tools().find((t) => t.name === 'of_position');
    const self = await tool.handler({});
    assert.match(self.text, /我（id 1）位置：\(0\.0, 0\.0, 0\.0\)/);
    const other = await tool.handler({ name: '乙' });
    assert.match(other.text, /乙（id 2）位置：\(10\.0, 0\.0, 0\.0\)/);
    assert.match(other.text, /距你 10\.0m/);
    assert.equal(pushed.length, 0, '查询位置不产生推送');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('environment prompt declares an envPrompt doc and fills short state vars', () => {
  const dir = feedDir();
  try {
    const cfg = structuredClone(DEFAULTS);
    const world = new OverfieldWorld({ cfg, dataDir: dir, botDir: dir, timezone: 'Asia/Shanghai' });
    const doc = world.webUi('zh').promptDocs.find((entry) => entry.role === 'envPrompt');
    assert.ok(doc, '必须声明 role=envPrompt 的模板');
    assert.equal(existsSync(doc.path), true, '模板文件要跟着包一起发');
    assert.equal(doc.path.endsWith('ENV_PROMPT.md'), true);

    const vars = world.envPromptVars();
    assert.deepEqual(Object.keys(vars).sort(), [
      'overfield.mode', 'overfield.position', 'overfield.scene', 'overfield.self', 'overfield.unread',
    ]);
    assert.match(vars['overfield.mode'], /未运行/);
    assert.match(vars['overfield.self'], /未知/);

    const template = readFileSync(doc.path, 'utf8');
    assert.match(template, /\{\{overfield\.mode\}\}/);
    assert.match(template, /of_chat_send/);
    assert.match(template, /of_position/);
    for (const name of Object.keys(vars)) assert.match(template, new RegExp(`\\{\\{${name}\\}\\}`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
