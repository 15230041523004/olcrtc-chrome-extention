import test from 'node:test';
import assert from 'node:assert/strict';
import { FALLBACK_GEO_PROFILE } from '../extension/lib/geo-spoof.js';
import { buildSpoofProfile, DEFAULT_SPOOF_SETTINGS } from '../extension/lib/fingerprint-spoof.js';

// Mock chrome APIs before importing intercept.js
const debuggerCommands = [];
const attachedDebuggerTabs = new Set();
const tabListeners = {
  created: [],
  updated: [],
  removed: [],
};
const debuggerListeners = {
  detach: [],
  event: [],
};

const mockTabs = new Map();
const tabReloads = [];
const tabUpdates = [];
const sessionRules = new Map();
const dynamicRules = new Map();
function updateRules(store, { removeRuleIds = [], addRules = [] }) {
  removeRuleIds.forEach((id) => store.delete(id));
  addRules.forEach((rule) => store.set(rule.id, rule));
}

globalThis.chrome = {
  runtime: { id: 'testextension' },
  declarativeNetRequest: {
    updateDynamicRules: async (params) => updateRules(dynamicRules, params),
    getDynamicRules: async () => [...dynamicRules.values()],
    updateSessionRules: async (params) => updateRules(sessionRules, params),
    getSessionRules: async () => [...sessionRules.values()],
  },
  contentSettings: { location: { set: async () => {}, clear: async () => {} } },
  privacy: { network: { networkPredictionEnabled: { set: async () => {}, clear: async () => {} } } },
  debugger: {
    attach: async ({ tabId }, protocol) => {
      attachedDebuggerTabs.add(tabId);
      debuggerCommands.push({ type: 'attach', tabId, protocol });
    },
    detach: async ({ tabId }) => {
      attachedDebuggerTabs.delete(tabId);
      debuggerCommands.push({ type: 'detach', tabId });
    },
    sendCommand: async ({ tabId, sessionId }, method, params) => {
      debuggerCommands.push({ type: 'sendCommand', tabId, sessionId, method, params });
      if (method === 'Page.addScriptToEvaluateOnNewDocument') {
        return { identifier: `script_${tabId}` };
      }
      return {};
    },
    onDetach: {
      addListener: (fn) => debuggerListeners.detach.push(fn),
    },
    onEvent: {
      addListener: (fn) => debuggerListeners.event.push(fn),
    },
  },
  tabs: {
    get: async (id) => {
      const tab = mockTabs.get(id);
      if (!tab) throw new Error('Tab not found');
      return tab;
    },
    query: async () => Array.from(mockTabs.values()),
    create: async ({ url }) => {
      const id = mockTabs.size + 100;
      const tab = { id, url };
      mockTabs.set(id, tab);
      return tab;
    },
    onCreated: {
      addListener: (fn) => tabListeners.created.push(fn),
    },
    onUpdated: {
      addListener: (fn) => tabListeners.updated.push(fn),
    },
    onRemoved: {
      addListener: (fn) => tabListeners.removed.push(fn),
    },
    reload: async (id, opts) => {
      tabReloads.push({ id, opts });
    },
    update: async (id, opts) => {
      tabUpdates.push({ id, opts });
      const tab = mockTabs.get(id);
      if (tab && opts?.url) tab.url = opts.url;
      return tab || { id, url: opts?.url };
    },
  },
  webNavigation: {
    onBeforeNavigate: {
      addListener: () => {},
    },
  },
};

const {
  configureIntercept,
  startIntercept,
  stopIntercept,
  attachTab,
  detachTab,
  getAttachedTabCount,
  getAttachedTabs,
  setHandshakeOk,
  isPrivilegedTabUrl,
  clearResponseCache,
  getInterceptStats,
  resetInterceptStats,
  isStaticAssetUrl,
  getCacheTtlMs,
  u8ToB64,
  getCachedResponse,
  putCachedResponse,
  SWR_GRACE_MS,
  isGraphQlQuery,
  fastBodyHash,
  setSpoofProfile,
  isUnsupportedCountryPath,
  isGoogleAccountHost,
  isGoogleAuthCookieName,
  stripGoogleAuthCookies,
  applyGoogleAuthCookieStrip,
  setGoogleAuthCookieSnapshot,
  getGoogleAuthCookieSnapshot,
} = await import('../extension/lib/intercept.js');

function cookieSpoofProfile(on, token = 'ck') {
  return buildSpoofProfile({
    geo: FALLBACK_GEO_PROFILE,
    settings: { ...DEFAULT_SPOOF_SETTINGS, stripGoogleAuthCookies: on },
    chromeMajor: 141,
    token,
  });
}

test('isGoogleAccountHost and stripGoogleAuthCookies drop snapshotted SID/NID and keep PREF and new login cookies', async () => {
  assert.equal(isGoogleAccountHost('https://flow.google.com/'), true);
  assert.equal(isGoogleAccountHost('https://accounts.google.com/'), true);
  assert.equal(isGoogleAccountHost('https://www.gstatic.com/x'), true);
  assert.equal(isGoogleAccountHost('https://example.com/'), false);
  assert.equal(isGoogleAuthCookieName('SID'), true);
  assert.equal(isGoogleAuthCookieName('__Secure-1PSID'), true);
  assert.equal(isGoogleAuthCookieName('PREF'), false);
  setGoogleAuthCookieSnapshot(['SID=secret', 'NID=n1', '__Secure-1PSID=x']);
  const { cookie, stripped } = stripGoogleAuthCookies('SID=secret; PREF=p; NID=n1; __Secure-1PSID=x; SID=newlogin');
  assert.equal(cookie.includes('PREF=p'), true);
  assert.equal(cookie.includes('SID=newlogin'), true);
  assert.equal(cookie.includes('SID=secret'), false);
  assert.ok(stripped.includes('SID'));
  assert.ok(stripped.includes('NID'));
  const headers = { Cookie: 'SID=secret; session=1' };
  assert.equal(applyGoogleAuthCookieStrip(headers, 'https://example.com/'), 0);
  assert.equal(headers.Cookie, 'SID=secret; session=1');
  assert.equal(applyGoogleAuthCookieStrip(headers, 'https://flow.google.com/'), 0, 'strip is off by default');
  assert.equal(headers.Cookie, 'SID=secret; session=1');
  await setSpoofProfile(cookieSpoofProfile(true, 'ck-on'));
  assert.ok(applyGoogleAuthCookieStrip(headers, 'https://flow.google.com/') > 0);
  assert.equal(headers.Cookie, 'session=1');
  setGoogleAuthCookieSnapshot([]);
  const login = { Cookie: 'SID=secret; __Host-GAPS=fresh' };
  assert.equal(applyGoogleAuthCookieStrip(login, 'https://accounts.google.com/'), 0);
  assert.equal(login.Cookie, 'SID=secret; __Host-GAPS=fresh');
  await setSpoofProfile(cookieSpoofProfile(false, 'ck-off'));
});

test('isPrivilegedTabUrl identifies non-interceptable schemes', () => {
  assert.equal(isPrivilegedTabUrl('chrome://extensions'), true);
  assert.equal(isPrivilegedTabUrl('chrome-extension://xyz'), true);
  assert.equal(isPrivilegedTabUrl('about:blank'), true);
  assert.equal(isPrivilegedTabUrl('edge://settings'), true);
  assert.equal(isPrivilegedTabUrl('https://youtube.com/'), false);
  assert.equal(isPrivilegedTabUrl('http://example.com/'), false);
});

