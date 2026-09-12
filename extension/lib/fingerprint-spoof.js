import { FALLBACK_GEO_PROFILE, normalizeGeoProfile } from './geo-spoof.js';

export const LOCALES = Object.freeze(['auto', 'en-US', 'en-GB', 'ru-RU', 'nl-NL']);
export const UA_PRESETS = Object.freeze(['chrome-win', 'chrome-mac', 'chrome-linux']);
export const HW_VALUES = Object.freeze([2, 4, 8, 12, 16]);

export const DEFAULT_SPOOF_SETTINGS = Object.freeze({
  spoofLanguage: true,
  spoofLocale: 'auto',
  spoofUa: true,
  spoofUaPreset: 'chrome-win',
  spoofHwConcurrency: true,
  spoofHwConcurrencyValue: 8,
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

/**
 * @param {object} [raw]
 */
export function normalizeSpoofSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const spoofLocale = LOCALES.includes(src.spoofLocale) ? src.spoofLocale : 'auto';
  const spoofUaPreset = UA_PRESETS.includes(src.spoofUaPreset) ? src.spoofUaPreset : 'chrome-win';
  let hw = Number(src.spoofHwConcurrencyValue);
  if (!HW_VALUES.includes(hw)) hw = 8;
  return {
    spoofLanguage: src.spoofLanguage !== false,
    spoofLocale,
    spoofUa: src.spoofUa !== false,
    spoofUaPreset,
    spoofHwConcurrency: src.spoofHwConcurrency !== false,
    spoofHwConcurrencyValue: hw,
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
    token: String(args.token || `${Date.now().toString(36)}`),
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
  return `spoof.profile country=${profile.country} tz=${profile.timezoneId} locale=${profile.spoofLanguage ? profile.locale : 'off'} ua=${profile.spoofUa ? profile.spoofUaPreset : 'off'} hw=${profile.spoofHwConcurrency ? profile.hardwareConcurrency : 'off'}`;
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
        }
      : null,
    hw: profile?.spoofHwConcurrency ? Number(profile.hardwareConcurrency) : null,
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
    }
  } catch (e) {}
  try {
    if (P.hw != null && isFinite(P.hw)) {
      def(navigator, 'hardwareConcurrency', function () { return P.hw; });
    } else {
      und(navigator, 'hardwareConcurrency');
    }
  } catch (e) {}
})();`;
}
