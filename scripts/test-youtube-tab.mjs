import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const extPath = path.join(root, 'extension');
const profileDir = await mkdtemp(path.join(os.tmpdir(), 'chrome-yt-'));

const uri = 'olcrtc://telemost?vp8channel<vp8-fps=30&vp8-batch=64>@39277823564632#b3dc684364873554abca7e0e2b32b9bd04c6f0ddacc0c2b2af5da2f3b3af5047$Debian-Telemost-srv';

const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const chrome = spawn(chromePath, [
  '--headless=new',
  `--user-data-dir=${profileDir}`,
  '--remote-debugging-port=9222',
  '--enable-unsafe-extension-debugging',
  '--no-first-run',
  '--no-default-browser-check',
  'about:blank',
]);

chrome.on('error', (e) => console.error('Chrome spawn error:', e));

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

  const send = (method, params = {}, sessionId, timeoutMs = 8000) => {
    const id = ++reqId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  };

  console.log('Loading unpacked extension from:', extPath);
  const loadRes = await send('Extensions.loadUnpacked', { path: extPath });
  const extId = loadRes.id;
  console.log('Extension ID:', extId);

  // Open popup.html as target
  const popupTarget = await send('Target.createTarget', { url: `chrome-extension://${extId}/popup.html` });
  const { sessionId } = await send('Target.attachToTarget', { targetId: popupTarget.targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);

  await new Promise((r) => setTimeout(r, 1000));

  // Connect via popup
  await send('Runtime.evaluate', {
    expression: `(() => {
      document.getElementById('uri').value = ${JSON.stringify(uri)};
      const dbg = document.getElementById('debug-toggle');
      if (dbg && !dbg.checked) dbg.click();
      document.getElementById('connect').click();
    })()`,
  }, sessionId);
  console.log('Clicked Connect in popup');

  // Wait for handshake, ping and auto-intercept
  let connected = false;
  for (let i = 0; i < 35; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const fullLog = await send('Runtime.evaluate', {
      expression: `new Promise((resolve) => chrome.runtime.sendMessage({ type: 'GET_LOG' }, resolve))`,
      awaitPromise: true,
      returnByValue: true,
    }, sessionId);
    const data = fullLog.result?.value;
    const flags = data?.flags || {};
    process.stdout.write(`\r[${i}s] status=${data?.status} hs=${flags.handshakeOk} ping=${flags.pingOk} intercept=${flags.intercept} tabs=${data?.interceptTabCount}`);
    if (flags.handshakeOk && flags.pingOk) {
      connected = true;
      console.log('\nTunnel is connected and healthy!');
      break;
    }
  }

  if (!connected) {
    throw new Error('Failed to connect within timeout');
  }

  // Wait 3s for exit geo and intercept to stabilize
  console.log('Waiting 3s for auto-intercept stabilization...');
  await new Promise((r) => setTimeout(r, 3000));

  // Open YouTube tab via chrome.tabs.create from the extension!
  console.log('Navigating tab to YouTube...');
  const createTabRes = await send('Runtime.evaluate', {
    expression: `new Promise((resolve) => {
      chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] }, (tabs) => {
        const landing = tabs.find(t => (t.url || '').includes('neverssl.com'));
        if (landing) {
          chrome.tabs.update(landing.id, { url: 'https://www.youtube.com/' }, (tab) => resolve(tab.id));
        } else {
          chrome.tabs.create({ url: 'https://www.youtube.com/' }, (tab) => resolve(tab.id));
        }
      });
    })`,
    awaitPromise: true,
    returnByValue: true,
  }, sessionId);

  const tabId = createTabRes.result?.value;
  console.log('YouTube tabId:', tabId);

  let lastEventIdx = 0;
  let lastLogIdx = 0;
  let fulfilledCount = 0;
  let totalBytes = 0;

  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 1000));

    // Get tab status
    const tabInfo = await send('Runtime.evaluate', {
      expression: `new Promise((resolve) => {
        chrome.tabs.get(${tabId}, (t) => resolve(t ? { status: t.status, title: t.title, url: t.url } : null));
      })`,
      awaitPromise: true,
      returnByValue: true,
    }, sessionId);

    const t = tabInfo.result?.value;

    // Get extension events and logs
    const logRes = await send('Runtime.evaluate', {
      expression: `new Promise((resolve) => chrome.runtime.sendMessage({ type: 'GET_LOG' }, resolve))`,
      awaitPromise: true,
      returnByValue: true,
    }, sessionId);

    const events = logRes.result?.value?.events || [];
    while (lastEventIdx < events.length) {
      const ev = events[lastEventIdx++];
      console.log('  EV:', ev);
      if (ev.includes('fetch.fulfill')) {
        fulfilledCount++;
        const m = ev.match(/bytes=(\d+)/);
        if (m) totalBytes += Number.parseInt(m[1], 10);
      }
    }

    const logs = logRes.result?.value?.logs || [];
    while (lastLogIdx < logs.length) {
      const l = logs[lastLogIdx++];
      if (l.includes('socks') || l.includes('tls') || l.includes('http') || l.includes('smux') || l.includes('pool') || l.includes('kcp.stats')) {
        console.log('  LOG:', l);
      }
    }

    console.log(`[youtube ${i}s] tabStatus="${t?.status}" tabTitle="${t?.title}" fulfilled=${fulfilledCount} bytes=${totalBytes}`);

    if (t?.title === 'YouTube' || (fulfilledCount > 15 && totalBytes > 100000)) {
      console.log('\n>>> YOUTUBE SUCCESSFULLY LOADED IN BROWSER! <<<');
      console.log(`Total fulfilled requests: ${fulfilledCount}, Total bytes: ${totalBytes}`);
      break;
    }
  }

} finally {
  chrome.kill();
  await new Promise((r) => setTimeout(r, 1000));
  await rm(profileDir, { recursive: true, force: true }).catch(() => {});
}
