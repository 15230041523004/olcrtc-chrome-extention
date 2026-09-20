import { preferVp8OnTransceiver, preferVp8Sdp, enhanceSdpBandwidth, isIPv4IceCandidate } from './sdp-vp8.js';

const UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:149.0) Gecko/20100101 Firefox/149.0';
const DEFAULT_STUN = 'stun:stun.rtc.yandex.net:3478';
const SUB_TIMEOUT_MS = 20_000;
const PUB_OFFER_DELAY_MS = 300;

export function goolomCapabilitiesOffer() {
  return {
    offerAnswerMode: ['SEPARATE'],
    initialSubscriberOffer: ['ON_HELLO'],
    slotsMode: ['FROM_CONTROLLER'],
    simulcastMode: ['DISABLED', 'STATIC'],
    selfVadStatus: ['FROM_SERVER', 'FROM_CLIENT'],
    dataChannelSharing: ['TO_RTP'],
    videoEncoderConfig: ['NO_CONFIG', 'ONLY_INIT_CONFIG', 'RUNTIME_CONFIG'],
    dataChannelVideoCodec: ['VP8', 'UNIQUE_CODEC_FROM_TRACK_DESCRIPTION'],
    bandwidthLimitationReason: ['BANDWIDTH_REASON_DISABLED', 'BANDWIDTH_REASON_ENABLED'],
    sdkDefaultDeviceManagement: [
      'SDK_DEFAULT_DEVICE_MANAGEMENT_DISABLED',
      'SDK_DEFAULT_DEVICE_MANAGEMENT_ENABLED',
    ],
    joinOrderLayout: ['JOIN_ORDER_LAYOUT_DISABLED', 'JOIN_ORDER_LAYOUT_ENABLED'],
    pinLayout: ['PIN_LAYOUT_DISABLED'],
    sendSelfViewVideoSlot: [
      'SEND_SELF_VIEW_VIDEO_SLOT_DISABLED',
      'SEND_SELF_VIEW_VIDEO_SLOT_ENABLED',
    ],
    serverLayoutTransition: ['SERVER_LAYOUT_TRANSITION_DISABLED'],
    sdkPublisherOptimizeBitrate: [
      'SDK_PUBLISHER_OPTIMIZE_BITRATE_DISABLED',
      'SDK_PUBLISHER_OPTIMIZE_BITRATE_FULL',
      'SDK_PUBLISHER_OPTIMIZE_BITRATE_ONLY_SELF',
    ],
    sdkNetworkLostDetection: ['SDK_NETWORK_LOST_DETECTION_DISABLED'],
    sdkNetworkPathMonitor: ['SDK_NETWORK_PATH_MONITOR_DISABLED'],
    publisherVp9: ['PUBLISH_VP9_DISABLED', 'PUBLISH_VP9_ENABLED'],
    svcMode: ['SVC_MODE_DISABLED', 'SVC_MODE_L3T3', 'SVC_MODE_L3T3_KEY'],
    subscriberOfferAsyncAck: [
      'SUBSCRIBER_OFFER_ASYNC_ACK_DISABLED',
      'SUBSCRIBER_OFFER_ASYNC_ACK_ENABLED',
    ],
    androidBluetoothRoutingFix: ['ANDROID_BLUETOOTH_ROUTING_FIX_DISABLED'],
    fixedIceCandidatesPoolSize: ['FIXED_ICE_CANDIDATES_POOL_SIZE_DISABLED'],
    sdkAndroidTelecomIntegration: ['SDK_ANDROID_TELECOM_INTEGRATION_DISABLED'],
    setActiveCodecsMode: ['SET_ACTIVE_CODECS_MODE_DISABLED', 'SET_ACTIVE_CODECS_MODE_VIDEO_ONLY'],
    subscriberDtlsPassiveMode: ['SUBSCRIBER_DTLS_PASSIVE_MODE_DISABLED'],
    publisherOpusDred: ['PUBLISHER_OPUS_DRED_DISABLED'],
    publisherOpusLowBitrate: ['PUBLISHER_OPUS_LOW_BITRATE_DISABLED'],
    sdkAndroidDestroySessionOnTaskRemoved: ['SDK_ANDROID_DESTROY_SESSION_ON_TASK_REMOVED_DISABLED'],
    svcModes: ['FALSE'],
    reportTelemetryModes: ['TRUE'],
    keepDefaultDevicesModes: ['FALSE'],
  };
}

