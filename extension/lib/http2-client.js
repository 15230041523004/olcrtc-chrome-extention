/**
 * Minimal HTTP/2 client for Google domains (GFE mandates h2 for www.google.com etc.)
 *
 * Implements just enough of RFC 7540 to send a single GET request and read
 * the HEADERS + DATA response.  No multiplexing, no server-push handling,
 * no flow-control adjustments (initial window 65535 is big enough for the
 * HTML pages we proxy).
 *
 * HPACK: we send a static header table only (no dynamic table updates on the
 * request side). We parse the server's HPACK response with a very small
 * decoder that understands indexed headers and literal headers (with and
 * without indexing), which covers everything Google sends.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PREFACE = new TextEncoder().encode('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n');

// Frame types
const FRAME_DATA = 0x0;
const FRAME_HEADERS = 0x1;
const FRAME_PRIORITY = 0x2; // eslint-disable-line no-unused-vars
const FRAME_RST_STREAM = 0x3;
const FRAME_SETTINGS = 0x4;
const FRAME_PUSH_PROMISE = 0x5; // eslint-disable-line no-unused-vars
const FRAME_PING = 0x6;
const FRAME_GOAWAY = 0x7;
const FRAME_WINDOW_UPDATE = 0x8;
const FRAME_CONTINUATION = 0x9;

// Flags
const FLAG_END_STREAM = 0x1;
const FLAG_END_HEADERS = 0x4;
const FLAG_ACK = 0x1;
const FLAG_PADDED = 0x8;
const FLAG_PRIORITY = 0x20;

// ---------------------------------------------------------------------------
// Low-level frame reader/writer
// ---------------------------------------------------------------------------

function buildFrame(type, flags, streamId, payload) {
  const len = payload ? payload.length : 0;
  const frame = new Uint8Array(9 + len);
  const dv = new DataView(frame.buffer);
  dv.setUint8(0, (len >> 16) & 0xff);
  dv.setUint8(1, (len >> 8) & 0xff);
  dv.setUint8(2, len & 0xff);
  dv.setUint8(3, type);
  dv.setUint8(4, flags);
  dv.setUint32(5, streamId & 0x7fffffff);
  if (payload && payload.length) frame.set(payload, 9);
  return frame;
}

function buildSettingsFrame(settings = []) {
  const payload = new Uint8Array(settings.length * 6);
  const dv = new DataView(payload.buffer);
  for (let i = 0; i < settings.length; i++) {
    dv.setUint16(i * 6, settings[i][0]);
    dv.setUint32(i * 6 + 2, settings[i][1]);
  }
  return buildFrame(FRAME_SETTINGS, 0, 0, payload);
}

function buildSettingsAck() {
  return buildFrame(FRAME_SETTINGS, FLAG_ACK, 0, null);
}

function buildWindowUpdate(streamId, increment) {
  const payload = new Uint8Array(4);
  new DataView(payload.buffer).setUint32(0, increment & 0x7fffffff);
  return buildFrame(FRAME_WINDOW_UPDATE, 0, streamId, payload);
}

// ---------------------------------------------------------------------------
// HPACK encoder (minimal: only static table indexing + literal)
// ---------------------------------------------------------------------------

// Static header table (RFC 7541 Appendix A)
const STATIC_TABLE = [
  null, // index 0 unused
  [':authority', ''],
  [':method', 'GET'],
  [':method', 'POST'],
  [':path', '/'],
  [':path', '/index.html'],
  [':scheme', 'http'],
  [':scheme', 'https'],
  [':status', '200'],
  [':status', '204'],
  [':status', '206'],
  [':status', '304'],
  [':status', '400'],
  [':status', '404'],
  [':status', '500'],
  ['accept-charset', ''],
  ['accept-encoding', 'gzip, deflate'],
  ['accept-language', ''],
  ['accept-ranges', ''],
  ['accept', ''],
  ['access-control-allow-origin', ''],
  ['age', ''],
  ['allow', ''],
  ['authorization', ''],
  ['cache-control', ''],
  ['content-disposition', ''],
  ['content-encoding', ''],
  ['content-language', ''],
  ['content-length', ''],
  ['content-location', ''],
  ['content-range', ''],
  ['content-type', ''],
  ['cookie', ''],
  ['date', ''],
  ['etag', ''],
  ['expect', ''],
  ['expires', ''],
  ['from', ''],
  ['host', ''],
  ['if-match', ''],
  ['if-modified-since', ''],
  ['if-none-match', ''],
  ['if-range', ''],
  ['if-unmodified-since', ''],
  ['last-modified', ''],
  ['link', ''],
  ['location', ''],
  ['max-forwards', ''],
  ['proxy-authenticate', ''],
  ['proxy-authorization', ''],
  ['range', ''],
  ['referer', ''],
  ['refresh', ''],
  ['retry-after', ''],
  ['server', ''],
  ['set-cookie', ''],
  ['strict-transport-security', ''],
  ['transfer-encoding', ''],
  ['user-agent', ''],
  ['vary', ''],
  ['via', ''],
  ['www-authenticate', ''],
];

function hpackEncodeInt(prefix, n, prefixBits) {
  const max = (1 << prefixBits) - 1;
  const result = [];
  if (n < max) {
    result.push((prefix & ~max) | n);
  } else {
    result.push(prefix | max);
    n -= max;
    while (n >= 128) {
      result.push((n & 0x7f) | 0x80);
      n >>= 7;
    }
    result.push(n);
  }
  return result;
}

function hpackEncodeString(str) {
  const encoded = new TextEncoder().encode(str);
  const lenBytes = hpackEncodeInt(0, encoded.length, 7);
  return [...lenBytes, ...encoded];
}

function hpackEncodeHeader(name, value) {
  // Check for static table full match
  for (let i = 1; i < STATIC_TABLE.length; i++) {
    const entry = STATIC_TABLE[i];
    if (!entry) continue;
    if (entry[0] === name && entry[1] === value) {
      return hpackEncodeInt(0x80, i, 7); // indexed
    }
  }
  // Literal without indexing (0x00 prefix, name as literal or indexed)
  for (let i = 1; i < STATIC_TABLE.length; i++) {
    const entry = STATIC_TABLE[i];
    if (!entry) continue;
    if (entry[0] === name) {
      // Name index + literal value (no indexing: 0x00 prefix, 4-bit int)
      return [...hpackEncodeInt(0x00, i, 4), ...hpackEncodeString(value)];
    }
  }
  // Fully literal (name + value, no indexing: 0x00, then name as string)
  return [0x00, ...hpackEncodeString(name), ...hpackEncodeString(value)];
}

function buildHeadersFrame(streamId, headers, endStream = false) {
  let hpack = [];
  for (const [name, value] of headers) {
    hpack = [...hpack, ...hpackEncodeHeader(name, value)];
  }
  const payload = new Uint8Array(hpack);
  const flags = FLAG_END_HEADERS | (endStream ? FLAG_END_STREAM : 0);
  return buildFrame(FRAME_HEADERS, flags, streamId, payload);
}

// ---------------------------------------------------------------------------
// HPACK decoder (for response headers)
// ---------------------------------------------------------------------------

class HpackDecoder {
  constructor() {
    // Dynamic table (initially empty)
    this._dynamic = [];
    this._maxSize = 4096;
  }

  _tableEntry(i) {
    if (i >= 1 && i <= STATIC_TABLE.length - 1) return STATIC_TABLE[i];
    const di = i - STATIC_TABLE.length;
    if (di >= 0 && di < this._dynamic.length) return this._dynamic[di];
    return null;
  }

  _addDynamic(name, value) {
    this._dynamic.unshift([name, value]);
    // Evict entries if over max size (simplified: entry size = name + value + 32)
    let total = this._dynamic.reduce((s, e) => s + e[0].length + e[1].length + 32, 0);
    while (total > this._maxSize && this._dynamic.length > 0) {
      const removed = this._dynamic.pop();
      total -= removed[0].length + removed[1].length + 32;
    }
  }

  _decodeInt(data, pos, prefixBits) {
    const mask = (1 << prefixBits) - 1;
    let n = data[pos] & mask;
    pos++;
    if (n < mask) return { n, pos };
    let shift = 0;
    while (pos < data.length) {
      const b = data[pos++];
      n += (b & 0x7f) << shift;
      shift += 7;
      if ((b & 0x80) === 0) break;
    }
    return { n, pos };
  }

  _decodeString(data, pos) {
    const huffman = (data[pos] & 0x80) !== 0;
    const { n: len, pos: afterLen } = this._decodeInt(data, pos, 7);
    pos = afterLen;
    const raw = data.subarray(pos, pos + len);
    pos += len;
    if (huffman) {
      // We don't implement Huffman decoding here, just decode as latin1
      // (works for ASCII headers like :status)
      return { value: huffmanDecodeSimple(raw), pos };
    }
    return { value: new TextDecoder('latin1').decode(raw), pos };
  }

  decode(data) {
    const headers = [];
    let pos = 0;
    while (pos < data.length) {
      const b = data[pos];
      if (b & 0x80) {
        // Indexed header
        const { n: idx, pos: p } = this._decodeInt(data, pos, 7);
        pos = p;
        const entry = this._tableEntry(idx);
        if (entry) headers.push([entry[0], entry[1]]);
      } else if ((b & 0xc0) === 0x40) {
        // Literal with incremental indexing
        const nameIdx = b & 0x3f;
        if (nameIdx === 0) {
          pos++;
          const { value: name, pos: p1 } = this._decodeString(data, pos);
          pos = p1;
          const { value: val, pos: p2 } = this._decodeString(data, pos);
          pos = p2;
          headers.push([name, val]);
          this._addDynamic(name, val);
        } else {
          const { n: idx, pos: p } = this._decodeInt(data, pos, 6);
          pos = p;
          const entry = this._tableEntry(idx);
          const name = entry ? entry[0] : '';
          const { value: val, pos: p2 } = this._decodeString(data, pos);
          pos = p2;
          headers.push([name, val]);
          this._addDynamic(name, val);
        }
      } else if ((b & 0xf0) === 0x00 || (b & 0xf0) === 0x10) {
        // Literal without indexing or never-indexed
        const prefixBits = 4;
        const nameIdx = b & 0x0f;
        if (nameIdx === 0) {
          pos++;
          const { value: name, pos: p1 } = this._decodeString(data, pos);
          pos = p1;
          const { value: val, pos: p2 } = this._decodeString(data, pos);
          pos = p2;
          headers.push([name, val]);
        } else {
          const { n: idx, pos: p } = this._decodeInt(data, pos, prefixBits);
          pos = p;
          const entry = this._tableEntry(idx);
          const name = entry ? entry[0] : '';
          const { value: val, pos: p2 } = this._decodeString(data, pos);
          pos = p2;
          headers.push([name, val]);
        }
      } else if ((b & 0xe0) === 0x20) {
        // Dynamic table size update
        const { n: newSize, pos: p } = this._decodeInt(data, pos, 5);
        pos = p;
        this._maxSize = newSize;
        // Evict if needed
        let total = this._dynamic.reduce((s, e) => s + e[0].length + e[1].length + 32, 0);
        while (total > this._maxSize && this._dynamic.length > 0) {
          const removed = this._dynamic.pop();
          total -= removed[0].length + removed[1].length + 32;
        }
      } else {
        pos++; // unknown, skip
      }
    }
    return headers;
  }
}

// Very minimal Huffman decoder — only handles common ASCII characters
// using RFC 7541 Huffman table. This is a fallback; most GFE headers are not Huffman-encoded.
function huffmanDecodeSimple(data) {
  // Huffman table from RFC 7541 Appendix B (symbol → code, code_len)
  // We decode bit-by-bit using a lookup table
  // For simplicity, return latin1 as-is if we can't decode — headers will still work for :status
  try {
    return huffmanDecode(data);
  } catch {
    return new TextDecoder('latin1').decode(data);
  }
}

// RFC 7541 Huffman codes table (symbol, code, code_length)
// Only first 256 ASCII chars needed for response headers
const H_CODES = (() => {
  // [symbol, bits(MSB first), length]
  // Generated from RFC 7541 Appendix B
  const raw = [
    [0,0x1ff8,13],[1,0x7fffd8,23],[2,0xfffffe2,28],[3,0xfffffe3,28],[4,0xfffffe4,28],
    [5,0xfffffe5,28],[6,0xfffffe6,28],[7,0xfffffe7,28],[8,0xfffffe8,28],[9,0xffffea,24],
    [10,0x3ffffffc,30],[11,0xfffffe9,28],[12,0xfffffea,28],[13,0x3ffffffd,30],
    [14,0xfffffeb,28],[15,0xfffffec,28],[16,0xfffffed,28],[17,0xfffffee,28],
    [18,0xfffffef,28],[19,0xffffff0,28],[20,0xffffff1,28],[21,0xffffff2,28],
    [22,0x3ffffffe,30],[23,0xffffff3,28],[24,0xffffff4,28],[25,0xffffff5,28],
    [26,0xffffff6,28],[27,0xffffff7,28],[28,0xffffff8,28],[29,0xffffff9,28],
    [30,0xffffffa,28],[31,0xffffffb,28],[32,0x14,6],[33,0x3f8,10],[34,0x3f9,10],
    [35,0xffa,12],[36,0x1ff9,13],[37,0x15,6],[38,0xf8,8],[39,0x7fa,11],
    [40,0x3fa,10],[41,0x3fb,10],[42,0xf9,8],[43,0x7fb,11],[44,0xfa,8],
    [45,0x16,6],[46,0x17,6],[47,0x18,6],[48,0x0,5],[49,0x1,5],
    [50,0x2,5],[51,0x19,6],[52,0x1a,6],[53,0x1b,6],[54,0x1c,6],
    [55,0x1d,6],[56,0x1e,6],[57,0x1f,6],[58,0x5c,7],[59,0xfb,8],
    [60,0x7ffc,15],[61,0x20,6],[62,0xffb,12],[63,0x3fc,10],[64,0x1ffa,13],
    [65,0x21,6],[66,0x5d,7],[67,0x5e,7],[68,0x5f,7],[69,0x60,7],
    [70,0x61,7],[71,0x62,7],[72,0x63,7],[73,0x64,7],[74,0x65,7],
    [75,0x66,7],[76,0x67,7],[77,0x68,7],[78,0x69,7],[79,0x6a,7],
    [80,0x6b,7],[81,0x6c,7],[82,0x6d,7],[83,0x6e,7],[84,0x6f,7],
    [85,0x70,7],[86,0x71,7],[87,0x72,7],[88,0xfc,8],[89,0x73,7],
    [90,0xfd,8],[91,0x1ffb,13],[92,0x7fff0,19],[93,0x1ffc,13],[94,0x3ffc,14],
    [95,0x22,6],[96,0x7ffd,15],[97,0x3,5],[98,0x23,6],[99,0x4,5],
    [100,0x24,6],[101,0x5,5],[102,0x25,6],[103,0x26,6],[104,0x27,6],
    [105,0x6,5],[106,0x74,7],[107,0x75,7],[108,0x28,6],[109,0x29,6],
    [110,0x2a,6],[111,0x7,5],[112,0x2b,6],[113,0x76,7],[114,0x2c,6],
    [115,0x8,5],[116,0x9,5],[117,0x2d,6],[118,0x77,7],[119,0x78,7],
    [120,0x79,7],[121,0x7a,7],[122,0x7b,7],[123,0x7ffe,15],[124,0x7fc,11],
    [125,0x3ffd,14],[126,0x1ffd,13],[127,0xffffffc,28],[128,0xfffe6,20],
    [129,0x3fffd2,22],[130,0xfffe7,20],[131,0xfffe8,20],[132,0x3fffd3,22],
    [133,0x3fffd4,22],[134,0x3fffd5,22],[135,0x7fffd9,23],[136,0x3fffd6,22],
    [137,0x7fffda,23],[138,0x7fffdb,23],[139,0x7fffdc,23],[140,0x7fffdd,23],
    [141,0x7fffde,23],[142,0xffffeb,24],[143,0x7fffdf,23],[144,0xffffec,24],
    [145,0xffffed,24],[146,0x3fffd7,22],[147,0x7fffe0,23],[148,0xffffee,24],
    [149,0x7fffe1,23],[150,0x7fffe2,23],[151,0x7fffe3,23],[152,0x7fffe4,23],
    [153,0x1fffdc,21],[154,0x3fffd8,22],[155,0x7fffe5,23],[156,0x3fffd9,22],
    [157,0x7fffe6,23],[158,0x7fffe7,23],[159,0xffffef,24],[160,0x3fffda,22],
    [161,0x1fffdd,21],[162,0xfffe9,20],[163,0x3fffdb,22],[164,0x3fffdc,22],
    [165,0x7fffe8,23],[166,0x7fffe9,23],[167,0x1fffde,21],[168,0x7fffea,23],
    [169,0x3fffdd,22],[170,0x3fffde,22],[171,0xfffff0,24],[172,0x1fffdf,21],
    [173,0x3fffdf,22],[174,0x7fffeb,23],[175,0x7fffec,23],[176,0x1fffe0,21],
    [177,0x1fffe1,21],[178,0x3fffe0,22],[179,0x1fffe2,21],[180,0x7fffed,23],
    [181,0x3fffe1,22],[182,0x7fffee,23],[183,0x7fffef,23],[184,0xfffea,20],
    [185,0x3fffe2,22],[186,0x3fffe3,22],[187,0x3fffe4,22],[188,0x7ffff0,23],
    [189,0x3fffe5,22],[190,0x3fffe6,22],[191,0x7ffff1,23],[192,0x3ffffe0,26],
    [193,0x3ffffe1,26],[194,0xfffeb,20],[195,0x7fff1,19],[196,0x3fffe7,22],
    [197,0x7ffff2,23],[198,0x3fffe8,22],[199,0x1ffffec,25],[200,0x3ffffe2,26],
    [201,0x3ffffe3,26],[202,0x3ffffe4,26],[203,0x7ffffde,27],[204,0x7ffffdf,27],
    [205,0x3ffffe5,26],[206,0xfffff1,24],[207,0x1ffffed,25],[208,0x7fff2,19],
    [209,0x1fffe3,21],[210,0x3ffffe6,26],[211,0x7ffffe0,27],[212,0x7ffffe1,27],
    [213,0x3ffffe7,26],[214,0x7ffffe2,27],[215,0xfffff2,24],[216,0x1fffe4,21],
    [217,0x1fffe5,21],[218,0x3ffffe8,26],[219,0x3ffffe9,26],[220,0xffffffd,28],
    [221,0x7ffffe3,27],[222,0x7ffffe4,27],[223,0x7ffffe5,27],[224,0xfffec,20],
    [225,0xfffff3,24],[226,0xfffed,20],[227,0x1fffe6,21],[228,0x3fffe9,22],
    [229,0x1fffe7,21],[230,0x1fffe8,21],[231,0x7ffff3,23],[232,0x3fffea,22],
    [233,0x3fffeb,22],[234,0x1ffffee,25],[235,0x1ffffef,25],[236,0xfffff4,24],
    [237,0xfffff5,24],[238,0x3ffffea,26],[239,0x7ffff4,23],[240,0x3ffffeb,26],
    [241,0x7ffffe6,27],[242,0x3ffffec,26],[243,0x3ffffed,26],[244,0x7ffffe7,27],
    [245,0x7ffffe8,27],[246,0x7ffffe9,27],[247,0x7ffffeA,27],[248,0x7ffffeB,27],
    [249,0x3ffffee,26],[250,0x3ffffef,26],[251,0xfffff6,24],[252,0x7ffff5,23],
    [253,0x3fffff0,26],[254,0x7ffff6,23],[255,0x3ffffe9,26],// EOS=0x3fffffff,30
  ];
  // Build decode tree
  const tree = {};
  for (const [sym, code, len] of raw) {
    let node = tree;
    for (let i = len - 1; i >= 0; i--) {
      const bit = (code >> i) & 1;
      if (!node[bit]) node[bit] = {};
      node = node[bit];
    }
    node.sym = sym;
  }
  return tree;
})();

function huffmanDecode(data) {
  const result = [];
  let node = H_CODES;
  let bits = 0;
  let bitsLeft = 0;
  for (const byte of data) {
    bits = (bits << 8) | byte;
    bitsLeft += 8;
    while (bitsLeft > 0) {
      const bit = (bits >> (bitsLeft - 1)) & 1;
      bitsLeft--;
      node = node[bit];
      if (!node) throw new Error('huffman: invalid code');
      if ('sym' in node) {
        if (node.sym === 256) break; // EOS
        result.push(node.sym);
        node = H_CODES;
      }
    }
  }
  return String.fromCharCode(...result);
}

// ---------------------------------------------------------------------------
// Frame reader — reads exactly one HTTP/2 frame from a stream
// ---------------------------------------------------------------------------

async function readFrame(stream) {
  // Read 9-byte header
  let hdr = new Uint8Array(0);
  while (hdr.length < 9) {
    const chunk = await stream.read(9 - hdr.length);
    if (!chunk || !chunk.length) throw new Error('http2: eof reading frame header');
    const tmp = new Uint8Array(hdr.length + chunk.length);
    tmp.set(hdr);
    tmp.set(chunk, hdr.length);
    hdr = tmp;
  }
  const dv = new DataView(hdr.buffer);
  const length = (hdr[0] << 16) | (hdr[1] << 8) | hdr[2];
  const type = hdr[3];
  const flags = hdr[4];
  const streamId = dv.getUint32(5) & 0x7fffffff;

  // Read payload
  let payload = new Uint8Array(0);
  let remaining = length;
  while (remaining > 0) {
    const chunk = await stream.read(remaining);
    if (!chunk || !chunk.length) throw new Error('http2: eof reading frame payload');
    const tmp = new Uint8Array(payload.length + chunk.length);
    tmp.set(payload);
    tmp.set(chunk, payload.length);
    payload = tmp;
    remaining -= chunk.length;
  }
  return { type, flags, streamId, payload };
}

// ---------------------------------------------------------------------------
// Main HTTP/2 request function
// ---------------------------------------------------------------------------

/**
 * Sends a single HTTP/2 GET request over an already-established TLS stream
 * and returns { status, headers, body, keepAlive }.
 *
 * @param {object} tlsStream - { read, write, close, closed }
 * @param {object} opts - { method, path, host, headers, log }
 */
