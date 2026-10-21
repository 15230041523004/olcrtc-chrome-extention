import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EXTENSION_PATH = 'X:\\GIT\\olcrtc-chrome-extention-research-\\extension';
const USER_STAND_URI = 'olcrtc://telemost?vp8channel<vp8-fps=30&vp8-batch=64>@65512210846330#094411a45bebb6b458b951c52262accc4997df3085b6b4638cf8da66f30271e1$Debian-Tele';

const profileDir = await mkdtemp(join(tmpdir(), 'chrome-yt-'));
const chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
  '--remote-debugging-port=9333',
  `--user-data-dir=${profileDir}`,
  '--no-first-run',
  '--no-default-browser-check',
  `--disable-extensions-except=${EXTENSION_PATH}`,
  'about:blank',
]);

try {
  let endpoint = null;
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch('http://127.0.0.1:9333/json/version');
      const data = await res.json();
      endpoint = data.webSocketDebuggerUrl;
      if (endpoint) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!endpoint) throw new Error('Could not get CDP endpoint');

  const ws = new WebSocket(endpoint);
  await new Promise((r) => (ws.onopen = r));

  let reqId = 1;
  const pending = new Map();
  ws.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  };

  function send(method, params = {}, sessionId = null) {
    return new Promise((resolve, reject) => {
      const id = reqId++;
      pending.set(id, { resolve, reject });
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      ws.send(JSON.stringify(payload));
    });
  }

  const loadRes = await send('Extensions.loadUnpacked', { path: EXTENSION_PATH });
  const extensionId = loadRes.id;
  console.log('Extension ID:', extensionId);

  const popupTarget = await send('Target.createTarget', { url: `chrome-extension://${extensionId}/popup.html` });
  const { sessionId } = await send('Target.attachToTarget', { targetId: popupTarget.targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);

  await new Promise((r) => setTimeout(r, 1000));

  await send('Runtime.evaluate', {
    expression: `(() => {
      document.getElementById('uri').value = ${JSON.stringify(USER_STAND_URI)};
      const dbg = document.getElementById('debug-toggle');
      if (dbg && !dbg.checked) dbg.click();
      document.getElementById('connect').click();
    })()`,
  }, sessionId);
  console.log('Clicked Connect in popup');

  let connected = false;
  let lastLogged = 0;
  for (let i = 0; i < 35; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const fullLog = await send('Runtime.evaluate', {
      expression: `new Promise((resolve) => chrome.runtime.sendMessage({ type: 'GET_LOG' }, resolve))`,
      awaitPromise: true,
      returnByValue: true,
    }, sessionId);
    const data = fullLog.result?.value;
    const flags = data?.flags || {};
    const logs = data?.logs || [];
    while (lastLogged < logs.length) {
      console.log('  LOG:', logs[lastLogged++]);
    }
    if (flags.handshakeOk && flags.pingOk) {
      console.log('HANDSHAKE AND PING OK!');
      connected = true;
      break;
    }
  }

  if (connected) {
    console.log('\n--- NAVIGATING DIRECTLY TO YOUTUBE ---');
    const pageTarget = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId: pageSession } = await send('Target.attachToTarget', { targetId: pageTarget.targetId, flatten: true });
    await send('Page.enable', {}, pageSession);

    await send('Page.navigate', { url: 'https://www.youtube.com/' }, pageSession);
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const titleEval = await send('Runtime.evaluate', { expression: 'document.title' }, pageSession).catch(() => ({}));
      console.log(`[youtube ${i}s] Title: ${titleEval.result?.value}`);
      
      const fullLog = await send('Runtime.evaluate', {
        expression: `new Promise((resolve) => chrome.runtime.sendMessage({ type: 'GET_LOG' }, resolve))`,
        awaitPromise: true,
        returnByValue: true,
      }, sessionId);
      const logs = fullLog.result?.value?.logs || [];
      while (lastLogged < logs.length) {
        console.log('  LOG:', logs[lastLogged++]);
      }
      for (const ev of (fullLog.result?.value?.events || []).slice(-5)) {
        console.log('  EV:', ev);
      }
    }
  }

  ws.close();
} finally {
  chrome.kill();
  await new Promise((r) => setTimeout(r, 1000));
  await rm(profileDir, { recursive: true, force: true }).catch(() => {});
}
