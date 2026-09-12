/**
 * KCP ARQ (ikcp / kcp-go compatible). Stream mode + conv 0xC0FFEE01 for vp8channel.
 * JS fallback — no Go toolchain here to emit WASM.
 */

export const KCP_CONV = 0xc0ffee01;
export const KCP_MTU = 1400;
export const KCP_OVERHEAD = 24;
export const KCP_CMD_PUSH = 81;
export const KCP_CMD_ACK = 82;
export const KCP_CMD_WASK = 83;
export const KCP_CMD_WINS = 84;

function nowMs() {
  return Math.floor(performance.now()) >>> 0;
}

function timediff(later, earlier) {
  return (later - earlier) | 0;
}

function encodeSeg(seg) {
  const buf = new Uint8Array(KCP_OVERHEAD + (seg.data ? seg.data.length : 0));
  const v = new DataView(buf.buffer);
  v.setUint32(0, seg.conv, true);
  buf[4] = seg.cmd;
  buf[5] = seg.frg;
  v.setUint16(6, seg.wnd, true);
  v.setUint32(8, seg.ts, true);
  v.setUint32(12, seg.sn, true);
  v.setUint32(16, seg.una, true);
  v.setUint32(20, seg.data ? seg.data.length : 0, true);
  if (seg.data && seg.data.length) buf.set(seg.data, KCP_OVERHEAD);
  return buf;
}

export class KCP {
  constructor(conv, output) {
    this.conv = conv >>> 0;
    this.output = output;
    this.mtu = KCP_MTU;
    this.mss = this.mtu - KCP_OVERHEAD;
    this.sndUna = 0;
    this.sndNxt = 0;
    this.rcvNxt = 0;
    this.rxRto = 200;
    this.rxMinrto = 30;
    this.rxSrtt = 0;
    this.rxRttvar = 0;
    this.sndWnd = 32;
    this.rcvWnd = 32;
    this.rmtWnd = 32;
    this.cwnd = 0;
    this.interval = 100;
    this.tsFlush = 0;
    this.nodelay = 0;
    this.updated = 0;
    this.fastresend = 0;
    this.nocwnd = 0;
    this.stream = 0;
    this.sndQueue = [];
    this.rcvQueue = [];
    this.sndBuf = [];
    this.rcvBuf = [];
    this.acklist = [];
    this.deadLink = 20;
    this.state = 0;
    this.ssthresh = 2;
    this.incr = 0;
    this.probe = 0;
  }

  setMtu(mtu) {
    if (mtu <= KCP_OVERHEAD) return;
    this.mtu = mtu;
    this.mss = mtu - KCP_OVERHEAD;
  }

  noDelay(nodelay, interval, resend, nc) {
    if (nodelay >= 0) {
      this.nodelay = nodelay;
      this.rxMinrto = nodelay ? 30 : 100;
    }
    if (interval >= 0) {
      this.interval = Math.min(5000, Math.max(10, interval));
    }
    if (resend >= 0) this.fastresend = resend;
    if (nc >= 0) this.nocwnd = nc;
  }

  wndSize(snd, rcv) {
    if (snd > 0) this.sndWnd = snd;
    if (rcv > 0) this.rcvWnd = rcv;
  }

  setStream(on) {
    this.stream = on ? 1 : 0;
  }

  wndUnused() {
    return this.rcvQueue.length < this.rcvWnd ? this.rcvWnd - this.rcvQueue.length : 0;
  }

  send(buffer) {
    if (!buffer.length) return -1;
    let data = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (this.stream && this.sndQueue.length) {
      const last = this.sndQueue[this.sndQueue.length - 1];
      if (last.data.length < this.mss) {
        const ext = Math.min(data.length, this.mss - last.data.length);
        const n = new Uint8Array(last.data.length + ext);
        n.set(last.data);
        n.set(data.subarray(0, ext), last.data.length);
        last.data = n;
        data = data.subarray(ext);
      }
      if (!data.length) return 0;
    }
    let count = Math.ceil(data.length / this.mss) || 1;
    if (count > 255) return -2;
    for (let i = 0; i < count; i++) {
      const size = Math.min(data.length, this.mss);
      this.sndQueue.push({
        data: data.subarray(0, size).slice(),
        frg: this.stream ? 0 : count - i - 1,
      });
      data = data.subarray(size);
    }
    return 0;
  }