export async function http2Request(tlsStream, { method = 'GET', path, host, headers: extraHeaders = {}, log = () => {} }) {
  // 1. Send client preface + SETTINGS
  await tlsStream.write(PREFACE);
  // SETTINGS: HEADER_TABLE_SIZE=4096, MAX_FRAME_SIZE=16384, INITIAL_WINDOW_SIZE=65535
  await tlsStream.write(buildSettingsFrame([
    [0x1, 4096],   // HEADER_TABLE_SIZE
    [0x4, 65535],  // INITIAL_WINDOW_SIZE
    [0x5, 16384],  // MAX_FRAME_SIZE
  ]));

  // Send connection-level window update (65535 → 1MB)
  await tlsStream.write(buildWindowUpdate(0, 983041));

  const hpackDecoder = new HpackDecoder();

  // 2. Build request headers
  const reqHeaders = [
    [':method', method],
    [':path', path || '/'],
    [':scheme', 'https'],
    [':authority', host],
    ['accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'],
    ['accept-encoding', 'gzip, deflate'],
    ['accept-language', 'en-US,en;q=0.9'],
    ['user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'],
  ];
  // Append extra request headers (skip hop-by-hop)
  const skip = new Set([':method', ':path', ':scheme', ':authority', 'host', 'connection', 'proxy-connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'accept-encoding']);
  for (const [k, v] of Object.entries(extraHeaders)) {
    if (k.startsWith(':')) continue;
    if (skip.has(k.toLowerCase())) continue;
    reqHeaders.push([k.toLowerCase(), v]);
  }

  const streamId = 1;

  // 3. Send HEADERS frame (end_stream for GET since no body)
  await tlsStream.write(buildHeadersFrame(streamId, reqHeaders, true));
  log(`http2.sent ${method} ${host}${path}`);

  // 4. Read frames until we have response headers + body
  let serverSettingsDone = false;
  const bodyParts = [];
  let responseHeaders = null;
  let streamEndSeen = false;
  let headerBlockBuf = null;
  let headerBlockFlags = 0;

  const deadline = Date.now() + 30000;

  while (!streamEndSeen) {
    if (Date.now() > deadline) throw new Error('http2: response timeout');
    const frame = await readFrame(tlsStream);
    log(`http2.frame type=${frame.type} flags=${frame.flags} sid=${frame.streamId} len=${frame.payload.length}`);

    if (frame.type === FRAME_SETTINGS) {
      if (!(frame.flags & FLAG_ACK)) {
        // Server SETTINGS — ACK it
        await tlsStream.write(buildSettingsAck());
        serverSettingsDone = true;
        // Also parse server settings for dynamic table size
        const dv = new DataView(frame.payload.buffer, frame.payload.byteOffset);
        for (let i = 0; i + 6 <= frame.payload.length; i += 6) {
          const id = dv.getUint16(i);
          const val = dv.getUint32(i + 2);
          if (id === 0x1) hpackDecoder._maxSize = val; // HEADER_TABLE_SIZE
        }
      }
      if (!serverSettingsDone) serverSettingsDone = true;
      continue;
    }

    if (frame.type === FRAME_WINDOW_UPDATE) {
      // Ignore — we don't track flow control for a single request
      continue;
    }

    if (frame.type === FRAME_PING) {
      if (!(frame.flags & FLAG_ACK)) {
        // PING — reply with ACK
        await tlsStream.write(buildFrame(FRAME_PING, FLAG_ACK, 0, frame.payload));
      }
      continue;
    }

    if (frame.type === FRAME_GOAWAY) {
      throw new Error('http2: server sent GOAWAY');
    }

    if (frame.type === FRAME_RST_STREAM && frame.streamId === streamId) {
      const code = frame.payload.length >= 4 ? new DataView(frame.payload.buffer, frame.payload.byteOffset).getUint32(0) : 0;
      throw new Error(`http2: stream reset code=${code}`);
    }

    if (frame.streamId !== streamId && frame.streamId !== 0) {
      // Frames from other streams (e.g. server push) — ignore
      continue;
    }

    if (frame.type === FRAME_HEADERS || frame.type === FRAME_CONTINUATION) {
      let headerPayload = frame.payload;
      // Strip PADDED
      let padLen = 0;
      let payloadOffset = 0;
      if (frame.type === FRAME_HEADERS && (frame.flags & FLAG_PADDED)) {
        padLen = headerPayload[0];
        payloadOffset = 1;
      }
      // Strip PRIORITY
      if (frame.type === FRAME_HEADERS && (frame.flags & FLAG_PRIORITY)) {
        payloadOffset += 5;
      }
      const headerData = headerPayload.subarray(payloadOffset, headerPayload.length - padLen);

      if (headerBlockBuf === null) {
        headerBlockBuf = headerData;
        headerBlockFlags = frame.flags;
      } else {
        const merged = new Uint8Array(headerBlockBuf.length + headerData.length);
        merged.set(headerBlockBuf);
        merged.set(headerData, headerBlockBuf.length);
        headerBlockBuf = merged;
        headerBlockFlags |= frame.flags;
      }

      if (frame.flags & FLAG_END_HEADERS) {
        // Decode HPACK
        const decoded = hpackDecoder.decode(headerBlockBuf);
        headerBlockBuf = null;
        const statusEntry = decoded.find(([n]) => n === ':status');
        const status = statusEntry ? Number(statusEntry[1]) : 200;
        const responseHdrs = decoded
          .filter(([n]) => !n.startsWith(':'))
          .map(([n, v]) => ({ name: n, value: v }));
        responseHeaders = { status, headers: responseHdrs };
        log(`http2.headers status=${status} n=${responseHdrs.length}`);
      }

      if (headerBlockFlags & FLAG_END_STREAM) {
        streamEndSeen = true;
      }
      continue;
    }

    if (frame.type === FRAME_DATA && frame.streamId === streamId) {
      // Strip padding
      let data = frame.payload;
      if (frame.flags & FLAG_PADDED && data.length > 0) {
        const padLen = data[0];
        data = data.subarray(1, data.length - padLen);
      }
      if (data.length > 0) {
        bodyParts.push(data);
        // Send WINDOW_UPDATE to keep the server sending
        await tlsStream.write(buildWindowUpdate(streamId, data.length));
        await tlsStream.write(buildWindowUpdate(0, data.length));
        log(`http2.data n=${data.length}`);
      }
      if (frame.flags & FLAG_END_STREAM) {
        streamEndSeen = true;
      }
      continue;
    }
  }

  if (!responseHeaders) throw new Error('http2: no response headers received');

  // Assemble body
  let totalLen = bodyParts.reduce((s, p) => s + p.length, 0);
  const body = new Uint8Array(totalLen);
  let offset = 0;
  for (const part of bodyParts) {
    body.set(part, offset);
    offset += part.length;
  }

  log(`http2.done status=${responseHeaders.status} body=${body.length}`);

  return {
    status: responseHeaders.status,
    statusText: '',
    headers: responseHeaders.headers,
    body,
    keepAlive: false, // h2 connections not pooled (single-request use for now)
    leftover: new Uint8Array(0),
  };
}

/**
 * Returns true if the hostname needs h2 ALPN (Google Frontend domains).
 */
export function isH2RequiredHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return (
    h === 'www.google.com' ||
    h === 'google.com' ||
    h.endsWith('.google.com') ||
    h === 'www.youtube.com' ||
    h.endsWith('.youtube.com') ||
    h.endsWith('.googleapis.com') ||
    h.endsWith('.gstatic.com') ||
    h.endsWith('.ggpht.com') ||
    h.endsWith('.googlevideo.com')
  );
}

