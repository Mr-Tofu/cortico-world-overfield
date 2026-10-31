import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OverfieldWorld } from '../src/world.js';
import { DEFAULTS } from '../src/config.js';

function record(overrides) {
  return { v: 1, ...overrides };
}

test('of_chat_send uses the relay control API when relay mode is live', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'of-relay-send-'));
  const chatDir = join(dir, 'overfield-chat');
  mkdirSync(chatDir, { recursive: true });
  const received = [];
  const control = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      received.push(JSON.parse(body || '{}'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, packetId: 7 }));
    });
  });
  await new Promise((r) => control.listen(19993, '127.0.0.1', r));
  writeFileSync(join(chatDir, 'status.json'), JSON.stringify({
    v: 1, mode: 'relay', pid: process.pid, updatedAt: new Date().toISOString(),
    ports: { dispatch: 18881, gate: 18882, control: 19993 },
  }));

  const cfg = structuredClone(DEFAULTS);
  cfg.chatMode = 'relay';
  cfg.chatEnabled = false;
  const world = new OverfieldWorld({ cfg, dataDir: dir, botDir: dir, timezone: 'Asia/Shanghai' });
  try {
    const tool = world.tools().find((t) => t.name === 'of_chat_send');
    const result = await tool.handler({ text: '中午好', channel: 1 }, {});
    assert.match(result.text, /中转到「世界」/);
    assert.match(result.text, /服务器已回执/);
    assert.equal(received.length, 1);
    assert.deepEqual(received[0], { text: '中午好', channel: 1, target: 0 });
  } finally {
    await world.stop();
    await new Promise((r) => control.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('world start/tail/push/read end to end', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'of-world-'));
  const chatDir = join(dir, 'overfield-chat');
  mkdirSync(chatDir, { recursive: true });
  const pushed = [];
  const host = {
    pushEvent: async (event, opts) => { pushed.push({ event, opts }); return event; },
    log: { info() {}, warn() {} },
  };

  const cfg = structuredClone(DEFAULTS);
  cfg.chatEnabled = false;
  // 唤醒规则默认全关；这个用例验的是推送路径，所以显式打开。
  cfg.wakeOnPrivate = true;
  cfg.wakeOnMention = true;
  const world = new OverfieldWorld({ cfg, dataDir: dir, botDir: dir, timezone: 'Asia/Shanghai' });
  try {
    await world.start(host);

    writeFileSync(join(chatDir, 'status.json'), JSON.stringify({
      v: 1, pid: process.pid, updatedAt: new Date().toISOString(), chats: 2, self: { name: '阿桃' },
    }));
    writeFileSync(join(chatDir, 'chat.jsonl'), [
      JSON.stringify(record({ kind: 'chat', channel: 2, playerId: 7, name: '乙', text: '私聊你一下', sendTime: Date.now() })),
      JSON.stringify(record({ kind: 'chat', channel: 0, playerId: 8, name: '丙', text: '随便说说', sendTime: Date.now() })),
      JSON.stringify(record({ kind: 'chat', channel: 0, playerId: 9, name: '丁', text: '@阿桃 来打本', sendTime: Date.now() })),
    ].join('\n') + '\n');

    await new Promise((resolve) => setTimeout(resolve, 900));

    assert.equal(existsSync(join(dir, 'workspace')), false, '主 World 不再写聊天归档');
    assert.equal(world.feed.selfName, '阿桃');
    assert.equal(pushed.length, 2, 'private + mention only');
    assert.equal(pushed[0].event.meta.channel, 2);
    assert.equal(pushed[1].event.meta.channel, 0);
    assert.match(pushed[1].event.text, /丁: @阿桃 来打本/);

    const readTool = world.tools().find((t) => t.name === 'of_chat_read');
    const result = await readTool.handler({ n: 10, channels: 'nearby' }, {});
    assert.match(result.text, /丙: 随便说说/);
    assert.match(result.text, /丁: @阿桃 来打本/);
    assert.doesNotMatch(result.text, /私聊你一下/);

    const bridgeTool = world.tools().find((t) => t.name === 'of_chat_bridge');
    const statusText = await bridgeTool.handler({ action: 'status' }, {});
    assert.match(statusText.text, /运行中/);
    assert.match(statusText.text, /阿桃/);
  } finally {
    await world.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
