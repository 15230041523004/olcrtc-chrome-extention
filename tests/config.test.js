import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { DEFAULT_CONFIG, CONFIG, DEFAULT_MAX_BODY_BYTES, getMaxBodyBytes, setMaxBodyBytes } from '../extension/lib/config.js';
import { readHttpResponse, decodeChunked, prepareFulfill } from '../extension/lib/http-client.js';
import { ConnPool, POOL_MAX_BODY, canPoolResponse, canWarmHost } from '../extension/lib/pool.js';
import { clearCookieCache, isTelemetryUrl } from '../extension/lib/intercept.js';

test('config maxBodyBytes defaults to 32 MiB and can be updated', () => {
  assert.equal(DEFAULT_MAX_BODY_BYTES, 32 * 1024 * 1024);
  assert.equal(getMaxBodyBytes(), 32 * 1024 * 1024);

  setMaxBodyBytes(64 * 1024 * 1024);
  assert.equal(getMaxBodyBytes(), 64 * 1024 * 1024);

  // Invalid values should be ignored
  setMaxBodyBytes(-100);
  assert.equal(getMaxBodyBytes(), 64 * 1024 * 1024);

  setMaxBodyBytes('not-a-number');
  assert.equal(getMaxBodyBytes(), 64 * 1024 * 1024);

  // Reset back to default for other tests
  setMaxBodyBytes(DEFAULT_MAX_BODY_BYTES);
  assert.equal(getMaxBodyBytes(), 32 * 1024 * 1024);
});

test('config has increased concurrency and pool defaults', () => {
  assert.equal(DEFAULT_CONFIG.poolMaxTotal, 240);
  assert.equal(DEFAULT_CONFIG.poolMaxPerHost, 32);
  assert.equal(DEFAULT_CONFIG.poolIdleMs, 180_000);
  assert.equal(DEFAULT_CONFIG.imageGateConcurrency, 6);
  assert.equal(DEFAULT_CONFIG.hostGateConcurrency, 6);
  assert.equal(DEFAULT_CONFIG.subSemConcurrency, 64);
  assert.equal(DEFAULT_CONFIG.mediaSemConcurrency, 16);
  assert.equal(DEFAULT_CONFIG.maxDataPackets, 128);
  assert.equal(DEFAULT_CONFIG.fastTelemetry, true);
  assert.equal(DEFAULT_CONFIG.fastCorsOptions, true);
  assert.equal(DEFAULT_CONFIG.coalesceEnabled, true);
  assert.equal(DEFAULT_CONFIG.cacheEnabled, true);
  assert.equal(DEFAULT_CONFIG.cacheMaxBytes, 512 * 1024 * 1024);
  assert.equal(DEFAULT_CONFIG.cacheMaxItemBytes, 4 * 1024 * 1024);
  assert.equal(DEFAULT_CONFIG.cacheTtlMs, 30_000);
  assert.equal(DEFAULT_CONFIG.cacheStaticTtlMs, 300_000);

  const pool = new ConnPool();
  assert.equal(pool.maxTotal, 240);
  assert.equal(pool.maxPerHost, 32);
  assert.equal(pool.idleMs, 180_000);
});

