import net from 'node:net';
import { readFileSync } from 'node:fs';
import init from '../extension/lib/vendor/tls-wasm/rust_tls_wasm.js';
import { wrapTls } from '../extension/lib/tls.js';

await init({ module_or_path: readFileSync('./extension/lib/vendor/tls-wasm/rust_tls_wasm_bg.wasm') });

const sock = net.connect(443, 'www.youtube.com', async () => {
  const queue = [];
  let waiter = null;
  sock.on('data', (d) => {
    queue.push(new Uint8Array(d));
    if (waiter) { const w = waiter; waiter = null; w(); }
  });
  sock.on('end', () => {
    queue.push(new Uint8Array(0));
    if (waiter) { const w = waiter; waiter = null; w(); }
  });
  const tcp = {
    async read(n) {
      while (queue.length === 0) await new Promise((r) => { waiter = r; });
      return queue.shift();
    },
    write(d) {
      return new Promise((resolve) => sock.write(d, resolve));
    },
    close() { sock.destroy(); }
  };

  const req = 'GET / HTTP/1.1\r\n' +
    'Host: www.youtube.com\r\n' +
    'Connection: keep-alive\r\n' +
    'Accept-Encoding: gzip, deflate\r\n' +
    'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/jxl,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7\r\n' +
    'Upgrade-Insecure-Requests: 1\r\n' +
    'Accept-Language: en-US,en;q=0.9\r\n' +
    'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36\r\n' +
    'Sec-CH-UA: "Google Chrome";v="155", "Chromium";v="155", "Not.A/Brand";v="24"\r\n' +
    'Sec-CH-UA-Mobile: ?0\r\n' +
    'Sec-CH-UA-Platform: "Windows"\r\n' +
    'Sec-CH-UA-Full-Version-List: "Google Chrome";v="155.0.0.0", "Chromium";v="155.0.0.0", "Not.A/Brand";v="24.0.0.0"\r\n' +
    'Sec-CH-UA-Platform-Version: "15.0.0"\r\n' +
    'Sec-CH-UA-Arch: "x86"\r\n' +
    'Sec-CH-UA-Bitness: "64"\r\n' +
    'Sec-CH-UA-Model: ""\r\n\r\n';

  try {
    const tls = await wrapTls(tcp, { sni: 'www.youtube.com', log: console.log });
    console.log('Sending exact Chrome request, length:', req.length);
    await tls.write(new TextEncoder().encode(req));
    const res = await tls.read(4096);
    console.log('Response len:', res.length);
    console.log('Response text:', new TextDecoder().decode(res.subarray(0, 300)));
  } catch (e) {
    console.error('Error:', e);
  } finally {
    sock.destroy();
  }
});
