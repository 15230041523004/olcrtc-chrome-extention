import { CONFIG, getMaxBodyBytes } from './config.js';

export const POOL_MAX_PER_HOST = CONFIG.poolMaxPerHost || 8;
export const POOL_MAX_TOTAL = CONFIG.poolMaxTotal || 48;
export const POOL_IDLE_MS = CONFIG.poolIdleMs || 45_000;
export const PROXY_INFLIGHT = 8;
export const CONNECT_TIMEOUT_MS = 10_000;
export const TLS_TIMEOUT_MS = 15_000;
export const HTTP_HEADER_TIMEOUT_MS = 25_000;
export const HTTP_BODY_IDLE_MS = 30_000;
export const HTTP_BODY_TIMEOUT_MS = 180_000;
export const HTTP_TIMEOUT_MS = HTTP_HEADER_TIMEOUT_MS + HTTP_BODY_TIMEOUT_MS;
export const POOL_MAX_BODY = getMaxBodyBytes();

export function canPoolResponse({ connection, keepAlive, body, leftover }, maxBody = getMaxBodyBytes()) {
  if (connection !== 'keep-alive' || !keepAlive) return false;
  if (leftover?.length) return false;
  if ((body?.length || 0) >= maxBody) return false;
  return true;
}

export function canWarmHost({ body, leftover }, maxBody = getMaxBodyBytes()) {
  return !(leftover?.length) && (body?.length || 0) < maxBody;
}

export function concatBytes(a, b) {
  const n = new Uint8Array(a.length + b.length);
  n.set(a);
  n.set(b, a.length);
  return n;
}

export class BufferedStream {
  constructor(inner) {
    this.inner = inner;
    this.buf = new Uint8Array(0);
  }

  get closed() {
    return Boolean(this.inner?.closed);
  }

  pushBack(u8) {
    if (!u8?.length) return;
    this.buf = this.buf.length ? concatBytes(u8, this.buf) : u8.slice();
  }

  write(u8) {
    this.inner.write(u8);
  }

  async read(n) {
    if (this.buf.length) {
      const take = Math.min(n ?? this.buf.length, this.buf.length);
      const out = this.buf.subarray(0, take).slice();
      this.buf = this.buf.subarray(take);
      return out;
    }
    return this.inner.read(n);
  }

  close() {
    this.inner.close?.();
  }
}

export function poolKey(host, port, tls) {
  return `${host}:${port}:${tls ? 'tls' : 'tcp'}`;
}

export class ConnPool {
  constructor({ maxPerHost = POOL_MAX_PER_HOST, maxTotal = POOL_MAX_TOTAL, idleMs = POOL_IDLE_MS, log, now } = {}) {
    this.maxPerHost = maxPerHost;
    this.maxTotal = maxTotal;
    this.idleMs = idleMs;
    this.log = log || (() => {});
    this.now = now || (() => Date.now());
    this.idle = new Map();
  }

  totalIdle() {
    let n = 0;
    for (const list of this.idle.values()) n += list.length;
    return n;
  }

  evictExpired() {
    const t = this.now();
    for (const [key, list] of this.idle) {
      const keep = [];
      for (const item of list) {
        if (t - item.at > this.idleMs) {
          item.stream.close?.();
          this.log(`pool.evict ${key} ttl`);
        } else {
          keep.push(item);
        }
      }
      if (keep.length) this.idle.set(key, keep);
      else this.idle.delete(key);
    }
  }

  evictOldest() {
    let oldestKey = null;
    let oldestAt = Infinity;
    for (const [key, list] of this.idle) {
      if (list[0] && list[0].at < oldestAt) {
        oldestAt = list[0].at;
        oldestKey = key;
      }
    }
    if (!oldestKey) return;
    const list = this.idle.get(oldestKey);
    const item = list.shift();
    item.stream.close?.();
    this.log(`pool.evict ${oldestKey} total`);
    if (!list.length) this.idle.delete(oldestKey);
  }

  take(key) {
    this.evictExpired();
    const list = this.idle.get(key);
    while (list?.length) {
      const item = list.pop();
      if (item.stream?.closed) {
        item.stream.close?.();
        this.log(`pool.drop ${key} dead`);
        continue;
      }
      if (!list.length) this.idle.delete(key);
      this.log(`pool.hit ${key} idle=${this.totalIdle()}`);
      return item.stream;
    }
    this.idle.delete(key);
    return null;
  }

  put(key, stream) {
    this.evictExpired();
    while (this.totalIdle() >= this.maxTotal) this.evictOldest();
    let list = this.idle.get(key);
    if (!list) {
      list = [];
      this.idle.set(key, list);
    }
    while (list.length >= this.maxPerHost) {
      const old = list.shift();
      old.stream.close?.();
      this.log(`pool.evict ${key} perHost`);
    }
    list.push({ stream, at: this.now() });
  }

  clear() {
    for (const list of this.idle.values()) {
      for (const item of list) item.stream.close?.();
    }
    this.idle.clear();
  }
}

export class Semaphore {
  constructor(max, log) {
    this.max = max;
    this.n = 0;
    this.wait = [];
    this.log = log || (() => {});
  }

  async acquire() {
    while (this.n >= this.max) {
      await new Promise((r) => this.wait.push(r));
    }
    this.n += 1;
    this.log(`proxy.inflight=${this.n}`);
  }

  release() {
    this.n = Math.max(0, this.n - 1);
    this.log(`proxy.inflight=${this.n}`);
    const next = this.wait.shift();
    if (next) next();
  }
}

export function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Concurrency gate per key (limits concurrent CONNECT+TLS+HTTP per host). */
export class HostGate {
  constructor(concurrency = 1) {
    this.concurrency = concurrency;
    this.running = new Map();
    this.queue = new Map();
  }

  async run(key, fn) {
    while ((this.running.get(key) || 0) >= this.concurrency) {
      await new Promise((resolve) => {
        let q = this.queue.get(key);
        if (!q) {
          q = [];
          this.queue.set(key, q);
        }
        q.push(resolve);
      });
    }
    this.running.set(key, (this.running.get(key) || 0) + 1);
    try {
      return await fn();
    } finally {
      const active = (this.running.get(key) || 1) - 1;
      if (active <= 0) {
        this.running.delete(key);
      } else {
        this.running.set(key, active);
      }
      const q = this.queue.get(key);
      const next = q?.shift();
      if (next) {
        if (!q.length) this.queue.delete(key);
        next();
      }
    }
  }
}