/**
 * @typedef {object} GoolomHooks
 * @property {(line: string, extra?: object) => void} log
 * @property {(ev: object) => void} [onEvent]
 * @property {(pc: RTCPeerConnection, sender: RTCRtpSender) => void} [onPublisherSender]
 * @property {(receiver: RTCRtpReceiver, track: MediaStreamTrack) => void} [onSubscriberTrack]
 */

export class GoolomSession {
  /**
   * @param {object} creds
   * @param {MediaStreamTrack} videoTrack
   * @param {GoolomHooks} hooks
   */
  constructor(creds, videoTrack, hooks) {
    this.creds = creds;
    this.videoTrack = videoTrack;
    this.log = hooks.log;
    this.onEvent = hooks.onEvent || (() => {});
    this.onPublisherSender = hooks.onPublisherSender || (() => {});
    this.onSubscriberTrack = hooks.onSubscriberTrack || (() => {});

    this.pub = null;
    this.sub = null;
    this.ws = null;
    this.closed = false;
    this.pubSent = false;
    this.keepAliveTimer = null;
    this.appPingTimer = null;
    this.telemetryTimer = null;
    this.subConnected = defer();
    this.remoteVideo = new MediaStream();
  }

  async connect() {
    this.assertTransform();
    const ice = { iceServers: [{ urls: [DEFAULT_STUN] }] };
    this.sub = new RTCPeerConnection(ice);
    this.pub = new RTCPeerConnection(ice);

    this.sub.addEventListener('connectionstatechange', () => {
      const s = this.sub.connectionState;
      this.log(`goolom subscriber state: ${s}`);
      if (s === 'connected') {
        this.log('sub.connected');
        this.onEvent({ type: 'sub.connected' });
        this.subConnected.resolve();
      }
      if (s === 'failed' || s === 'disconnected') {
        this.onEvent({ type: 'pc.failed', side: 'subscriber', state: s });
      }
    });
    this.pub.addEventListener('connectionstatechange', () => {
      const s = this.pub.connectionState;
      this.log(`goolom publisher state: ${s}`);
      if (s === 'connected') {
        this.log('pub.connected');
        this.onEvent({ type: 'pub.connected' });
      }
      if (s === 'failed') {
        this.log('goolom publisher PC failed - reconnect needed');
        this.onEvent({ type: 'pc.failed', side: 'publisher', state: s });
      }
    });

    this.sub.addEventListener('track', (ev) => this.handleTrack(ev));
    this.sub.addEventListener('icecandidate', (ev) => this.sendIce(ev.candidate, 'SUBSCRIBER'));
    this.pub.addEventListener('icecandidate', (ev) => this.sendIce(ev.candidate, 'PUBLISHER'));

    const sender = this.pub.addTrack(this.videoTrack);
    const trx = this.pub.getTransceivers().find((t) => t.sender === sender);
    const vp8ok = preferVp8OnTransceiver(trx);
    this.log(`codec.vp8 prefer=${vp8ok}`);
    this.onPublisherSender(this.pub, sender);

    await this.dialWs();
    this.readLoop();
    this.startKeepalives();
    await this.sendHello();

    await Promise.race([
      this.subConnected.promise,
      sleep(SUB_TIMEOUT_MS).then(() => {
        throw new Error('subscriber media timeout');
      }),
    ]);
  }

  assertTransform() {
    if (!('RTCRtpScriptTransform' in globalThis) || !('transform' in RTCRtpSender.prototype)) {
      throw new Error('Chrome 141+ Encoded Transform required (RTCRtpSender.transform missing)');
    }
  }

  handleTrack(ev) {
    const track = ev.track;
    if (track.kind !== 'video') {
      track.stop();
      return;
    }
    for (const t of ev.streams?.[0]?.getTracks?.() ?? [track]) {
      if (t.kind === 'video') this.remoteVideo.addTrack(t);
    }
    const receiver = ev.receiver;
    const mime = mimeOfReceiver(receiver);
    this.log(`goolom remote video track: codec=${mime} id=${track.id}`);
    if ((mime || '').toLowerCase().includes('vp8') || mime === '') {
      this.log(`remote.vp8 mime=${mime || 'pending'}`);
      this.onEvent({ type: 'remote.vp8', mime });
    }
    this.onSubscriberTrack(receiver, track);
  }

