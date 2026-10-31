#!/usr/bin/env node
/**
 * OverField local relay (本地中转版).
 *
 * Sits between the game client and the gateway so the extension can both read
 * and send chat over the game's own protocol:
 *
 *   client → 127.0.0.1:18881 (dispatch rewrite) → real dispatch
 *   client → 127.0.0.1:18882 (gate relay)      → real gate
 *
 * The dispatch response's `gate_tcp_ip` / `gate_tcp_port` are rewritten to the
 * local gate relay. Nothing is injected into the game process; the only system
 * change is one hosts line (see setup-hosts.cmd), because the client must be
 * made to talk to us instead of the real dispatch host.
 *
 * Output is the same chat.jsonl / status.json the passive bridge writes, so the
 * World does not care which mode produced it. A small control API on
 * 127.0.0.1:18883 accepts chat sends and returns the server's reply status.
 */

import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns/promises';
import zlib from 'node:zlib';
import { appendFileSync, closeSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Output } from '../bridge/output.mjs';
import { FrameParser } from '../bridge/frame.mjs';
import { findGate } from '../bridge/gate.mjs';
import { FrameRecorder } from './frames.mjs';
import {
  decodeChangeChatChannelNotice, decodeChangeSceneChannelRsp, decodeChatMsgNotice,
  decodeChatMsgRecordInitNotice, decodeFriendRsp, decodePlayerLoginRsp, decodePlayerMainDataRsp,
  decodePlayerSceneSyncDataNotice, decodePrivateChatMsgRecordReq, decodePrivateChatMsgRecordRsp,
  decodeSceneDataNotice, decodeSendChatMsgReq, decodeTransmitSceneRsp,
  encodeFrame, encodeSendChatMsgReq, encodeTransmitSceneReq, encodePrivateChatMsgRecordReq,
} from '../bridge/proto.mjs';

const MSG = {
  PLAYER_LOGIN_RSP: 1004,
  PLAYER_MAIN_DATA_RSP: 1006,
  SCENE_DATA_NOTICE: 1016,
  CHANGE_SCENE_CHANNEL_RSP: 1202,
  PLAYER_SCENE_SYNC_DATA_NOTICE: 1206,
  SERVER_SCENE_SYNC_DATA_NOTICE: 1208,
  FRIEND_RSP: 1740,
  SEND_CHAT_MSG_REQ: 1933,
  SEND_CHAT_MSG_RSP: 1934,
  CHAT_MSG_NOTICE: 1936,
  CHAT_MSG_RECORD_INIT_NOTICE: 1938,
  PRIVATE_CHAT_MSG_RECORD_REQ: 2013,
  PRIVATE_CHAT_MSG_RECORD_RSP: 2014,
  CHANGE_CHAT_CHANNEL_NOTICE: 2232,
  TRANSMIT_SCENE_REQ: 2315,
  TRANSMIT_SCENE_RSP: 2316,
};

const DEFAULT_DISPATCH_HOST = 'dsp-prod-of.inutan.com';
const FALLBACK_DISPATCH_IP = '14.103.225.205';

