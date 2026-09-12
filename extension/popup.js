import { parseOlcrtcUri } from './lib/uri.js';

const uriContainer = document.getElementById('uri-container');
const uriPreview = document.getElementById('uri-preview');
const uriRoomText = document.getElementById('uri-room-text');
const uriDoneBtn = document.getElementById('uri-done-btn');
const uriToggleHint = document.getElementById('uri-toggle-hint');
const uriEl = document.getElementById('uri');
const modeEl = document.getElementById('mode');
const statusEl = document.getElementById('status');
const flagsEl = document.getElementById('flags');
const statusCard = document.getElementById('status-card');
const statusHeader = document.getElementById('status-header');
const statusPill = document.getElementById('status-pill');
const statusSummary = document.getElementById('status-summary');
const statusBlocks = document.getElementById('status-blocks');
const eventsEl = document.getElementById('events');
const logEl = document.getElementById('log');
const connectBtn = document.getElementById('connect');
const disconnectBtn = document.getElementById('disconnect');
const downloadLogBtn = document.getElementById('download-log');
const logResultEl = document.getElementById('log-result');
const debugToggle = document.getElementById('debug-toggle');
const debugAccordion = document.getElementById('debug-accordion');
const debugHint = document.getElementById('debug-hint');

const debugToggleLabel = document.querySelector('.debug-toggle-label');
const spoofLanguageEl = document.getElementById('spoof-language');
const spoofLocaleEl = document.getElementById('spoof-locale');
const spoofUaEl = document.getElementById('spoof-ua');
const spoofUaPresetEl = document.getElementById('spoof-ua-preset');
const spoofHwEl = document.getElementById('spoof-hw');
const spoofHwValueEl = document.getElementById('spoof-hw-value');
const settingsExitEl = document.getElementById('settings-exit');
const recheckExitBtn = document.getElementById('recheck-exit');
const networkGuardEl = document.getElementById('network-guard');

function extractRoom(rawUri) {
  const uri = (rawUri || '').trim();
  if (!uri) return 'No room set (click to edit)';
  try {
    const parsed = parseOlcrtcUri(uri);
    return parsed.roomId || 'Unknown room';
  } catch {
    const at = uri.indexOf('@');
    const hash = uri.indexOf('#');
    if (at >= 0) {
      const room = hash > at ? uri.slice(at + 1, hash) : uri.slice(at + 1);
      if (room.trim()) return room.trim();
    }
    const m = uri.match(/telemost\.yandex\.ru\/j\/(\d+)/);
    if (m) return m[1];
    return uri.length > 28 ? uri.slice(0, 28) + '…' : uri;
  }
}

function updateRoomPreview(uri) {
  const room = extractRoom(uri);
  uriRoomText.textContent = room;
  uriRoomText.classList.toggle('empty', !uri || !uri.trim());
}

function expandUriEditor() {
  uriContainer.classList.add('expanded');
  if (uriToggleHint) uriToggleHint.textContent = 'click done when finished';
  uriEl.focus();
  uriEl.select();
}

function collapseUriEditor() {
  uriContainer.classList.remove('expanded');
  if (uriToggleHint) uriToggleHint.textContent = 'click to edit';
  updateRoomPreview(uriEl.value);
  chrome.storage.local.set({ uri: uriEl.value });
}

uriPreview.addEventListener('click', expandUriEditor);
uriPreview.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    expandUriEditor();
  }
});

uriDoneBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  collapseUriEditor();
});

uriEl.addEventListener('input', () => {
  updateRoomPreview(uriEl.value);
});

uriEl.addEventListener('change', () => {
  chrome.storage.local.set({ uri: uriEl.value });
  updateRoomPreview(uriEl.value);
});

uriEl.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    collapseUriEditor();
  } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    collapseUriEditor();
  }
});

document.addEventListener('click', (e) => {
  if (uriContainer.classList.contains('expanded') && !uriContainer.contains(e.target)) {
    collapseUriEditor();
  }
});

function setDebugState(on) {
  const isDebug = Boolean(on);
  debugToggle.checked = isDebug;
  debugAccordion.classList.toggle('open', isDebug);
  if (debugHint) {
    debugHint.textContent = isDebug ? '(off for max speed)' : '(on for troubleshooting)';
    debugHint.classList.toggle('on', isDebug);
  }
  if (debugToggleLabel) {
    debugToggleLabel.title = isDebug
      ? 'Turn off for maximum speed'
      : 'Enable when troubleshooting is needed';
  }
}

const FLAG_LABELS = [
  ['authOk', 'auth.ok'],
  ['wsOpen', 'ws.open'],
  ['helloSent', 'hello.sent'],
  ['serverHello', 'serverHello'],
  ['subConnected', 'sub.connected'],
  ['pubConnected', 'pub.connected'],
  ['senderTransform', 'sender.transform'],
  ['remoteVp8', 'remote.vp8'],
  ['tokenOk', 'token.match'],
  ['handshakeOk', 'handshake.ok'],
  ['pingOk', 'ping.ok'],
  ['intercept', 'intercept'],
  ['blockWebrtc', 'webrtc.block'],
];

