import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32Ieee, crc32Castagnoli, appendKcpChecksum, stripKcpChecksum } from '../extension/lib/vp8-wire.js';
import { nativeCrc32c, nativeOpenKcp, nativeSealKcp } from './helpers/native-wire.js';

test('CRC32C matches Go golden vectors and remains distinct from the header CRC', () => {
  // Castagnoli values from https://go.dev/src/hash/crc32/crc32_test.go
  const vectors = [
    ['', 0], ['a', 0xc1d04330], ['ab', 0xe2a22936], ['abc', 0x364b3fb7],
    ['abcd', 0x92c80a31], ['abcde', 0xc450d697], ['abcdef', 0x53bceff1],
    ['abcdefg', 0xe627f441], ['abcdefgh', 0x0a9421b7], ['abcdefghi', 0x2ddc99fc],
    ['abcdefghij', 0xe6599437], ['01234567'.repeat(1024), 0x8a11661f],
    ['a'.repeat(1089), 0x5a6f5c45], ['123456789', 0xe3069283],
  ];
  for (const [text, expected] of vectors) {
    const bytes = new TextEncoder().encode(text);
    assert.equal(crc32Castagnoli(bytes), expected);
    assert.equal(nativeCrc32c(bytes), expected);
  }
  assert.equal(crc32Ieee(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('a KCP ACK carries a big-endian CRC32C trailer and both receivers strip it', () => {
  const packet = Buffer.from('01eeffc05200001000000000000000000000000000000000', 'hex');
  const wire = appendKcpChecksum(packet);
  assert.equal(Buffer.from(wire.subarray(-4)).toString('hex'), '1b928667');
  assert.deepEqual(nativeOpenKcp(wire), new Uint8Array(packet));
  // A nonzero byteOffset is common when splitting an OLKB batch.
  const carrier = new Uint8Array(5 + wire.length);
  carrier.set(nativeSealKcp(packet), 5);
  assert.deepEqual(stripKcpChecksum(carrier.subarray(5)), new Uint8Array(packet));
});

test('missing, corrupt, little-endian and IEEE trailers are rejected', () => {
  const packet = new Uint8Array(24).fill(0x51);
  for (const open of [stripKcpChecksum, nativeOpenKcp]) {
    assert.equal(open(packet), null, 'old extension wire format');
    assert.equal(open(new Uint8Array(3)), null);
    const wire = appendKcpChecksum(packet);
    const damaged = wire.slice();
    damaged[7] ^= 1;
    assert.equal(open(damaged), null);
    const wrongEndian = wire.slice();
    wrongEndian.set(wire.slice(-4).reverse(), packet.length);
    assert.equal(open(wrongEndian), null);
    const wrongPolynomial = wire.slice();
    new DataView(wrongPolynomial.buffer).setUint32(packet.length, crc32Ieee(packet));
    assert.equal(open(wrongPolynomial), null);
  }
});
