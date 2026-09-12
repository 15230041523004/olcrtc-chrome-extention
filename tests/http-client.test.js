import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import {
  buildHttpRequest,
  bodyTimeoutMs,
  decodeChunked,
  parseHttpHeaders,
  readHttpResponse,
  prepareFulfill,
  concatParts,
} from '../extension/lib/http-client.js';

test('prepareFulfill 301 with gzip header and empty body keeps Location', async () => {
  const res = await prepareFulfill({
    status: 301,
    headers: [
      { name: 'Content-Encoding', value: 'gzip' },
      { name: 'Transfer-Encoding', value: 'chunked' },
      { name: 'Location', value: 'https://yandex.ru/' },
    ],
    body: new Uint8Array(0),
  });
  assert.equal(res.status, 301);
  assert.equal(res.decoded, '');
  assert.equal(res.body.length, 0);
  assert.equal(res.headers.find((h) => h.name === 'Location').value, 'https://yandex.ru/');
  assert.ok(!res.headers.some((h) => h.name.toLowerCase() === 'content-encoding'));
});

test('prepareFulfill 200 html with false gzip header is not inflated', async () => {
  const html = new TextEncoder().encode('<html>ok</html>');
  const res = await prepareFulfill({
    status: 200,
    headers: [
      { name: 'Content-Encoding', value: 'gzip' },
      { name: 'Content-Type', value: 'text/html' },
    ],
    body: html,
  });
  assert.equal(new TextDecoder().decode(res.body), '<html>ok</html>');
  assert.equal(res.decoded, '');
});

test('prepareFulfill gunzips and drops hop-by-hop headers', async () => {
  const plain = new TextEncoder().encode('<html>ok</html>');
  const gz = zlib.gzipSync(plain);
  const res = await prepareFulfill({
    status: 200,
    headers: [
      { name: 'Content-Encoding', value: 'gzip' },
      { name: 'Transfer-Encoding', value: 'chunked' },
      { name: 'Content-Type', value: 'text/html' },
    ],
    body: gz,
  });
  assert.equal(new TextDecoder().decode(res.body), '<html>ok</html>');
  assert.equal(res.decoded, 'gzip');
  assert.equal(res.rawLength, gz.length);
  assert.ok(!res.headers.some((h) => h.name.toLowerCase() === 'content-encoding'));
  assert.ok(!res.headers.some((h) => h.name.toLowerCase() === 'transfer-encoding'));
  assert.equal(res.headers.find((h) => h.name === 'Content-Length').value, String(plain.length));
});

test('builds GET with gzip/deflate, not br/zstd/identity', () => {
  const u8 = buildHttpRequest({
    method: 'GET',
    path: '/',
    host: 'example.com',
    headers: { Accept: '*/*', 'Accept-Encoding': 'gzip, br, zstd' },
  });
  const s = new TextDecoder().decode(u8);
  assert.match(s, /^GET \/ HTTP\/1\.1\r\n/);
  assert.match(s, /Host: example.com\r\n/);
  assert.match(s, /Connection: close\r\n/);
  assert.match(s, /Accept-Encoding: gzip, deflate\r\n/);
  assert.doesNotMatch(s, /Content-Length:/);
  assert.doesNotMatch(s, /identity/);
  assert.doesNotMatch(s, /br/);
  assert.doesNotMatch(s, /zstd/);
  assert.ok(s.endsWith('\r\n\r\n'));
});

test('POST without body sends Content-Length: 0', () => {
  const s = new TextDecoder().decode(
    buildHttpRequest({ method: 'POST', path: '/youtubei/v1/next', host: 'www.youtube.com' }),
  );
  assert.match(s, /^POST \/youtubei\/v1\/next HTTP\/1\.1\r\n/);
  assert.match(s, /Content-Length: 0\r\n/);
  assert.ok(s.endsWith('\r\n\r\n'));
});

test('POST with body sends Content-Length of the bytes', () => {
  const body = new Uint8Array([0x00, 0x80, 0xff]);
  const u8 = buildHttpRequest({
    method: 'POST',
    path: '/',
    host: 'example.com',
    body,
  });
  const s = new TextDecoder('latin1').decode(u8);
  assert.match(s, /Content-Length: 3\r\n/);
  assert.deepEqual(u8.subarray(u8.length - 3), body);
});

