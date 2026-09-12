// Serialized into the isolated fixture extension's service worker by check-privacy.mjs.
export async function runPrivacyFixture(port) {
  const { intercept, guard } = globalThis;
  const origin = `http://127.0.0.1:${port}`;
  const requests = [];
  globalThis.testLogs = [];
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function waitFor(fn) {
    for (let i = 0; i < 100; i++) { if (await fn()) return; await delay(50); }
    throw new Error('Fixture wait timed out');
  }
  intercept.configureIntercept({
    log: (line) => testLogs.push(line),
    proxy: async (req) => {
      requests.push(req.url);
      const pathname = new URL(req.url).pathname;
      const isPage = pathname === '/page' || pathname === '/frame';
      let body = isPage ? '<!doctype html><title>Tunnel fixture</title><body>TUNNEL</body>' : 'PROXIED';
      if (pathname === '/worker.js') body = `fetch('${origin}/worker-fetch').then(r => r.text()).then(text => postMessage(text))`;
      return {
        ok: true, status: 200, bodyB64: btoa(body),
        headers: [{ name: 'Content-Type', value: isPage ? 'text/html' : pathname === '/worker.js' ? 'text/javascript' : 'text/plain' }],
      };
    },
  });
  await guard.enableNetworkGuard();
  const tab = await chrome.tabs.create({ url: `${origin}/page`, active: true });
  intercept.setHandshakeOk(true);
  await intercept.startIntercept(tab.id);
  async function inPage(fn) {
    const result = await chrome.debugger.sendCommand({ tabId: tab.id }, 'Runtime.evaluate', {
      expression: `(${fn.toString()})()`, awaitPromise: true, returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result?.value;
  }
  await waitFor(() => inPage(() => document.title === 'Tunnel fixture'));
  check(await inPage(() => fetch('/fetch').then((r) => r.text())) === 'PROXIED', 'fetch must use tunnel');
  check(await inPage(() => new Promise((resolve) => {
    const worker = new Worker('/worker.js');
    worker.onmessage = (e) => { worker.terminate(); resolve(e.data); };
    worker.onerror = (e) => resolve(`ERROR: ${e.message}`);
  })) === 'PROXIED', 'worker fetch must use tunnel');
  await inPage(() => new Promise((resolve) => {
    const frame = document.createElement('iframe');
    frame.src = location.href.replace('127.0.0.1', 'localhost').replace('/page', '/frame');
    frame.onload = () => resolve(true);
    document.body.appendChild(frame);
  }));
  check(requests.includes(`http://localhost:${port}/frame`), 'cross-origin iframe must use tunnel');
  const protocols = await inPage(() => ['RTCPeerConnection', 'WebSocket', 'WebTransport'].map((key) => {
    try { new window[key]('https://example.test'); return 'opened'; } catch (e) { return e.name; }
  }));
  check(protocols.every((name) => name === 'NotAllowedError'), 'unproxied transports blocked');
  // An isolated JS world has the native WebSocket constructor, so this tests
  // browser-side blocking independently of the page's constructor stub.
  const { frameTree } = await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.getFrameTree');
  const { executionContextId } = await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.createIsolatedWorld', {
    frameId: frameTree.frame.id, worldName: 'native-network-probe',
  });
  const nativeSocket = await chrome.debugger.sendCommand({ tabId: tab.id }, 'Runtime.evaluate', {
    expression: `new Promise(resolve => { const socket = new WebSocket('ws://127.0.0.1:${port}/native-websocket'); socket.onopen = () => { socket.close(); resolve('LEAK'); }; socket.onerror = () => resolve('BLOCKED'); })`,
    contextId: executionContextId, awaitPromise: true, returnByValue: true,
  });
  check(nativeSocket.result?.value === 'BLOCKED', 'native WebSocket blocked by browser rules');
  // Bypass the JS coordinates stub to exercise the actual browser permission.
  const locationResult = await inPage(() => new Promise((resolve) => {
    delete navigator.geolocation;
    navigator.geolocation.getCurrentPosition(() => resolve('LEAK'), (error) => resolve(error.code));
  }));
  check(locationResult === 1, 'native geolocation must be denied');
  check((await chrome.privacy.network.networkPredictionEnabled.get({})).value === false, 'prediction disabled');

  intercept.setHandshakeOk(false);
  const offlineTab = await chrome.tabs.create({ url: `${origin}/offline`, active: false });
  await waitFor(() => intercept.getAttachedTabs().some((t) => t.id === offlineTab.id));
  check(await inPage(() => fetch('/during-outage').then(() => 'LEAK', () => 'BLOCKED')) === 'BLOCKED', 'outage must block');
  await intercept.stopIntercept();
  await chrome.tabs.update(tab.id, { url: `${origin}/detached` });
  await chrome.tabs.create({ url: `${origin}/unattached`, active: false });
  await delay(300);
  check(await (await fetch(`${origin}/carrier`)).text() === 'DIRECT', 'carrier must remain available');
  await guard.disableNetworkGuard();
  check(!await guard.isNetworkGuardEnabled(), 'explicit release removes guard');
  check((await chrome.privacy.network.networkPredictionEnabled.get({})).value === true, 'prediction preference restored');
  await chrome.tabs.update(tab.id, { url: `${origin}/released` });
  await delay(300);
  return { proxiedRequests: requests, protocols, nativeWebSocket: nativeSocket.result?.value, nativeLocationError: locationResult };
}
