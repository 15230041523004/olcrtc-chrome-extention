/**
 * Compact olcrtc URI v1.
 * olcrtc://<Provider>?<Transport><k=v&k=v>@<RoomID>#<EncryptionKey>$<comment>
 */

const TELEMOST_PREFIX = 'https://telemost.yandex.ru/j/';

export function parseOlcrtcUri(raw) {
  const s = String(raw ?? '').trim();
  if (!s.startsWith('olcrtc://')) {
    throw new Error('URI must start with olcrtc://');
  }
  const rest = s.slice('olcrtc://'.length);
  const q = rest.indexOf('?');
  if (q < 0) {
    throw new Error('URI missing ?transport');
  }
  const provider = rest.slice(0, q).toLowerCase();
  if (!provider) {
    throw new Error('URI missing provider');
  }

  const at = rest.indexOf('@', q + 1);
  if (at < 0) {
    throw new Error('URI missing @room');
  }
  const hash = rest.indexOf('#', at + 1);
  if (hash < 0) {
    throw new Error('URI missing #key');
  }
  const dollar = rest.indexOf('$', hash + 1);

  const transportAndParams = rest.slice(q + 1, at);
  let transport = transportAndParams;
  const params = {};
  const lt = transportAndParams.indexOf('<');
  if (lt >= 0) {
    if (!transportAndParams.endsWith('>')) {
      throw new Error('URI transport params not closed with >');
    }
    transport = transportAndParams.slice(0, lt);
    const body = transportAndParams.slice(lt + 1, -1);
    for (const part of body.split('&')) {
      if (!part) continue;
      const eq = part.indexOf('=');
      if (eq < 0) params[part] = '';
      else params[decodeURIComponent(part.slice(0, eq))] = decodeURIComponent(part.slice(eq + 1));
    }
  }
  transport = transport.toLowerCase();

  const roomRaw = rest.slice(at + 1, hash);
  const key = (dollar < 0 ? rest.slice(hash + 1) : rest.slice(hash + 1, dollar)).trim();
  const comment = dollar < 0 ? '' : rest.slice(dollar + 1);

  if (!/^[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error('crypto key must be 64 hex characters');
  }

  const fps = intParam(params, 'vp8-fps', 30);
  const batch = intParam(params, 'vp8-batch', 64);

  const roomUrl = normalizeTelemostRoom(roomRaw);
  return {
    provider,
    transport,
    roomId: roomRaw,
    roomUrl,
    keyHex: key.toLowerCase(),
    comment,
    vp8: { fps, batchSize: batch },
    params,
  };
}

export function normalizeTelemostRoom(roomId) {
  const id = String(roomId ?? '').trim();
  if (!id) {
    throw new Error('room id is empty');
  }
  if (id.startsWith('https://') || id.startsWith('http://')) {
    return id;
  }
  return TELEMOST_PREFIX + id.replace(/^\/+/, '');
}

export function redactUri(uri) {
  try {
    const p = parseOlcrtcUri(uri);
    return `olcrtc://${p.provider}?${p.transport}@${p.roomId}#${p.keyHex.slice(0, 8)}…`;
  } catch {
    return '(invalid uri)';
  }
}

function intParam(params, key, fallback) {
  if (!(key in params) || params[key] === '') return fallback;
  const n = Number(params[key]);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}
