/**
 * Full-frame recorder for the local relay.
 *
 * The relay already decodes the handful of messages the chat World needs. For
 * schema work (furniture, home/channel, anything new) we need to see *every*
 * frame: msgId, direction, and the raw protobuf body, with a timestamp we can
 * line up against what the player did in the game.
 *
 * Design notes:
 *  - One JSONL file (`frames.jsonl`) in the relay output dir, rotated to
 *    `frames-<stamp>.jsonl` when it grows past --record-max-mb.
 *  - Bodies are hex, capped at `bodyLimit` bytes per frame (the interesting
 *    protobuf bodies are small; a truncated frame says so).
 *  - Position sync (1206/1208) arrives every second and would drown everything
 *    else, so those are sampled once per `sampleMs` instead of fully recorded.
 *  - Writes are batched (flush every 250 ms) so the relay's forwarding path is
 *    not blocked by one fsync per frame.
 *  - `mark()` lines segment the timeline: gate open/close, login, maybe a
 *    label the operator sets before doing an action in the game.
 */

import {
  closeSync, existsSync, mkdirSync, openSync, renameSync, statSync, writeFileSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';

const DEFAULT_BODY_LIMIT = 8192;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_SAMPLE_MS = 5000;
const FLUSH_MS = 250;

function stamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** msgIds that flood the wire; keep one sample per interval instead of every frame. */
const NOISY_IDS = new Set([1206, 1208]);

export class FrameRecorder {
  constructor(dir, options = {}) {
    this.dir = dir;
    this.path = join(dir, 'frames.jsonl');
    this.indexPath = join(dir, 'frames-index.json');
    this.bodyLimit = positive(options.bodyLimit, DEFAULT_BODY_LIMIT);
    this.maxBytes = positive(options.maxBytes, DEFAULT_MAX_BYTES);
    this.sampleMs = positive(options.sampleMs, DEFAULT_SAMPLE_MS);
    this.enabled = options.enabled !== false;
    this.label = typeof options.label === 'string' ? options.label : '';
    this.startedAt = new Date().toISOString();
    this.bytes = 0;
    this.frames = 0;
    this.written = 0;
    this.byMsg = new Map();
    this.sampled = new Map();
    this.pending = [];
    this.fd = null;
    this.timer = null;
    this.lastError = '';
  }

  open() {
    mkdirSync(this.dir, { recursive: true });
    if (existsSync(this.path)) {
      this.bytes = statSync(this.path).size;
      if (this.bytes >= this.maxBytes) this.#rotate();
    }
    this.fd = openSync(this.path, 'a');
    this.timer = setInterval(() => this.flush(), FLUSH_MS);
    this.timer.unref?.();
    this.mark('record-start', { label: this.label, file: this.path });
    return this;
  }

  #rotate() {
    if (this.fd !== null) {
      try { closeSync(this.fd); } catch { /* ignore */ }
      this.fd = null;
    }
    const target = join(this.dir, `frames-${stamp()}.jsonl`);
    try { renameSync(this.path, target); } catch { /* ignore */ }
    this.bytes = 0;
    this.fd = openSync(this.path, 'a');
    this.mark('record-rotate', { file: target });
  }

  #write(lines) {
    if (!lines.length) return;
    if (this.fd === null) this.fd = openSync(this.path, 'a');
    const payload = lines.join('');
    try {
      writeSync(this.fd, payload);
      this.bytes += Buffer.byteLength(payload);
      this.written += lines.length;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      return;
    }
    if (this.bytes >= this.maxBytes) this.#rotate();
  }

  flush() {
    if (!this.pending.length) return;
    const lines = this.pending;
    this.pending = [];
    this.#write(lines);
    this.#writeIndex();
  }

  mark(kind, extra = {}) {
    if (!this.enabled) return;
    this.pending.push(`${JSON.stringify({
      v: 1,
      ts: new Date().toISOString(),
      kind,
      ...extra,
    })}\n`);
    this.flush();
  }

  /**
   * Record one decoded frame. `body` is the decompressed protobuf body.
   * Unknown msgIds are exactly the point, so nothing is filtered by id.
   */
  frame({ direction, msgId, packetId = 0, seqId = 0, flag = 0, body, note = '' } = {}) {
    if (!this.enabled) return;
    this.frames += 1;
    const key = `${direction}:${msgId}`;
    const entry = this.byMsg.get(key) ?? { direction, msgId, count: 0, bytes: 0, first: '', last: '', sampled: false };
    entry.count += 1;
    entry.bytes += body?.length ?? 0;
    const now = new Date().toISOString();
    if (!entry.first) entry.first = now;
    entry.last = now;
    this.byMsg.set(key, entry);

    if (NOISY_IDS.has(msgId)) {
      const last = this.sampled.get(key) ?? 0;
      if (Date.now() - last < this.sampleMs) return;
      this.sampled.set(key, Date.now());
      entry.sampled = true;
    }

    const buf = body ?? Buffer.alloc(0);
    const truncated = buf.length > this.bodyLimit;
    this.pending.push(`${JSON.stringify({
      v: 1,
      ts: now,
      kind: 'frame',
      dir: direction,
      msgId,
      packetId,
      seqId,
      flag,
      len: buf.length,
      ...(truncated ? { truncated: true } : {}),
      hex: buf.subarray(0, this.bodyLimit).toString('hex'),
      ...(note ? { note } : {}),
    })}\n`);
    if (this.pending.length >= 200) this.flush();
  }

  #writeIndex() {
    const byMsg = [...this.byMsg.values()]
      .sort((a, b) => b.count - a.count)
      .map((e) => ({ ...e }));
    try {
      const tmp = `${this.indexPath}.tmp`;
      writeFileSync(tmp, JSON.stringify({
        v: 1,
        updatedAt: new Date().toISOString(),
        startedAt: this.startedAt,
        file: this.path,
        frames: this.frames,
        bytes: this.bytes,
        byMsg,
      }, null, 2));
      renameSync(tmp, this.indexPath);
    } catch { /* index is best effort */ }
  }

  status() {
    const byMsg = [...this.byMsg.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 80)
      .map((e) => ({ dir: e.direction, msgId: e.msgId, count: e.count, bytes: e.bytes, sampled: e.sampled }));
    return {
      enabled: this.enabled,
      file: this.path,
      label: this.label,
      startedAt: this.startedAt,
      frames: this.frames,
      written: this.written,
      queued: this.pending.length,
      bytes: this.bytes,
      bodyLimit: this.bodyLimit,
      lastError: this.lastError,
      byMsg,
    };
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.mark('record-stop', { frames: this.frames });
    this.flush();
    this.#writeIndex();
    if (this.fd !== null) {
      try { closeSync(this.fd); } catch { /* ignore */ }
      this.fd = null;
    }
  }
}

function positive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
