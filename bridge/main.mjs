#!/usr/bin/env node
/**
 * OverField chat bridge.
 *
 * Passive capture of the game's gateway TCP stream, decoded into a small
 * append-only JSONL feed that the Coopanion World tails. No injection, no
 * debugger, no memory access: it only reads packets the adapter already sees.
 *
 * Usage:
 *   node bridge/main.mjs --out <dir> [--device <name>] [--ports 11000-11100]
 *   node bridge/main.mjs --out <dir> --pcap capture.pcapng   (replay)
 */

import { readFileSync } from 'node:fs';
import { parseFrame, isGatePort, parsePortRanges } from './decode.mjs';
import { FrameParser } from './frame.mjs';
import { TcpReassembler } from './tcp.mjs';
import { Output } from './output.mjs';
import { findGate } from './gate.mjs';
import { readCaptureFile } from './pcapfile.mjs';
import {
  chooseDevice, closeCapture, listDevices, localAddress, nextPacket, npcapVersion, openDevice,
} from './pcap.mjs';
import {
  decodeChangeChatChannelNotice, decodeChangeSceneChannelRsp, decodeChatMsgNotice,
  decodeChatMsgRecordInitNotice, decodeFriendRsp, decodePlayerLoginRsp, decodePlayerMainDataRsp,
  decodePlayerSceneSyncDataNotice, decodePrivateChatMsgRecordReq, decodePrivateChatMsgRecordRsp,
  decodeSceneDataNotice, decodeSendChatMsgReq,
} from './proto.mjs';

const MSG = {
  PLAYER_LOGIN_RSP: 1004,
  PLAYER_MAIN_DATA_RSP: 1006,
  SCENE_DATA_NOTICE: 1016,
  CHANGE_SCENE_CHANNEL_RSP: 1202,
  PLAYER_SCENE_SYNC_DATA_NOTICE: 1206,
  SERVER_SCENE_SYNC_DATA_NOTICE: 1208,
  FRIEND_RSP: 1740,
  SEND_CHAT_MSG_REQ: 1933,
  CHAT_MSG_NOTICE: 1936,
  CHAT_MSG_RECORD_INIT_NOTICE: 1938,
  PRIVATE_CHAT_MSG_RECORD_REQ: 2013,
  PRIVATE_CHAT_MSG_RECORD_RSP: 2014,
  CHANGE_CHAT_CHANNEL_NOTICE: 2232,
};

function parseArgs(argv) {
  const args = { ports: '11000-11100', device: '', pcap: '', out: '', durationSec: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--out') { args.out = value ?? ''; i += 1; }
    else if (key === '--device') { args.device = value ?? ''; i += 1; }
    else if (key === '--ports') { args.ports = value ?? ''; i += 1; }
    else if (key === '--pcap') { args.pcap = value ?? ''; i += 1; }
    else if (key === '--duration') { args.durationSec = Number(value ?? 0) || 0; i += 1; }
    else if (key === '--help' || key === '-h') { args.help = true; }
  }
  return args;
}

function usage() {
  return [
    'OverField chat bridge',
    '  --out <dir>         output directory (required)',
    '  --device <name>     Npcap device name or description fragment',
    '  --ports <ranges>    gateway port ranges, default 11000-11100',
    '  --pcap <file>       replay a pcap/pcapng instead of live capture',
    '  --duration <sec>    stop after N seconds (live only)',
  ].join('\n');
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(usage());
  process.exit(0);
}
if (!args.out) {
  console.error(usage());
  process.exit(2);
}

const portRanges = parsePortRanges(args.ports);
const filter = `tcp and (${portRanges.map(([lo, hi]) => (lo === hi ? `port ${lo}` : `portrange ${lo}-${hi}`)).join(' or ')})`;

const output = new Output(args.out, {
  mode: args.pcap ? 'pcap' : 'live',
  filter,
  npcap: args.pcap ? '' : npcapVersion(),
});
output.init();

let stopping = false;
const streams = new Map();
let lastPrivateTarget = 0;

function streamFor(key, dir) {
  let stream = streams.get(key);
  if (!stream) {
    stream = {
      dir,
      lastSeen: Date.now(),
      parser: new FrameParser(
        (frame) => onFrame(frame, dir),
        (message) => output.log(`frame: ${message}`),
      ),
    };
    streams.set(key, stream);
  }
  stream.lastSeen = Date.now();
  return stream;
}