function parseArgs(argv) {
  const args = {
    out: '',
    dispatchPort: 18881,
    upstreamPort: 0,
    gatePort: 18882,
    controlPort: 18883,
    dispatchHost: DEFAULT_DISPATCH_HOST,
    dispatchIp: '',
    durationSec: 0,
    record: true,
    recordMaxMb: 64,
    recordBodyKb: 8,
    recordSampleMs: 5000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    const take = () => { i += 1; return value ?? ''; };
    if (key === '--out') args.out = take();
    else if (key === '--dispatch-port') args.dispatchPort = Number(take()) || 18881;
    else if (key === '--upstream-port') args.upstreamPort = Number(take()) || 0;
    else if (key === '--gate-port') args.gatePort = Number(take()) || 18882;
    else if (key === '--control-port') args.controlPort = Number(take()) || 18883;
    else if (key === '--dispatch-host') args.dispatchHost = take() || DEFAULT_DISPATCH_HOST;
    else if (key === '--dispatch-ip') args.dispatchIp = take();
    else if (key === '--duration') args.durationSec = Number(take()) || 0;
    else if (key === '--record') args.record = take() !== 'off';
    else if (key === '--no-record') args.record = false;
    else if (key === '--record-max-mb') args.recordMaxMb = Number(take()) || 64;
    else if (key === '--record-body-kb') args.recordBodyKb = Number(take()) || 8;
    else if (key === '--record-sample-ms') args.recordSampleMs = Number(take()) || 5000;
    else if (key === '--help' || key === '-h') args.help = true;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
args.upstreamPort = args.upstreamPort || args.dispatchPort;
if (args.help || !args.out) {
  console.log([
    'OverField local relay',
    '  --out <dir>            output directory (required)',
    '  --dispatch-port <n>    local dispatch port, default 18881',
    '  --upstream-port <n>    real dispatch port, default = --dispatch-port',
    '  --gate-port <n>        local gate relay port, default 18882',
    '  --control-port <n>     control API port, default 18883',
    '  --dispatch-host <name> default dsp-prod-of.inutan.com',
    '  --dispatch-ip <ip>     pin the real dispatch IP (otherwise resolved)',
    '  --duration <sec>       stop after N seconds',
    '  --record on|off        full-frame recorder, default on',
    '  --record-max-mb <n>    rotate frames.jsonl above N MB, default 64',
    '  --record-body-kb <n>   max body bytes per frame, default 8',
    '  --record-sample-ms <n> sample noisy 1206/1208 sync this often, default 5000',
  ].join('\n'));
  process.exit(args.help ? 0 : 2);
}

const output = new Output(args.out, { mode: 'relay', filter: '', npcap: '' });
output.init();

const recorder = new FrameRecorder(args.out, {
  enabled: args.record,
  bodyLimit: Math.max(1024, args.recordBodyKb * 1024),
  maxBytes: Math.max(1, args.recordMaxMb) * 1024 * 1024,
  sampleMs: args.recordSampleMs,
});
recorder.open();

let stopping = false;
let realGate = null;
let dispatchIp = '';
let hostsActive = false;
let activeSession = null;
let lastPrivateTarget = 0;
const counters = { dispatchRequests: 0, regionRewrites: 0, gateConnections: 0, injected: 0, injectedOk: 0, injectedFailed: 0 };

/** Message ids kept verbatim for schema work; chat itself is not dumped. */
const RAW_MSG_IDS = new Set([1739, 1740, 2013, 2014, 2315, 2316]);

function dumpRaw(kind, msgId, packetId, body, extra = {}) {
  try {
    appendFileSync(join(args.out, 'protocol-raw.jsonl'), `${JSON.stringify({
      ts: new Date().toISOString(),
      kind,
      msgId,
      packetId,
      len: body.length,
      hex: body.toString('hex').slice(0, 40_000),
      ...extra,
    })}\n`);
  } catch {
    // Diagnostics must never break the relay.
  }
}

/* ------------------------------------------------------------------ *
 * Dispatch HTTP server: rewrite region_info's gate address.
 * ------------------------------------------------------------------ */

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function resolveDispatch() {
  if (args.dispatchIp) { dispatchIp = args.dispatchIp; return dispatchIp; }
  try {
    const looked = await dns.lookup(args.dispatchHost);
    if (looked?.address && looked.address !== '127.0.0.1') { dispatchIp = looked.address; return dispatchIp; }
  } catch { /* fall through */ }
  // With the hosts line active, dns.lookup returns 127.0.0.1; ask real DNS instead.
  try {
    const resolver = new dns.Resolver();
    resolver.setServers(['223.5.5.5', '119.29.29.29', '8.8.8.8']);
    const list = await resolver.resolve4(args.dispatchHost);
    if (list?.[0]) { dispatchIp = list[0]; return dispatchIp; }
  } catch { /* fall through */ }
  if (!dispatchIp) dispatchIp = FALLBACK_DISPATCH_IP;
  return dispatchIp;
}

function rewriteRegionInfo(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (!json || typeof json.gate_tcp_ip !== 'string') return null;
  realGate = { ip: json.gate_tcp_ip, port: Number(json.gate_tcp_port) || 0 };
  output.setStatus({ gate: { ip: realGate.ip, port: realGate.port, local: args.gatePort } });
  counters.regionRewrites += 1;
  output.bump('gateRewrites');
  json.gate_tcp_ip = '127.0.0.1';
  json.gate_tcp_port = args.gatePort;
  return JSON.stringify(json);
}

const dispatchServer = http.createServer(async (req, res) => {
  counters.dispatchRequests += 1;
  output.bump('dispatchRequests');
  try {
    const ip = await resolveDispatch();
    const host = (req.headers.host || `${args.dispatchHost}:${args.dispatchPort}`).replace(/:\d+$/, '');
    const rawUrl = req.url || '/';
    let path = rawUrl;
    if (/^https?:\/\//i.test(rawUrl)) {
      const parsed = new URL(rawUrl);
      path = parsed.pathname + parsed.search;
    }
    const isRegion = /\/dispatch\/region_info(?:\?|$)/.test(path);
    const body = await readBody(req);
    const headers = {
      ...req.headers,
      host: `${args.dispatchHost}:${args.dispatchPort}`,
      'accept-encoding': 'identity',
    };
    delete headers['content-length'];
    if (body.length) headers['content-length'] = String(body.length);

    const upstream = http.request({
      host: ip,
      port: args.upstreamPort,
      method: req.method,
      path,
      headers,
      timeout: 10_000,
    }, (up) => {
      const chunks = [];
      up.on('data', (chunk) => chunks.push(chunk));
      up.on('end', () => {
        let responseBody = Buffer.concat(chunks);
        const encoding = String(up.headers['content-encoding'] || '').toLowerCase();
        if (encoding === 'gzip') {
          try { responseBody = zlib.gunzipSync(responseBody); } catch { /* leave as-is */ }
        } else if (encoding === 'deflate') {
          try { responseBody = zlib.inflateSync(responseBody); } catch { /* leave as-is */ }
        }
        const outHeaders = { ...up.headers };
        delete outHeaders['content-encoding'];
        delete outHeaders['transfer-encoding'];
        if (isRegion) {
          const rewritten = rewriteRegionInfo(responseBody.toString('utf8'));
          if (rewritten) responseBody = Buffer.from(rewritten, 'utf8');
        }
        outHeaders['content-length'] = String(responseBody.length);
        res.writeHead(up.statusCode ?? 502, outHeaders);
        res.end(responseBody);
      });
    });
    upstream.on('timeout', () => upstream.destroy(new Error('dispatch 超时')));
    upstream.on('error', (error) => {
      output.error(`dispatch ${host}${path}: ${error.message}`);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`relay: ${error.message}`);
    });
    if (body.length) upstream.write(body);
    upstream.end();
  } catch (error) {
    output.error(`dispatch: ${error.message}`);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('relay error');
  }
});

/* ------------------------------------------------------------------ *
 * Gate TCP relay + chat send injection.
 * ------------------------------------------------------------------ */

function frameHead(frame, seqId) {
  return {
    packetId: frame.packetId,
    msgId: frame.msgId,
    flag: frame.flag,
    bodyLen: frame.body.length,
    totalPackCount: frame.totalPackCount,
    seqId,
  };
}

function handleS2C(frame, session) {
  const { msgId, body } = frame;
  try {
    recorder.frame({ direction: 's2c', msgId, packetId: frame.packetId, seqId: frame.seqId, flag: frame.flag, body });
  } catch { /* recording must never break the relay */ }
  if (msgId === 1740 || msgId === 2014 || msgId === 2316) {
    dumpRaw('rsp', msgId, frame.packetId, body);
  }
  // Any response can settle an injected request: probes use arbitrary msgIds,
  // so this must run before the known-message handlers.
  const pending = session?.pending.get(frame.packetId);
  if (pending && (pending.expect === undefined || pending.expect === msgId)) {
    session.pending.delete(frame.packetId);
    clearTimeout(pending.timer);
    counters.injectedOk += 1;
    output.bump('injectedOk');
    let decoded = { ok: true, packetId: frame.packetId };
    try {
      if (pending.decode) decoded = { ...decoded, ...pending.decode(body) };
      else if (pending.raw) {
        decoded = {
          ...decoded,
          msgId,
          len: body.length,
          hex: body.toString('hex').slice(0, 65_536),
        };
      }
    } catch (error) {
      output.log(`rsp decode ${msgId}: ${error.message}`);
    }
    pending.resolve(decoded);
    return;
  }
  if (msgId === MSG.CHAT_MSG_NOTICE) {
    const notice = decodeChatMsgNotice(body);
    if (!notice?.msg) return;
    const msg = notice.msg;
    output.chat({
      ts: new Date().toISOString(),
      dir: 's2c',
      channel: notice.type,
      playerId: msg.playerId,
      name: msg.name,
      text: msg.text,
      expression: msg.expression,
      sendTime: msg.sendTime,
      avatarFrame: msg.avatarFrame,
      head: msg.head,
      badge: msg.badge,
    });
    return;
  }
  if (msgId === MSG.CHAT_MSG_RECORD_INIT_NOTICE) {
    const notice = decodeChatMsgRecordInitNotice(body);
    if (!notice?.msg?.length) return;
    output.history(notice.type, notice.msg.map((m) => ({
      playerId: m.playerId,
      name: m.name,
      text: m.text,
      expression: m.expression,
      sendTime: m.sendTime,
      head: m.head,
      badge: m.badge,
      avatarFrame: m.avatarFrame,
    })));
    return;
  }
  if (msgId === MSG.PLAYER_LOGIN_RSP || msgId === MSG.PLAYER_MAIN_DATA_RSP) {
    const rsp = msgId === MSG.PLAYER_LOGIN_RSP ? decodePlayerLoginRsp(body) : decodePlayerMainDataRsp(body);
    if (rsp?.playerName) {
      output.self({
        name: rsp.playerName,
        playerId: rsp.playerId ?? 0,
        sceneId: rsp.sceneId,
        channelId: rsp.channelId,
        serverTimeMs: rsp.serverTimeMs,
      });
      if (msgId === MSG.PLAYER_MAIN_DATA_RSP) {
        output.profile({
          playerId: rsp.playerId ?? 0,
          name: rsp.playerName,
          level: rsp.level ?? 0,
          head: rsp.head ?? 0,
          sign: rsp.sign ?? '',
          worldLevel: rsp.worldLevel ?? 0,
          sex: rsp.sex ?? 0,
          sceneId: rsp.sceneId ?? 0,
          channelId: rsp.channelId ?? 0,
          ts: new Date().toISOString(),
        });
      } else {
        recorder.mark('login', {
          name: rsp.playerName,
          sceneId: rsp.sceneId ?? 0,
          channelId: rsp.channelId ?? 0,
        });
      }
    }
    return;
  }
  if (msgId === MSG.SCENE_DATA_NOTICE) {
    const notice = decodeSceneDataNotice(body);
    if (notice?.scene) {
      output.scene({ ...notice.scene, ts: new Date().toISOString() });
      recorder.mark('scene', {
        sceneId: notice.scene.sceneId ?? 0,
        channelId: notice.scene.channelId ?? 0,
        channelLabel: notice.scene.channelLabel ?? 0,
        players: notice.scene.players?.length ?? 0,
      });
    }
    return;
  }
  if (msgId === MSG.PLAYER_SCENE_SYNC_DATA_NOTICE || msgId === MSG.SERVER_SCENE_SYNC_DATA_NOTICE) {
    const notice = decodePlayerSceneSyncDataNotice(body);
    if (notice?.players?.length) output.positions(notice.players);
    return;
  }
  if (msgId === MSG.CHANGE_SCENE_CHANNEL_RSP) {
    const rsp = decodeChangeSceneChannelRsp(body);
    output.sceneChannel({ sceneId: rsp.sceneId, channelId: rsp.channelId, channelLabel: rsp.channelLabel });
    return;
  }
  if (msgId === MSG.FRIEND_RSP) {
    const rsp = decodeFriendRsp(body);
    if (rsp?.friends?.length) output.friends(rsp.friends);
    return;
  }
  if (msgId === MSG.PRIVATE_CHAT_MSG_RECORD_RSP) {
    const rsp = decodePrivateChatMsgRecordRsp(body);
    if (rsp?.messages?.length) output.privateHistory(lastPrivateTarget, rsp.messages);
    return;
  }
  if (msgId === MSG.CHANGE_CHAT_CHANNEL_NOTICE) {
    const notice = decodeChangeChatChannelNotice(body);
    if (notice) {
      output.channel({ channelId: notice.channelId });
      recorder.mark('chat-channel', { channelId: notice.channelId });
    }
  }
}

function handleC2S(frame) {
  const { msgId, body } = frame;
  try {
    recorder.frame({ direction: 'c2s', msgId, packetId: frame.packetId, seqId: frame.seqId, flag: frame.flag, body });
  } catch { /* recording must never break the relay */ }
  if (msgId === 1739 || msgId === 2013) {
    dumpRaw('c2s', msgId, frame.packetId, body);
  }
  if (msgId === MSG.SEND_CHAT_MSG_REQ) {
    const req = decodeSendChatMsgReq(body);
    output.sent({
      ts: new Date().toISOString(),
      channel: req.type,
      target: req.playerId,
      text: req.text,
      expression: req.expression,
    });
  } else if (msgId === MSG.PRIVATE_CHAT_MSG_RECORD_REQ) {
    const req = decodePrivateChatMsgRecordReq(body);
    if (req?.targetPlayerId) lastPrivateTarget = req.targetPlayerId;
  }
}

function attachSession(client, upstream) {
  const session = {
    client,
    upstream,
    lastSeq: 0,
    nextPacketId: 0x40000000,
    injectedSeqs: new Set(),
    pending: new Map(),
  };
  recorder.mark('gate-open', {
    remote: `${upstream.remoteAddress ?? '?'}:${upstream.remotePort ?? '?'}`,
  });

  // Client → server: parse first so an injected frame's seq collision can be
  // rewritten before the server sees the client's copy.
  const c2s = new FrameParser((frame, raw) => {
    session.lastSeq = Math.max(session.lastSeq, frame.seqId);
    let out = raw;
    if (session.injectedSeqs.has(frame.seqId)) {
      session.injectedSeqs.delete(frame.seqId);
      session.lastSeq += 1;
      out = encodeFrame(frameHead(frame, session.lastSeq), frame.body);
      output.bump('seqCollisionsFixed');
    }
    if (upstream.writable) upstream.write(out);
    try { handleC2S(frame); } catch { /* never break the relay for a decode */ }
  }, (message) => output.log(`c2s frame: ${message}`));

  // Server → client: forward immediately, decode a copy.
  const s2c = new FrameParser((frame) => {
    try { handleS2C(frame, session); } catch (error) { output.log(`s2c decode: ${error.message}`); }
  }, (message) => output.log(`s2c frame: ${message}`));

  client.on('data', (chunk) => c2s.push(chunk));
  upstream.on('data', (chunk) => {
    if (client.writable) client.write(chunk);
    s2c.push(chunk);
  });

  const close = () => {
    try { client.destroy(); } catch { /* ignore */ }
    try { upstream.destroy(); } catch { /* ignore */ }
    for (const [, pending] of session.pending) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error: '连接已断开，没等到服务器回执' });
    }
    session.pending.clear();
    if (activeSession === session) {
      activeSession = null;
      recorder.mark('gate-close');
    }
  };
  client.on('close', close);
  client.on('error', close);
  upstream.on('close', close);
  upstream.on('error', close);
  return session;
}

