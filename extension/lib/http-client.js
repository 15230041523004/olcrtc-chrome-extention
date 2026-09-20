import { getMaxBodyBytes } from './config.js';

export function getHttpMaxBody() {
  return getMaxBodyBytes();
}
export const HTTP_MAX_BODY = getMaxBodyBytes();
export const HTTP_READ_CHUNK_SIZE = 512 * 1024; // 512 KiB buffer size for high-throughput reads
const SKIP = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'proxy-connection',
  'keep-alive',
  'accept-encoding',
]);

export function buildHttpRequest({ method, path, host, headers, body, connection }) {
  const verb = method || 'GET';
  const conn = connection || 'close';
  let head = `${verb} ${path || '/'} HTTP/1.1\r\nHost: ${host}\r\nConnection: ${conn}\r\nAccept-Encoding: gzip, deflate\r\n`;
  if (body?.length) head += `Content-Length: ${body.length}\r\n`;
  else if (!['GET', 'HEAD'].includes(String(verb).toUpperCase())) head += `Content-Length: 0\r\n`;
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.startsWith(':')) continue;
    if (SKIP.has(key.toLowerCase())) continue;
    head += `${key}: ${value}\r\n`;
  }
  head += '\r\n';
  const prefix = new TextEncoder().encode(head);
  if (!body?.length) return prefix;
  const out = new Uint8Array(prefix.length + body.length);
  out.set(prefix);
  out.set(body, prefix.length);
  return out;
}

export function concatBytes(a, b) {
  const n = new Uint8Array(a.length + b.length);
  n.set(a);
  n.set(b, a.length);
  return n;
}

/** Decode HTTP/1.1 chunked body. Returns { body, rest, done }. */
export function decodeChunked(buf, max = getMaxBodyBytes()) {
  let offset = 0;
  const parts = [];
  let total = 0;
  const latin = new TextDecoder('latin1');
  while (offset < buf.length) {
    const view = latin.decode(buf.subarray(offset, Math.min(buf.length, offset + 64)));
    const nl = view.indexOf('\r\n');
    if (nl < 0) return { body: null, rest: buf.subarray(offset), done: false };
    const sizeLine = view.slice(0, nl).split(';', 1)[0].trim();
    const size = Number.parseInt(sizeLine, 16);
    if (!Number.isFinite(size) || size < 0) throw new Error('http: bad chunk size');
    offset += nl + 2;
    if (size === 0) {
      if (buf.length - offset >= 2) {
        const end = latin.decode(buf.subarray(offset, offset + 2));
        if (end === '\r\n') {
          return { body: concatParts(parts), rest: buf.subarray(offset + 2), done: true };
        }
      }
      const rem = latin.decode(buf.subarray(offset));
      const trailerEnd = rem.indexOf('\r\n\r\n');
      if (trailerEnd >= 0) {
        return { body: concatParts(parts), rest: buf.subarray(offset + trailerEnd + 4), done: true };
      }
      return { body: concatParts(parts), rest: buf.subarray(offset - (nl + 2)), done: false };
    }
    if (offset + size + 2 > buf.length) {
      return { body: concatParts(parts), rest: buf.subarray(offset - (nl + 2)), done: false };
    }
    if (total + size > max) throw new Error('http: body too large');
    parts.push(buf.subarray(offset, offset + size));
    total += size;
    offset += size + 2;
  }
  return { body: concatParts(parts), rest: new Uint8Array(0), done: false };
}

export function concatParts(parts) {
  if (!parts || parts.length === 0) return new Uint8Array(0);
  if (parts.length === 1) return parts[0];
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function parseHttpHeaders(headerText) {
  const lines = headerText.split('\r\n');
  const statusLine = lines.shift() || '';
  const match = statusLine.match(/^HTTP\/1\.([01]) (\d+)(?:\s+(.*))?/);
  const httpMinor = match ? Number(match[1]) : 1;
  const status = match ? Number(match[2]) : 502;
  const statusText = match?.[3] ? match[3].trim() : '';
  const headers = [];
  let contentLength = null;
  let chunked = false;
  let connection = '';
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    headers.push({ name, value });
    const lower = name.toLowerCase();
    if (lower === 'content-length') contentLength = Number(value);
    if (lower === 'transfer-encoding' && value.toLowerCase().includes('chunked')) chunked = true;
    if (lower === 'connection') connection = value.toLowerCase();
  }
  const keepAlive = connection.includes('close')
    ? false
    : connection.includes('keep-alive')
      ? true
      : httpMinor >= 1;
  return { status, statusText, headers, contentLength, chunked, keepAlive, httpMinor };
}

