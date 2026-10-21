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

  let lastEventIdx = 0;
  async function flushLogs() {
    const fullLog = await send('Runtime.evaluate', {
      expression: 'new Promise(r => chrome.runtime.sendMessage({ type: "GET_LOG" }, r))',
      awaitPromise: true,
      returnByValue: true,
    }, sessionId);
    const events = fullLog.result?.value?.events || [];
    while (lastEventIdx < events.length) console.log('  EV:', events[lastEventIdx++]);
  }

  for (let i = 0; i < 35; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const fullLog = await send('Runtime.evaluate', {
      expression: 'new Promise(r => chrome.runtime.sendMessage({ type: "GET_LOG" }, r))',
      awaitPromise: true,
      returnByValue: true,
    }, sessionId);
    const flags = fullLog.result?.value?.flags || {};
    console.log(`[${i}s] hs=${flags.handshakeOk} ping=${flags.pingOk} sub=${flags.subConnected} pub=${flags.pubConnected}`);
    if (flags.handshakeOk) {
      console.log('Tunnel Handshake OK!');
      break;
    }
  }

  // Helper to fetch via HTTP_PROXY
  async function proxyFetch(label, url, headers = {}) {
    process.stdout.write(`\nFetching ${label} ... `);
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

  // Test 1: ifconfig
  await proxyFetch('ifconfig', 'https://ifconfig.co/json');

  // Test 2: YouTube empty headers
  await proxyFetch('YouTube empty headers', 'https://www.youtube.com/');

  // Test 3: YouTube with Chrome navigation headers
  const chromeHeaders = {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Upgrade-Insecure-Requests': '1',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-User': '?1',
    'Sec-Fetch-Dest': 'document',
    'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Accept-Language': 'en-US,en;q=0.9',
  };

  await proxyFetch('YouTube Chrome headers', 'https://www.youtube.com/', chromeHeaders);

} finally {
  chrome.kill();
  await rm(profileDir, { recursive: true, force: true }).catch(() => {});
}
