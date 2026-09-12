import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Tunnel } from '../extension/lib/tunnel.js';
import { KcpStream, KCP_CONV } from '../extension/lib/kcp.js';
import { newKeySet, AAD_CONTROL } from '../extension/lib/olc2.js';
import { buildEpochHeader, parseEpochHeader, splitKCPPayload } from '../extension/lib/vp8-wire.js';
import { nativeSealKcp, nativeOpenKcp } from './helpers/native-wire.js';

// Local protocol peer: real extension KCP/OLC2, independent smux/JSON framing.
// This exercises the extension stack; it does not substitute for native srv/Telemost.
test('HELLO/WELCOME and two ping/pong exchanges survive loss, duplication and other clients', { timeout: 18_000 }, async (t) => {
  const logs = [];
  const flags = [];
  const tunnel = new Tunnel((line) => logs.push(line));
  tunnel.onFlag = (event) => flags.push(event);
  t.after(() => tunnel.stop());
  const psk = new Uint8Array(32).fill(0x17); // synthetic test key
  await tunnel.start({ keyHex: Buffer.from(psk).toString('hex'), roomId: 'local-test', deviceId: 'chrome-test' });
  tunnel.localEpoch = 0x76911886;
  const serverKeys = await newKeySet(psk, 'server');
  const serverOut = [];
  const server = new KcpStream(KCP_CONV, (bytes) => serverOut.push(bytes));
  let applicationBytes = Buffer.alloc(0);
  let smuxBytes = Buffer.alloc(0);
  let streamId = null;
  let helloCount = 0;
  let pingCount = 0;
  const reply = (message) => {
    const json = Buffer.from(JSON.stringify(message));
    const plain = Buffer.alloc(8 + 4 + json.length);
    plain[0] = 2;
    plain[1] = 2;
    plain.writeUInt16LE(4 + json.length, 2);
    plain.writeUInt32LE(streamId, 4);
    plain.writeUInt32BE(json.length, 8);
    plain.set(json, 12);
    server.send(serverKeys.seal(plain, AAD_CONTROL));
  };
  server.onMessage = (record) => {
    smuxBytes = Buffer.concat([smuxBytes, serverKeys.open(record, AAD_CONTROL)]);
    while (smuxBytes.length >= 8) {
      assert.equal(smuxBytes[0], 2);
      const cmd = smuxBytes[1];
      const len = smuxBytes.readUInt16LE(2);
      const sid = smuxBytes.readUInt32LE(4);
      if (smuxBytes.length < 8 + len) break;
      const payload = smuxBytes.subarray(8, 8 + len);
      smuxBytes = smuxBytes.subarray(8 + len);
      if (cmd === 0) {
        assert.equal(sid, 3, 'first client stream ID');
        streamId = sid;
        continue;
      }
      assert.equal(sid, streamId);
      if (cmd !== 2) continue;
      applicationBytes = Buffer.concat([applicationBytes, payload]);
      while (applicationBytes.length >= 4) {
        const size = applicationBytes.readUInt32BE(0);
        if (applicationBytes.length < 4 + size) break;
        const msg = JSON.parse(applicationBytes.subarray(4, 4 + size).toString());
        applicationBytes = applicationBytes.subarray(4 + size);
        if (msg.type === 'CLIENT_HELLO') {
          helloCount++;
          assert.equal(msg.version, 3);
          assert.equal(msg.device_id, 'chrome-test');
          assert.match(msg.challenge, /^[0-9a-f]{32}$/);
          reply({ version: 3, type: 'SERVER_WELCOME', session_id: 'local-session', peer_id: '66fe81a8', challenge: msg.challenge });
        } else {
          assert.equal(msg.type, 'CONTROL_PING');
          assert.equal(msg.version, 1);
          pingCount++;
          reply({ ...msg, type: 'CONTROL_PONG' });
        }
      }
    }
  };
  const inbound = (src, dst, payload = new Uint8Array()) => {
    const frame = new Uint8Array(36 + payload.length);
    frame.set(buildEpochHeader(tunnel.token, src, dst));
    frame.set(payload, 36);
    tunnel.handleInbound(frame);
  };
  // Another participant's keepalive must not become the assumed server identity.
  inbound(0x66fe81a8, 0);
  inbound(0x1459fb8e, 0);
  const handshake = tunnel.startHandshake();
  let dropped = false;
  const start = performance.now();
  while (performance.now() - start < 14_000 && logs.filter((line) => line === 'liveness.pong').length < 2) {
    const frame = tunnel.buildSample({ frameType: 'delta' });
    const header = parseEpochHeader(frame);
    if (header.payload.length) {
      assert.equal(header.src, 0xf6911886);
      if (!dropped) {
        dropped = true;
        // Foreign broadcast HELLO and traffic for a different client must be ignored.
        inbound(0x9459fb8e, 0, header.payload);
        inbound(0xe6fe81a8, 0x9459fb8e, header.payload);
      } else {
        for (const wire of splitKCPPayload(header.payload)) {
          const packet = nativeOpenKcp(wire);
          assert.ok(packet, 'native CRC32C gate accepts the outgoing datagram');
          assert.equal(server.input(packet), 0);
        }
      }
    }
    server.update();
    // Reverse and duplicate deliveries: KCP must reassemble only once.
    for (const packet of serverOut.splice(0).reverse()) {
      const wire = nativeSealKcp(packet);
      inbound(0xe6fe81a8, 0xf6911886, wire);
      inbound(0xe6fe81a8, 0xf6911886, wire);
    }
    await delay(33);
  }
  assert.ok(performance.now() - start > 10_000, 'sustained delta-only carrier for more than ten seconds');
  assert.equal(helloCount, 1, logs.join('\n'));
  assert.equal(tunnel.handshakeOk, true, logs.join('\n'));
  assert.equal(tunnel.pingOk, true, logs.join('\n'));
  assert.equal(pingCount, 2);
  assert.equal(logs.filter((line) => line === 'liveness.pong').length, 2);
  assert.ok(tunnel.stats.controlAcks > 0);
  assert.ok(tunnel.control.kcp.sndUna > 0);
  assert.equal(tunnel.stats.queueDrops, 0);
  assert.ok(flags.some((event) => event.handshakeOk));
  assert.ok(flags.some((event) => event.pingOk));
  assert.ok(!logs.some((line) => /handshake.error|olc2.open|kcp.input/.test(line)), logs.join('\n'));
  await handshake;
});
