import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const chrome = process.argv[2] || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const scratch = path.join(root, '.tmp');
await mkdir(scratch, { recursive: true });
const profile = await mkdtemp(path.join(scratch, 'chrome-loopback-'));
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (!/^\/(?:tests\/(?:browser|helpers)\/[\w.-]+\.(?:js|html)|extension\/(?:lib\/[\w./-]+\.(?:js|wasm)|transform-worker\.js))$/.test(pathname)) {
    res.writeHead(404).end();
    return;
  }
  try {
    const content = await readFile(path.join(root, pathname.slice(1)));
    const ct = pathname.endsWith('.js')
      ? 'application/javascript'
      : pathname.endsWith('.wasm')
        ? 'application/wasm'
        : 'text/html; charset=utf-8';
    res.setHeader('Content-Type', ct);
    res.end(content);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let browser;
let socket;
let launchError;
const deadline = Date.now() + 45_000;
const pending = new Map();
let requestId = 0;
function send(method, params = {}) {
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
try {
  browser = spawn(chrome, [
    '--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-extensions', '--autoplay-policy=no-user-gesture-required', 'about:blank',
  ], { windowsHide: true, stdio: 'ignore' });
  browser.on('error', (error) => { launchError = error; });
  browser.on('exit', (code) => { launchError = new Error(`Chrome exited with code ${code}`); });
  let port;
  while (!port) {
    if (launchError) throw launchError;
    if (Date.now() > deadline) throw new Error('Chrome startup timeout');
    try { port = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; } catch {}
    if (!port) await delay(100);
  }
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(targets.find(({ type }) => type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  socket.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    const item = pending.get(msg.id);
    if (!item) return;
    pending.delete(msg.id);
    if (msg.error) item.reject(new Error(msg.error.message));
    else item.resolve(msg.result);
  };
  await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/tests/browser/loopback.html` });
  let result;
  while (!result) {
    if (Date.now() > deadline) throw new Error('Loopback test timeout');
    const evaluated = await send('Runtime.evaluate', { expression: 'globalThis.loopbackResult', returnByValue: true });
    result = evaluated.result?.value;
    if (!result) await delay(250);
  }
  const reportPath = path.join(scratch, 'chrome-loopback-result.json');
  await writeFile(reportPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, logs: undefined, reportPath }, null, 2));
  if (!result.passed) process.exitCode = 1;
} finally {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ id: ++requestId, method: 'Browser.close' }));
    socket.close();
  }
  browser?.kill();
  server.closeAllConnections();
  server.close();
}
