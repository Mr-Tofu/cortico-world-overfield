/** Builders for synthetic game frames and packets, used by the tests. */

export function varint(value) {
  let v = Number(value);
  const out = [];
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return Buffer.from(out);
}

export function fieldVarint(no, value) {
  return Buffer.concat([varint((no << 3) | 0), varint(value)]);
}

export function fieldBytes(no, bytes) {
  return Buffer.concat([varint((no << 3) | 2), varint(bytes.length), Buffer.from(bytes)]);
}

export function fieldString(no, text) {
  return fieldBytes(no, Buffer.from(text, 'utf8'));
}

export function chatMsgData({ playerId = 11763684, name = '阿桃', text = '你好', expression = 0, sendTime = 1761000000000 } = {}) {
  return Buffer.concat([
    fieldVarint(1, playerId),
    fieldString(4, name),
    fieldString(5, text),
    fieldVarint(6, expression),
    fieldVarint(7, sendTime),
  ]);
}

export function chatMsgNotice({ type = 0, msg = chatMsgData() } = {}) {
  return Buffer.concat([fieldVarint(1, 0), fieldVarint(2, type), fieldBytes(3, msg)]);
}

export function packetHead({ msgId, bodyLen, packetId = 0, seqId = 1, flag = 0 }) {
  return Buffer.concat([
    fieldVarint(1, packetId),
    fieldVarint(2, msgId),
    fieldVarint(3, flag),
    fieldVarint(4, bodyLen),
    fieldVarint(6, seqId),
  ]);
}

export function frame({ msgId, body, packetId = 0, seqId = 1, flag = 0 }) {
  const head = packetHead({ msgId, bodyLen: body.length, packetId, seqId, flag });
  const len = Buffer.alloc(2);
  len.writeUInt16BE(head.length, 0);
  return Buffer.concat([len, head, body]);
}

export function snappyLiteral(bytes) {
  const buf = Buffer.from(bytes);
  const parts = [varint(buf.length)];
  let pos = 0;
  while (pos < buf.length) {
    const chunk = Math.min(60, buf.length - pos);
    parts.push(Buffer.from([(chunk - 1) << 2]));
    parts.push(buf.subarray(pos, pos + chunk));
    pos += chunk;
  }
  return Buffer.concat(parts);
}

/** Build an Ethernet/IPv4/TCP packet carrying `payload`. */
export function tcpPacket({
  srcIp = '192.168.2.61', dstIp = '14.103.255.173', sport = 51000, dport = 11002,
  seq = 1000, flags = 0x18, payload = Buffer.alloc(0),
}) {
  const eth = Buffer.alloc(14);
  Buffer.from('aabbccddeeff', 'hex').copy(eth, 0);
  Buffer.from('112233445566', 'hex').copy(eth, 6);
  eth.writeUInt16BE(0x0800, 12);

  const tcp = Buffer.alloc(20);
  tcp.writeUInt16BE(sport, 0);
  tcp.writeUInt16BE(dport, 2);
  tcp.writeUInt32BE(seq >>> 0, 4);
  tcp.writeUInt32BE(1, 8);
  tcp[12] = 5 << 4;
  tcp[13] = flags;
  tcp.writeUInt16BE(65535, 14);

  const ip = Buffer.alloc(20);
  ip[0] = 0x45;
  ip.writeUInt16BE(20 + tcp.length + payload.length, 2);
  ip[8] = 64;
  ip[9] = 6;
  const src = srcIp.split('.').map(Number);
  const dst = dstIp.split('.').map(Number);
  for (let i = 0; i < 4; i += 1) { ip[12 + i] = src[i]; ip[16 + i] = dst[i]; }

  return Buffer.concat([eth, ip, tcp, payload]);
}

/** Serialize packets as a classic little-endian pcap file. */
export function pcapFile(packets, linkType = 1) {
  const header = Buffer.alloc(24);
  header.writeUInt32LE(0xa1b2c3d4, 0);
  header.writeUInt16LE(2, 4);
  header.writeUInt16LE(4, 6);
  header.writeUInt32LE(65535, 16);
  header.writeUInt32LE(linkType, 20);
  const chunks = [header];
  for (const packet of packets) {
    const rec = Buffer.alloc(16);
    rec.writeUInt32LE(1761000000, 0);
    rec.writeUInt32LE(0, 4);
    rec.writeUInt32LE(packet.length, 8);
    rec.writeUInt32LE(packet.length, 12);
    chunks.push(rec, packet);
  }
  return Buffer.concat(chunks);
}
