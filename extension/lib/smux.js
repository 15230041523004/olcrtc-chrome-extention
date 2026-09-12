/**
 * smux v2 client (xtaci/smux). Header is little-endian.
 * First client OpenStream id is 3 (nextStreamID starts at 1, then += 2).
 */

const CMD_SYN = 0;
const CMD_FIN = 1;
const CMD_PSH = 2;
const CMD_NOP = 3;
const CMD_UPD = 4;
const HDR = 8;
const UPD_LEN = 8;
const VERSION = 2;
const MAX_FRAME = 32 * 1024;
export const SMUX_STREAM_WINDOW = 4 * 1024 * 1024; // 4 MiB stream receive window for unthrottled throughput
export const SMUX_UPD_THRESHOLD = 256 * 1024; // 256 KiB increment threshold for window updates

function hdr(ver, cmd, sid, len) {
  const b = new Uint8Array(HDR);
  b[0] = ver;
  b[1] = cmd;
  new DataView(b.buffer).setUint16(2, len, true);
  new DataView(b.buffer).setUint32(4, sid, true);
  return b;
}

export class SmuxClient {
  constructor(conn) {
    this.conn = conn; // { write(u8), onData }
    this.nextStreamID = 1;
    this.streams = new Map();
    this.rx = new Uint8Array(0);
    this.conn.onData = (chunk) => this.push(chunk);
  }

  openStream() {
    this.nextStreamID += 2;
    const sid = this.nextStreamID;
    const st = new SmuxStream(this, sid);
    this.streams.set(sid, st);
    this.conn.write(hdr(VERSION, CMD_SYN, sid, 0));
    return st;
  }

  closeAll() {
    for (const st of Array.from(this.streams.values())) {
      try {
        st.close();
      } catch {
        /* ignore */
      }
    }
    this.streams.clear();
  }

  writeFrame(cmd, sid, data) {
    const payload = data || new Uint8Array(0);
    const h = hdr(VERSION, cmd, sid, payload.length);
    const out = new Uint8Array(h.length + payload.length);
    out.set(h, 0);
    if (payload.length) out.set(payload, h.length);
    this.conn.write(out);
  }

  push(chunk) {
    if (!chunk || !chunk.length) return;
    if (this.rx.length === 0) {
      this.rx = chunk;
    } else {
      const n = new Uint8Array(this.rx.length + chunk.length);
      n.set(this.rx, 0);
      n.set(chunk, this.rx.length);
      this.rx = n;
    }
    this.parse();
  }

  parse() {
    let offset = 0;
    while (this.rx.length - offset >= HDR) {
      const v = new DataView(this.rx.buffer, this.rx.byteOffset + offset, this.rx.length - offset);
      const ver = this.rx[offset];
      const cmd = this.rx[offset + 1];
      const len = v.getUint16(2, true);
      const sid = v.getUint32(4, true);
      if (ver !== VERSION) return;
      if (this.rx.length - offset < HDR + len) break;
      const body = this.rx.subarray(offset + HDR, offset + HDR + len);
      offset += HDR + len;
      const st = this.streams.get(sid);
      if (cmd === CMD_PSH && st && body.length) {
        st.pushBytes(body.slice());
        st.numRead = (st.numRead + body.length) >>> 0;
        st.incr = (st.incr + body.length) >>> 0;
        // Send window update on first chunk or when accumulated consumed bytes reach threshold (256 KB)
        if (st.incr >= SMUX_UPD_THRESHOLD || st.numRead === body.length) {
          st.incr = 0;
          try {
            this.writeFrame(CMD_UPD, sid, updBody(st.numRead, SMUX_STREAM_WINDOW));
          } catch {
            /* conn may be closing */
          }
        }
      } else if (cmd === CMD_FIN && st) {
        st.eof = true;
        st.wake();
        this.streams.delete(sid);
      } else if (cmd === CMD_UPD && body.length === UPD_LEN && st) {
        /* peer window update */
        const uv = new DataView(body.buffer, body.byteOffset, body.byteLength);
        st.peerConsumed = uv.getUint32(0, true);
        st.peerWindow = uv.getUint32(4, true);
      }
    }
    if (offset > 0) {
      if (offset >= this.rx.length) {
        this.rx = new Uint8Array(0);
      } else {
        this.rx = this.rx.slice(offset);
      }
    }
  }
}

