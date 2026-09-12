import { normalizeGeoProfile } from './geo-spoof.js';

export const EXIT_GEO_URLS = Object.freeze(['https://ifconfig.co/json', 'https://ipinfo.io/json']);

function coordinate(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return NaN;
  if (typeof value === 'string' && !value.trim()) return NaN;
  return Number(value);
}

/**
 * Parse a geo-IP JSON body (ifconfig.co or ipinfo.io).
 * @param {string} text
 * @returns {ReturnType<typeof normalizeGeoProfile> | null}
 */
export function parseExitGeoBody(text) {
  if (!text || typeof text !== 'string') return null;
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (!json || typeof json !== 'object') return null;

  const ip = typeof json.ip === 'string' ? json.ip.trim() : '';
  const countryRaw = json.country_iso || json.countryCode || json.country || '';
  const country = typeof countryRaw === 'string' ? countryRaw.trim().toUpperCase() : '';
  if (!ip || !/^[A-Z]{2}$/.test(country)) return null;

  let latitude = coordinate(json.latitude ?? json.lat);
  let longitude = coordinate(json.longitude ?? json.lon ?? json.lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    const loc = typeof json.loc === 'string' ? json.loc.split(',') : [];
    latitude = coordinate(loc[0]);
    longitude = coordinate(loc[1]);
  }
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;

  let timezoneId = '';
  if (typeof json.timezone === 'string') timezoneId = json.timezone;
  else if (typeof json.time_zone === 'string') timezoneId = json.time_zone;
  else if (json.time_zone && typeof json.time_zone === 'object') {
    timezoneId = String(json.time_zone.name || json.time_zone.id || '');
  }
  // A partial provider response must not become a fabricated US/New York exit.
  if (!timezoneId) return null;
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezoneId }); } catch { return null; }

  return normalizeGeoProfile({
    latitude,
    longitude,
    accuracy: 50_000,
    timezoneId,
    country,
    ip,
  });
}

function b64ToUtf8(b64) {
  if (!b64) return '';
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(b64, 'base64').toString('utf8');
  }
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(u8);
}

export function proxyResToText(res) {
  if (!res) return '';
  if (typeof res.body === 'string' && res.body) return res.body;
  if (res.body instanceof Uint8Array) return new TextDecoder().decode(res.body);
  if (typeof res.bodyB64 === 'string' && res.bodyB64) return b64ToUtf8(res.bodyB64);
  return '';
}

/**
 * Resolve exit-node geo via the tunnel HTTP proxy.
 * @param {(req: object) => Promise<object>} proxyFn
 * @param {{ timeoutMs?: number, urls?: string[], onAttempt?: (attempt: object) => void }} [opts]
 * @returns {Promise<ReturnType<typeof parseExitGeoBody>>}
 */
export async function resolveExitGeo(proxyFn, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 5_000;
  const urls = Array.isArray(opts.urls) && opts.urls.length ? opts.urls : EXIT_GEO_URLS;
  if (typeof proxyFn !== 'function') return null;

  for (const url of urls) {
    let timer;
    const start = Date.now();
    let outcome = 'invalid-response';
    let status = 0;
    try {
      const res = await Promise.race([
        proxyFn({ method: 'GET', url, headers: { Accept: 'application/json' } }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('exit geo timeout')), timeoutMs);
        }),
      ]);
      if (!res || res.ok === false) { outcome = 'proxy-error'; continue; }
      status = Number(res.status) || 0;
      if (status < 200 || status >= 300) { outcome = 'http-error'; continue; }
      const parsed = parseExitGeoBody(proxyResToText(res));
      if (parsed) { outcome = 'resolved'; return parsed; }
    } catch (error) {
      outcome = error?.message === 'exit geo timeout' ? 'timeout' : 'proxy-error';
    } finally {
      clearTimeout(timer);
      // Diagnostics contain no response bodies, request headers or credentials.
      try { opts.onAttempt?.({ url, outcome, status, elapsedMs: Date.now() - start }); } catch {}
    }
  }
  return null;
}
