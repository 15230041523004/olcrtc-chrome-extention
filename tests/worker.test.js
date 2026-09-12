import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';

test('worker forwards delta frames when Chrome has no transformer.generateKeyFrame', async (t) => {
  const intervals = new Map();
  const messages = [];
  const worker = new EventTarget();
  worker.postMessage = (message) => messages.push(message);
  const originalSelf = Object.getOwnPropertyDescriptor(globalThis, 'self');
  Object.defineProperty(globalThis, 'self', { configurable: true, value: worker });
  t.after(() => {
    if (originalSelf) Object.defineProperty(globalThis, 'self', originalSelf);
    else delete globalThis.self;
  });
  t.mock.method(globalThis, 'setInterval', (fn, ms) => {
    const id = {};
    intervals.set(id, { fn, ms });
    return id;
  });
  t.mock.method(globalThis, 'clearInterval', (id) => intervals.delete(id));
  await import('../extension/transform-worker.js');
  const input = new TransformStream();
  const output = [];
  worker.onrtctransform({ transformer: {
    options: { name: 'sender', mode: 'tunnel' },
    readable: input.readable,
    writable: new WritableStream({ write(frame) { output.push(frame); } }),
  } });
  const writer = input.writable.getWriter();
  const frame = { type: 'delta', data: new Uint8Array([1, 2, 3]).buffer };
  await writer.write(frame);
  await nextTurn();
  assert.equal(output[0], frame);
  await writer.close();
  await nextTurn();
  assert.equal([...intervals.values()].filter(({ ms }) => ms === 1000).length, 0);
  assert.ok(!messages.some(({ type }) => type === 'pipeError' || type === 'error'));
  assert.ok(!messages.some(({ line }) => line?.includes('keyframe.hint')));
});
