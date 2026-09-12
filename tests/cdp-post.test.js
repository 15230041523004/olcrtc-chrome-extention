import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeCdpPostData, latin1ToBytes, resolveCdpPostBody } from '../extension/lib/cdp-post.js';

test('latin1 postData keeps bytes 0x00/0x80/0xff (TextEncoder would not)', () => {
  const raw = new Uint8Array([0x00, 0x80, 0xff, 0x41]);
  const postData = String.fromCharCode(...raw);
  const { body, src } = decodeCdpPostData({ postData });
  assert.equal(src, 'paused');
  assert.deepEqual(body, raw);
  const utf8 = new TextEncoder().encode(postData);
  assert.notEqual(utf8.length, raw.length);
});

test('postDataEntries concatenates base64 parts', () => {
  const a = new Uint8Array([0x00, 0x80]);
  const b = new Uint8Array([0xff, 0x41]);
  const { body, src } = decodeCdpPostData({
    postData: 'ignored',
    postDataEntries: [
      { bytes: Buffer.from(a).toString('base64') },
      { bytes: Buffer.from(b).toString('base64') },
    ],
  });
  assert.equal(src, 'entries');
  assert.deepEqual(body, new Uint8Array([0x00, 0x80, 0xff, 0x41]));
});

test('empty request is none', () => {
  const { body, src } = decodeCdpPostData({});
  assert.equal(src, 'none');
  assert.equal(body, null);
});

test('resolveCdpPostBody fetches when hasPostData and paused body missing', async () => {
  const raw = new Uint8Array([0x80, 0xff]);
  const { body, src } = await resolveCdpPostBody(
    { hasPostData: true },
    { getPostData: async () => ({ postData: String.fromCharCode(...raw) }) },
  );
  assert.equal(src, 'get');
  assert.deepEqual(body, raw);
});

test('resolveCdpPostBody miss does not throw', async () => {
  const { body, src, error } = await resolveCdpPostBody(
    { hasPostData: true },
    { getPostData: async () => { throw new Error('no body'); } },
  );
  assert.equal(src, 'none');
  assert.equal(body, null);
  assert.match(error.message, /no body/);
});

test('latin1ToBytes caps via resolveCdpPostBody max', async () => {
  const postData = String.fromCharCode(1, 2, 3, 4, 5);
  const { body } = await resolveCdpPostBody({ postData }, { max: 3 });
  assert.deepEqual(body, new Uint8Array([1, 2, 3]));
  assert.deepEqual(latin1ToBytes(postData), new Uint8Array([1, 2, 3, 4, 5]));
});
