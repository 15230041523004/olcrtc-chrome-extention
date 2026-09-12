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
  fingerprintSpoofSource,
  localeFromCountry,
  normalizeSpoofSettings,
  parseChromeMajor,
  parseChromeVersion,
} from '../extension/lib/fingerprint-spoof.js';

test('normalizeSpoofSettings defaults on and rejects unknown locale/ua/hw', () => {
  const d = normalizeSpoofSettings({});
  assert.equal(d.spoofLanguage, true);
  assert.equal(d.spoofLocale, 'auto');
  assert.equal(d.spoofUa, true);
  assert.equal(d.spoofUaPreset, 'chrome-win');
  assert.equal(d.spoofHwConcurrency, true);
  assert.equal(d.spoofHwConcurrencyValue, 8);

  const n = normalizeSpoofSettings({
    spoofLanguage: false,
    spoofLocale: 'xx-YY',
    spoofUa: false,
    spoofUaPreset: 'firefox',
    spoofHwConcurrency: false,
    spoofHwConcurrencyValue: 3,
  });
  assert.equal(n.spoofLanguage, false);
  assert.equal(n.spoofLocale, 'auto');
  assert.equal(n.spoofUa, false);
  assert.equal(n.spoofUaPreset, 'chrome-win');
  assert.equal(n.spoofHwConcurrency, false);
  assert.equal(n.spoofHwConcurrencyValue, 8);
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
  assert.match(p.userAgent, /Chrome\/141/);
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
