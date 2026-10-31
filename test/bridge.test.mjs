import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { snappyDecompress } from '../bridge/snappy.mjs';
import { FrameParser } from '../bridge/frame.mjs';
import { TcpReassembler } from '../bridge/tcp.mjs';
import { parseFrame, parsePortRanges, isGatePort } from '../bridge/decode.mjs';
import { readCaptureFile } from '../bridge/pcapfile.mjs';
import {
  decodeFriendRsp, decodePlayerSceneSyncDataNotice, decodePrivateChatMsgRecordRsp,
  decodeSceneDataNotice, decodeTransmitSceneRsp, decodeVector3,
} from '../bridge/proto.mjs';
import {
  chatMsgData, chatMsgNotice, fieldBytes, fieldString, fieldVarint, frame, pcapFile, snappyLiteral, tcpPacket,
} from './helpers.mjs';

const MAIN = fileURLToPath(new URL('../bridge/main.mjs', import.meta.url));

test('snappy literal blocks decode', () => {
  const text = Buffer.from('开放空间聊天测试', 'utf8');
  assert.deepEqual(Buffer.from(snappyDecompress(snappyLiteral(text))), text);
});

test('snappy copy blocks decode with overlap', () => {
  // "abcabcabcabc": literal "abc" then copy offset 3 length 9.
  const literal = Buffer.from('abc');
  const stream = Buffer.concat([
    Buffer.from([literal.length + 9]),
    Buffer.from([(literal.length - 1) << 2]),
    literal,
    Buffer.from([((9 - 1) << 2) | 2, 3, 0]),
  ]);
  assert.equal(Buffer.from(snappyDecompress(stream)).toString(), 'abcabcabcabc');
});

test('frame parser handles split and concatenated frames', () => {
  const body1 = chatMsgNotice({ type: 0, msg: chatMsgData({ text: '附近消息' }) });
  const body2 = chatMsgNotice({ type: 2, msg: chatMsgData({ text: '私聊消息' }) });
  const bytes = Buffer.concat([
    frame({ msgId: 1936, body: body1, seqId: 1 }),
    frame({ msgId: 1936, body: body2, seqId: 2 }),
  ]);
  const frames = [];
  const parser = new FrameParser((f) => frames.push(f));
  for (let i = 0; i < bytes.length; i += 7) parser.push(bytes.subarray(i, i + 7));
  assert.equal(frames.length, 2);
  assert.equal(frames[0].msgId, 1936);
  assert.equal(frames[1].body.length, body2.length);
});

test('frame parser decompresses snappy bodies (flag=1)', () => {
  const body = chatMsgNotice({ type: 1, msg: chatMsgData({ text: '世界消息' }) });
  const packed = snappyLiteral(body);
  const bytes = frame({ msgId: 1936, body: packed, flag: 1 });
  const frames = [];
  new FrameParser((f) => frames.push(f)).push(bytes);
  assert.equal(frames.length, 1);
  assert.deepEqual(Buffer.from(frames[0].body), body);
});

test('tcp reassembly handles reordering and retransmission', () => {
  const body = chatMsgNotice({ type: 0, msg: chatMsgData({ text: '重排测试' }) });
  const bytes = frame({ msgId: 1936, body });
  const cut = Math.floor(bytes.length / 2);
  const seqBase = 5000;

  const frames = [];
  const streams = new Map();
  const reassembler = new TcpReassembler((key, chunk) => {
    let parser = streams.get(key);
    if (!parser) { parser = new FrameParser((f) => frames.push(f)); streams.set(key, parser); }
    parser.push(chunk);
  });

  const packet = (seq, payload) => ({
    srcIp: '192.168.2.61', dstIp: '14.103.255.173', sport: 51000, dport: 11002, seq, flags: 0x18, payload,
  });

  reassembler.push(packet(seqBase, bytes.subarray(0, cut)));
  // Second half arrives before the middle chunk, then the middle chunk, then a retransmit.
  reassembler.push(packet(seqBase + cut + 5, bytes.subarray(cut + 5)));
  reassembler.push(packet(seqBase + cut, bytes.subarray(cut, cut + 5)));
  reassembler.push(packet(seqBase, bytes.subarray(0, cut)));

  assert.equal(frames.length, 1);
  assert.deepEqual(Buffer.from(frames[0].body), body);
});

