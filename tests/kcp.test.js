import test from 'node:test';
import assert from 'node:assert/strict';
import { KcpStream, KCP_CONV } from '../extension/lib/kcp.js';

test('a wire ACK advances sndUna and removes the outstanding send', () => {
  const packets = [];
  const stream = new KcpStream(KCP_CONV, (bytes) => packets.push(bytes));
  stream.send(new Uint8Array([1, 2, 3]));
  assert.equal(stream.kcp.sndBuf.length, 1);
  // conv=C0FFEE01, ACK=82, wnd=4096, ts/sn/una/len=0 (little endian).
  const ack = Buffer.from('01eeffc05200001000000000000000000000000000000000', 'hex');
  assert.equal(stream.input(ack), 0);
  assert.equal(stream.kcp.sndBuf.length, 0);
  assert.equal(stream.kcp.sndUna, 1);
  stream.kcp.flush();
  assert.equal(packets.length, 1, 'acknowledged packet is not retransmitted');
});

test('KCP reports invalid input instead of treating it as accepted', () => {
  const stream = new KcpStream(KCP_CONV, () => {});
  assert.equal(stream.input(new Uint8Array(3)), -1);
  const invalid = Buffer.from('01eeffc0ff00001000000000000000000000000000000000', 'hex');
  assert.equal(stream.input(invalid), -3);
});
