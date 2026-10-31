import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FrameParser } from '../bridge/frame.mjs';
import { decodeSendChatMsgReq, encodeFrame } from '../bridge/proto.mjs';
import { chatMsgData, chatMsgNotice, frame } from './helpers.mjs';

const RELAY = fileURLToPath(new URL('../relay/main.mjs', import.meta.url));

const DISPATCH_FAKE = 19081;
const GATE_FAKE = 19082;
const DISPATCH_LOCAL = 19881;
const GATE_LOCAL = 19882;
const CONTROL_LOCAL = 19883;

function waitFor(url, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      if (Date.now() > deadline) { reject(new Error(`timeout waiting for ${url}`)); return; }
      try {
        const res = await fetch(url);
        if (res.ok) { resolve(await res.json()); return; }
      } catch { /* retry */ }
      setTimeout(tick, 120);
    };
    tick();
  });
}

test('relay rewrites dispatch, forwards gate, injects chat and records it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'of-relay-'));
  const gateFrames = [];
  let gateConn = null;

  const fakeGate = net.createServer((socket) => {
    gateConn = socket;
    const parser = new FrameParser((f) => {
      gateFrames.push(f);
      if (f.msgId === 1999) {
        // Probe endpoint: reply with a non-chat message so the raw body comes back.
        socket.write(encodeFrame({
          packetId: f.packetId, msgId: 2000, flag: 0, bodyLen: 2, totalPackCount: 0, seqId: f.seqId + 1,
        }, Buffer.from([0x08, 0x01])));
        return;
      }
      if (f.msgId === 1933) {
        const req = decodeSendChatMsgReq(f.body);
        socket.write(encodeFrame({
          packetId: f.packetId, msgId: 1934, flag: 0, bodyLen: 0, totalPackCount: 0, seqId: f.seqId + 1,
        }, Buffer.alloc(0)));
        // Also push a chat notice so the read path is exercised.
        const notice = chatMsgNotice({ type: 0, msg: chatMsgData({ playerId: 42, name: '乙', text: `回声:${req.text}`, sendTime: Date.now() }) });
        socket.write(frame({ msgId: 1936, body: notice, seqId: 1 }));
      }
    });
    socket.on('data', (chunk) => parser.push(chunk));
    socket.on('error', () => { /* client may close first */ });
  });
  const fakeDispatch = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: true, gate_tcp_ip: '127.0.0.1', gate_tcp_port: GATE_FAKE, extra: 'keep' }));
  });

  await new Promise((r) => fakeGate.listen(GATE_FAKE, '127.0.0.1', r));
  await new Promise((r) => fakeDispatch.listen(DISPATCH_FAKE, '127.0.0.1', r));

  const child = spawn(process.execPath, [
    RELAY, '--out', dir,
    '--dispatch-port', String(DISPATCH_LOCAL),
    '--upstream-port', String(DISPATCH_FAKE),
    '--gate-port', String(GATE_LOCAL),
    '--control-port', String(CONTROL_LOCAL),
    '--dispatch-ip', '127.0.0.1',
  ], { stdio: 'ignore', env: { ...process.env, COOPANION_APP_ROOT: process.env.COOPANION_APP_ROOT ?? '' } });

  let client;
  try {
    await waitFor(`http://127.0.0.1:${CONTROL_LOCAL}/status`);

    const region = await (await fetch(`http://127.0.0.1:${DISPATCH_LOCAL}/dispatch/region_info?x=1`)).json();
    assert.equal(region.gate_tcp_ip, '127.0.0.1');
    assert.equal(region.gate_tcp_port, GATE_LOCAL);
    assert.equal(region.extra, 'keep');

    // Connect as the game client would, then send one c2s frame.
    client = net.connect({ host: '127.0.0.1', port: GATE_LOCAL });
    client.on('error', () => { /* asserted through data below */ });
    await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('error', reject); });
    client.write(frame({ msgId: 1007, body: Buffer.alloc(0), seqId: 5 }));
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(gateFrames.some((f) => f.msgId === 1007), 'gate saw the forwarded ping');

    const sent = await (await fetch(`http://127.0.0.1:${CONTROL_LOCAL}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '中转测试', channel: 0 }),
    })).json();
    assert.equal(sent.ok, true);
    assert.ok(gateFrames.some((f) => f.msgId === 1933 && decodeSendChatMsgReq(f.body).text === '中转测试'), 'gate saw injected send');

    const probe = await (await fetch(`http://127.0.0.1:${CONTROL_LOCAL}/probe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msgId: 1999, bodyHex: '08 01'.replace(/\s+/g, ''), expect: 2000 }),
    })).json();
    assert.equal(probe.ok, true);
    assert.equal(probe.msgId, 2000);
    assert.equal(probe.hex, '0801');
    assert.ok(gateFrames.some((f) => f.msgId === 1999 && f.body[1] === 1), 'probe body reached the gate');

    await new Promise((r) => setTimeout(r, 600));
    const lines = readFileSync(join(dir, 'chat.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(lines.some((l) => l.kind === 'sent' && l.text === '中转测试'));
    assert.ok(lines.some((l) => l.kind === 'chat' && l.text === '回声:中转测试' && l.channel === 0));

    const record = await (await fetch(`http://127.0.0.1:${CONTROL_LOCAL}/record`)).json();
    assert.equal(record.enabled, true);
    const frameLines = readFileSync(join(dir, 'frames.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const kinds = frameLines.map((l) => l.kind);
    assert.ok(kinds.includes('record-start'), 'recorder marked its start');
    assert.ok(frameLines.some((l) => l.kind === 'frame' && l.dir === 'c2s' && l.msgId === 1007), 'c2s frame recorded');
    assert.ok(frameLines.some((l) => l.kind === 'frame' && l.dir === 's2c' && l.msgId === 1936 && l.hex.length > 0), 's2c body recorded');
    assert.ok(frameLines.some((l) => l.kind === 'inject' && l.msgId === 1999), 'probe injection marked');
    const tail = await (await fetch(`http://127.0.0.1:${CONTROL_LOCAL}/frames?msgId=1936&limit=5`)).json();
    assert.equal(tail.count, 1);
    assert.equal(tail.frames[0].msgId, 1936);
    const marked = await (await fetch(`http://127.0.0.1:${CONTROL_LOCAL}/record`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'mark', label: 'place-1' }),
    })).json();
    assert.equal(marked.label, 'place-1');

    const status = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8'));
    assert.equal(status.mode, 'relay');
    assert.ok(status.dispatchRequests >= 1);
    assert.ok(status.gateConnections >= 1);
    assert.ok(status.injectedSends >= 1);
    const live = await (await fetch(`http://127.0.0.1:${CONTROL_LOCAL}/status`)).json();
    assert.ok(live.record?.frames >= 3, 'live status carries recorder counters');
    assert.ok(live.record.byMsg.some((m) => m.msgId === 1936));
  } finally {
    try { client?.destroy(); } catch { /* ignore */ }
    child.kill();
    await new Promise((r) => fakeGate.close(r));
    await new Promise((r) => fakeDispatch.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});
