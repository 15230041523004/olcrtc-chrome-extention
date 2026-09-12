// Local Chrome integration check, with fixture HTTP responses and a fresh profile.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPrivacyFixture } from './privacy-fixture.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(path.join(root, '.tmp'), { recursive: true });
const dir = await mkdtemp(path.join(root, '.tmp/chrome-privacy-'));
const ext = path.join(dir, 'extension');
await cp(path.join(root, 'extension'), ext, { recursive: true });
await writeFile(path.join(ext, 'background.js'), [
  `import * as intercept from './lib/intercept.js';`,
  `import * as guard from './lib/network-guard.js';`,
  'Object.assign(globalThis, { intercept, guard });',
].join('\n'));
const hits = [];
const server = createServer((req, res) => { hits.push(req.url); res.end('DIRECT'); });
server.on('upgrade', (req, socket) => { hits.push(req.url); socket.destroy(); });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const browser = spawn(process.argv[2] || 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', `--user-data-dir=${path.join(dir, 'profile')}`, '--remote-debugging-pipe',
  '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check',
  '--disable-background-networking', '--site-per-process', 'about:blank',
], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
let nextId = 0;
let buffer = '';
const pending = new Map();
function rejectPending(error) {
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); }
  pending.clear();
}
browser.on('error', rejectPending);
browser.on('exit', () => rejectPending(new Error('Chrome exited')));
browser.stdio[4].setEncoding('utf8');
browser.stdio[4].on('data', (chunk) => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf('\0')) >= 0) {
    const msg = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    const p = pending.get(msg.id);
    if (!p) continue;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
    else p.resolve(msg.result);
  }
});
function send(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, 30_000);
    pending.set(id, { resolve, reject, timer });
    browser.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
  });
}
try {
  const version = await send('Browser.getVersion');
  const { id } = await send('Extensions.loadUnpacked', { path: ext });
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    target = (await send('Target.getTargets')).targetInfos.find((t) => t.url === `chrome-extension://${id}/background.js`);
    if (!target) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(target, 'fixture service worker started');
  const { sessionId } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  for (let i = 0; i < 50; i++) {
    const ready = await send('Runtime.evaluate', { expression: 'Boolean(globalThis.intercept)', returnByValue: true }, sessionId);
    if (ready.result?.value) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const result = await send('Runtime.evaluate', {
    expression: `(${runPrivacyFixture.toString()})(${server.address().port})`,
    awaitPromise: true, returnByValue: true,
  }, sessionId).catch(async (error) => {
    const logs = await send('Runtime.evaluate', { expression: 'globalThis.testLogs', returnByValue: true }, sessionId);
    console.error(logs.result?.value);
    throw error;
  });
  if (result.exceptionDetails) {
    const logs = await send('Runtime.evaluate', { expression: 'globalThis.testLogs', returnByValue: true }, sessionId);
    console.error(logs.result?.value);
    throw new Error(JSON.stringify(result.exceptionDetails));
  }
  assert.deepEqual(hits.filter((url) => url !== '/favicon.ico'), ['/carrier', '/released'], 'only carrier and explicitly released requests reach the network');
  const report = { passed: true, chrome: version.product, ...result.result.value, directRequests: hits };
  const reportPath = path.join(root, '.tmp/chrome-privacy-result.json');
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, reportPath }, null, 2));
} finally {
  await send('Browser.close').catch(() => {});
  browser.kill();
  server.closeAllConnections();
  server.close();
}
