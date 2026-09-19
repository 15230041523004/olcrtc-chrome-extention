import { resolveCdpPostBody } from './cdp-post.js';
import { WEBRTC_BLOCK_SOURCE } from './webrtc-block.js';
import { CONFIG, getMaxBodyBytes } from './config.js';
import { FALLBACK_GEO_PROFILE } from './geo-spoof.js';
import { enableNetworkGuard, allowInterceptedTab, blockUnattachedTab, clearInterceptedTabs } from './network-guard.js';
import {
  applyHeaderSpoof,
  buildSpoofProfile,
  DEFAULT_SPOOF_SETTINGS,
  fingerprintSpoofSource,
  spoofLogLine,
} from './fingerprint-spoof.js';

const PROTOCOL = '1.3';
/** example.com is HSTS-preloaded; http:// always upgrades to https. */
export const HTTP_TEST_URL = 'http://neverssl.com/';

const attachedTabs = new Map(); // tabId -> { url: string, webrtcScriptId: string | null, spoofScriptId: string | null }
const attaching = new Map(); // tabId -> Promise<boolean>
const childSessions = new Map();
let interceptGeneration = 0;
const reloadedAfterAttach = new Set();
const pendingNavigations = new Set();
const ATTACH_RETRIES = 3;
const ATTACH_RETRY_MS = [50, 100, 150];
const RECOVER_GAP_MS = 200;
let recoverChain = Promise.resolve();
let interceptActive = false;
let onLog = () => {};
let onLost = () => {};
let onTabCountChange = () => {};
let proxyFn = async () => ({ ok: false, error: 'no proxy' });
let handshakeOk = false;
let blockWebrtc = true;
let pauseCount = 0;
let spoofProfile = buildSpoofProfile({
  geo: FALLBACK_GEO_PROFILE,
  settings: DEFAULT_SPOOF_SETTINGS,
  chromeMajor: 141,
  token: 'init',
});

const cookieCache = new Map(); // origin -> { cookieStr, expiresAt }
const COOKIE_CACHE_TTL_MS = 5000;

if (typeof chrome !== 'undefined' && chrome.cookies?.onChanged) {
  chrome.cookies.onChanged.addListener(() => {
    cookieCache.clear();
  });
}

export function clearCookieCache() {
  cookieCache.clear();
}

const responseCache = new Map(); // key -> { status, statusText, headers, bodyB64, body, bodyLength, expiresAt, size }
let currentCacheBytes = 0;

export function clearResponseCache() {
  responseCache.clear();
  currentCacheBytes = 0;
}

const inflightRequests = new Map(); // key -> { promise, waiters }

export const interceptStats = {
  cacheHits: 0,
  coalesceHits: 0,
  cacheMisses: 0,
  telemetryBlocked: 0,
  bytesSaved: 0,
};

export function getInterceptStats() {
  return {
    ...interceptStats,
    cacheItems: responseCache.size,
    cacheBytes: currentCacheBytes,
    inflightCount: inflightRequests.size,
  };
}

export function resetInterceptStats() {
  interceptStats.cacheHits = 0;
  interceptStats.coalesceHits = 0;
  interceptStats.cacheMisses = 0;
  interceptStats.telemetryBlocked = 0;
  interceptStats.bytesSaved = 0;
}

export const SWR_GRACE_MS = 60 * 60 * 1000; // 1 hour stale grace period for static assets

export function getCachedResponse(key, url = '') {
  if (CONFIG.cacheEnabled === false) return null;
  const item = responseCache.get(key);
  if (!item) return null;
  const now = Date.now();
  if (now > item.expiresAt) {
    if (url && isStaticAssetUrl(url) && now <= item.expiresAt + SWR_GRACE_MS) {
      // Serve stale static asset for instant 0ms serve, marked for background revalidation
      responseCache.delete(key);
      responseCache.set(key, item);
      return { ...item, isStale: true };
    }
    responseCache.delete(key);
    currentCacheBytes -= item.size;
    return null;
  }
  // LRU touch: move to end
  responseCache.delete(key);
  responseCache.set(key, item);
  return item;
}

function revalidateInBackground(cacheKey, req, url) {
  if (inflightRequests.has(cacheKey)) return;
  void proxyFn({
    method: req.method || 'GET',
    url,
    headers: req.headers || {},
    body: null,
  })
    .then((freshRes) => {
      if (freshRes?.ok) {
        if (freshRes.bodyB64 == null && freshRes.body) {
          freshRes.bodyB64 = u8ToB64(
            freshRes.body instanceof Uint8Array ? freshRes.body : Uint8Array.from(freshRes.body),
          );
        }
        putCachedResponse(cacheKey, freshRes, url);
        onLog(`fetch.cache-revalidated ${url.slice(0, 80)}`);
      }
    })
    .catch(() => {});
}

export function isGraphQlQuery(bodyU8, url = '') {
  if (!bodyU8 || !bodyU8.length) return false;
  const isGqlUrl = url.includes('/graphql') || url.includes('/gql');
  if (!isGqlUrl) return false;
  try {
    const text = new TextDecoder().decode(bodyU8);
    if (text.includes('"mutation"') || text.includes('mutation ') || text.includes('mutation{')) {
      return false;
    }
    return text.includes('"query"') || text.includes('query ') || text.includes('query{');
  } catch {
    return false;
  }
}

