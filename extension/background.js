import { parseOlcrtcUri, redactUri } from './lib/uri.js';
import {
  configureIntercept,
  startIntercept,
  stopIntercept,
  setHandshakeOk,
  pickHttpTab,
  setBlockWebrtc,
  getInterceptStats,
  setSpoofProfile,
} from './lib/intercept.js';
import { FALLBACK_GEO_PROFILE } from './lib/geo-spoof.js';
import { resolveExitGeo } from './lib/geo-profile.js';
import { enableNetworkGuard, disableNetworkGuard, isNetworkGuardEnabled } from './lib/network-guard.js';
import {
  DEFAULT_SPOOF_SETTINGS,
  normalizeSpoofSettings,
  buildSpoofProfile,
} from './lib/fingerprint-spoof.js';

configureIntercept({
  log: (line) => log(line),
  proxy: (req) => sendToOffscreen({ type: 'HTTP_PROXY', ...req }),
  tabCount: (count) => {
    state.interceptTabCount = count;
    state.flags.intercept = count > 0;
    if (count > 0) state.flags.interceptLost = false;
    broadcast();
  },
  lost: () => {
    state.flags.intercept = false;
    state.flags.interceptLost = true;
    log('intercept.lost (all debuggers detached) — re-enable from popup');
    broadcast();
  },
});

const LOG_CAP = 400;
const EVENT_CAP = 300;
const EVENT_RE = /intercept|fetch\.|socks\.|http\.proxy|http[.\s]|youtube\.|handshake|dataSmux|tls\.|error |auth\.ok|connect |pool\.|webrtc\.|proxy\.inflight|geo\.|spoof\.|cookie\.strip/i;
const ALARM = 'olc-keepalive';
let lifecycleOperation = Promise.resolve();
let acceptTunnelEvents = false;
function runLifecycle(fn) {
  const next = lifecycleOperation.then(fn, fn);
  lifecycleOperation = next.catch(() => {});
  return next;
}

const state = {
  status: 'idle',
  error: '',
  mode: 'tunnel',
  uriRedacted: '',
  interceptUrl: '',
  interceptTabCount: 0,
  verboseLogs: false,
  flags: {
    authOk: false,
    wsOpen: false,
    helloSent: false,
    serverHello: false,
    subConnected: false,
    pubConnected: false,
    senderTransform: false,
    remoteVp8: false,
    transformIn: 0,
    transformOut: 0,
    tokenOk: false,
    handshakeOk: false,
    pingOk: false,
    token: 0,
    intercept: false,
    interceptLost: false,
    blockWebrtc: true,
  },
  logs: [],
  events: [],
  spoofSettings: { ...DEFAULT_SPOOF_SETTINGS },
  exitGeo: null,
  exitGeoLookup: { status: 'idle', checkedAt: null, attempts: [] },
  spoofProfile: null,
  networkGuard: false,
};

