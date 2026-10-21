import fs from 'node:fs';

// 1. tunnel.js: remove peer.epochChanged suicide block, update pingLoop
let tunnelCode = fs.readFileSync('extension/lib/tunnel.js', 'utf8');

const oldPeerCheck = `    const src = hdr.src;
    if (src === this.localEpoch || src === this.localControlEpoch) return;

    if (this.handshakeOk && (src & CONTROL_EPOCH_FLAG) === 0 && src !== this.peerEpoch) {
      if (this.unackedPings >= 2 || (this.stats.dataAcks === 0 && this.stats.dataIn === 0)) {
        this.log(\`peer.epochChanged old=\${hexU32(this.peerEpoch)} new=\${hexU32(src)} reconnecting...\`);
        void this.reconnect();
        return;
      }
    }`;

const newPeerCheck = `    const src = hdr.src;
    if (src === this.localEpoch || src === this.localControlEpoch) return;

    if (this.handshakeOk) {
      const isOurServer = (src === this.peerEpoch) || (src === ((this.peerEpoch | CONTROL_EPOCH_FLAG) >>> 0));
      if (!isOurServer) return;
    }`;

if (tunnelCode.includes(oldPeerCheck.replace(/\n/g, '\r\n'))) {
  tunnelCode = tunnelCode.replace(oldPeerCheck.replace(/\n/g, '\r\n'), newPeerCheck.replace(/\n/g, '\r\n'));
  console.log('Fixed peer.epochChanged in tunnel.js (CRLF)');
} else if (tunnelCode.includes(oldPeerCheck)) {
  tunnelCode = tunnelCode.replace(oldPeerCheck, newPeerCheck);
  console.log('Fixed peer.epochChanged in tunnel.js (LF)');
} else {
  console.error('Could not find oldPeerCheck in tunnel.js');
}

// pingLoop: increase max unacked pings to 5 and log server ping
const oldPingPump = `          const msg = await readControl(stream);
          if (msg.type === PING) sendPong(stream, msg);`;

const newPingPump = `          const msg = await readControl(stream);
          if (msg.type === PING) {
            this.log(\`liveness.serverPing seq=\${msg.seq}\`);
            void sendPong(stream, msg);
          }`;

if (tunnelCode.includes(oldPingPump.replace(/\n/g, '\r\n'))) {
  tunnelCode = tunnelCode.replace(oldPingPump.replace(/\n/g, '\r\n'), newPingPump.replace(/\n/g, '\r\n'));
  console.log('Updated pingLoop in tunnel.js (CRLF)');
} else if (tunnelCode.includes(oldPingPump)) {
  tunnelCode = tunnelCode.replace(oldPingPump, newPingPump);
  console.log('Updated pingLoop in tunnel.js (LF)');
} else {
  console.error('Could not find oldPingPump in tunnel.js');
}

const oldPingLimit = `if (this.unackedPings >= 3) {`;
const newPingLimit = `if (this.unackedPings >= 5) {`;
if (tunnelCode.includes(oldPingLimit)) {
  tunnelCode = tunnelCode.replace(oldPingLimit, newPingLimit);
  console.log('Updated ping failure threshold to 5');
}

fs.writeFileSync('extension/lib/tunnel.js', tunnelCode, 'utf8');

// 2. kcp.js: stream mode unbounded chunks, and zero-window probing
let kcpCode = fs.readFileSync('extension/lib/kcp.js', 'utf8');

const oldKcpSend = `    let count = Math.ceil(data.length / this.mss) || 1;
    if (count > 255) return -2;`;
const newKcpSend = `    let count = Math.ceil(data.length / this.mss) || 1;
    if (!this.stream && count > 255) return -2;`;

if (kcpCode.includes(oldKcpSend.replace(/\n/g, '\r\n'))) {
  kcpCode = kcpCode.replace(oldKcpSend.replace(/\n/g, '\r\n'), newKcpSend.replace(/\n/g, '\r\n'));
  console.log('Fixed KCP stream-mode fragment count (CRLF)');
} else if (kcpCode.includes(oldKcpSend)) {
  kcpCode = kcpCode.replace(oldKcpSend, newKcpSend);
  console.log('Fixed KCP stream-mode fragment count (LF)');
}

