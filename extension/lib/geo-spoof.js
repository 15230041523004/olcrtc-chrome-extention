/** Tab-only geolocation profile. Never inject into offscreen Goolom. */

export const FALLBACK_GEO_PROFILE = Object.freeze({
  latitude: 40.7128,
  longitude: -74.006,
  accuracy: 50_000,
  timezoneId: 'America/New_York',
  country: 'US',
  ip: '',
});

const TZ_RE = /^(UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+)$/;

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * @param {object} [raw]
 * @returns {{ latitude: number, longitude: number, accuracy: number, timezoneId: string, country: string, ip: string }}
 */
export function normalizeGeoProfile(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  let latitude = Number(src.latitude);
  let longitude = Number(src.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    latitude = FALLBACK_GEO_PROFILE.latitude;
    longitude = FALLBACK_GEO_PROFILE.longitude;
  }
  latitude = clamp(latitude, -90, 90);
  longitude = clamp(longitude, -180, 180);

  let accuracy = Number(src.accuracy);
  if (!Number.isFinite(accuracy) || accuracy <= 0) accuracy = FALLBACK_GEO_PROFILE.accuracy;
  accuracy = clamp(accuracy, 1_000, 200_000);

  let timezoneId = typeof src.timezoneId === 'string' ? src.timezoneId.trim() : '';
  if (!TZ_RE.test(timezoneId)) timezoneId = FALLBACK_GEO_PROFILE.timezoneId;

  let country = typeof src.country === 'string' ? src.country.trim().toUpperCase() : '';
  if (!/^[A-Z]{2}$/.test(country)) country = FALLBACK_GEO_PROFILE.country;

  const ip = typeof src.ip === 'string' ? src.ip.trim() : '';

  return { latitude, longitude, accuracy, timezoneId, country, ip };
}