export function fastBodyHash(u8) {
  if (!u8 || !u8.length) return '0';
  let h = 0x811c9dc5;
  for (let i = 0; i < u8.length; i++) {
    h ^= u8[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

export function isStaticAssetUrl(url) {
  try {
    const p = new URL(url);
    const path = p.pathname.toLowerCase();
    return (
      /\.(svg|woff2?|ttf|eot|png|jpe?g|webp|gif|ico|css|js|map)$/i.test(path) ||
      path.includes('/assets/') ||
      path.includes('/themes/') ||
      path.includes('/static/') ||
      p.hostname.startsWith('static.') ||
      p.hostname.startsWith('pic.') ||
      p.hostname.startsWith('st.')
    );
  } catch {
    return false;
  }
}

export function getCacheTtlMs(url, res = {}) {
  // Check Cache-Control max-age header if available
  const cc = (res.headers || []).find((h) => h.name?.toLowerCase() === 'cache-control')?.value || '';
  const match = cc.match(/max-age=(\d+)/i);
  if (match) {
    const maxAgeSec = parseInt(match[1], 10);
    if (Number.isFinite(maxAgeSec) && maxAgeSec > 0) {
      return Math.min(600_000, Math.max(30_000, maxAgeSec * 1000));
    }
  }

  // Static assets get 5 minutes (CONFIG.cacheStaticTtlMs)
  if (isStaticAssetUrl(url)) {
    return CONFIG.cacheStaticTtlMs || 300_000;
  }

  // Default dynamic API gets 30 seconds (CONFIG.cacheTtlMs)
  return CONFIG.cacheTtlMs || 30_000;
}

export function putCachedResponse(key, res, url = '') {
  if (CONFIG.cacheEnabled === false) return;
  if (res.status !== 200 && res.status !== 206) return;
  const headers = res.headers || [];
  const cacheControl = headers.filter((h) => h.name?.toLowerCase() === 'cache-control').map((h) => h.value).join(',');
  if (/\b(no-store|no-cache|private)\b/i.test(cacheControl)) return;
  if (headers.some((h) => h.name?.toLowerCase() === 'set-cookie')) return;
  if (isSessionSensitiveUrl(url)) return;
  const bodyLen = res.bodyLength ?? (res.body?.length || 0);
  const maxItem = CONFIG.cacheMaxItemBytes || 4 * 1024 * 1024;
  if (bodyLen > maxItem || bodyLen === 0) return;

  const maxTotal = CONFIG.cacheMaxBytes || 512 * 1024 * 1024;
  const ttl = getCacheTtlMs(url, res);
  const itemSize = bodyLen;

  while (currentCacheBytes + itemSize > maxTotal && responseCache.size > 0) {
    const oldestKey = responseCache.keys().next().value;
    const oldItem = responseCache.get(oldestKey);
    responseCache.delete(oldestKey);
    if (oldItem) currentCacheBytes -= oldItem.size;
  }

  const item = {
    status: res.status,
    statusText: res.statusText || 'OK',
    headers: res.headers || [],
    bodyB64: res.bodyB64 || '',
    bodyLength: bodyLen,
    size: itemSize,
    expiresAt: Date.now() + ttl,
  };
  responseCache.set(key, item);
  currentCacheBytes += itemSize;
}

export function configureIntercept({ log, proxy, lost, tabCount }) {
  onLog = log || onLog;
  proxyFn = proxy || proxyFn;
  onLost = lost || onLost;
  onTabCountChange = tabCount || onTabCountChange;
}

export function setHandshakeOk(ok) {
  if (!ok && handshakeOk) reloadedAfterAttach.clear();
  handshakeOk = Boolean(ok);
}

export function interceptTabId() {
  return attachedTabs.keys().next().value || null;
}

export function getAttachedTabCount() {
  return attachedTabs.size;
}

export function getAttachedTabs() {
  return Array.from(attachedTabs.entries()).map(([id, info]) => ({ id, url: info.url }));
}

export function isInterceptActive() {
  return interceptActive;
}

export async function setBlockWebrtc(on) {
  blockWebrtc = Boolean(on);
  onLog(`webrtc.block ${blockWebrtc ? 'on' : 'off'} (active tabs: ${attachedTabs.size})`);
  for (const [id, info] of attachedTabs.entries()) {
    info.webrtcScriptId = await applyWebrtcBlock(id);
  }
}

export function webrtcBlocked() {
  return blockWebrtc;
}

export function getSpoofProfile() {
  return spoofProfile;
}

export async function setSpoofProfile(profile) {
  spoofProfile = profile || spoofProfile;
  onLog(spoofLogLine(spoofProfile));
  for (const [id, info] of attachedTabs.entries()) {
    info.spoofScriptId = await applySpoof(id, info.spoofScriptId);
  }
  for (const info of childSessions.values()) {
    info.spoofScriptId = await applySpoof(info.source, info.spoofScriptId, info.type === 'iframe');
  }
}

function skipUrl(url) {
  return (
    !url ||
    url.startsWith('data:') ||
    url.startsWith('blob:') ||
    url.startsWith('chrome:') ||
    url.startsWith('chrome-extension:') ||
    url.startsWith('edge:') ||
    url.startsWith('devtools:') ||
    url.startsWith('about:')
  );
}

export function isPrivilegedTabUrl(url) {
  return skipUrl(url) || (url && !url.startsWith('http://') && !url.startsWith('https://'));
}

function isHttpish(url) {
  return typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'));
}

const GOOGLE_AUTH_COOKIE_RE =
  /^(SID|HSID|SSID|APISID|SAPISID|NID|LSID|OSID|SIDCC|ACCOUNT_CHOOSER|GAPS|SMSV|LSOLH|__Host-GAPS|__Secure-OSID|__Secure-\d*(PSID|PAPISID|PSIDTS|PSIDCC).*)$/i;

export function isGoogleAccountHost(urlOrHost) {
  let h = String(urlOrHost || '').toLowerCase();
  if (h.includes('://')) {
    try {
      h = new URL(h).hostname.toLowerCase();
    } catch {
      return false;
    }
  }
  return (
    h === 'google.com' ||
    h.endsWith('.google.com') ||
    h === 'youtube.com' ||
    h.endsWith('.youtube.com') ||
    h === 'googleapis.com' ||
    h.endsWith('.googleapis.com') ||
    h === 'gstatic.com' ||
    h.endsWith('.gstatic.com') ||
    h === 'googleusercontent.com' ||
    h.endsWith('.googleusercontent.com') ||
    h === 'ggpht.com' ||
    h.endsWith('.ggpht.com') ||
    h === 'googlemail.com' ||
    h.endsWith('.googlemail.com')
  );
}

export function isGoogleAuthCookieName(name) {
  return GOOGLE_AUTH_COOKIE_RE.test(String(name || '').trim());
}

/** name=value pairs from the profile jar at intercept start. New login cookies must not match. */
let googleAuthCookieSnapshot = new Set();

export function setGoogleAuthCookieSnapshot(pairs) {
  googleAuthCookieSnapshot = new Set(pairs || []);
}

export function getGoogleAuthCookieSnapshot() {
  return googleAuthCookieSnapshot;
}

export async function snapshotGoogleAuthCookiesFromStore() {
  const pairs = new Set();
  if (typeof chrome !== 'undefined' && chrome.cookies?.getAll) {
    const domains = ['.google.com', 'google.com', '.youtube.com', '.googleusercontent.com'];
    for (const domain of domains) {
      try {
        const cookies = await chrome.cookies.getAll({ domain });
        for (const c of cookies || []) {
          if (isGoogleAuthCookieName(c.name) && c.value != null && c.value !== '') {
            pairs.add(`${c.name}=${c.value}`);
          }
        }
      } catch {
        /* ignore */
      }
    }
  }
  googleAuthCookieSnapshot = pairs;
  return pairs.size;
}

function cookiePair(name, value) {
  return `${name}=${value}`;
}

export function stripGoogleAuthCookies(cookieStr, snapshot = googleAuthCookieSnapshot) {
  const snap = snapshot instanceof Set ? snapshot : new Set(snapshot || []);
  const stripped = [];
  const kept = [];
  for (const part of String(cookieStr || '').split(';')) {
    const piece = part.trim();
    if (!piece) continue;
    const eq = piece.indexOf('=');
    const name = (eq >= 0 ? piece.slice(0, eq) : piece).trim();
    const value = eq >= 0 ? piece.slice(eq + 1) : '';
    if (snap.has(cookiePair(name, value))) stripped.push(name);
    else kept.push(piece);
  }
  return { cookie: kept.join('; '), stripped };
}

export function applyGoogleAuthCookieStrip(headers, url) {
  if (!headers || !isGoogleAccountHost(url)) return 0;
  if (!googleAuthCookieSnapshot.size) return 0;
  let key = null;
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === 'cookie') {
      key = k;
      break;
    }
  }
  if (!key) return 0;
  const { cookie, stripped } = stripGoogleAuthCookies(headers[key]);
  if (!stripped.length) return 0;
  if (cookie) headers[key] = cookie;
  else delete headers[key];
  return stripped.length;
}

export async function pickHttpTab() {
  if (typeof chrome === 'undefined' || !chrome.tabs) return null;
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const activeUrl = active?.url || '';
  if (active?.id && (activeUrl.startsWith('http://') || activeUrl.startsWith('https://'))) {
    onLog(`intercept.pick tab=${active.id} url=${activeUrl} (active)`);
    return active;
  }
  const httpTabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  const preferred =
    httpTabs.find((t) => (t.url || '').includes('neverssl.com')) || httpTabs[0];
  if (preferred?.id && isHttpish(preferred.url || '')) {
    onLog(`intercept.pick tab=${preferred.id} url=${preferred.url}`);
    return preferred;
  }
  const created = await chrome.tabs.create({ url: HTTP_TEST_URL, active: false });
  onLog(`intercept.pick tab=${created.id} url=${HTTP_TEST_URL} (created)`);
  return created;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isAlreadyAttachedError(msg) {
  return String(msg || '')
    .toLowerCase()
    .includes('already attached');
}

function isForeignDebuggerError(msg) {
  return String(msg || '')
    .toLowerCase()
    .includes('another debugger');
}

function isDebuggerNotAttachedError(msg) {
  const s = String(msg || '').toLowerCase();
  return s.includes('debugger is not attached') || s.includes('not attached to the tab');
}

async function probeDebugger(id) {
  try {
    await chrome.debugger.sendCommand({ tabId: id }, 'Runtime.evaluate', { expression: '1' });
    return true;
  } catch {
    return false;
  }
}

export function isUnsupportedCountryPath(url) {
  try {
    const path = new URL(url).pathname.replace(/\/+$/, '') || '/';
    return path === '/unsupported-country';
  } catch {
    return false;
  }
}

function enqueueRecover(fn) {
  const run = recoverChain.then(fn, fn);
  recoverChain = run
    .then(() => sleep(RECOVER_GAP_MS))
    .catch(() => {});
  return run;
}

async function recoverTabAfterAttach(id, url) {
  if (!handshakeOk || !attachedTabs.has(id)) return;
  if (reloadedAfterAttach.has(id)) return;
  if (!isHttpish(url)) return;
  if (typeof chrome === 'undefined' || !chrome.tabs) return;

  const geoBlock = isUnsupportedCountryPath(url);
  if (!geoBlock) {
    let active = false;
    try {
      const tab = await chrome.tabs.get(id);
      active = Boolean(tab?.active);
    } catch {
      return;
    }
    if (!active && !pendingNavigations.has(id)) return;
  }

  reloadedAfterAttach.add(id);
  pendingNavigations.delete(id);
  await enqueueRecover(() => recoverTabNow(id, url, geoBlock));
}

async function recoverTabNow(id, url, geoBlock) {
  try {
    if (geoBlock && chrome.tabs.update) {
      const dest = `${new URL(url).origin}/`;
      await chrome.tabs.update(id, { url: dest });
      onLog(`intercept.navigate tab=${id} ${dest}`);
      return;
    }
    if (!chrome.tabs.reload) {
      reloadedAfterAttach.delete(id);
      return;
    }
    await chrome.tabs.reload(id, { bypassCache: true });
    onLog(`intercept.reload tab=${id}`);
  } catch (err) {
    reloadedAfterAttach.delete(id);
    onLog(`intercept.recover error tab=${id}: ${err.message}`);
  }
}

/**
 * Attach debugger + Fetch.enable. Concurrent calls for the same tab share one in-flight promise.
 * Only the call that successfully attached may detach on failure.
 */
export function attachTab(id, tabUrl) {
  if (id == null) return Promise.resolve(false);
  if (typeof chrome === 'undefined' || !chrome.debugger) return Promise.resolve(false);

  const existing = attaching.get(id);
  if (existing) return existing;
  const generation = interceptGeneration;

  const p = (async () => {
    if (attachedTabs.has(id)) {
      const live = await probeDebugger(id);
      if (live) {
        if (tabUrl && isHttpish(tabUrl)) attachedTabs.get(id).url = tabUrl;
        return true;
      }
      onLog(`intercept.stale tab=${id} (debugger gone, retrying)`);
      attachedTabs.delete(id);
      onTabCountChange(attachedTabs.size);
    }
    return attachTabOnce(id, tabUrl, generation);
  })().finally(() => {
    if (attaching.get(id) === p) attaching.delete(id);
  });
  attaching.set(id, p);
  return p;
}

async function attachTabOnce(id, tabUrl, generation) {
  let url = tabUrl;
  if (!url && chrome.tabs?.get) {
    try {
      const tab = await chrome.tabs.get(id);
      url = tab?.pendingUrl || tab?.url || '';
    } catch {
      return false;
    }
  }
  if (!isHttpish(url)) return false;

  onLog(`intercept.attach try tab=${id} url=${url.slice(0, 80)}`);

  let lastErr = '';
  for (let attempt = 1; attempt <= ATTACH_RETRIES; attempt++) {
    if (generation !== interceptGeneration) return false;
    const result = await tryAttach(id, url, attempt, generation);
    if (result.ok) return true;
    lastErr = result.reason || '';
    if (result.fatal) {
      onLog(`intercept.attach fail tab=${id} reason=${lastErr}`);
      return false;
    }
    if (attempt < ATTACH_RETRIES) await sleep(ATTACH_RETRY_MS[attempt - 1] || 100);
  }
  onLog(`intercept.attach fail tab=${id} reason=${lastErr || 'exhausted'}`);
  return false;
}

async function tryAttach(id, url, attempt, generation) {
  let weAttached = false;

  try {
    await chrome.debugger.attach({ tabId: id }, PROTOCOL);
    weAttached = true;
    onLog(`intercept.attach ok tab=${id} attempt=${attempt}`);
  } catch (err) {
    const msg = String(err?.message || err);
    if (isForeignDebuggerError(msg)) {
      return { ok: false, fatal: true, reason: 'foreign debugger' };
    } else if (isAlreadyAttachedError(msg)) {
      onLog(`intercept.attach already tab=${id} attempt=${attempt}`);
    } else {
      return { ok: false, fatal: !isDebuggerNotAttachedError(msg), reason: msg };
    }
  }

  // Register before enabling Fetch: Chrome can immediately emit paused requests.
  attachedTabs.set(id, { url, webrtcScriptId: null, spoofScriptId: null });
  try {
    await chrome.debugger.sendCommand({ tabId: id }, 'Fetch.enable', {
      patterns: [{ urlPattern: '*', requestStage: 'Request' }],
    });
    await configureNetworkSession({ tabId: id });
    onLog(`fetch.enable ok tab=${id} attempt=${attempt}`);
  } catch (err) {
    const msg = String(err?.message || err);
    onLog(`fetch.enable fail tab=${id} attempt=${attempt} reason=${msg}`);
    attachedTabs.delete(id);
    await blockUnattachedTab(id);
    if (weAttached) {
      try {
        await chrome.debugger.detach({ tabId: id });
      } catch {}
    }
    return { ok: false, fatal: false, reason: msg };
  }

  const webrtcScriptId = await applyWebrtcBlock(id);
  const spoofScriptId = await applySpoof(id, null);
  if ((blockWebrtc && !webrtcScriptId) || !spoofScriptId || attachedTabs.get(id)?.protectionFailed) {
    await detachTab(id);
    return { ok: false, fatal: true, reason: 'page protection could not be installed' };
  }
  if (generation !== interceptGeneration) {
    await blockUnattachedTab(id);
    await detachTab(id);
    return { ok: false, fatal: true, reason: 'interception stopped' };
  }
  attachedTabs.set(id, { url, webrtcScriptId, spoofScriptId });
  await allowInterceptedTab(id);
  if (generation !== interceptGeneration) {
    await blockUnattachedTab(id);
    await detachTab(id);
    return { ok: false, fatal: true, reason: 'interception stopped' };
  }
  onLog(`intercept.attached tab=${id} total=${attachedTabs.size} url=${url.slice(0, 80)}`);
  onTabCountChange(attachedTabs.size);
  await recoverTabAfterAttach(id, url);
  return { ok: true };
}

export async function detachTab(id) {
  if (!attachedTabs.has(id)) return;
  await blockUnattachedTab(id);
  attachedTabs.delete(id);
  forgetChildSessions(id);
  if (typeof chrome !== 'undefined' && chrome.debugger) {
    try {
      await chrome.debugger.sendCommand({ tabId: id }, 'Fetch.disable');
    } catch {}
    try {
      await chrome.debugger.detach({ tabId: id });
    } catch {}
  }
  onLog(`intercept.detached tab=${id} remaining=${attachedTabs.size}`);
  onTabCountChange(attachedTabs.size);
}

export async function startIntercept(targetTabId = null) {
  const generation = interceptGeneration;
  const starting = !interceptActive;
  if (starting) await enableNetworkGuard();
  if (generation !== interceptGeneration) return;
  interceptActive = true;
  pauseCount = 0;
  if (starting) {
    clearResponseCache();
    clearCookieCache();
    try {
      const n = await snapshotGoogleAuthCookiesFromStore();
      onLog(`cookie.snapshot n=${n}`);
    } catch (err) {
      onLog(`cookie.snapshot error ${err.message}`);
    }
  }
  if (generation !== interceptGeneration) return;

  if (targetTabId != null) {
    await attachTab(targetTabId);
    return;
  }

  // Intercept all profile tabs
  if (typeof chrome !== 'undefined' && chrome.tabs?.query) {
    let tabs = [];
    try {
      tabs = await chrome.tabs.query({});
    } catch (err) {
      onLog(`tabs.query error ${err.message}`);
    }

    let attachedCount = 0;
    for (const tab of tabs) {
      if (generation !== interceptGeneration) return;
      const url = tab.pendingUrl || tab.url || '';
      if (tab?.id && isHttpish(url)) {
        const ok = await attachTab(tab.id, url);
        if (ok) {
          attachedCount++;
          await recoverTabAfterAttach(tab.id, url);
        }
      }
    }

    // If no http tabs exist yet, open a landing test tab
    if (attachedCount === 0 && tabs.length > 0) {
      const hasAnyHttp = tabs.some((t) => isHttpish(t.url || ''));
      if (!hasAnyHttp) {
        try {
          const created = await chrome.tabs.create({ url: HTTP_TEST_URL, active: false });
          onLog(`intercept.created landing tab=${created.id} url=${HTTP_TEST_URL}`);
        } catch (err) {
          onLog(`intercept.tabCreate error ${err.message}`);
        }
      }
    }
  }

  onLog(`intercept.all active=true attached=${attachedTabs.size}`);
  onTabCountChange(attachedTabs.size);
}

export async function stopIntercept() {
  interceptActive = false;
  interceptGeneration++;
  await clearInterceptedTabs();
  await Promise.allSettled([...attaching.values()]);
  if (typeof chrome !== 'undefined' && chrome.debugger) {
    const ids = Array.from(attachedTabs.keys());
    for (const id of ids) {
      try {
        await chrome.debugger.sendCommand({ tabId: id }, 'Fetch.disable');
      } catch {}
      try {
        await chrome.debugger.detach({ tabId: id });
      } catch {}
    }
  }
  attachedTabs.clear();
  childSessions.clear();
  attaching.clear();
  reloadedAfterAttach.clear();
  pendingNavigations.clear();
  recoverChain = Promise.resolve();
  onLog('intercept.off all tabs detached');
  onTabCountChange(0);
}

if (typeof chrome !== 'undefined' && chrome.tabs) {
  chrome.tabs.onCreated?.addListener((tab) => {
    if (!interceptActive) return;
    if (!tab?.id) return;
    const url = tab.pendingUrl || tab.url || '';
    if (isHttpish(url)) {
      pendingNavigations.add(tab.id);
      void attachTab(tab.id, url).catch((err) => onLog(`intercept.attach error ${err.message}`));
    }
  });

  chrome.tabs.onUpdated?.addListener((tabId, changeInfo, tab) => {
    if (!interceptActive) return;
    const url = changeInfo.url || tab?.pendingUrl || tab?.url || '';
    if (isHttpish(url) && (changeInfo.url || !attachedTabs.has(tabId))) {
      if (!attachedTabs.has(tabId)) pendingNavigations.add(tabId);
      void attachTab(tabId, url).catch((err) => onLog(`intercept.attach error ${err.message}`));
    }
  });

  chrome.tabs.onRemoved?.addListener((tabId) => {
    void blockUnattachedTab(tabId).catch((err) => onLog(`guard.error ${err.message}`));
    forgetChildSessions(tabId);
    attaching.delete(tabId);
    reloadedAfterAttach.delete(tabId);
    pendingNavigations.delete(tabId);
    if (attachedTabs.has(tabId)) {
      attachedTabs.delete(tabId);
      onLog(`intercept.tabClosed tab=${tabId} remaining=${attachedTabs.size}`);
      onTabCountChange(attachedTabs.size);
    }
  });
}

if (typeof chrome !== 'undefined' && chrome.webNavigation?.onBeforeNavigate) {
  chrome.webNavigation.onBeforeNavigate.addListener((details) => {
    if (!interceptActive) return;
    if (details.frameId !== 0) return;
    if (isHttpish(details.url)) {
      if (!attachedTabs.has(details.tabId)) pendingNavigations.add(details.tabId);
      void attachTab(details.tabId, details.url).catch((err) => onLog(`intercept.attach error ${err.message}`));
    }
  });
}

if (typeof chrome !== 'undefined' && chrome.debugger) {
  chrome.debugger.onDetach?.addListener((source, reason) => {
    const id = source?.tabId;
    if (id && attachedTabs.has(id)) {
      attachedTabs.delete(id);
      forgetChildSessions(id);
      onLog(`intercept.detached tab=${id} reason=${reason || ''} remaining=${attachedTabs.size}`);
      onTabCountChange(attachedTabs.size);
      // Chrome notifies us after detach; revoking the HTTP exception is async.
      // This reduces exposure but is not an OS-level, atomic kill switch.
      void blockUnattachedTab(id).then(() => {
        if (interceptActive) return attachTab(id);
      }).catch((err) => onLog(`guard.error ${err.message}`));
      if (attachedTabs.size === 0 && interceptActive) {
        onLost(reason || 'all detached');
      }
    }
  });


  chrome.debugger.onEvent?.addListener((source, method, params) => {
    if (!attachedTabs.has(source.tabId)) return;
    if (method === 'Target.attachedToTarget') {
      void attachChildSession(source, params);
    } else if (method === 'Target.detachedFromTarget') {
      childSessions.delete(`${source.tabId}:${params.sessionId}`);
    } else if (method === 'Runtime.executionContextCreated' && params.context?.auxData?.isDefault) {
      void chrome.debugger.sendCommand(source, 'Runtime.evaluate', {
        expression: `${blockWebrtc ? WEBRTC_BLOCK_SOURCE : ''}\n${fingerprintSpoofSource(spoofProfile)}`,
        contextId: params.context.id,
      }).catch((err) => onLog(`intercept.context ${err.message}`));
    } else if (method === 'Fetch.requestPaused') {
      void handlePaused(source, params);
    }
  });
}

async function configureNetworkSession(source) {
  await chrome.debugger.sendCommand(source, 'Network.enable');
  await chrome.debugger.sendCommand(source, 'Network.setBypassServiceWorker', { bypass: true });
  await chrome.debugger.sendCommand(source, 'Network.setCacheDisabled', { cacheDisabled: true });
  await chrome.debugger.sendCommand(source, 'Runtime.enable');
  await chrome.debugger.sendCommand(source, 'Target.setAutoAttach', {
    autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
    filter: [
      { type: 'iframe', exclude: false }, { type: 'worker', exclude: false },
      { type: 'shared_worker', exclude: false }, { type: 'service_worker', exclude: false },
      { exclude: true },
    ],
  });
}

function forgetChildSessions(tabId) {
  for (const [key, info] of childSessions) {
    if (info.source.tabId === tabId) childSessions.delete(key);
  }
}

async function attachChildSession(parent, params) {
  const source = { tabId: parent.tabId, sessionId: params.sessionId };
  const key = `${source.tabId}:${source.sessionId}`;
  const info = { source, type: params.targetInfo?.type, spoofScriptId: null };
  childSessions.set(key, info);
  try {
    // Dedicated worker loaders inherit Fetch interception from the owning page;
    // Chrome does not expose the Fetch domain on the worker's own CDP session.
    if (info.type !== 'worker') {
      await chrome.debugger.sendCommand(source, 'Fetch.enable', {
        patterns: [{ urlPattern: '*', requestStage: 'Request' }],
      });
    }
    await configureNetworkSession(source);
    if (info.type === 'iframe') await applyWebrtcBlock(source);
    else if (blockWebrtc) await chrome.debugger.sendCommand(source, 'Runtime.evaluate', { expression: WEBRTC_BLOCK_SOURCE });
    info.spoofScriptId = await applySpoof(source, null, info.type === 'iframe');
    await chrome.debugger.sendCommand(source, 'Runtime.runIfWaitingForDebugger');
  } catch (err) {
    onLog(`intercept.child error tab=${source.tabId}: ${err.message}`);
    const tab = attachedTabs.get(source.tabId);
    if (tab) tab.protectionFailed = true;
    await blockUnattachedTab(source.tabId).catch((error) => onLog(`guard.error ${error.message}`));
    // Leave this target paused when protection could not be installed.
    onLost(`child target protection failed: ${err.message}`);
  }
}

function isStaticCdn(hostname) {
  const h = String(hostname || '').toLowerCase();
  return (
    h.startsWith('pic.') ||
    h.startsWith('static.') ||
    h.startsWith('st.') ||
    h.includes('ytimg.com') ||
    h.includes('gstatic.com') ||
    h.includes('googlevideo.com') ||
    h.includes('mycdn.me') ||
    h.includes('vkvd.net') ||
    h.includes('vk-cdn')
  );
}

async function resolveCookies(url) {
  try {
    const parsed = new URL(url);
    if (isStaticCdn(parsed.hostname)) return '';
    const now = Date.now();
    const origin = parsed.origin;
    const cached = cookieCache.get(origin);
    if (cached && now < cached.expiresAt) {
      return cached.cookieStr;
    }
    if (typeof chrome === 'undefined' || !chrome.cookies?.getAll) return '';
    const cookies = await chrome.cookies.getAll({ url });
    const cookieStr =
      cookies && cookies.length > 0 ? cookies.map((c) => `${c.name}=${c.value}`).join('; ') : '';
    cookieCache.set(origin, { cookieStr, expiresAt: now + COOKIE_CACHE_TTL_MS });
    return cookieStr;
  } catch {
    return '';
  }
}

export function getTelemetryMock(url) {
  try {
    const p = new URL(url);
    const host = p.hostname.toLowerCase();
    const path = p.pathname.toLowerCase();

    // VK video tracking API & client telemetry logger
    if (
      host.includes('vkvideo.ru') &&
      (path.includes('trackplayerevents') || path.includes('viewstarted') || path.includes('usefull.php') || path.includes('useful.php'))
    ) {
      if (path.includes('usefull.php') || path.includes('useful.php')) {
        return { code: 200, phrase: 'OK', body: '', contentType: 'text/plain' };
      }
      return { code: 200, phrase: 'OK', body: '{"response":1}', contentType: 'application/json' };
    }
    // OK feedback / telemetry
    if (host.includes('okcdn.ru') && path.includes('/fb.do')) {
      return { code: 200, phrase: 'OK', body: '', contentType: 'text/plain' };
    }
    // Mediascope video telemetry
    if ((host.endsWith('vk.ru') || host.endsWith('vk.com')) && path.includes('video_mediascope')) {
      return { code: 202, phrase: 'Accepted', body: '', contentType: 'text/plain' };
    }
    // Retargeting / stats
    if ((host.endsWith('vk.com') || host.endsWith('vk.ru')) && (path.includes('/rtrg') || path.includes('stats.php'))) {
      return { code: 204, phrase: 'No Content', body: '' };
    }
    // Twitter/X client event logger (jot)
    if (
      (host.endsWith('twitter.com') || host.endsWith('x.com')) &&
      (path.includes('/jot') || path.includes('client_event.json'))
    ) {
      return { code: 200, phrase: 'OK', body: '', contentType: 'application/json' };
    }
    // Walmart client performance & observability beacons
    if (
      host.endsWith('walmart.com') &&
      path.includes('/si/') &&
      (path.endsWith('/obs') || path.includes('/obs'))
    ) {
      return { code: 200, phrase: 'OK', body: '{}', contentType: 'application/json' };
    }
    // Matomo open-source analytics
    if (path.includes('/matomo.js') || path.endsWith('/matomo.js')) {
      return { code: 200, phrase: 'OK', body: '/* matomo */', contentType: 'application/javascript' };
    }
    if (path.includes('/matomo.php') || path.includes('/piwik.php')) {
      return { code: 204, phrase: 'No Content', body: '' };
    }
    if (host.includes('tns-counter.ru') || host.includes('mediascope.net')) {
      return { code: 204, phrase: 'No Content', body: '' };
    }
    if (
      host === 'api.vigo.tech' ||
      host.endsWith('.vigo.tech') ||
      host === 'uxfeedback.ru' ||
      host.endsWith('.uxfeedback.ru') ||
      host === 'expf.ru' ||
      host.endsWith('.expf.ru') ||
      host === 'log.rutube.ru' ||
      host.endsWith('.log.rutube.ru') ||
      (host === 'goya.rutube.ru' && path.includes('/v2/online/')) ||
      (host === 'ac.rutube.ru' && path.includes('/api/v1/ev')) ||
      host.includes('mc.yandex.ru') ||
      host.includes('google-analytics.com') ||
      host.includes('top-fwz1.mail.ru')
    ) {
      return { code: 204, phrase: 'No Content', body: '' };
    }
    return null;
  } catch {
    return null;
  }
}

export function isTelemetryUrl(url) {
  return Boolean(getTelemetryMock(url));
}

function isDocumentPaused(params, req) {
  return String(params?.resourceType || req?.resourceType || '').toLowerCase() === 'document';
}

// Eligibility and sign-in responses must be checked again for the current
// session, including after the tunnel reconnects or the user signs in.
export function isSessionSensitiveUrl(url) {
  try {
    const host = new URL(url).hostname;
    return host === 'flow.google.com' || host === 'accounts.youtube.com' || /^accounts\.google\.[a-z.]+$/.test(host);
  } catch {
    return false;
  }
}

function urlForLog(url, isDocument) {
  return isDocument ? url : url.slice(0, 80);
}

async function handlePaused(source, params) {
  const startTime = performance.now();
  const requestId = params.requestId;
  const req = params.request || {};
  const url = req.url || '';
  const isDocument = isDocumentPaused(params, req);
  try {
    if (skipUrl(url)) {
      await chrome.debugger.sendCommand(source, 'Fetch.continueRequest', { requestId });
      return;
    }
    // Strict killswitch: if tunnel is not ready, never leak to direct internet
    if (!handshakeOk) {
      onLog(`fetch.killswitch blocked (tunnel not ready) ${url.slice(0, 120)}`);
      await cdp(source, 'Fetch.failRequest', { requestId, errorReason: 'InternetDisconnected' });
      return;
    }
    // Strict killswitch: do not allow unproxied WebSockets to bypass the tunnel and leak IP
    if (isWebsocket(url, req)) {
      onLog(`fetch.killswitch blocked ws (unproxied) ${url.slice(0, 120)}`);
      await cdp(source, 'Fetch.failRequest', { requestId, errorReason: 'AccessDenied' });
      return;
    }
    if (!(url.startsWith('http://') || url.startsWith('https://'))) {
      onLog(`fetch.block reason=unsupported-protocol ${url.slice(0, 120)}`);
      await cdp(source, 'Fetch.failRequest', { requestId, errorReason: 'AccessDenied' });
      return;
    }
    if (!attachedTabs.has(source.tabId)) return;

    // Fast-fulfill CORS preflight OPTIONS requests locally to eliminate 500-700ms roundtrips
    if (CONFIG.fastCorsOptions !== false && (req.method || '').toUpperCase() === 'OPTIONS') {
      onLog(`fetch.fast-cors-options 204 ${url.slice(0, 120)}`);
      const origin = req.headers?.Origin || req.headers?.origin || '*';
      const allowHeaders =
        req.headers?.['Access-Control-Request-Headers'] ||
        req.headers?.['access-control-request-headers'] ||
        '*';
      await cdp(source, 'Fetch.fulfillRequest', {
        requestId,
        responseCode: 204,
        responsePhrase: 'No Content',
        responseHeaders: [
          { name: 'Access-Control-Allow-Origin', value: origin },
          { name: 'Access-Control-Allow-Methods', value: 'GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD' },
          { name: 'Access-Control-Allow-Headers', value: allowHeaders },
          { name: 'Access-Control-Allow-Credentials', value: 'true' },
          { name: 'Access-Control-Max-Age', value: '86400' },
        ],
        body: '',
      });
      return;
    }

    // Fast-fulfill pure telemetry / analytics beacons with local mock to save tunnel bandwidth
    const telemetryMock = CONFIG.fastTelemetry !== false ? getTelemetryMock(url) : null;
    if (telemetryMock) {
      onLog(`fetch.fast-telemetry ${telemetryMock.code} ${url.slice(0, 120)}`);
      interceptStats.telemetryBlocked += 1;
      const origin = req.headers?.Origin || req.headers?.origin || '*';
      const responseHeaders = [
        { name: 'Access-Control-Allow-Origin', value: origin },
        { name: 'Access-Control-Allow-Credentials', value: 'true' },
      ];
      if (telemetryMock.contentType) {
        responseHeaders.push({ name: 'Content-Type', value: telemetryMock.contentType });
      }
      await cdp(source, 'Fetch.fulfillRequest', {
        requestId,
        responseCode: telemetryMock.code,
        responsePhrase: telemetryMock.phrase,
        responseHeaders,
        body: telemetryMock.body ? btoa(telemetryMock.body) : '',
      });
      return;
    }

    const method = (req.method || 'GET').toUpperCase();
    const reqRange = req.headers?.Range || req.headers?.range || '';
    const cacheKey = `${method}:${url}:${reqRange}`;
    const sessionSensitive = isDocument || isSessionSensitiveUrl(url);

    // Fast-fulfill from short-lived in-memory LRU response cache
    if (!sessionSensitive && CONFIG.cacheEnabled !== false && (method === 'GET' || method === 'HEAD')) {
      const cached = getCachedResponse(cacheKey, url);
      if (cached) {
        interceptStats.cacheHits += 1;
        interceptStats.bytesSaved += cached.bodyLength;
        const tag = cached.isStale ? ' [stale-revalidating]' : '';
        onLog(`fetch.cache-hit ${cached.status} ${url.slice(0, 100)} bytes=${cached.bodyLength} ms=0${tag}`);
        const safePhrase = (cached.statusText || 'OK').replace(/[^\x20-\x7e]/g, '').trim() || 'OK';
        await cdp(source, 'Fetch.fulfillRequest', {
          requestId,
          responseCode: cached.status,
          responsePhrase: safePhrase,
          responseHeaders: (cached.headers || []).map((h) => ({ name: h.name, value: h.value })),
          body: cached.bodyB64 || '',
        });
        if (cached.isStale) {
          revalidateInBackground(cacheKey, req, url);
        }
        return;
      }
    }

    let got = { body: null, src: 'none' };
    if (method !== 'GET' && method !== 'HEAD') {
      got = await resolveCdpPostBody(req, {
        max: getMaxBodyBytes(),
        getPostData: () => chrome.debugger.sendCommand(source, 'Fetch.getRequestPostData', { requestId }),
      });
      if (got.error) onLog(`http.post miss ${got.error.message}`);
      onLog(`http.post n=${got.body?.length || 0} src=${got.src}`);
    }

    // In-Flight Request Deduplication (Coalescing)
    let inflightKey = null;
    const isGql = method === 'POST' && isGraphQlQuery(got.body, url);
    if (!sessionSensitive && CONFIG.coalesceEnabled !== false) {
      if (method === 'GET' || method === 'HEAD') {
        inflightKey = cacheKey;
      } else if (isGql) {
        inflightKey = `POST:${url}:${fastBodyHash(got.body)}`;
      }
    }

    if (inflightKey) {
      const existing = inflightRequests.get(inflightKey);
      if (existing) {
        existing.waiters += 1;
        interceptStats.coalesceHits += 1;
        onLog(`fetch.coalesce-join waiters=${existing.waiters} ${url.slice(0, 120)}`);
        try {
          const res = await existing.promise;
          const elapsedMs = Math.round(performance.now() - startTime);
          const byteLen = res.bodyLength ?? (res.body?.length || 0);
          const safePhrase = (res.statusText || 'OK').replace(/[^\x20-\x7e]/g, '').trim() || 'OK';
          const fulfillRes = await cdp(source, 'Fetch.fulfillRequest', {
            requestId,
            responseCode: res.status || 200,
            responsePhrase: safePhrase,
            responseHeaders: (res.headers || []).map((h) => ({ name: h.name, value: h.value })),
            body: res.bodyB64 || '',
          });
          if (!fulfillRes?.gone) {
            onLog(`fetch.fulfill ${res.status} ${urlForLog(url, isDocument)} bytes=${byteLen} ms=${elapsedMs} [coalesced]`);
          }
          return;
        } catch (coalesceErr) {
          if (isGone(coalesceErr)) {
            onLog(`fetch.gone ${url.slice(0, 80)}`);
            return;
          }
          await cdp(source, 'Fetch.failRequest', { requestId, errorReason: 'Failed' });
          return;
        }
      }
    }

    let resolveInflight = null;
    let rejectInflight = null;
    if (inflightKey) {
      const p = new Promise((res, rej) => {
        resolveInflight = res;
        rejectInflight = rej;
      });
      inflightRequests.set(inflightKey, { promise: p, waiters: 1 });
    }

    pauseCount += 1;
    onLog(`fetch.pause tab=${source.tabId} ${req.method || '?'} ${url.slice(0, 160)}`);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers || {})) headers[k] = v;
    
    if (!headers['Cookie'] && !headers['cookie']) {
      const cookieStr = await resolveCookies(url);
      if (cookieStr) headers['Cookie'] = cookieStr;
    }

    applyHeaderSpoof(headers, spoofProfile);

    const stripped = applyGoogleAuthCookieStrip(headers, url);
    if (stripped > 0) {
      try {
        onLog(`cookie.strip host=${new URL(url).hostname} n=${stripped}`);
      } catch {
        onLog(`cookie.strip n=${stripped}`);
      }
    }

    // Russian streaming services: fill ru-RU only when language spoof is off
    if (!spoofProfile?.spoofLanguage && isRussianTarget(url)) {
      if (!headers['Accept-Language'] && !headers['accept-language']) {
        headers['Accept-Language'] = 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7';
      }
    }

    if (!attachedTabs.has(source.tabId)) {
      if (inflightKey) rejectInflight?.(new Error('tab detached'));
      return;
    }

    const bodyB64 = got.body?.length ? u8ToB64(got.body) : null;
    const body = null;

    if (!attachedTabs.has(source.tabId)) {
      if (inflightKey) rejectInflight?.(new Error('tab detached'));
      return;
    }

    let res;
    try {
      res = await proxyFn({ method, url, headers, bodyB64, body });
      if (!attachedTabs.has(source.tabId)) {
        if (inflightKey) rejectInflight?.(new Error('tab detached'));
        return;
      }
      if (res?.ok) {
        if (res.bodyB64 == null && res.body) {
          res.bodyB64 = u8ToB64(res.body instanceof Uint8Array ? res.body : Uint8Array.from(res.body));
        }
        if (!sessionSensitive && CONFIG.cacheEnabled !== false && (method === 'GET' || method === 'HEAD')) {
          putCachedResponse(cacheKey, res, url);
        }
        if (inflightKey) {
          resolveInflight?.(res);
        }
      } else {
        if (inflightKey) rejectInflight?.(new Error(res?.error || 'proxy error'));
      }
    } catch (proxyErr) {
      if (inflightKey) rejectInflight?.(proxyErr);
      throw proxyErr;
    } finally {
      if (inflightKey) inflightRequests.delete(inflightKey);
    }

    if (!res?.ok) {
      onLog(`fetch.fail ${res?.error || 'proxy'}`);
      await cdp(source, 'Fetch.failRequest', { requestId, errorReason: 'Failed' });
      return;
    }
    const b64 =
      res.bodyB64 != null
        ? res.bodyB64
        : res.body
          ? u8ToB64(res.body instanceof Uint8Array ? res.body : Uint8Array.from(res.body))
          : '';
    const byteLen = res.bodyLength ?? (res.body?.length || 0);
    const elapsedMs = Math.round(performance.now() - startTime);
    const safePhrase = (res.statusText || 'OK').replace(/[^\x20-\x7e]/g, '').trim() || 'OK';
    const fulfillParams = {
      requestId,
      responseCode: res.status || 200,
      responsePhrase: safePhrase,
      responseHeaders: (res.headers || []).map((h) => ({ name: h.name, value: h.value })),
      body: b64,
    };
    let fulfillRes = null;
    try {
      fulfillRes = await cdp(source, 'Fetch.fulfillRequest', fulfillParams);
    } catch (fulfillErr) {
      const errStr = String(fulfillErr?.message || fulfillErr);
      if (errStr.includes('Invalid http status code or phrase')) {
        onLog(`fetch.fulfill fallback status=200 for non-standard code=${res.status}`);
        fulfillParams.responseCode = 200;
        fulfillParams.responsePhrase = 'OK';
        fulfillRes = await cdp(source, 'Fetch.fulfillRequest', fulfillParams);
      } else {
        throw fulfillErr;
      }
    }
    if (fulfillRes?.gone) {
      onLog(`fetch.gone ${urlForLog(url, isDocument)} ms=${elapsedMs}`);
    } else {
      onLog(`fetch.fulfill ${res.status} ${urlForLog(url, isDocument)} bytes=${byteLen} ms=${elapsedMs}`);
    }
  } catch (err) {
    const elapsedMs = Math.round(performance.now() - startTime);
    if (isGone(err)) {
      onLog(`fetch.gone ${urlForLog(url, isDocument)} ms=${elapsedMs}`);
      return;
    }
    onLog(`fetch.error ${err.message} ms=${elapsedMs}`);
    // Strict killswitch: never fallback to continueRequest on proxy/network errors
    try {
      await cdp(source, 'Fetch.failRequest', { requestId, errorReason: 'Failed' });
    } catch {
      /* ignore */
    }
  }
}

