import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ICON_THEMES,
  DEFAULT_ICON_THEME,
  ICON_STATES,
  resolveIconState,
  getThemeBadge,
  renderIcon,
  generateIconData,
} from '../extension/lib/icon-theme.js';

test('ICON_THEMES and ICON_STATES constants', () => {
  assert.deepEqual(ICON_THEMES, ['wormhole', 'optics', 'radar']);
  assert.equal(DEFAULT_ICON_THEME, 'wormhole');
  assert.deepEqual(ICON_STATES, [
    'disconnected',
    'connecting',
    'connected',
    'active',
    'error',
  ]);
});

test('resolveIconState maps background tunnel state accurately', () => {
  // Disconnected / idle
  assert.equal(resolveIconState({ status: 'idle' }).state, 'disconnected');
  assert.equal(resolveIconState({}).state, 'disconnected');
  assert.equal(resolveIconState(null).state, 'disconnected');

  // Error state
  assert.equal(resolveIconState({ status: 'error' }).state, 'error');
  assert.equal(resolveIconState({ status: 'connected', flags: { interceptLost: true } }).state, 'error');

  // Connecting state
  assert.equal(resolveIconState({ status: 'connecting' }).state, 'connecting');
  // Connected without handshake is still considered connecting
  assert.equal(resolveIconState({ status: 'connected', flags: { handshakeOk: false } }).state, 'connecting');

  // Connected idle
  const idle = resolveIconState({
    status: 'connected',
    flags: { handshakeOk: true, transformIn: 10, transformOut: 20 },
    interceptStats: { inflightCount: 0 },
  });
  assert.equal(idle.state, 'connected');
  assert.equal(idle.inFlight, 0);

  // Connected active (in-flight count > 0)
  const activeTraffic = resolveIconState({
    status: 'connected',
    flags: { handshakeOk: true, transformIn: 100, transformOut: 200 },
    interceptStats: { inflightCount: 3 },
  }, 5);
  assert.equal(activeTraffic.state, 'active');
  assert.equal(activeTraffic.inFlight, 3);
  assert.equal(activeTraffic.frame, 5);
  assert.ok(activeTraffic.loadPercent > 0 && activeTraffic.loadPercent <= 100);

  // Fallback in-flight from flags.intercept when stats missing
  const fallbackActive = resolveIconState({
    status: 'connected',
    flags: { handshakeOk: true, intercept: true },
  });
  assert.equal(fallbackActive.state, 'active');
  assert.equal(fallbackActive.inFlight, 1);
});

test('getThemeBadge returns appropriate badge text and color for all themes', () => {
  // Wormhole theme: never shows any badge overlays
  for (const state of ICON_STATES) {
    const b = getThemeBadge('wormhole', state, { inFlight: 5, loadPercent: 80 });
    assert.deepEqual(b, { text: '', color: '#00000000' });
  }

  // Radar theme: clean without badges
  for (const state of ICON_STATES) {
    const b = getThemeBadge('radar', state, { inFlight: 5, loadPercent: 80 });
    assert.deepEqual(b, { text: '', color: '#00000000' });
  }

  // Optics theme: error badge
  assert.deepEqual(getThemeBadge('optics', 'error'), { text: '!', color: '#dc2626' });

  // Optics active traffic with load <= 40%
  const opticsLow = getThemeBadge('optics', 'active', { inFlight: 1, loadPercent: 30 });
  assert.equal(opticsLow.text, '30%');
  assert.equal(opticsLow.color, '#10b981');

  // Optics active traffic with load > 40% and <= 75%
  const opticsMed = getThemeBadge('optics', 'active', { inFlight: 2, loadPercent: 60 });
  assert.equal(opticsMed.text, '60%');
  assert.equal(opticsMed.color, '#f59e0b');

  // Optics active traffic with load > 75%
  const opticsHigh = getThemeBadge('optics', 'active', { inFlight: 4, loadPercent: 90 });
  assert.equal(opticsHigh.text, '90%');
  assert.equal(opticsHigh.color, '#ef4444');

  // Optics active traffic with inFlight > 9
  const opticsBusy = getThemeBadge('optics', 'active', { inFlight: 12, loadPercent: 95 });
  assert.equal(opticsBusy.text, '12');
  assert.equal(opticsBusy.color, '#ef4444');

  // Throughput speed badge (showThroughput: true)
  const tpIdle = getThemeBadge('wormhole', 'connected', { showThroughput: true, speedMbps: 0, inFlight: 0 });
  assert.equal(tpIdle.text, '');

  const tpLow = getThemeBadge('wormhole', 'connected', { showThroughput: true, speedMbps: 1.25 });
  assert.equal(tpLow.text, '1.3M');
  assert.equal(tpLow.color, '#10b981');

  const tpMed = getThemeBadge('wormhole', 'connected', { showThroughput: true, speedMbps: 24.6 });
  assert.equal(tpMed.text, '25M');
  assert.equal(tpMed.color, '#f59e0b');

  const tpHigh = getThemeBadge('wormhole', 'connected', { showThroughput: true, speedMbps: 75.2 });
  assert.equal(tpHigh.text, '75M');
  assert.equal(tpHigh.color, '#ef4444');
});

test('renderIcon generates valid image data structures for all themes and states', () => {
  for (const theme of [...ICON_THEMES, 'unknown_theme']) {
    for (const state of [...ICON_STATES, 'unknown_state']) {
      const icon16 = renderIcon(theme, state, 16, { frame: 1, loadPercent: 50 });
      assert.ok(icon16);
      assert.equal(icon16.width, 16);
      assert.equal(icon16.height, 16);
      assert.equal(icon16.data.length, 16 * 16 * 4);

      const icon32 = renderIcon(theme, state, 32, { frame: 2, loadPercent: 80 });
      assert.ok(icon32);
      assert.equal(icon32.width, 32);
      assert.equal(icon32.height, 32);
      assert.equal(icon32.data.length, 32 * 32 * 4);
    }
  }
});

test('generateIconData returns dictionary with 16 and 32 sizes', () => {
  const data = generateIconData('wormhole', 'connected', { frame: 0 });
  assert.ok(data[16]);
  assert.ok(data[32]);
  assert.equal(data[16].width, 16);
  assert.equal(data[32].width, 32);
});

