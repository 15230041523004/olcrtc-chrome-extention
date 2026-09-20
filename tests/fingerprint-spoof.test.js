import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { FALLBACK_GEO_PROFILE } from '../extension/lib/geo-spoof.js';
import {
  acceptLanguageFor,
  applyHeaderSpoof,
  buildSpoofProfile,
  buildUaPreset,
  DEFAULT_SPOOF_SETTINGS,
  deviceMemoryFor,
  fingerprintSpoofSource,
  fontsForUaPreset,
  fingerprintSeed,
  localeFromCountry,
  normalizeSpoofSettings,
  parseChromeMajor,
  parseChromeVersion,
  screenSpec,
  seedFromToken,
  spoofLogLine,
  webglForUaPreset,
} from '../extension/lib/fingerprint-spoof.js';

test('normalizeSpoofSettings defaults on and rejects unknown locale/ua/hw', () => {
  const d = normalizeSpoofSettings({});
  assert.equal(d.spoofLanguage, true);
  assert.equal(d.spoofLocale, 'auto');
  assert.equal(d.spoofUa, true);
  assert.equal(d.spoofUaPreset, 'chrome-win');
  assert.equal(d.spoofHwConcurrency, true);
  assert.equal(d.spoofHwConcurrencyValue, 8);
  assert.equal(d.stripGoogleAuthCookies, false);
  assert.equal(DEFAULT_SPOOF_SETTINGS.stripGoogleAuthCookies, false);
  assert.equal(d.spoofScreen, false);
  assert.equal(d.spoofScreenPreset, '1920x1080');
  assert.equal(d.spoofColorScheme, 'off');
  assert.equal(d.spoofRender, true);

  const n = normalizeSpoofSettings({
    spoofLanguage: false,
    spoofLocale: 'xx-YY',
    spoofUa: false,
    spoofUaPreset: 'firefox',
    spoofHwConcurrency: false,
    spoofHwConcurrencyValue: 3,
    stripGoogleAuthCookies: true,
  });
  assert.equal(n.spoofLanguage, false);
  assert.equal(n.spoofLocale, 'auto');
  assert.equal(n.spoofUa, false);
  assert.equal(n.spoofUaPreset, 'chrome-win');
  assert.equal(n.spoofHwConcurrency, false);
  assert.equal(n.spoofHwConcurrencyValue, 8);
  assert.equal(n.stripGoogleAuthCookies, true);
  assert.equal(normalizeSpoofSettings({ stripGoogleAuthCookies: 'yes' }).stripGoogleAuthCookies, false);
  const extra = normalizeSpoofSettings({
    spoofScreen: true,
    spoofScreenPreset: '2560x1440',
    spoofColorScheme: 'dark',
    spoofRender: false,
  });
  assert.equal(extra.spoofScreen, true);
  assert.equal(extra.spoofScreenPreset, '2560x1440');
  assert.equal(extra.spoofColorScheme, 'dark');
  assert.equal(extra.spoofRender, false);
  assert.equal(normalizeSpoofSettings({ spoofScreenPreset: '4k', spoofColorScheme: 'sepia' }).spoofScreenPreset, '1920x1080');
});

test('localeFromCountry maps exit country and falls back to en-US', () => {
  assert.equal(localeFromCountry('US'), 'en-US');
  assert.equal(localeFromCountry('gb'), 'en-GB');
  assert.equal(localeFromCountry('NL'), 'nl-NL');
  assert.equal(localeFromCountry('RU'), 'ru-RU');
  assert.equal(localeFromCountry('DE'), 'de-DE');
  assert.equal(localeFromCountry('BR'), 'en-US');
});

test('buildUaPreset keeps Chrome major from real UA', () => {
  const ua = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.7390.65 Safari/537.36';
  assert.equal(parseChromeVersion(ua), '141.0.7390.65');
  assert.equal(parseChromeMajor(ua), 141);
  const win = buildUaPreset('chrome-win', ua);
  assert.match(win.userAgent, /Windows NT 10\.0/);
  assert.match(win.userAgent, /Chrome\/141\.0\.7390\.65/);
  assert.equal(win.platform, 'Win32');
  assert.equal(win.userAgentData.platform, 'Windows');
  assert.equal(win.userAgentMetadata.platform, 'Windows');
  assert.equal(win.clientHints.platform, '"Windows"');

  const mac = buildUaPreset('chrome-mac', 141);
  assert.match(mac.userAgent, /Macintosh/);
  assert.match(mac.userAgent, /Chrome\/141\.0\.0\.0/);
  assert.equal(mac.userAgentData.platform, 'macOS');
});