// Recover conservatively after a service-worker/browser restart: dynamic
// blocks survive, but old session allowances must not outlive our debugger state.
const guardReady = (async () => {
  if (await isNetworkGuardEnabled()) {
    state.networkGuard = true;
    await enableNetworkGuard();
    log('guard.restored direct traffic blocked; connect to resume');
    broadcast();
  }
})();
guardReady.catch((err) => fail(`Network guard: ${err.message}`));

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM, { periodInMinutes: 0.4 });
  chrome.storage.local.set({ verboseLogs: false, verboseLogsV2: true });
  state.verboseLogs = false;
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM, { periodInMinutes: 0.4 });
  chrome.storage.local.set({ verboseLogs: false, verboseLogsV2: true });
  state.verboseLogs = false;
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== ALARM) return;
  if (state.status === 'connected' || state.status === 'connecting') {
    pingOffscreen();
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return;

  if (msg.source === 'offscreen') {
    handleOffscreen(msg);
    return;
  }

  if (msg.type === 'GET_STATE') {
    sendResponse({ state: publicState() });
    return;
  }
  if (msg.type === 'GET_LOG') {
    const snapshot = publicState();
    sendResponse({
      version: chrome.runtime.getManifest().version,
      exportedAt: new Date().toISOString(),
      status: state.status,
      mode: state.mode,
      networkGuard: snapshot.networkGuard,
      interceptTabCount: snapshot.interceptTabCount,
      spoof: snapshot.spoof,
      flags: { ...state.flags },
      interceptStats: getInterceptStats(),
      events: state.events.slice(),
      logs: state.logs.slice(),
    });
    return;
  }
  if (msg.type === 'RECHECK_EXIT') {
    if (!state.flags.handshakeOk) {
      sendResponse({ ok: false, error: 'Connect the tunnel before checking its exit', state: publicState() });
      return;
    }
    void resolveAndApplyExitGeo(connectionGeneration)
      .then(() => sendResponse({ ok: true, state: publicState() }))
      .catch((err) => sendResponse({ ok: false, error: err.message, state: publicState() }));
    return true;
  }
  if (msg.type === 'CONNECT') {
    void runLifecycle(() => connect(msg.uri, msg.mode))
      .then(() => sendResponse({ ok: true, state: publicState() }))
      .catch((err) => {
        fail(err.message);
        sendResponse({ ok: false, error: err.message, state: publicState() });
      });
    return true;
  }
  if (msg.type === 'DISCONNECT') {
    void runLifecycle(disconnect)
      .then(() => sendResponse({ ok: true, state: publicState() }))
      .catch((err) => {
        fail(err.message);
        sendResponse({ ok: false, error: err.message, state: publicState() });
      });
    return true;
  }
  if (msg.type === 'INTERCEPT') {
    void runLifecycle(() => toggleIntercept(Boolean(msg.on)))
      .then(() => sendResponse({ ok: true, state: publicState() }))
      .catch((err) => {
        log(`intercept.error ${err.message}`);
        sendResponse({ ok: false, error: err.message, state: publicState() });
      });
    return true;
  }
  if (msg.type === 'SET_MODE') {
    state.mode = msg.mode === 'marker' || msg.mode === 'identity' || msg.mode === 'tunnel' ? msg.mode : 'tunnel';
    chrome.storage.local.set({ mode: state.mode });
    sendToOffscreen({ type: 'SET_MODE', mode: state.mode });
    broadcast();
    sendResponse({ ok: true, state: publicState() });
    return;
  }
  if (msg.type === 'SET_VERBOSE_LOGS') {
    state.verboseLogs = Boolean(msg.on);
    chrome.storage.local.set({ verboseLogs: state.verboseLogs, verboseLogsV2: true });
    sendToOffscreen({ type: 'SET_VERBOSE_LOGS', verbose: state.verboseLogs });
    broadcast();
    sendResponse({ ok: true, state: publicState() });
    return;
  }
  if (msg.type === 'SET_SPOOF_SETTINGS') {
    const next = normalizeSpoofSettings({ ...state.spoofSettings, ...(msg.settings || msg) });
    state.spoofSettings = next;
    chrome.storage.local.set({
      spoofLanguage: next.spoofLanguage,
      spoofLocale: next.spoofLocale,
      spoofUa: next.spoofUa,
      spoofUaPreset: next.spoofUaPreset,
      spoofHwConcurrency: next.spoofHwConcurrency,
      spoofHwConcurrencyValue: next.spoofHwConcurrencyValue,
    });
    void applyMergedSpoof()
      .then(() => sendResponse({ ok: true, state: publicState() }))
      .catch((err) => sendResponse({ ok: false, error: err.message, state: publicState() }));
    broadcast();
    return true;
  }
});

