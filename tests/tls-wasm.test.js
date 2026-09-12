import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import init, { WasmTlsClient } from '../extension/lib/vendor/tls-wasm/rust_tls_wasm.js';

test('rustls wasm loads and emits ClientHello', async () => {
  const wasmPath = fileURLToPath(new URL('../extension/lib/vendor/tls-wasm/rust_tls_wasm_bg.wasm', import.meta.url));
  await init({ module_or_path: readFileSync(wasmPath) });
  const client = new WasmTlsClient('example.com', 'http/1.1');
  assert.equal(client.is_handshaking(), true);
  assert.equal(client.wants_write(), true);
  const hello = client.extract_network_data();
  assert.ok(hello.length > 5);
  assert.equal(hello[0], 0x16);
  client.free();
});
