import {
  EPOCH_HDR_LEN,
  CONTROL_EPOCH_FLAG,
  buildEpochHeader,
  parseEpochHeader,
  splitKCPPayload,
  appendBatchPacket,
  hexU32,
  KCP_BATCH_MAGIC,
  KCP_WIRE_CRC_LEN,
  appendKcpChecksum,
  stripKcpChecksum,
} from './vp8-wire.js';
import { matchBindingToken, formatBindingLog } from './binding.js';
import { KcpStream, KCP_CONV, KCP_MTU, KCP_CMD_ACK } from './kcp.js';
import { newKeySet, hexToBytes, AAD_DATA, AAD_CONTROL } from './olc2.js';
import { SmuxClient } from './smux.js';
import { clientHandshake, sendPing, sendPong, readControl, PING, PONG } from './handshake.js';
import { buildHttpRequest, readHttpResponse, prepareFulfill, HTTP_BODY_IDLE_MS } from './http-client.js';
import { encodeTunnelConnect, CONNECT_ACK_OK } from './socks.js';
import { wrapTls } from './tls.js';
import {
  BufferedStream,
  ConnPool,
  Semaphore,
  HostGate,
  poolKey,
  canPoolResponse,
  canWarmHost,
  withTimeout,
  PROXY_INFLIGHT,
  CONNECT_TIMEOUT_MS,
  TLS_TIMEOUT_MS,
  HTTP_HEADER_TIMEOUT_MS,
} from './pool.js';
import { CONFIG } from './config.js';

const MAX_CONTROL_PACKETS = 2;
const MAX_DATA_PACKETS = CONFIG.maxDataPackets || 128;
const MAX_DATA_BYTES = 58 * 1024;
const MAX_CONTROL_QUEUE = 256;
const MAX_DATA_QUEUE = 4096;
const DATA_KEEP_BULK_MS = 2000;

export class Tunnel {
  constructor(log) {
    this.log = log;
    this.token = 0;
    this.tokenOk = false;
    this.localEpoch = (crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff) >>> 0;
    if (this.localEpoch === 0) this.localEpoch = 1;
    this.peerEpoch = 0;
    this.dataDst = 0;
    this.controlDst = 0;
    this.dataOut = [];
    this.controlOut = [];
    this.lastKeep = 0;
    this.lastDataKeep = performance.now();
    this.inKeepLog = 0;
    this.kcpOutLogged = false;
    this.ready = false;
    this.handshakeOk = false;
    this.pingOk = false;
    this.seq = 0;
    this.unackedPings = 0;
    this.consecutiveConnectTimeouts = 0;
    this.consecutiveControl = 0;
    this.recvFrom = new Map();
    this.stats = { samples: 0, datagrams: 0, queueDrops: 0, controlIn: 0, controlAcks: 0, wireCrcErrors: 0 };
    this.handshakeRetryTimer = null;
  }

  async start(cfg) {
    this.cfg = cfg;
    this.psk = hexToBytes(cfg.keyHex);
    this.controlKeys = await newKeySet(this.psk, 'client');
    this.dataKeys = await newKeySet(this.psk, 'client');
    const guessed = matchBindingToken(cfg, null);
    this.token = guessed.local?.token || 0;
    this.tokenOk = Boolean(this.token);
    this.log(formatBindingLog(guessed));
    if (this.tokenOk) this.onFlag?.({ tokenOk: true });

    this.data = new KcpStream(KCP_CONV, (dgram) => this.onKcpOut('data', dgram));
    this.control = new KcpStream(KCP_CONV, (dgram) => this.onKcpOut('ctrl', dgram));
    this.dataMux = new Mux(this.data, this.dataKeys, AAD_DATA, this.log);
    this.controlMux = new Mux(this.control, this.controlKeys, AAD_CONTROL, this.log);
    this.smux = new SmuxClient(this.controlMux);
    this.dataSmux = null;
    this.dataSmuxReady = new Promise((resolve) => {
      this._resolveDataSmux = resolve;
    });
    this.pool = new ConnPool({
      maxPerHost: CONFIG.poolMaxPerHost,
      maxTotal: CONFIG.poolMaxTotal,
      idleMs: CONFIG.poolIdleMs,
      log: (m) => this.log(m),
    });
    this.mediaSem = new Semaphore(CONFIG.mediaSemConcurrency || 16, (m) => this.log(`media.${m}`));
    this.subSem = new Semaphore(CONFIG.subSemConcurrency || 48, (m) => this.log(`sub.${m}`));
    this.hostGate = new HostGate(CONFIG.hostGateConcurrency || 8);
    this.imageGate = new HostGate(CONFIG.imageGateConcurrency || 6);
    this.unackedPings = 0;
    this.consecutiveConnectTimeouts = 0;
    this.warmHosts = new Set();
    this.timer = setInterval(() => {
      this.data.update();
      this.control.update();
    }, 5);
    this.ready = true;
    this.log(`tunnel.ready epoch=${hexU32(this.localEpoch)} control=${hexU32(this.localControlEpoch)} token=${hexU32(this.token)} carrier=every-tick maxPackets=${MAX_DATA_PACKETS} maxSample=${MAX_DATA_BYTES} kcpWire=crc32c`);
  }