const gateServer = net.createServer((client) => {
  const gate = realGate ?? (() => {
    const fromLog = findGate();
    return fromLog ? { ip: fromLog.ip, port: fromLog.port } : null;
  })();
  if (!gate) {
    output.error('还没有拿到区服网关地址：先让客户端请求一次 region_info（重新登录）');
    client.destroy();
    return;
  }
  counters.gateConnections += 1;
  output.bump('gateConnections');
  const upstream = net.connect({ host: gate.ip, port: gate.port });
  upstream.setNoDelay?.(true);
  client.setNoDelay?.(true);
  upstream.on('connect', () => {
    activeSession = attachSession(client, upstream);
    output.setStatus({ gateConnection: { remote: `${gate.ip}:${gate.port}` } });
  });
  upstream.on('error', (error) => output.error(`gate connect ${gate.ip}:${gate.port}: ${error.message}`));
});

/**
 * Inject a request into the client's own gateway connection and wait for the
 * matching response. The client keeps running; we only borrow its session.
 */
function injectRequest({ msgId, body = Buffer.alloc(0), expect, decodeRsp, timeoutMs = 5000, label = '', raw = false } = {}) {
  const session = activeSession;
  if (!session || !session.upstream.writable) {
    return Promise.reject(new Error('没有活动的网关连接（游戏没登录，或还没经过中转）'));
  }
  const packetId = session.nextPacketId;
  session.nextPacketId = (session.nextPacketId + 1) >>> 0;
  const seqId = session.lastSeq + 1;
  const frame = encodeFrame({
    packetId, msgId, flag: 0, bodyLen: body.length, totalPackCount: 0, seqId,
  }, body);
  session.lastSeq = seqId;
  session.injectedSeqs.add(seqId);
  counters.injected += 1;
  if (RAW_MSG_IDS.has(msgId)) dumpRaw('req', msgId, packetId, body);
  recorder.mark('inject', {
    msgId,
    label: label || String(msgId),
    packetId,
    seqId,
    len: body.length,
    hex: body.toString('hex').slice(0, 16_384),
  });
  output.bump('injectedSends');
  output.log(`inject ${label || msgId} packet=${packetId} seq=${seqId}`);

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      session.pending.delete(packetId);
      counters.injectedFailed += 1;
      output.bump('injectedFailed');
      resolve({ ok: true, packetId, note: '已发出，但服务器没有回执' });
    }, timeoutMs);
    session.pending.set(packetId, { expect, resolve, timer, decode: decodeRsp, raw });
    session.upstream.write(frame);
  });
}