test('attachTab registers valid http tab and enables Fetch + WebRTC block', async () => {
  mockTabs.clear();
  debuggerCommands.length = 0;
  mockTabs.set(1, { id: 1, url: 'https://example.com' });

  let tabCounts = [];
  configureIntercept({
    log: () => {},
    tabCount: (c) => tabCounts.push(c),
  });
  setHandshakeOk(true);

  const ok = await attachTab(1, 'https://example.com');
  assert.equal(ok, true);
  assert.equal(getAttachedTabCount(), 1);
  assert.equal(getAttachedTabs()[0].id, 1);
  assert.ok(debuggerCommands.some((c) => c.method === 'Fetch.enable'));
  assert.ok(debuggerCommands.some((c) => c.method === 'Page.addScriptToEvaluateOnNewDocument'));
  const geoCmd = debuggerCommands.find((c) => c.method === 'Emulation.setGeolocationOverride');
  assert.ok(geoCmd, 'attachTab must override geolocation');
  assert.equal(geoCmd.params.latitude, FALLBACK_GEO_PROFILE.latitude);
  assert.ok(debuggerCommands.some((c) => c.method === 'Emulation.setTimezoneOverride'));
  assert.ok(debuggerCommands.some((c) => c.method === 'Emulation.setLocaleOverride'));
  assert.ok(debuggerCommands.some((c) => c.method === 'Emulation.setUserAgentOverride'));
  assert.ok(!debuggerCommands.some((c) => c.method === 'Emulation.enable'));
});

test('startIntercept queries and attaches all open http(s) tabs', async () => {
  await stopIntercept();
  mockTabs.clear();
  debuggerCommands.length = 0;

  mockTabs.set(1, { id: 1, url: 'https://youtube.com' });
  mockTabs.set(2, { id: 2, url: 'https://neverssl.com' });
  mockTabs.set(3, { id: 3, url: 'chrome://settings' }); // should be skipped

  await startIntercept();
  assert.equal(getAttachedTabCount(), 2);
  const ids = getAttachedTabs().map((t) => t.id);
  assert.deepEqual(ids.sort(), [1, 2]);
});

test('dynamic tab lifecycle automatically tracks created and removed tabs', async () => {
  assert.equal(getAttachedTabCount(), 2);

  // Tab 4 is created (e.g. Google sign-in popup)
  const newTab = { id: 4, url: 'https://accounts.google.com/signin' };
  mockTabs.set(4, newTab);
  for (const fn of tabListeners.created) fn(newTab);

  await new Promise((r) => setTimeout(r, 20));
  assert.equal(getAttachedTabCount(), 3);
  assert.ok(getAttachedTabs().some((t) => t.id === 4));

  // Tab 1 is closed
  mockTabs.delete(1);
  for (const fn of tabListeners.removed) fn(1);

  assert.equal(getAttachedTabCount(), 2);
  assert.ok(!getAttachedTabs().some((t) => t.id === 1));
});

test('stopIntercept detaches all active tabs', async () => {
  await stopIntercept();
  assert.equal(getAttachedTabCount(), 0);
  assert.equal(getAttachedTabs().length, 0);
});

test('strict killswitch blocks requests when tunnel handshake is not ready', async () => {
  debuggerCommands.length = 0;
  mockTabs.clear();
  mockTabs.set(10, { id: 10, url: 'https://rutube.ru' });

  setHandshakeOk(false); // Tunnel offline!
  await attachTab(10, 'https://rutube.ru');

  // Trigger Fetch.requestPaused event
  const pausedEvent = {
    requestId: 'req_1',
    request: {
      url: 'https://rutube.ru/api/video',
      method: 'GET',
      headers: {},
    },
  };
  for (const fn of debuggerListeners.event) {
    fn({ tabId: 10 }, 'Fetch.requestPaused', pausedEvent);
  }

  await new Promise((r) => setTimeout(r, 20));

  const failCmd = debuggerCommands.find((c) => c.method === 'Fetch.failRequest');
  assert.ok(failCmd, 'Killswitch must fail request when tunnel not ready');
  assert.equal(failCmd.params.errorReason, 'InternetDisconnected');
  assert.ok(!debuggerCommands.some((c) => c.method === 'Fetch.continueRequest'));
});

test('strict killswitch blocks unproxied WebSockets to prevent IP leakage', async () => {
  debuggerCommands.length = 0;
  setHandshakeOk(true);

  const wsEvent = {
    requestId: 'req_ws',
    request: {
      url: 'wss://rutube.ru/ws',
      method: 'GET',
      headers: { Upgrade: 'websocket' },
    },
  };
  for (const fn of debuggerListeners.event) {
    fn({ tabId: 10 }, 'Fetch.requestPaused', wsEvent);
  }

  await new Promise((r) => setTimeout(r, 20));

  const failCmd = debuggerCommands.find((c) => c.method === 'Fetch.failRequest' && c.params.requestId === 'req_ws');
  assert.ok(failCmd, 'Killswitch must block unproxied WebSockets');
  assert.equal(failCmd.params.errorReason, 'AccessDenied');
});