  stop() {
    clearInterval(this.timer);
    clearInterval(this.pingTimer);
    clearTimeout(this.handshakeTimer);
    clearTimeout(this.handshakeRetryTimer);
    this.ready = false;
    this.dataOut.length = 0;
    this.controlOut.length = 0;
    this.pool?.clear();
    this.warmHosts?.clear();
    this.dataSmux?.closeAll();
    this.smux?.closeAll();
    this.dataSmux = null;
    this.dataSmuxReady = new Promise((resolve) => {
      this._resolveDataSmux = resolve;
    });
  }

  async reconnect() {
    if (this.reconnecting || !this.ready) return;
    this.reconnecting = true;
    this.log('tunnel.reconnect: tearing down dead session and resetting peer');

    clearInterval(this.pingTimer);
    clearTimeout(this.handshakeTimer);
    clearTimeout(this.handshakeRetryTimer);

    this.handshakeOk = false;
    this.pingOk = false;
    this.hsStarted = false;
    this.peerEpoch = 0;
    this.dataDst = 0;
    this.controlDst = 0;
    this.unackedPings = 0;
    this.consecutiveConnectTimeouts = 0;

    this.localEpoch = (crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff) >>> 0;
    if (this.localEpoch === 0) this.localEpoch = 1;
    if (this.psk) {
      this.controlKeys = await newKeySet(this.psk, 'client');
      this.dataKeys = await newKeySet(this.psk, 'client');
    }

    this.pool?.clear();
    this.warmHosts?.clear();

    try { this.dataSmux?.closeAll(); } catch {}
    try { this.smux?.closeAll(); } catch {}
    this.dataSmux = null;
    this.dataSmuxReady = new Promise((resolve) => {
      this._resolveDataSmux = resolve;
    });

    this.dataOut.length = 0;
    this.controlOut.length = 0;

    this.data = new KcpStream(KCP_CONV, (dgram) => this.onKcpOut('data', dgram));
    this.control = new KcpStream(KCP_CONV, (dgram) => this.onKcpOut('ctrl', dgram));
    this.dataMux = new Mux(this.data, this.dataKeys, AAD_DATA, this.log);
    this.controlMux = new Mux(this.control, this.controlKeys, AAD_CONTROL, this.log);
    this.smux = new SmuxClient(this.controlMux);

    this.onFlag?.({ handshakeOk: false, pingOk: false });
    this.reconnecting = false;
    this.log('tunnel.reconnect: restarting handshake');
    await this.startHandshake();
  }

