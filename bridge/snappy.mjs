/**
 * Snappy raw-block decompressor.
 *
 * The game compresses a packet body with Snappy when the packet head has
 * `flag = 1` (the server does it for bodies above 1 KiB, so chat history
 * bursts are compressed). There is no Snappy decoder in Node, and pulling a
 * native module into an extension is not worth it for ~60 lines.
 *
 * Format: https://github.com/google/snappy/blob/main/format_description.txt
 */

function readU32LE(buf, pos) {
  return buf[pos] | (buf[pos + 1] << 8) | (buf[pos + 2] << 16) | (buf[pos + 3] * 0x1000000);
}

function readVarint(buf, pos) {
  let result = 0;
  let shift = 0;
  for (;;) {
    if (pos >= buf.length) throw new RangeError('snappy: truncated varint');
    const byte = buf[pos++];
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return [result, pos];
    shift += 7;
    if (shift > 35) throw new RangeError('snappy: varint too long');
  }
}

export function snappyDecompress(input) {
  const buf = input instanceof Uint8Array ? input : Uint8Array.from(input);
  let pos = 0;
  const [expected] = readVarint(buf, pos);
  pos = readVarint(buf, pos)[1];
  if (expected === 0) return new Uint8Array(0);
  if (expected > 64 * 1024 * 1024) throw new RangeError(`snappy: implausible length ${expected}`);

  const out = new Uint8Array(expected);
  let written = 0;

  while (pos < buf.length && written < expected) {
    const tag = buf[pos++];
    const kind = tag & 0x03;

    if (kind === 0) {
      // Literal: length-1, possibly extended.
      let length = tag >> 2;
      if (length < 60) {
        length += 1;
      } else {
        const extra = length - 59;
        if (pos + extra > buf.length) throw new RangeError('snappy: truncated literal length');
        let value = 0;
        for (let i = 0; i < extra; i += 1) value += buf[pos + i] * 2 ** (8 * i);
        pos += extra;
        length = value + 1;
      }
      if (pos + length > buf.length) throw new RangeError('snappy: truncated literal');
      if (written + length > expected) throw new RangeError('snappy: literal overflow');
      out.set(buf.subarray(pos, pos + length), written);
      pos += length;
      written += length;
      continue;
    }

    let length;
    let offset;
    if (kind === 1) {
      if (pos >= buf.length) throw new RangeError('snappy: truncated copy1');
      length = ((tag >> 2) & 0x07) + 4;
      offset = ((tag >> 5) << 8) | buf[pos++];
    } else if (kind === 2) {
      if (pos + 2 > buf.length) throw new RangeError('snappy: truncated copy2');
      length = (tag >> 2) + 1;
      offset = buf[pos] | (buf[pos + 1] << 8);
      pos += 2;
    } else {
      if (pos + 4 > buf.length) throw new RangeError('snappy: truncated copy4');
      length = (tag >> 2) + 1;
      offset = readU32LE(buf, pos);
      pos += 4;
    }

    if (offset <= 0 || offset > written) throw new RangeError('snappy: bad copy offset');
    if (written + length > expected) throw new RangeError('snappy: copy overflow');
    // Overlapping copies are legal and must run byte by byte.
    for (let i = 0; i < length; i += 1) {
      out[written] = out[written - offset];
      written += 1;
    }
  }

  if (written !== expected) throw new RangeError(`snappy: expected ${expected} bytes, got ${written}`);
  return out;
}
