/**
 * Game frame parser.
 *
 * Wire format (from the client's own network layer):
 *   uint16 BE headLen | PacketHead (protobuf, headLen bytes) | body (bodyLen bytes)
 * body is Snappy-compressed when PacketHead.flag == 1.
 */

import { decodePacketHead } from './proto.mjs';
import { snappyDecompress } from './snappy.mjs';

const MAX_HEAD = 4096;
const MAX_BODY = 1_000_000;

export class FrameParser {
  constructor(onFrame, onError) {
    this.onFrame = onFrame;
    this.onError = onError ?? (() => {});
    this.buffer = Buffer.alloc(0);
    this.resyncs = 0;
  }

  /** Feed ordered stream bytes. Returns the number of frames emitted. */
  push(chunk) {
    if (!chunk || chunk.length === 0) return 0;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk);
    let emitted = 0;

    for (;;) {
      if (this.buffer.length < 2) break;
      const headLen = this.buffer.readUInt16BE(0);
      if (headLen < 2 || headLen > MAX_HEAD) {
        this.#dropOne('bad head length');
        continue;
      }
      if (this.buffer.length < 2 + headLen) break;

      let head;
      try {
        head = decodePacketHead(this.buffer.subarray(2, 2 + headLen));
      } catch {
        this.#dropOne('bad packet head');
        continue;
      }
      if (head.flag > 1 || head.bodyLen > MAX_BODY) {
        this.#dropOne('implausible packet head');
        continue;
      }
      if (this.buffer.length < 2 + headLen + head.bodyLen) break;

      const bodyRaw = this.buffer.subarray(2 + headLen, 2 + headLen + head.bodyLen);
      let body = bodyRaw;
      if (head.flag === 1) {
        try {
          body = Buffer.from(snappyDecompress(bodyRaw));
        } catch (error) {
          this.onError(`snappy: ${error.message}`, head);
          this.buffer = this.buffer.subarray(2 + headLen + head.bodyLen);
          continue;
        }
      }

      const total = 2 + headLen + head.bodyLen;
      const rawFrame = Buffer.from(this.buffer.subarray(0, total));
      this.buffer = this.buffer.subarray(total);
      emitted += 1;
      try {
        // The relay needs the original bytes to forward them untouched.
        this.onFrame({ ...head, body }, rawFrame);
      } catch (error) {
        this.onError(`frame handler: ${error.message}`, head);
      }
      if (this.buffer.length === 0) break;
    }
    return emitted;
  }

  #dropOne(reason) {
    this.resyncs += 1;
    this.buffer = this.buffer.subarray(1);
    if (this.resyncs <= 5 || this.resyncs % 500 === 0) this.onError(`resync: ${reason}`, null);
  }
}