// Add tsProbe and probeWait to KCP constructor
const oldKcpCtor = `    this.incr = 0;
    this.probe = 0;
  }`;
const newKcpCtor = `    this.incr = 0;
    this.probe = 0;
    this.tsProbe = 0;
    this.probeWait = 0;
  }`;

if (kcpCode.includes(oldKcpCtor.replace(/\n/g, '\r\n'))) {
  kcpCode = kcpCode.replace(oldKcpCtor.replace(/\n/g, '\r\n'), newKcpCtor.replace(/\n/g, '\r\n'));
  console.log('Added probe tracking to KCP constructor (CRLF)');
} else if (kcpCode.includes(oldKcpCtor)) {
  kcpCode = kcpCode.replace(oldKcpCtor, newKcpCtor);
  console.log('Added probe tracking to KCP constructor (LF)');
}

// Add zero-window probing in flush()
const oldKcpFlushProbes = `    if (this.probe & 2) {
      push(encodeSeg({ conv: this.conv, cmd: KCP_CMD_WINS, frg: 0, wnd, ts: current, sn: 0, una, data: null }));
    }
    this.probe = 0;`;

const newKcpFlushProbes = `    if (this.rmtWnd === 0) {
      if (this.probeWait === 0) {
        this.probeWait = 1000;
        this.tsProbe = current + this.probeWait;
      } else if (timediff(current, this.tsProbe) >= 0) {
        this.probeWait = Math.min(5000, this.probeWait + (this.probeWait >> 1));
        this.tsProbe = current + this.probeWait;
        this.probe |= 1;
      }
    } else {
      this.tsProbe = 0;
      this.probeWait = 0;
    }

    if (this.probe & 1) {
      push(encodeSeg({ conv: this.conv, cmd: KCP_CMD_WASK, frg: 0, wnd, ts: current, sn: 0, una, data: null }));
    }
    if (this.probe & 2) {
      push(encodeSeg({ conv: this.conv, cmd: KCP_CMD_WINS, frg: 0, wnd, ts: current, sn: 0, una, data: null }));
    }
    this.probe = 0;`;

if (kcpCode.includes(oldKcpFlushProbes.replace(/\n/g, '\r\n'))) {
  kcpCode = kcpCode.replace(oldKcpFlushProbes.replace(/\n/g, '\r\n'), newKcpFlushProbes.replace(/\n/g, '\r\n'));
  console.log('Added zero-window probing to KCP flush (CRLF)');
} else if (kcpCode.includes(oldKcpFlushProbes)) {
  kcpCode = kcpCode.replace(oldKcpFlushProbes, newKcpFlushProbes);
  console.log('Added zero-window probing to KCP flush (LF)');
}

fs.writeFileSync('extension/lib/kcp.js', kcpCode, 'utf8');

// 3. tls.js: safe close and pump
let tlsCode = fs.readFileSync('extension/lib/tls.js', 'utf8');

const oldTlsPump = `  const pump = async () => {
    try {
      for (;;) {
        const chunk = await tcp.read(65536);
        log(\`tls.tcp.recv sni=\${sni} n=\${chunk.length}\`);
        if (!chunk.length) break;
        const app = feedNetwork(client, chunk);
        log(\`tls.feed sni=\${sni} chunk=\${chunk.length} app=\${app.length}\`);
        if (app.length) {
          pushBytes(app);
          wake();
        }
        const flushed = flushOut(client, tcp);
        if (flushed && typeof flushed.then === 'function') await flushed;
      }
    } catch (err) {
      log(\`tls.pump \${err.message}\`);
    }
    closed = true;
    wake();
  };`;

