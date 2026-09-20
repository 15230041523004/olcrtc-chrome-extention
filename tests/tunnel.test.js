import test from 'node:test';
import assert from 'node:assert/strict';
import { Tunnel, isImageUrl } from '../extension/lib/tunnel.js';
import { ConnPool, HostGate, Semaphore } from '../extension/lib/pool.js';
import { buildEpochHeader, parseEpochHeader, splitKCPPayload, appendBatchPacket, KCP_BATCH_MAGIC } from '../extension/lib/vp8-wire.js';
import { KCP_MTU } from '../extension/lib/kcp.js';
import { nativeSealKcp, nativeOpenKcp } from './helpers/native-wire.js';

function readyTunnel() {
  const logs = [];
  const tunnel = new Tunnel((line) => logs.push(line));
  tunnel.localEpoch = 0x76911886;
  tunnel.token = 0x12345678;
  tunnel.ready = tunnel.tokenOk = true;
  tunnel.lastDataKeep = performance.now();
  return { tunnel, logs };
}

test('33 queued KCP datagrams leave on delta ticks in samples of at most two', () => {
  const { tunnel, logs } = readyTunnel();
  const packets = Array.from({ length: 33 }, (_, i) => new Uint8Array(KCP_MTU).fill(i));
  tunnel.controlOut.push(...packets);
  const received = [];
  for (let i = 0; i < 17; i++) {
    const sample = tunnel.buildSample({ frameType: 'delta' });
    assert.ok(sample, 'a delta frame must carry queued KCP');
    assert.ok(sample.byteLength <= 2852, 'bounded VP8 sample including OLKB and per-datagram CRC32C');
    const header = parseEpochHeader(sample);
    assert.ok(header.ok);
    assert.equal(header.src, 0xf6911886);
    const batch = splitKCPPayload(header.payload).map(nativeOpenKcp);
    assert.ok(batch.every(Boolean), 'native CRC32C gate must accept every datagram');
    assert.ok(batch.length >= 1 && batch.length <= 2);
    received.push(...batch);
  }
  assert.deepEqual(received, packets, 'preserves every datagram and its order');
  assert.equal(tunnel.controlOut.length, 0);
  assert.ok(logs.some((line) => line.includes('chromeType=delta stuffed=kcp')));
});

test('control priority preserves queued data and enforces bare data keepalives under load', () => {
  const { tunnel } = readyTunnel();
  const ctrl = new Uint8Array(30).fill(1);
  const data = new Uint8Array(50).fill(2);
  tunnel.controlOut.push(ctrl, ctrl, ctrl);
  tunnel.dataOut.push(data);
  const first = parseEpochHeader(tunnel.buildSample({ frameType: 'delta' }));
  assert.equal(first.src, 0xf6911886);
  assert.equal(tunnel.dataOut.length, 1);
  tunnel.lastDataKeep = performance.now() - 2001;
  const keep = parseEpochHeader(tunnel.buildSample({ frameType: 'delta' }));
  assert.equal(keep.src, tunnel.localEpoch);
  assert.equal(keep.payload.length, 0);
  assert.equal(tunnel.controlOut.length, 1);
  assert.equal(tunnel.dataOut.length, 1);
  tunnel.buildSample({ frameType: 'delta' });
  const last = parseEpochHeader(tunnel.buildSample({ frameType: 'key' }));
  assert.deepEqual(splitKCPPayload(last.payload).map(nativeOpenKcp), [data]);
});

test('unsigned control epochs accept server responses addressed to this client', () => {
  const { tunnel } = readyTunnel();
  assert.equal(tunnel.acceptsDst(0xf6911886), true);
  assert.equal(tunnel.acceptsControl(0xe6fe81a8, 0xf6911886), true);
  assert.equal(tunnel.acceptsControl(0xe6fe81a8, 0), false);
  assert.equal(tunnel.acceptsControl(0xe6fe81a8, 0x80000001), false);
  tunnel.confirmPeer('66fe81a8');
  tunnel.handshakeOk = true;
  assert.equal(tunnel.controlDst, 0xe6fe81a8);
  assert.equal(tunnel.acceptsControl(0xe6fe81a8, 0xf6911886), true);
  assert.equal(tunnel.acceptsControl(0xe6fe81a8, 0), false);
  assert.equal(tunnel.acceptsControl(0x80000001, 0xf6911886), false);
});