chrome.storage.local.get(
  { verboseLogs: false, verboseLogsV2: false, ...DEFAULT_SPOOF_SETTINGS },
  (stored) => {
    if (!stored.verboseLogsV2) {
      chrome.storage.local.set({ verboseLogs: false, verboseLogsV2: true });
      state.verboseLogs = false;
    } else {
      state.verboseLogs = Boolean(stored.verboseLogs);
    }
    state.spoofSettings = normalizeSpoofSettings(stored);
    void applyMergedSpoof();
  },
);
state.flags.blockWebrtc = true;
void setBlockWebrtc(true);

async function connect(uri, mode) {
  const parsed = parseOlcrtcUri(uri);
  if (parsed.provider !== 'telemost') {
    throw new Error(`Stage 1 only supports telemost, got ${parsed.provider}`);
  }
  if (parsed.transport !== 'vp8channel') {
    throw new Error(`Stage 1 only supports vp8channel, got ${parsed.transport}`);
  }
  const generation = ++connectionGeneration;
  acceptTunnelEvents = true;
  state.exitGeo = null;
  state.exitGeoLookup = { status: 'idle', checkedAt: null, attempts: [] };

  state.mode = mode === 'marker' || mode === 'identity' || mode === 'tunnel' ? mode : 'tunnel';
  state.uriRedacted = redactUri(uri);
  state.error = '';
  state.logs = [];
  resetFlags();
  state.status = 'connecting';
  log(`connect ${state.uriRedacted}`);
  await chrome.storage.local.set({ uri, mode: state.mode });
  broadcast();

  await guardReady;
  // Guard sites before carrier setup or exit-geo lookup begins. Requests in
  // attached tabs fail closed until the tunnel handshake succeeds.
  try {
    await startIntercept();
  } finally {
    state.networkGuard = await isNetworkGuardEnabled();
  }
  broadcast();
  if (generation !== connectionGeneration) return;
  await ensureOffscreen();
  if (generation !== connectionGeneration) return;
  const cfg = {
    roomUrl: parsed.roomUrl,
    roomId: parsed.roomId,
    keyHex: parsed.keyHex,
    channelId: parsed.params.channel || '',
    vp8: parsed.vp8,
    mode: state.mode,
    verboseLogs: state.verboseLogs,
  };
  const res = await sendToOffscreen({ type: 'START', config: cfg });
  if (!res || res.ok === false) {
    const err = res?.error || 'offscreen START failed (no response from offscreen)';
    if (isChannelClosed(err)) {
      log(`(ignored) ${err}`);
      return;
    }
    throw new Error(err);
  }
}

let autoInterceptStarted = false;
let connectionGeneration = 0;
let exitGeoRequest = null;

async function autoIntercept() {
  if (autoInterceptStarted) return;
  autoInterceptStarted = true;
  const generation = connectionGeneration;
  try {
    await resolveAndApplyExitGeo(generation);
    if (generation !== connectionGeneration) return;
    await toggleIntercept(true);
  } catch (err) {
    log(`intercept.auto ${err.message}`);
    state.error = err.message;
    broadcast();
  } finally {
    if (generation === connectionGeneration) autoInterceptStarted = false;
  }
}

function resolveAndApplyExitGeo(generation) {
  if (exitGeoRequest?.generation === generation) return exitGeoRequest.promise;
  const request = { generation };
  request.promise = lookupAndApplyExitGeo(generation).finally(() => {
    if (exitGeoRequest === request) exitGeoRequest = null;
  });
  exitGeoRequest = request;
  return request.promise;
}

