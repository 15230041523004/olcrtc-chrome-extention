import test from 'node:test';
import assert from 'node:assert/strict';
import { errorMessage } from '../extension/lib/errors.js';

test('errorMessage preserves Error, string and structured failures', () => {
  assert.equal(errorMessage(new Error('socket closed')), 'socket closed');
  assert.equal(errorMessage('Rustls write_app_data error: write zero'), 'Rustls write_app_data error: write zero');
  assert.equal(errorMessage({ code: 'TLS_BUFFER_FULL' }), '{"code":"TLS_BUFFER_FULL"}');
  assert.equal(errorMessage(undefined, 'proxy failed'), 'proxy failed');
});