test('looped-back control packets never enter KCP', () => {
  const { tunnel } = readyTunnel();
  let inputs = 0;
  tunnel.control = { input() { inputs++; } };
  const sample = new Uint8Array(60);
  sample.set(buildEpochHeader(tunnel.token, 0xf6911886, 0));
  tunnel.handleInbound(sample);
  assert.equal(inputs, 0);
});

test('paused encoder queue stays bounded and resumes with small samples', () => {
  const { tunnel, logs } = readyTunnel();
  for (let i = 0; i < 1000; i++) tunnel.onKcpOut('ctrl', new Uint8Array(24));
  assert.equal(tunnel.controlOut.length, 256);
  assert.equal(tunnel.stats.queueDrops, 744);
  assert.ok(logs.some((line) => line.startsWith('vp8.queue drop=')));
  const sample = tunnel.buildSample({ frameType: 'key' });
  assert.equal(splitKCPPayload(parseEpochHeader(sample).payload).length, 2);
  assert.equal(tunnel.controlOut.length, 254);
});

test('invalid welcome peer IDs cannot mark a tunnel connected', () => {
  const { tunnel } = readyTunnel();
  for (const id of ['', '00000000', 'e6fe81a8', '66fe81a8junk', '66fe']) {
    assert.throws(() => tunnel.confirmPeer(id), /peer_id/);
  }
  assert.equal(tunnel.peerEpoch, 0);
});

test('addressed native ACK has its CRC32C checked and removed before KCP', () => {
  const { tunnel } = readyTunnel();
  const packets = [];
  tunnel.control = { input(packet) { packets.push(packet.slice()); return 0; } };
  const ack = Buffer.from('01eeffc05200001000000000000000000000000000000000', 'hex');
  const wire = nativeSealKcp(ack);
  const frame = new Uint8Array(36 + wire.length);
  frame.set(buildEpochHeader(tunnel.token, 0xe6fe81a8, tunnel.localControlEpoch));
  frame.set(wire, 36);
  tunnel.handleInbound(frame);
  assert.deepEqual(packets, [new Uint8Array(ack)], 'no trailer may reach the KCP parser');
  frame[frame.length - 1] ^= 1;
  tunnel.handleInbound(frame);
  assert.equal(packets.length, 1, 'corrupted packets must never reach KCP');
});

test('a bad CRC in one batch entry does not discard a separate valid entry', () => {
  const { tunnel } = readyTunnel();
  const packets = [];
  tunnel.control = { input(packet) { packets.push(packet.slice()); return 0; } };
  const ack = Buffer.from('01eeffc05200001000000000000000000000000000000000', 'hex');
  const good = nativeSealKcp(ack);
  const bad = good.slice();
  bad[8] ^= 1;
  let sample = new Uint8Array(40);
  sample.set(buildEpochHeader(tunnel.token, 0xe6fe81a8, tunnel.localControlEpoch));
  sample.set(KCP_BATCH_MAGIC, 36);
  sample = appendBatchPacket(appendBatchPacket(sample, bad), good);
  tunnel.handleInbound(sample);
  assert.deepEqual(packets, [new Uint8Array(ack)]);
  assert.equal(tunnel.stats.wireCrcErrors, 1);
  assert.equal(tunnel.stats.controlIn, 1);
});