async function lookupAndApplyExitGeo(generation) {
  state.exitGeo = null;
  state.exitGeoLookup = { status: 'resolving', checkedAt: null, attempts: [] };
  broadcast();
  try {
    // Each provider has its own timeout; do not cut the second attempt short.
    const geo = await resolveExitGeo((req) => sendToOffscreen({ type: 'HTTP_PROXY', ...req }), {
      onAttempt: (attempt) => {
        if (generation !== connectionGeneration) return;
        state.exitGeoLookup.attempts.push(attempt);
        log(`geo.lookup ${attempt.url} ${attempt.outcome} status=${attempt.status} ms=${attempt.elapsedMs}`);
      },
    });
    if (generation !== connectionGeneration) return;
    if (geo) {
      state.exitGeo = geo;
      state.exitGeoLookup.status = 'resolved';
      log(`geo.profile country=${geo.country} tz=${geo.timezoneId} ip=${geo.ip || ''}`);
    } else {
      state.exitGeoLookup.status = 'unavailable';
      log('geo.profile unverified; using fallback browser profile, exit country unknown');
    }
  } catch (err) {
    if (generation !== connectionGeneration) return;
    state.exitGeoLookup.status = 'unavailable';
    log(`geo.profile unverified (${err.message})`);
  }
  state.exitGeoLookup.checkedAt = new Date().toISOString();
  await applyMergedSpoof();
  if (generation === connectionGeneration) broadcast();
}

function applyMergedSpoof() {
  const profile = buildSpoofProfile({
    geo: state.exitGeo || FALLBACK_GEO_PROFILE,
    settings: state.spoofSettings,
    chromeUa: globalThis.navigator?.userAgent || '',
    token: `${Date.now().toString(36)}`,
  });
  state.spoofProfile = profile;
  return setSpoofProfile(profile);
}

async function toggleIntercept(on) {
  if (on) {
    if (!state.flags.handshakeOk) throw new Error('handshake.ok required');
    await startIntercept();
    state.flags.intercept = true;
    state.flags.interceptLost = false;
    log(`intercept attached: all profile tabs (${state.interceptTabCount || 0} active)`);
    broadcast();
    return;
  }
  await stopIntercept();
  state.flags.intercept = false;
  state.interceptTabCount = 0;
  broadcast();
}

async function disconnect() {
  connectionGeneration++;
  acceptTunnelEvents = false;
  setHandshakeOk(false);
  log('disconnect');
  // Even a failed restoration (for example a controlled browser preference)
  // must not prevent the user from explicitly releasing installed blocks.
  await guardReady.catch(() => {});
  await stopIntercept();
  state.flags.intercept = false;
  try {
    await sendToOffscreen({ type: 'STOP' });
  } catch {
    /* ignore */
  }
  try {
    await chrome.offscreen.closeDocument();
  } catch {
    /* ignore */
  }
  await disableNetworkGuard();
  state.networkGuard = false;
  state.status = 'idle';
  state.exitGeo = null;
  state.exitGeoLookup = { status: 'idle', checkedAt: null, attempts: [] };
  resetFlags();
  void applyMergedSpoof();
  broadcast();
}

let offscreenReadyWaiters = [];

function notifyOffscreenReady() {
  const waiters = offscreenReadyWaiters;
  offscreenReadyWaiters = [];
  for (const resolve of waiters) resolve();
}

function handleOffscreen(msg) {
  if (msg.type === 'LOG' && msg.line) {
    log(msg.line);
    return;
  }
  if (msg.type === 'EVENT' && msg.event) {
    if (!acceptTunnelEvents) return;
    applyEvent(msg.event);
    return;
  }
  if (msg.type === 'OFFSCREEN_READY') {
    log('offscreen.ready');
    notifyOffscreenReady();
    return;
  }
}

