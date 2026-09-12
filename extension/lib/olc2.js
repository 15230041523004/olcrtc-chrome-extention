/**
 * OLC2 record layer: HKDF-SHA256 + XChaCha20-Poly1305.
 * Matches golang.org/x/crypto chacha20poly1305 + olcrtc/internal/crypto.
 */

const MAGIC = new TextEncoder().encode('OLC2');
const NONCE_PREFIX = 16; // XChaCha nonce 24 - counter 8
const HEADER = 4 + 8 + NONCE_PREFIX; // 28
const TAG = 16;
export const WIRE_OVERHEAD = HEADER + TAG;
export const AAD_DATA = new TextEncoder().encode('olcrtc/muxconn/v2/data');
export const AAD_CONTROL = new TextEncoder().encode('olcrtc/muxconn/v2/control');
const C2S = 'olcrtc/v2/client-to-server';
const S2C = 'olcrtc/v2/server-to-client';
const REPLAY_WINDOW = 64;
const MAX_SENDERS = 256;

const SIGMA = new Uint32Array([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]);

function rotl(v, n) {
  return (v << n) | (v >>> (32 - n));
}

function u8ToU32LE(u8, off) {
  return u8[off] | (u8[off + 1] << 8) | (u8[off + 2] << 16) | (u8[off + 3] << 24);
}

function u32ToU8LE(out, off, v) {
  out[off] = v & 0xff;
  out[off + 1] = (v >>> 8) & 0xff;
  out[off + 2] = (v >>> 16) & 0xff;
  out[off + 3] = (v >>> 24) & 0xff;
}

function quarter(s, a, b, c, d) {
  s[a] = (s[a] + s[b]) | 0;
  s[d] = rotl(s[d] ^ s[a], 16);
  s[c] = (s[c] + s[d]) | 0;
  s[b] = rotl(s[b] ^ s[c], 12);
  s[a] = (s[a] + s[b]) | 0;
  s[d] = rotl(s[d] ^ s[a], 8);
  s[c] = (s[c] + s[d]) | 0;
  s[b] = rotl(s[b] ^ s[c], 7);
}

function chachaBlock(keyU32, counter, nonceU32, outU8) {
  const s = new Uint32Array(16);
  s.set(SIGMA, 0);
  s.set(keyU32, 4);
  s[12] = counter;
  s[13] = nonceU32[0];
  s[14] = nonceU32[1];
  s[15] = nonceU32[2];
  const x = new Uint32Array(s);
  for (let i = 0; i < 10; i++) {
    quarter(x, 0, 4, 8, 12);
    quarter(x, 1, 5, 9, 13);
    quarter(x, 2, 6, 10, 14);
    quarter(x, 3, 7, 11, 15);
    quarter(x, 0, 5, 10, 15);
    quarter(x, 1, 6, 11, 12);
    quarter(x, 2, 7, 8, 13);
    quarter(x, 3, 4, 9, 14);
  }
  for (let i = 0; i < 16; i++) u32ToU8LE(outU8, i * 4, (x[i] + s[i]) | 0);
}

function keyToU32(key) {
  const k = new Uint32Array(8);
  for (let i = 0; i < 8; i++) k[i] = u8ToU32LE(key, i * 4);
  return k;
}

function hchacha20(key, nonce16) {
  const s = new Uint32Array(16);
  const k = keyToU32(key);
  s.set(SIGMA, 0);
  s.set(k, 4);
  for (let i = 0; i < 4; i++) s[12 + i] = u8ToU32LE(nonce16, i * 4);
  for (let r = 0; r < 10; r++) {
    quarter(s, 0, 4, 8, 12);
    quarter(s, 1, 5, 9, 13);
    quarter(s, 2, 6, 10, 14);
    quarter(s, 3, 7, 11, 15);
    quarter(s, 0, 5, 10, 15);
    quarter(s, 1, 6, 11, 12);
    quarter(s, 2, 7, 8, 13);
    quarter(s, 3, 4, 9, 14);
  }
  const out = new Uint8Array(32);
  u32ToU8LE(out, 0, s[0]);
  u32ToU8LE(out, 4, s[1]);
  u32ToU8LE(out, 8, s[2]);
  u32ToU8LE(out, 12, s[3]);
  u32ToU8LE(out, 16, s[12]);
  u32ToU8LE(out, 20, s[13]);
  u32ToU8LE(out, 24, s[14]);
  u32ToU8LE(out, 28, s[15]);
  return out;
}