function sendChat({ channel = 0, target = 0, text = '', expression = 0, timeoutMs = 5000 } = {}) {
  if (!activeSession?.upstream?.writable) {
    return Promise.reject(new Error('没有活动的网关连接（游戏没登录，或还没经过中转）'));
  }
  const body = encodeSendChatMsgReq({ type: channel, playerId: target, text, expression });
  // The injected frame does not pass through the client parser, so record it
  // here; the World then knows what "I" said in-game.
  output.sent({
    ts: new Date().toISOString(),
    channel,
    target,
    text,
    expression,
    injected: true,
  });
  return injectRequest({
    msgId: MSG.SEND_CHAT_MSG_REQ,
    body,
    expect: MSG.SEND_CHAT_MSG_RSP,
    label: 'chat',
    timeoutMs,
  });
}

function requestFriends() {
  return injectRequest({
    msgId: 1739, // FriendReq
    expect: MSG.FRIEND_RSP,
    decodeRsp: decodeFriendRsp,
    label: 'friends',
  });
}

function requestHistory(target) {
  return injectRequest({
    msgId: MSG.PRIVATE_CHAT_MSG_RECORD_REQ,
    body: encodePrivateChatMsgRecordReq({ targetPlayerId: target }),
    expect: MSG.PRIVATE_CHAT_MSG_RECORD_RSP,
    decodeRsp: decodePrivateChatMsgRecordRsp,
    label: `history:${target}`,
  });
}