const blockEls = [];
for (const [key, label] of FLAG_LABELS) {
  const b = document.createElement('div');
  b.className = 'status-block';
  b.title = `${label}: waiting`;
  statusBlocks.appendChild(b);
  blockEls.push({ key, label, el: b });
}

statusHeader.addEventListener('click', () => {
  statusCard.classList.toggle('open');
});

let lastState = null;

chrome.storage.local.get(
  [
    'uri',
    'mode',
    'verboseLogs',
    'verboseLogsV2',
    'spoofLanguage',
    'spoofLocale',
    'spoofUa',
    'spoofUaPreset',
    'spoofHwConcurrency',
    'spoofHwConcurrencyValue',
  ],
  (stored) => {
    if (stored.uri) uriEl.value = stored.uri;
    updateRoomPreview(uriEl.value);
    modeEl.value = 'tunnel';
    chrome.storage.local.set({ mode: 'tunnel' });
    // Default to false (off) for max speed, migrate stale flag if needed
    const isDebug = stored.verboseLogsV2 ? Boolean(stored.verboseLogs) : false;
    if (!stored.verboseLogsV2) {
      chrome.storage.local.set({ verboseLogs: false, verboseLogsV2: true });
    }
    setDebugState(isDebug);
    applySpoofControls({
      spoofLanguage: stored.spoofLanguage !== false,
      spoofLocale: stored.spoofLocale || 'auto',
      spoofUa: stored.spoofUa !== false,
      spoofUaPreset: stored.spoofUaPreset || 'chrome-win',
      spoofHwConcurrency: stored.spoofHwConcurrency !== false,
      spoofHwConcurrencyValue: stored.spoofHwConcurrencyValue || 8,
    });
  },
);

let renderPending = false;
let pendingState = null;

function scheduleRender(state) {
  pendingState = state;
  if (!renderPending) {
    renderPending = true;
    requestAnimationFrame(() => {
      renderPending = false;
      if (pendingState) render(pendingState);
    });
  }
}

chrome.runtime.sendMessage({ type: 'GET_STATE' }, (res) => {
  if (res?.state) scheduleRender(res.state);
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'STATE' && msg.state) scheduleRender(msg.state);
});

connectBtn.addEventListener('click', () => {
  collapseUriEditor();
  chrome.runtime.sendMessage(
    { type: 'CONNECT', uri: uriEl.value, mode: modeEl.value },
    (res) => {
      if (res?.state) scheduleRender(res.state);
      if (res && res.ok === false) {
        statusEl.textContent = `error ${res.error}`;
        statusPill.className = 'status-pill error';
        statusPill.textContent = 'error';
        statusSummary.textContent = res.error;
      }
    },
  );
});

disconnectBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'DISCONNECT' }, (res) => {
    if (res?.state) scheduleRender(res.state);
  });
});

debugToggle.addEventListener('change', () => {
  const on = debugToggle.checked;
  setDebugState(on);
  chrome.storage.local.set({ verboseLogs: on, verboseLogsV2: true });
  chrome.runtime.sendMessage({ type: 'SET_VERBOSE_LOGS', on });
  if (lastState) render(lastState);
});