test('bodyTimeoutMs scales with Content-Length', () => {
  assert.equal(bodyTimeoutMs({ chunked: true }), 180_000);
  assert.equal(bodyTimeoutMs({ contentLength: 1000 }), 45_000);
  assert.equal(bodyTimeoutMs({ contentLength: 16 * 1024 * 40 }), 95_000);
  assert.equal(bodyTimeoutMs({ contentLength: 8 * 1024 * 1024 }), 180_000);
});

test('builds GET with keep-alive when asked', () => {
  const u8 = buildHttpRequest({
    method: 'GET',
    path: '/',
    host: 'example.com',
    connection: 'keep-alive',
  });
  assert.match(new TextDecoder().decode(u8), /Connection: keep-alive\r\n/);
});

test('readHttpResponse header timeout', async () => {
  const stream = {
    async read() {
      await new Promise((r) => setTimeout(r, 400));
      return new Uint8Array(0);
    },
  };
  await assert.rejects(
    () => readHttpResponse(stream, { headerTimeoutMs: 20 }),
    /header timeout/,
  );
});

test('decodes chunked body', () => {
  const raw = new TextEncoder().encode('5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n');
  const { body, done } = decodeChunked(raw);
  assert.equal(done, true);
  assert.equal(new TextDecoder().decode(body), 'hello world');
});

test('parseHttpHeaders sees chunked and keep-alive', () => {
  const p = parseHttpHeaders('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n');
  assert.equal(p.status, 200);
  assert.equal(p.chunked, true);
  assert.equal(p.keepAlive, true);
});

test('parseHttpHeaders Connection close', () => {
  const p = parseHttpHeaders('HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n');
  assert.equal(p.keepAlive, false);
});

test('readHttpResponse content-length leftover', async () => {
  const payload = new TextEncoder().encode('HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nabcdNEXT');
  const stream = fakeStream(payload);
  const res = await readHttpResponse(stream);
  assert.equal(res.status, 200);
  assert.equal(new TextDecoder().decode(res.body), 'abcd');
  assert.equal(new TextDecoder().decode(res.leftover), 'NEXT');
  assert.equal(res.keepAlive, true);
});

test('readHttpResponse chunked', async () => {
  const payload = new TextEncoder().encode(
    'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\n',
  );
  const res = await readHttpResponse(fakeStream(payload));
  assert.equal(new TextDecoder().decode(res.body), 'Wikipedia');
});

test('readHttpResponse body idle aborts a stall under a long overall deadline', async () => {
  const head = new TextEncoder().encode('HTTP/1.1 200 OK\r\nContent-Length: 200\r\n\r\n');
  const first = concatU8(head, new Uint8Array(100).fill(0x61));
  let n = 0;
  const stream = {
    async read() {
      n += 1;
      if (n === 1) return first;
      await new Promise((r) => setTimeout(r, 400));
      return new Uint8Array(0);
    },
  };
  await assert.rejects(
    () =>
      readHttpResponse(stream, {
        idleTimeoutMs: 25,
        bodyTimeoutMs: 500,
      }),
    /http body idle got=100/,
  );
});

