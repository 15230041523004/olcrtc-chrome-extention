import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ConnPool,
  Semaphore,
  BufferedStream,
  HostGate,
  poolKey,
  canPoolResponse,
  canWarmHost,
  POOL_MAX_BODY,
} from '../extension/lib/pool.js';

function mockStream() {
  return {
    closed: false,
    close() {
      this.closed = true;
    },
  };
}

test('canPoolResponse rejects large bodies and leftovers', () => {
  const small = new Uint8Array(16);
  assert.equal(
    canPoolResponse({ connection: 'keep-alive', keepAlive: true, body: small, leftover: new Uint8Array(0) }),
    true,
  );
  assert.equal(
    canPoolResponse({
      connection: 'keep-alive',
      keepAlive: true,
      body: new Uint8Array(POOL_MAX_BODY),
      leftover: new Uint8Array(0),
    }),
    false,
  );
  assert.equal(
    canPoolResponse({
      connection: 'keep-alive',
      keepAlive: true,
      body: small,
      leftover: new Uint8Array([1]),
    }),
    false,
  );
  assert.equal(
    canPoolResponse({ connection: 'close', keepAlive: true, body: small, leftover: new Uint8Array(0) }),
    false,
  );
});

test('canWarmHost only for small complete bodies', () => {
  assert.equal(canWarmHost({ body: new Uint8Array(8), leftover: new Uint8Array(0) }), true);
  assert.equal(canWarmHost({ body: new Uint8Array(POOL_MAX_BODY), leftover: new Uint8Array(0) }), false);
  assert.equal(canWarmHost({ body: new Uint8Array(8), leftover: new Uint8Array([1]) }), false);
});

test('poolKey encodes host port tls', () => {
  assert.equal(poolKey('a.com', 443, true), 'a.com:443:tls');
  assert.equal(poolKey('a.com', 80, false), 'a.com:80:tcp');
});

test('pool hit reuses idle stream', () => {
  const logs = [];
  const pool = new ConnPool({ log: (m) => logs.push(m), now: () => 1000 });
  const s = mockStream();
  pool.put('h:443:tls', s);
  assert.equal(pool.take('h:443:tls'), s);
  assert.equal(pool.take('h:443:tls'), null);
  assert.ok(logs.some((l) => l.startsWith('pool.hit')));
});

test('pool take drops dead streams', () => {
  const logs = [];
  const pool = new ConnPool({ log: (m) => logs.push(m), now: () => 1000 });
  const dead = mockStream();
  const alive = mockStream();
  pool.put('h:443:tls', alive);
  pool.put('h:443:tls', dead);
  dead.closed = true;
  assert.equal(pool.take('h:443:tls'), alive);
  assert.ok(logs.some((l) => l.includes('pool.drop')));
});

test('pool miss after idle ttl', () => {
  let t = 0;
  const pool = new ConnPool({ idleMs: 30, log: () => {}, now: () => t });
  const s = mockStream();
  t = 0;
  pool.put('h:443:tls', s);
  t = 40;
  assert.equal(pool.take('h:443:tls'), null);
  assert.equal(s.closed, true);
});

test('pool evicts per-host overflow', () => {
  const pool = new ConnPool({ maxPerHost: 2, maxTotal: 8, log: () => {}, now: () => 1 });
  const a = mockStream();
  const b = mockStream();
  const c = mockStream();
  pool.put('h:443:tls', a);
  pool.put('h:443:tls', b);
  pool.put('h:443:tls', c);
  assert.equal(a.closed, true);
  assert.equal(pool.totalIdle(), 2);
});

test('semaphore orders waiters', async () => {
  const logs = [];
  const sem = new Semaphore(1, (m) => logs.push(m));
  const order = [];
  await sem.acquire();
  const second = sem.acquire().then(() => order.push('b'));
  order.push('a');
  sem.release();
  await second;
  assert.deepEqual(order, ['a', 'b']);
  assert.ok(logs.includes('proxy.inflight=1'));
});