function chacha20Xor(key, nonce12, counter, data) {
  const k = keyToU32(key);
  const n = new Uint32Array([u8ToU32LE(nonce12, 0), u8ToU32LE(nonce12, 4), u8ToU32LE(nonce12, 8)]);
  const block = new Uint8Array(64);
  const out = new Uint8Array(data.length);
  let off = 0;
  let ctr = counter >>> 0;
  while (off < data.length) {
    chachaBlock(k, ctr, n, block);
    ctr = (ctr + 1) >>> 0;
    const ncopy = Math.min(64, data.length - off);
    for (let i = 0; i < ncopy; i++) out[off + i] = data[off + i] ^ block[i];
    off += ncopy;
  }
  return out;
}

const P1305 = (1n << 130n) - 5n;

function leBytesToBig(u8) {
  let n = 0n;
  for (let i = u8.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(u8[i]);
  return n;
}

function poly1305(key, msg) {
  const r = leBytesToBig(key.subarray(0, 16)) & 0x0ffffffc0ffffffc0ffffffc0fffffffn;
  const s = leBytesToBig(key.subarray(16, 32));
  let acc = 0n;
  for (let i = 0; i < msg.length; i += 16) {
    const chunk = msg.subarray(i, Math.min(i + 16, msg.length));
    const block = new Uint8Array(chunk.length + 1);
    block.set(chunk);
    block[chunk.length] = 1;
    acc = (acc + leBytesToBig(block)) * r % P1305;
  }
  acc = (acc + s) & ((1n << 128n) - 1n);
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = Number(acc & 0xffn);
    acc >>= 8n;
  }
  return out;
}

function pad16(len) {
  const rem = len % 16;
  return rem === 0 ? 0 : 16 - rem;
}

function polyAad(aad, ciphertext) {
  const aLen = aad ? aad.length : 0;
  const cLen = ciphertext.length;
  const total = aLen + pad16(aLen) + cLen + pad16(cLen) + 16;
  const buf = new Uint8Array(total);
  let o = 0;
  if (aad && aLen) {
    buf.set(aad, 0);
    o += aLen + pad16(aLen);
  } else {
    o += pad16(aLen);
  }
  buf.set(ciphertext, o);
  o += cLen + pad16(cLen);
  const view = new DataView(buf.buffer);
  view.setUint32(o, aLen, true);
  view.setUint32(o + 8, cLen, true);
  return buf;
}

function xchacha20poly1305Seal(key, nonce24, plaintext, aad) {
  const subKey = hchacha20(key, nonce24.subarray(0, 16));
  const nonce12 = new Uint8Array(12);
  nonce12.set(nonce24.subarray(16, 24), 4);
  const otk = chacha20Xor(subKey, nonce12, 0, new Uint8Array(32));
  const ct = chacha20Xor(subKey, nonce12, 1, plaintext);
  const tag = poly1305(otk, polyAad(aad, ct));
  const out = new Uint8Array(ct.length + 16);
  out.set(ct, 0);
  out.set(tag, ct.length);
  return out;
}

function xchacha20poly1305Open(key, nonce24, record, aad) {
  if (record.length < 16) throw new Error('olc2: record too short');
  const subKey = hchacha20(key, nonce24.subarray(0, 16));
  const nonce12 = new Uint8Array(12);
  nonce12.set(nonce24.subarray(16, 24), 4);
  const ct = record.subarray(0, record.length - 16);
  const tag = record.subarray(record.length - 16);
  const otk = chacha20Xor(subKey, nonce12, 0, new Uint8Array(32));
  const expect = poly1305(otk, polyAad(aad, ct));
  let diff = 0;
  for (let i = 0; i < 16; i++) diff |= tag[i] ^ expect[i];
  if (diff !== 0) throw new Error('olc2: authentication failed');
  return chacha20Xor(subKey, nonce12, 1, ct);
}

