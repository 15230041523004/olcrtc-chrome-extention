import test from 'node:test';
import assert from 'node:assert/strict';
import { FALLBACK_GEO_PROFILE, normalizeGeoProfile } from '../extension/lib/geo-spoof.js';
import { parseExitGeoBody, proxyResToText, resolveExitGeo } from '../extension/lib/geo-profile.js';

test('normalizeGeoProfile uses US fallback for garbage and clamps ranges', () => {
  const fb = normalizeGeoProfile(null);
  assert.equal(fb.latitude, FALLBACK_GEO_PROFILE.latitude);
  assert.equal(fb.longitude, FALLBACK_GEO_PROFILE.longitude);
  assert.equal(fb.timezoneId, 'America/New_York');
  assert.equal(fb.country, 'US');
  assert.equal(fb.accuracy, 50_000);

  const clamped = normalizeGeoProfile({
    latitude: 200,
    longitude: -400,
    accuracy: 5,
    timezoneId: 'not a zone',
    country: 'usa',
    ip: '1.2.3.4',
  });
  assert.equal(clamped.latitude, 90);
  assert.equal(clamped.longitude, -180);
  assert.equal(clamped.accuracy, 1_000);
  assert.equal(clamped.timezoneId, 'America/New_York');
  assert.equal(clamped.country, 'US');
  assert.equal(clamped.ip, '1.2.3.4');
});

test('normalizeGeoProfile keeps valid IANA timezone and ISO country', () => {
  const p = normalizeGeoProfile({
    latitude: 37.77,
    longitude: -122.41,
    accuracy: 25_000,
    timezoneId: 'America/Los_Angeles',
    country: 'us',
    ip: '8.8.8.8',
  });
  assert.equal(p.timezoneId, 'America/Los_Angeles');
  assert.equal(p.country, 'US');
  assert.equal(p.accuracy, 25_000);
});

test('parseExitGeoBody reads ipinfo loc + timezone', () => {
  const p = parseExitGeoBody(
    JSON.stringify({
      ip: '203.0.113.10',
      city: 'Newark',
      country: 'US',
      loc: '40.7357,-74.1724',
      timezone: 'America/New_York',
    }),
  );
  assert.ok(p);
  assert.equal(p.ip, '203.0.113.10');
  assert.equal(p.country, 'US');
  assert.equal(p.timezoneId, 'America/New_York');
  assert.ok(Math.abs(p.latitude - 40.7357) < 0.001);
  assert.ok(Math.abs(p.longitude - -74.1724) < 0.001);
});

test('parseExitGeoBody reads ifconfig.co latitude/longitude/time_zone', () => {
  const p = parseExitGeoBody(
    JSON.stringify({
      ip: '198.51.100.20',
      country_iso: 'GB',
      latitude: 51.5074,
      longitude: -0.1278,
      time_zone: 'Europe/London',
    }),
  );
  assert.ok(p);
  assert.equal(p.country, 'GB');
  assert.equal(p.timezoneId, 'Europe/London');
  assert.ok(Math.abs(p.latitude - 51.5074) < 0.001);
});

test('parseExitGeoBody accepts time_zone object and rejects non-JSON', () => {
  const p = parseExitGeoBody(
    JSON.stringify({
      ip: '192.0.2.1',
      country: 'DE',
      latitude: 52.52,
      longitude: 13.405,
      time_zone: { name: 'Europe/Berlin' },
    }),
  );
  assert.equal(p.timezoneId, 'Europe/Berlin');
  assert.equal(parseExitGeoBody('not-json'), null);
  assert.equal(parseExitGeoBody('{"ip":"1.2.3.4"}'), null);
});

test('exit lookup rejects incomplete or invalid data instead of inventing a US exit', () => {
  const valid = { ip: '192.0.2.1', country: 'GB', latitude: 51.5, longitude: 0, timezone: 'Europe/London' };
  for (const change of [
    { ip: '' }, { country: '' }, { country: 'United Kingdom' },
    { timezone: '' }, { timezone: 'Invalid/Zone' },
    { latitude: null }, { longitude: '' }, { latitude: 91 },
  ]) {
    assert.equal(parseExitGeoBody(JSON.stringify({ ...valid, ...change })), null);
  }
  assert.equal(parseExitGeoBody(JSON.stringify(valid)).longitude, 0);
});

test('exit lookup exposes bounded diagnostic outcomes and tries the next provider', async () => {
  const attempts = [];
  const result = await resolveExitGeo(async ({ url }) => {
    if (url.endsWith('/blocked')) return { ok: true, status: 403, body: 'denied' };
    return { ok: true, status: 200, body: JSON.stringify({ ip: '192.0.2.1', country: 'US', loc: '40.7,-74.0', timezone: 'America/New_York' }) };
  }, { urls: ['https://example.test/blocked', 'https://example.test/ok'], onAttempt: (attempt) => attempts.push(attempt) });
  assert.equal(result.country, 'US');
  assert.deepEqual(attempts.map(({ outcome, status }) => ({ outcome, status })), [
    { outcome: 'http-error', status: 403 }, { outcome: 'resolved', status: 200 },
  ]);
  assert.ok(attempts.every((attempt) => !('body' in attempt)));
});

test('proxyResToText decodes bodyB64 and body bytes', () => {
  const text = '{"ok":true}';
  assert.equal(proxyResToText({ body: text }), text);
  assert.equal(proxyResToText({ body: new TextEncoder().encode(text) }), text);
  assert.equal(proxyResToText({ bodyB64: Buffer.from(text, 'utf8').toString('base64') }), text);
  assert.equal(proxyResToText(null), '');
});

test('resolveExitGeo tries urls and returns first parseable body', async () => {
  const calls = [];
  const geo = await resolveExitGeo(async (req) => {
    calls.push(req.url);
    if (req.url.includes('ifconfig')) return { ok: false, error: 'fail' };
    return {
      ok: true,
      status: 200,
      body: JSON.stringify({
        ip: '203.0.113.9',
        country: 'US',
        loc: '40.7,-74.0',
        timezone: 'America/New_York',
      }),
    };
  });
  assert.equal(calls.length, 2);
  assert.equal(geo.country, 'US');
  assert.equal(geo.ip, '203.0.113.9');
});

test('resolveExitGeo returns null on timeout and bad payloads', async () => {
  const none = await resolveExitGeo(async () => ({ ok: true, status: 200, body: 'nope' }), {
    timeoutMs: 50,
    urls: ['https://example.test/json'],
  });
  assert.equal(none, null);

  const timed = await resolveExitGeo(() => new Promise(() => {}), {
    timeoutMs: 20,
    urls: ['https://example.test/json'],
  });
  assert.equal(timed, null);
});