export const HTTP_BODY_IDLE_MS = 30_000;

/** Body wait: 45s min, 15s + 2s/16KiB, 180s cap. Chunked or unknown length: 180s. */
export function bodyTimeoutMs({ contentLength, chunked } = {}) {
  if (chunked || !Number.isFinite(contentLength) || contentLength < 0) return 180_000;
  const scaled = 15_000 + Math.ceil(contentLength / 16384) * 2000;
  return Math.min(180_000, Math.max(45_000, scaled));
}

function timedRead(stream, n, { deadline, idleMs, label, got } = {}) {
  const suffix = got != null ? ` got=${got}` : '';
  const now = Date.now();
  const overallLeft = deadline ? deadline - now : Infinity;
  const idleLeft = idleMs > 0 ? idleMs : Infinity;
  const wait = Math.min(overallLeft, idleLeft);
  if (!Number.isFinite(wait)) return stream.read(n);
  const kind = idleLeft <= overallLeft && Number.isFinite(idleLeft) ? 'idle' : 'timeout';
  if (wait <= 0) return Promise.reject(new Error(`${label} ${kind}${suffix}`));
  const read = stream.read(n);
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} ${kind}${suffix}`)), wait);
  });
  return Promise.race([read, timeout]).finally(() => clearTimeout(timer));
}

export async function readHttpResponse(stream, opts = {}) {
  const headerDeadline = opts.headerTimeoutMs ? Date.now() + opts.headerTimeoutMs : 0;
  const idleMs = opts.idleTimeoutMs === 0 ? 0 : (opts.idleTimeoutMs ?? HTTP_BODY_IDLE_MS);
  const maxBody = opts.maxBody ?? getMaxBodyBytes();
  let lastProg = Date.now();
  const progress = (n) => {
    if (!opts.onProgress) return;
    const now = Date.now();
    if (now - lastProg < 15_000) return;
    lastProg = now;
    opts.onProgress(n);
  };
  const bodyRead = (n, deadline, got) =>
    timedRead(stream, n, { deadline, idleMs, label: 'http body', got });
  let buf = new Uint8Array(0);
  for (;;) {
    const chunk = await timedRead(stream, 4096, {
      deadline: headerDeadline,
      label: 'http header',
      got: buf.length,
    });
    if (!chunk.length) break;
    buf = concatBytes(buf, chunk);
    const text = new TextDecoder('latin1').decode(buf.subarray(0, Math.min(buf.length, 65536)));
    const split = text.indexOf('\r\n\r\n');
    if (split < 0) {
      if (buf.length > 65536) throw new Error('http: header too large');
      continue;
    }
    const parsed = parseHttpHeaders(text.slice(0, split));
    opts.onHeaders?.(parsed, buf.subarray(0, split + 4));
    let bodyDeadline = Date.now() + bodyTimeoutMs(parsed);
    if (opts.bodyTimeoutMs) bodyDeadline = Math.max(bodyDeadline, Date.now() + opts.bodyTimeoutMs);
    let body = buf.subarray(split + 4);
    const isNoBody =
      opts.method === 'HEAD' ||
      parsed.status === 204 ||
      parsed.status === 304 ||
      (parsed.status >= 100 && parsed.status < 200);
    if (isNoBody) {
      return {
        status: parsed.status,
        statusText: parsed.statusText,
        headers: parsed.headers,
        body: new Uint8Array(0),
        keepAlive: parsed.keepAlive,
        leftover: body.length ? body : new Uint8Array(0),
      };
    }
    if (parsed.chunked) {
      const encoding = ((parsed.headers || []).find((h) => h.name.toLowerCase() === 'content-encoding')?.value || '').toLowerCase();
      const isCompressed = encoding.includes('gzip') || encoding.includes('deflate') || encoding.includes('br');
      const canEarlyIdle = Boolean(opts.isMedia) && !isCompressed;

      for (;;) {
        const dec = decodeChunked(body, maxBody);
        if (dec.done) {
          return {
            status: parsed.status,
            statusText: parsed.statusText,
            headers: parsed.headers,
            body: dec.body,
            keepAlive: parsed.keepAlive,
            leftover: dec.rest || new Uint8Array(0),
          };
        }
        let more;
        try {
          // If this is an uncompressed media stream (like YouTube SABR/ALR) and we already have data,
          // wait at most 600ms (or 1000ms if small) for more data before resolving the chunk.
          // For compressed responses (like gzipped JS/CSS/HTML), NEVER early-idle, or decompression will fail!
          const maxMediaIdle = dec.body && dec.body.length >= 64 * 1024 ? 600 : 1000;
          const chunkIdleMs = canEarlyIdle && dec.body && dec.body.length > 0 ? Math.min(maxMediaIdle, idleMs) : idleMs;
          more = await timedRead(stream, HTTP_READ_CHUNK_SIZE, {
            deadline: bodyDeadline,
            idleMs: chunkIdleMs,
            label: 'http body',
            got: body.length,
          });
        } catch (err) {
          if (canEarlyIdle && dec.body && dec.body.length > 0 && String(err?.message || '').includes('idle')) {
            return {
              status: parsed.status,
              statusText: parsed.statusText,
              headers: parsed.headers,
              body: dec.body,
              keepAlive: false,
              leftover: new Uint8Array(0),
            };
          }
          throw err;
        }
        if (!more.length) {
          if (dec.body && dec.body.length > 0) {
            return {
              status: parsed.status,
              statusText: parsed.statusText,
              headers: parsed.headers,
              body: dec.body,
              keepAlive: false,
              leftover: new Uint8Array(0),
            };
          }
          throw new Error('http: truncated chunked body');
        }
        body = concatBytes(body, more);
        progress(body.length);
      }
    }
    if (Number.isFinite(parsed.contentLength) && parsed.contentLength >= 0) {
      const want = Math.min(parsed.contentLength, maxBody);
      const willTruncate = parsed.contentLength > maxBody;
      if (body.length >= want) {
        return {
          status: parsed.status,
          statusText: parsed.statusText,
          headers: parsed.headers,
          body: body.subarray(0, want),
          keepAlive: willTruncate ? false : parsed.keepAlive,
          leftover: body.length > want ? body.subarray(want) : new Uint8Array(0),
        };
      }
      const parts = body.length ? [body] : [];
      let total = body.length;
      while (total < want) {
        const readSize = Math.min(HTTP_READ_CHUNK_SIZE, want - total);
        const more = await bodyRead(readSize, bodyDeadline, total);
        if (!more.length) break;
        parts.push(more);
        total += more.length;
        progress(total);
      }
      const assembled = concatParts(parts);
      return {
        status: parsed.status,
        statusText: parsed.statusText,
        headers: parsed.headers,
        body: assembled.subarray(0, want),
        keepAlive: willTruncate ? false : parsed.keepAlive,
        leftover: assembled.length > want ? assembled.subarray(want) : new Uint8Array(0),
      };
    }
    const parts = body.length ? [body] : [];
    let total = body.length;
    while (total < maxBody) {
      const readSize = Math.min(HTTP_READ_CHUNK_SIZE, maxBody - total);
      const more = await bodyRead(readSize, bodyDeadline, total);
      if (!more.length) break;
      parts.push(more);
      total += more.length;
      progress(total);
    }
    const assembled = concatParts(parts);
    return {
      status: parsed.status,
      statusText: parsed.statusText,
      headers: parsed.headers,
      body: assembled,
      keepAlive: false,
      leftover: new Uint8Array(0),
    };
  }
  throw new Error('http: connection closed before headers');
}

const HOP = new Set(['transfer-encoding', 'content-encoding', 'content-length']);

export function headerValue(headers, name) {
  const n = name.toLowerCase();
  for (const h of headers || []) {
    if (h.name.toLowerCase() === n) return h.value;
  }
  return '';
}

function isGzipMagic(u8) {
  return u8.length >= 2 && u8[0] === 0x1f && u8[1] === 0x8b;
}

function looksLikeText(u8) {
  if (!u8.length) return true;
  if (u8.length >= 3 && u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) return true;
  if (u8.length >= 7) {
    const prefix = new TextDecoder('latin1').decode(u8.subarray(0, 16));
    if (prefix.startsWith('#EXTM3U') || prefix.startsWith('WEBVTT') || prefix.startsWith('<?xml')) return true;
  }
  for (let i = 0; i < Math.min(u8.length, 24); i++) {
    const c = u8[i];
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) continue;
    return c === 0x3c || c === 0x7b || c === 0x23;
  }
  return true;
}

export async function inflateBody(body, encoding) {
  const enc = String(encoding || '').toLowerCase();
  let format = '';
  if (enc.includes('gzip') || enc.includes('x-gzip')) format = 'gzip';
  else if (enc.includes('deflate')) format = 'deflate';
  else return body instanceof Uint8Array ? body : new Uint8Array(body || []);
  const u8 = body instanceof Uint8Array ? body : new Uint8Array(body || []);
  if (!u8.length) return u8;
  const ds = new DecompressionStream(format);
  const parts = [];
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  const writeP = writer.write(u8).then(() => writer.close());
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value?.length) parts.push(value);
  }
  await writeP;
  return concatParts(parts);
}

/** Decode gzip/deflate and drop hop-by-hop headers so Fetch.fulfillRequest can render HTML. */
export async function prepareFulfill(res) {
  const encoding = headerValue(res.headers, 'content-encoding');
  const raw = res.body instanceof Uint8Array ? res.body : new Uint8Array(res.body || []);
  const enc = String(encoding || '').toLowerCase();
  const status = res.status || 200;
  const redirect = status >= 300 && status < 400;
  const wantGzip = enc.includes('gzip') || enc.includes('x-gzip');
  const wantDeflate = enc.includes('deflate') && !wantGzip;
  let body = raw;
  let decoded = '';
  const tryInflate = raw.length > 0 && ((wantGzip && isGzipMagic(raw)) || wantDeflate);
  if (tryInflate) {
    try {
      body = await inflateBody(raw, encoding);
      decoded = wantGzip ? 'gzip' : 'deflate';
    } catch (err) {
      if (redirect) body = new Uint8Array(0);
      else if (looksLikeText(raw)) body = raw;
      else throw new Error(`http.decode fail ${err.message}`);
    }
  } else if ((wantGzip || wantDeflate) && !redirect && raw.length && !looksLikeText(raw) && !isGzipMagic(raw)) {
    throw new Error('http.decode fail bad magic');
  }
  const headers = (res.headers || []).filter((h) => !HOP.has(h.name.toLowerCase()));
  headers.push({ name: 'Content-Length', value: String(body.length) });

  if (res.status === 206) {
    const crIndex = headers.findIndex((h) => h.name.toLowerCase() === 'content-range');
    if (crIndex !== -1) {
      const cr = headers[crIndex].value;
      const m = cr.match(/^bytes\s+(\d+)-(\d+)\/(.*)$/i);
      if (m) {
        const start = parseInt(m[1], 10);
        const end = start + body.length - 1;
        headers[crIndex].value = `bytes ${start}-${Math.max(start, end)}/${m[3]}`;
      }
    } else {
      const end = Math.max(0, body.length - 1);
      headers.push({ name: 'Content-Range', value: `bytes 0-${end}/${body.length}` });
    }
  }

  return { ...res, body, headers, decoded, rawLength: raw.length };
}
