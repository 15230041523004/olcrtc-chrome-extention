import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const extPath = path.join(root, 'extension');
const profileDir = await mkdtemp(path.join(os.tmpdir(), 'chrome-live-'));

const uri = 'olcrtc://telemost?vp8channel<vp8-fps=30&vp8-batch=64>@65512210846330#094411a45bebb6b458b951c52262accc4997df3085b6b4638cf8da66f30271e1$Debian-Tele';

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

  const send = (method, params = {}, sessionId) => {
    const id = ++reqId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  };

  console.log('Loading unpacked extension from:', extPath);
  const loadRes = await send('Extensions.loadUnpacked', { path: extPath });
  const extId = loadRes.id;
  console.log('Extension ID:', extId);

  // Open popup.html as a target
  const popupTarget = await send('Target.createTarget', { url: `chrome-extension://${extId}/popup.html` });
  const { sessionId } = await send('Target.attachToTarget', { targetId: popupTarget.targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);

  await new Promise((r) => setTimeout(r, 1000));

  // Enable verbose logs and set URI
  await send('Runtime.evaluate', {
    expression: `(() => {
      document.getElementById('uri').value = ${JSON.stringify(uri)};
      const dbg = document.getElementById('debug-toggle');
      if (dbg && !dbg.checked) {
        dbg.click();
      }
      document.getElementById('connect').click();
    })()`,
  }, sessionId);
  console.log('Clicked Connect in popup with user URI');

  // Monitor handshake progress for up to 35 seconds
  let lastLogged = 0;
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
    console.log(`[${i}s] status=${data?.status} sub=${flags.subConnected} pub=${flags.pubConnected} in=${flags.transformIn} out=${flags.transformOut} hs=${flags.handshakeOk} ping=${flags.pingOk}`);
    
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
    console.log('\n--- TESTING NAVIGATION ---');
    const pageTarget = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId: pageSession } = await send('Target.attachToTarget', { targetId: pageTarget.targetId, flatten: true });
    await send('Page.enable', {}, pageSession);
    
    console.log('Navigating to https://ifconfig.co/json...');
    await send('Page.navigate', { url: 'https://ifconfig.co/json' }, pageSession);
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const bodyEval = await send('Runtime.evaluate', { expression: 'document.body?.innerText' }, pageSession);
      const body = (bodyEval.result?.value || '').trim();
      if (body && !body.includes('about:blank')) {
        console.log(`[ifconfig ${i}s] Got body:`, body.slice(0, 150));
        break;
      }
    }

    // Close any background neverssl tabs
    const targets = await send('Target.getTargets');
    for (const t of targets.targetInfos || []) {
      if (t.type === 'page' && (t.url || '').includes('neverssl')) {
        await send('Target.closeTarget', { targetId: t.targetId }).catch(() => {});
      }
    }

    console.log('Navigating to https://www.youtube.com/...');
    void send('Page.navigate', { url: 'https://www.youtube.com/' }, pageSession);
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const evalRes = await send('Runtime.evaluate', {
        expression: `({ title: document.title, ready: document.readyState, bodyLen: document.body?.innerHTML?.length || 0 })`,
        returnByValue: true,
      }, pageSession).catch(() => ({ result: { value: {} } }));
      const val = evalRes.result?.value || {};
      console.log(`[youtube ${i}s] Title: "${val.title}" Ready: ${val.ready} BodyLen: ${val.bodyLen}`);

      const fullLog = await send('Runtime.evaluate', {
        expression: `new Promise((resolve) => chrome.runtime.sendMessage({ type: 'GET_LOG' }, resolve))`,
        awaitPromise: true,
        returnByValue: true,
      }, sessionId);
      const logs = fullLog.result?.value?.logs || [];
      while (lastLogged < logs.length) {
        console.log('  LOG:', logs[lastLogged++]);
      }

      if (val.title === 'YouTube' || (val.bodyLen > 1000 && val.title && val.title !== 'www.youtube.com')) {
        console.log('SUCCESS! YouTube fully loaded!');
        break;
      }
    }
  }

  const finalLog = await send('Runtime.evaluate', {
    expression: `new Promise((resolve) => chrome.runtime.sendMessage({ type: 'GET_LOG' }, resolve))`,
    awaitPromise: true,
    returnByValue: true,
  }, sessionId);

  console.log('\n--- ALL EVENTS ---');
  for (const e of (finalLog.result?.value?.events || [])) console.log(e);

  console.log('\n--- RECENT LOGS ---');
  for (const l of (finalLog.result?.value?.logs || []).slice(-100)) console.log(l);

  ws.close();
} finally {
  chrome.kill();
  await new Promise((r) => setTimeout(r, 1000));
  await rm(profileDir, { recursive: true, force: true }).catch(() => {});
}
