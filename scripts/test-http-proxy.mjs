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

  console.log('\n--- Test 1: Fetch ifconfig.co via HTTP_PROXY ---');
  const res1 = await send('Runtime.evaluate', {
    expression: `new Promise((resolve) => {
      chrome.runtime.sendMessage({
        type: 'HTTP_PROXY',
        method: 'GET',
        url: 'https://ifconfig.co/json',
        headers: { 'Host': 'ifconfig.co', 'User-Agent': 'curl/7.68.0' }
      }, resolve);
    })`,
    awaitPromise: true,
    returnByValue: true,
  }, sessionId);
  console.log('ifconfig.co result:', { ok: res1.result?.value?.ok, status: res1.result?.value?.status, bodyLen: res1.result?.value?.bodyLength });

  console.log('\n--- Test 2: Fetch www.youtube.com via HTTP_PROXY ---');
  const pYt = send('Runtime.evaluate', {
    expression: `new Promise((resolve) => {
      chrome.runtime.sendMessage({
        type: 'HTTP_PROXY',
        method: 'GET',
        url: 'https://www.youtube.com/',
        headers: {
          'Host': 'www.youtube.com',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        }
      }, resolve);
    })`,
    awaitPromise: true,
    returnByValue: true,
  }, sessionId);

  let lastLogged = 0;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const fullLog = await send('Runtime.evaluate', {
      expression: 'new Promise(r => chrome.runtime.sendMessage({ type: "GET_LOG" }, r))',
      awaitPromise: true,
      returnByValue: true,
    }, sessionId);
    const logs = fullLog.result?.value?.logs || [];
    while (lastLogged < logs.length) console.log('  LOG:', logs[lastLogged++]);
  }

  const res2 = await pYt;
  console.log('youtube result:', res2.result?.value);
} finally {
  chrome.kill();
  await rm(profileDir, { recursive: true, force: true }).catch(() => {});
}

