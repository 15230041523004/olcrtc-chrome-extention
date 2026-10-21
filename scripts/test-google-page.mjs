import { spawn } from 'node:child_process';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';

const extPath = path.resolve('extension');
const profileDir = await mkdtemp(path.join(os.tmpdir(), 'chrome-diag-'));
const uri = 'olcrtc://telemost?vp8channel<vp8-fps=30&vp8-batch=64>@39277823564632#b3dc684364873554abca7e0e2b32b9bd04c6f0ddacc0c2b2af5da2f3b3af5047$Debian-Telemost-srv';

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
    if (fullLog.result?.value?.flags?.handshakeOk) {
      console.log('Tunnel ready!');
      break;
    }
  }

  // Create page for google.com
  const pageTarget = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: pageSession } = await send('Target.attachToTarget', { targetId: pageTarget.targetId, flatten: true });
  await send('Page.enable', {}, pageSession);
  console.log('Navigating page to https://www.google.com/ ...');
  void send('Page.navigate', { url: 'https://www.google.com/' }, pageSession);

  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const evalRes = await send('Runtime.evaluate', {
      expression: '({ title: document.title, url: location.href, text: document.body?.innerText?.slice(0, 300) })',
      returnByValue: true
    }, pageSession).catch(() => ({}));
    const val = evalRes.result?.value;
    console.log(`[${i}s] title=${JSON.stringify(val?.title)} url=${val?.url} text=${JSON.stringify(val?.text)}`);
    if (val?.title?.includes('Google') || val?.htmlLen > 1000) {
      console.log('SUCCESS: Google loaded!');
      break;
    }
  }

} finally {
  chrome.kill();
  await rm(profileDir, { recursive: true, force: true }).catch(() => {});
}

