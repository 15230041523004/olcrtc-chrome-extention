import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { requestPublisherKeyframe, monitorPublisher } from '../extension/lib/publisher-monitor.js';

test('keyframe requests use Chrome encodingOptions for each negotiated encoding', async () => {
  const parameters = { transactionId: 'test', encodings: [{ rid: 'a' }, { rid: 'b' }] };
  let calls = 0;
  assert.equal(await requestPublisherKeyframe({
    getParameters: () => parameters,
    async setParameters(actual, options) {
      calls++;
      assert.equal(actual, parameters);
      assert.deepEqual(options, { encodingOptions: [{ keyFrame: true }, { keyFrame: true }] });
    },
  }), true);
  assert.equal(calls, 1);
  assert.equal(await requestPublisherKeyframe({ getParameters: () => ({ encodings: [] }) }), false);
});

test('publisher monitor skips disconnected peers, serializes requests and stops its timer', async (t) => {
  let tick;
  let cleared = false;
  t.mock.method(globalThis, 'setInterval', (fn) => { tick = fn; return 7; });
  t.mock.method(globalThis, 'clearInterval', (id) => { assert.equal(id, 7); cleared = true; });
  const pc = { connectionState: 'new' };
  const logs = [];
  let requests = 0;
  let resolve;
  const stop = monitorPublisher(pc, {
    getParameters: () => ({ encodings: [{}] }),
    setParameters() { requests++; return new Promise((done) => { resolve = done; }); },
    async getStats() { return new Map([['video', { type: 'outbound-rtp', kind: 'video', packetsSent: 5, bytesSent: 500, keyFramesEncoded: 2 }]]); },
  }, (line) => logs.push(line), () => true);
  assert.equal(requests, 0);
  pc.connectionState = 'connected';
  tick();
  tick();
  assert.equal(requests, 1);
  resolve();
  await nextTurn();
  assert.ok(logs.some((line) => line.includes('packets=5 bytes=500') && line.includes('keys=2 keyRequests=1')));
  stop();
  tick();
  assert.equal(requests, 1);
  assert.equal(cleared, true);
});
