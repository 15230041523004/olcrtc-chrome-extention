import test from 'node:test';
import assert from 'node:assert/strict';

test('connect guards before carrier startup; disconnect cancels a pending geo lookup and ignores late events', async () => {
  const listeners = [];
  const dynamic = new Map();
  const session = new Map();
  const calls = [];
  let finishGeo;
  const event = { addListener() {} };
  const update = (store, { removeRuleIds = [], addRules = [] }) => {
    removeRuleIds.forEach((id) => store.delete(id));
    addRules.forEach((rule) => store.set(rule.id, rule));
  };
  globalThis.chrome = {
    runtime: {
      id: 'fixture', onInstalled: event, onStartup: event,
      onMessage: { addListener: (fn) => listeners.push(fn) },
      getManifest: () => ({ version: 'test' }),
      sendMessage: async (msg) => {
        if (msg.dest !== 'offscreen') return {};
        calls.push(msg.type);
        if (msg.type === 'START') {
          assert.equal(dynamic.size, 2, 'block rules must exist before carrier startup');
          assert.ok(session.size > 0, 'existing tabs must already be intercepted');
        }
        if (msg.type === 'HTTP_PROXY') return new Promise((resolve) => { finishGeo = resolve; });
        return { ok: true };
      },
    },
    alarms: { create() {}, onAlarm: event },
    storage: { local: { get: (defaults, callback) => callback(defaults), set: async () => {} } },
    offscreen: { hasDocument: async () => true, closeDocument: async () => {} },
    declarativeNetRequest: {
      updateDynamicRules: async (params) => update(dynamic, params), getDynamicRules: async () => [...dynamic.values()],
      updateSessionRules: async (params) => update(session, params), getSessionRules: async () => [...session.values()],
    },
    contentSettings: { location: { set: async () => {}, clear: async () => {} } },
    privacy: { network: { networkPredictionEnabled: { set: async () => {}, clear: async () => {} } } },
    debugger: {
      attach: async () => {}, detach: async () => {}, onEvent: event, onDetach: event,
      sendCommand: async (_source, method) => method === 'Page.addScriptToEvaluateOnNewDocument' ? { identifier: 'script' } : {},
    },
    tabs: {
      query: async () => [{ id: 1, url: 'https://example.test/', active: true }],
      get: async () => ({ id: 1, url: 'https://example.test/', active: true }), reload: async () => {},
      onCreated: event, onUpdated: event, onRemoved: event,
    },
  };
  await import('../extension/background.js');
  const request = (msg) => new Promise((resolve) => listeners[0](msg, {}, resolve));
  const emit = (type, data = {}) => listeners[0]({ source: 'offscreen', type: 'EVENT', event: { type, ...data } }, {}, () => {});
  const connected = await request({ type: 'CONNECT', uri: `olcrtc://telemost?vp8channel@123456#${'a'.repeat(64)}` });
  assert.equal(connected.ok, true);
  assert.equal(connected.state.networkGuard, true);
  assert.ok(calls.includes('START'));
  emit('tunnel.flags', { handshakeOk: true });
  assert.equal(typeof finishGeo, 'function');
  emit('pc.failed', { side: 'pub', state: 'failed' });
  // A carrier failure retains browser blocks until an explicit disconnect.
  assert.equal(dynamic.size, 2);
  const disconnected = await request({ type: 'DISCONNECT' });
  assert.equal(disconnected.ok, true);
  assert.equal(dynamic.size, 0);
  assert.equal(session.size, 0);
  finishGeo({ ok: true, status: 200, body: JSON.stringify({ ip: '192.0.2.1', latitude: 52, longitude: 13, country: 'DE', timezone: 'Europe/Berlin' }) });
  emit('tunnel.flags', { handshakeOk: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const { state } = await request({ type: 'GET_STATE' });
  assert.equal(state.status, 'idle');
  assert.equal(state.networkGuard, false);
  assert.equal(state.flags.handshakeOk, false);
  assert.equal(state.spoof.exit, null);
  assert.equal(dynamic.size, 0, 'late geo/event completion must not rearm the guard');
});

test('explicit disconnect can release persistent blocks after startup protection fails', async () => {
  const { networkGuardRules, isNetworkGuardEnabled } = await import('../extension/lib/network-guard.js');
  await chrome.declarativeNetRequest.updateDynamicRules({ addRules: networkGuardRules(chrome.runtime.id) });
  const original = chrome.privacy.network.networkPredictionEnabled.set;
  chrome.privacy.network.networkPredictionEnabled.set = async () => { throw new Error('preference controlled'); };
  let listener;
  chrome.runtime.onMessage.addListener = (fn) => { listener = fn; };
  await import('../extension/background.js?failed-guard-restore');
  await new Promise((resolve) => setTimeout(resolve, 10));
  const response = await new Promise((resolve) => listener({ type: 'DISCONNECT' }, {}, resolve));
  assert.equal(response.ok, true);
  assert.equal(response.state.networkGuard, false);
  assert.equal(await isNetworkGuardEnabled(), false);
  chrome.privacy.network.networkPredictionEnabled.set = original;
});

test('failed exit lookup stays unknown in the exported log and can be rechecked through the tunnel', async () => {
  const originalSend = chrome.runtime.sendMessage;
  let proxyResponse = { ok: true, status: 403, body: 'blocked provider' };
  let proxyCalls = 0;
  chrome.runtime.sendMessage = async (msg) => {
    if (msg.type === 'HTTP_PROXY') { proxyCalls++; return proxyResponse; }
    return originalSend(msg);
  };
  let listener;
  chrome.runtime.onMessage.addListener = (fn) => { listener = fn; };
  await import('../extension/background.js?exit-diagnostics');
  const request = (msg) => new Promise((resolve) => listener(msg, {}, resolve));
  const disconnectedCheck = await request({ type: 'RECHECK_EXIT' });
  assert.equal(disconnectedCheck.ok, false);
  assert.equal(proxyCalls, 0, 'no direct-network fallback while disconnected');
  await request({ type: 'CONNECT', uri: `olcrtc://telemost?vp8channel@123456#${'a'.repeat(64)}` });
  listener({ source: 'offscreen', type: 'EVENT', event: { type: 'tunnel.flags', handshakeOk: true } }, {}, () => {});
  await request({ type: 'RECHECK_EXIT' });
  const failed = await request({ type: 'GET_LOG' });
  assert.equal(proxyCalls, 2, 'manual and automatic checks share the pending lookup');
  assert.equal(failed.spoof.exit, null, 'fallback US profile is not an observed exit');
  assert.equal(failed.spoof.exitLookup.status, 'unavailable');
  assert.equal(failed.spoof.exitLookup.attempts.length, 2);
  assert.equal(failed.spoof.exitLookup.attempts[0].status, 403);
  assert.equal(failed.networkGuard, true);
  proxyResponse = { ok: true, status: 200, body: JSON.stringify({ ip: '192.0.2.1', country: 'US', loc: '40.7,-74.0', timezone: 'America/New_York' }) };
  const checked = await request({ type: 'RECHECK_EXIT' });
  assert.equal(checked.state.spoof.exit.ip, '192.0.2.1');
  const report = await request({ type: 'GET_LOG' });
  assert.equal(report.spoof.exitLookup.status, 'resolved');
  assert.equal(report.spoof.exit.country, 'US');
  assert.equal(report.spoof.browserGeo.fallback, false);
  assert.ok(report.spoof.exitLookup.checkedAt);
  assert.equal(report.uri, undefined);
  await request({ type: 'DISCONNECT' });
  chrome.runtime.sendMessage = originalSend;
});
