import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const extPath = path.resolve('extension');
const profileDir = await mkdtemp(path.join(os.tmpdir(), 'chrome-diag-'));
const uri = 'olcrtc://telemost?vp8channel<vp8-fps=30&vp8-batch=64>@65512210846330#094411a45bebb6b458b951c52262accc4997df3085b6b4638cf8da66f30271e1$Debian-Tele';

const chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
  '--headless=new',
  '--user-data-dir=' + profileDir,
  '--remote-debugging-port=9222',
  '--enable-unsafe-extension-debugging',
  '--no-first-run',
  '--no-default-browser-check',
  'about:blank',
]);

try {
  let ver = null;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch('http://127.0.0.1:9222/json/version');
      ver = await res.json();
      break;
    } catch {}
  }

  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let reqId = 0;
  const pending = new Map();
  ws.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    }
  };
  const send = (method, params = {}, sessionId) => {
    const id = ++reqId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  };

  const loadRes = await send('Extensions.loadUnpacked', { path: extPath });
  const extId = loadRes.id;
  const popupTarget = await send('Target.createTarget', { url: `chrome-extension://${extId}/popup.html` });
  const { sessionId } = await send('Target.attachToTarget', { targetId: popupTarget.targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await new Promise((r) => setTimeout(r, 1000));

  await send('Runtime.evaluate', {
    expression: `(() => {
      document.getElementById('uri').value = ${JSON.stringify(uri)};
      const dbg = document.getElementById('debug-toggle');
      if (dbg && !dbg.checked) dbg.click();
      document.getElementById('connect').click();
    })()`,
  }, sessionId);

  for (let i = 0; i < 35; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const fullLog = await send('Runtime.evaluate', {
      expression: 'new Promise(r => chrome.runtime.sendMessage({ type: "GET_LOG" }, r))',
      awaitPromise: true,
      returnByValue: true,
    }, sessionId);
    if (fullLog.result?.value?.flags?.handshakeOk && fullLog.result?.value?.flags?.pingOk) {
      console.log('Tunnel Connected!');
      break;
    }
  }

  let lastLogged = 0;
  async function flushLogs() {
    const fullLog = await send('Runtime.evaluate', {
      expression: 'new Promise(r => chrome.runtime.sendMessage({ type: "GET_LOG" }, r))',
      awaitPromise: true,
      returnByValue: true,
    }, sessionId);
    const logs = fullLog.result?.value?.logs || [];
    while (lastLogged < logs.length) console.log('  LOG:', logs[lastLogged++]);
  }

  // Helper to fetch via HTTP_PROXY
  async function proxyFetch(url, headers = {}) {
    process.stdout.write(`Fetching ${url} ... `);
    const t0 = Date.now();
    const res = await send('Runtime.evaluate', {
      expression: `new Promise((resolve) => {
        chrome.runtime.sendMessage({
          type: 'HTTP_PROXY',
          method: 'GET',
          url: ${JSON.stringify(url)},
          headers: ${JSON.stringify(headers)}
        }, resolve);
      })`,
      awaitPromise: true,
      returnByValue: true,
    }, sessionId);
    const val = res.result?.value;
    if (val?.ok) {
      console.log(`OK ${val.status} (${val.bodyLength || val.body?.length} bytes in ${Date.now() - t0}ms)`);
    } else {
      console.log(`FAIL: ${val?.error} (${Date.now() - t0}ms)`);
    }
    await flushLogs();
    return val;
  }

  await proxyFetch('https://ifconfig.co/json');
  await proxyFetch('https://example.com/');
  await proxyFetch('http://neverssl.com/');
  await proxyFetch('https://httpbin.org/get');
  await proxyFetch('https://www.wikipedia.org/');
  await proxyFetch('https://www.cloudflare.com/');
  await proxyFetch('https://yandex.ru/');
  await proxyFetch('https://www.google.com/');
  await proxyFetch('https://www.youtube.com/');
} finally {
  chrome.kill();
  await rm(profileDir, { recursive: true, force: true }).catch(() => {});
}
