/**
 * Minimal pcap / pcapng reader, for replaying a capture in tests or when the
 * person already has a .pcap from another tool. Live capture uses pcap.mjs.
 */

// The magic is read little-endian, so its value tells us the file's byte order.
const PCAP_MAGICS = new Map([
  [0xa1b2c3d4, { endian: 'le', nano: false }],
  [0xd4c3b2a1, { endian: 'be', nano: false }],
  [0xa1b23c4d, { endian: 'le', nano: true }],
  [0x4d3cb2a1, { endian: 'be', nano: true }],
]);

export function readCaptureFile(buffer) {
  const buf = Buffer.from(buffer);
  if (buf.length < 4) throw new Error('capture: too short');

  if (buf.readUInt32BE(0) === 0x0a0d0d0a) return readPcapng(buf);

  const magic = buf.readUInt32LE(0);
  const info = PCAP_MAGICS.get(magic);
  if (!info) throw new Error(`capture: unknown magic 0x${magic.toString(16)}`);
  const le = info.endian === 'le';
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  if (buf.length < 24) throw new Error('capture: truncated global header');
  const linkType = u32(20);
  const packets = [];
  let pos = 24;
  while (pos + 16 <= buf.length) {
    const sec = u32(pos);
    const frac = u32(pos + 4);
    const caplen = u32(pos + 8);
    if (pos + 16 + caplen > buf.length) break;
    packets.push({
      tsMs: sec * 1000 + Math.floor(frac / (info.nano ? 1e6 : 1e3)),
      bytes: buf.subarray(pos + 16, pos + 16 + caplen),
    });
    pos += 16 + caplen;
  }
  return { linkType, packets };
}

function readPcapng(buf) {
  let pos = 0;
  let le = true;
  let linkType = 1;
  const packets = [];
  while (pos + 8 <= buf.length) {
    const typeRaw = buf.readUInt32LE(pos);
    if (typeRaw === 0x0a0d0d0a) {
      const bom = buf.readUInt32LE(pos + 8);
      le = bom === 0x1a2b3c4d;
      pos += buf.readUInt32LE(pos + 4);
      continue;
    }
    const total = le ? buf.readUInt32LE(pos + 4) : buf.readUInt32BE(pos + 4);
    if (total < 12 || pos + total > buf.length) break;
    const body = buf.subarray(pos + 8, pos + total - 4);
    const type = le ? typeRaw : buf.readUInt32BE(pos);
    if (type === 1 && body.length >= 8) {
      linkType = le ? body.readUInt16LE(0) : body.readUInt16BE(0);
    } else if (type === 6 && body.length >= 20) {
      const tsHigh = le ? body.readUInt32LE(4) : body.readUInt32BE(4);
      const tsLow = le ? body.readUInt32LE(8) : body.readUInt32BE(8);
      const caplen = le ? body.readUInt32LE(12) : body.readUInt32BE(12);
      const start = 20;
      if (start + caplen <= body.length) {
        packets.push({ tsMs: ((tsHigh * 2 ** 32 + tsLow) / 1000), bytes: body.subarray(start, start + caplen) });
      }
    } else if (type === 3 && body.length >= 4) {
      const origLen = le ? body.readUInt32LE(0) : body.readUInt32BE(0);
      const len = Math.min(origLen, body.length - 4);
      packets.push({ tsMs: 0, bytes: body.subarray(4, 4 + len) });
    }
    pos += total;
  }
  return { linkType, packets };
}