test('ethernet/ipv4/tcp parsing and gate port detection', () => {
  const payload = Buffer.from('hello');
  const raw = tcpPacket({ payload });
  const packet = parseFrame(raw, 1);
  assert.equal(packet.srcIp, '192.168.2.61');
  assert.equal(packet.dstIp, '14.103.255.173');
  assert.equal(packet.sport, 51000);
  assert.equal(packet.dport, 11002);
  assert.equal(packet.payload.toString(), 'hello');
  const ranges = parsePortRanges('11000-11100');
  assert.equal(isGatePort(packet.sport, packet.dport, ranges), true);
  assert.equal(isGatePort(51000, 443, ranges), false);
});

test('friend, private history, scene and position decoders', () => {
  const brief = Buffer.concat([
    fieldVarint(1, 42),
    fieldString(2, '乙'),
    fieldVarint(3, 30),
    fieldVarint(9, 1),
    fieldString(10, '晚上好'),
  ]);
  const friend = Buffer.concat([fieldString(1, '小乙'), fieldBytes(2, brief), fieldVarint(4, 77)]);
  const friendRsp = decodeFriendRsp(Buffer.concat([fieldVarint(1, 0), fieldBytes(2, friend)]));
  assert.equal(friendRsp.friends.length, 1);
  assert.equal(friendRsp.friends[0].info.playerId, 42);
  assert.equal(friendRsp.friends[0].info.online, true);
  assert.equal(friendRsp.friends[0].intimacy, 77);

  const privateRsp = decodePrivateChatMsgRecordRsp(Buffer.concat([
    fieldVarint(1, 0),
    fieldBytes(2, chatMsgData({ playerId: 42, name: '乙', text: '私聊记录' })),
  ]));
  assert.equal(privateRsp.messages.length, 1);
  assert.equal(privateRsp.messages[0].text, '私聊记录');

  const scenePlayer = Buffer.concat([fieldVarint(1, 42), fieldString(2, '乙')]);
  const scene = decodeSceneDataNotice(Buffer.concat([
    fieldVarint(1, 0),
    fieldBytes(2, Buffer.concat([
      fieldVarint(1, 1001),
      fieldBytes(22, scenePlayer),
      fieldVarint(23, 7),
      fieldVarint(27, 3),
    ])),
  ]));
  assert.equal(scene.scene.sceneId, 1001);
  assert.equal(scene.scene.channelId, 7);
  assert.equal(scene.scene.players[0].name, '乙');

  const vector = (x, z) => Buffer.concat([
    fieldVarint(1, x), fieldVarint(2, 0), fieldVarint(3, z), fieldVarint(4, 2),
  ]);
  const char = Buffer.concat([fieldVarint(1, 1), fieldBytes(3, vector(150, 250)), fieldBytes(4, vector(0, 0))]);
  const recorder = fieldBytes(1, char);
  const sync = Buffer.concat([fieldVarint(1, 42), fieldBytes(2, recorder)]);
  const notice = decodePlayerSceneSyncDataNotice(Buffer.concat([fieldVarint(1, 0), fieldBytes(2, sync)]));
  assert.equal(notice.players[0].playerId, 42);
  assert.equal(notice.players[0].chars[0].pos.x, 1.5);
  assert.equal(notice.players[0].chars[0].pos.z, 2.5);
});

