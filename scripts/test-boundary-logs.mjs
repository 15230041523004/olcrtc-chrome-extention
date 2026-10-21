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

  await new Promise((r) => setTimeout(r, 4000));

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

  async function testSize(size) {
    const url = `http://httpbin.org/bytes/${size}`;
    const t0 = Date.now();
    console.log(`\n=== Testing size ${size} bytes ===`);
    const p = send('Runtime.evaluate', {
      expression: `new Promise((resolve) => {
        chrome.runtime.sendMessage({
          type: 'HTTP_PROXY',
          method: 'GET',
          url: ${JSON.stringify(url)},
        }, resolve);
      })`,
      awaitPromise: true,
      returnByValue: true,
    }, sessionId);

    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      await flushLogs();
      const st = await Promise.race([p, Promise.resolve(null)]);
      if (st) {
        const val = st.result?.value;
        console.log(`Result for ${size}:`, val?.ok ? `OK len=${val.bodyLength || val.body?.length}` : `FAIL ${val?.error}`, `in ${Date.now() - t0}ms`);
        break;
      }
    }
  }

  await testSize(14000);
  await testSize(14500);

} finally {
  try {
    await send('Runtime.evaluate', {
      expression: `new Promise((resolve) => chrome.runtime.sendMessage({ type: 'DISCONNECT' }, resolve))`,
      awaitPromise: true,
    }, sessionId);
  } catch {}
  chrome.kill();
  await rm(profileDir, { recursive: true, force: true }).catch(() => {});
}