function applyEvent(ev) {
  switch (ev.type) {
    case 'auth.ok':
      state.flags.authOk = true;
      break;
    case 'ws.open':
      state.flags.wsOpen = true;
      break;
    case 'hello.sent':
      state.flags.helloSent = true;
      break;
    case 'serverHello':
      state.flags.serverHello = true;
      break;
    case 'sub.connected':
      state.flags.subConnected = true;
      maybeConnected();
      break;
    case 'pub.connected':
      state.flags.pubConnected = true;
      maybeConnected();
      break;
    case 'sender.transform.attached':
      state.flags.senderTransform = true;
      break;
    case 'remote.vp8':
      state.flags.remoteVp8 = true;
      break;
    case 'transform.stats':
      state.flags.transformIn = ev.in || 0;
      state.flags.transformOut = ev.out || 0;
      if (typeof ev.handshakeOk === 'boolean') {
        const changed = state.flags.handshakeOk !== ev.handshakeOk;
        state.flags.handshakeOk = ev.handshakeOk;
        setHandshakeOk(ev.handshakeOk);
        if (ev.handshakeOk && changed) void autoIntercept();
      }
      if (typeof ev.pingOk === 'boolean') state.flags.pingOk = ev.pingOk;
      if (typeof ev.tokenOk === 'boolean') state.flags.tokenOk = ev.tokenOk;
      if (ev.token) state.flags.token = ev.token;
      break;
    case 'tunnel.flags':
      if (typeof ev.handshakeOk === 'boolean') {
        const changed = state.flags.handshakeOk !== ev.handshakeOk;
        state.flags.handshakeOk = ev.handshakeOk;
        setHandshakeOk(ev.handshakeOk);
        if (ev.handshakeOk && changed) void autoIntercept();
      }
      if (typeof ev.pingOk === 'boolean') state.flags.pingOk = ev.pingOk;
      if (typeof ev.tokenOk === 'boolean') state.flags.tokenOk = ev.tokenOk;
      break;
    case 'pc.failed':
      fail(`${ev.side} PC ${ev.state}`);
      return;
    case 'ws.close':
    case 'ws.dead':
    case 'conference.ended':
      if (state.status === 'connected' || state.status === 'connecting') {
        fail(ev.type);
        return;
      }
      break;
    default:
      break;
  }
  broadcast();
}

function maybeConnected() {
  if (state.flags.subConnected && state.status === 'connecting') {
    state.status = 'connected';
  }
}

function isChannelClosed(message) {
  return /message channel closed/i.test(String(message || ''));
}

function fail(message) {
  if (isChannelClosed(message)) {
    log(`(ignored) ${message}`);
    return;
  }
  state.status = 'error';
  state.flags.handshakeOk = false;
  setHandshakeOk(false);
  state.error = message;
  log(`error ${message}`);
  broadcast();
}

function log(line) {
  const isEvent = EVENT_RE.test(String(line));
  const isCritical = /error|fail|intercept|connected|handshake|auth\.ok|lost|warn|connect\s|disconnect|geo\.profile|spoof\.|fetch\.enable|fetch\.fulfill|cookie\./i.test(String(line));
  if (!state.verboseLogs && !isCritical) {
    return;
  }
  const entry = `${new Date().toISOString()} ${line}`;
  if (isEvent) {
    state.events.push(entry);
    if (state.events.length > EVENT_CAP) {
      state.events.splice(0, state.events.length - EVENT_CAP);
    }
  } else {
    state.logs.push(entry);
    if (state.logs.length > LOG_CAP) {
      state.logs.splice(0, state.logs.length - LOG_CAP);
    }
  }
  if (state.verboseLogs) {
    console.log('[olc]', line);
  }
}

function publicState() {
  const count = state.interceptTabCount || 0;
  return {
    status: state.status,
    error: state.error,
    mode: state.mode,
    verboseLogs: state.verboseLogs,
    uriRedacted: state.uriRedacted,
    interceptUrl: state.flags.intercept ? `Profile (${count} tab${count === 1 ? '' : 's'})` : '',
    interceptTabCount: count,
    networkGuard: state.networkGuard,
    flags: { ...state.flags },
    interceptStats: getInterceptStats(),
    events: state.events.slice(-80),
    logs: state.logs.slice(-80),
    spoof: {
      exitLookup: { ...state.exitGeoLookup, attempts: state.exitGeoLookup.attempts.map((attempt) => ({ ...attempt })) },
      browserGeo: {
        country: state.spoofProfile?.country || FALLBACK_GEO_PROFILE.country,
        timezoneId: state.spoofProfile?.timezoneId || FALLBACK_GEO_PROFILE.timezoneId,
        fallback: !state.exitGeo,
      },
      settings: { ...state.spoofSettings },
      locale: state.spoofProfile?.locale || '',
      userAgent: state.spoofProfile?.userAgent || '',
      hardwareConcurrency: state.spoofProfile?.hardwareConcurrency ?? 8,
      exit: state.exitGeo
        ? {
            ip: state.exitGeo.ip || '',
            country: state.exitGeo.country,
            timezoneId: state.exitGeo.timezoneId,
            latitude: state.exitGeo.latitude,
            longitude: state.exitGeo.longitude,
          }
        : null,
    },
  };
}