async function hkdfSha256(ikm, info) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(32),
      info: new TextEncoder().encode(info),
    },
    key,
    256,
  );
  return new Uint8Array(bits);
}

export async function newKeySet(psk, role) {
  if (psk.length !== 32) throw new Error('olc2: PSK must be 32 bytes');
  const c2s = await hkdfSha256(psk, C2S);
  const s2c = await hkdfSha256(psk, S2C);
  const send = role === 'server' ? s2c : c2s;
  const recv = role === 'server' ? c2s : s2c;
  const prefix = crypto.getRandomValues(new Uint8Array(NONCE_PREFIX));
  return new KeySet(send, recv, prefix);
}

class KeySet {
  constructor(sendKey, recvKey, prefix) {
    this.sendKey = sendKey;
    this.recvKey = recvKey;
    this.prefix = prefix;
    this.counter = 0n;
    this.senders = new Map();
    this.lru = [];
  }

  seal(plaintext, aad) {
    this.counter += 1n;
    if (this.counter === 0n) throw new Error('olc2: counter wrap');
    const nonce = new Uint8Array(24);
    nonce.set(this.prefix, 0);
    const view = new DataView(nonce.buffer);
    view.setBigUint64(16, this.counter, false);
    const sealed = xchacha20poly1305Seal(this.sendKey, nonce, plaintext, aad);
    const out = new Uint8Array(HEADER + sealed.length);
    out.set(MAGIC, 0);
    new DataView(out.buffer).setBigUint64(4, this.counter, false);
    out.set(this.prefix, 12);
    out.set(sealed, HEADER);
    return out;
  }

  open(record, aad) {
    if (record.length < WIRE_OVERHEAD) throw new Error('olc2: record too short');
    if (record[0] !== 0x4f || record[1] !== 0x4c || record[2] !== 0x43 || record[3] !== 0x32) {
      throw new Error('olc2: bad magic');
    }
    const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
    const counter = view.getBigUint64(4, false);
    if (counter === 0n) throw new Error('olc2: counter 0');
    const prefix = record.subarray(12, 12 + NONCE_PREFIX);
    const nonce = new Uint8Array(24);
    nonce.set(prefix, 0);
    new DataView(nonce.buffer).setBigUint64(16, counter, false);
    const pt = xchacha20poly1305Open(this.recvKey, nonce, record.subarray(HEADER), aad);
    this.acceptReplay(prefix, counter);
    return pt;
  }

  acceptReplay(prefix, counter) {
    const key = String.fromCharCode(...prefix);
    let st = this.senders.get(key);
    if (!st) {
      if (this.lru.length >= MAX_SENDERS) {
        const old = this.lru.shift();
        this.senders.delete(old);
      }
      this.senders.set(key, { highest: counter, seen: 1n });
      this.lru.push(key);
      return;
    }
    this.lru.splice(this.lru.indexOf(key), 1);
    this.lru.push(key);
    if (counter > st.highest) {
      const shift = counter - st.highest;
      st.seen = shift >= BigInt(REPLAY_WINDOW) ? 1n : ((st.seen << shift) | 1n);
      st.highest = counter;
      return;
    }
    const age = st.highest - counter;
    if (age >= BigInt(REPLAY_WINDOW)) throw new Error('olc2: replay too old');
    const mask = 1n << age;
    if (st.seen & mask) throw new Error('olc2: replay duplicate');
    st.seen |= mask;
  }
}

export function hexToBytes(hex) {
  const h = hex.replace(/\s+/g, '');
  if (h.length !== 64) throw new Error('olc2: key must be 64 hex chars');
  const u8 = new Uint8Array(32);
  for (let i = 0; i < 32; i++) u8[i] = parseInt(h.substr(i * 2, 2), 16);
  return u8;
}