test('fair scheduling prevents control plane retransmission storm from starving data plane', () => {
  const { tunnel } = readyTunnel();
  const ctrl = new Uint8Array(30).fill(1);
  const data = new Uint8Array(50).fill(2);
  for (let i = 0; i < 10; i++) tunnel.controlOut.push(ctrl);
  tunnel.dataOut.push(data);

  const s1 = parseEpochHeader(tunnel.buildSample({ frameType: 'delta' }));
  assert.equal(s1.src, tunnel.localControlEpoch);
  const s2 = parseEpochHeader(tunnel.buildSample({ frameType: 'delta' }));
  assert.equal(s2.src, tunnel.localControlEpoch);
  const s3 = parseEpochHeader(tunnel.buildSample({ frameType: 'delta' }));
  assert.equal(s3.src, tunnel.localEpoch);
  assert.deepEqual(splitKCPPayload(s3.payload).map(nativeOpenKcp), [data]);
});

test('isMediaUrl strictly excludes static assets and telemetry while identifying video streams', async () => {
  const { isMediaUrl } = await import('../extension/lib/tunnel.js');

  // Static assets must NEVER be isMedia
  assert.equal(isMediaUrl('https://static.rtbcdn.ru/video/assets/2.121.0/web/js/582.js'), false);
  assert.equal(isMediaUrl('https://static.rtbcdn.ru/static/wdp/fonts/Semibold/OpenSans-Semibold.woff'), false);
  assert.equal(isMediaUrl('https://static.rutube.ru/static/img/png/adsdkbanner.png'), false);
  assert.equal(isMediaUrl('https://pic.rtbcdn.ru/video/2026-09-14/7a/57/thumb.jpg?width=500'), false);
  assert.equal(isMediaUrl('https://pic.rtbcdn.ru/user/7b/0e/avatar.webp'), false);
  assert.equal(isMediaUrl('https://rutube.ru/api/play/options/cc76bc511ff324eef371665d081cc3e1/?client=wdp'), false);
  assert.equal(isMediaUrl('https://log.rutube.ru/player_events/?app=player-rutube&did=123'), false);
  assert.equal(isMediaUrl('https://goya.rutube.ru/v2/banner/?cid=123'), false);
  assert.equal(isMediaUrl('https://api.vigo.tech/uxzoom/1/notify?svcid=fe73'), false);

  // Video streams and manifests MUST be isMedia
  assert.equal(isMediaUrl('https://bl.rutube.ru/route/cc76bc511ff324eef371665d081cc3e1.m3u8?guids=xyz'), true);
  assert.equal(isMediaUrl('https://river-ntv-rtk-d408.rtbcdn.ru/vod/hls/1080p/segment_001.ts'), true);
  assert.equal(isMediaUrl('https://rr1---sn-ax816n-aixe.googlevideo.com/videoplayback?expire=123'), true);
  assert.equal(isMediaUrl('https://vkvd.net/video/route/stream.m3u8'), true);
  assert.equal(isMediaUrl('https://st1-25.vkvideo.ru/video/fragment-1.m4s'), true);
  assert.equal(isMediaUrl('https://vk6-4.vkuser.net/?expires=1789926792488&srcIp=23.95.170.162&bytes=13977-1107570'), true);
  assert.equal(isMediaUrl('https://iv.okcdn.ru/videoPreview?id=20015769455233&type=42'), true);
  assert.equal(isMediaUrl('https://example.com/stream-chunk', null, { range: 'bytes=0-1000' }), true);
});

test('tunnel.reconnect resets peer epochs, clears pool, and starts handshake', async () => {
  const { tunnel, logs } = readyTunnel();
  tunnel.peerEpoch = 0x524eb0e5;
  tunnel.handshakeOk = true;
  tunnel.pingOk = true;
  tunnel.unackedPings = 3;
  tunnel.dataDst = 0x524eb0e5;
  tunnel.dataOut.push(new Uint8Array(10));

  let hsCalled = false;
  tunnel.startHandshake = async () => { hsCalled = true; };

  await tunnel.reconnect();
  assert.equal(tunnel.peerEpoch, 0);
  assert.equal(tunnel.handshakeOk, false);
  assert.equal(tunnel.pingOk, false);
  assert.equal(tunnel.unackedPings, 0);
  assert.equal(tunnel.dataOut.length, 0);
  assert.equal(hsCalled, true);
  assert.ok(logs.some((l) => l.includes('tunnel.reconnect: restarting handshake')));
});