  peekSize() {
    if (!this.rcvQueue.length) return -1;
    const seg = this.rcvQueue[0];
    if (seg.frg === 0) return seg.data.length;
    if (this.rcvQueue.length < seg.frg + 1) return -1;
    let n = 0;
    for (const s of this.rcvQueue) {
      n += s.data.length;
      if (s.frg === 0) break;
    }
    return n;
  }

  recv(buffer) {
    const peek = this.peekSize();
    if (peek < 0) return -1;
    if (buffer.length < peek) return -2;
    let n = 0;
    while (this.rcvQueue.length) {
      const seg = this.rcvQueue.shift();
      buffer.set(seg.data, n);
      n += seg.data.length;
      if (seg.frg === 0) break;
    }
    this.moveRcv();
    return n;
  }

  moveRcv() {
    this.rcvBuf.sort((a, b) => timediff(a.sn, b.sn));
    while (this.rcvBuf.length) {
      const seg = this.rcvBuf[0];
      if (seg.sn === this.rcvNxt && this.rcvQueue.length < this.rcvWnd) {
        this.rcvBuf.shift();
        this.rcvQueue.push(seg);
        this.rcvNxt = (this.rcvNxt + 1) >>> 0;
      } else break;
    }
  }

  input(data) {
    const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (u8.length < KCP_OVERHEAD) return -1;
    let off = 0;
    const prevUna = this.sndUna;
    while (off + KCP_OVERHEAD <= u8.length) {
      const v = new DataView(u8.buffer, u8.byteOffset + off);
      const conv = v.getUint32(0, true);
      const cmd = u8[off + 4];
      const frg = u8[off + 5];
      const wnd = v.getUint16(6, true);
      const ts = v.getUint32(8, true);
      const sn = v.getUint32(12, true);
      const una = v.getUint32(16, true);
      const len = v.getUint32(20, true);
      off += KCP_OVERHEAD;
      if (conv !== this.conv) return -1;
      if (off + len > u8.length) return -2;
      if (![KCP_CMD_ACK, KCP_CMD_PUSH, KCP_CMD_WASK, KCP_CMD_WINS].includes(cmd)) return -3;
      this.rmtWnd = wnd;
      this.parseUna(una);
      this.shrinkBuf();
      if (cmd === KCP_CMD_ACK) {
        this.parseAck(sn);
        this.shrinkBuf();
        this.parseFastack(sn, ts);
        if (timediff(nowMs(), ts) >= 0) this.updateAck(timediff(nowMs(), ts));
      } else if (cmd === KCP_CMD_PUSH) {
        if (timediff(sn, this.rcvNxt + this.rcvWnd) < 0) {
          this.acklist.push({ sn, ts });
          if (timediff(sn, this.rcvNxt) >= 0) {
            this.parseData({ conv, cmd, frg, wnd, ts, sn, una, data: u8.subarray(off, off + len).slice() });
          }
        }
      } else if (cmd === KCP_CMD_WASK) {
        this.probe |= 2;
      }
      off += len;
    }
    if (this.nocwnd === 0 && timediff(this.sndUna, prevUna) > 0 && this.cwnd < this.rmtWnd) {
      this.cwnd = Math.min(this.cwnd + 1, this.rmtWnd) || 1;
    }
    return 0;
  }

  parseUna(una) {
    while (this.sndBuf.length && timediff(una, this.sndBuf[0].sn) > 0) this.sndBuf.shift();
  }

