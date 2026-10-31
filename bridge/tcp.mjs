/**
 * Per-direction TCP stream reassembly.
 *
 * We capture on the host, so segments usually arrive in order; retransmits,
 * keep-alive probes and rare reordering still happen. This keeps one ordered
 * byte stream per 4-tuple direction and hands contiguous bytes to the frame
 * parser.
 */

const MAX_PENDING = 256;

export class TcpReassembler {
  constructor(onData, onGap) {
    this.onData = onData;
    this.onGap = onGap ?? (() => {});
    this.streams = new Map();
  }

  key(packet) {
    return `${packet.srcIp}:${packet.sport}>${packet.dstIp}:${packet.dport}`;
  }

  stateFor(packet) {
    const key = this.key(packet);
    let state = this.streams.get(key);
    if (!state) {
      state = { key, nextSeq: null, pending: new Map(), synced: false, bytes: 0, gaps: 0 };
      this.streams.set(key, state);
    }
    return state;
  }

  push(packet) {
    const { seq, flags, payload } = packet;
    const state = this.stateFor(packet);
    const hasSyn = (flags & 0x02) !== 0;
    const hasRst = (flags & 0x04) !== 0;

    if (hasRst) {
      this.streams.delete(state.key);
      return;
    }

    if (hasSyn) {
      state.nextSeq = (seq + 1) >>> 0;
      state.pending.clear();
      state.synced = true;
      state.bytes = 0;
      if (!payload || payload.length === 0) return;
    }

    if (!payload || payload.length === 0) return;

    let start = seq >>> 0;
    if (state.nextSeq === null) {
      state.nextSeq = start;
      state.synced = true;
    }

    // Bytes already delivered (retransmission): trim the overlap.
    let ahead = ((start - state.nextSeq) >>> 0);
    if (ahead >= 0x80000000) {
      const overlap = ((state.nextSeq - start) >>> 0);
      if (overlap >= payload.length) return;
      start = state.nextSeq;
      ahead = 0;
    }

    if (ahead === 0) {
      this.#deliver(state, payload);
      this.#drain(state);
    } else {
      // Ahead of the stream: hold it until the gap fills.
      if (state.pending.size >= MAX_PENDING) {
        this.#skipTo(state, start);
      }
      const existing = state.pending.get(start);
      if (!existing || existing.length < payload.length) state.pending.set(start, Buffer.from(payload));
    }
  }

  #deliver(state, data) {
    state.nextSeq = (state.nextSeq + data.length) >>> 0;
    state.bytes += data.length;
    this.onData(state.key, data);
  }

  #drain(state) {
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const [start, data] of state.pending) {
        const delta = ((start - state.nextSeq) >>> 0);
        if (delta === 0) {
          state.pending.delete(start);
          this.#deliver(state, data);
          progressed = true;
        } else if (delta < data.length) {
          // Overlaps a bit; keep the tail.
          state.pending.delete(start);
          this.#deliver(state, data.subarray(delta));
          progressed = true;
        } else if (delta >= 0x80000000) {
          // Behind the stream: stale retransmit.
          state.pending.delete(start);
        }
      }
    }
  }

  /** A gap never filled: jump to the earliest held segment and report it. */
  #skipTo(state, seq) {
    let smallest = seq;
    for (const start of state.pending.keys()) {
      if (((start - smallest) >>> 0) < 0x80000000) smallest = start;
    }
    state.gaps += 1;
    state.nextSeq = smallest;
    state.pending.clear();
    this.onGap(state.key, state.gaps);
  }
}
