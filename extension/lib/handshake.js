/** Handshake v3 + control ping/pong on the first smux stream. */

export const HELLO = 'CLIENT_HELLO';
export const WELCOME = 'SERVER_WELCOME';
export const REJECT = 'SERVER_REJECT';
export const PING = 'CONTROL_PING';
export const PONG = 'CONTROL_PONG';
export const PROTO = 3;
export const CTRL_PROTO = 1;

function writeFrame(stream, obj) {
  const json = new TextEncoder().encode(JSON.stringify(obj));
  const buf = new Uint8Array(4 + json.length);
  new DataView(buf.buffer).setUint32(0, json.length);
  buf.set(json, 4);
  stream.write(buf);
}

async function readFrame(stream, max = 64 * 1024) {
  const hdr = await stream.readFull(4);
  const size = new DataView(hdr.buffer).getUint32(0);
  if (size === 0 || size > max) throw new Error(`handshake: bad frame size ${size}`);
  return JSON.parse(new TextDecoder().decode(await stream.readFull(size)));
}

function randomChallenge() {
  const raw = crypto.getRandomValues(new Uint8Array(16));
  return [...raw].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function clientHandshake(stream, deviceId) {
  const challenge = randomChallenge();
  writeFrame(stream, {
    version: PROTO,
    type: HELLO,
    device_id: deviceId,
    challenge,
  });
  for (;;) {
    const msg = await readFrame(stream);
    if (msg.challenge !== challenge) continue;
    if (msg.type === REJECT) {
      throw new Error(`handshake rejected: ${msg.reason || ''}`);
    }
    if (msg.type !== WELCOME) {
      throw new Error(`handshake unexpected ${msg.type}`);
    }
    if (msg.version !== PROTO) {
      throw new Error(`handshake version ${msg.version}`);
    }
    return { sessionId: msg.session_id, peerId: msg.peer_id, challenge };
  }
}

export function sendPing(stream, seq) {
  writeFrame(stream, {
    version: CTRL_PROTO,
    type: PING,
    seq,
    sent_unix_nano: Date.now() * 1e6,
  });
}

export function sendPong(stream, ping) {
  writeFrame(stream, {
    version: CTRL_PROTO,
    type: PONG,
    seq: ping.seq,
    sent_unix_nano: ping.sent_unix_nano,
  });
}

export async function readControl(stream) {
  return readFrame(stream, 16 * 1024);
}

export { writeFrame, readFrame };
