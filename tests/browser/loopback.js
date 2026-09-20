import { monitorPublisher, requestPublisherKeyframe } from '../../extension/lib/publisher-monitor.js';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const logs = [];
const errors = [];
const pub = new RTCPeerConnection({ iceServers: [] });
const sub = new RTCPeerConnection({ iceServers: [] });
const senderWorker = new Worker('../../extension/transform-worker.js', { type: 'module' });
const receiverWorker = new Worker('./receiver.js', { type: 'module' });
let stream;
let paintTimer;
let stopMonitor;

async function waitUntil(predicate, label) {
  const started = performance.now();
  while (!predicate()) {
    if (performance.now() - started > 10_000) throw new Error(`timeout: ${label}`);
    await pause(25);
  }
}

async function outbound(sender) {
  return [...(await sender.getStats()).values()].filter((s) => s.type === 'outbound-rtp' && s.kind === 'video')
    .map(({ packetsSent, bytesSent, framesEncoded, keyFramesEncoded, pliCount }) => ({ packetsSent, bytesSent, framesEncoded, keyFramesEncoded, pliCount }));
}

async function run() {
  let ready = false;
  senderWorker.onmessage = ({ data }) => {
    if (data.type === 'tunnel.ready') ready = true;
    if (data.line) logs.push(data.line);
    if (data.type === 'error' || data.type === 'pipeError') errors.push(data.message);
  };
  senderWorker.onerror = receiverWorker.onerror = (event) => errors.push(event.message);
  senderWorker.postMessage({ type: 'startTunnel', config: {
    roomId: 'local-loopback-test', keyHex: '17'.repeat(32), deviceId: 'chrome-local-test',
  } });
  await waitUntil(() => ready, 'tunnel worker ready');
  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d', { alpha: false });
  let tick = 0;
  const paint = () => {
    tick++;
    ctx.fillStyle = `rgb(${32 + tick % 48},${16 + tick % 32},40)`;
    ctx.fillRect(0, 0, 16, 16);
    ctx.fillStyle = '#9cf';
    ctx.fillRect(tick % 16, (tick * 3) % 16, 3, 3);
  };
  paint();
  stream = canvas.captureStream(30);
  paintTimer = setInterval(paint, 33);
  const sender = pub.addTrack(stream.getVideoTracks()[0], stream);
  const transceiver = pub.getTransceivers()[0];
  transceiver.setCodecPreferences(RTCRtpSender.getCapabilities('video').codecs.filter((c) => c.mimeType.toLowerCase() === 'video/vp8'));
  sender.transform = new RTCRtpScriptTransform(senderWorker, { name: 'sender', mode: 'identity' });
  sub.ontrack = ({ receiver, track }) => {
    receiver.transform = new RTCRtpScriptTransform(receiverWorker);
    document.getElementById('remote').srcObject = new MediaStream([track]);
  };
  await pub.setLocalDescription(await pub.createOffer());
  await waitUntil(() => pub.iceGatheringState === 'complete', 'publisher ICE');
  await sub.setRemoteDescription(pub.localDescription);
  await sub.setLocalDescription(await sub.createAnswer());
  await waitUntil(() => sub.iceGatheringState === 'complete', 'subscriber ICE');
  await pub.setRemoteDescription(sub.localDescription);
  await waitUntil(() => pub.connectionState === 'connected', 'peer connection');
  // Verify the hint on clean VP8 first, so decoder PLI requests from the
  // stuffed samples cannot explain the additional keyframe.
  await pause(1500);
  const cleanBefore = await outbound(sender);
  await requestPublisherKeyframe(sender);
  await pause(500);
  const cleanAfter = await outbound(sender);
  const cleanHintWorks = cleanAfter[0].keyFramesEncoded > cleanBefore[0].keyFramesEncoded && cleanAfter[0].pliCount === cleanBefore[0].pliCount;
  senderWorker.postMessage({ type: 'setMode', mode: 'tunnel' });
  senderWorker.postMessage({ type: 'mediaReady' });
  await pause(100);
  receiverWorker.postMessage('tunnel');
  await pause(2500);
  const before = await outbound(sender);
  stopMonitor = monitorPublisher(pub, sender, (line) => logs.push(line), () => true);
  await pause(4500);
  const after = await outbound(sender);
  const received = await new Promise((resolve) => {
    receiverWorker.onmessage = ({ data }) => {
      if (data.type === 'snapshot') resolve(data);
      if (data.type === 'error') errors.push(data.message);
    };
    receiverWorker.postMessage('snapshot');
  });
  const keyframeIncrease = after[0].keyFramesEncoded - before[0].keyFramesEncoded;
  const passed = cleanHintWorks && errors.length === 0 && received.dataSamples >= 2 && received.badHeaders === 0 && received.badKcp === 0 && received.badCrc32c === 0 && keyframeIncrease >= 2;
  return { passed, browser: navigator.userAgent, cleanBefore, cleanAfter, cleanHintWorks, before, after, keyframeIncrease, received, errors, logs };
}

try {
  globalThis.loopbackResult = await run();
} catch (error) {
  globalThis.loopbackResult = { passed: false, error: error.message, logs, errors };
} finally {
  stopMonitor?.();
  clearInterval(paintTimer);
  pub.close();
  sub.close();
  stream?.getTracks().forEach((track) => track.stop());
  senderWorker.terminate();
  receiverWorker.terminate();
  document.getElementById('result').textContent = JSON.stringify(globalThis.loopbackResult, null, 2);
}