function onFrame(frame, dir) {
  output.bump('frames');
  const { msgId, body } = frame;
  if (msgId === MSG.CHAT_MSG_NOTICE) {
    const notice = decode('ChatMsgNotice', () => decodeChatMsgNotice(body));
    if (!notice?.msg) return;
    const msg = notice.msg;
    output.chat({
      ts: new Date().toISOString(),
      dir,
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
    const notice = decode('ChatMsgRecordInitNotice', () => decodeChatMsgRecordInitNotice(body));
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
  if (msgId === MSG.SEND_CHAT_MSG_REQ) {
    const req = decode('SendChatMsgReq', () => decodeSendChatMsgReq(body));
    if (!req) return;
    output.sent({
      ts: new Date().toISOString(),
      channel: req.type,
      target: req.playerId,
      text: req.text,
      expression: req.expression,
    });
    return;
  }
  if (msgId === MSG.PLAYER_LOGIN_RSP || msgId === MSG.PLAYER_MAIN_DATA_RSP) {
    const rsp = msgId === MSG.PLAYER_LOGIN_RSP
      ? decode('PlayerLoginRsp', () => decodePlayerLoginRsp(body))
      : decode('PlayerMainDataRsp', () => decodePlayerMainDataRsp(body));
    if (!rsp?.playerName) return;
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
    }
    return;
  }
  if (msgId === MSG.SCENE_DATA_NOTICE) {
    const notice = decode('SceneDataNotice', () => decodeSceneDataNotice(body));
    if (!notice?.scene) return;
    output.scene({ ...notice.scene, ts: new Date().toISOString() });
    return;
  }
  if (msgId === MSG.PLAYER_SCENE_SYNC_DATA_NOTICE || msgId === MSG.SERVER_SCENE_SYNC_DATA_NOTICE) {
    const notice = decode('PlayerSceneSyncDataNotice', () => decodePlayerSceneSyncDataNotice(body));
    if (notice?.players?.length) output.positions(notice.players);
    return;
  }
  if (msgId === MSG.CHANGE_SCENE_CHANNEL_RSP) {
    const rsp = decode('ChangeSceneChannelRsp', () => decodeChangeSceneChannelRsp(body));
    if (rsp) output.sceneChannel({ sceneId: rsp.sceneId, channelId: rsp.channelId, channelLabel: rsp.channelLabel });
    return;
  }
  if (msgId === MSG.FRIEND_RSP) {
    const rsp = decode('FriendRsp', () => decodeFriendRsp(body));
    if (rsp?.friends?.length) output.friends(rsp.friends);
    return;
  }
  if (msgId === MSG.PRIVATE_CHAT_MSG_RECORD_REQ) {
    const req = decode('PrivateChatMsgRecordReq', () => decodePrivateChatMsgRecordReq(body));
    if (req?.targetPlayerId) lastPrivateTarget = req.targetPlayerId;
    return;
  }
  if (msgId === MSG.PRIVATE_CHAT_MSG_RECORD_RSP) {
    const rsp = decode('PrivateChatMsgRecordRsp', () => decodePrivateChatMsgRecordRsp(body));
    if (rsp?.messages?.length) output.privateHistory(lastPrivateTarget, rsp.messages);
    return;
  }
  if (msgId === MSG.CHANGE_CHAT_CHANNEL_NOTICE) {
    const notice = decode('ChangeChatChannelNotice', () => decodeChangeChatChannelNotice(body));
    if (!notice) return;
    output.channel({ channelId: notice.channelId });
  }
}

function decode(label, fn) {
  try {
    return fn();
  } catch (error) {
    output.log(`decode ${label}: ${error.message}`);
    return null;
  }
}

const reassembler = new TcpReassembler(
  (key, chunk) => {
    const info = streams.get(key) ?? streamFor(key, 's2c');
    info.parser.push(chunk);
  },
  (key, gaps) => output.log(`tcp gap ${key} #${gaps}`),
);

function handlePacket(bytes, linkType) {
  output.bump('packets');
  const packet = parseFrame(bytes, linkType);
  if (!packet) return;
  output.bump('tcpPackets');
  if (!isGatePort(packet.sport, packet.dport, portRanges)) return;
  const serverPort = portRanges.some(([lo, hi]) => packet.dport >= lo && packet.dport <= hi);
  const key = reassembler.key(packet);
  streamFor(key, serverPort ? 'c2s' : 's2c');
  reassembler.push(packet);
}

function refreshGate() {
  const gate = findGate();
  if (gate) output.setStatus({ gate });
}

function pruneStreams() {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [key, stream] of streams) {
    if (stream.lastSeen < cutoff) streams.delete(key);
  }
}

async function runReplay() {
  const data = readCaptureFile(readFileSync(args.pcap));
  output.setStatus({ pcap: args.pcap, linkType: data.linkType, totalPackets: data.packets.length });
  output.log(`replay ${args.pcap}: ${data.packets.length} packets, linkType=${data.linkType}`);
  for (const packet of data.packets) {
    if (stopping) break;
    handlePacket(packet.bytes, data.linkType);
  }
  output.writeStatus();
}

async function runLive() {
  const devices = listDevices();
  const localIp = await localAddress();
  const device = chooseDevice(devices, { preferred: args.device, localIp });
  output.setStatus({
    device: device.name,
    deviceDescription: device.description,
    localIp,
    devices: devices.map((d) => ({ name: d.name, description: d.description, ips: d.ips })),
  });
  output.log(`device ${device.description} (${device.name}) local=${localIp} filter="${filter}"`);

  const capture = openDevice(device.name, { filter });
  const deadline = args.durationSec > 0 ? Date.now() + args.durationSec * 1000 : 0;
  let lastStatus = 0;
  let lastGate = 0;
  let sinceYield = 0;

  try {
    while (!stopping) {
      const now = Date.now();
      if (deadline && now >= deadline) break;
      if (now - lastStatus >= 1000) {
        lastStatus = now;
        output.writeStatus();
        if (now - lastGate >= 10_000) {
          lastGate = now;
          try { refreshGate(); } catch { /* ignore */ }
        }
        pruneStreams();
      }
      const packet = nextPacket(capture);
      if (packet) {
        handlePacket(packet.bytes, capture.linkType);
        sinceYield += 1;
      }
      // Let timers and signal handlers run even while traffic is heavy.
      if (!packet || sinceYield >= 200) {
        sinceYield = 0;
        await new Promise((resolve) => setTimeout(resolve, packet ? 0 : 2));
      }
    }
  } finally {
    closeCapture(capture);
  }
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  output.log(`signal ${signal}`);
  output.close();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (error) => {
  output.error(`uncaught: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  shutdown('uncaughtException');
});

try {
  await (args.pcap ? runReplay() : runLive());
} catch (error) {
  output.error(error instanceof Error ? error.message : String(error));
  output.close();
  process.exit(1);
}
if (!stopping) {
  output.close();
  process.exit(0);
}
