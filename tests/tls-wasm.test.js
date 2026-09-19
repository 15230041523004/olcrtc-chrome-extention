import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import init, { WasmTlsClient } from '../extension/lib/vendor/tls-wasm/rust_tls_wasm.js';

test('rustls wasm loads and emits ClientHello with TLS 1.2 and 1.3', async () => {
  const wasmPath = fileURLToPath(new URL('../extension/lib/vendor/tls-wasm/rust_tls_wasm_bg.wasm', import.meta.url));
  await init({ module_or_path: readFileSync(wasmPath) });
  const client = new WasmTlsClient('example.com', 'http/1.1');
  assert.equal(client.is_handshaking(), true);
  assert.equal(client.wants_write(), true);
  const hello = client.extract_network_data();
  assert.ok(hello.length > 5);
  assert.equal(hello[0], 0x16);
  const hex = Buffer.from(hello).toString('hex');
  // Both TLS 1.3 (0x0304) and TLS 1.2 (0x0303) in supported_versions extension (0x002b)
  assert.ok(hex.includes('002b00050403040303'), 'must offer supported_versions with TLS 1.3 and TLS 1.2');
  // TLS 1.3 cipher suites (AES-128-GCM, AES-256-GCM)
  assert.ok(hex.includes('1301') && hex.includes('1302'), 'must include TLS 1.3 cipher suites');
  // TLS 1.2 cipher suites (ECDHE-RSA and ECDHE-ECDSA)
  assert.ok(hex.includes('c02f') && hex.includes('c02b'), 'must include TLS 1.2 cipher suites');
  client.free();
});