test('buildSpoofProfile auto locale follows exit country', () => {
  const p = buildSpoofProfile({
    geo: { ...FALLBACK_GEO_PROFILE, country: 'GB', timezoneId: 'Europe/London', latitude: 51.5, longitude: -0.1 },
    settings: { ...DEFAULT_SPOOF_SETTINGS, spoofLocale: 'auto' },
    chromeUa: 'Mozilla/5.0 Chrome/141.0.7390.65',
    token: 't1',
  });
  assert.equal(p.locale, 'en-GB');
  assert.equal(p.timezoneId, 'Europe/London');
  assert.equal(p.hardwareConcurrency, 8);
  assert.equal(p.deviceMemory, 8);
  assert.equal(p.maxTouchPoints, 0);
  assert.equal(p.vendor, 'Google Inc.');
  assert.equal(p.screen, null);
  assert.equal(p.spoofRender, true);
  assert.equal(p.webgl.vendor, webglForUaPreset('chrome-win').vendor);
  assert.equal(p.stripGoogleAuthCookies, false);
  assert.match(p.userAgent, /Chrome\/141/);
  assert.match(spoofLogLine(p), /cookie=off/);
  assert.match(spoofLogLine(p), /screen=off/);
  assert.match(spoofLogLine(p), /render=on/);
  const isolated = buildSpoofProfile({
    geo: FALLBACK_GEO_PROFILE,
    settings: { ...DEFAULT_SPOOF_SETTINGS, stripGoogleAuthCookies: true },
    chromeMajor: 141,
    token: 't-cookie',
  });
  assert.equal(isolated.stripGoogleAuthCookies, true);
  assert.match(spoofLogLine(isolated), /cookie=on/);
});

test('applyHeaderSpoof overwrites UA and Accept-Language only when enabled', () => {
  const on = buildSpoofProfile({
    geo: FALLBACK_GEO_PROFILE,
    settings: DEFAULT_SPOOF_SETTINGS,
    chromeMajor: 141,
    token: 'h1',
  });
  const headers = {
    'accept-language': 'nl-NL,nl;q=0.9',
    'user-agent': 'real',
    'sec-ch-ua-platform': '"Linux"',
  };
  applyHeaderSpoof(headers, on);
  assert.equal(headers['Accept-Language'], acceptLanguageFor('en-US'));
  assert.equal(headers['User-Agent'], on.userAgent);
  assert.equal(headers['Sec-CH-UA-Platform'], '"Windows"');
  assert.equal(headers['accept-language'], undefined);
  assert.equal(headers['user-agent'], undefined);

  const off = buildSpoofProfile({
    geo: FALLBACK_GEO_PROFILE,
    settings: { spoofLanguage: false, spoofUa: false, spoofHwConcurrency: false },
    chromeMajor: 141,
    token: 'h2',
  });
  const keep = { 'Accept-Language': 'nl-NL', 'User-Agent': 'real' };
  applyHeaderSpoof(keep, off);
  assert.equal(keep['Accept-Language'], 'nl-NL');
  assert.equal(keep['User-Agent'], 'real');
});

