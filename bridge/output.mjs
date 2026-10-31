/**
 * Bridge output: append-only chat feed, atomic status file, and a small log.
 *
 * The World tails `chat.jsonl`; `status.json` is the health/one-glance JSON the
 * World reads without keeping its own counters.
 */

import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync,
  renameSync, statSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';

const ROTATE_BYTES = 8 * 1024 * 1024;

export class Output {
  constructor(dir, meta = {}) {
    this.dir = dir;
    this.meta = meta;
    this.feedPath = join(dir, 'chat.jsonl');
    this.statusPath = join(dir, 'status.json');
    this.logPath = join(dir, 'bridge.log');
    this.fd = null;
    this.bytes = 0;
    this.startedAt = new Date().toISOString();
    this.counters = {
      packets: 0,
      tcpPackets: 0,
      frames: 0,
      chats: 0,
      history: 0,
      sent: 0,
      resyncs: 0,
    };
    this.extra = {};
    this.lastError = '';
  }

  init() {
    mkdirSync(this.dir, { recursive: true });
    this.#checkLock();
    this.#rotateIfNeeded(true);
    this.log(`bridge start pid=${process.pid} ${JSON.stringify(this.meta)}`);
    this.writeStatus();
  }

  #checkLock() {
    if (!existsSync(this.statusPath)) return;
    try {
      const previous = JSON.parse(readFileSync(this.statusPath, 'utf8'));
      const pid = Number(previous?.pid);
      if (pid && pid !== process.pid && isAlive(pid)) {
        throw new Error(`另一个桥接进程正在运行（pid ${pid}）`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('另一个桥接')) throw error;
      // A corrupt status file is not a lock.
    }
  }

  #rotateIfNeeded(force = false) {
    if (this.fd !== null) {
      if (!force && this.bytes < ROTATE_BYTES) return;
      closeSync(this.fd);
      this.fd = null;
    }
    if (existsSync(this.feedPath)) {
      const size = statSync(this.feedPath).size;
      if (size >= ROTATE_BYTES) {
        const old = join(this.dir, 'chat.1.jsonl');
        try { if (existsSync(old)) unlinkSync(old); } catch { /* ignore */ }
        try { renameSync(this.feedPath, old); } catch { /* ignore */ }
        this.bytes = 0;
      } else {
        this.bytes = size;
      }
    }
    this.fd = openSync(this.feedPath, 'a');
  }

  #writeLine(record) {
    const line = JSON.stringify(record) + '\n';
    this.#rotateIfNeeded(false);
    writeSync(this.fd, line);
    this.bytes += Buffer.byteLength(line);
  }

  chat(record) {
    this.counters.chats += 1;
    this.#writeLine({ v: 1, kind: 'chat', ...record });
    this.writeStatus();
  }

  history(channel, messages) {
    if (!messages.length) return;
    this.counters.history += messages.length;
    this.#writeLine({ v: 1, kind: 'history', channel, messages });
    this.writeStatus();
  }

  sent(record) {
    this.counters.sent += 1;
    this.#writeLine({ v: 1, kind: 'sent', ...record });
  }

  self(record) {
    this.extra.self = record;
    this.#writeLine({ v: 1, kind: 'self', ...record });
  }

  profile(record) {
    this.extra.profile = record;
    this.#writeLine({ v: 1, kind: 'profile', ...record });
  }

  friends(list) {
    this.extra.friends = { count: list.length, updatedAt: new Date().toISOString() };
    this.#writeLine({ v: 1, kind: 'friends', friends: list, updatedAt: new Date().toISOString() });
  }

  privateHistory(target, messages) {
    this.counters.history += messages.length;
    this.#writeLine({ v: 1, kind: 'privateHistory', target, messages });
    this.writeStatus();
  }

  scene(record) {
    this.extra.scene = record;
    this.#writeLine({ v: 1, kind: 'scene', ...record });
    this.writeStatus();
  }

  sceneChannel(record) {
    this.extra.sceneChannel = record;
    this.#writeLine({ v: 1, kind: 'sceneChannel', ...record });
  }

  /** Position sync arrives many times per second; persist at most every 2 s. */
  positions(players) {
    this.extra.positions = { updatedAt: new Date().toISOString(), players };
    const now = Date.now();
    if (now - (this._lastPositionsWrite ?? 0) < 2000) return;
    this._lastPositionsWrite = now;
    this.#writeLine({ v: 1, kind: 'positions', updatedAt: this.extra.positions.updatedAt, players });
  }

  channel(record) {
    this.extra.channel = record;
    this.#writeLine({ v: 1, kind: 'channel', ...record });
  }

  note(record) {
    this.#writeLine({ v: 1, kind: 'note', ...record });
  }

  bump(name, delta = 1) {
    this.counters[name] = (this.counters[name] ?? 0) + delta;
  }

  setStatus(patch) {
    Object.assign(this.extra, patch);
  }

  error(message) {
    this.lastError = String(message).slice(0, 500);
    this.log(`ERROR ${this.lastError}`);
    this.writeStatus();
  }

  writeStatus() {
    const status = {
      v: 1,
      pid: process.pid,
      mode: this.meta.mode ?? 'live',
      startedAt: this.startedAt,
      updatedAt: new Date().toISOString(),
      dir: this.dir,
      device: this.meta.device ?? '',
      deviceDescription: this.meta.deviceDescription ?? '',
      filter: this.meta.filter ?? '',
      npcap: this.meta.npcap ?? '',
      ...this.counters,
      lastError: this.lastError,
      ...this.extra,
    };
    const tmp = `${this.statusPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(status, null, 2));
    try { renameSync(tmp, this.statusPath); } catch { /* Windows race; next tick retries */ }
  }

  log(message) {
    const line = `${new Date().toISOString()} ${message}\n`;
    try { appendFileSync(this.logPath, line); } catch { /* ignore */ }
    if (process.env.OF_BRIDGE_VERBOSE) process.stderr.write(line);
  }

  close() {
    this.writeStatus();
    if (this.fd !== null) {
      try { closeSync(this.fd); } catch { /* ignore */ }
      this.fd = null;
    }
    this.log('bridge stop');
  }
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