test('isTelemetryUrl identifies tracking endpoints while leaving video and assets untouched', () => {
  assert.equal(isTelemetryUrl('https://api.vigo.tech/uxzoom/1/notify?foo=bar'), true);
  assert.equal(isTelemetryUrl('https://log.rutube.ru/player_events/?app=player-rutube'), true);
  assert.equal(isTelemetryUrl('https://931221.log.rutube.ru/?t=1789641539050'), true);
  assert.equal(isTelemetryUrl('https://951221.log.rutube.ru/?t=1789641542543'), true);
  assert.equal(isTelemetryUrl('https://goya.rutube.ru/v2/online/2069613e9e2006f9/?event_name=mrc'), true);
  assert.equal(isTelemetryUrl('https://ac.rutube.ru/api/v1/ev?cid=123&ev_type=play_start'), true);
  assert.equal(isTelemetryUrl('https://uxfeedback.ru/widget/123.js'), true);
  assert.equal(isTelemetryUrl('https://mc.yandex.ru/metrika/watch.js'), true);
  // VK and OK telemetry
  assert.equal(isTelemetryUrl('https://vk.ru/video_mediascope?event_name=pause&video_id=123'), true);
  assert.equal(isTelemetryUrl('https://api.okcdn.ru/fb.do'), true);
  assert.equal(isTelemetryUrl('https://api.vkvideo.ru/method/video.trackPlayerEvents?v=5.289'), true);
  assert.equal(isTelemetryUrl('https://api.vkvideo.ru/method/video.viewStarted?v=5.289'), true);
  assert.equal(isTelemetryUrl('https://vkvideo.ru/usefull.php'), true);
  assert.equal(isTelemetryUrl('https://vkvideo.ru/useful.php'), true);
  assert.equal(isTelemetryUrl('https://vk.com/rtrg?p=123'), true);
  assert.equal(isTelemetryUrl('https://tns-counter.ru/tb/counter.js'), true);
  // Twitter / X jot telemetry
  assert.equal(isTelemetryUrl('https://api.x.com/1.1/jot/client_event.json'), true);
  assert.equal(isTelemetryUrl('https://twitter.com/i/jot'), true);
  assert.equal(isTelemetryUrl('https://x.com/i/jot/'), true);
  // Walmart client performance & observability beacons
  assert.equal(isTelemetryUrl('https://www.walmart.com/si/elh9ie/obs'), true);
  assert.equal(isTelemetryUrl('https://walmart.com/si/12345/obs'), true);
  // Matomo open-source analytics
  assert.equal(isTelemetryUrl('https://www.sis.gov.uk/matomo/matomo.js'), true);
  assert.equal(isTelemetryUrl('https://www.sis.gov.uk/matomo/matomo.php'), true);

  // Non-telemetry endpoints must return false
  assert.equal(isTelemetryUrl('https://rutube.ru/video/2069613e9e2006f9a088cf94348fc996/'), false);
  assert.equal(isTelemetryUrl('https://river-3-346.rtbcdn.ru/hls-vod/segment-355-v1-a1.ts'), false);
  assert.equal(isTelemetryUrl('https://preview.rtbcdn.ru/preview/5531b7b1ef6025ec6033da4550e45365.webp?width=500'), false);
  assert.equal(isTelemetryUrl('https://pic.rtbcdn.ru/avatar.jpg'), false);
  assert.equal(isTelemetryUrl('https://static.rtbcdn.ru/bundle.min.js'), false);
  assert.equal(isTelemetryUrl('https://pbs.twimg.com/media/G123.jpg'), false);
  assert.equal(isTelemetryUrl('https://abs.twimg.com/responsive-web/client-web/main.123.js'), false);
});

test('decodeChunked respects custom max limit', () => {
  const payload = new TextEncoder().encode('5\r\nhello\r\n0\r\n\r\n');
  assert.throws(() => decodeChunked(payload, 3), /body too large/);

  const ok = decodeChunked(payload, 10);
  assert.equal(new TextDecoder().decode(ok.body), 'hello');
});

test('readHttpResponse truncates body at configurable maxBody', async () => {
  const head = new TextEncoder().encode('HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\n0123456789');
  let sent = false;
  const stream = {
    async read() {
      if (sent) return new Uint8Array(0);
      sent = true;
      return head;
    },
  };

  const res = await readHttpResponse(stream, { maxBody: 5 });
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 5);
  assert.equal(new TextDecoder().decode(res.body), '01234');
  assert.equal(res.keepAlive, false); // Truncated responses cannot keep connection alive
});

test('canPoolResponse and canWarmHost respect custom max limit', () => {
  assert.equal(canPoolResponse({ connection: 'keep-alive', keepAlive: true, body: new Uint8Array(50) }, 40), false);
  assert.equal(canPoolResponse({ connection: 'keep-alive', keepAlive: true, body: new Uint8Array(30) }, 40), true);

  assert.equal(canWarmHost({ body: new Uint8Array(50), leftover: new Uint8Array(0) }, 40), false);
  assert.equal(canWarmHost({ body: new Uint8Array(30), leftover: new Uint8Array(0) }, 40), true);
});

test('clearCookieCache is callable and resets without errors', () => {
  assert.doesNotThrow(() => clearCookieCache());
});

test('prepareFulfill decompresses gzip using single-allocation concatParts', async () => {
  const original = 'body-content-for-testing-gzip-decompression-with-lots-of-repeated-text-'.repeat(20);
  const compressed = zlib.gzipSync(Buffer.from(original));
  const res = await prepareFulfill({
    status: 200,
    headers: [
      { name: 'Content-Encoding', value: 'gzip' },
      { name: 'Content-Type', value: 'text/plain' },
    ],
    body: new Uint8Array(compressed),
  });
  assert.equal(res.status, 200);
  assert.equal(res.decoded, 'gzip');
  assert.equal(new TextDecoder().decode(res.body), original);
});