function isRussianTarget(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host.endsWith('.ru') ||
      host.endsWith('.su') ||
      host.endsWith('.xn--p1ai') || // .рф
      host.includes('rutube') ||
      host.includes('rtbcdn') ||
      host.includes('vk.com') ||
      host.includes('vkvideo') ||
      host.includes('vk-cdn') ||
      host.includes('mycdn') ||
      host.includes('smotrim') ||
      host.includes('yandex') ||
      host.includes('kinopoisk')
    );
  } catch {
    return false;
  }
}

function isWebsocket(url, req) {
  if (url.startsWith('ws:') || url.startsWith('wss:')) return true;
  const upgrade = String(req.headers?.Upgrade || req.headers?.upgrade || '').toLowerCase();
  return upgrade === 'websocket';
}

function debuggee(id) {
  return typeof id === 'object' ? id : { tabId: id };
}

function targetLabel(id) {
  if (typeof id === 'number' || typeof id === 'string') return `tab=${id}`;
  if (id && typeof id === 'object') {
    if (id.targetId) return `target=${id.targetId.slice(0, 8)}`;
    if (id.tabId) return `tab=${id.tabId}`;
  }
  return `tab=${id}`;
}

async function cdpTry(id, method, params) {
  try {
    return await chrome.debugger.sendCommand(debuggee(id), method, params);
  } catch (err) {
    if (method === 'Emulation.setLocaleOverride' && err.message?.includes('Another locale override')) {
      return null;
    }
    onLog(`spoof.${method} ${targetLabel(id)}: ${err.message}`);
    return null;
  }
}

