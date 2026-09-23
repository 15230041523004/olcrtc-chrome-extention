/**
 * Global configuration module for olcRTC extension.
 */

export const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024; // 32 MiB

export const DEFAULT_CONFIG = {
  /** Maximum HTTP body size in bytes for intercepted requests and responses. */
  maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
  /** Total maximum idle keep-alive connections in the connection pool across all hosts. */
  poolMaxTotal: 240,
  /** Maximum idle keep-alive connections in the connection pool per host. */
  poolMaxPerHost: 32,
  /** Idle connection keep-alive timeout in milliseconds (15 seconds). */
  poolIdleMs: 15_000,
  /** Concurrent request limit for image hosts (matches Chrome MAX_SOCKETS_PER_GROUP = 6). */
  imageGateConcurrency: 6,
  /** Concurrent request limit per host (matches Chrome MAX_SOCKETS_PER_GROUP = 6 to prevent TLS handshake storms and maximize keep-alive reuse). */
  hostGateConcurrency: 6,
  /** Total concurrency semaphore limit for all subresources (JS/CSS/images/fonts/API). */
  subSemConcurrency: 64,
  /** Concurrency semaphore limit reserved specifically for media streaming (video/audio chunks). */
  mediaSemConcurrency: 16,
  /** Maximum KCP data packets (ACKs/datagrams) packed into a single VP8 video carrier frame. */
  maxDataPackets: 128,
  /** Fast-fulfill pure telemetry/metrics beacons with local 204 No Content to save tunnel bandwidth. */
  fastTelemetry: true,
  /** Fast-fulfill CORS preflight OPTIONS requests with local 204 No Content and permissive CORS headers. */
  fastCorsOptions: true,
  /** Enable in-flight GET request deduplication (coalescing). */
  coalesceEnabled: true,
  /** Enable short-lived in-memory LRU response cache for successful GET responses. */
  cacheEnabled: true,
  /** Maximum total size of in-memory response cache in bytes (default 512 MiB). */
  cacheMaxBytes: 512 * 1024 * 1024,
  /** Maximum size of an individual response to store in the in-memory cache (default 4 MiB). */
  cacheMaxItemBytes: 4 * 1024 * 1024,
  /** In-memory response cache TTL for dynamic API in milliseconds (default 30 seconds). */
  cacheTtlMs: 30_000,
  /** In-memory response cache TTL for static assets (images, fonts, scripts, css, svgs) in milliseconds (default 5 minutes). */
  cacheStaticTtlMs: 300_000,
};

export const CONFIG = { ...DEFAULT_CONFIG };

/**
 * Get maximum body size in bytes.
 * @returns {number}
 */
export function getMaxBodyBytes() {
  return CONFIG.maxBodyBytes;
}

/**
 * Set maximum body size in bytes.
 * Updates in-memory config and persists to chrome.storage.local if available.
 * @param {number} bytes
 */
export function setMaxBodyBytes(bytes) {
  const n = Number(bytes);
  if (Number.isFinite(n) && n > 0) {
    CONFIG.maxBodyBytes = n;
    if (typeof chrome !== 'undefined' && chrome.storage?.local?.set) {
      chrome.storage.local.set({ maxBodyBytes: n }).catch?.(() => {});
    }
  }
}

// Automatically load persisted configuration if running in Chrome extension context
if (typeof chrome !== 'undefined' && chrome.storage?.local?.get) {
  chrome.storage.local.get(
    [
      'maxBodyBytes',
      'poolMaxTotal',
      'poolMaxPerHost',
      'poolIdleMs',
      'imageGateConcurrency',
      'hostGateConcurrency',
      'subSemConcurrency',
      'fastTelemetry',
      'fastCorsOptions',
      'coalesceEnabled',
      'cacheEnabled',
      'cacheMaxBytes',
      'cacheMaxItemBytes',
      'cacheTtlMs',
      'cacheStaticTtlMs',
    ],
    (stored) => {
      if (stored?.maxBodyBytes && Number.isFinite(Number(stored.maxBodyBytes))) {
        CONFIG.maxBodyBytes = Number(stored.maxBodyBytes);
      }
      if (stored?.poolMaxTotal && Number.isFinite(Number(stored.poolMaxTotal))) {
        CONFIG.poolMaxTotal = Number(stored.poolMaxTotal);
      }
      if (stored?.poolMaxPerHost && Number.isFinite(Number(stored.poolMaxPerHost))) {
        CONFIG.poolMaxPerHost = Number(stored.poolMaxPerHost);
      }
      if (stored?.poolIdleMs && Number.isFinite(Number(stored.poolIdleMs))) {
        CONFIG.poolIdleMs = Number(stored.poolIdleMs);
      }
      if (typeof stored?.fastTelemetry === 'boolean') {
        CONFIG.fastTelemetry = stored.fastTelemetry;
      }
      if (typeof stored?.fastCorsOptions === 'boolean') {
        CONFIG.fastCorsOptions = stored.fastCorsOptions;
      }
      if (typeof stored?.coalesceEnabled === 'boolean') {
        CONFIG.coalesceEnabled = stored.coalesceEnabled;
      }
      if (typeof stored?.cacheEnabled === 'boolean') {
        CONFIG.cacheEnabled = stored.cacheEnabled;
      }
      if (stored?.cacheMaxBytes && Number.isFinite(Number(stored.cacheMaxBytes))) {
        CONFIG.cacheMaxBytes = Number(stored.cacheMaxBytes);
      }
      if (stored?.cacheMaxItemBytes && Number.isFinite(Number(stored.cacheMaxItemBytes))) {
        CONFIG.cacheMaxItemBytes = Number(stored.cacheMaxItemBytes);
      }
      if (stored?.cacheTtlMs && Number.isFinite(Number(stored.cacheTtlMs))) {
        CONFIG.cacheTtlMs = Number(stored.cacheTtlMs);
      }
      if (stored?.cacheStaticTtlMs && Number.isFinite(Number(stored.cacheStaticTtlMs))) {
        CONFIG.cacheStaticTtlMs = Number(stored.cacheStaticTtlMs);
      }
    },
  );
}