  async dialWs() {
    const url = this.creds.mediaServerURL;
    this.ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('signaling websocket timeout')), 15_000);
      this.ws.addEventListener('open', () => {
        clearTimeout(t);
        resolve();
      });
      this.ws.addEventListener('error', () => {
        clearTimeout(t);
        reject(new Error('signaling websocket error'));
      });
    });
    this.log('ws.open');
    this.onEvent({ type: 'ws.open' });
  }

  async sendHello() {
    const hello = {
      uid: crypto.randomUUID(),
      hello: {
        participantMeta: {
          name: this.creds.name,
          role: 'SPEAKER',
          description: '',
          sendAudio: false,
          sendVideo: true,
        },
        participantAttributes: {
          name: this.creds.name,
          role: 'SPEAKER',
          description: '',
        },
        sendAudio: false,
        sendVideo: true,
        sendSharing: false,
        participantId: this.creds.peerID,
        roomId: this.creds.roomID,
        serviceName: 'telemost',
        credentials: this.creds.credentials,
        capabilitiesOffer: goolomCapabilitiesOffer(),
        sdkInfo: {
          implementation: 'browser',
          version: '5.27.0',
          userAgent: UA,
          hwConcurrency: navigator.hardwareConcurrency || 4,
        },
        sdkInitializationId: crypto.randomUUID(),
        disablePublisher: false,
        disableSubscriber: false,
        disableSubscriberAudio: true,
      },
    };
    this.sendJson(hello);
    this.log('hello.sent');
    this.onEvent({ type: 'hello.sent' });
  }

  sendJson(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('goolom signaling websocket closed');
    }
    this.ws.send(JSON.stringify(obj));
  }

  sendAck(uid) {
    if (!uid) return;
    try {
      this.sendJson({
        uid,
        ack: { status: { code: 'OK' } },
      });
    } catch (err) {
      this.log(`goolom: ack ${uid}: ${err.message}`);
    }
  }

  sendPong(uid) {
    try {
      this.sendJson({ uid, pong: {} });
    } catch (err) {
      this.log(`goolom: pong: ${err.message}`);
    }
  }

  sendIce(candidate, target) {
    if (!candidate || this.closed) return;
    const init = candidate.toJSON();
    const candStr = init.candidate || '';
    if (!isIPv4IceCandidate(candStr)) {
      return;
    }
    try {
      this.sendJson({
        uid: crypto.randomUUID(),
        webrtcIceCandidate: {
          candidate: candStr,
          sdpMid: init.sdpMid,
          sdpMlineIndex: init.sdpMLineIndex,
          sdpMLineIndex: init.sdpMLineIndex,
          target,
          pcSeq: 1,
        },
      });
    } catch (err) {
      this.log(`goolom: ice candidate (${target}): ${err.message}`);
    }
  }

  startKeepalives() {
    this.keepAliveTimer = setInterval(() => {
      /* browser WS stack sends protocol pings; app ping is what Goolom counts */
    }, 30_000);
    this.appPingTimer = setInterval(() => {
      if (this.closed) return;
      try {
        this.sendJson({ uid: crypto.randomUUID(), ping: {} });
      } catch {
        this.onEvent({ type: 'ws.dead' });
      }
    }, 5_000);
  }

  async readLoop() {
    this._msgChain = Promise.resolve();
    this.ws.addEventListener('message', (ev) => {
      this._msgChain = this._msgChain
        .then(() => this.onMessage(ev.data))
        .catch((err) => this.log(`signaling: ${err.message}`));
    });
    this.ws.addEventListener('close', () => {
      if (!this.closed) this.onEvent({ type: 'ws.close' });
    });
  }

  async onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const uid = typeof msg.uid === 'string' ? msg.uid : '';

    if (msg.ack) return;

    if (msg.serverHello && typeof msg.serverHello === 'object') {
      this.log('serverHello');
      this.onEvent({ type: 'serverHello' });
      this.applyServerHello(msg.serverHello);
      this.startTelemetry(msg.serverHello);
      this.sendAck(uid);
    }

    if (isConferenceEnd(msg)) {
      this.log('conference ended');
      this.onEvent({ type: 'conference.ended' });
      return;
    }

    if (msg.subscriberSdpOffer && typeof msg.subscriberSdpOffer === 'object') {
      try {
        await this.handleSdpOffer(msg.subscriberSdpOffer, uid, !this.pubSent);
        this.pubSent = true;
      } catch (err) {
        this.log(`sdp offer error: ${err.message}`);
      }
    }

    if (msg.publisherSdpAnswer && typeof msg.publisherSdpAnswer === 'object') {
      await this.handleSdpAnswer(msg.publisherSdpAnswer, uid);
    }

    if (msg.webrtcIceCandidate && typeof msg.webrtcIceCandidate === 'object') {
      this.handleRemoteIce(msg.webrtcIceCandidate);
    }

    for (const key of [
      'updateDescription',
      'upsertDescription',
      'removeDescription',
      'slotsConfig',
      'slotsMeta',
      'vadActivity',
      'pong',
    ]) {
      if (key in msg) this.sendAck(uid);
    }
    if (msg.ping) this.sendPong(uid);
  }

  applyServerHello(serverHello) {
    const rawCfg = serverHello.rtcConfiguration;
    const rawServers = rawCfg?.iceServers;
    if (!Array.isArray(rawServers) || !rawServers.length) return;
    const iceServers = [];
    for (const s of rawServers) {
      const parsed = parseIceServer(s);
      if (parsed) iceServers.push(parsed);
    }
    if (!iceServers.length) return;
    const cfg = { iceServers };
    try {
      this.sub?.setConfiguration(cfg);
      this.pub?.setConfiguration(cfg);
      this.log(`ice.set servers=${iceServers.length}`);
    } catch (err) {
      this.log(`ice.setConfiguration: ${err.message}`);
    }
  }

  async handleSdpOffer(offer, uid, sendPub) {
    const sdp = offer.sdp;
    const pcSeq = Number(offer.pcSeq) || 0;
    await this.sub.setRemoteDescription({ type: 'offer', sdp });
    let answer = await this.sub.createAnswer();
    const enhancedAnswerSdp = enhanceSdpBandwidth(preferVp8Sdp(answer.sdp));
    try {
      await this.sub.setLocalDescription({ type: 'answer', sdp: enhancedAnswerSdp });
    } catch {
      await this.sub.setLocalDescription(answer);
    }
    this.sendJson({
      uid: crypto.randomUUID(),
      subscriberSdpAnswer: {
        pcSeq,
        sdp: this.sub.localDescription.sdp || enhancedAnswerSdp,
      },
    });
    this.sendAck(uid);
    try {
      await this.sendSetSlots();
    } catch (err) {
      this.log(`setSlots error: ${err.message}`);
    }
    if (!sendPub) return;

    await sleep(PUB_OFFER_DELAY_MS);
    let pubOffer = await this.pub.createOffer();
    const enhancedPubSdp = enhanceSdpBandwidth(preferVp8Sdp(pubOffer.sdp));
    pubOffer = { type: 'offer', sdp: enhancedPubSdp };
    try {
      await this.pub.setLocalDescription(pubOffer);
    } catch {
      await this.pub.setLocalDescription(await this.pub.createOffer());
    }
    this.sendJson({
      uid: crypto.randomUUID(),
      publisherSdpOffer: {
        pcSeq: 1,
        sdp: this.pub.localDescription.sdp || enhancedPubSdp,
        tracks: this.publisherTrackDescriptions(),
      },
    });
    this.log('publisherSdpOffer.sent');
  }

  async handleSdpAnswer(answer, uid) {
    const sdp = answer.sdp;
    try {
      await this.pub.setRemoteDescription({ type: 'answer', sdp });
    } catch (err) {
      this.log(`goolom publisher SetRemoteDescription failed: ${err.message}`);
    }
    this.sendAck(uid);
  }

  handleRemoteIce(cand) {
    const candStr = cand.candidate;
    if (!candStr) return;
    const init = {
      candidate: candStr,
      sdpMid: cand.sdpMid ?? null,
      sdpMLineIndex: cand.sdpMlineIndex ?? cand.sdpMLineIndex ?? 0,
    };
    const target = cand.target;
    const pc = target === 'PUBLISHER' ? this.pub : this.sub;
    pc?.addIceCandidate(init).catch(() => {});
  }

  async sendSetSlots() {
    const slots = Array.from({ length: 8 }, (_, i) => ({
      width: i === 0 ? 3840 : 1920,
      height: i === 0 ? 2160 : 1080,
    }));
    this.sendJson({
      uid: crypto.randomUUID(),
      setSlots: {
        slots,
        audioSlotsCount: 0,
        key: 1,
        shutdownAllVideo: null,
        withSelfView: false,
        selfViewVisibility: 'ON_LOADING_THEN_SHOW',
        gridConfig: {},
      },
    });
    this.log('setSlots.sent');
  }

  publisherTrackDescriptions() {
    const tracks = [];
    for (const transceiver of this.pub.getTransceivers()) {
      const sender = transceiver.sender;
      const track = sender?.track;
      if (!track) continue;
      tracks.push({
        mid: transceiver.mid,
        transceiverMid: transceiver.mid,
        kind: track.kind === 'audio' ? 'AUDIO' : 'VIDEO',
        priority: 0,
        label: track.id,
        codecs: {},
        groupId: 1,
        description: '',
      });
    }
    return tracks;
  }

  startTelemetry(serverHello) {
    const cfg = serverHello.telemetryConfiguration;
    if (!cfg || typeof cfg !== 'object') return;
    let endpoint = cfg.logEndpoint || cfg.endpoint || cfg.url;
    if (typeof endpoint !== 'string' || !endpoint.startsWith('https://')) return;
    let interval = Number(cfg.sendingInterval);
    if (!Number.isFinite(interval) || interval < 1000) interval = 20_000;
    if (interval > 5 * 60_000) interval = 5 * 60_000;

    const send = (event) => {
      const body = JSON.stringify({
        event,
        timestamp: Date.now(),
        peerId: this.creds.peerID,
        roomId: this.creds.roomID,
        displayName: this.creds.name,
        implementation: 'browser',
        dataChannel: { bufferedAmount: 0, sendQueue: 0 },
      });
      fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': UA,
          Referer: this.creds.roomURL || '',
          'X-Requested-With': 'XMLHttpRequest',
          'Client-Instance-Id': crypto.randomUUID(),
          'X-Telemost-Client-Version': '187.1.0',
          'Idempotency-Key': crypto.randomUUID(),
        },
        body,
      }).catch(() => {});
    };
    send('join');
    this.telemetryTimer = setInterval(() => send('stats'), interval);
    this._telemetryLeave = () => send('leave');
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.keepAliveTimer);
    clearInterval(this.appPingTimer);
    clearInterval(this.telemetryTimer);
    try {
      this._telemetryLeave?.();
    } catch {
      /* ignore */
    }
    try {
      this.sendJson({ uid: crypto.randomUUID(), leave: {} });
    } catch {
      /* ignore */
    }
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    try {
      this.pub?.close();
    } catch {
      /* ignore */
    }
    try {
      this.sub?.close();
    } catch {
      /* ignore */
    }
  }
}

function parseIceServer(raw) {
  if (!raw || typeof raw !== 'object') return null;
  let urls = raw.urls;
  if (typeof urls === 'string') urls = [urls];
  if (!Array.isArray(urls) || !urls.length) return null;
  const ice = { urls };
  if (raw.username) ice.username = raw.username;
  if (raw.credential) ice.credential = raw.credential;
  return ice;
}

function mimeOfReceiver(receiver) {
  try {
    const params = receiver.getParameters?.();
    const c = params?.codecs?.[0];
    return c?.mimeType || '';
  } catch {
    return '';
  }
}

function isConferenceEnd(msg) {
  for (const key of ['conferenceClosed', 'conferenceEnded', 'roomClosed', 'roomEnded', 'callEnded']) {
    if (key in msg) return true;
  }
  const state = msg.conference?.state || msg.conferenceState?.state;
  if (typeof state === 'string') {
    const s = state.toLowerCase();
    return s === 'closed' || s === 'ended' || s === 'finished' || s === 'terminated';
  }
  return false;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function defer() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