downloadLogBtn.addEventListener('click', async () => {
  try {
    const report = await chrome.runtime.sendMessage({ type: 'GET_LOG' });
    if (!report?.logs) throw new Error('Log is unavailable');
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `olcrtc-${report.exportedAt.replace(/[:.]/g, '-')}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    logResultEl.textContent = `${(report.events || []).length} events, ${report.logs.length} media`;
  } catch (err) {
    logResultEl.textContent = err.message;
  }
});

modeEl.addEventListener('change', () => {
  chrome.runtime.sendMessage({ type: 'SET_MODE', mode: modeEl.value });
});

function applySpoofControls(s) {
  if (!s) return;
  spoofLanguageEl.checked = s.spoofLanguage !== false;
  if (s.spoofLocale) spoofLocaleEl.value = s.spoofLocale;
  spoofUaEl.checked = s.spoofUa !== false;
  if (s.spoofUaPreset) spoofUaPresetEl.value = s.spoofUaPreset;
  spoofHwEl.checked = s.spoofHwConcurrency !== false;
  if (s.spoofHwConcurrencyValue != null) spoofHwValueEl.value = String(s.spoofHwConcurrencyValue);
  spoofLocaleEl.disabled = !spoofLanguageEl.checked;
  spoofUaPresetEl.disabled = !spoofUaEl.checked;
  spoofHwValueEl.disabled = !spoofHwEl.checked;
}

function currentSpoofSettings() {
  return {
    spoofLanguage: spoofLanguageEl.checked,
    spoofLocale: spoofLocaleEl.value,
    spoofUa: spoofUaEl.checked,
    spoofUaPreset: spoofUaPresetEl.value,
    spoofHwConcurrency: spoofHwEl.checked,
    spoofHwConcurrencyValue: Number(spoofHwValueEl.value),
  };
}

function persistSpoofSettings() {
  const settings = currentSpoofSettings();
  applySpoofControls(settings);
  chrome.storage.local.set(settings);
  chrome.runtime.sendMessage({ type: 'SET_SPOOF_SETTINGS', settings }, (res) => {
    if (res?.state) scheduleRender(res.state);
  });
}

for (const el of [spoofLanguageEl, spoofLocaleEl, spoofUaEl, spoofUaPresetEl, spoofHwEl, spoofHwValueEl]) {
  el.addEventListener('change', persistSpoofSettings);
}

function renderExitLine(state) {
  const exit = state?.spoof?.exit;
  const lookup = state?.spoof?.exitLookup;
  const hw = state?.spoof?.hardwareConcurrency;
  recheckExitBtn.disabled = !state?.flags?.handshakeOk || lookup?.status === 'resolving';
  recheckExitBtn.textContent = lookup?.status === 'resolving' ? 'Checking exit...' : 'Check exit through tunnel';
  if (!exit) {
    settingsExitEl.textContent = lookup?.status === 'resolving'
      ? 'Exit: checking through tunnel'
      : lookup?.status === 'unavailable'
        ? 'Exit: unknown · fallback browser profile does not verify the exit country'
        : 'Exit: waiting for handshake';
    return;
  }
  const parts = [exit.country, exit.timezoneId];
  if (exit.ip) parts.push(exit.ip);
  if (hw) parts.push(`${hw} cores`);
  settingsExitEl.textContent = `Exit: ${parts.filter(Boolean).join(' · ')}`;
}

recheckExitBtn.addEventListener('click', () => {
  recheckExitBtn.disabled = true;
  chrome.runtime.sendMessage({ type: 'RECHECK_EXIT' }, (res) => {
    if (res?.state) scheduleRender(res.state);
    if (res?.ok === false) settingsExitEl.textContent = res.error;
  });
});

uriEl.addEventListener('change', () => {
  chrome.storage.local.set({ uri: uriEl.value });
});

function renderLogs(state) {
  if (debugToggle.checked) {
    eventsEl.textContent = (state.events || []).join('\n');
    eventsEl.scrollTop = eventsEl.scrollHeight;
    logEl.textContent = (state.logs || []).join('\n');
    logEl.scrollTop = logEl.scrollHeight;
  } else {
    eventsEl.textContent = '';
    logEl.textContent = '';
  }
}

function render(state) {
  lastState = state;
  if (typeof state.verboseLogs === 'boolean' && state.verboseLogs !== debugToggle.checked) {
    setDebugState(state.verboseLogs);
  }

  const isOpen = statusCard.classList.contains('open');
  statusCard.className = `status-card ${state.status}${isOpen ? ' open' : ''}`;
  statusPill.className = `status-pill ${state.status}`;
  statusPill.textContent = state.status;

  const isConnecting = state.status === 'connecting';
  const isConnected = state.status === 'connected';
  connectBtn.disabled = isConnected || isConnecting;
  disconnectBtn.disabled = state.status === 'idle' && !state.networkGuard;
  connectBtn.textContent = isConnecting ? 'Connecting...' : (isConnected ? 'Connected' : 'Connect');

  const f = state.flags || {};
  networkGuardEl.textContent = state.networkGuard
    ? (f.handshakeOk ? 'HTTP(S) tunnel · direct fallback blocked · WS/WT blocked' : 'Direct traffic blocked · reconnect or Disconnect to release')
    : 'Direct traffic protection: off';
  let activeFlagsCount = 0;
  for (const item of blockEls) {
    const on = Boolean(f[item.key]);
    if (on) activeFlagsCount++;
    item.el.classList.toggle('on', on);
    item.el.title = `${item.label}: ${on ? 'OK' : 'waiting'}`;
  }

  if (state.status === 'connected') {
    statusSummary.textContent = `in:${f.transformIn || 0} out:${f.transformOut || 0}`;
  } else if (state.status === 'connecting') {
    statusSummary.textContent = `${activeFlagsCount}/${FLAG_LABELS.length}`;
  } else if (state.error) {
    statusSummary.textContent = state.error;
  } else {
    statusSummary.textContent = '';
  }

  statusEl.className = `status ${state.status}`;
  let text = state.status;
  if (state.error) text += ` — ${state.error}`;
  if (state.uriRedacted) text += `\n${state.uriRedacted}`;
  if (state.interceptUrl) text += `\nintercept ${state.interceptUrl}`;
  const tok = f.token ? `0x${(f.token >>> 0).toString(16).padStart(8, '0')}` : '';
  text += `\nin=${f.transformIn || 0} out=${f.transformOut || 0} mode=${state.mode} ${tok}`;
  statusEl.textContent = text;
  modeEl.value = state.mode || modeEl.value;

  flagsEl.innerHTML = '';
  for (const [key, label] of FLAG_LABELS) {
    const li = document.createElement('li');
    li.textContent = `${f[key] ? '●' : '○'} ${label}`;
    if (f[key]) li.className = 'on';
    flagsEl.appendChild(li);
  }

  renderLogs(state);
  renderExitLine(state);
}