const newTlsPump = `  const pump = async () => {
    try {
      while (!closed) {
        const chunk = await tcp.read(65536);
        if (closed || !chunk.length) break;
        log(\`tls.tcp.recv sni=\${sni} n=\${chunk.length}\`);
        const app = feedNetwork(client, chunk);
        if (closed) break;
        log(\`tls.feed sni=\${sni} chunk=\${chunk.length} app=\${app.length}\`);
        if (app.length) {
          pushBytes(app);
          wake();
        }
        if (closed) break;
        const flushed = flushOut(client, tcp);
        if (flushed && typeof flushed.then === 'function') await flushed;
      }
    } catch (err) {
      if (!closed) log(\`tls.pump \${err.message}\`);
    } finally {
      closed = true;
      wake();
    }
  };`;

if (tlsCode.includes(oldTlsPump.replace(/\n/g, '\r\n'))) {
  tlsCode = tlsCode.replace(oldTlsPump.replace(/\n/g, '\r\n'), newTlsPump.replace(/\n/g, '\r\n'));
  console.log('Updated tls pump (CRLF)');
} else if (tlsCode.includes(oldTlsPump)) {
  tlsCode = tlsCode.replace(oldTlsPump, newTlsPump);
  console.log('Updated tls pump (LF)');
}

const oldTlsClose = `    close() {
      try {
        if (typeof client.close === 'function') client.close();
        const f = flushOut(client, tcp);
        if (f && typeof f.catch === 'function') f.catch(() => {});
      } catch {
        /* ignore */
      }
      try {
        client.free();
      } catch {
        /* ignore */
      }
      tcp.close();
    },`;

const newTlsClose = `    close() {
      if (closed) return;
      closed = true;
      wake();
      try {
        if (typeof client.close === 'function') client.close();
      } catch {
        /* ignore */
      }
      try {
        client.free();
      } catch {
        /* ignore */
      }
      try {
        tcp.close();
      } catch {
        /* ignore */
      }
    },`;

if (tlsCode.includes(oldTlsClose.replace(/\n/g, '\r\n'))) {
  tlsCode = tlsCode.replace(oldTlsClose.replace(/\n/g, '\r\n'), newTlsClose.replace(/\n/g, '\r\n'));
  console.log('Updated tls close (CRLF)');
} else if (tlsCode.includes(oldTlsClose)) {
  tlsCode = tlsCode.replace(oldTlsClose, newTlsClose);
  console.log('Updated tls close (LF)');
}

fs.writeFileSync('extension/lib/tls.js', tlsCode, 'utf8');

// 4. smux.js: writeFrame on openStream
let smuxCode = fs.readFileSync('extension/lib/smux.js', 'utf8');

const oldSmuxOpen = `  openStream() {
    this.nextStreamID += 2;
    const sid = this.nextStreamID;
    const st = new SmuxStream(this, sid);
    this.streams.set(sid, st);
    this.conn.write(hdr(VERSION, CMD_SYN, sid, 0));
    return st;
  }`;

const newSmuxOpen = `  openStream() {
    this.nextStreamID += 2;
    const sid = this.nextStreamID;
    const st = new SmuxStream(this, sid);
    this.streams.set(sid, st);
    this.writeFrame(CMD_SYN, sid, null);
    return st;
  }`;

if (smuxCode.includes(oldSmuxOpen.replace(/\n/g, '\r\n'))) {
  smuxCode = smuxCode.replace(oldSmuxOpen.replace(/\n/g, '\r\n'), newSmuxOpen.replace(/\n/g, '\r\n'));
  console.log('Updated smux openStream (CRLF)');
} else if (smuxCode.includes(oldSmuxOpen)) {
  smuxCode = smuxCode.replace(oldSmuxOpen, newSmuxOpen);
  console.log('Updated smux openStream (LF)');
}

fs.writeFileSync('extension/lib/smux.js', smuxCode, 'utf8');

// 5. handshake.js: async writeFrame
let hsCode = fs.readFileSync('extension/lib/handshake.js', 'utf8');

const oldHsWrite = `function writeFrame(stream, obj) {
  const json = new TextEncoder().encode(JSON.stringify(obj));
  const buf = new Uint8Array(4 + json.length);
  new DataView(buf.buffer).setUint32(0, json.length);
  buf.set(json, 4);
  stream.write(buf);
}`;