function updBody(consumed, window) {
  const b = new Uint8Array(UPD_LEN);
  const v = new DataView(b.buffer);
  v.setUint32(0, consumed >>> 0, true);
  v.setUint32(4, window >>> 0, true);
  return b;
}

export class SmuxStream {
  constructor(sess, sid) {
    this.sess = sess;
    this.sid = sid;
    this.chunks = [];
    this.headOffset = 0;
    this.bufferedBytes = 0;
    this.eof = false;
    this.closed = false;
    this.waiters = [];
    this.numRead = 0;
    this.incr = 0;
    this.peerConsumed = 0;
    this.peerWindow = SMUX_STREAM_WINDOW;
  }

  get buf() {
    if (this.chunks.length === 0) return new Uint8Array(0);
    if (this.chunks.length === 1 && this.headOffset === 0) return this.chunks[0];
    const out = new Uint8Array(this.bufferedBytes);
    let off = 0;
    for (let i = 0; i < this.chunks.length; i++) {
      const c = i === 0 ? this.chunks[0].subarray(this.headOffset) : this.chunks[i];
      out.set(c, off);
      off += c.length;
    }
    return out;
  }

  set buf(val) {
    this.chunks = val?.length ? [val] : [];
    this.headOffset = 0;
    this.bufferedBytes = val?.length || 0;
  }

  pushBytes(b) {
    if (!b || !b.length) return;
    this.chunks.push(b);
    this.bufferedBytes += b.length;
    this.wake();
  }

  wake() {
    const w = this.waiters.splice(0);
    for (const fn of w) fn();
  }

  write(data) {
    if (this.closed) throw new Error(`smux: stream ${this.sid} closed`);
    const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
    let off = 0;
    while (off < u8.length) {
      const n = Math.min(MAX_FRAME, u8.length - off);
      this.sess.writeFrame(CMD_PSH, this.sid, u8.subarray(off, off + n));
      off += n;
    }
    return u8.length;
  }

  async read(n) {
    while (this.bufferedBytes === 0) {
      if (this.eof || this.closed) return new Uint8Array(0);
      await new Promise((r) => this.waiters.push(r));
    }
    const want = Math.min(n ?? this.bufferedBytes, this.bufferedBytes);
    if (want === 0) return new Uint8Array(0);

    const headAvail = this.chunks[0].length - this.headOffset;
    if (want === headAvail) {
      const out = this.headOffset === 0 ? this.chunks[0] : this.chunks[0].subarray(this.headOffset);
      this.chunks.shift();
      this.headOffset = 0;
      this.bufferedBytes -= want;
      return out;
    }
    if (want < headAvail) {
      const out = this.chunks[0].subarray(this.headOffset, this.headOffset + want);
      this.headOffset += want;
      this.bufferedBytes -= want;
      return out;
    }

    const out = new Uint8Array(want);
    let copied = 0;
    while (copied < want) {
      const cur = this.chunks[0];
      const curAvail = cur.length - this.headOffset;
      const take = Math.min(curAvail, want - copied);
      out.set(cur.subarray(this.headOffset, this.headOffset + take), copied);
      copied += take;
      this.headOffset += take;
      if (this.headOffset >= cur.length) {
        this.chunks.shift();
        this.headOffset = 0;
      }
    }
    this.bufferedBytes -= want;
    return out;
  }

  async readFull(n) {
    const out = new Uint8Array(n);
    let o = 0;
    while (o < n) {
      const chunk = await this.read(n - o);
      if (!chunk.length) throw new Error('smux: eof');
      out.set(chunk, o);
      o += chunk.length;
    }
    return out;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.incr > 0) {
      try {
        this.sess.writeFrame(CMD_UPD, this.sid, updBody(this.numRead, 512 * 1024));
      } catch {
        /* session may be dead */
      }
      this.incr = 0;
    }
    try {
      this.sess.writeFrame(CMD_FIN, this.sid, null);
    } catch {
      /* session may be dead */
    }
    this.sess.streams.delete(this.sid);
    this.eof = true;
    this.wake();
  }
}
