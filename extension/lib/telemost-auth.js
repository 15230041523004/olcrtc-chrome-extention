const DEFAULT_API = 'https://cloud-api.yandex.ru/telemost_front/v2/telemost';
const UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:149.0) Gecko/20100101 Firefox/149.0';

export async function issueTelemostConnection(roomUrl, displayName) {
  const encoded = encodeURIComponent(roomUrl);
  const url = new URL(`${DEFAULT_API}/conferences/${encoded}/connection`);
  url.searchParams.set('next_gen_media_platform_allowed', 'true');
  url.searchParams.set('display_name', displayName);
  url.searchParams.set('waiting_room_supported', 'true');

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      Accept: '*/*',
      'Content-Type': 'application/json',
      'User-Agent': UA,
      'Client-Instance-Id': crypto.randomUUID(),
      'X-Telemost-Client-Version': '187.1.0',
      'Idempotency-Key': crypto.randomUUID(),
      Origin: 'https://telemost.yandex.ru',
      Referer: 'https://telemost.yandex.ru/',
    },
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`telemost auth HTTP ${res.status}: ${text.slice(0, 180)}`);
  }

  let info;
  try {
    info = JSON.parse(text);
  } catch {
    throw new Error('telemost auth: response is not JSON');
  }

  const mediaServerURL =
    info?.client_configuration?.media_server_url ||
    info?.clientConfiguration?.mediaServerUrl ||
    '';
  const peerID = info?.peer_id || info?.peerId || '';
  const roomID = info?.room_id || info?.roomId || '';
  const credentials = info?.credentials || '';

  if (!mediaServerURL || !peerID || !roomID) {
    throw new Error('telemost auth: missing media_server_url / peer_id / room_id');
  }

  return {
    mediaServerURL,
    peerID,
    roomID,
    credentials,
    roomURL: roomUrl,
  };
}

export function wsHost(mediaServerURL) {
  try {
    return new URL(mediaServerURL).host;
  } catch {
    return '(invalid-ws-url)';
  }
}