test('child workers are intercepted and protected before resuming, with session IDs preserved', async () => {
  debuggerCommands.length = 0;
  for (const fn of debuggerListeners.event) {
    fn({ tabId: 10 }, 'Target.attachedToTarget', {
      sessionId: 'worker-session', targetInfo: { type: 'worker' }, waitingForDebugger: true,
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  const childCommands = debuggerCommands.filter((c) => c.sessionId === 'worker-session');
  assert.equal(childCommands[0].method, 'Network.enable');
  assert.ok(!childCommands.some((c) => c.method === 'Fetch.enable'), 'dedicated workers inherit Fetch from their owner');
  assert.ok(childCommands.some((c) => c.method === 'Target.setAutoAttach' && c.params.waitForDebuggerOnStart));
  assert.ok(childCommands.some((c) => c.method === 'Network.setBypassServiceWorker' && c.params.bypass));
  assert.equal(childCommands.at(-1).method, 'Runtime.runIfWaitingForDebugger');
  setHandshakeOk(false);
  for (const fn of debuggerListeners.event) {
    fn({ tabId: 10, sessionId: 'worker-session' }, 'Fetch.requestPaused', {
      requestId: 'child-offline', request: { url: 'https://example.com/worker-fetch', method: 'GET' },
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(debuggerCommands.some((c) => c.sessionId === 'worker-session' && c.method === 'Fetch.failRequest' && c.params.requestId === 'child-offline'));
  debuggerCommands.length = 0;
  for (const fn of debuggerListeners.event) {
    fn({ tabId: 10 }, 'Target.attachedToTarget', {
      sessionId: 'iframe-session', targetInfo: { type: 'iframe' }, waitingForDebugger: true,
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  const iframeCommands = debuggerCommands.filter((c) => c.sessionId === 'iframe-session');
  assert.ok(iframeCommands.some((c) => c.method === 'Emulation.setGeolocationOverride'));
  assert.ok(!iframeCommands.some((c) => c.method === 'Emulation.setDeviceMetricsOverride'));
  assert.ok(!iframeCommands.some((c) => c.method === 'Emulation.clearDeviceMetricsOverride'));
  setHandshakeOk(true);
});

test('new tabs remain guarded while the tunnel is offline', async () => {
  await startIntercept();
  setHandshakeOk(false);
  const tab = { id: 19, url: 'https://example.com/offline', active: false };
  mockTabs.set(tab.id, tab);
  for (const fn of tabListeners.created) fn(tab);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(getAttachedTabs().some((item) => item.id === tab.id));
  assert.ok(!tabReloads.some((item) => item.id === tab.id));
  await detachTab(tab.id);
  assert.ok(![...sessionRules.values()].some((rule) => rule.condition.tabIds.includes(tab.id)));
  setHandshakeOk(true);
});

test('fast telemetry fulfills VK/OK tracking endpoints locally with expected status and payloads', async () => {
  debuggerCommands.length = 0;
  setHandshakeOk(true);
  resetInterceptStats();

  let proxyCalled = false;
  configureIntercept({
    log: () => {},
    proxy: async () => { proxyCalled = true; return { ok: true, status: 200, headers: [] }; },
  });

  // 1. video_mediascope returns 202 Accepted
  const mediascopeEvent = {
    requestId: 'req_media_1',
    request: {
      url: 'https://vk.ru/video_mediascope?event_name=pause&video_id=123',
      method: 'GET',
      headers: { Origin: 'https://vk.com' },
    },
  };
  for (const fn of debuggerListeners.event) {
    fn({ tabId: 10 }, 'Fetch.requestPaused', mediascopeEvent);
  }

  // 2. VK Video trackPlayerEvents returns 200 with {"response":1}
  const trackEvent = {
    requestId: 'req_track_1',
    request: {
      url: 'https://api.vkvideo.ru/method/video.trackPlayerEvents?v=5.289',
      method: 'POST',
      headers: { Origin: 'https://vkvideo.ru' },
    },
  };
  for (const fn of debuggerListeners.event) {
    fn({ tabId: 10 }, 'Fetch.requestPaused', trackEvent);
  }

  const geminiErrorEvent = {
    requestId: 'req_gemini_jserror',
    request: {
      url: 'https://gemini.google.com/_/BardChatUi/jserror?script=app&error=render',
      method: 'POST',
      headers: { Origin: 'https://gemini.google.com' },
    },
  };
  for (const fn of debuggerListeners.event) {
    fn({ tabId: 10 }, 'Fetch.requestPaused', geminiErrorEvent);
  }

  await new Promise((r) => setTimeout(r, 30));

  assert.equal(proxyCalled, false, 'Fast telemetry must not call proxyFn');
  const mediaFulfill = debuggerCommands.find((c) => c.method === 'Fetch.fulfillRequest' && c.params.requestId === 'req_media_1');
  assert.ok(mediaFulfill, 'Mediascope request must be fulfilled');
  assert.equal(mediaFulfill.params.responseCode, 202);

  const trackFulfill = debuggerCommands.find((c) => c.method === 'Fetch.fulfillRequest' && c.params.requestId === 'req_track_1');
  assert.ok(trackFulfill, 'TrackPlayerEvents request must be fulfilled');
  assert.equal(trackFulfill.params.responseCode, 200);
  assert.equal(atob(trackFulfill.params.body), '{"response":1}');
  const geminiFulfill = debuggerCommands.find((c) => c.method === 'Fetch.fulfillRequest' && c.params.requestId === 'req_gemini_jserror');
  assert.ok(geminiFulfill, 'Gemini JavaScript error report must be fulfilled locally');
  assert.equal(geminiFulfill.params.responseCode, 204);
  assert.equal(getInterceptStats().telemetryBlocked, 3);
});

test('in-flight request deduplication coalesces concurrent identical requests and shares the response', async () => {
  debuggerCommands.length = 0;
  clearResponseCache();
  resetInterceptStats();
  setHandshakeOk(true);

  let proxyCalls = 0;
  configureIntercept({
    log: () => {},
    proxy: async () => {
      proxyCalls += 1;
      await new Promise((r) => setTimeout(r, 40));
      return {
        ok: true,
        status: 200,
        headers: [{ name: 'Content-Type', value: 'video/mp4' }],
        body: new Uint8Array([10, 20, 30]),
      };
    },
  });

  const reqUrl = 'https://vk6-4.vkuser.net/?bytes=1000-2000';
  const event1 = {
    requestId: 'req_coal_1',
    request: { url: reqUrl, method: 'GET', headers: {} },
  };
  const event2 = {
    requestId: 'req_coal_2',
    request: { url: reqUrl, method: 'GET', headers: {} },
  };

  // Dispatch both concurrent requests
  for (const fn of debuggerListeners.event) {
    fn({ tabId: 10 }, 'Fetch.requestPaused', event1);
    fn({ tabId: 10 }, 'Fetch.requestPaused', event2);
  }

  await new Promise((r) => setTimeout(r, 80));

  assert.equal(proxyCalls, 1, 'Two concurrent requests for the same URL must coalesce into 1 proxy call');
  const f1 = debuggerCommands.find((c) => c.method === 'Fetch.fulfillRequest' && c.params.requestId === 'req_coal_1');
  const f2 = debuggerCommands.find((c) => c.method === 'Fetch.fulfillRequest' && c.params.requestId === 'req_coal_2');
  assert.ok(f1, 'Request 1 must be fulfilled');
  assert.ok(f2, 'Request 2 must be fulfilled');
  assert.equal(f1.params.responseCode, 200);
  assert.equal(f2.params.responseCode, 200);
  assert.equal(f1.params.body, f2.params.body);
  assert.equal(getInterceptStats().coalesceHits, 1);
});

test('short-lived in-memory response cache instantly fulfills subsequent identical requests without proxy', async () => {
  debuggerCommands.length = 0;
  clearResponseCache();
  resetInterceptStats();
  setHandshakeOk(true);

  let proxyCalls = 0;
  configureIntercept({
    log: () => {},
    proxy: async () => {
      proxyCalls += 1;
      return {
        ok: true,
        status: 200,
        headers: [{ name: 'Content-Type', value: 'application/octet-stream' }],
        body: new Uint8Array([42, 43, 44]),
      };
    },
  });

  const reqUrl = 'https://vk6-4.vkuser.net/?bytes=5000-6000';
  const event1 = {
    requestId: 'req_cache_1',
    request: { url: reqUrl, method: 'GET', headers: {} },
  };

  for (const fn of debuggerListeners.event) {
    fn({ tabId: 10 }, 'Fetch.requestPaused', event1);
  }
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(proxyCalls, 1);

  // Now dispatch a second request for the same URL after the first completed
  const event2 = {
    requestId: 'req_cache_2',
    request: { url: reqUrl, method: 'GET', headers: {} },
  };
  for (const fn of debuggerListeners.event) {
    fn({ tabId: 10 }, 'Fetch.requestPaused', event2);
  }
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(proxyCalls, 1, 'Second request must be served directly from cache without calling proxyFn');
  const f2 = debuggerCommands.find((c) => c.method === 'Fetch.fulfillRequest' && c.params.requestId === 'req_cache_2');
  assert.ok(f2, 'Cached request must be fulfilled');
  assert.equal(f2.params.responseCode, 200);
  assert.equal(getInterceptStats().cacheHits, 1);
  assert.equal(getInterceptStats().bytesSaved, 3);
});

test('smart TTL differentiates static assets (5 min) vs dynamic API (30 sec) and respects max-age', () => {
  // Static assets must return true
  assert.equal(isStaticAssetUrl('https://www.sis.gov.uk/themes/custom/green/assets/images/globe.svg'), true);
  assert.equal(isStaticAssetUrl('https://www.sis.gov.uk/themes/custom/green/assets/fonts/nokora-v31-latin-regular.woff2'), true);
  assert.equal(isStaticAssetUrl('https://www.sis.gov.uk/assets/js/bundle.min.js'), true);
  assert.equal(isStaticAssetUrl('https://www.sis.gov.uk/assets/css/style.css'), true);
  assert.equal(isStaticAssetUrl('https://www.sis.gov.uk/assets/img.png'), true);
  assert.equal(isStaticAssetUrl('https://static.rtbcdn.ru/bundle.js'), true);
  assert.equal(isStaticAssetUrl('https://pic.rtbcdn.ru/avatar.webp'), true);

  // Dynamic endpoints must return false
  assert.equal(isStaticAssetUrl('https://rutube.ru/api/video/info'), false);
  assert.equal(isStaticAssetUrl('https://vk.com/al_video.php'), false);

  // Default static TTL is 300,000 ms (5 minutes)
  assert.equal(getCacheTtlMs('https://www.sis.gov.uk/themes/custom/images/logo.svg'), 300_000);

  // Default dynamic TTL is 30,000 ms (30 seconds)
  assert.equal(getCacheTtlMs('https://rutube.ru/api/video/info'), 30_000);

  // Cache-Control max-age header overrides TTL
  const resWithMaxAge = {
    headers: [{ name: 'Cache-Control', value: 'public, max-age=120' }],
  };
  assert.equal(getCacheTtlMs('https://rutube.ru/api/video/info', resWithMaxAge), 120_000);
});

test('fast telemetry fulfills Matomo open-source analytics with harmless mock', async () => {
  debuggerCommands.length = 0;
  setHandshakeOk(true);
  resetInterceptStats();

  let proxyCalled = false;
  configureIntercept({
    log: () => {},
    proxy: async () => { proxyCalled = true; return { ok: true, status: 200, headers: [] }; },
  });

  // matomo.js script returns 200 with /* matomo */
  const matomoJsEvent = {
    requestId: 'req_matomo_js',
    request: {
      url: 'https://www.sis.gov.uk/matomo/matomo.js',
      method: 'GET',
      headers: { Origin: 'https://www.sis.gov.uk' },
    },
  };
  for (const fn of debuggerListeners.event) {
    fn({ tabId: 10 }, 'Fetch.requestPaused', matomoJsEvent);
  }

  // matomo.php tracking beacon returns 204
  const matomoPhpEvent = {
    requestId: 'req_matomo_php',
    request: {
      url: 'https://www.sis.gov.uk/matomo/matomo.php?idsite=1&rec=1',
      method: 'POST',
      headers: { Origin: 'https://www.sis.gov.uk' },
    },
  };
  for (const fn of debuggerListeners.event) {
    fn({ tabId: 10 }, 'Fetch.requestPaused', matomoPhpEvent);
  }

  await new Promise((r) => setTimeout(r, 30));

  assert.equal(proxyCalled, false, 'Matomo telemetry must not call proxyFn');
  const jsFulfill = debuggerCommands.find((c) => c.method === 'Fetch.fulfillRequest' && c.params.requestId === 'req_matomo_js');
  assert.ok(jsFulfill, 'matomo.js must be fulfilled');
  assert.equal(jsFulfill.params.responseCode, 200);
  assert.equal(atob(jsFulfill.params.body), '/* matomo */');

  const phpFulfill = debuggerCommands.find((c) => c.method === 'Fetch.fulfillRequest' && c.params.requestId === 'req_matomo_php');
  assert.ok(phpFulfill, 'matomo.php must be fulfilled');
  assert.equal(phpFulfill.params.responseCode, 204);
  assert.equal(getInterceptStats().telemetryBlocked, 2);
});

test('fast telemetry fulfills Twitter / X jot client event logging with harmless 200 mock', async () => {
  debuggerCommands.length = 0;
  setHandshakeOk(true);
  resetInterceptStats();

  let proxyCalled = false;
  configureIntercept({
    log: () => {},
    proxy: async () => { proxyCalled = true; return { ok: true, status: 200, headers: [] }; },
  });

  const jotEvent = {
    requestId: 'req_x_jot',
    request: {
      url: 'https://api.x.com/1.1/jot/client_event.json',
      method: 'POST',
      headers: { Origin: 'https://x.com' },
    },
  };
  for (const fn of debuggerListeners.event) {
    fn({ tabId: 10 }, 'Fetch.requestPaused', jotEvent);
  }

  await new Promise((r) => setTimeout(r, 30));

  assert.equal(proxyCalled, false, 'Twitter jot telemetry must not call proxyFn');
  const fulfill = debuggerCommands.find((c) => c.method === 'Fetch.fulfillRequest' && c.params.requestId === 'req_x_jot');
  assert.ok(fulfill, 'req_x_jot must be fulfilled');
  assert.equal(fulfill.params.responseCode, 200);
  assert.equal(atob(fulfill.params.body || ''), '');
  assert.equal(getInterceptStats().telemetryBlocked, 1);
});

test('fast telemetry fulfills VK Video usefull.php logging with 200 OK mock', async () => {
  debuggerCommands.length = 0;
  setHandshakeOk(true);
  resetInterceptStats();

  let proxyCalled = false;
  configureIntercept({
    log: () => {},
    proxy: async () => { proxyCalled = true; return { ok: true, status: 200, headers: [] }; },
  });

  const usefulEvent = {
    requestId: 'req_vk_useful',
    request: {
      url: 'https://vkvideo.ru/usefull.php',
      method: 'POST',
      headers: { Origin: 'https://vkvideo.ru' },
    },
  };
  for (const fn of debuggerListeners.event) {
    fn({ tabId: 10 }, 'Fetch.requestPaused', usefulEvent);
  }

  await new Promise((r) => setTimeout(r, 30));

  assert.equal(proxyCalled, false, 'vkvideo.ru/usefull.php must not call proxyFn');
  const fulfill = debuggerCommands.find((c) => c.method === 'Fetch.fulfillRequest' && c.params.requestId === 'req_vk_useful');
  assert.ok(fulfill, 'req_vk_useful must be fulfilled');
  assert.equal(fulfill.params.responseCode, 200);
  assert.equal(atob(fulfill.params.body || ''), '');
  assert.equal(getInterceptStats().telemetryBlocked, 1);
});

test('u8ToB64 correctly encodes binary data to base64 matching Buffer', () => {
  const data = new Uint8Array([72, 101, 108, 108, 111, 32, 87, 111, 114, 108, 100]); // "Hello World"
  assert.equal(u8ToB64(data), Buffer.from(data).toString('base64'));

  // Test multi-chunk buffer (70 KB)
  const large = new Uint8Array(70 * 1024);
  for (let i = 0; i < large.length; i++) large[i] = i % 256;
  assert.equal(u8ToB64(large), Buffer.from(large).toString('base64'));
});

test('Stale-While-Revalidate serves stale static asset within grace period and marks it for revalidation', () => {
  clearResponseCache();
  const staticUrl = 'https://abs.twimg.com/responsive-web/client-web/main.123.js';
  const dynamicUrl = 'https://api.x.com/1.1/users/lookup.json';
  const keyStatic = `GET:${staticUrl}:`;
  const keyDynamic = `GET:${dynamicUrl}:`;

  // Put static asset in cache
  putCachedResponse(keyStatic, {
    status: 200,
    headers: [],
    body: new Uint8Array([1, 2, 3]),
    bodyLength: 3,
  }, staticUrl);

  // Put dynamic API in cache
  putCachedResponse(keyDynamic, {
    status: 200,
    headers: [],
    body: new Uint8Array([4, 5, 6]),
    bodyLength: 3,
  }, dynamicUrl);

  // Both should be fresh immediately
  const freshStatic = getCachedResponse(keyStatic, staticUrl);
  assert.ok(freshStatic);
  assert.equal(freshStatic.isStale, undefined);

  // Simulate expiration by moving expiresAt into the past
  freshStatic.expiresAt = Date.now() - 60_000; // expired 1 minute ago

  const freshDynamic = getCachedResponse(keyDynamic, dynamicUrl);
  assert.ok(freshDynamic);
  freshDynamic.expiresAt = Date.now() - 60_000; // expired 1 minute ago

  // Dynamic API must be evicted and return null
  assert.equal(getCachedResponse(keyDynamic, dynamicUrl), null);

  // Static asset must return with isStale: true within SWR_GRACE_MS
  const staleStatic = getCachedResponse(keyStatic, staticUrl);
  assert.ok(staleStatic);
  assert.equal(staleStatic.isStale, true);

  // If expired beyond SWR_GRACE_MS, static asset must also be evicted
  freshStatic.expiresAt = Date.now() - (SWR_GRACE_MS + 10_000);
  assert.equal(getCachedResponse(keyStatic, staticUrl), null);
});

test('fast telemetry fulfills Walmart obs telemetry beacon with 200 OK "{}"', async () => {
  mockTabs.set(10, { id: 10, url: 'https://www.walmart.com/' });
  await attachTab(10, 'https://www.walmart.com/');
  setHandshakeOk(true);
  resetInterceptStats();

  let proxyCalled = false;
  configureIntercept({
    log: () => {},
    proxy: async () => { proxyCalled = true; return { ok: true, status: 200, headers: [] }; },
  });

  const walmartObsEvent = {
    requestId: 'req_walmart_obs_1',
    request: {
      url: 'https://www.walmart.com/si/elh9ie/obs',
      method: 'POST',
      headers: { Origin: 'https://www.walmart.com' },
    },
  };
  for (const fn of debuggerListeners.event) {
    fn({ tabId: 10 }, 'Fetch.requestPaused', walmartObsEvent);
  }

  await new Promise((r) => setTimeout(r, 30));

  assert.equal(proxyCalled, false, 'walmart.com/si/.../obs must not call proxyFn');
  const fulfill = debuggerCommands.find((c) => c.method === 'Fetch.fulfillRequest' && c.params.requestId === 'req_walmart_obs_1');
  assert.ok(fulfill, 'req_walmart_obs_1 must be fulfilled');
  assert.equal(fulfill.params.responseCode, 200);
  assert.equal(atob(fulfill.params.body || ''), '{}');
  assert.equal(getInterceptStats().telemetryBlocked, 1);
});

test('isGraphQlQuery correctly identifies GraphQL read queries and strictly excludes mutations', () => {
  const enc = (s) => new TextEncoder().encode(s);

  // Valid GraphQL queries
  assert.equal(
    isGraphQlQuery(enc('{"query":"query GetItem { item { id name } }"}'), 'https://www.walmart.com/swag/graphql'),
    true,
  );
  assert.equal(
    isGraphQlQuery(enc('query HomePageQuery { home { banners } }'), 'https://www.walmart.com/orchestra/home/graphql'),
    true,
  );
  assert.equal(
    isGraphQlQuery(enc('{"query": "{ user { id } }"}'), 'https://example.com/api/gql'),
    true,
  );

  // Mutations must NEVER be identified as read queries (must return false)
  assert.equal(
    isGraphQlQuery(
      enc('{"query":"mutation AddToCart($item: ID!) { addItem(id: $item) { status } }"}'),
      'https://www.walmart.com/swag/graphql',
    ),
    false,
  );
  assert.equal(
    isGraphQlQuery(
      enc('mutation { updateUser(name: "test") { id } }'),
      'https://www.walmart.com/orchestra/home/graphql',
    ),
    false,
  );

  // Non-GraphQL URLs or non-query payloads must return false
  assert.equal(
    isGraphQlQuery(enc('{"query":"test"}'), 'https://www.walmart.com/api/v1/search'),
    false,
  );
  assert.equal(
    isGraphQlQuery(enc('hello world'), 'https://www.walmart.com/swag/graphql'),
    false,
  );
  assert.equal(isGraphQlQuery(null, 'https://www.walmart.com/swag/graphql'), false);
});

test('fastBodyHash generates stable distinct hashes', () => {
  const b1 = new TextEncoder().encode('query A { a }');
  const b2 = new TextEncoder().encode('query A { a }');
  const b3 = new TextEncoder().encode('query B { b }');

  assert.equal(fastBodyHash(b1), fastBodyHash(b2));
  assert.notEqual(fastBodyHash(b1), fastBodyHash(b3));
  assert.equal(fastBodyHash(null), '0');
});

test('in-flight request deduplication coalesces concurrent identical GraphQL queries while keeping mutations uncoalesced', async () => {
  mockTabs.set(10, { id: 10, url: 'https://www.walmart.com/' });
  await attachTab(10, 'https://www.walmart.com/');
  setHandshakeOk(true);
  resetInterceptStats();

  let proxyCallCount = 0;
  let resolveProxy;
  const proxyPromise = new Promise((resolve) => {
    resolveProxy = resolve;
  });

  configureIntercept({
    log: () => {},
    proxy: async (req) => {
      proxyCallCount++;
      await proxyPromise;
      return {
        ok: true,
        status: 200,
        headers: [{ name: 'Content-Type', value: 'application/json' }],
        body: new TextEncoder().encode('{"data":{"result":"ok"}}'),
      };
    },
  });

  const queryBody = '{"query":"query SwagData { items { id } }"}';
  const queryEvent1 = {
    requestId: 'req_gql_1',
    request: {
      url: 'https://www.walmart.com/swag/graphql',
      method: 'POST',
      postData: queryBody,
      headers: {},
    },
  };
  const queryEvent2 = {
    requestId: 'req_gql_2',
    request: {
      url: 'https://www.walmart.com/swag/graphql',
      method: 'POST',
      postData: queryBody,
      headers: {},
    },
  };

  // Dispatch both concurrent identical GraphQL requests
  for (const fn of debuggerListeners.event) {
    fn({ tabId: 10 }, 'Fetch.requestPaused', queryEvent1);
    fn({ tabId: 10 }, 'Fetch.requestPaused', queryEvent2);
  }

  // Yield to microtasks so both requests process
  await new Promise((r) => setTimeout(r, 20));

  // Only 1 proxy call should be made because request 2 coalesces on request 1
  assert.equal(proxyCallCount, 1, 'Only one proxy call should be made for concurrent identical GraphQL queries');

  // Resolve proxy
  resolveProxy();
  await new Promise((r) => setTimeout(r, 30));

  // Both should be fulfilled
  const fulfill1 = debuggerCommands.find((c) => c.method === 'Fetch.fulfillRequest' && c.params.requestId === 'req_gql_1');
  const fulfill2 = debuggerCommands.find((c) => c.method === 'Fetch.fulfillRequest' && c.params.requestId === 'req_gql_2');
  assert.ok(fulfill1, 'req_gql_1 must be fulfilled');
  assert.ok(fulfill2, 'req_gql_2 must be fulfilled');
  assert.equal(getInterceptStats().coalesceHits, 1, 'Coalesce hits should increment by 1');
});

test('setSpoofProfile re-sends Emulation and replaces NewDocument script', async () => {
  debuggerCommands.length = 0;
  mockTabs.set(21, { id: 21, url: 'https://example.com/' });
  setHandshakeOk(true);
  await attachTab(21, 'https://example.com/');
  const addedBefore = debuggerCommands.filter((c) => c.method === 'Page.addScriptToEvaluateOnNewDocument').length;
  debuggerCommands.length = 0;

  const next = buildSpoofProfile({
    geo: { ...FALLBACK_GEO_PROFILE, timezoneId: 'America/Los_Angeles', country: 'US' },
    settings: { ...DEFAULT_SPOOF_SETTINGS, spoofLocale: 'en-US', spoofHwConcurrencyValue: 4 },
    chromeMajor: 141,
    token: 'reapply',
  });
  await setSpoofProfile(next);

  assert.ok(debuggerCommands.some((c) => c.method === 'Page.removeScriptToEvaluateOnNewDocument'));
  assert.ok(debuggerCommands.some((c) => c.method === 'Page.addScriptToEvaluateOnNewDocument'));
  const tz = debuggerCommands.find((c) => c.method === 'Emulation.setTimezoneOverride');
  assert.equal(tz.params.timezoneId, 'America/Los_Angeles');
  const locale = debuggerCommands.find((c) => c.method === 'Emulation.setLocaleOverride');
  assert.equal(locale.params.locale, 'en-US');
  const hw = debuggerCommands.find((c) => c.method === 'Emulation.setHardwareConcurrencyOverride');
  assert.equal(hw.params.hardwareConcurrency, 4);
  assert.ok(debuggerCommands.some((c) => c.method === 'Emulation.clearDeviceMetricsOverride'));
  assert.ok(addedBefore >= 2, 'attach injects WebRTC block and spoof scripts');
});

test('screen spoof sends device metrics; color-scheme sends emulated media', async () => {
  debuggerCommands.length = 0;
  mockTabs.set(23, { id: 23, url: 'https://example.com/' });
  setHandshakeOk(true);
  await attachTab(23, 'https://example.com/');
  debuggerCommands.length = 0;
  const next = buildSpoofProfile({
    geo: FALLBACK_GEO_PROFILE,
    settings: {
      ...DEFAULT_SPOOF_SETTINGS,
      spoofScreen: true,
      spoofScreenPreset: '1920x1080',
      spoofColorScheme: 'dark',
    },
    chromeMajor: 141,
    token: 'screen-on',
  });
  await setSpoofProfile(next);
  const metrics = debuggerCommands.find((c) => c.method === 'Emulation.setDeviceMetricsOverride');
  assert.ok(metrics);
  assert.equal(metrics.params.width, 1920);
  assert.equal(metrics.params.height, 1080);
  assert.equal(metrics.params.mobile, false);
  const media = debuggerCommands.find((c) => c.method === 'Emulation.setEmulatedMedia');
  assert.ok(media);
  assert.equal(media.params.features[0].name, 'prefers-color-scheme');
  assert.equal(media.params.features[0].value, 'dark');
});

test('proxied requests rewrite Accept-Language and User-Agent when spoof is on', async () => {
  debuggerCommands.length = 0;
  mockTabs.set(22, { id: 22, url: 'https://example.com/' });
  setHandshakeOk(true);
  await attachTab(22, 'https://example.com/');

  const profile = buildSpoofProfile({
    geo: FALLBACK_GEO_PROFILE,
    settings: DEFAULT_SPOOF_SETTINGS,
    chromeUa: 'Mozilla/5.0 Chrome/141.0.7390.65',
    token: 'hdr-on',
  });
  await setSpoofProfile(profile);

  let proxied = null;
  configureIntercept({
    log: () => {},
    proxy: async (req) => {
      proxied = req;
      return { ok: true, status: 200, headers: [], bodyB64: '' };
    },
  });

  for (const fn of debuggerListeners.event) {
    fn(
      { tabId: 22 },
      'Fetch.requestPaused',
      {
        requestId: 'req_spoof_hdr',
        request: {
          url: 'https://example.com/api',
          method: 'GET',
          headers: { 'Accept-Language': 'nl-NL', 'User-Agent': 'real' },
        },
      },
    );
  }
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(proxied);
  assert.equal(proxied.headers['User-Agent'], profile.userAgent);
  assert.equal(proxied.headers['Accept-Language'], profile.acceptLanguage);
  assert.equal(proxied.headers['Sec-CH-UA-Platform'], '"Windows"');
});

test('language spoof off fills ru-RU on Russian targets only when header is missing', async () => {
  const off = buildSpoofProfile({
    geo: FALLBACK_GEO_PROFILE,
    settings: { spoofLanguage: false, spoofUa: false, spoofHwConcurrency: false },
    chromeMajor: 141,
    token: 'hdr-off',
  });
  await setSpoofProfile(off);

  let proxied = null;
  configureIntercept({
    log: () => {},
    proxy: async (req) => {
      proxied = req;
      return { ok: true, status: 200, headers: [], bodyB64: '' };
    },
  });
  setHandshakeOk(true);
  mockTabs.set(22, { id: 22, url: 'https://rutube.ru/' });
  await attachTab(22, 'https://rutube.ru/');

  for (const fn of debuggerListeners.event) {
    fn(
      { tabId: 22 },
      'Fetch.requestPaused',
      {
        requestId: 'req_ru_lang',
        request: {
          url: 'https://rutube.ru/api/video',
          method: 'GET',
          headers: {},
        },
      },
    );
  }
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(proxied);
  assert.equal(proxied.headers['Accept-Language'], 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7');
  assert.equal(proxied.headers['User-Agent'], undefined);

  await setSpoofProfile(
    buildSpoofProfile({
      geo: FALLBACK_GEO_PROFILE,
      settings: DEFAULT_SPOOF_SETTINGS,
      chromeMajor: 141,
      token: 'restore',
    }),
  );
});

test('concurrent attachTab shares one debugger session and does not detach', async () => {
  await stopIntercept();
  debuggerCommands.length = 0;
  tabReloads.length = 0;
  mockTabs.set(30, { id: 30, url: 'https://flow.google.com/', active: true });
  setHandshakeOk(true);

  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const origAttach = chrome.debugger.attach;
  chrome.debugger.attach = async ({ tabId }, protocol) => {
    debuggerCommands.push({ type: 'attach', tabId, protocol });
    await gate;
    attachedDebuggerTabs.add(tabId);
  };

  const p1 = attachTab(30, 'https://flow.google.com/');
  const p2 = attachTab(30, 'https://flow.google.com/');
  release();
  const [a, b] = await Promise.all([p1, p2]);
  chrome.debugger.attach = origAttach;

  assert.equal(a, true);
  assert.equal(b, true);
  assert.equal(debuggerCommands.filter((c) => c.type === 'attach').length, 1);
  assert.equal(debuggerCommands.filter((c) => c.type === 'detach').length, 0);
  assert.equal(getAttachedTabCount(), 1);
  assert.equal(tabReloads.filter((r) => r.id === 30).length, 1);
  assert.equal(tabReloads.find((r) => r.id === 30).opts.bypassCache, true);
});

test('Fetch.enable not-attached is retried then succeeds without a stale map entry on failure', async () => {
  await stopIntercept();
  debuggerCommands.length = 0;
  tabReloads.length = 0;
  mockTabs.set(31, { id: 31, url: 'https://flow.google.com/' });
  setHandshakeOk(true);

  let enableFails = 1;
  const origSend = chrome.debugger.sendCommand;
  chrome.debugger.sendCommand = async ({ tabId }, method, params) => {
    debuggerCommands.push({ type: 'sendCommand', tabId, method, params });
    if (method === 'Fetch.enable' && enableFails > 0) {
      enableFails -= 1;
      throw new Error(`Debugger is not attached to the tab with id: ${tabId}`);
    }
    if (method === 'Page.addScriptToEvaluateOnNewDocument') {
      return { identifier: `script_${tabId}` };
    }
    return {};
  };

  const ok = await attachTab(31, 'https://flow.google.com/');
  chrome.debugger.sendCommand = origSend;

  assert.equal(ok, true);
  assert.equal(getAttachedTabs().some((t) => t.id === 31), true);
  const enables = debuggerCommands.filter((c) => c.method === 'Fetch.enable');
  assert.ok(enables.length >= 2, 'Fetch.enable must retry after not-attached');
  assert.equal(tabReloads.filter((r) => r.id === 31).length, 0);
});

test('Fetch.enable always failing does not leave tab in attached map and does not reload', async () => {
  await stopIntercept();
  debuggerCommands.length = 0;
  tabReloads.length = 0;
  mockTabs.set(32, { id: 32, url: 'https://flow.google.com/' });
  setHandshakeOk(true);

  const origSend = chrome.debugger.sendCommand;
  chrome.debugger.sendCommand = async ({ tabId }, method, params) => {
    debuggerCommands.push({ type: 'sendCommand', tabId, method, params });
    if (method === 'Fetch.enable') {
      throw new Error(`Debugger is not attached to the tab with id: ${tabId}`);
    }
    return {};
  };

  const ok = await attachTab(32, 'https://flow.google.com/');
  chrome.debugger.sendCommand = origSend;

  assert.equal(ok, false);
  assert.ok(!getAttachedTabs().some((t) => t.id === 32));
  assert.equal(tabReloads.filter((r) => r.id === 32).length, 0);
});

test('foreign debugger attach error does not detach', async () => {
  await stopIntercept();
  debuggerCommands.length = 0;
  mockTabs.set(33, { id: 33, url: 'https://flow.google.com/' });
  setHandshakeOk(true);

  const origAttach = chrome.debugger.attach;
  chrome.debugger.attach = async ({ tabId }, protocol) => {
    debuggerCommands.push({ type: 'attach', tabId, protocol });
    throw new Error('Another debugger is already attached to the tab');
  };

  const ok = await attachTab(33, 'https://flow.google.com/');
  chrome.debugger.attach = origAttach;

  assert.equal(ok, false);
  assert.equal(debuggerCommands.filter((c) => c.type === 'detach').length, 0);
  assert.ok(!debuggerCommands.some((c) => c.method === 'Fetch.enable'));
  assert.ok(!getAttachedTabs().some((t) => t.id === 33));
});

test('already-attached plus Fetch.enable failure does not detach a session we do not own', async () => {
  await stopIntercept();
  debuggerCommands.length = 0;
  mockTabs.set(34, { id: 34, url: 'https://example.com/' });
  setHandshakeOk(true);

  const origAttach = chrome.debugger.attach;
  const origSend = chrome.debugger.sendCommand;
  chrome.debugger.attach = async ({ tabId }, protocol) => {
    debuggerCommands.push({ type: 'attach', tabId, protocol });
    throw new Error('Debugger is already attached to the tab with id: ' + tabId);
  };
  chrome.debugger.sendCommand = async ({ tabId }, method, params) => {
    debuggerCommands.push({ type: 'sendCommand', tabId, method, params });
    if (method === 'Fetch.enable') {
      throw new Error(`Debugger is not attached to the tab with id: ${tabId}`);
    }
    return {};
  };

  const ok = await attachTab(34, 'https://example.com/');
  chrome.debugger.attach = origAttach;
  chrome.debugger.sendCommand = origSend;

  assert.equal(ok, false);
  assert.equal(debuggerCommands.filter((c) => c.type === 'detach').length, 0);
  assert.ok(!getAttachedTabs().some((t) => t.id === 34));
});

test('second attachTab on a live session does not reload again', async () => {
  await stopIntercept();
  tabReloads.length = 0;
  mockTabs.set(35, { id: 35, url: 'https://example.com/', active: true });
  setHandshakeOk(true);

  assert.equal(await attachTab(35, 'https://example.com/'), true);
  const first = tabReloads.filter((r) => r.id === 35).length;
  assert.equal(first, 1);
  assert.equal(await attachTab(35, 'https://example.com/'), true);
  assert.equal(tabReloads.filter((r) => r.id === 35).length, 1);
});

test('isUnsupportedCountryPath matches Google geo-block route only', () => {
  assert.equal(isUnsupportedCountryPath('https://flow.google.com/unsupported-country'), true);
  assert.equal(isUnsupportedCountryPath('https://flow.google.com/unsupported-country/'), true);
  assert.equal(isUnsupportedCountryPath('https://flow.google.com/'), false);
  assert.equal(isUnsupportedCountryPath('https://example.com/foo'), false);
});

test('attach of /unsupported-country navigates to origin / instead of reloading the block page', async () => {
  await stopIntercept();
  tabReloads.length = 0;
  tabUpdates.length = 0;
  mockTabs.set(36, { id: 36, url: 'https://flow.google.com/unsupported-country' });
  setHandshakeOk(true);

  assert.equal(await attachTab(36, 'https://flow.google.com/unsupported-country'), true);
  assert.equal(tabReloads.filter((r) => r.id === 36).length, 0);
  assert.equal(tabUpdates.length, 1);
  assert.equal(tabUpdates[0].id, 36);
  assert.equal(tabUpdates[0].opts.url, 'https://flow.google.com/');

  assert.equal(await attachTab(36, 'https://flow.google.com/unsupported-country'), true);
  assert.equal(tabUpdates.length, 1);
  assert.equal(tabReloads.filter((r) => r.id === 36).length, 0);
});

test('attach of a normal URL still reloads once and does not tabs.update', async () => {
  await stopIntercept();
  tabReloads.length = 0;
  tabUpdates.length = 0;
  mockTabs.set(37, { id: 37, url: 'https://example.com/foo', active: true });
  setHandshakeOk(true);

  assert.equal(await attachTab(37, 'https://example.com/foo'), true);
  assert.equal(tabReloads.filter((r) => r.id === 37).length, 1);
  assert.equal(tabReloads.find((r) => r.id === 37).opts.bypassCache, true);
  assert.equal(tabUpdates.filter((u) => u.id === 37).length, 0);
});

test('inactive tab is not force-reloaded after attach', async () => {
  await stopIntercept();
  tabReloads.length = 0;
  tabUpdates.length = 0;
  mockTabs.set(38, { id: 38, url: 'https://gemini.google.com/app', active: false });
  setHandshakeOk(true);
  assert.equal(await attachTab(38, 'https://gemini.google.com/app'), true);
  assert.equal(tabReloads.filter((r) => r.id === 38).length, 0);
  assert.equal(tabUpdates.filter((u) => u.id === 38).length, 0);
});

test('tab recoveries are serialized so the second reload waits on the first', async () => {
  await stopIntercept();
  tabReloads.length = 0;
  mockTabs.set(40, { id: 40, url: 'https://a.example/', active: true });
  mockTabs.set(41, { id: 41, url: 'https://b.example/', active: true });
  setHandshakeOk(true);

  let releaseFirst;
  const firstGate = new Promise((r) => {
    releaseFirst = r;
  });
  const origReload = chrome.tabs.reload;
  chrome.tabs.reload = async (id, opts) => {
    tabReloads.push({ id, opts });
    if (id === 40) await firstGate;
  };

  const p1 = attachTab(40, 'https://a.example/');
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(tabReloads.filter((r) => r.id === 40).length, 1);
  const p2 = attachTab(41, 'https://b.example/');
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(tabReloads.filter((r) => r.id === 41).length, 0, 'second reload must wait');
  releaseFirst();
  await Promise.all([p1, p2]);
  chrome.tabs.reload = origReload;
  assert.equal(tabReloads.filter((r) => r.id === 41).length, 1);
});

test('proxied Google requests drop SID/NID; other hosts keep cookies', async () => {
  await stopIntercept();
  mockTabs.set(50, { id: 50, url: 'https://flow.google.com/', active: true });
  mockTabs.set(51, { id: 51, url: 'https://example.com/', active: false });
  setHandshakeOk(true);
  await setSpoofProfile(cookieSpoofProfile(true, 'ck-proxy'));
  setGoogleAuthCookieSnapshot(['SID=secret', 'NID=n1', '__Secure-1PSID=x']);
  await attachTab(50, 'https://flow.google.com/');
  await attachTab(51, 'https://example.com/');

  let googleHdrs = null;
  let otherHdrs = null;
  configureIntercept({
    log: () => {},
    proxy: async (req) => {
      if (String(req.url).includes('flow.google.com')) googleHdrs = req.headers;
      else otherHdrs = req.headers;
      return { ok: true, status: 200, headers: [], bodyB64: '' };
    },
  });

  for (const fn of debuggerListeners.event) {
    fn(
      { tabId: 50 },
      'Fetch.requestPaused',
      {
        requestId: 'req_g_ck',
        request: {
          url: 'https://flow.google.com/_/x',
          method: 'GET',
          headers: { Cookie: 'SID=secret; NID=n1; PREF=p; __Secure-1PSID=x' },
        },
      },
    );
  }
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(googleHdrs);
  const gck = googleHdrs.Cookie || googleHdrs.cookie || '';
  assert.equal(gck.includes('SID=secret'), false);
  assert.equal(gck.includes('NID='), false);
  assert.equal(gck.includes('__Secure-1PSID'), false);
  assert.equal(gck.includes('PREF=p'), true);

  for (const fn of debuggerListeners.event) {
    fn(
      { tabId: 51 },
      'Fetch.requestPaused',
      {
        requestId: 'req_ex_ck',
        request: {
          url: 'https://example.com/api',
          method: 'GET',
          headers: { Cookie: 'SID=secret; session=1' },
        },
      },
    );
  }
  await new Promise((r) => setTimeout(r, 30));
  const ock = otherHdrs?.Cookie || otherHdrs?.cookie || '';
  assert.equal(ock.includes('SID=secret'), true);
  assert.equal(ock.includes('session=1'), true);
  await setSpoofProfile(cookieSpoofProfile(false, 'ck-proxy-off'));
});

test('restarting an active intercept does not classify fresh sign-in cookies as old', async () => {
  await stopIntercept();
  mockTabs.clear();
  const previousCookies = chrome.cookies;
  let value = 'old-session';
  chrome.cookies = { getAll: async () => [{ name: 'SID', value }] };
  try {
    await setSpoofProfile(cookieSpoofProfile(true, 'ck-restart'));
    await startIntercept();
    assert.ok(getGoogleAuthCookieSnapshot().has('SID=old-session'));
    value = 'fresh-sign-in';
    await startIntercept();
    assert.ok(!getGoogleAuthCookieSnapshot().has('SID=fresh-sign-in'));
    assert.equal(stripGoogleAuthCookies('SID=fresh-sign-in').cookie, 'SID=fresh-sign-in');
  } finally {
    await stopIntercept();
    chrome.cookies = previousCookies;
    setGoogleAuthCookieSnapshot([]);
    await setSpoofProfile(cookieSpoofProfile(false, 'ck-restart-off'));
  }
});

test('startIntercept does not snapshot Google cookies when isolation is off', async () => {
  await stopIntercept();
  const previousCookies = chrome.cookies;
  chrome.cookies = { getAll: async () => [{ name: 'SID', value: 'keep-me' }] };
  try {
    await setSpoofProfile(cookieSpoofProfile(false, 'ck-skip'));
    await startIntercept();
    assert.equal(getGoogleAuthCookieSnapshot().size, 0);
  } finally {
    await stopIntercept();
    chrome.cookies = previousCookies;
  }
});

test('enabling Google cookie isolation while intercepting snapshots; disabling clears', async () => {
  await stopIntercept();
  const previousCookies = chrome.cookies;
  chrome.cookies = { getAll: async () => [{ name: 'SID', value: 'live' }] };
  try {
    await setSpoofProfile(cookieSpoofProfile(false, 'ck-live-off'));
    await startIntercept();
    assert.equal(getGoogleAuthCookieSnapshot().size, 0);
    await setSpoofProfile(cookieSpoofProfile(true, 'ck-live-on'));
    assert.ok(getGoogleAuthCookieSnapshot().has('SID=live'));
    await setSpoofProfile(cookieSpoofProfile(false, 'ck-live-off2'));
    assert.equal(getGoogleAuthCookieSnapshot().size, 0);
  } finally {
    await stopIntercept();
    chrome.cookies = previousCookies;
    setGoogleAuthCookieSnapshot([]);
  }
});

test('response cache excludes private, non-cacheable and session-setting responses', () => {
  clearResponseCache();
  const response = { status: 200, body: new Uint8Array([1, 2]), bodyB64: 'AQI=' };
  for (const value of ['private, max-age=600', 'no-store', 'no-cache']) {
    putCachedResponse('sensitive', { ...response, headers: [{ name: 'Cache-Control', value }] }, 'https://example.com/');
    assert.equal(getCachedResponse('sensitive'), null);
  }
  putCachedResponse('session', { ...response, headers: [{ name: 'Set-Cookie', value: 'session=new' }] }, 'https://example.com/');
  assert.equal(getCachedResponse('session'), null);
  putCachedResponse('flow', response, 'https://flow.google.com/');
  assert.equal(getCachedResponse('flow'), null);
});

test('Flow eligibility requests are neither shared nor replayed from the extension cache', async () => {
  debuggerCommands.length = 0;
  clearResponseCache();
  setHandshakeOk(true);
  await attachTab(71, 'https://flow.google.com/');
  let count = 0;
  configureIntercept({ proxy: async () => {
    count++;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { ok: true, status: 200, body: new TextEncoder().encode('fresh eligibility'), headers: [] };
  } });
  const pause = (id) => {
    for (const listener of debuggerListeners.event) listener({ tabId: 71 }, 'Fetch.requestPaused', {
      requestId: id, request: { method: 'GET', url: 'https://flow.google.com/eligibility', headers: {} },
    });
  };
  pause('flow-check-1');
  pause('flow-check-2');
  await new Promise((resolve) => setTimeout(resolve, 40));
  pause('flow-check-3');
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(count, 3);
  assert.equal(debuggerCommands.filter((cmd) => cmd.method === 'Fetch.fulfillRequest' && cmd.params.requestId.startsWith('flow-check-')).length, 3);
  await stopIntercept();
});