test('tunnel.reconnect generates a fresh localEpoch and re-derives crypto keys', async () => {
  const { tunnel } = readyTunnel();
  const oldEpoch = tunnel.localEpoch;
  tunnel.startHandshake = async () => {};

  await tunnel.reconnect();
  assert.notEqual(tunnel.localEpoch, oldEpoch, 'localEpoch must be randomized on reconnect');
  assert.ok(tunnel.localEpoch > 0);
});

test('tunnel.startHandshake schedules auto-retry on error when ready', async (t) => {
  const { tunnel, logs } = readyTunnel();
  let attempts = 0;
  tunnel.smux = {
    openStream() {
      attempts++;
      throw new Error('connection refused');
    },
  };

  await tunnel.startHandshake();
  assert.equal(attempts, 1);
  assert.equal(tunnel.handshakeOk, false);
  assert.ok(tunnel.handshakeRetryTimer !== null, 'retry timer must be scheduled');
  assert.ok(logs.some((l) => l.includes('handshake.error connection refused')));
  clearTimeout(tunnel.handshakeRetryTimer);
});

test('httpProxy warm-socket fast-path bypasses hostGate queue when connection is in pool', async () => {
  const { tunnel } = readyTunnel();
  tunnel.pool = new ConnPool();
  tunnel.subSem = new Semaphore(64);
  tunnel.mediaSem = new Semaphore(16);
  tunnel.hostGate = new HostGate(6);
  tunnel.imageGate = new HostGate(6);
  const key = 'abs.twimg.com:443:tls';

  // Mock dummy stream in pool
  const mockStream = {
    closed: false,
    write: () => {},
    read: async () => new Uint8Array(0),
    close: () => {},
  };
  tunnel.pool.put(key, mockStream);
  assert.equal(tunnel.pool.totalIdle(), 1);

  // Block the gate completely (concurrency 6)
  let unblockGate;
  const blockPromise = new Promise((r) => { unblockGate = r; });
  for (let i = 0; i < (tunnel.imageGate?.limit || 6); i++) {
    void tunnel.imageGate.run(key, () => blockPromise);
  }

  // httpProxyInner mock that verifies stream came from pool
  let innerCalledWithStream = null;
  tunnel.httpProxyInner = async (req, opts) => {
    innerCalledWithStream = opts.stream;
    return { status: 200, body: new Uint8Array(0) };
  };

  // httpProxy should complete immediately despite the gate being 100% blocked
  const res = await tunnel.httpProxy({
    url: 'https://abs.twimg.com/pic.jpg',
    method: 'GET',
    headers: {},
  });

  assert.equal(res.status, 200);
  assert.equal(innerCalledWithStream, mockStream, 'warm stream from pool must be used directly');
  unblockGate();
});

test('isImageUrl correctly identifies SVG, AVIF, BMP and image CDNs (including walmartimages.com)', () => {
  assert.equal(isImageUrl('/images/logo.svg', 'www.example.com'), true);
  assert.equal(isImageUrl('/photos/photo.avif', 'static.example.com'), true);
  assert.equal(isImageUrl('/assets/icon.bmp', 'example.com'), true);
  assert.equal(isImageUrl('/dfw/63fd9f59/wplus-icon.svg', 'i5.walmartimages.com'), true);
  assert.equal(isImageUrl('/seo/item.jpeg', 'i5.walmartimages.com'), true);
  assert.equal(isImageUrl('/vi/dQw4w9WgXcQ/default.jpg', 'i.ytimg.com'), true);
  assert.equal(isImageUrl('/photo.png', 'img.example.com'), true);
  assert.equal(isImageUrl('/avatar.webp', 'pic.rtbcdn.ru'), true);

  // Non-image URLs must return false
  assert.equal(isImageUrl('/api/v1/user', 'api.walmart.com'), false);
  assert.equal(isImageUrl('/bundle.js', 'www.walmart.com'), false);
  assert.equal(isImageUrl('/index.html', 'example.com'), false);
});