  handleInbound(frame, opts = {}) {
    if (!this.ready) return;
    const probe = Boolean(opts.probe);
    const u8 = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
    if (u8.byteLength < EPOCH_HDR_LEN) return;
    const hdr = parseEpochHeader(u8);
    if (!hdr) {
      this.log(`vp8.in crc=bad bytes=${u8.byteLength}`);
      return;
    }
    this.inCount = (this.inCount || 0) + 1;
    const payloadLen = u8.byteLength - EPOCH_HDR_LEN;
    const tag = probe ? 'vp8.in t=2' : 'vp8.in t=1';
    const interesting = payloadLen > 0 || !hdr.ok;
    const nowMs = performance.now();
    const keepLog =
      interesting ||
      this.inKeepLog < 15 ||
      nowMs - (this.lastKeepInLog || 0) >= 1000;
    if (keepLog) {
      this.inKeepLog = (this.inKeepLog || 0) + 1;
      this.lastKeepInLog = nowMs;
      this.log(
        `${tag} token=${hexU32(hdr.token)} src=${hexU32(hdr.src)} dst=${hexU32(hdr.dst)} bytes=${u8.byteLength} payload=${payloadLen} crc=${hdr.ok ? 'ok' : 'bad'}`,
      );
    }
    if (payloadLen > 0 && !this.loggedPayloadHex) {
      this.loggedPayloadHex = true;
      const hex = [...u8.subarray(0, Math.min(48, u8.byteLength))]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(' ');
      this.log(`${tag} first-payload hex=${hex}`);
    }
    if (probe) return;
    if (!hdr.ok) return;

    if (hdr.token !== this.token) {
      const result = matchBindingToken(this.cfg, hdr.token);
      this.log(formatBindingLog(result));
      this.token = result.match?.token ?? hdr.token;
      this.tokenOk = true;
      this.log(`token wire=${hexU32(hdr.token)} stamp=${hexU32(this.token)} via=${result.match?.label || 'latch'}`);
      this.onFlag?.({ tokenOk: true });
      if (!this.handshakeOk && !this.hsStarted) {
        void this.startHandshake();
      }
    }

    const src = hdr.src;
    if (src === this.localEpoch || src === this.localControlEpoch) return;

    if (this.handshakeOk && (src & CONTROL_EPOCH_FLAG) === 0 && src !== this.peerEpoch) {
      if (this.unackedPings >= 2 || (this.stats.dataAcks === 0 && this.stats.dataIn === 0)) {
        this.log(`peer.epochChanged old=${hexU32(this.peerEpoch)} new=${hexU32(src)} reconnecting...`);
        void this.reconnect();
        return;
      }
    }

    const packets = splitKCPPayload(hdr.payload);
    for (const wire of packets) {
      const pkt = stripKcpChecksum(wire);
      if (!pkt) {
        this.stats.wireCrcErrors++;
        if (this.stats.wireCrcErrors <= 5 || this.stats.wireCrcErrors % 100 === 0) {
          this.log(`vp8.kcp.crc bad src=${hexU32(src)} wire=${wire.length} total=${this.stats.wireCrcErrors}`);
        }
        continue;
      }
      if (!pkt.length) continue;
      this.kcpRecvN = (this.kcpRecvN || 0) + 1;
      if (this.kcpRecvN <= 8 || this.kcpRecvN % 20 === 0 || pkt.length >= 400) {
        this.log(`kcp.recv from=${hexU32(src)} n=${pkt.length} wire=${wire.length} crc32c=ok`);
      }
      this.recvFrom.set(src, (this.recvFrom.get(src) || 0) + pkt.length);
      if (!this.acceptsDst(hdr.dst)) continue;
      const isCtrl = (src & CONTROL_EPOCH_FLAG) !== 0;
      if (isCtrl) {
        if (!this.acceptsControl(src, hdr.dst)) continue;
        const result = this.control.input(pkt);
        if (result !== 0) {
          this.log(`kcp.input plane=ctrl error=${result} n=${pkt.length}`);
          continue;
        }
        this.stats.controlIn++;
        for (let off = 0; off + 24 <= pkt.length;) {
          const v = new DataView(pkt.buffer, pkt.byteOffset + off, pkt.length - off);
          if (pkt[off + 4] === KCP_CMD_ACK) {
            this.stats.controlAcks++;
            if (this.stats.controlAcks <= 5) {
              this.log(`kcp.ack plane=ctrl sn=${v.getUint32(12, true)} una=${v.getUint32(16, true)}`);
            }
          }
          off += 24 + v.getUint32(20, true);
        }
      } else {
        if (!this.handshakeOk) continue;
        if (src !== this.peerEpoch) continue;
        const result = this.data.input(pkt);
        if (result !== 0) {
          this.log(`kcp.input plane=data error=${result} n=${pkt.length}`);
          continue;
        }
        this.stats.dataIn = (this.stats.dataIn || 0) + 1;
        for (let off = 0; off + 24 <= pkt.length;) {
          const v = new DataView(pkt.buffer, pkt.byteOffset + off, pkt.length - off);
          if (pkt[off + 4] === KCP_CMD_ACK) {
            this.stats.dataAcks = (this.stats.dataAcks || 0) + 1;
          }
          off += 24 + v.getUint32(20, true);
        }
      }
    }
  }

