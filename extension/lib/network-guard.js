// Browser-side fallback for requests which never reach CDP Fetch (new tabs,
// detached targets, workers, WebSocket and WebTransport). Dynamic rules survive
// service-worker and browser restarts; only an explicit disconnect removes them.
export const NETWORK_GUARD_RULE_IDS = Object.freeze([910001, 910002]);
const TAB_RULE_BASE = 1_000_000;
const HTTP_RESOURCE_TYPES = Object.freeze([
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font',
  'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'webbundle', 'other',
]);

export function tabGuardRule(tabId) {
  return {
    id: TAB_RULE_BASE + tabId,
    priority: 2,
    action: { type: 'allow' },
    condition: { tabIds: [tabId], regexFilter: '^https?://', resourceTypes: [...HTTP_RESOURCE_TYPES] },
  };
}

export async function allowInterceptedTab(tabId) {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [TAB_RULE_BASE + tabId], addRules: [tabGuardRule(tabId)],
  });
}

export async function blockUnattachedTab(tabId) {
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [TAB_RULE_BASE + tabId] });
}

export async function clearInterceptedTabs() {
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  const ids = rules.filter(({ id }) => id >= TAB_RULE_BASE).map(({ id }) => id);
  if (ids.length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });
}

export function networkGuardRules(extensionId) {
  if (!extensionId) throw new Error('Missing extension ID for network guard');
  return [
    {
      id: NETWORK_GUARD_RULE_IDS[0],
      priority: 1,
      action: { type: 'block' },
      condition: {
        excludedResourceTypes: ['main_frame'],
        // Only the extension carrier may use the network directly. Never
        // exempt destination domains: sites could use those domains to leak.
        excludedInitiatorDomains: [extensionId],
      },
    },
    {
      id: NETWORK_GUARD_RULE_IDS[1],
      priority: 1,
      action: { type: 'block' },
      // Also guard navigations initiated by chrome.tabs.update/create.
      condition: { resourceTypes: ['main_frame'] },
    },
  ];
}

export async function enableNetworkGuard() {
  await clearInterceptedTabs();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [...NETWORK_GUARD_RULE_IDS],
    addRules: networkGuardRules(chrome.runtime.id),
  });
  // This denies native GPS/Wi-Fi location even if a page bypasses a JS stub
  // or the debugger detaches. It does not change the offscreen WebRTC carrier.
  await chrome.contentSettings.location.set({ primaryPattern: '<all_urls>', setting: 'block' });
  await chrome.privacy.network.networkPredictionEnabled.set({ value: false });
}

export async function isNetworkGuardEnabled() {
  const rules = await chrome.declarativeNetRequest.getDynamicRules();
  return rules.some(({ id }) => NETWORK_GUARD_RULE_IDS.includes(id));
}

export async function disableNetworkGuard() {
  // Clear only this extension's settings; Chrome restores underlying user or
  // policy preferences. Do not overwrite them with guessed previous values.
  await chrome.contentSettings.location.clear({});
  await chrome.privacy.network.networkPredictionEnabled.clear({});
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [...NETWORK_GUARD_RULE_IDS] });
  await clearInterceptedTabs();
}
