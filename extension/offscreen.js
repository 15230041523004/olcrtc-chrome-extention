import { issueTelemostConnection, wsHost } from './lib/telemost-auth.js';
import { GoolomSession } from './lib/goolom.js';
import { monitorPublisher } from './lib/publisher-monitor.js';
import { errorMessage } from './lib/errors.js';

let session = null;
let dummyTimer = null;
let dummyStream = null;
let worker = null;
let mode = 'tunnel';
let lastStats = { in: 0, out: 0, mode: 'tunnel' };
let receiverTransformAttached = false;
let stopPublisherMonitor = null;
let verboseLogs = false;
const httpWait = new Map();
let httpSeq = 1;

chrome.runtime.sendMessage({ source: 'offscreen', type: 'OFFSCREEN_READY' }).catch(() => {});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.dest === 'popup') return;
  if (msg.source === 'offscreen') return;

  if (msg.type === 'START') {
    void start(msg.config)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        emit('log', `error ${err.message}`);
        sendResponse({ ok: false, error: err.message });
      });
    return true;
  }
  if (msg.type === 'STOP') {
    void stop().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'SET_MODE') {
    setMode(msg.mode);
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === 'SET_VERBOSE_LOGS') {
    verboseLogs = Boolean(msg.verbose);
    worker?.postMessage({ type: 'setVerboseLogs', verbose: verboseLogs });
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === 'PING_OFFSCREEN') {
    sendResponse({ ok: true, stats: lastStats });
    return;
  }
  if (msg.type === 'HTTP_PROXY') {
    void proxyHttp(msg)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: errorMessage(err, 'HTTP proxy failed') }));
    return true;
  }
});

function proxyHttp(msg) {
  if (!worker) return Promise.reject(new Error('no worker'));
  const id = httpSeq++;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      httpWait.delete(id);
      reject(new Error('http proxy timeout'));
    }, 180_000);
    httpWait.set(id, { resolve, reject, t });
    worker.postMessage({
      type: 'httpProxy',
      id,
      method: msg.method,
      url: msg.url,
      headers: msg.headers || {},
      bodyB64: msg.bodyB64 || null,
      body: msg.body || null,
    });
  });
}

async function start(config) {
  await stop();
  receiverTransformAttached = false;
  mode = config.mode || 'tunnel';
  if (config.verboseLogs != null) verboseLogs = Boolean(config.verboseLogs);
  try {
    await startSession(config);
  } catch (err) {
    await stop();
    throw err;
  }
}

async function startSession(config) {
  if (!config?.roomUrl) throw new Error('START missing roomUrl');
  if (!('RTCRtpScriptTransform' in window) || !('transform' in RTCRtpSender.prototype)) {
    throw new Error('Chrome 141+ Encoded Transform required');
  }

  const displayName = config.displayName || randomName();
  const creds = await issueTelemostConnection(config.roomUrl, displayName);
  emit('log', `auth.ok host=${wsHost(creds.mediaServerURL)}`);
  emit('event', { type: 'auth.ok', host: wsHost(creds.mediaServerURL), apiRoomId: creds.roomID });

  dummyStream = startDummyVideo(config.vp8?.fps || 120);
  const videoTrack = dummyStream.getVideoTracks()[0];
  if (!videoTrack) throw new Error('canvas.captureStream produced no video track');

  worker = new Worker(chrome.runtime.getURL('transform-worker.js'), { type: 'module' });
  worker.addEventListener('message', onWorkerMessage);
  worker.postMessage({ type: 'setVerboseLogs', verbose: verboseLogs });

  if (mode === 'tunnel') {
    await startTunnelOnWorker({
      keyHex: config.keyHex,
      roomId: config.roomId,
      roomUrl: config.roomUrl,
      apiRoomId: creds.roomID,
      channelId: config.channelId || '',
      deviceId: `chrome-${crypto.randomUUID().slice(0, 8)}`,
      verboseLogs,
    });
  } else {
    worker.postMessage({ type: 'setMode', mode });
  }

  session = new GoolomSession(
    { ...creds, name: displayName, roomURL: config.roomUrl },
    videoTrack,
    {
      log: (line) => emit('log', line),
      onEvent: (ev) => {
        emit('event', ev);
        if (ev.type === 'sub.connected') {
          worker?.postMessage({ type: 'mediaReady' });
        }
      },
      onPublisherSender: (pc, sender) => {
        sender.transform = new RTCRtpScriptTransform(worker, { name: 'sender', mode });
        try {
          const params = sender.getParameters?.();
          if (params?.encodings?.length) {
            for (const enc of params.encodings) {
              enc.maxBitrate = 120_000_000;
              enc.maxFramerate = 60;
            }
            sender.setParameters(params).catch(() => {});
          }
        } catch {}
        stopPublisherMonitor = monitorPublisher(pc, sender, (line) => emit('log', line), () => mode === 'tunnel');
        emit('log', 'sender.transform.attached');
        emit('event', { type: 'sender.transform.attached' });
      },
      onSubscriberTrack: (receiver, track) => {
        if (receiverTransformAttached) {
          receiver.transform = new RTCRtpScriptTransform(worker, { name: 'receiver2', mode });
          if (verboseLogs) emit('log', `receiver2.transform.attached (log-only) ${track?.id || ''}`);
          return;
        }
        receiverTransformAttached = true;
        receiver.transform = new RTCRtpScriptTransform(worker, { name: 'receiver', mode });
        emit('log', 'receiver.transform.attached');
        emit('event', { type: 'receiver.transform.attached' });
      },
    },
  );

  const remoteEl = document.getElementById('remote');
  if (remoteEl) remoteEl.srcObject = session.remoteVideo;

  await session.connect();
}