test('readHttpResponse trickles under idle interval until complete', async () => {
  const head = new TextEncoder().encode('HTTP/1.1 200 OK\r\nContent-Length: 8\r\n\r\n');
  const chunks = [head, new Uint8Array([1, 2, 3, 4]), new Uint8Array([5, 6, 7, 8])];
  let i = 0;
  const stream = {
    async read() {
      if (i >= chunks.length) return new Uint8Array(0);
      const c = chunks[i];
      i += 1;
      if (i > 1) await new Promise((r) => setTimeout(r, 20));
      return c;
    },
  };
  const res = await readHttpResponse(stream, { idleTimeoutMs: 80, bodyTimeoutMs: 500 });
  assert.equal(res.body.length, 8);
  assert.deepEqual([...res.body], [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('readHttpResponse 204 No Content returns immediately with empty body', async () => {
  const payload = new TextEncoder().encode('HTTP/1.1 204 No Content\r\nServer: goya\r\nConnection: keep-alive\r\n\r\n');
  const stream = fakeStream(payload);
  const res = await readHttpResponse(stream, { idleTimeoutMs: 500 });
  assert.equal(res.status, 204);
  assert.equal(res.statusText, 'No Content');
  assert.equal(res.body.length, 0);
  assert.equal(res.keepAlive, true);
});

test('readHttpResponse 304 Not Modified and HEAD requests return empty body', async () => {
  const payload304 = new TextEncoder().encode('HTTP/1.1 304 Not Modified\r\nETag: "123"\r\n\r\n');
  const res304 = await readHttpResponse(fakeStream(payload304));
  assert.equal(res304.status, 304);
  assert.equal(res304.statusText, 'Not Modified');
  assert.equal(res304.body.length, 0);

  const payloadHead = new TextEncoder().encode('HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\n');
  const resHead = await readHttpResponse(fakeStream(payloadHead), { method: 'HEAD' });
  assert.equal(resHead.status, 200);
  assert.equal(resHead.statusText, 'OK');
  assert.equal(resHead.body.length, 0);
});

test('parseHttpHeaders extracts statusText and preserves non-standard codes', () => {
  const p = parseHttpHeaders('HTTP/1.1 244 Unknown Status Code\r\nServer: rutube\r\n\r\n');
  assert.equal(p.status, 244);
  assert.equal(p.statusText, 'Unknown Status Code');
});

test('buildHttpRequest strips HTTP/2 pseudo-headers starting with colon', () => {
  const raw = buildHttpRequest({
    method: 'GET',
    path: '/api/video',
    host: 'rutube.ru',
    headers: {
      ':authority': 'rutube.ru',
      ':method': 'GET',
      ':path': '/api/video',
      ':scheme': 'https',
      'User-Agent': 'Mozilla/5.0',
      'Accept': 'application/json',
    },
  });
  const text = new TextDecoder('latin1').decode(raw);
  assert.ok(!text.includes(':authority:'));
  assert.ok(!text.includes(':method:'));
  assert.ok(!text.includes(':path:'));
  assert.ok(!text.includes(':scheme:'));
  assert.ok(text.includes('User-Agent: Mozilla/5.0'));
  assert.ok(text.includes('Accept: application/json'));
  assert.ok(text.startsWith('GET /api/video HTTP/1.1\r\nHost: rutube.ru\r\n'));
});

test('prepareFulfill recognizes HLS #EXTM3U playlists without bad magic error', async () => {
  const m3u8 = new TextEncoder().encode('#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:10.0,\nchunk1.ts\n');
  const res = await prepareFulfill({
    status: 200,
    headers: [{ name: 'Content-Type', value: 'application/vnd.apple.mpegurl' }],
    body: m3u8,
  });
  assert.equal(res.status, 200);
  assert.equal(new TextDecoder().decode(res.body), new TextDecoder().decode(m3u8));
});

test('prepareFulfill synthesizes Content-Range on 206 if omitted by CDN', async () => {
  const chunk = new Uint8Array(1024).fill(0xaa);
  const res = await prepareFulfill({
    status: 206,
    headers: [{ name: 'Content-Type', value: 'video/mp4' }],
    body: chunk,
  });
  assert.equal(res.status, 206);
  const cr = res.headers.find((h) => h.name.toLowerCase() === 'content-range');
  assert.ok(cr, 'Content-Range header must be present on 206');
  assert.equal(cr.value, 'bytes 0-1023/1024');
});

test('concatParts provides zero-copy for single part and correctly combines multi-part', () => {
  const p1 = new Uint8Array([1, 2, 3]);
  const p2 = new Uint8Array([4, 5]);

  // Single part should return exact reference (zero-copy)
  assert.equal(concatParts([p1]), p1);

  // Empty should return 0-byte Uint8Array
  assert.equal(concatParts([]).length, 0);

  // Multi-part should concat properly
  const multi = concatParts([p1, p2]);
  assert.deepEqual(Array.from(multi), [1, 2, 3, 4, 5]);
});

function concatU8(a, b) {
  const n = new Uint8Array(a.length + b.length);
  n.set(a);
  n.set(b, a.length);
  return n;
}

function fakeStream(bytes) {
  let sent = false;
  return {
    async read() {
      if (sent) return new Uint8Array(0);
      sent = true;
      return bytes;
    },
  };
}