function requestTeleport(friendId) {
  return injectRequest({
    msgId: MSG.TRANSMIT_SCENE_REQ,
    body: encodeTransmitSceneReq({ friendId }),
    expect: MSG.TRANSMIT_SCENE_RSP,
    decodeRsp: decodeTransmitSceneRsp,
    label: `teleport:${friendId}`,
    timeoutMs: 8000,
  });
}

/* ------------------------------------------------------------------ *
 * Control API for the World.
 * ------------------------------------------------------------------ */

/** Tail of frames.jsonl: last `limit` matching records, without loading 64 MB. */
function readFramesTail({ limit = 50, msgId = 0, dir = '', since = '' } = {}) {
  let size = 0;
  try { size = statSync(recorder.path).size; } catch { return []; }
  const window = Math.min(size, 4 * 1024 * 1024);
  const buf = Buffer.alloc(window);
  const fd = openSync(recorder.path, 'r');
  try { readSync(fd, buf, 0, window, size - window); } finally { closeSync(fd); }
  let text = buf.toString('utf8');
  if (size > window) {
    const firstNewline = text.indexOf('\n');
    if (firstNewline >= 0) text = text.slice(firstNewline + 1);
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.kind !== 'frame' && rec.kind !== 'mark') continue;
    if (msgId && rec.msgId !== msgId) continue;
    if (dir && rec.dir !== dir) continue;
    if (since && String(rec.ts) < since) continue;
    out.push(rec);
  }
  return out.slice(-limit);
}