async function applySpoof(id, prevScriptId, hasPage = true) {
  const profile = spoofProfile || buildSpoofProfile({
    geo: FALLBACK_GEO_PROFILE,
    settings: DEFAULT_SPOOF_SETTINGS,
    chromeMajor: 141,
    token: 'init',
  });
  try {
    if (hasPage) await cdpTry(id, 'Page.enable');
    if (hasPage) await cdpTry(id, 'Emulation.setGeolocationOverride', {
      latitude: profile.latitude,
      longitude: profile.longitude,
      accuracy: profile.accuracy,
    });
    await cdpTry(id, 'Emulation.setTimezoneOverride', { timezoneId: profile.timezoneId });
    if (hasPage && profile.spoofLanguage && profile.locale) {
      await cdpTry(id, 'Emulation.setLocaleOverride', { locale: profile.locale });
    } else if (hasPage) {
      await cdpTry(id, 'Emulation.setLocaleOverride', { locale: '' });
    }
    if (profile.spoofUa && profile.userAgent) {
      const uaParams = {
        userAgent: profile.userAgent,
        acceptLanguage: profile.acceptLanguage || '',
        platform: profile.platform || '',
      };
      if (profile.userAgentMetadata) uaParams.userAgentMetadata = profile.userAgentMetadata;
      await cdpTry(id, 'Emulation.setUserAgentOverride', uaParams);
    } else {
      await cdpTry(id, 'Emulation.setUserAgentOverride', { userAgent: '' });
    }

    if (prevScriptId) {
      try {
        await chrome.debugger.sendCommand(debuggee(id), 'Page.removeScriptToEvaluateOnNewDocument', {
          identifier: prevScriptId,
        });
      } catch {}
    }
    const source = fingerprintSpoofSource(profile);
    const res = hasPage ? await chrome.debugger.sendCommand(debuggee(id), 'Page.addScriptToEvaluateOnNewDocument', {
      source,
    }) : null;
    const scriptId = res?.identifier || null;
    try {
      await chrome.debugger.sendCommand(debuggee(id), 'Runtime.evaluate', { expression: source });
    } catch {}
    onLog(`spoof.apply ${targetLabel(id)} tz=${profile.timezoneId} locale=${profile.spoofLanguage ? profile.locale : 'off'}`);
    return scriptId;
  } catch (err) {
    onLog(`spoof.apply error ${targetLabel(id)}: ${err.message}`);
    return null;
  }
}

