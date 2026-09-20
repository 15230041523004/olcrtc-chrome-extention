import { FALLBACK_GEO_PROFILE, normalizeGeoProfile } from './geo-spoof.js';

export const LOCALES = Object.freeze(['auto', 'en-US', 'en-GB', 'ru-RU', 'nl-NL']);
export const UA_PRESETS = Object.freeze(['chrome-win', 'chrome-mac', 'chrome-linux']);
export const HW_VALUES = Object.freeze([2, 4, 8, 12, 16]);
export const SCREEN_PRESETS = Object.freeze(['1920x1080', '2560x1440', '1920x1200', '1366x768']);
export const COLOR_SCHEMES = Object.freeze(['off', 'light', 'dark']);

export const DEFAULT_SPOOF_SETTINGS = Object.freeze({
  spoofLanguage: true,
  spoofLocale: 'auto',
  spoofUa: true,
  spoofUaPreset: 'chrome-win',
  spoofHwConcurrency: true,
  spoofHwConcurrencyValue: 8,
  stripGoogleAuthCookies: false,
  spoofScreen: false,
  spoofScreenPreset: '1920x1080',
  spoofColorScheme: 'off',
  spoofRender: true,
});

const COUNTRY_LOCALE = Object.freeze({
  US: 'en-US',
  GB: 'en-GB',
  DE: 'de-DE',
  NL: 'nl-NL',
  RU: 'ru-RU',
});

const LOCALE_LANGS = Object.freeze({
  'en-US': ['en-US', 'en'],
  'en-GB': ['en-GB', 'en'],
  'ru-RU': ['ru-RU', 'ru', 'en-US', 'en'],
  'nl-NL': ['nl-NL', 'nl', 'en-US', 'en'],
  'de-DE': ['de-DE', 'de', 'en-US', 'en'],
});

const SCREEN_SPECS = Object.freeze({
  '1920x1080': { width: 1920, height: 1080, deviceScaleFactor: 1 },
  '2560x1440': { width: 2560, height: 1440, deviceScaleFactor: 1 },
  '1920x1200': { width: 1920, height: 1200, deviceScaleFactor: 1 },
  '1366x768': { width: 1366, height: 768, deviceScaleFactor: 1 },
});

const WEBGL_BY_PRESET = Object.freeze({
  'chrome-win': {
    vendor: 'Google Inc. (NVIDIA)',
    renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1080 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  },
  'chrome-mac': {
    vendor: 'Google Inc. (Apple)',
    renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)',
  },
  'chrome-linux': {
    vendor: 'Google Inc. (NVIDIA)',
    renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1080 OpenGL 4.5.0, OpenGL 4.5.0)',
  },
});

const FONTS_BY_PRESET = Object.freeze({
  'chrome-win': Object.freeze([
    'arial', 'calibri', 'cambria', 'comic sans ms', 'consolas', 'courier new',
    'georgia', 'impact', 'segoe ui', 'tahoma', 'times new roman', 'trebuchet ms',
    'verdana', 'microsoft yahei', 'simsun',
  ]),
  'chrome-mac': Object.freeze([
    'arial', 'courier new', 'georgia', 'helvetica', 'helvetica neue', 'menlo',
    'monaco', 'times', 'times new roman', 'verdana', 'pingfang sc', 'sf pro text',
  ]),
  'chrome-linux': Object.freeze([
    'arial', 'dejavu sans', 'dejavu sans mono', 'dejavu serif', 'liberation sans',
    'liberation serif', 'noto sans', 'ubuntu', 'courier new', 'times new roman',
  ]),
});

/**
 * @param {object} [raw]
 */