test('decoders tolerate real-world nesting and signed coordinates', () => {
  // FriendBriefInfo with PlayerBriefInfo nested at field 1 instead of field 2.
  const brief = Buffer.concat([fieldVarint(1, 43), fieldString(2, '丙'), fieldVarint(9, 1)]);
  const altFriend = Buffer.concat([fieldBytes(1, brief), fieldString(2, '小丙'), fieldVarint(4, 5)]);
  const alt = decodeFriendRsp(Buffer.concat([fieldVarint(1, 0), fieldBytes(2, altFriend)]));
  assert.equal(alt.friends.length, 1);
  assert.equal(alt.friends[0].info.playerId, 43);

  // PrivateChatMsgRecordRsp element is a MsgRecord wrapper, not ChatMsgData.
  const wrapped = Buffer.concat([fieldBytes(1, chatMsgData({ playerId: 44, name: '丁', text: '包一层' }))]);
  const hist = decodePrivateChatMsgRecordRsp(Buffer.concat([fieldVarint(1, 0), fieldBytes(2, wrapped)]));
  assert.equal(hist.messages.length, 1);
  assert.equal(hist.messages[0].text, '包一层');

  // Negative int32 coordinates arrive as a 10-byte two's-complement varint.
  const negOne = Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01]);
  const vec = Buffer.concat([Buffer.from([0x08]), negOne, Buffer.from([0x20, 0x02])]);
  const decoded = decodeVector3(vec);
  assert.equal(decoded.x, -0.01);
  assert.equal(decoded.dp, 2);

  const okTeleport = decodeTransmitSceneRsp(Buffer.concat([fieldVarint(1, 0), fieldVarint(2, 9999)]));
  assert.equal(okTeleport.status, 0);
  assert.equal(okTeleport.statusPresent, true);
  const noStatus = decodeTransmitSceneRsp(Buffer.alloc(0));
  assert.equal(noStatus.status, null);
  assert.equal(noStatus.statusPresent, false);
});

test('pcap reader and bridge replay produce chat.jsonl', () => {
  const dir = mkdtempSync(join(tmpdir(), 'of-bridge-'));
  try {
    const chatA = chatMsgNotice({ type: 0, msg: chatMsgData({ playerId: 1, name: '甲', text: '在吗', sendTime: 1761000000001 }) });
    const chatB = chatMsgNotice({ type: 2, msg: chatMsgData({ playerId: 2, name: '乙', text: '私聊你', sendTime: 1761000000002 }) });
    const stream = Buffer.concat([
      frame({ msgId: 1936, body: chatA, seqId: 1 }),
      frame({ msgId: 1936, body: chatB, seqId: 2 }),
    ]);
    const packets = [
      tcpPacket({ seq: 1, flags: 0x02, payload: Buffer.alloc(0) }),
      tcpPacket({ seq: 2, payload: stream.subarray(0, 20) }),
      tcpPacket({ seq: 22, payload: stream.subarray(20) }),
    ];
    const file = join(dir, 'capture.pcap');
    const outDir = join(dir, 'out');
    writeFileSync(file, pcapFile(packets));

    const parsed = readCaptureFile(readFileSync(file));
    assert.equal(parsed.linkType, 1);
    assert.equal(parsed.packets.length, 3);

    const run = spawnSync(process.execPath, [MAIN, '--out', outDir, '--pcap', file], {
      timeout: 30000,
      stdio: 'inherit',
    });
    assert.equal(run.status, 0);

    const lines = readFileSync(join(outDir, 'chat.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const chats = lines.filter((l) => l.kind === 'chat');
    assert.equal(chats.length, 2);
    assert.equal(chats[0].channel, 0);
    assert.equal(chats[0].name, '甲');
    assert.equal(chats[0].text, '在吗');
    assert.equal(chats[1].channel, 2);
    assert.equal(chats[1].text, '私聊你');

    const status = JSON.parse(readFileSync(join(outDir, 'status.json'), 'utf8'));
    assert.equal(status.chats, 2);
    assert.equal(status.frames, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