function startTunnelOnWorker(cfg) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('tunnel start timeout')), 8000);
    const onMsg = (ev) => {
      if (ev.data?.type === 'tunnel.ready') {
        worker.removeEventListener('message', onMsg);
        clearTimeout(t);
        resolve();
      }
    };
    worker.addEventListener('message', onMsg);
    worker.postMessage({ type: 'startTunnel', config: cfg });
  });
}

function onWorkerMessage(ev) {
  const msg = ev.data;
  if (!msg) return;
  if (msg.type === 'stats') {
    lastStats = { in: msg.in, out: msg.out, mode: msg.mode };
    if (verboseLogs) {
      const tag =
        msg.mode === 'marker' ? 'transform.marker' : msg.mode === 'tunnel' ? 'transform.tunnel' : 'transform.identity';
      emit('log', `${tag} in=${msg.in} out=${msg.out}`);
    }
    emit('event', {
      type: 'transform.stats',
      ...lastStats,
      handshakeOk: msg.handshakeOk,
      pingOk: msg.pingOk,
      tokenOk: msg.tokenOk,
      token: msg.token,
    });
    return;
  }
  if (msg.type === 'log' && msg.line) {
    if (verboseLogs || /error|connected|handshake|auth\.ok|lost|tunnel\.ready|ready|started/i.test(msg.line)) {
      emit('log', msg.line);
    }
    return;
  }
  if (msg.type === 'flags') {
    emit('event', { type: 'tunnel.flags', ...msg.flags });
    return;
  }
  if (msg.type === 'inboundPrefix') {
    if (verboseLogs) emit('log', `inbound.prefix n=${msg.n} bytes=${msg.bytes} type=${msg.frameType} hex=${msg.prefix}`);
    return;
  }
  if (msg.type === 'attached') {
    if (verboseLogs) emit('log', `transform.worker attached ${msg.name} mode=${msg.mode}`);
    return;
  }
  if (msg.type === 'error' || msg.type === 'pipeError') {
    emit('log', `transform.${msg.type}: ${msg.message}`);
  }
  if (msg.type === 'httpResult' && httpWait.has(msg.id)) {
    const pending = httpWait.get(msg.id);
    httpWait.delete(msg.id);
    clearTimeout(pending.t);
    pending.resolve(msg);
  }
}

function setMode(next) {
  mode = next === 'marker' || next === 'identity' || next === 'tunnel' ? next : 'tunnel';
  worker?.postMessage({ type: 'setMode', mode });
  emit('log', `transform.mode=${mode}`);
}

function startDummyVideo(fps) {
  fps = Number(fps) || 60;
  const canvas = document.getElementById('dummy');
  const ctx = canvas.getContext('2d', { alpha: false });
  let t = 0;
  const paint = () => {
    t = (t + 1) & 0xff;
    ctx.fillStyle = `rgb(${32 + (t % 48)}, ${16 + (t % 32)}, 40)`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#9cf';
    ctx.fillRect(t % canvas.width, (t * 3) % canvas.height, 3, 3);
  };
  paint();
  dummyTimer = setInterval(paint, Math.max(8, Math.floor(1000 / fps)));
  return canvas.captureStream(fps);
}

async function stop() {
  stopPublisherMonitor?.();
  stopPublisherMonitor = null;
  if (dummyTimer) {
    clearInterval(dummyTimer);
    dummyTimer = null;
  }
  if (session) {
    await session.close();
    session = null;
  }
  dummyStream?.getTracks().forEach((t) => t.stop());
  dummyStream = null;
  if (worker) {
    worker.postMessage({ type: 'stopTunnel' });
    worker.terminate();
    worker = null;
  }
  lastStats = { in: 0, out: 0, mode };
}

function emit(kind, payload) {
  const msg =
    kind === 'log'
      ? { source: 'offscreen', type: 'LOG', line: payload }
      : { source: 'offscreen', type: 'EVENT', event: payload };
  chrome.runtime.sendMessage(msg).catch(() => {});
}

function randomName() {
  const names = ['Olga', 'Ivan', 'Mira', 'Pavel', 'Nina', 'Kirill', 'Vera', 'Oleg'];
  const n = names[Math.floor(Math.random() * names.length)];
  return `${n} ${crypto.randomUUID().slice(0, 4)}`;
}
