import test from 'node:test';
import assert from 'node:assert/strict';
import { SmuxClient } from '../extension/lib/smux.js';

function mockConn() {
  const written = [];
  return {
    written,
    write(buf) {
      written.push(new Uint8Array(buf));
    },
    onData: null,
  };
}

test('openStream increments stream ID and stores in streams map', () => {
  const conn = mockConn();
  const client = new SmuxClient(conn);
  const s1 = client.openStream();
  assert.equal(s1.sid, 3);
  assert.equal(client.streams.get(3), s1);
  assert.equal(conn.written.length, 1);
  assert.equal(conn.written[0][1], 0); // CMD_SYN

  const s2 = client.openStream();
  assert.equal(s2.sid, 5);
  assert.equal(client.streams.get(5), s2);
});

test('stream.close sends CMD_FIN, deletes from streams, and wakes pending reader with EOF', async () => {
  const conn = mockConn();
  const client = new SmuxClient(conn);
  const s = client.openStream();
  assert.equal(client.streams.size, 1);

  let readDone = false;
  let readResult = null;
  s.read(10).then((res) => {
    readDone = true;
    readResult = res;
  });

  await new Promise((r) => setTimeout(r, 10));
  assert.equal(readDone, false);

  s.close();

  await new Promise((r) => setTimeout(r, 10));
  assert.equal(readDone, true);
  assert.equal(readResult.length, 0);
  assert.equal(s.eof, true);
  assert.equal(s.closed, true);
  assert.equal(client.streams.has(s.sid), false);
  assert.equal(client.streams.size, 0);

  // Subsequent close is idempotent
  s.close();
  // Write after close throws
  assert.throws(() => s.write(new Uint8Array([1, 2, 3])), /closed/);
});

test('client.closeAll closes every open stream and clears the map', async () => {
  const conn = mockConn();
  const client = new SmuxClient(conn);
  const s1 = client.openStream();
  const s2 = client.openStream();
  assert.equal(client.streams.size, 2);

  client.closeAll();
  assert.equal(client.streams.size, 0);
  assert.equal(s1.closed, true);
  assert.equal(s2.closed, true);
});

test('inbound CMD_FIN sets EOF, wakes readers and removes stream from map', async () => {
  const conn = mockConn();
  const client = new SmuxClient(conn);
  const s = client.openStream();

  let readDone = false;
  let readResult = null;
  s.read(10).then((res) => {
    readDone = true;
    readResult = res;
  });

  // Construct CMD_FIN frame: ver=2, cmd=1, len=0, sid=3
  const fin = new Uint8Array(8);
  fin[0] = 2;
  fin[1] = 1;
  new DataView(fin.buffer).setUint16(2, 0, true);
  new DataView(fin.buffer).setUint32(4, 3, true);

  conn.onData(fin);

  await new Promise((r) => setTimeout(r, 10));
  assert.equal(readDone, true);
  assert.equal(readResult.length, 0);
  assert.equal(s.eof, true);
  assert.equal(s.closed, true);
  assert.equal(client.streams.has(3), false);
});

test('inbound CMD_PSH advances cumulative numRead and sends CMD_UPD with cumulative consumed', () => {
  const conn = mockConn();
  const client = new SmuxClient(conn);
  const s = client.openStream(); // sid = 3
  conn.written.length = 0; // Clear SYN

  function makePsh(sid, len) {
    const frame = new Uint8Array(8 + len);
    frame[0] = 2; // version
    frame[1] = 2; // CMD_PSH
    new DataView(frame.buffer).setUint16(2, len, true);
    new DataView(frame.buffer).setUint32(4, sid, true);
    return frame;
  }

  // 1. First frame (1000 bytes): should trigger immediate CMD_UPD because numRead === body.length
  conn.onData(makePsh(3, 1000));
  assert.equal(s.numRead, 1000);
  assert.equal(conn.written.length, 1);
  const upd1 = conn.written[0];
  assert.equal(upd1[1], 4); // CMD_UPD
  const v1 = new DataView(upd1.buffer, 8);
  assert.equal(v1.getUint32(0, true), 1000, 'consumed must be 1000');
  assert.equal(v1.getUint32(4, true), 4 * 1024 * 1024, 'window must be 4MB');

  // 2. Second frame (2000 bytes): total 3000 bytes, incr 2000 < 256KB -> no update yet
  conn.onData(makePsh(3, 2000));
  assert.equal(s.numRead, 3000);
  assert.equal(conn.written.length, 1);

  // 3. Send frames crossing 256KB: 9 frames of 30,000 bytes (+270,000 bytes) -> total incr = 272,000 >= 256KB
  for (let i = 0; i < 9; i++) {
    conn.onData(makePsh(3, 30000));
  }
  assert.equal(s.numRead, 273000);
  assert.equal(conn.written.length, 2);
  const upd2 = conn.written[1];
  assert.equal(upd2[1], 4); // CMD_UPD
  const v2 = new DataView(upd2.buffer, 8);
  assert.equal(v2.getUint32(0, true), 273000, 'consumed must be cumulative 273000');
  assert.equal(v2.getUint32(4, true), 4 * 1024 * 1024);

  // 4. Another large chunk crossing 256KB: send 10 frames of 30,000 bytes (+300,000 bytes)
  for (let i = 0; i < 10; i++) {
    conn.onData(makePsh(3, 30000));
  }
  assert.equal(s.numRead, 573000);
  assert.equal(conn.written.length, 3);
  const lastUpd = conn.written[conn.written.length - 1];
  assert.equal(lastUpd[1], 4); // CMD_UPD
  const vLast = new DataView(lastUpd.buffer, 8);
  assert.equal(vLast.getUint32(0, true), 543000, 'consumed must be cumulative 543000');
  assert.equal(vLast.getUint32(4, true), 4 * 1024 * 1024);
});

test('inbound CMD_UPD updates peerConsumed and peerWindow on stream', () => {
  const conn = mockConn();
  const client = new SmuxClient(conn);
  const s = client.openStream(); // sid = 3

  const updFrame = new Uint8Array(8 + 8);
  updFrame[0] = 2; // version
  updFrame[1] = 4; // CMD_UPD
  new DataView(updFrame.buffer).setUint16(2, 8, true);
  new DataView(updFrame.buffer).setUint32(4, 3, true);
  new DataView(updFrame.buffer).setUint32(8, 65536, true); // consumed
  new DataView(updFrame.buffer).setUint32(12, 1048576, true); // window (1MB)

  conn.onData(updFrame);
  assert.equal(s.peerConsumed, 65536);
  assert.equal(s.peerWindow, 1048576);
});