test('fingerprintSpoofSource interpolates via JSON and stubs geo/language/ua/hw', async () => {
  const profile = buildSpoofProfile({
    geo: FALLBACK_GEO_PROFILE,
    settings: DEFAULT_SPOOF_SETTINGS,
    chromeUa: 'Mozilla/5.0 Chrome/141.0.7390.65',
    token: 'inj1',
  });
  const src = fingerprintSpoofSource(profile);
  assert.ok(src.includes(JSON.stringify(profile.token)));
  assert.ok(src.includes(String(FALLBACK_GEO_PROFILE.latitude)));
  assert.ok(src.includes('geolocation'));
  assert.ok(src.includes('hardwareConcurrency'));

  const proto = {
    language: 'nl-NL',
    languages: ['nl-NL'],
    userAgent: 'real-ua',
    appVersion: 'real-app',
    platform: 'Linux x86_64',
    hardwareConcurrency: 32,
    geolocation: { native: true },
  };
  const navigator = Object.create(proto);
  navigator.permissions = {
    query: async () => ({ state: 'prompt' }),
  };
  const sandbox = {
    navigator,
    queueMicrotask: (fn) => fn(),
    Date,
    Promise,
    Object,
    Array,
    isFinite,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(src, sandbox);

  assert.equal(navigator.language, 'en-US');
  assert.equal(JSON.stringify([...navigator.languages]), JSON.stringify(['en-US', 'en']));
  assert.match(navigator.userAgent, /Windows NT 10\.0/);
  assert.equal(navigator.platform, 'Win32');
  assert.equal(navigator.hardwareConcurrency, 8);
  assert.equal(navigator.userAgentData.platform, 'Windows');

  let pos = null;
  navigator.geolocation.getCurrentPosition((p) => {
    pos = p;
  });
  assert.ok(pos);
  assert.equal(pos.coords.latitude, FALLBACK_GEO_PROFILE.latitude);
  assert.equal(pos.coords.longitude, FALLBACK_GEO_PROFILE.longitude);

  const perm = await navigator.permissions.query({ name: 'geolocation' });
  assert.equal(perm.state, 'granted');

  const entropy = await navigator.userAgentData.getHighEntropyValues(['platform', 'architecture']);
  assert.equal(entropy.platform, 'Windows');
  assert.equal(entropy.architecture, 'x86');
});

test('fingerprintSpoofSource restores native language/ua/hw when those spoofs are off', () => {
  const on = buildSpoofProfile({
    geo: FALLBACK_GEO_PROFILE,
    settings: DEFAULT_SPOOF_SETTINGS,
    chromeMajor: 141,
    token: 'a',
  });
  const off = buildSpoofProfile({
    geo: FALLBACK_GEO_PROFILE,
    settings: { spoofLanguage: false, spoofUa: false, spoofHwConcurrency: false },
    chromeMajor: 141,
    token: 'b',
  });
  const proto = {
    language: 'nl-NL',
    userAgent: 'real-ua',
    platform: 'Linux x86_64',
    hardwareConcurrency: 32,
  };
  const navigator = Object.create(proto);
  const sandbox = {
    navigator,
    queueMicrotask: (fn) => fn(),
    Date,
    Promise,
    Object,
    Array,
    isFinite,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(fingerprintSpoofSource(on), sandbox);
  assert.equal(navigator.language, 'en-US');
  vm.runInNewContext(fingerprintSpoofSource(off), sandbox);
  assert.equal(navigator.language, 'nl-NL');
  assert.equal(navigator.userAgent, 'real-ua');
  assert.equal(navigator.hardwareConcurrency, 32);
});

test('deviceMemory follows hw and is clamped to Chrome’s 8 GB cap', () => {
  assert.equal(deviceMemoryFor(2), 2);
  assert.equal(deviceMemoryFor(4), 4);
  assert.equal(deviceMemoryFor(8), 8);
  assert.equal(deviceMemoryFor(16), 8);
});

test('screen and webgl presets follow UA OS', () => {
  const win = screenSpec('1920x1080', 'chrome-win');
  assert.equal(win.width, 1920);
  assert.equal(win.availHeight, 1040);
  const mac = screenSpec('1920x1080', 'chrome-mac');
  assert.equal(mac.availHeight, 1055);
  assert.match(webglForUaPreset('chrome-mac').renderer, /Apple M1/);
  assert.match(webglForUaPreset('chrome-win').renderer, /Direct3D11/);
  assert.ok(fontsForUaPreset('chrome-win').includes('segoe ui'));
  assert.equal(seedFromToken('abc'), seedFromToken('abc'));
  assert.notEqual(seedFromToken('abc'), seedFromToken('abd'));
});

test('buildSpoofProfile carries screen metrics only when enabled', () => {
  const on = buildSpoofProfile({
    geo: FALLBACK_GEO_PROFILE,
    settings: { ...DEFAULT_SPOOF_SETTINGS, spoofScreen: true, spoofScreenPreset: '2560x1440', spoofColorScheme: 'dark' },
    chromeMajor: 141,
    token: 'scr',
  });
  assert.equal(on.screen.width, 2560);
  assert.equal(on.screen.height, 1440);
  assert.equal(on.spoofColorScheme, 'dark');
  assert.match(spoofLogLine(on), /screen=2560x1440/);
  assert.match(spoofLogLine(on), /color=dark/);
});

test('fingerprintSpoofSource stubs deviceMemory and native-chrome fields', () => {
  const profile = buildSpoofProfile({
    geo: FALLBACK_GEO_PROFILE,
    settings: { ...DEFAULT_SPOOF_SETTINGS, spoofHwConcurrencyValue: 4 },
    chromeMajor: 141,
    token: 'nav2',
  });
  const navigator = Object.create({
    deviceMemory: 32,
    maxTouchPoints: 5,
    vendor: 'odd',
    product: 'odd',
    pdfViewerEnabled: false,
    hardwareConcurrency: 32,
  });
  const screen = Object.create({ width: 100, height: 100 });
  const sandbox = {
    navigator,
    screen,
    queueMicrotask: (fn) => fn(),
    Date,
    Promise,
    Object,
    Array,
    isFinite,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(fingerprintSpoofSource(profile), sandbox);
  assert.equal(navigator.deviceMemory, 4);
  assert.equal(navigator.maxTouchPoints, 0);
  assert.equal(navigator.vendor, 'Google Inc.');
  assert.equal(navigator.product, 'Gecko');
  assert.equal(navigator.pdfViewerEnabled, true);
});

test('render seed is determined by Settings, not Connect time or token', () => {
  const a = buildSpoofProfile({
    geo: FALLBACK_GEO_PROFILE,
    settings: DEFAULT_SPOOF_SETTINGS,
    chromeMajor: 141,
    token: 'connect-1',
  });
  const b = buildSpoofProfile({
    geo: { ...FALLBACK_GEO_PROFILE, country: 'GB', timezoneId: 'Europe/London', latitude: 51.5, longitude: -0.1 },
    settings: DEFAULT_SPOOF_SETTINGS,
    chromeMajor: 141,
    token: 'connect-2',
  });
  const c = buildSpoofProfile({
    geo: FALLBACK_GEO_PROFILE,
    settings: DEFAULT_SPOOF_SETTINGS,
    chromeMajor: 141,
  });
  assert.equal(a.renderSeed, b.renderSeed);
  assert.equal(a.renderSeed, c.renderSeed);
  assert.equal(a.renderSeed, fingerprintSeed(DEFAULT_SPOOF_SETTINGS));
  const srcA = fingerprintSpoofSource(a);
  const srcB = fingerprintSpoofSource(b);
  assert.ok(srcA.includes(`"seed":${a.renderSeed}`));
  assert.ok(srcB.includes(`"seed":${a.renderSeed}`));
  assert.ok(!srcA.includes(Date.now().toString(36)));

  const mac = buildSpoofProfile({
    geo: FALLBACK_GEO_PROFILE,
    settings: { ...DEFAULT_SPOOF_SETTINGS, spoofUaPreset: 'chrome-mac' },
    chromeMajor: 141,
    token: 'connect-1',
  });
  assert.notEqual(mac.renderSeed, a.renderSeed);

  const hw = buildSpoofProfile({
    geo: FALLBACK_GEO_PROFILE,
    settings: { ...DEFAULT_SPOOF_SETTINGS, spoofHwConcurrencyValue: 4 },
    chromeMajor: 141,
  });
  assert.notEqual(hw.renderSeed, a.renderSeed);
  assert.equal(fingerprintSeed({ ...DEFAULT_SPOOF_SETTINGS }), fingerprintSeed({ ...DEFAULT_SPOOF_SETTINGS, stripGoogleAuthCookies: true }));
});

test('render spoof injects stable canvas/webgl/audio/font hooks; off restores skip', () => {
  const on = buildSpoofProfile({
    geo: FALLBACK_GEO_PROFILE,
    settings: DEFAULT_SPOOF_SETTINGS,
    chromeMajor: 141,
    token: 'rend-on',
  });
  const off = buildSpoofProfile({
    geo: FALLBACK_GEO_PROFILE,
    settings: { ...DEFAULT_SPOOF_SETTINGS, spoofRender: false },
    chromeMajor: 141,
    token: 'rend-off',
  });
  const onSrc = fingerprintSpoofSource(on);
  const offSrc = fingerprintSpoofSource(off);
  assert.ok(onSrc.includes('"render":{'));
  assert.ok(onSrc.includes('toDataURL'));
  assert.ok(onSrc.includes('getParameter'));
  assert.ok(onSrc.includes('startRendering'));
  assert.ok(onSrc.includes('fonts'));
  assert.match(onSrc, /"seed":\d+/);
  assert.ok(offSrc.includes('"render":null'));
});