const newHsWrite = `async function writeFrame(stream, obj) {
  const json = new TextEncoder().encode(JSON.stringify(obj));
  const buf = new Uint8Array(4 + json.length);
  new DataView(buf.buffer).setUint32(0, json.length);
  buf.set(json, 4);
  await stream.write(buf);
}`;

if (hsCode.includes(oldHsWrite.replace(/\n/g, '\r\n'))) {
  hsCode = hsCode.replace(oldHsWrite.replace(/\n/g, '\r\n'), newHsWrite.replace(/\n/g, '\r\n'));
  console.log('Updated handshake writeFrame (CRLF)');
} else if (hsCode.includes(oldHsWrite)) {
  hsCode = hsCode.replace(oldHsWrite, newHsWrite);
  console.log('Updated handshake writeFrame (LF)');
}

const oldClientHs = `  const challenge = randomChallenge();
  writeFrame(stream, {`;

const newClientHs = `  const challenge = randomChallenge();
  await writeFrame(stream, {`;

if (hsCode.includes(oldClientHs.replace(/\n/g, '\r\n'))) {
  hsCode = hsCode.replace(oldClientHs.replace(/\n/g, '\r\n'), newClientHs.replace(/\n/g, '\r\n'));
  console.log('Updated clientHandshake await (CRLF)');
} else if (hsCode.includes(oldClientHs)) {
  hsCode = hsCode.replace(oldClientHs, newClientHs);
  console.log('Updated clientHandshake await (LF)');
}

fs.writeFileSync('extension/lib/handshake.js', hsCode, 'utf8');

// 6. offscreen.js: emit all logs
let offCode = fs.readFileSync('extension/offscreen.js', 'utf8');
const oldOffLog = `  if (msg.type === 'log' && msg.line) {
    if (verboseLogs || /error|connected|handshake|auth\\.ok|lost|tunnel\\.ready|ready|started|socks|http|smux|pool|tls|geo/i.test(msg.line)) {
      emit('log', msg.line);
    }
    return;
  }`;

const newOffLog = `  if (msg.type === 'log' && msg.line) {
    emit('log', msg.line);
    return;
  }`;

if (offCode.includes(oldOffLog.replace(/\n/g, '\r\n'))) {
  offCode = offCode.replace(oldOffLog.replace(/\n/g, '\r\n'), newOffLog.replace(/\n/g, '\r\n'));
  console.log('Updated offscreen log filter (CRLF)');
} else if (offCode.includes(oldOffLog)) {
  offCode = offCode.replace(oldOffLog, newOffLog);
  console.log('Updated offscreen log filter (LF)');
}

fs.writeFileSync('extension/offscreen.js', offCode, 'utf8');

// 7. background.js: log filter preserves events
let bgCode = fs.readFileSync('extension/background.js', 'utf8');
const oldBgLog = `  const isCritical = /error|fail|intercept|connected|handshake|auth\\.ok|lost|warn|connect\\s|disconnect|geo\\.profile|spoof\\.|fetch\\.enable|fetch\\.fulfill|cookie\\./i.test(String(line));
  if (!state.verboseLogs && !isCritical) {
    return;
  }`;

const newBgLog = `  const isCritical = /error|fail|intercept|connected|handshake|auth\\.ok|lost|warn|connect\\s|disconnect|geo\\.profile|spoof\\.|fetch\\.enable|fetch\\.fulfill|cookie\\./i.test(String(line));
  if (!state.verboseLogs && !isCritical && !isEvent) {
    return;
  }`;

if (bgCode.includes(oldBgLog.replace(/\n/g, '\r\n'))) {
  bgCode = bgCode.replace(oldBgLog.replace(/\n/g, '\r\n'), newBgLog.replace(/\n/g, '\r\n'));
  console.log('Updated background log filter (CRLF)');
} else if (bgCode.includes(oldBgLog)) {
  bgCode = bgCode.replace(oldBgLog, newBgLog);
  console.log('Updated background log filter (LF)');
}

fs.writeFileSync('extension/background.js', bgCode, 'utf8');

console.log('All fixes applied successfully!');