export function normalizeSpoofSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const spoofLocale = LOCALES.includes(src.spoofLocale) ? src.spoofLocale : 'auto';
  const spoofUaPreset = UA_PRESETS.includes(src.spoofUaPreset) ? src.spoofUaPreset : 'chrome-win';
  let hw = Number(src.spoofHwConcurrencyValue);
  if (!HW_VALUES.includes(hw)) hw = 8;
  const spoofScreenPreset = SCREEN_PRESETS.includes(src.spoofScreenPreset) ? src.spoofScreenPreset : '1920x1080';
  const spoofColorScheme = COLOR_SCHEMES.includes(src.spoofColorScheme) ? src.spoofColorScheme : 'off';
  return {
    spoofLanguage: src.spoofLanguage !== false,
    spoofLocale,
    spoofUa: src.spoofUa !== false,
    spoofUaPreset,
    spoofHwConcurrency: src.spoofHwConcurrency !== false,
    spoofHwConcurrencyValue: hw,
    stripGoogleAuthCookies: src.stripGoogleAuthCookies === true,
    spoofScreen: src.spoofScreen === true,
    spoofScreenPreset,
    spoofColorScheme,
    spoofRender: src.spoofRender !== false,
  };
}

export function localeFromCountry(country) {
  const cc = String(country || '').trim().toUpperCase();
  return COUNTRY_LOCALE[cc] || 'en-US';
}

export function languagesFor(locale) {
  return (LOCALE_LANGS[locale] || [locale || 'en-US', 'en']).slice();
}

export function acceptLanguageFor(locale) {
  const langs = languagesFor(locale);
  if (langs.length === 1) return langs[0];
  return langs
    .map((tag, i) => {
      if (i === 0) return tag;
      const q = Math.max(0.1, Math.round((1 - i * 0.1) * 10) / 10);
      return `${tag};q=${q}`;
    })
    .join(',');
}

export function parseChromeVersion(ua) {
  const m = String(ua || '').match(/Chrome\/(\d+(?:\.\d+){0,3})/);
  return m ? m[1] : '141.0.0.0';
}

export function parseChromeMajor(ua) {
  const major = Number(String(parseChromeVersion(ua)).split('.')[0]);
  return Number.isFinite(major) && major > 0 ? major : 141;
}

/** Chrome reports deviceMemory as 0.25, 0.5, 1, 2, 4 or 8. */
export function deviceMemoryFor(hw) {
  const n = Number(hw);
  if (n <= 2) return 2;
  if (n <= 4) return 4;
  return 8;
}

export function screenSpec(preset, uaPreset) {
  const base = SCREEN_SPECS[preset] || SCREEN_SPECS['1920x1080'];
  const chromeUi = uaPreset === 'chrome-mac' ? 25 : 40;
  return {
    width: base.width,
    height: base.height,
    deviceScaleFactor: base.deviceScaleFactor,
    availWidth: base.width,
    availHeight: Math.max(base.height - chromeUi, 1),
    colorDepth: 24,
    pixelDepth: 24,
  };
}

export function webglForUaPreset(preset) {
  return WEBGL_BY_PRESET[UA_PRESETS.includes(preset) ? preset : 'chrome-win'];
}

export function fontsForUaPreset(preset) {
  return (FONTS_BY_PRESET[UA_PRESETS.includes(preset) ? preset : 'chrome-win'] || []).slice();
}