  parseAck(sn) {
    if (timediff(sn, this.sndUna) < 0 || timediff(sn, this.sndNxt) >= 0) return;
    for (const seg of this.sndBuf) {
      if (sn === seg.sn) {
        seg.acked = 1;
        break;
      }
      if (timediff(sn, seg.sn) < 0) break;
    }
  }

  parseFastack(sn) {
    if (timediff(sn, this.sndUna) < 0 || timediff(sn, this.sndNxt) >= 0) return;
    for (const seg of this.sndBuf) {
      if (timediff(sn, seg.sn) < 0) break;
      if (sn !== seg.sn) seg.fastack = (seg.fastack || 0) + 1;
    }
  }

  parseData(newseg) {
    const sn = newseg.sn;
    if (timediff(sn, this.rcvNxt + this.rcvWnd) >= 0 || timediff(sn, this.rcvNxt) < 0) return;
    if (this.rcvBuf.some((s) => s.sn === sn)) return;
    this.rcvBuf.push(newseg);
    this.moveRcv();
  }

  shrinkBuf() {
    this.sndBuf = this.sndBuf.filter((s) => !s.acked);
    this.sndUna = this.sndBuf.length ? this.sndBuf[0].sn : this.sndNxt;
  }

  updateAck(rtt) {
    if (this.rxSrtt === 0) {
      this.rxSrtt = rtt;
      this.rxRttvar = rtt >> 1;
    } else {
      let delta = rtt - this.rxSrtt;
      this.rxSrtt += delta >> 3;
      if (delta < 0) delta = -delta;
      this.rxRttvar += (delta - this.rxRttvar) >> 2;
    }
    const rto = this.rxSrtt + Math.max(this.interval, this.rxRttvar << 2);
    this.rxRto = Math.min(Math.max(this.rxMinrto, rto), 60000);
  }

  update() {
    const current = nowMs();
    if (!this.updated) {
      this.updated = 1;
      this.tsFlush = current;
    }
    if (timediff(current, this.tsFlush) >= 0) {
      this.tsFlush = current + this.interval;
      this.flush();
    }
  }

  flush() {
    const current = nowMs();
    const chunks = [];
    const push = (bytes) => {
      chunks.push(bytes);
    };
    const una = this.rcvNxt;
    const wnd = this.wndUnused();
    for (const ack of this.acklist) {
      push(encodeSeg({ conv: this.conv, cmd: KCP_CMD_ACK, frg: 0, wnd, ts: ack.ts, sn: ack.sn, una, data: null }));
    }
    this.acklist = [];
    if (this.probe & 2) {
      push(encodeSeg({ conv: this.conv, cmd: KCP_CMD_WINS, frg: 0, wnd, ts: current, sn: 0, una, data: null }));
    }
    this.probe = 0;

    let cwnd = Math.min(this.sndWnd, this.rmtWnd);
    if (this.nocwnd === 0 && this.cwnd) cwnd = Math.min(this.cwnd, cwnd);
    if (this.nocwnd) cwnd = Math.min(this.sndWnd, this.rmtWnd);

    while (timediff(this.sndNxt, this.sndUna + cwnd) < 0 && this.sndQueue.length) {
      const seg = this.sndQueue.shift();
      seg.conv = this.conv;
      seg.cmd = KCP_CMD_PUSH;
      seg.wnd = wnd;
      seg.ts = current;
      seg.sn = this.sndNxt;
      seg.una = una;
      seg.xmit = 0;
      seg.rto = this.rxRto;
      seg.resendts = current + this.rxRto;
      seg.fastack = 0;
      this.sndBuf.push(seg);
      this.sndNxt = (this.sndNxt + 1) >>> 0;
    }

    const resent = this.fastresend > 0 ? this.fastresend : 0xffffffff;
    for (const seg of this.sndBuf) {
      if (seg.acked) continue;
      let need = false;
      if (seg.xmit === 0) {
        need = true;
        seg.xmit = 1;
        seg.rto = this.rxRto;
        seg.resendts = current + seg.rto;
      } else if (seg.fastack >= resent) {
        need = true;
        seg.fastack = 0;
        seg.xmit++;
        seg.resendts = current + seg.rto;
      } else if (timediff(current, seg.resendts) >= 0) {
        need = true;
        seg.xmit++;
        seg.rto += this.nodelay ? (this.rxRto >> 1) : this.rxRto;
        seg.resendts = current + seg.rto;
      }
      if (need) {
        seg.ts = current;
        seg.wnd = wnd;
        seg.una = una;
        push(encodeSeg(seg));
      }
    }

    if (!chunks.length) return;
    // Concatenate into MTU-sized datagrams.
    let buf = new Uint8Array(0);
    const emit = (b) => {
      if (b.length) this.output(b);
    };
    for (const c of chunks) {
      if (buf.length + c.length > this.mtu) {
        emit(buf);
        buf = c;
      } else {
        const n = new Uint8Array(buf.length + c.length);
        n.set(buf);
        n.set(c, buf.length);
        buf = n;
      }
    }
    emit(buf);
  }
}