function broadcast() {
  chrome.runtime.sendMessage({ source: 'sw', type: 'STATE', state: publicState() }).catch(() => {});
}

function resetFlags() {
  state.interceptTabCount = 0;
  state.flags = {
    authOk: false,
    wsOpen: false,
    helloSent: false,
    serverHello: false,
    subConnected: false,
    pubConnected: false,
    senderTransform: false,
    remoteVp8: false,
    transformIn: 0,
    transformOut: 0,
    tokenOk: false,
    handshakeOk: false,
    pingOk: false,
    token: 0,
    intercept: false,
    interceptLost: false,
    blockWebrtc: state.flags.blockWebrtc !== false,
  };
  setHandshakeOk(false);
  autoInterceptStarted = false;
}

async function ensureOffscreen() {
  const exists = await hasOffscreen();
  if (exists) {
    const pong = await sendToOffscreen({ type: 'PING_OFFSCREEN' });
    if (pong?.ok) return;
  }
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['WEB_RTC'],
      justification: 'Hold RTCPeerConnection and dummy VP8 track for Telemost olcRTC media path',
    });
  } catch (err) {
    const m = String(err?.message || err);
    if (!m.includes('single offscreen') && !m.includes('already exists')) {
      throw err;
    }
  }
  await waitOffscreenReady(5000);
}

async function hasOffscreen() {
  if (chrome.offscreen?.hasDocument) {
    const v = chrome.offscreen.hasDocument();
    return v instanceof Promise ? v : Boolean(v);
  }
  const ctxs = await chrome.runtime.getContexts?.({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return Boolean(ctxs?.length);
}

function waitOffscreenReady(timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let timer = null;
    let done = false;

    const onReady = () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve();
    };

    timer = setTimeout(() => {
      const idx = offscreenReadyWaiters.indexOf(onReady);
      if (idx >= 0) offscreenReadyWaiters.splice(idx, 1);
      // Fallback check before rejecting: ping offscreen in case event was missed
      sendToOffscreen({ type: 'PING_OFFSCREEN' })
        .then((res) => {
          if (res?.ok) {
            if (!done) {
              done = true;
              resolve();
            }
          } else {
            if (!done) {
              done = true;
              reject(new Error('offscreen ready timeout'));
            }
          }
        })
        .catch(() => {
          if (!done) {
            done = true;
            reject(new Error('offscreen ready timeout'));
          }
        });
    }, timeoutMs);

    offscreenReadyWaiters.push(onReady);

    // Also proactively ping in case offscreen is already initialized
    sendToOffscreen({ type: 'PING_OFFSCREEN' })
      .then((res) => {
        if (res?.ok && !done) {
          done = true;
          const idx = offscreenReadyWaiters.indexOf(onReady);
          if (idx >= 0) offscreenReadyWaiters.splice(idx, 1);
          if (timer) clearTimeout(timer);
          resolve();
        }
      })
      .catch(() => {});
  });
}

function sendToOffscreen(payload) {
  return chrome.runtime.sendMessage({ source: 'sw', dest: 'offscreen', ...payload }).catch((err) => {
    const message = err.message || String(err);
    if (isChannelClosed(message)) {
      log(`(ignored) ${message}`);
      return { ok: true, ignored: true };
    }
    log(`error offscreen message failed: ${message}`);
    return { ok: false, error: message };
  });
}

function pingOffscreen() {
  chrome.runtime.sendMessage({ source: 'sw', type: 'PING_OFFSCREEN' }).catch(() => {});
}