test('HostGate serializes two runs on the same key', async () => {
  const gate = new HostGate();
  const order = [];
  let releaseFirst;
  const first = gate.run('h:443:tls', () => new Promise((r) => {
    order.push('a-start');
    releaseFirst = () => {
      order.push('a-end');
      r('one');
    };
  }));
  const second = gate.run('h:443:tls', async () => {
    order.push('b');
    return 'two';
  });
  for (let i = 0; i < 10 && !releaseFirst; i++) await Promise.resolve();
  assert.equal(typeof releaseFirst, 'function');
  assert.deepEqual(order, ['a-start']);
  releaseFirst();
  assert.equal(await first, 'one');
  assert.equal(await second, 'two');
  assert.deepEqual(order, ['a-start', 'a-end', 'b']);
});

test('BufferedStream pushBack is read first', async () => {
  const inner = {
    chunks: [new Uint8Array([3, 4])],
    async read() {
      return this.chunks.shift() || new Uint8Array(0);
    },
    write() {},
    close() {},
  };
  const s = new BufferedStream(inner);
  s.pushBack(new Uint8Array([1, 2]));
  const a = await s.read(10);
  assert.deepEqual([...a], [1, 2]);
  const b = await s.read(10);
  assert.deepEqual([...b], [3, 4]);
});

test('canPoolResponse accepts 2MB video chunk bodies', () => {
  const videoChunk = new Uint8Array(2 * 1024 * 1024);
  assert.equal(
    canPoolResponse({ connection: 'keep-alive', keepAlive: true, body: videoChunk, leftover: new Uint8Array(0) }),
    true,
  );
  assert.equal(canWarmHost({ body: videoChunk, leftover: new Uint8Array(0) }), true);
});

test('HostGate(2) allows two concurrent runs and queues the third', async () => {
  const gate = new HostGate(2);
  const events = [];
  let release1, release2;
  const p1 = gate.run('video-host', () => new Promise((r) => {
    events.push('p1-start');
    release1 = () => { events.push('p1-end'); r('p1'); };
  }));
  const p2 = gate.run('video-host', () => new Promise((r) => {
    events.push('p2-start');
    release2 = () => { events.push('p2-end'); r('p2'); };
  }));
  const p3 = gate.run('video-host', async () => {
    events.push('p3-run');
    return 'p3';
  });

  for (let i = 0; i < 10 && (!release1 || !release2); i++) await Promise.resolve();
  assert.deepEqual(events, ['p1-start', 'p2-start']);
  release1();
  assert.equal(await p1, 'p1');
  assert.equal(await p3, 'p3');
  assert.deepEqual(events, ['p1-start', 'p2-start', 'p1-end', 'p3-run']);
  release2();
  assert.equal(await p2, 'p2');
  assert.deepEqual(events, ['p1-start', 'p2-start', 'p1-end', 'p3-run', 'p2-end']);
});

test('ConnPool.count returns exact idle count for key and evicts expired', () => {
  let t = 1000;
  const pool = new ConnPool({ idleMs: 50, now: () => t });
  const key = 'h:443:tls';
  assert.equal(pool.count(key), 0);
  pool.put(key, mockStream());
  pool.put(key, mockStream());
  assert.equal(pool.count(key), 2);
  t += 60; // expire
  assert.equal(pool.count(key), 0);
});

test('HostGate.run respects maxConcurrency override for throttled image downloads', async () => {
  const gate = new HostGate(6);
  const events = [];
  let release1;
  const p1 = gate.run('img-host', () => new Promise((r) => {
    events.push('p1-start');
    release1 = () => { events.push('p1-end'); r('p1'); };
  }), 1); // limit to 1
  const p2 = gate.run('img-host', async () => {
    events.push('p2-run');
    return 'p2';
  }, 1);

  for (let i = 0; i < 10 && !release1; i++) await Promise.resolve();
  assert.deepEqual(events, ['p1-start']);
  release1();
  assert.equal(await p1, 'p1');
  assert.equal(await p2, 'p2');
  assert.deepEqual(events, ['p1-start', 'p1-end', 'p2-run']);
});