const controlServer = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url?.startsWith('/status')) {
      // Re-resolve every time: hosts may have been added after the relay
      // started (the old once-at-startup check kept reporting "未配置").
      try { await checkHosts(); } catch { /* keep the last value */ }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        mode: 'relay',
        hostsActive,
        dispatchIp,
        gate: realGate,
        active: !!activeSession,
        counters,
        record: recorder.status(),
      }));
      return;
    }
    if (req.method === 'GET' && req.url?.startsWith('/record')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...recorder.status() }));
      return;
    }
    if (req.method === 'POST' && req.url?.startsWith('/record')) {
      const body = await readBody(req, 64 * 1024);
      const payload = JSON.parse(body.toString('utf8') || '{}');
      const action = String(payload.action ?? 'mark');
      if (payload.label !== undefined) recorder.label = String(payload.label);
      if (action === 'start') recorder.enabled = true;
      else if (action === 'stop') recorder.enabled = false;
      else if (action === 'mark') recorder.mark('user-mark', { label: recorder.label });
      else if (action === 'flush') recorder.flush();
      else if (action !== 'status') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: `未知 action：${action}` }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, action, ...recorder.status() }));
      return;
    }
    if (req.method === 'GET' && req.url?.startsWith('/frames')) {
      const url = new URL(req.url, 'http://127.0.0.1');
      const list = readFramesTail({
        limit: Math.max(0, Math.min(2000, Number(url.searchParams.get('limit')) || 50)),
        msgId: Number(url.searchParams.get('msgId')) || 0,
        dir: url.searchParams.get('dir') || '',
        since: url.searchParams.get('since') || '',
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, count: list.length, frames: list }));
      return;
    }
    if (req.method === 'POST' && req.url?.startsWith('/probe')) {
      const body = await readBody(req, 256 * 1024);
      const payload = JSON.parse(body.toString('utf8') || '{}');
      const msgId = Number(payload.msgId) || 0;
      if (!msgId) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'msgId 为空' }));
        return;
      }
      let frameBody = Buffer.alloc(0);
      if (typeof payload.bodyHex === 'string' && payload.bodyHex.trim()) {
        try { frameBody = Buffer.from(payload.bodyHex.trim(), 'hex'); } catch {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'bodyHex 不是合法十六进制' }));
          return;
        }
      }
      const result = await injectRequest({
        msgId,
        body: frameBody,
        expect: Number(payload.expect) || undefined,
        raw: true,
        timeoutMs: Math.max(200, Math.min(20_000, Number(payload.timeoutMs) || 5000)),
        label: `probe:${msgId}`,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: result.ok, ...result }));
      return;
    }
    if (req.method === 'POST' && req.url?.startsWith('/send')) {
      const body = await readBody(req, 64 * 1024);
      const payload = JSON.parse(body.toString('utf8') || '{}');
      const text = String(payload.text ?? '').trim();
      if (!text) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'text 为空' }));
        return;
      }
      const result = await sendChat({
        channel: Number(payload.channel) || 0,
        target: Number(payload.target) || 0,
        text,
        expression: Number(payload.expression) || 0,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ...result, text }));
      return;
    }
    if (req.method === 'POST' && req.url?.startsWith('/friends')) {
      const result = await requestFriends();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: result.ok,
        status: result.status ?? null,
        statusPresent: result.statusPresent ?? false,
        friends: result.friends ?? [],
        note: result.note,
      }));
      return;
    }
    if (req.method === 'POST' && req.url?.startsWith('/history')) {
      const body = await readBody(req, 64 * 1024);
      const payload = JSON.parse(body.toString('utf8') || '{}');
      const target = Number(payload.target) || 0;
      if (!target) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'target 为空' }));
        return;
      }
      const result = await requestHistory(target);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: result.ok,
        status: result.status ?? null,
        statusPresent: result.statusPresent ?? false,
        messages: result.messages ?? [],
        note: result.note,
      }));
      return;
    }
    if (req.method === 'POST' && req.url?.startsWith('/teleport')) {
      const body = await readBody(req, 64 * 1024);
      const payload = JSON.parse(body.toString('utf8') || '{}');
      const friendId = Number(payload.friendId) || 0;
      if (!friendId) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'friendId 为空' }));
        return;
      }
      const result = await requestTeleport(friendId);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: result.ok,
        status: result.status ?? null,
        statusPresent: result.statusPresent ?? false,
        fields: result.fields ?? [],
        note: result.note,
      }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not found' }));
  } catch (error) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  }
});