const LEN_PREFIX = 4;
const MAX_MSG = 8 * 1024 * 1024;

/** Length-prefixed stream over KCP, matching vp8channel kcpRuntime. */
export class KcpStream {
  constructor(conv, onDatagram) {
    this.kcp = new KCP(conv, (buf) => onDatagram(buf));
    this.kcp.setMtu(KCP_MTU);
    this.kcp.noDelay(1, 5, 2, 1);
    this.kcp.wndSize(4096, 4096);
    this.kcp.setStream(true);
    this.rx = new Uint8Array(0);
    this.onMessage = null;
    this.recvBytes = 0;
    this.drainBuf = new Uint8Array(64 * 1024);
  }

  input(datagram) {
    const result = this.kcp.input(datagram);
    if (result !== 0) return result;
    this.kcp.flush();
    this.drainRecv();
    return 0;
  }

  send(msg) {
    const u8 = msg instanceof Uint8Array ? msg : new Uint8Array(msg);
    if (u8.length > MAX_MSG) throw new Error('kcp: message too large');
    const framed = new Uint8Array(LEN_PREFIX + u8.length);
    new DataView(framed.buffer).setUint32(0, u8.length);
    framed.set(u8, LEN_PREFIX);
    this.kcp.send(framed);
    this.kcp.flush();
  }

  update() {
    this.kcp.update();
    this.drainRecv();
  }

  drainRecv() {
    const tmp = this.drainBuf;
    const chunks = [];
    let total = 0;
    for (;;) {
      const n = this.kcp.recv(tmp);
      if (n < 0) break;
      chunks.push(tmp.slice(0, n));
      total += n;
      this.recvBytes += n;
    }
    if (total > 0) {
      if (this.rx.length === 0 && chunks.length === 1) {
        this.rx = chunks[0];
      } else {
        const next = new Uint8Array(this.rx.length + total);
        next.set(this.rx, 0);
        let off = this.rx.length;
        for (const c of chunks) {
          next.set(c, off);
          off += c.length;
        }
        this.rx = next;
      }
    }
    while (this.rx.length >= LEN_PREFIX) {
      const size = new DataView(this.rx.buffer, this.rx.byteOffset, this.rx.byteLength).getUint32(0);
      if (size === 0) {
        this.rx = this.rx.subarray(LEN_PREFIX);
        continue;
      }
      if (size > MAX_MSG) {
        this.rx = new Uint8Array(0);
        return;
      }
      if (this.rx.length < LEN_PREFIX + size) break;
      const msg = this.rx.subarray(LEN_PREFIX, LEN_PREFIX + size).slice();
      this.rx = this.rx.subarray(LEN_PREFIX + size);
      this.onMessage?.(msg);
    }
  }
}
