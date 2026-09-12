/** vp8channel sample layout. Stage 1 uses keepalive + marker; Stage 2 fills KCP. */

export const VP8_KEEPALIVE = new Uint8Array([
  0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, 0x10, 0x00,
  0x10, 0x00, 0x00, 0x47, 0x08, 0x85, 0x85, 0x88,
  0x99, 0x84, 0x88, 0xfc,
]);

export const MARKER_ASCII = new Uint8Array([0x4f, 0x4c, 0x43, 0x31]); // OLC1
export const KCP_BATCH_MAGIC = new Uint8Array([0x4f, 0x4c, 0x4b, 0x42]); // OLKB

export const TOKEN_OFF = 20;
export const SRC_OFF = 24;
export const DST_OFF = 28;
export const CRC_OFF = 32;
export const EPOCH_HDR_LEN = 36;
export const CONTROL_EPOCH_FLAG = 0x80000000;
export const KCP_WIRE_CRC_LEN = 4;

// Native kcpConn uses CRC32C (Castagnoli) for each KCP datagram. The epoch
// header above still uses CRC32-IEEE; these are separate checksums.
const CRC32C_TABLE = Uint32Array.from({ length: 256 }, (_, byte) => {
  let crc = byte;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0x82f63b78 : 0);
  return crc >>> 0;
});

const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;

/** FNV-1a 32-bit. Matches internal/transport/common/binding.go. */
export function bindingToken(channelId, roomUrl) {
  const source = channelId || roomUrl || '';
  let hash = FNV_OFFSET;
  const bytes = new TextEncoder().encode(source);
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash === 0 ? 1 : hash;
}

/** IEEE CRC-32 (ISO 3309). Vector: CRC32("123456789") = 0xCBF43926. */
export function crc32Ieee(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let b = 0; b < 8; b++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** CRC32C("123456789") = 0xE3069283. Matches Go crc32.Castagnoli. */
export function crc32Castagnoli(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC32C_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

export function appendKcpChecksum(packet) {
  const out = new Uint8Array(packet.length + KCP_WIRE_CRC_LEN);
  out.set(packet);
  new DataView(out.buffer).setUint32(packet.length, crc32Castagnoli(packet));
  return out;
}

/** Verify and strip the big-endian CRC32C trailer before feeding KCP. */
export function stripKcpChecksum(wire) {
  if (wire.length < KCP_WIRE_CRC_LEN) return null;
  const body = wire.subarray(0, wire.length - KCP_WIRE_CRC_LEN);
  const expected = new DataView(wire.buffer, wire.byteOffset, wire.byteLength).getUint32(body.length);
  return crc32Castagnoli(body) === expected ? body : null;
}

export function epochCrc(token, src, dst) {
  const buf = new Uint8Array(12);
  const view = new DataView(buf.buffer);
  view.setUint32(0, token >>> 0);
  view.setUint32(4, src >>> 0);
  view.setUint32(8, dst >>> 0);
  return crc32Ieee(buf);
}

export function buildEpochHeader(token, src, dst = 0) {
  const hdr = new Uint8Array(EPOCH_HDR_LEN);
  hdr.set(VP8_KEEPALIVE, 0);
  const view = new DataView(hdr.buffer);
  view.setUint32(TOKEN_OFF, token >>> 0);
  view.setUint32(SRC_OFF, src >>> 0);
  view.setUint32(DST_OFF, dst >>> 0);
  view.setUint32(CRC_OFF, epochCrc(token, src, dst));
  return hdr;
}

export function parseEpochHeader(frame) {
  const u8 = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
  if (u8.byteLength < EPOCH_HDR_LEN) {
    return null;
  }
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const token = view.getUint32(TOKEN_OFF);
  const src = view.getUint32(SRC_OFF);
  const dst = view.getUint32(DST_OFF);
  const crc = view.getUint32(CRC_OFF);
  const ok = crc === epochCrc(token, src, dst);
  return { token, src, dst, crc, ok, payload: u8.subarray(EPOCH_HDR_LEN) };
}

export function peekDst(frame) {
  const u8 = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
  if (u8.byteLength < EPOCH_HDR_LEN) return null;
  return new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getUint32(DST_OFF);
}

/** Split OLKB into wire packets, each still carrying its CRC32C trailer. */
export function splitKCPPayload(payload) {
  const u8 = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  if (u8.byteLength < 4) {
    return u8.byteLength ? [u8] : [];
  }
  if (!(u8[0] === 0x4f && u8[1] === 0x4c && u8[2] === 0x4b && u8[3] === 0x42)) {
    return [u8];
  }
  const out = [];
  let i = 4;
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  while (i + 2 <= u8.byteLength) {
    const size = view.getUint16(i);
    i += 2;
    if (size === 0 || i + size > u8.byteLength) break;
    out.push(u8.subarray(i, i + size));
    i += size;
  }
  return out;
}

export function appendBatchPacket(dst, packet) {
  if (packet.length > 0xffff) return dst;
  const next = new Uint8Array(dst.length + 2 + packet.length);
  next.set(dst, 0);
  next[dst.length] = (packet.length >>> 8) & 0xff;
  next[dst.length + 1] = packet.length & 0xff;
  next.set(packet, dst.length + 2);
  return next;
}

export function hexU32(n) {
  return `0x${(n >>> 0).toString(16).padStart(8, '0')}`;
}

export function hexPrefix(buffer, n = 36) {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const len = Math.min(n, u8.byteLength);
  const parts = new Array(len);
  for (let i = 0; i < len; i++) {
    parts[i] = u8[i].toString(16).padStart(2, '0');
  }
  return parts.join(' ');
}

export function keepaliveBuffer() {
  return VP8_KEEPALIVE.buffer.slice(
    VP8_KEEPALIVE.byteOffset,
    VP8_KEEPALIVE.byteOffset + VP8_KEEPALIVE.byteLength,
  );
}

/** Stage 1 marker sample: keepalive + "OLC1" + original length (u32 BE). */
export function markerSample(originalLength) {
  const out = new Uint8Array(VP8_KEEPALIVE.length + MARKER_ASCII.length + 4);
  out.set(VP8_KEEPALIVE, 0);
  out.set(MARKER_ASCII, VP8_KEEPALIVE.length);
  new DataView(out.buffer).setUint32(VP8_KEEPALIVE.length + MARKER_ASCII.length, originalLength >>> 0);
  return out.buffer;
}