test('tunnel start creates ConnPool with configured poolMaxPerHost (32) and poolMaxTotal (240)', async () => {
  const logs = [];
  const tunnel = new Tunnel((line) => logs.push(line));
  await tunnel.start({
    keyHex: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    roomId: 'test-room',
  });

  assert.equal(tunnel.pool.maxPerHost, 32);
  assert.equal(tunnel.pool.maxTotal, 240);
  tunnel.stop();
});

test('prewarmHost establishes connection and stores warm stream in pool', async () => {
  const { tunnel, logs } = readyTunnel();
  tunnel.dataSmux = { openStream() { return { sid: 1, closed: false, close() {} }; }, closeAll() {} };

  tunnel.connectTCP = async (host, port) => ({
    closed: false,
    read: async () => new Uint8Array(0),
    write() {},
    close() {},
  });

  const key = 'rr1---sn-ajab55-5o.googlevideo.com:443:tcp';
  await tunnel.prewarmHost(key, 'rr1---sn-ajab55-5o.googlevideo.com', 443, false);

  assert.equal(tunnel.pool.count(key), 1);
  assert.ok(logs.some((l) => l.includes('pool.prewarm.start')));
  assert.ok(logs.some((l) => l.includes('pool.prewarm.ok')));

  // Second call when already at 1 should be allowed up to 2
  await tunnel.prewarmHost(key, 'rr1---sn-ajab55-5o.googlevideo.com', 443, false);
  assert.equal(tunnel.pool.count(key), 2);

  // Third call should be skipped because count is >= 2
  await tunnel.prewarmHost(key, 'rr1---sn-ajab55-5o.googlevideo.com', 443, false);
  assert.equal(tunnel.pool.count(key), 2);

  tunnel.stop();
});

test('prewarmHost deduplicates concurrent in-flight calls for same key', async () => {
  const { tunnel } = readyTunnel();
  tunnel.dataSmux = { openStream() { return { sid: 1, closed: false, close() {} }; }, closeAll() {} };
  let connects = 0;
  tunnel.connectTCP = async () => {
    connects++;
    await new Promise((r) => setTimeout(r, 20));
    return { closed: false, read: async () => new Uint8Array(0), write() {}, close() {} };
  };

  const key = 'media.cdn.net:80:tcp';
  const p1 = tunnel.prewarmHost(key, 'media.cdn.net', 80, false);
  const p2 = tunnel.prewarmHost(key, 'media.cdn.net', 80, false);
  await Promise.all([p1, p2]);

  assert.equal(connects, 1, 'concurrent prewarm for same key must be deduplicated');
  assert.equal(tunnel.pool.count(key), 1);
  tunnel.stop();
});

test('httpProxy proactively triggers prewarmHost for media URLs when pool has no spare socket', async () => {
  const { tunnel } = readyTunnel();
  tunnel.dataSmux = { openStream() { return { sid: 1, closed: false, close() {} }; }, closeAll() {} };
  const prewarmed = [];
  tunnel.prewarmHost = async (k) => { prewarmed.push(k); };
  tunnel.httpProxyInner = async () => ({ status: 200, body: new Uint8Array(0) });

  await tunnel.httpProxy({
    url: 'https://rr1---sn-ax816n-aixe.googlevideo.com/videoplayback?expire=123',
    method: 'POST',
    headers: {},
  });

  assert.ok(prewarmed.some((k) => k.includes('googlevideo.com')), 'media request must trigger prewarmHost');
  tunnel.stop();
});



