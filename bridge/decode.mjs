/**
 * Link/network/transport parsing for captured frames.
 *
 * Npcap hands us link-layer frames. The game talks IPv4/TCP, so this handles
 * Ethernet II (with or without a single 802.1Q tag) and raw IP, and ignores
 * everything that is not TCP.
 */

const ETH_IPV4 = 0x0800;
const ETH_VLAN = 0x8100;
const ETH_VLAN_QINQ = 0x88a8;

export function parseFrame(raw, datalink = 1) {
  const buf = raw instanceof Buffer ? raw : Buffer.from(raw);
  let offset = 0;

  if (datalink === 1) {
    if (buf.length < 14) return null;
    let etherType = buf.readUInt16BE(12);
    offset = 14;
    while (etherType === ETH_VLAN || etherType === ETH_VLAN_QINQ) {
      if (buf.length < offset + 4) return null;
      etherType = buf.readUInt16BE(offset + 2);
      offset += 4;
    }
    if (etherType !== ETH_IPV4) return null;
  } else if (datalink === 12 || datalink === 101) {
    offset = 0;
  } else {
    return null;
  }

  if (buf.length < offset + 20) return null;
  const version = buf[offset] >> 4;
  if (version !== 4) return null;
  const ihl = (buf[offset] & 0x0f) * 4;
  if (ihl < 20 || buf.length < offset + ihl) return null;
  const totalLen = buf.readUInt16BE(offset + 2);
  const protocol = buf[offset + 9];
  if (protocol !== 6) return null;
  if (totalLen < ihl + 20 || totalLen > buf.length - offset) return null;

  const srcIp = `${buf[offset + 12]}.${buf[offset + 13]}.${buf[offset + 14]}.${buf[offset + 15]}`;
  const dstIp = `${buf[offset + 16]}.${buf[offset + 17]}.${buf[offset + 18]}.${buf[offset + 19]}`;

  const tcp = offset + ihl;
  const dataOffset = (buf[tcp + 12] >> 4) * 4;
  if (dataOffset < 20) return null;
  const sport = buf.readUInt16BE(tcp);
  const dport = buf.readUInt16BE(tcp + 2);
  const seq = buf.readUInt32BE(tcp + 4);
  const flags = buf[tcp + 13];
  const payloadStart = tcp + dataOffset;
  const payloadEnd = offset + totalLen;
  const payload = payloadStart <= payloadEnd ? buf.subarray(payloadStart, payloadEnd) : Buffer.alloc(0);

  return { srcIp, dstIp, sport, dport, seq, flags, payload };
}

/** True when either endpoint uses one of the game gateway ports. */
export function isGatePort(sport, dport, ranges) {
  return ranges.some(([lo, hi]) => (sport >= lo && sport <= hi) || (dport >= lo && dport <= hi));
}

/** Parse "11000-11100,12000" into [[11000,11100],[12000,12000]]. */
export function parsePortRanges(text) {
  const ranges = [];
  for (const part of String(text ?? '').split(',')) {
    const piece = part.trim();
    if (!piece) continue;
    const m = /^(\d{1,5})(?:\s*-\s*(\d{1,5}))?$/.exec(piece);
    if (!m) continue;
    const lo = Number(m[1]);
    const hi = m[2] === undefined ? lo : Number(m[2]);
    if (lo >= 1 && hi <= 65535 && lo <= hi) ranges.push([lo, hi]);
  }
  return ranges.length ? ranges : [[11000, 11100]];
}