async function applyWebrtcBlock(id) {
  try {
    await chrome.debugger.sendCommand(debuggee(id), 'Page.enable');
    const prev = attachedTabs.get(id)?.webrtcScriptId;
    if (prev) {
      try {
        await chrome.debugger.sendCommand(debuggee(id), 'Page.removeScriptToEvaluateOnNewDocument', {
          identifier: prev,
        });
      } catch {}
    }
    if (!blockWebrtc) {
      onLog(`webrtc.block off tab=${id}`);
      return null;
    }
    const res = await chrome.debugger.sendCommand(debuggee(id), 'Page.addScriptToEvaluateOnNewDocument', {
      source: WEBRTC_BLOCK_SOURCE,
    });
    const scriptId = res?.identifier || null;
    try {
      await chrome.debugger.sendCommand(debuggee(id), 'Runtime.evaluate', {
        expression: WEBRTC_BLOCK_SOURCE,
      });
    } catch {}
    onLog(`webrtc.block on tab=${id}`);
    return scriptId;
  } catch (err) {
    onLog(`webrtc.block error tab=${id}: ${err.message}`);
    return null;
  }
}

function isGone(err) {
  return /Invalid InterceptionId|No tab with given id/i.test(String(err?.message || err));
}

async function cdp(source, method, params) {
  try {
    await chrome.debugger.sendCommand(source, method, params);
    return { ok: true };
  } catch (err) {
    if (isGone(err)) {
      onLog(`fetch.gone ${method}`);
      return { ok: false, gone: true };
    }
    throw err;
  }
}

export function u8ToB64(u8) {
  if (!u8 || !u8.length) return '';
  if (typeof u8.toBase64 === 'function') {
    return u8.toBase64();
  }
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('base64');
  }
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + chunk, u8.length)));
  }
  return btoa(s);
}