  acceptsDst(dst) {
    if (dst === 0) return true;
    return dst === this.localEpoch || dst === this.localControlEpoch;
  }

  get localControlEpoch() {
    return (this.localEpoch | CONTROL_EPOCH_FLAG) >>> 0;
  }

  acceptsControl(src, dst) {
    // Native srv addresses replies to our control epoch even during bootstrap.
    // Broadcast HELLOs belong to other clients and would corrupt this KCP stream.
    if (dst !== this.localControlEpoch) return false;
    if (this.handshakeOk) {
      return src === ((this.peerEpoch | CONTROL_EPOCH_FLAG) >>> 0);
    }
    return true;
  }

  onKcpOut(plane, dgram) {
    if (dgram.length > KCP_MTU) throw new Error(`kcp output exceeds MTU: ${dgram.length}`);
    const sn = dgram.length >= 24 ? new DataView(dgram.buffer, dgram.byteOffset, 24).getUint32(12, true) : 0;
    if (!this.kcpOutLogged && dgram.length >= 24) {
      this.kcpOutLogged = true;
      const conv = new DataView(dgram.buffer, dgram.byteOffset, 24).getUint32(0, true);
      const cmd = dgram[4];
      const hdr = [...dgram.subarray(0, 24)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
      const body = [...dgram.subarray(24, Math.min(dgram.length, 24 + 64))]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(' ');
      this.log(`kcp.out plane=${plane} conv=${hexU32(conv)} cmd=${cmd} sn=${sn} n=${dgram.length} hdr=${hdr}`);
      this.log(`kcp.out body=${body}`);
    } else if (plane === 'ctrl' && dgram.length >= 24) {
      this.log(`kcp.out plane=ctrl cmd=${dgram[4]} sn=${sn} n=${dgram.length}`);
    }
    const queue = plane === 'ctrl' ? this.controlOut : this.dataOut;
    const limit = plane === 'ctrl' ? MAX_CONTROL_QUEUE : MAX_DATA_QUEUE;
    if (queue.length >= limit) {
      // A paused encoder must not accumulate unlimited retransmissions.
      // KCP owns the reliable send buffer and will retry dropped datagrams.
      queue.shift();
      this.stats.queueDrops++;
      if (this.stats.queueDrops === 1 || this.stats.queueDrops % 100 === 0) {
        this.log(`vp8.queue drop=${this.stats.queueDrops} plane=${plane} limit=${limit}`);
      }
    }
    queue.push(dgram);
  }

  emitDataKeepalive(chromeType) {
    this.lastDataKeep = performance.now();
    this.lastKeep = this.lastDataKeep;
    const hdr = buildEpochHeader(this.token, this.localEpoch, this.dataDst);
    this.dataKeepN = (this.dataKeepN || 0) + 1;
    if (this.dataKeepN <= 5 || this.dataKeepN % 10 === 0) {
      this.log(`vp8.out chromeType=${chromeType} stuffed=keep len=36 src=${hexU32(this.localEpoch)}`);
    }
    return hdr.buffer.slice(hdr.byteOffset, hdr.byteOffset + hdr.byteLength);
  }

  buildSample(opts = {}) {
    if (!this.ready || !this.tokenOk) return null;
    const now = performance.now();
    const chromeType = opts.frameType || (opts.keyframe === false ? 'delta' : 'key');
    // Bare data keepalives refresh the native peer even under continuous control load.
    if (now - this.lastDataKeep >= DATA_KEEP_BULK_MS) {
      this.consecutiveControl = 0;
      return this.emitDataKeepalive(chromeType);
    }
    // Fair scheduling: prevent control plane retransmissions from starving bulk data and ACKs.
    // If control has sent 2 consecutive samples and data has queued packets, force data sample.
    const forceData = this.consecutiveControl >= 2 && this.dataOut.length > 0;
    if (!forceData && this.controlOut.length) {
      this.consecutiveControl += 1;
      return this.packSample(this.localControlEpoch, this.controlDst, this.controlOut, chromeType, {
        maxPackets: MAX_CONTROL_PACKETS,
        maxBytes: 2852,
      });
    }
    if (this.dataOut.length) {
      this.consecutiveControl = 0;
      return this.packSample(this.localEpoch, this.dataDst, this.dataOut, chromeType, {
        maxPackets: MAX_DATA_PACKETS,
        maxBytes: MAX_DATA_BYTES,
      });
    }
    if (this.controlOut.length) {
      this.consecutiveControl += 1;
      return this.packSample(this.localControlEpoch, this.controlDst, this.controlOut, chromeType, {
        maxPackets: MAX_CONTROL_PACKETS,
        maxBytes: 2852,
      });
    }
    this.consecutiveControl = 0;
    return this.emitDataKeepalive(chromeType);
  }

  packSample(src, dst, queue, chromeType, { maxPackets = MAX_DATA_PACKETS, maxBytes = MAX_DATA_BYTES } = {}) {
    let byteTotal = EPOCH_HDR_LEN + 4;
    const packets = [];
    while (queue.length && packets.length < maxPackets) {
      const nextLen = queue[0].length + KCP_WIRE_CRC_LEN + 2;
      if (byteTotal + nextLen > maxBytes && packets.length > 0) break;
      const raw = queue.shift();
      byteTotal += nextLen;
      packets.push(appendKcpChecksum(raw));
    }
    if (!packets.length) return this.emitDataKeepalive(chromeType);

    const hdr = buildEpochHeader(this.token, src, dst);
    let sample;
    if (packets.length === 1) {
      sample = new Uint8Array(EPOCH_HDR_LEN + packets[0].length);
      sample.set(hdr, 0);
      sample.set(packets[0], EPOCH_HDR_LEN);
    } else {
      sample = new Uint8Array(EPOCH_HDR_LEN + 4);
      sample.set(hdr, 0);
      sample.set(KCP_BATCH_MAGIC, EPOCH_HDR_LEN);
      for (const packet of packets) sample = appendBatchPacket(sample, packet);
    }
    this.stats.samples++;
    this.stats.datagrams += packets.length;
    this.log(
      `vp8.out chromeType=${chromeType} stuffed=kcp n=${packets.length} len=${sample.length} src=${hexU32(src)} dst=${hexU32(dst)} queued=${queue.length} crc32c=ok`,
    );
    return sample.buffer;
  }

  logStats() {
    if (!this.ready) return;
    const kcp = this.control.kcp;
    this.log(
      `kcp.stats plane=ctrl in=${this.stats.controlIn} ack=${this.stats.controlAcks} una=${kcp.sndUna} next=${kcp.sndNxt} pending=${kcp.sndBuf.length} queued=${this.controlOut.length} samples=${this.stats.samples} datagrams=${this.stats.datagrams} drops=${this.stats.queueDrops} crcErrors=${this.stats.wireCrcErrors}`,
    );
    const dataKcp = this.data.kcp;
    this.log(
      `kcp.stats plane=data in=${this.stats.dataIn || 0} ack=${this.stats.dataAcks || 0} una=${dataKcp.sndUna} next=${dataKcp.sndNxt} pending=${dataKcp.sndBuf.length} queued=${this.dataOut.length} activeStreams=${this.dataSmux?.streams?.size || 0}`,
    );
  }

  async startHandshake() {
    if (this.hsStarted || !this.ready || !this.tokenOk) return;
    this.hsStarted = true;
    clearTimeout(this.handshakeRetryTimer);
    this.handshakeTimer = setTimeout(() => {
      this.log('handshake.pending after=15s; capture extension and srv logs for this session');
      this.logStats();
    }, 15_000);
    try {
      const stream = this.smux.openStream();
      this.controlStream = stream;
      this.log('handshake.hello');
      const deviceId = this.cfg?.deviceId || `chrome-${crypto.randomUUID().slice(0, 8)}`;
      const w = await clientHandshake(stream, deviceId);
      if (!this.ready) return;
      const peer = w.peerId || '';
      this.confirmPeer(peer);
      this.log(`handshake.welcome session=${w.sessionId || ''} peer=0x${peer}`);
      this.handshakeOk = true;
      this.dataSmux = new SmuxClient(this.dataMux);
      this._resolveDataSmux?.();
      this.log('dataSmux.ready');
      this.onFlag?.({ handshakeOk: true, peerId: peer, dataSmux: true });
      this.seq += 1;
      sendPing(stream, this.seq);
      this.pingLoop(stream);
    } catch (err) {
      this.log(`handshake.error ${err.message}`);
      this.hsStarted = false;
      if (this.ready && !this.handshakeOk) {
        clearTimeout(this.handshakeRetryTimer);
        this.handshakeRetryTimer = setTimeout(() => {
          if (this.ready && !this.handshakeOk && !this.hsStarted) {
            this.log('handshake.retry: auto-retrying handshake after error');
            void this.startHandshake();
          }
        }, 2000);
      }
    } finally {
      clearTimeout(this.handshakeTimer);
    }
  }

  confirmPeer(peerId) {
    if (!/^[0-7][0-9a-f]{7}$/i.test(peerId) || Number.parseInt(peerId, 16) === 0) {
      throw new Error('welcome peer_id must be a nonzero data epoch (8 hex digits)');
    }
    const epoch = Number.parseInt(peerId, 16);
    this.peerEpoch = epoch >>> 0;
    this.dataDst = this.peerEpoch;
    this.controlDst = (this.peerEpoch | CONTROL_EPOCH_FLAG) >>> 0;
    this.log(`confirmPeer dst=${hexU32(this.dataDst)}`);
  }

  async connectTCP(host, port) {
    await this.dataSmuxReady;
    if (!this.dataSmux) throw new Error('data smux not ready');
    const stream = this.dataSmux.openStream();
    const payload = encodeTunnelConnect(host, port);
    this.log(`socks.connect ${host}:${port} sid=${stream.sid}`);
    try {
      stream.write(payload);
      const ack = await withTimeout(
        stream.readFull(1),
        CONNECT_TIMEOUT_MS,
        `connect ${host}:${port}`,
      );
      if (ack[0] !== CONNECT_ACK_OK) {
        throw new Error(`connect ack ${ack[0]} for ${host}:${port}`);
      }
      this.consecutiveConnectTimeouts = 0;
      this.log(`socks.connected ${host}:${port} sid=${stream.sid}`);
      return stream;
    } catch (err) {
      stream.close();
      if (String(err?.message || '').includes('timeout')) {
        this.consecutiveConnectTimeouts = (this.consecutiveConnectTimeouts || 0) + 1;
        if (this.consecutiveConnectTimeouts >= 3 && this.handshakeOk) {
          this.log(`socks.connect repeated timeouts count=${this.consecutiveConnectTimeouts} reconnecting...`);
          void this.reconnect();
        }
      }
      throw err;
    }
  }

  async httpProxy(req) {
    const parsed = new URL(req.url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('only http(s)');
    }
    const https = parsed.protocol === 'https:';
    const port = parsed.port ? Number(parsed.port) : https ? 443 : 80;
    const key = poolKey(parsed.hostname, port, https);
    const isMedia = isMediaUrl(req.url, parsed, req.headers);
    const isImage = !isMedia && isImageUrl(parsed.pathname, parsed.hostname);
    const sem = isMedia ? this.mediaSem : this.subSem;
    const gate = isImage ? this.imageGate : this.hostGate;
    await sem.acquire();
    try {
      // Warm-socket fast-path: if an idle keep-alive socket is already available in the pool,
      // take it immediately and execute in parallel, bypassing the host gate queue.
      const warmStream = this.pool.take(key);
      if (warmStream) {
        try {
          return await this.httpProxyInner(req, {
            parsed,
            https,
            port,
            key,
            isMedia,
            stream: warmStream,
            fromPool: true,
            inGate: false,
          });
        } catch (err) {
          if (isStalePoolError(err)) {
            this.log(`pool.retry ${key} (warm fast-path died: ${err.message}, falling back to gated fresh connect)`);
            return await gate.run(key, () =>
              this.httpProxyInner(req, {
                parsed,
                https,
                port,
                key,
                isMedia,
                forceFresh: true,
                inGate: true,
              }),
            );
          }
          throw err;
        }
      }
      return await gate.run(key, () =>
        this.httpProxyInner(req, { parsed, https, port, key, isMedia, inGate: true }),
      );
    } finally {
      sem.release();
    }
  }

  async httpProxyInner(
    { method, url, headers, body },
    {
      parsed,
      https,
      port,
      key,
      isMedia,
      stream = null,
      fromPool = false,
      forceFresh = false,
      inGate = false,
    },
  ) {
    const path = `${parsed.pathname || '/'}${parsed.search || ''}`;
    const connection = 'keep-alive';
    if (!stream && !forceFresh) {
      stream = this.pool.take(key);
      if (stream) fromPool = true;
    }
    if (!stream) {
      this.log(`pool.miss ${key}`);
      let tcp = await this.connectTCP(parsed.hostname, port);
      tcp = new BufferedStream(tcp);
      if (https) {
        try {
          stream = await withTimeout(
            wrapTls(tcp, { sni: parsed.hostname, log: (m) => this.log(m) }),
            TLS_TIMEOUT_MS,
            'tls',
          );
        } catch (err) {
          tcp.close();
          throw err;
        }
        stream = new BufferedStream(stream);
      } else {
        stream = tcp;
      }
    }
    try {
      const wire = buildHttpRequest({
        method: method || 'GET',
        path,
        host: parsed.host,
        headers,
        body,
        connection,
      });
      this.log(`http.write ${method || 'GET'} ${url} n=${wire.length} conn=${connection}`);
      stream.write(wire);
      const res = await readHttpResponse(stream, {
        method: method || 'GET',
        headerTimeoutMs: fromPool ? 3_000 : HTTP_HEADER_TIMEOUT_MS,
        idleTimeoutMs: HTTP_BODY_IDLE_MS,
        isMedia,
        onProgress: (n) => this.log(`http.body n=${n}`),
        onHeaders: (parsedHead, rawHead) => {
          const n = Math.min(32, rawHead.length);
          const hex = [...rawHead.subarray(0, n)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
          const cl = Number.isFinite(parsedHead.contentLength) ? parsedHead.contentLength : '-';
          this.log(
            `http.head ${parsedHead.status} n=${rawHead.length} cl=${cl} chunked=${parsedHead.chunked} hex=${hex}`,
          );
        },
      });
      this.log(`http ${method || 'GET'} ${url} → ${res.status} body=${res.body.length}`);
      if (url.includes('videoplayback') || url.includes('/player')) {
        const preview = new TextDecoder('latin1').decode(res.body.subarray(0, 200)).replace(/[\r\n\x00-\x1f]/g, ' ');
        const hex = [...res.body.subarray(0, 24)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
        this.log(`http.body.peek ${url.slice(0, 60)}: n=${res.body.length} hex=${hex} txt=${preview}`);
      }
      if (canWarmHost(res)) this.warmHosts.add(key);
      else this.warmHosts.delete(key);
      if (canPoolResponse({ ...res, connection })) {
        if (res.leftover?.length) stream.pushBack(res.leftover);
        this.pool.put(key, stream);
        stream = null;
      } else {
        this.log(
          `pool.skip ${key} body=${res.body.length} leftover=${res.leftover?.length || 0} keep=${res.keepAlive}`,
        );
      }
      let out = res;
      try {
        out = await prepareFulfill(res);
      } catch (err) {
        throw new Error(`http.decode fail ${err.message}`);
      }
      if (out.decoded) this.log(`http.decode ${out.decoded} ${out.rawLength} → ${out.body.length}`);
      if (url.includes('/player')) {
        try {
          const jsonStr = new TextDecoder('utf-8').decode(out.body);
          const parsedJson = JSON.parse(jsonStr);
          const playability = parsedJson.playabilityStatus;
          const sub = playability?.errorScreen?.playerErrorMessageRenderer?.subreason?.simpleText || '';
          this.log(`youtube.player status=${playability?.status} reason="${playability?.reason || ''}" subreason="${sub}"`);
          this.log(`youtube.playability ${JSON.stringify(playability).slice(0, 300)}`);
        } catch {
          // ignore
        }
      }
      return out;
    } catch (err) {
      if (fromPool && isStalePoolError(err)) {
        stream?.close();
        stream = null;
        if (!inGate) {
          throw err;
        }
        this.log(`pool.retry ${key} (stale pooled connection died: ${err.message}, retrying fresh)`);
        return await this.httpProxyInner(
          { method, url, headers, body },
          { parsed, https, port, key, isMedia, forceFresh: true, inGate: true },
        );
      }
      this.log(`http.proxy error ${method || 'GET'} ${url} — ${err.message}`);
      throw err;
    } finally {
      stream?.close();
    }
  }

  pingLoop(stream) {
    this.unackedPings = 0;
    this.pingTimer = setInterval(() => {
      this.seq += 1;
      this.unackedPings += 1;
      if (this.unackedPings >= 3) {
        this.log(`liveness.timeout unackedPings=${this.unackedPings} reconnecting...`);
        void this.reconnect();
        return;
      }
      sendPing(stream, this.seq);
    }, 10_000);
    const pump = async () => {
      try {
        for (;;) {
          const msg = await readControl(stream);
          if (msg.type === PING) sendPong(stream, msg);
          if (msg.type === PONG) {
            this.unackedPings = 0;
            this.pingOk = true;
            this.log('liveness.pong');
            this.onFlag?.({ pingOk: true });
          }
        }
      } catch (err) {
        this.log(`control.read ${err.message}`);
        if (this.handshakeOk) {
          void this.reconnect();
        }
      }
    };
    void pump();
  }
}

class Mux {
  constructor(kcp, keys, aad, log) {
    this.kcp = kcp;
    this.keys = keys;
    this.aad = aad;
    this.log = log;
    this.onData = null;
    this.rxCount = 0;
    const plane = aad === AAD_DATA ? 'data' : 'ctrl';
    kcp.onMessage = (cipher) => {
      try {
        const pt = keys.open(cipher, aad);
        this.rxCount++;
        if (this.rxCount <= 5 || this.rxCount % 50 === 0) {
          this.log(`mux.rx plane=${plane} n=${pt.length} total=${this.rxCount}`);
        }
        this.onData?.(pt);
      } catch (err) {
        this.log(`olc2.open plane=${plane} ${err.message} len=${cipher.length}`);
      }
    };
  }

  write(plain) {
    const enc = this.keys.seal(plain instanceof Uint8Array ? plain : new Uint8Array(plain), this.aad);
    this.kcp.send(enc);
  }
}

function isStalePoolError(err) {
  const msg = String(err?.message || err);
  return (
    msg.includes('connection closed before headers') ||
    msg.includes('http header timeout got=0') ||
    msg.includes('eof during handshake') ||
    msg.includes('tls: eof')
  );
}

export function isMediaUrl(url, parsed = null, headers = null) {
  let p = parsed;
  if (!p) {
    try {
      p = new URL(url);
    } catch {
      return false;
    }
  }
  const host = (p.hostname || '').toLowerCase();
  const path = (p.pathname || '').toLowerCase();

  // 1. Static asset hosts are NEVER media
  if (
    host.startsWith('static.') ||
    host === 'st.rutube.ru' ||
    host.includes('uxfeedback') ||
    host.includes('expf.ru')
  ) {
    return false;
  }

  // 2. Static file extensions are NEVER media
  if (/\.(js|css|woff2?|ttf|eot|json|html?|svg|png|jpe?g|webp|gif|ico|map)$/i.test(path)) {
    return false;
  }

  // 3. Analytics, telemetry, banners are NEVER media
  if (
    host.startsWith('log.') ||
    host.startsWith('goya.') ||
    host.includes('analytics') ||
    path.includes('player_events') ||
    path.includes('/banner') ||
    path.includes('/notify')
  ) {
    return false;
  }

  // 4. Byte-range parameters and headers for media segments
  if (p.searchParams?.has('bytes')) {
    return true;
  }
  if (headers && (headers['range'] || headers['Range'])) {
    return true;
  }

  // 5. Genuine media streaming file extensions
  if (/\.(m3u8|mpd|ts|m4s|mp4|webm|m4a|aac|f4m|mp3)$/i.test(path)) {
    return true;
  }

  // 6. Streaming path keywords
  if (
    path.includes('/videoplayback') ||
    path.includes('/videopreview') ||
    path.includes('/route/') ||
    path.includes('/vod/') ||
    path.includes('/live/') ||
    path.includes('/hls/') ||
    path.includes('/dash/') ||
    path.includes('/segment') ||
    path.includes('/fragment')
  ) {
    return true;
  }

  // 7. Dedicated video CDN domains (non-static paths)
  if (
    host.includes('googlevideo.com') ||
    host === 'bl.rutube.ru' ||
    host.includes('vkvd.net') ||
    host.includes('vk-cdn') ||
    host.includes('mycdn.me') ||
    host.includes('vkuser.net') ||
    host.includes('vkvideo.ru')
  ) {
    return true;
  }

  return false;
}

export function isImageUrl(pathname = '', hostname = '') {
  const p = String(pathname || '').toLowerCase();
  const h = String(hostname || '').toLowerCase();
  return (
    /\.(jpe?g|png|webp|gif|ico|svg|avif|bmp)$/i.test(p) ||
    h.startsWith('pic.') ||
    h.startsWith('images.') ||
    h.startsWith('img.') ||
    h.includes('walmartimages.com') ||
    h.includes('ytimg.com')
  );
}