export function seedFromToken(token) {
  let h = 2166136261;
  const s = String(token || '1');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Stable canvas/audio seed from Settings only. Not time, not Connect. */
export function fingerprintSeed(settings) {
  const s = normalizeSpoofSettings(settings);
  return seedFromToken(
    [
      s.spoofUa ? s.spoofUaPreset : 'ua-off',
      s.spoofHwConcurrency ? String(s.spoofHwConcurrencyValue) : 'hw-off',
      s.spoofScreen ? s.spoofScreenPreset : 'screen-off',
      `color=${s.spoofColorScheme}`,
      s.spoofLanguage ? s.spoofLocale : 'lang-off',
      s.spoofRender ? 'render-on' : 'render-off',
    ].join('|'),
  );
}

function greaseBrand() {
  return { brand: 'Not.A/Brand', version: '24' };
}

function fullBrandList(full) {
  return [
    { brand: 'Google Chrome', version: full },
    { brand: 'Chromium', version: full },
    { brand: 'Not.A/Brand', version: '24.0.0.0' },
  ];
}

function chromeVersionFrom(chromeUaOrMajor) {
  if (typeof chromeUaOrMajor === 'string' && /Chrome\//.test(chromeUaOrMajor)) {
    return parseChromeVersion(chromeUaOrMajor);
  }
  if (typeof chromeUaOrMajor === 'string' && /^\d+(\.\d+){0,3}$/.test(chromeUaOrMajor)) {
    return chromeUaOrMajor.includes('.') ? chromeUaOrMajor : `${chromeUaOrMajor}.0.0.0`;
  }
  const major = Number(chromeUaOrMajor);
  return Number.isFinite(major) && major > 0 ? `${major}.0.0.0` : '141.0.0.0';
}

function formatChUa(brands) {
  return brands.map((b) => `"${b.brand}";v="${b.version}"`).join(', ');
}

/**
 * @param {'chrome-win' | 'chrome-mac' | 'chrome-linux'} preset
 * @param {string|number} chromeUaOrMajor
 */
export function buildUaPreset(preset, chromeUaOrMajor) {
  const name = UA_PRESETS.includes(preset) ? preset : 'chrome-win';
  const version = chromeVersionFrom(chromeUaOrMajor);
  const major = Number(String(version).split('.')[0]) || 141;

  const specs = {
    'chrome-win': {
      userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`,
      platform: 'Win32',
      uaChPlatform: 'Windows',
      platformVersion: '15.0.0',
    },
    'chrome-mac': {
      userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`,
      platform: 'MacIntel',
      uaChPlatform: 'macOS',
      platformVersion: '14.0.0',
    },
    'chrome-linux': {
      userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`,
      platform: 'Linux x86_64',
      uaChPlatform: 'Linux',
      platformVersion: '6.5.0',
    },
  };
  const spec = specs[name];
  const brands = [
    { brand: 'Google Chrome', version: String(major) },
    { brand: 'Chromium', version: String(major) },
    greaseBrand(),
  ];
  const fullVersionList = fullBrandList(version);
  const userAgentMetadata = {
    brands,
    fullVersionList,
    platform: spec.uaChPlatform,
    platformVersion: spec.platformVersion,
    architecture: 'x86',
    model: '',
    mobile: false,
    bitness: '64',
    wow64: false,
  };
  const clientHints = {
    ua: formatChUa(brands),
    mobile: '?0',
    platform: `"${spec.uaChPlatform}"`,
    fullVersionList: formatChUa(fullVersionList),
    platformVersion: `"${spec.platformVersion}"`,
    arch: '"x86"',
    bitness: '"64"',
    model: '""',
  };
  const appVersion = spec.userAgent.startsWith('Mozilla/') ? spec.userAgent.slice('Mozilla/'.length) : spec.userAgent;
  return {
    userAgent: spec.userAgent,
    appVersion,
    platform: spec.platform,
    userAgentMetadata,
    userAgentData: {
      brands,
      mobile: false,
      platform: spec.uaChPlatform,
      highEntropy: {
        brands,
        mobile: false,
        platform: spec.uaChPlatform,
        platformVersion: spec.platformVersion,
        architecture: 'x86',
        bitness: '64',
        model: '',
        uaFullVersion: version,
        fullVersionList,
        wow64: false,
      },
    },
    clientHints,
  };
}

/**
 * @param {{ geo?: object, settings?: object, chromeUa?: string, chromeMajor?: number, token?: string }} args
 */
export function buildSpoofProfile(args = {}) {
  const settings = normalizeSpoofSettings(args.settings);
  const geo = normalizeGeoProfile(args.geo || FALLBACK_GEO_PROFILE);
  const locale = settings.spoofLocale === 'auto' ? localeFromCountry(geo.country) : settings.spoofLocale;
  const chromeUa = args.chromeUa || (args.chromeMajor != null ? String(args.chromeMajor) : '');
  const ua = buildUaPreset(settings.spoofUaPreset, chromeUa || args.chromeMajor || 141);
  const webgl = webglForUaPreset(settings.spoofUaPreset);
  const renderSeed = fingerprintSeed(settings);
  const token = String(
    args.token
      || seedFromToken(`${renderSeed}|${geo.latitude}|${geo.longitude}|${geo.timezoneId}|${locale}`),
  );
  return {
    ...geo,
    spoofLanguage: settings.spoofLanguage,
    locale,
    languages: languagesFor(locale),
    acceptLanguage: acceptLanguageFor(locale),
    spoofUa: settings.spoofUa,
    spoofUaPreset: settings.spoofUaPreset,
    userAgent: ua.userAgent,
    appVersion: ua.appVersion,
    platform: ua.platform,
    userAgentMetadata: ua.userAgentMetadata,
    userAgentData: ua.userAgentData,
    clientHints: ua.clientHints,
    spoofHwConcurrency: settings.spoofHwConcurrency,
    hardwareConcurrency: settings.spoofHwConcurrencyValue,
    deviceMemory: deviceMemoryFor(settings.spoofHwConcurrencyValue),
    maxTouchPoints: 0,
    vendor: 'Google Inc.',
    product: 'Gecko',
    pdfViewerEnabled: true,
    stripGoogleAuthCookies: settings.stripGoogleAuthCookies,
    spoofScreen: settings.spoofScreen,
    spoofScreenPreset: settings.spoofScreenPreset,
    screen: settings.spoofScreen ? screenSpec(settings.spoofScreenPreset, settings.spoofUaPreset) : null,
    spoofColorScheme: settings.spoofColorScheme,
    spoofRender: settings.spoofRender,
    webgl,
    fonts: fontsForUaPreset(settings.spoofUaPreset),
    renderSeed,
    token,
  };
}

function setHeader(headers, name, value) {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) delete headers[key];
  }
  headers[name] = value;
}

/**
 * Mutates the proxied request header map to match the spoof profile.
 * @param {Record<string, string>} headers
 * @param {object | null} profile
 * @returns {Record<string, string>}
 */
export function applyHeaderSpoof(headers, profile) {
  if (!headers || !profile) return headers;
  if (profile.spoofLanguage && profile.acceptLanguage) {
    setHeader(headers, 'Accept-Language', profile.acceptLanguage);
  }
  if (profile.spoofUa && profile.userAgent) {
    setHeader(headers, 'User-Agent', profile.userAgent);
    const ch = profile.clientHints;
    if (ch) {
      setHeader(headers, 'Sec-CH-UA', ch.ua);
      setHeader(headers, 'Sec-CH-UA-Mobile', ch.mobile);
      setHeader(headers, 'Sec-CH-UA-Platform', ch.platform);
      if (ch.fullVersionList) setHeader(headers, 'Sec-CH-UA-Full-Version-List', ch.fullVersionList);
      if (ch.platformVersion) setHeader(headers, 'Sec-CH-UA-Platform-Version', ch.platformVersion);
      if (ch.arch) setHeader(headers, 'Sec-CH-UA-Arch', ch.arch);
      if (ch.bitness) setHeader(headers, 'Sec-CH-UA-Bitness', ch.bitness);
      if (ch.model != null) setHeader(headers, 'Sec-CH-UA-Model', ch.model);
    }
  }
  return headers;
}

export function spoofLogLine(profile) {
  if (!profile) return 'spoof.profile none';
  const screen = profile.spoofScreen && profile.screen
    ? `${profile.screen.width}x${profile.screen.height}`
    : 'off';
  return `spoof.profile country=${profile.country} tz=${profile.timezoneId} locale=${profile.spoofLanguage ? profile.locale : 'off'} ua=${profile.spoofUa ? profile.spoofUaPreset : 'off'} hw=${profile.spoofHwConcurrency ? profile.hardwareConcurrency : 'off'} cookie=${profile.stripGoogleAuthCookies ? 'on' : 'off'} screen=${screen} color=${profile.spoofColorScheme || 'off'} render=${profile.spoofRender ? 'on' : 'off'} seed=${profile.renderSeed ?? 0}`;
}

/**
 * Tab-only inject. Does not touch offscreen Goolom.
 * Values are JSON-encoded so user strings cannot break out of the IIFE.
 * @param {object} profile
 */
export function fingerprintSpoofSource(profile) {
  const p = {
    token: String(profile?.token || '1'),
    latitude: Number.isFinite(profile?.latitude) ? profile.latitude : FALLBACK_GEO_PROFILE.latitude,
    longitude: Number.isFinite(profile?.longitude) ? profile.longitude : FALLBACK_GEO_PROFILE.longitude,
    accuracy: Number(profile?.accuracy) || FALLBACK_GEO_PROFILE.accuracy,
    language: profile?.spoofLanguage
      ? { language: String(profile.locale || 'en-US'), languages: languagesFor(profile.locale || 'en-US') }
      : null,
    ua: profile?.spoofUa
      ? {
          userAgent: String(profile.userAgent || ''),
          appVersion: String(profile.appVersion || ''),
          platform: String(profile.platform || 'Win32'),
          brands: profile.userAgentData?.brands || [],
          mobile: false,
          uaPlatform: String(profile.userAgentData?.platform || 'Windows'),
          highEntropy: profile.userAgentData?.highEntropy || {},
          vendor: 'Google Inc.',
          product: 'Gecko',
          pdfViewerEnabled: true,
          maxTouchPoints: 0,
        }
      : null,
    hw: profile?.spoofHwConcurrency ? Number(profile.hardwareConcurrency) : null,
    deviceMemory: profile?.spoofHwConcurrency ? deviceMemoryFor(profile.hardwareConcurrency) : null,
    screen: profile?.spoofScreen && profile.screen
      ? {
          width: profile.screen.width,
          height: profile.screen.height,
          availWidth: profile.screen.availWidth,
          availHeight: profile.screen.availHeight,
          deviceScaleFactor: profile.screen.deviceScaleFactor,
          colorDepth: profile.screen.colorDepth,
          pixelDepth: profile.screen.pixelDepth,
        }
      : null,
    colorScheme: profile?.spoofColorScheme && profile.spoofColorScheme !== 'off' ? profile.spoofColorScheme : null,
    render: profile?.spoofRender
      ? {
          seed: Number(profile.renderSeed) || fingerprintSeed(profile),
          vendor: String(profile.webgl?.vendor || webglForUaPreset(profile.spoofUaPreset).vendor),
          renderer: String(profile.webgl?.renderer || webglForUaPreset(profile.spoofUaPreset).renderer),
          fonts: fontsForUaPreset(profile.spoofUaPreset),
        }
      : null,
  };
  return `(function () {
  var P = ${JSON.stringify(p)};
  if (globalThis.__olcSpoofToken === P.token) return;
  globalThis.__olcSpoofToken = P.token;
  function def(obj, key, getter) {
    try {
      Object.defineProperty(obj, key, { configurable: true, enumerable: true, get: getter });
    } catch (e) {}
  }
  function und(obj, key) {
    try { delete obj[key]; } catch (e) {}
  }
  function nativeToString(name) {
    return 'function ' + (name || '') + '() { [native code] }';
  }
  try {
    var coords = {
      latitude: P.latitude,
      longitude: P.longitude,
      accuracy: P.accuracy,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      speed: null
    };
    var geo = {
      getCurrentPosition: function (success) {
        if (typeof success === 'function') {
          queueMicrotask(function () { success({ coords: coords, timestamp: Date.now() }); });
        }
      },
      watchPosition: function (success) {
        if (typeof success === 'function') {
          queueMicrotask(function () { success({ coords: coords, timestamp: Date.now() }); });
        }
        return 1;
      },
      clearWatch: function () {}
    };
    def(navigator, 'geolocation', function () { return geo; });
  } catch (e) {}
  try {
    if (navigator.permissions && typeof navigator.permissions.query === 'function') {
      if (!globalThis.__olcPermQuery) {
        globalThis.__olcPermQuery = navigator.permissions.query.bind(navigator.permissions);
      }
      navigator.permissions.query = function (desc) {
        if (desc && desc.name === 'geolocation') {
          return Promise.resolve({ state: 'granted', onchange: null });
        }
        return globalThis.__olcPermQuery(desc);
      };
    }
  } catch (e) {}
  try {
    if (P.language) {
      def(navigator, 'language', function () { return P.language.language; });
      def(navigator, 'languages', function () { return P.language.languages.slice(); });
    } else {
      und(navigator, 'language');
      und(navigator, 'languages');
    }
  } catch (e) {}
  try {
    if (P.ua && P.ua.userAgent) {
      def(navigator, 'userAgent', function () { return P.ua.userAgent; });
      def(navigator, 'appVersion', function () { return P.ua.appVersion; });
      def(navigator, 'platform', function () { return P.ua.platform; });
      def(navigator, 'vendor', function () { return P.ua.vendor; });
      def(navigator, 'product', function () { return P.ua.product; });
      def(navigator, 'pdfViewerEnabled', function () { return P.ua.pdfViewerEnabled; });
      def(navigator, 'maxTouchPoints', function () { return P.ua.maxTouchPoints; });
      var uaData = {
        brands: P.ua.brands,
        mobile: P.ua.mobile,
        platform: P.ua.uaPlatform,
        getHighEntropyValues: function (hints) {
          var src = P.ua.highEntropy || {};
          var out = { brands: P.ua.brands, mobile: P.ua.mobile, platform: P.ua.uaPlatform };
          if (Array.isArray(hints)) {
            for (var i = 0; i < hints.length; i++) {
              var h = hints[i];
              if (Object.prototype.hasOwnProperty.call(src, h)) out[h] = src[h];
            }
          }
          return Promise.resolve(out);
        },
        toJSON: function () {
          return { brands: P.ua.brands, mobile: P.ua.mobile, platform: P.ua.uaPlatform };
        }
      };
      def(navigator, 'userAgentData', function () { return uaData; });
    } else {
      und(navigator, 'userAgent');
      und(navigator, 'appVersion');
      und(navigator, 'platform');
      und(navigator, 'userAgentData');
      und(navigator, 'vendor');
      und(navigator, 'product');
      und(navigator, 'pdfViewerEnabled');
      und(navigator, 'maxTouchPoints');
    }
  } catch (e) {}
  try {
    if (P.hw != null && isFinite(P.hw)) {
      def(navigator, 'hardwareConcurrency', function () { return P.hw; });
    } else {
      und(navigator, 'hardwareConcurrency');
    }
    if (P.deviceMemory != null && isFinite(P.deviceMemory)) {
      def(navigator, 'deviceMemory', function () { return P.deviceMemory; });
    } else {
      und(navigator, 'deviceMemory');
    }
  } catch (e) {}
  try {
    if (P.screen && typeof screen !== 'undefined') {
      def(screen, 'width', function () { return P.screen.width; });
      def(screen, 'height', function () { return P.screen.height; });
      def(screen, 'availWidth', function () { return P.screen.availWidth; });
      def(screen, 'availHeight', function () { return P.screen.availHeight; });
      def(screen, 'colorDepth', function () { return P.screen.colorDepth; });
      def(screen, 'pixelDepth', function () { return P.screen.pixelDepth; });
      def(globalThis, 'devicePixelRatio', function () { return P.screen.deviceScaleFactor; });
    } else if (typeof screen !== 'undefined') {
      und(screen, 'width');
      und(screen, 'height');
      und(screen, 'availWidth');
      und(screen, 'availHeight');
      und(screen, 'colorDepth');
      und(screen, 'pixelDepth');
      und(globalThis, 'devicePixelRatio');
    }
  } catch (e) {}
  try {
    if (typeof matchMedia === 'function') {
      if (!globalThis.__olcMatchMedia) globalThis.__olcMatchMedia = matchMedia.bind(globalThis);
      if (P.colorScheme) {
        globalThis.matchMedia = function (query) {
          var q = String(query || '');
          if (/prefers-color-scheme/i.test(q)) {
            var wantDark = P.colorScheme === 'dark';
            var matches = /dark/i.test(q) ? wantDark : /light/i.test(q) ? !wantDark : wantDark;
            return {
              matches: matches,
              media: q,
              onchange: null,
              addListener: function () {},
              removeListener: function () {},
              addEventListener: function () {},
              removeEventListener: function () {},
              dispatchEvent: function () { return false; }
            };
          }
          return globalThis.__olcMatchMedia(query);
        };
      } else {
        globalThis.matchMedia = globalThis.__olcMatchMedia;
      }
    }
  } catch (e) {}
  try {
    if (!globalThis.__olcNatives) globalThis.__olcNatives = {};
    var N = globalThis.__olcNatives;
    var spoofedFns = globalThis.__olcSpoofedFns || (globalThis.__olcSpoofedFns = typeof WeakSet === 'function' ? new WeakSet() : null);
    function remember(key, obj, prop) {
      if (!obj || N[key]) return;
      N[key] = obj[prop];
    }
    function restore(key, obj, prop) {
      if (!obj || !N[key]) return;
      try { obj[prop] = N[key]; } catch (e) {}
    }
    function mark(fn, name) {
      if (!fn) return fn;
      try { if (spoofedFns) spoofedFns.add(fn); } catch (e) {}
      try { Object.defineProperty(fn, 'name', { value: name, configurable: true }); } catch (e) {}
      return fn;
    }
    if (!N.toStringHooked && typeof Function !== 'undefined' && Function.prototype) {
      N.fnToString = Function.prototype.toString;
      Function.prototype.toString = function () {
        try {
          if (spoofedFns && spoofedFns.has(this)) return nativeToString(this.name);
        } catch (e) {}
        return N.fnToString.call(this);
      };
      mark(Function.prototype.toString, 'toString');
      N.toStringHooked = true;
    }
    if (!P.render) {
      restore('toDataURL', globalThis.HTMLCanvasElement && HTMLCanvasElement.prototype, 'toDataURL');
      restore('toBlob', globalThis.HTMLCanvasElement && HTMLCanvasElement.prototype, 'toBlob');
      restore('getImageData', globalThis.CanvasRenderingContext2D && CanvasRenderingContext2D.prototype, 'getImageData');
      restore('offscreenConvert', globalThis.OffscreenCanvas && OffscreenCanvas.prototype, 'convertToBlob');
      restore('glGetParameter', globalThis.WebGLRenderingContext && WebGLRenderingContext.prototype, 'getParameter');
      restore('gl2GetParameter', globalThis.WebGL2RenderingContext && WebGL2RenderingContext.prototype, 'getParameter');
      restore('startRendering', (globalThis.OfflineAudioContext && OfflineAudioContext.prototype) || (globalThis.webkitOfflineAudioContext && webkitOfflineAudioContext.prototype), 'startRendering');
      restore('fontsCheck', globalThis.document && document.fonts, 'check');
    } else {
      function mulberry(a) {
        return function () {
          a |= 0; a = a + 0x6D2B79F5 | 0;
          var t = Math.imul(a ^ a >>> 15, 1 | a);
          t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
          return ((t ^ t >>> 14) >>> 0) / 4294967296;
        };
      }
      function mixSeed(extra) {
        return (P.render.seed ^ (extra >>> 0)) >>> 0;
      }
      function noiseBytes(data, extra) {
        var rng = mulberry(mixSeed(extra || data.length));
        var n = Math.min(8, Math.floor(data.length / 4));
        for (var i = 0; i < n; i++) {
          var idx = (Math.floor(rng() * (data.length / 4)) * 4) | 0;
          data[idx] = data[idx] ^ 1;
        }
      }
      function withNoisy2d(canvas, fn) {
        var ctx = null;
        try { ctx = canvas.getContext('2d'); } catch (e) {}
        if (!ctx || !ctx.getImageData || !canvas.width || !canvas.height) return fn();
        var img;
        try { img = ctx.getImageData(0, 0, canvas.width, canvas.height); } catch (e) { return fn(); }
        var copy = new Uint8ClampedArray(img.data);
        noiseBytes(img.data, canvas.width * 31 + canvas.height);
        ctx.putImageData(img, 0, 0);
        try { return fn(); }
        finally {
          img.data.set(copy);
          try { ctx.putImageData(img, 0, 0); } catch (e2) {}
        }
      }
      if (globalThis.HTMLCanvasElement && HTMLCanvasElement.prototype) {
        remember('toDataURL', HTMLCanvasElement.prototype, 'toDataURL');
        remember('toBlob', HTMLCanvasElement.prototype, 'toBlob');
        var origToDataURL = N.toDataURL;
        var origToBlob = N.toBlob;
        if (origToDataURL) {
          HTMLCanvasElement.prototype.toDataURL = mark(function toDataURL() {
            var args = arguments;
            var self = this;
            return withNoisy2d(self, function () { return origToDataURL.apply(self, args); });
          }, 'toDataURL');
        }
        if (origToBlob) {
          HTMLCanvasElement.prototype.toBlob = mark(function toBlob() {
            var args = arguments;
            var self = this;
            return withNoisy2d(self, function () { return origToBlob.apply(self, args); });
          }, 'toBlob');
        }
      }
      if (globalThis.CanvasRenderingContext2D && CanvasRenderingContext2D.prototype) {
        remember('getImageData', CanvasRenderingContext2D.prototype, 'getImageData');
        var origGetImageData = N.getImageData;
        if (origGetImageData) {
          CanvasRenderingContext2D.prototype.getImageData = mark(function getImageData() {
            var img = origGetImageData.apply(this, arguments);
            try { noiseBytes(img.data, img.width * 17 + img.height); } catch (e) {}
            return img;
          }, 'getImageData');
        }
      }
      if (globalThis.OffscreenCanvas && OffscreenCanvas.prototype && OffscreenCanvas.prototype.convertToBlob) {
        remember('offscreenConvert', OffscreenCanvas.prototype, 'convertToBlob');
        var origConvert = N.offscreenConvert;
        OffscreenCanvas.prototype.convertToBlob = mark(function convertToBlob() {
          var args = arguments;
          var self = this;
          return withNoisy2d(self, function () { return origConvert.apply(self, args); });
        }, 'convertToBlob');
      }
      var VENDOR = 0x9245;
      var RENDERER = 0x9246;
      function wrapGL(proto, key) {
        if (!proto || !proto.getParameter) return;
        remember(key, proto, 'getParameter');
        var orig = N[key];
        proto.getParameter = mark(function getParameter(pname) {
          if (pname === VENDOR) return P.render.vendor;
          if (pname === RENDERER) return P.render.renderer;
          return orig.apply(this, arguments);
        }, 'getParameter');
      }
      wrapGL(globalThis.WebGLRenderingContext && WebGLRenderingContext.prototype, 'glGetParameter');
      wrapGL(globalThis.WebGL2RenderingContext && WebGL2RenderingContext.prototype, 'gl2GetParameter');
      var Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
      if (Offline && Offline.prototype && Offline.prototype.startRendering) {
        remember('startRendering', Offline.prototype, 'startRendering');
        var origStart = N.startRendering;
        Offline.prototype.startRendering = mark(function startRendering() {
          var result = origStart.apply(this, arguments);
          if (!result || typeof result.then !== 'function') return result;
          return result.then(function (buf) {
            try {
              var ch = buf.getChannelData(0);
              var rng = mulberry(P.render.seed);
              var n = Math.min(8, ch.length);
              for (var i = 0; i < n; i++) {
                var idx = ((i * 97) + (P.render.seed % 97)) % ch.length;
                ch[idx] = ch[idx] + (rng() - 0.5) * 1e-7;
              }
            } catch (e) {}
            return buf;
          });
        }, 'startRendering');
      }
      if (globalThis.document && document.fonts && typeof document.fonts.check === 'function') {
        remember('fontsCheck', document.fonts, 'check');
        var origCheck = N.fontsCheck.bind(document.fonts);
        var allowed = {};
        for (var fi = 0; fi < P.render.fonts.length; fi++) allowed[P.render.fonts[fi]] = true;
        document.fonts.check = mark(function check(font, text) {
          var fam = String(font || '').replace(/^[^'"]*['"]?/, '').replace(/['"].*$/, '').trim().toLowerCase();
          if (fam && !allowed[fam]) return false;
          return origCheck(font, text);
        }, 'check');
      }
      if (navigator.gpu && typeof navigator.gpu.requestAdapter === 'function') {
        if (!N.gpuRequest) N.gpuRequest = navigator.gpu.requestAdapter.bind(navigator.gpu);
        navigator.gpu.requestAdapter = mark(function requestAdapter() {
          return N.gpuRequest.apply(navigator.gpu, arguments).then(function (adapter) {
            if (!adapter) return adapter;
            try {
              def(adapter, 'info', function () {
                return {
                  vendor: P.render.vendor,
                  architecture: '',
                  device: P.render.renderer,
                  description: P.render.renderer
                };
              });
            } catch (e) {}
            return adapter;
          });
        }, 'requestAdapter');
      }
    }
  } catch (e) {}
})();`;
}
