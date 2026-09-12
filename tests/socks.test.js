import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeTunnelConnect, encodeSocks5Connect, CONNECT_ACK_OK } from '../extension/lib/socks.js';

test('tunnel connect JSON matches native ConnectRequest', () => {
  const s = new TextDecoder().decode(encodeTunnelConnect('example.com', 80));
  assert.deepEqual(JSON.parse(s), { cmd: 'connect', addr: 'example.com', port: 80 });
});

test('SOCKS5 CONNECT domain encoding', () => {
  const u8 = encodeSocks5Connect('example.com', 80);
  assert.equal(u8[0], 5);
  assert.equal(u8[1], 1);
  assert.equal(u8[3], 3);
  assert.equal(u8[4], 11);
  assert.equal(new TextDecoder().decode(u8.subarray(5, 16)), 'example.com');
  assert.equal((u8[16] << 8) | u8[17], 80);
});

test('ACK ok is SOCKS REP success byte', () => {
  assert.equal(CONNECT_ACK_OK, 0);
});
