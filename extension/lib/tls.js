import init, { WasmTlsClient } from './vendor/tls-wasm/rust_tls_wasm.js';
import { concatBytes } from './pool.js';
import { errorMessage } from './errors.js';

// Rustls limits how much plaintext can wait in its internal buffer. Drain one
// TLS record at a time so large POST bodies cannot make write_all fail before
// extract_network_data gets a chance to run.
export const TLS_APP_WRITE_CHUNK = 16 * 1024;

let wasmReady;

function ensureWasm() {
  if (!wasmReady) {
    wasmReady = init({
      module_or_path: new URL('./vendor/tls-wasm/rust_tls_wasm_bg.wasm', import.meta.url),
    });
  }
  return wasmReady;
}

function feedNetwork(client, chunk) {
  const u8 = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
  let offset = 0;
  let plain = new Uint8Array(0);
  while (offset < u8.length) {
    const n = client.provide_network_data(u8.subarray(offset));
    if (u8.length - offset > 0 && n === 0) {
      throw new Error('tls: rustls consumed 0 bytes');
    }
    offset += n;
    const app = client.read_app_data();
    if (app?.length) plain = concatBytes(plain, app);
  }
  return plain;
}

function flushOut(client, tcp) {
  while (client.wants_write()) {
    const net = client.extract_network_data();
    if (net?.length) tcp.write(net);
  }
}

export function writeTlsApplicationData(client, tcp, input) {
  const data = input instanceof Uint8Array ? input : new Uint8Array(input);
  for (let offset = 0; offset < data.length; offset += TLS_APP_WRITE_CHUNK) {
    client.write_app_data(data.subarray(offset, offset + TLS_APP_WRITE_CHUNK));
    flushOut(client, tcp);
  }
}

/**
 * TLS 1.2/1.3 client (Rustls WASM + Mozilla CA). Fail-closed on unknown issuer.
 * Duplex matches smux: { read, write, close }.
 */
export async function wrapTls(tcp, { sni, log }) {
  await ensureWasm();
  const client = new WasmTlsClient(sni, 'http/1.1');
  let closed = false;
  let plain = new Uint8Array(0);
  const waiters = [];
  const wake = () => {
    const w = waiters.splice(0);
    for (const fn of w) fn();
  };

  try {
    flushOut(client, tcp);
    while (client.is_handshaking()) {
      const chunk = await tcp.read(4096);
      if (!chunk.length) throw new Error('tls: eof during handshake');
      const app = feedNetwork(client, chunk);
      if (app.length) plain = concatBytes(plain, app);
      flushOut(client, tcp);
    }
  } catch (err) {
    const msg = errorMessage(err, 'TLS handshake failed');
    log(`tls.error ${msg}`);
    try {
      client.free();
    } catch {
      /* ignore */
    }
    throw err instanceof Error ? err : new Error(msg);
  }

  const ver =
    typeof client.protocol_version === 'function' ? client.protocol_version() : 'TLS1.3';
  const alpn = client.negotiatedAlpn?.() || 'http/1.1';
  log(`tls.ok sni=${sni} ver=${ver} ca=ok alpn=${alpn}`);

  const pump = async () => {
    try {
      for (;;) {
        const chunk = await tcp.read(4096);
        if (!chunk.length) break;
        const app = feedNetwork(client, chunk);
        if (app.length) {
          plain = concatBytes(plain, app);
          wake();
        }
        flushOut(client, tcp);
      }
    } catch (err) {
      log(`tls.pump ${err.message}`);
    }
    closed = true;
    wake();
  };
  void pump();

  return {
    get closed() {
      return closed;
    },
    write(u8) {
      writeTlsApplicationData(client, tcp, u8);
    },
    async read(n) {
      while (!plain.length && !closed) {
        await new Promise((r) => waiters.push(r));
      }
      if (!plain.length) return new Uint8Array(0);
      const take = Math.min(n ?? plain.length, plain.length);
      const out = plain.subarray(0, take).slice();
      plain = plain.subarray(take);
      return out;
    },
    close() {
      try {
        if (typeof client.close === 'function') client.close();
        flushOut(client, tcp);
      } catch {
        /* ignore */
      }
      try {
        client.free();
      } catch {
        /* ignore */
      }
      tcp.close();
    },
  };
}
