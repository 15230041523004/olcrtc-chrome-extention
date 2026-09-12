import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { networkGuardRules, tabGuardRule, enableNetworkGuard, disableNetworkGuard, isNetworkGuardEnabled, allowInterceptedTab, blockUnattachedTab } from '../extension/lib/network-guard.js';
import { WEBRTC_BLOCK_SOURCE } from '../extension/lib/webrtc-block.js';

test('guard blocks navigations and all non-carrier requests without destination exemptions', () => {
  const rules = networkGuardRules('extensionid');
  assert.equal(rules.length, 2);
  assert.ok(rules.every((rule) => rule.action.type === 'block'));
  assert.deepEqual(rules[0].condition.excludedInitiatorDomains, ['extensionid']);
  assert.deepEqual(rules[1].condition, { resourceTypes: ['main_frame'] });
  assert.ok(rules.every((rule) => !rule.condition.excludedRequestDomains));
  const tab = tabGuardRule(5);
  assert.deepEqual(tab.condition.tabIds, [5]);
  assert.equal(tab.condition.regexFilter, '^https?://');
  assert.ok(!tab.condition.resourceTypes.includes('websocket'));
  assert.ok(!tab.condition.resourceTypes.includes('webtransport'));
});

test('guard revokes stale tab exceptions, persists until release, and clears only its preferences', async () => {
  const dynamic = new Map();
  const session = new Map();
  const calls = [];
  const update = (store, { removeRuleIds = [], addRules = [] }) => {
    removeRuleIds.forEach((id) => store.delete(id));
    addRules.forEach((rule) => store.set(rule.id, rule));
  };
  globalThis.chrome = {
    runtime: { id: 'extensionid' },
    declarativeNetRequest: {
      updateDynamicRules: async (params) => update(dynamic, params),
      getDynamicRules: async () => [...dynamic.values()],
      updateSessionRules: async (params) => update(session, params),
      getSessionRules: async () => [...session.values()],
    },
    contentSettings: { location: { set: async (p) => calls.push(['geo.set', p]), clear: async (p) => calls.push(['geo.clear', p]) } },
    privacy: { network: { networkPredictionEnabled: { set: async (p) => calls.push(['prediction.set', p]), clear: async (p) => calls.push(['prediction.clear', p]) } } },
  };
  await allowInterceptedTab(9);
  await enableNetworkGuard();
  assert.equal(session.size, 0, 'restart invalidates stale allowances');
  assert.equal(await isNetworkGuardEnabled(), true);
  assert.deepEqual(calls[0], ['geo.set', { primaryPattern: '<all_urls>', setting: 'block' }]);
  await allowInterceptedTab(9);
  await blockUnattachedTab(9);
  assert.equal(session.size, 0);
  assert.equal(await isNetworkGuardEnabled(), true, 'detaching does not release the guard');
  await disableNetworkGuard();
  assert.equal(await isNetworkGuardEnabled(), false);
  assert.ok(calls.some(([name]) => name === 'geo.clear'));
  assert.ok(calls.some(([name]) => name === 'prediction.clear'));
  delete globalThis.chrome;
});

test('WebRTC block does not expose the native constructor through prototypes', () => {
  function NativePeer() { throw new Error('native network accessed'); }
  const context = vm.createContext({ RTCPeerConnection: NativePeer, webkitRTCPeerConnection: NativePeer, WebSocket: NativePeer, WebTransport: NativePeer, DOMException, navigator: {} });
  vm.runInContext(WEBRTC_BLOCK_SOURCE, context);
  for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'WebSocket', 'WebTransport']) {
    assert.throws(() => vm.runInContext(`new ${name}()`, context), { name: 'NotAllowedError' });
    assert.notEqual(Object.getPrototypeOf(context[name]), NativePeer);
    assert.notEqual(context[name].prototype.constructor, NativePeer);
  }
});