/* ------------------------------------------------------------------ *
 * Start / stop.
 * ------------------------------------------------------------------ */

async function checkHosts() {
  try {
    const looked = await dns.lookup(args.dispatchHost);
    hostsActive = looked?.address === '127.0.0.1';
  } catch {
    hostsActive = false;
  }
  output.setStatus({ hostsActive, dispatchHost: args.dispatchHost });
}

function listen(server, port, name) {
  return new Promise((resolve, reject) => {
    server.once('error', (error) => reject(new Error(`${name} 监听 ${port} 失败：${error.message}`)));
    server.listen(port, '127.0.0.1', () => resolve());
  });
}

async function main() {
  await checkHosts();
  if (!hostsActive) {
    output.log(`hosts 没有把 ${args.dispatchHost} 指到 127.0.0.1；客户端不会经过中转（见 setup-hosts.cmd）`);
  }
  await resolveDispatch();
  output.setStatus({
    dispatchHost: args.dispatchHost,
    dispatchIp,
    ports: { dispatch: args.dispatchPort, gate: args.gatePort, control: args.controlPort },
  });
  await listen(dispatchServer, args.dispatchPort, 'dispatch');
  await listen(gateServer, args.gatePort, 'gate');
  await listen(controlServer, args.controlPort, 'control');
  output.setStatus({ record: recorder.status() });
  output.log(`relay listening dispatch=127.0.0.1:${args.dispatchPort} gate=127.0.0.1:${args.gatePort} control=127.0.0.1:${args.controlPort} record=${recorder.enabled ? 'on' : 'off'} file=${recorder.path}`);

  const timer = setInterval(() => {
    output.setStatus({ record: recorder.status() });
    output.writeStatus();
  }, 1000);
  timer.unref?.();
  // hosts can be added or removed while the relay runs; keep the reported
  // state honest instead of freezing the startup value.
  const hostsTimer = setInterval(() => {
    checkHosts().catch(() => {});
  }, 30_000);
  hostsTimer.unref?.();

  const stop = () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    clearInterval(hostsTimer);
    try { dispatchServer.close(); } catch { /* ignore */ }
    try { gateServer.close(); } catch { /* ignore */ }
    try { controlServer.close(); } catch { /* ignore */ }
    if (activeSession) {
      try { activeSession.client.destroy(); } catch { /* ignore */ }
      try { activeSession.upstream.destroy(); } catch { /* ignore */ }
    }
    try { recorder.close(); } catch { /* ignore */ }
    output.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('uncaughtException', (error) => {
    output.error(`uncaught: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    stop();
  });

  const deadline = args.durationSec > 0 ? Date.now() + args.durationSec * 1000 : 0;
  if (deadline) setTimeout(stop, args.durationSec * 1000).unref?.();
  output.writeStatus();
}

main().catch((error) => {
  output.error(error instanceof Error ? error.message : String(error));
  output.close();
  process.exit(1);
});
