/**
 * Minimal protobuf reader for the handful of game messages this bridge needs.
 *
 * The whole protocol is protobuf over a length-prefixed TCP frame. We do not
 * need a schema engine: the chat messages are small, stable, and listed below
 * from the client's own protocol definitions. Unknown fields are skipped, so a
 * game update that adds fields keeps working.
 */

export function readVarint(buf, pos, end = buf.length) {
  let result = 0;
  let shift = 0;
  let p = pos;
  for (;;) {
    if (p >= end) throw new RangeError('proto: truncated varint');
    const byte = buf[p++];
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return [result, p];
    shift += 7;
    if (shift > 63) throw new RangeError('proto: varint too long');
  }
}

/** Same varint, but keep all 64 bits; needed for negative int32/int64 fields. */
export function readVarintBig(buf, pos, end = buf.length) {
  let result = 0n;
  let shift = 0n;
  let p = pos;
  for (;;) {
    if (p >= end) throw new RangeError('proto: truncated varint');
    const byte = buf[p++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [result, p];
    shift += 7n;
    if (shift > 63n) throw new RangeError('proto: varint too long');
  }
}

export function encodeVarint(value) {
  let v = Number(value) >>> 0;
  const out = [];
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return Buffer.from(out);
}

export function encodeFieldVarint(no, value) {
  return Buffer.concat([encodeVarint((no << 3) | 0), encodeVarint(value)]);
}

export function encodeFieldBytes(no, bytes) {
  const buf = Buffer.from(bytes);
  return Buffer.concat([encodeVarint((no << 3) | 2), encodeVarint(buf.length), buf]);
}

export function encodeFieldString(no, text) {
  return encodeFieldBytes(no, Buffer.from(String(text ?? ''), 'utf8'));
}

/** Iterate protobuf fields: returns [{ no, wire, value }] with bytes slices. */
export function readFields(buf) {
  const fields = [];
  let pos = 0;
  while (pos < buf.length) {
    let key;
    [key, pos] = readVarint(buf, pos);
    const no = key >>> 3;
    const wire = key & 0x07;
    if (no === 0) throw new RangeError('proto: field number 0');
    if (wire === 0) {
      let big;
      [big, pos] = readVarintBig(buf, pos);
      fields.push({ no, wire, value: Number(big), big });
    } else if (wire === 1) {
      if (pos + 8 > buf.length) throw new RangeError('proto: truncated fixed64');
      fields.push({ no, wire, value: buf.subarray(pos, pos + 8) });
      pos += 8;
    } else if (wire === 2) {
      let length;
      [length, pos] = readVarint(buf, pos);
      if (pos + length > buf.length) throw new RangeError('proto: truncated bytes');
      fields.push({ no, wire, value: buf.subarray(pos, pos + length) });
      pos += length;
    } else if (wire === 5) {
      if (pos + 4 > buf.length) throw new RangeError('proto: truncated fixed32');
      fields.push({ no, wire, value: buf.subarray(pos, pos + 4) });
      pos += 4;
    } else {
      throw new RangeError(`proto: unsupported wire type ${wire}`);
    }
  }
  return fields;
}

const utf8 = new TextDecoder('utf-8', { fatal: false });

function str(value) {
  if (!value) return '';
  return utf8.decode(value);
}

function num(fields, no, fallback = 0) {
  const f = fields.find((x) => x.no === no && x.wire === 0);
  return f ? f.value : fallback;
}

/**
 * Signed varint. protobuf encodes negative int32/int64 as a 10-byte
 * two's-complement varint; reading it as unsigned yields 2^64-1 territory.
 */
function snum(fields, no, fallback = 0) {
  const f = fields.find((x) => x.no === no && x.wire === 0);
  if (!f) return fallback;
  const big = f.big ?? BigInt(f.value);
  const signed = big >= (1n << 63n) ? big - (1n << 64n) : big;
  return Number(signed);
}

function bytes(fields, no) {
  const f = fields.find((x) => x.no === no && x.wire === 2);
  return f ? f.value : null;
}

function text(fields, no) {
  const b = bytes(fields, no);
  return b ? str(b) : '';
}

/** PacketHead: packet_id=1 msg_id=2 flag=3 body_len=4 total_pack_count=5 seq_id=6 */
export function decodePacketHead(buf) {
  const f = readFields(buf);
  return {
    packetId: num(f, 1),
    msgId: num(f, 2),
    flag: num(f, 3),
    bodyLen: num(f, 4),
    totalPackCount: num(f, 5),
    seqId: num(f, 6),
  };
}

/** ChatMsgData: player_id=1 head=2 badge=3 name=4 text=5 expression=6 send_time=7 avatar_frame=8 */
export function decodeChatMsgData(buf) {
  const f = readFields(buf);
  return {
    playerId: num(f, 1),
    head: num(f, 2),
    badge: num(f, 3),
    name: text(f, 4),
    text: text(f, 5),
    expression: num(f, 6),
    sendTime: num(f, 7),
    avatarFrame: num(f, 8),
  };
}

/** ChatMsgNotice: status=1 type=2 msg=3 */
export function decodeChatMsgNotice(buf) {
  const f = readFields(buf);
  const body = bytes(f, 3);
  return {
    status: num(f, 1),
    type: num(f, 2),
    msg: body ? decodeChatMsgData(body) : null,
  };
}

/** ChatMsgRecordInitNotice: status=1 type=2 msg=3 (repeated) */
export function decodeChatMsgRecordInitNotice(buf) {
  const f = readFields(buf);
  const list = f
    .filter((x) => x.no === 3 && x.wire === 2)
    .map((x) => decodeChatMsgData(x.value));
  return { status: num(f, 1), type: num(f, 2), msg: list };
}

/** SendChatMsgReq: type=1 player_id=2 text=3 expression=4 */
export function decodeSendChatMsgReq(buf) {
  const f = readFields(buf);
  return {
    type: num(f, 1),
    playerId: num(f, 2),
    text: text(f, 3),
    expression: num(f, 4),
  };
}

/** PlayerLoginRsp: player_name=11 scene_id=16 channel_id=17 server_time_ms=2 */
export function decodePlayerLoginRsp(buf) {
  const f = readFields(buf);
  return {
    serverTimeMs: num(f, 2),
    playerName: text(f, 11),
    sceneId: num(f, 16),
    channelId: num(f, 17),
  };
}

/** PlayerMainDataRsp: player_id=2 player_name=3 level=7 head=9 sign=10 world_level=12 scene=16 channel=17 sex=18 */
export function decodePlayerMainDataRsp(buf) {
  const f = readFields(buf);
  return {
    playerId: num(f, 2),
    playerName: text(f, 3),
    level: num(f, 7),
    head: num(f, 9),
    sign: text(f, 10),
    worldLevel: num(f, 12),
    sceneId: num(f, 16),
    channelId: num(f, 17),
    sex: num(f, 18),
  };
}

/** ChangeChatChannelNotice: status=1 channel_id=2 */
export function decodeChangeChatChannelNotice(buf) {
  const f = readFields(buf);
  return { status: num(f, 1), channelId: num(f, 2) };
}

/** Vector3: X=1 Y=2 Z=3 decimal_places=4 (fixed-point ints). */
export function decodeVector3(buf) {
  const f = readFields(buf);
  const dp = num(f, 4);
  const scale = 10 ** Math.min(6, Math.max(0, dp));
  return { x: snum(f, 1) / scale, y: snum(f, 2) / scale, z: snum(f, 3) / scale, dp };
}

/** PlayerBriefInfo: rich profile used by friends and other-player lookups. */
export function decodePlayerBriefInfo(buf) {
  const f = readFields(buf);
  return {
    playerId: num(f, 1),
    name: text(f, 2),
    level: num(f, 3),
    head: num(f, 4),
    lastLoginTime: num(f, 5),
    sex: num(f, 7),
    online: num(f, 9) !== 0,
    sign: text(f, 10),
    guildName: text(f, 11),
    characterId: num(f, 12),
    avatarFrame: num(f, 19),
  };
}

function printable(value, max = 60) {
  if (typeof value !== 'string' || !value) return '';
  if (value.length > max) return '';
  // Reject binary garbage decoded as UTF-8; names/aliases are human text.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/.test(value)) return '';
  return value;
}

function tryPlayerInfo(buf) {
  try {
    const p = decodePlayerBriefInfo(buf);
    const name = printable(p.name, 40);
    if (!p.playerId || !name) return null;
    return { ...p, name };
  } catch {
    return null;
  }
}

/**
 * One FriendBriefInfo. The real element is repeated `info` in FriendRsp; its
 * nested PlayerBriefInfo has been seen at field 2, but keep a layout-agnostic
 * fallback so a schema shift does not silently drop the whole list.
 */
function tryFriendEntry(buf) {
  let g;
  try { g = readFields(buf); } catch { return null; }
  const nested = bytes(g, 2);
  if (nested) {
    const info = tryPlayerInfo(nested);
    if (info) {
      return { alias: printable(text(g, 1), 30), friendTag: num(g, 3), intimacy: num(g, 4), info };
    }
  }
  for (const field of g) {
    if (field.wire !== 2) continue;
    const info = tryPlayerInfo(field.value);
    if (info) return { alias: '', friendTag: 0, intimacy: 0, info };
  }
  const info = tryPlayerInfo(buf);
  if (info) return { alias: '', friendTag: 0, intimacy: 0, info };
  return null;
}

/** FriendRsp: status=1 info=2 (repeated FriendBriefInfo). */
export function decodeFriendRsp(buf) {
  const f = readFields(buf);
  const friends = [];
  const seen = new Set();
  const add = (entry) => {
    if (!entry || seen.has(entry.info.playerId)) return;
    seen.add(entry.info.playerId);
    friends.push(entry);
  };
  for (const field of f) {
    if (field.wire !== 2) continue;
    const direct = tryFriendEntry(field.value);
    if (direct) { add(direct); continue; }
    // Some builds wrap the repeated list in a submessage; look one level down.
    let inner;
    try { inner = readFields(field.value); } catch { continue; }
    for (const sub of inner) if (sub.wire === 2) add(tryFriendEntry(sub.value));
  }
  return {
    status: num(f, 1),
    statusPresent: f.some((x) => x.no === 1 && x.wire === 0),
    friends,
  };
}

/** PrivateChatMsgRecordReq: target_player_id=1 */
export function decodePrivateChatMsgRecordReq(buf) {
  const f = readFields(buf);
  return { targetPlayerId: num(f, 1) };
}

function tryChatMsg(buf) {
  try {
    const m = decodeChatMsgData(buf);
    const name = printable(m.name, 40);
    const hasBody = !!name || !!m.text || !!m.expression;
    if (!hasBody) return null;
    return { ...m, name: name || m.name };
  } catch {
    return null;
  }
}

/**
 * PrivateChatMsgRecordRsp: status=1 msgRecord=2 (repeated MsgRecord).
 * MsgRecord is a wrapper class, not ChatMsgData; try the direct shape first and
 * then unwrap one nested message, so both layouts work.
 */
export function decodePrivateChatMsgRecordRsp(buf) {
  const f = readFields(buf);
  const messages = [];
  const seen = new Set();
  const add = (msg) => {
    if (!msg) return;
    const key = `${msg.playerId}|${msg.sendTime}|${msg.text}|${msg.expression}`;
    if (seen.has(key)) return;
    seen.add(key);
    messages.push(msg);
  };
  for (const field of f) {
    if (field.wire !== 2) continue;
    const direct = tryChatMsg(field.value);
    if (direct) { add(direct); continue; }
    let inner;
    try { inner = readFields(field.value); } catch { continue; }
    for (const sub of inner) {
      if (sub.wire !== 2) continue;
      add(tryChatMsg(sub.value));
    }
  }
  return {
    status: num(f, 1),
    statusPresent: f.some((x) => x.no === 1 && x.wire === 0),
    messages,
  };
}

/** TransmitSceneRsp: status=1; cite scene/channel when the server includes them. */
export function decodeTransmitSceneRsp(buf) {
  const f = readFields(buf);
  const statusPresent = f.some((x) => x.no === 1 && x.wire === 0);
  return {
    status: statusPresent ? num(f, 1) : null,
    statusPresent,
    sceneId: num(f, 2),
    channelId: num(f, 3),
    fields: f.map((x) => x.no),
  };
}

/** ScenePlayer: only the fields the pet needs for presence. */
export function decodeScenePlayer(buf) {
  const f = readFields(buf);
  return { playerId: num(f, 1), name: text(f, 2), avatarFrame: num(f, 8) };
}

/** SceneData: scene_id=1 players=22 channel_id=23 channel_label=27 */
export function decodeSceneData(buf) {
  const f = readFields(buf);
  return {
    sceneId: num(f, 1),
    players: f.filter((x) => x.no === 22 && x.wire === 2).map((x) => decodeScenePlayer(x.value)),
    channelId: num(f, 23),
    channelLabel: num(f, 27),
  };
}

/** SceneDataNotice: status=1 data=2 */
export function decodeSceneDataNotice(buf) {
  const f = readFields(buf);
  const data = bytes(f, 2);
  return { status: num(f, 1), scene: data ? decodeSceneData(data) : null };
}

/**
 * PlayerSceneSyncDataNotice: status=1 data=2 (repeated SceneSyncData)
 * SceneSyncData: player_id=1 data=2 (PlayerRecorderData)
 * PlayerRecorderData: char_recorder_data_lst=1
 * CharacterRecorderData: char_id=1 pos=3 rot=4
 */
export function decodePlayerSceneSyncDataNotice(buf) {
  const f = readFields(buf);
  const players = [];
  for (const entry of f.filter((x) => x.no === 2 && x.wire === 2)) {
    const g = readFields(entry.value);
    const playerId = num(g, 1);
    const chars = [];
    for (const rec of g.filter((x) => x.no === 2 && x.wire === 2)) {
      const h = readFields(rec.value);
      for (const charRec of h.filter((x) => x.no === 1 && x.wire === 2)) {
        const c = readFields(charRec.value);
        const pos = bytes(c, 3);
        const rot = bytes(c, 4);
        chars.push({
          charId: num(c, 1),
          pos: pos ? decodeVector3(pos) : null,
          rot: rot ? decodeVector3(rot) : null,
        });
      }
    }
    if (playerId) players.push({ playerId, chars });
  }
  return { status: num(f, 1), players };
}

/** Serialize ChangeSceneChannelReq for channel hops / teleports. */
export function encodeChangeSceneChannelReq({ sceneId = 0, channelLabel = 0, password = '', targetPlayerLabel = 0 } = {}) {
  const parts = [];
  if (sceneId) parts.push(encodeFieldVarint(1, sceneId));
  if (channelLabel) parts.push(encodeFieldVarint(2, channelLabel));
  if (password) parts.push(encodeFieldString(6, password));
  if (targetPlayerLabel) parts.push(encodeFieldVarint(7, targetPlayerLabel));
  return Buffer.concat(parts);
}

/** Serialize TransmitSceneReq (teleport to a friend). */
export function encodeTransmitSceneReq({ friendId }) {
  return encodeFieldVarint(1, friendId);
}

/** Serialize PrivateChatMsgRecordReq (ask for recent private messages). */
export function encodePrivateChatMsgRecordReq({ targetPlayerId }) {
  return encodeFieldVarint(1, targetPlayerId);
}

/** ChangeSceneChannelRsp: status=1 scene=2 channel=3 label=4 target=6 */
export function decodeChangeSceneChannelRsp(buf) {
  const f = readFields(buf);
  return {
    status: num(f, 1),
    sceneId: num(f, 2),
    channelId: num(f, 3),
    channelLabel: num(f, 4),
    targetPlayerId: num(f, 6),
  };
}

export function encodePacketHead(head) {
  const parts = [];
  if (head.packetId) parts.push(encodeFieldVarint(1, head.packetId));
  parts.push(encodeFieldVarint(2, head.msgId));
  if (head.flag) parts.push(encodeFieldVarint(3, head.flag));
  parts.push(encodeFieldVarint(4, head.bodyLen));
  if (head.totalPackCount) parts.push(encodeFieldVarint(5, head.totalPackCount));
  parts.push(encodeFieldVarint(6, head.seqId));
  return Buffer.concat(parts);
}

/** Serialize SendChatMsgReq. */
export function encodeSendChatMsgReq({ type = 0, playerId = 0, text = '', expression = 0 }) {
  const parts = [encodeFieldVarint(1, type)];
  if (playerId) parts.push(encodeFieldVarint(2, playerId));
  parts.push(encodeFieldString(3, text));
  if (expression) parts.push(encodeFieldVarint(4, expression));
  return Buffer.concat(parts);
}

/** One wire frame: uint16 BE headLen | head | body. */
export function encodeFrame(head, body) {
  const headBytes = encodePacketHead(head);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(headBytes.length, 0);
  return Buffer.concat([len, headBytes, Buffer.from(body)]);
}
