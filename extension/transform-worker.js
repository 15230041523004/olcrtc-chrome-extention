import { keepaliveBuffer, hexPrefix } from './lib/vp8-wire.js';
import { Tunnel } from './lib/tunnel.js';
import { errorMessage } from './lib/errors.js';

let mode = 'identity';
let verboseLogs = false;
const counts = { sender: 0, receiver: 0, receiver2: 0 };
let inboundLogged = 0;
let recv2Frames = 0;
let tunnel = null;

const log = (line) => {
  if (!verboseLogs) {
    if (/^(vp8\.|kcp\.|media\.|mux\.|transform\.)/i.test(line)) return;
  }
  self.postMessage({ type: 'log', line });
};

self.addEventListener('message', (ev) => {
  const msg = ev.data;
  if (msg?.type === 'setVerboseLogs') {
    verboseLogs = Boolean(msg.verbose);
  }
  if (msg?.type === 'setMode') {
    if (msg.mode === 'identity' || msg.mode === 'marker' || msg.mode === 'tunnel') {
      mode = msg.mode;
      postStatus();
    }
  }
  if (msg?.type === 'startTunnel') {
    if (msg.config?.verboseLogs != null) {
      verboseLogs = Boolean(msg.config.verboseLogs);
    }
    void startTunnel(msg.config);
  }
  if (msg?.type === 'stopTunnel') {
    tunnel?.stop();
    tunnel = null;
  }
  if (msg?.type === 'mediaReady') {
    void tunnel?.startHandshake();
  }
  if (msg?.type === 'httpProxy') {
    void runHttpProxy(msg);
  }
});

function u8ToB64(u8) {
  if (!u8 || !u8.length) return '';
  if (typeof u8.toBase64 === 'function') {
    return u8.toBase64();
  }
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + chunk, u8.length)));
  }
  return btoa(s);
}

function b64ToU8(b64) {
  if (!b64) return new Uint8Array(0);
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

async function waitForHandshake(tun, maxMs = 3000) {
  if (tun?.handshakeOk) return true;
  if (!tun?.ready) return false;
  const start = performance.now();
  while (performance.now() - start < maxMs) {
    await new Promise((r) => setTimeout(r, 50));
    if (tun?.handshakeOk) return true;
    if (!tun?.ready) return false;
  }
  return Boolean(tun?.handshakeOk);
}

async function runHttpProxy(msg) {
  const id = msg.id;
  try {
    if (!tunnel?.handshakeOk) {
      const ok = await waitForHandshake(tunnel, 3000);
      if (!ok) throw new Error('handshake not ready');
    }
    const body = msg.bodyB64
      ? b64ToU8(msg.bodyB64)
      : msg.body
        ? (msg.body instanceof Uint8Array ? msg.body : new Uint8Array(msg.body))
        : null;
    const res = await tunnel.httpProxy({
      method: msg.method,
      url: msg.url,
      headers: msg.headers || {},
      body,
    });
    const bodyB64 = u8ToB64(res.body);
    self.postMessage({
      type: 'httpResult',
      id,
      ok: true,
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
      bodyB64,
      bodyLength: res.body?.length || 0,
    });
  } catch (err) {
    const message = errorMessage(err, 'HTTP proxy failed');
    log(`http.proxy error ${message}`);
    self.postMessage({ type: 'httpResult', id, ok: false, error: message });
  }
}

async function startTunnel(cfg) {
  try {
    tunnel?.stop();
    tunnel = new Tunnel(log);
    tunnel.onFlag = (flags) => self.postMessage({ type: 'flags', flags });
    await tunnel.start(cfg);
    mode = 'tunnel';
    self.postMessage({ type: 'log', line: 'tunnel.started' });
    self.postMessage({ type: 'tunnel.ready' });
    postStatus();
  } catch (err) {
    log(`tunnel.start ${err.message}`);
  }
}

self.onrtctransform = (event) => {
  const transformer = event.transformer;
  const name = transformer.options?.name || 'sender';
  if (transformer.options?.mode) mode = transformer.options.mode;

  const stream = new TransformStream({
    transform(frame, controller) {
      counts[name] += 1;
      try {
        if (mode === 'identity') {
          controller.enqueue(frame);
          return;
        }
        if (mode === 'marker') {
          markerTransform(name, frame, controller);
          return;
        }
        tunnelTransform(name, frame, controller);
      } catch (err) {
        self.postMessage({ type: 'error', message: String(err?.message || err) });
        try {
          controller.enqueue(frame);
        } catch {
          /* drop */
        }
      }
    },
  });

  transformer.readable
    .pipeThrough(stream)
    .pipeTo(transformer.writable)
    .catch((err) => {
      self.postMessage({ type: 'pipeError', name, message: String(err?.message || err) });
    });

  self.postMessage({ type: 'attached', name, mode });
};

function markerTransform(name, frame, controller) {
  if (name === 'sender') {
    const orig = frame.data?.byteLength ?? 0;
    const out = new Uint8Array(24);
    out.set(new Uint8Array(keepaliveBuffer()));
    out.set([0x4f, 0x4c, 0x43, 0x31], 20);
    frame.data = out.buffer;
    void orig;
    controller.enqueue(frame);
    return;
  }
  inboundLogged += 1;
  if (inboundLogged === 1 || inboundLogged % 30 === 0) {
    self.postMessage({
      type: 'inboundPrefix',
      prefix: hexPrefix(frame.data, 36),
      bytes: frame.data?.byteLength ?? 0,
      frameType: frame.type,
      n: inboundLogged,
    });
  }
  frame.data = keepaliveBuffer();
  controller.enqueue(frame);
}

function tunnelTransform(name, frame, controller) {
  if (name === 'receiver' || name === 'receiver2') {
    if (name === 'receiver2') recv2Frames += 1;
    if (tunnel) tunnel.handleInbound(frame.data, { probe: name === 'receiver2' });
    frame.data = keepaliveBuffer();
    controller.enqueue(frame);
    return;
  }
  const isKey = frame.type === 'key';
  const sample = tunnel?.buildSample({ keyframe: isKey, frameType: isKey ? 'key' : 'delta' });
  if (sample) {
    frame.data = sample;
  }
  controller.enqueue(frame);
}

setInterval(postStatus, 2000);

function postStatus() {
  tunnel?.logStats();
  self.postMessage({
    type: 'stats',
    mode,
    in: counts.receiver,
    out: counts.sender,
    handshakeOk: Boolean(tunnel?.handshakeOk),
    pingOk: Boolean(tunnel?.pingOk),
    tokenOk: Boolean(tunnel?.tokenOk),
    token: tunnel?.token || 0,
    recv2: recv2Frames,
  });
  if (recv2Frames === 0 || recv2Frames % 60 === 0) {
    log(`receiver2 frames=${recv2Frames}`);
  }
}
