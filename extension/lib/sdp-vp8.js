/** Prefer VP8 on a video transceiver / offer SDP. */

export function preferVp8OnTransceiver(transceiver) {
  if (!transceiver || typeof RTCRtpSender.getCapabilities !== 'function') return false;
  const caps = RTCRtpSender.getCapabilities('video');
  if (!caps?.codecs?.length) return false;
  const vp8 = [];
  const rtx = [];
  const rest = [];
  for (const c of caps.codecs) {
    const mime = (c.mimeType || '').toLowerCase();
    if (mime === 'video/vp8') vp8.push(c);
    else if (mime === 'video/rtx') rtx.push(c);
    else rest.push(c);
  }
  if (!vp8.length) return false;
  try {
    transceiver.setCodecPreferences([...vp8, ...rtx, ...rest]);
    return true;
  } catch {
    return false;
  }
}

export function preferVp8Sdp(sdp) {
  if (!sdp || !sdp.includes('m=video')) return sdp;
  const lines = sdp.split('\r\n');
  const videoIdx = lines.findIndex((l) => l.startsWith('m=video'));
  if (videoIdx < 0) return sdp;

  const pts = [];
  for (const line of lines) {
    const m = line.match(/^a=rtpmap:(\d+) VP8\/90000/i);
    if (m) pts.push(m[1]);
  }
  if (!pts.length) return sdp;

  const parts = lines[videoIdx].split(' ');
  if (parts.length < 4) return sdp;
  const header = parts.slice(0, 3);
  const payloads = parts.slice(3);
  const preferred = pts.filter((p) => payloads.includes(p));
  const others = payloads.filter((p) => !pts.includes(p));
  lines[videoIdx] = [...header, ...preferred, ...others].join(' ');
  return lines.join('\r\n');
}

export function isIPv4IceCandidate(candidate) {
  if (!candidate) return false;
  const body = candidate.startsWith('candidate:') ? candidate.slice('candidate:'.length) : candidate;
  const fields = body.split(' ');
  const ip = fields[4];
  if (!ip) return false;
  if (ip.endsWith('.local')) return true;
  if (ip.includes(':')) return false;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(ip);
}
