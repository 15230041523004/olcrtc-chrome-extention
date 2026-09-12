// Independent reference for Go hash/crc32.Castagnoli wire semantics.
// Uses the normal polynomial and reflected input/output, unlike the extension's
// reflected lookup table. No production CRC helpers are imported here.
function reflect(value, bits) {
  let out = 0;
  for (let i = 0; i < bits; i++) {
    out = (out << 1) | (value & 1);
    value >>>= 1;
  }
  return out >>> 0;
}

export function nativeCrc32c(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= reflect(byte, 8) << 24;
    for (let i = 0; i < 8; i++) crc = (crc << 1) ^ (crc & 0x80000000 ? 0x1edc6f41 : 0);
  }
  return (~reflect(crc, 32)) >>> 0;
}

export function nativeSealKcp(packet) {
  const wire = new Uint8Array(packet.length + 4);
  wire.set(packet);
  new DataView(wire.buffer).setUint32(packet.length, nativeCrc32c(packet));
  return wire;
}

export function nativeOpenKcp(wire) {
  if (wire.length < 4) return null;
  const body = wire.subarray(0, wire.length - 4);
  const trailer = new DataView(wire.buffer, wire.byteOffset).getUint32(body.length);
  return nativeCrc32c(body) === trailer ? body : null;
}
