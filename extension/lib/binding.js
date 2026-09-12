import { bindingToken, hexU32 } from './vp8-wire.js';

/**
 * Native BindingToken(channelID, roomURL) hashes channelID if set, else room.id
 * as written in YAML — often the bare Telemost id, not the https URL.
 */
export function bindingCandidates({ roomId, roomUrl, apiRoomId, channelId }) {
  const out = [];
  const add = (label, source) => {
    if (source == null || source === '') return;
    if (out.some((c) => c.source === source)) return;
    out.push({ label, source, token: bindingToken('', source) });
  };
  add('channelId', channelId);
  add('uri.roomId', roomId);
  add('roomUrl', roomUrl);
  if (roomUrl && !roomUrl.endsWith('/')) add('roomUrl/', `${roomUrl}/`);
  add('api.room_id', apiRoomId);
  if (roomId && !String(roomId).startsWith('http')) {
    add('telemost-url', `https://telemost.yandex.ru/j/${roomId}`);
  }
  return out;
}

export function matchBindingToken(opts, wireToken) {
  const candidates = bindingCandidates(opts);
  const localBare = candidates.find((c) => c.label === 'uri.roomId') || candidates[0];
  let match = null;
  if (wireToken != null) {
    match = candidates.find((c) => c.token === (wireToken >>> 0)) || null;
  } else {
    match = localBare || null;
  }
  return {
    candidates,
    local: localBare || null,
    wire: wireToken == null ? null : wireToken >>> 0,
    match,
    ok: Boolean(match),
  };
}

export function formatBindingLog(result) {
  const lines = result.candidates.map(
    (c) => `  ${c.label} ${hexU32(c.token)} ${JSON.stringify(c.source)}`,
  );
  const wire = result.wire == null ? 'none' : hexU32(result.wire);
  const local = result.local ? hexU32(result.local.token) : 'none';
  const matched = result.match
    ? `${result.match.label} ${hexU32(result.match.token)}`
    : 'no';
  return `token local=${local} wire=${wire} match=${matched}\n${lines.join('\n')}`;
}
