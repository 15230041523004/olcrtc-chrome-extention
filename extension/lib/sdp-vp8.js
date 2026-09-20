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
  const pts = [];
  for (const line of lines) {
    const m = line.match(/^a=rtpmap:(\d+)\s+VP8\/90000/i);
    if (m && !pts.includes(m[1])) pts.push(m[1]);
  }
  if (!pts.length) return sdp;

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('m=video')) continue;
    const parts = lines[i].split(' ');
    if (parts.length < 4) continue;
    const header = parts.slice(0, 3);
    const payloads = parts.slice(3);
    const preferred = pts.filter((p) => payloads.includes(p));
    const others = payloads.filter((p) => !pts.includes(p));
    lines[i] = [...header, ...preferred, ...others].join(' ');
  }
  return lines.join('\r\n');
}

/**
 * Injects RFC 3556 b=AS, RFC 3890 b=TIAS and Google WebRTC format parameters
 * into video sections of SDP to remove receiver/sender BWE throughput caps.
 *
 * @param {string} sdp
 * @param {number} [kbps=120000] Target max bandwidth in kilobits per second (e.g. 120000 = 120 Mbps)
 * @returns {string}
 */
export function enhanceSdpBandwidth(sdp, kbps = 120_000) {
  if (!sdp || !sdp.includes('m=video')) return sdp;
  const targetKbps = Math.max(10_000, Number(kbps) || 120_000);
  const targetBps = targetKbps * 1000;
  const minKbps = Math.min(25_000, Math.floor(targetKbps / 4));
  const startKbps = Math.min(50_000, Math.floor(targetKbps / 2));

  const lines = sdp.split('\r\n');
  const result = [];
  let inVideo = false;
  let videoInsertedBw = false;
  const vp8Pts = new Set();

  for (const line of lines) {
    const m = line.match(/^a=rtpmap:(\d+)\s+VP8\/90000/i);
    if (m) vp8Pts.add(m[1]);
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('m=video')) {
      inVideo = true;
      videoInsertedBw = false;
      result.push(line);
      continue;
    }
    if (inVideo && line.startsWith('m=')) {
      inVideo = false;
    }

    if (inVideo) {
      if (line.startsWith('b=AS:') || line.startsWith('b=TIAS:')) {
        continue;
      }
      if (!videoInsertedBw && (line.startsWith('a=') || line.startsWith('c='))) {
        if (line.startsWith('c=')) {
          result.push(line);
          result.push(`b=AS:${targetKbps}`);
          result.push(`b=TIAS:${targetBps}`);
          videoInsertedBw = true;
          continue;
        } else {
          result.push(`b=AS:${targetKbps}`);
          result.push(`b=TIAS:${targetBps}`);
          videoInsertedBw = true;
        }
      }

      let handledFmtp = false;
      for (const pt of vp8Pts) {
        if (line.startsWith(`a=fmtp:${pt} `) || line === `a=fmtp:${pt}`) {
          handledFmtp = true;
          let fmtp = line;
          if (!fmtp.includes('x-google-max-bitrate')) {
            fmtp += `;x-google-min-bitrate=${minKbps};x-google-max-bitrate=${targetKbps};x-google-start-bitrate=${startKbps}`;
          }
          result.push(fmtp);
          break;
        }
      }
      if (handledFmtp) continue;

      result.push(line);

      for (const pt of vp8Pts) {
        if (line.startsWith(`a=rtpmap:${pt} VP8/90000`)) {
          const hasFmtp = lines.some((l) => l.startsWith(`a=fmtp:${pt} `) || l === `a=fmtp:${pt}`);
          if (!hasFmtp) {
            result.push(
              `a=fmtp:${pt} x-google-min-bitrate=${minKbps};x-google-max-bitrate=${targetKbps};x-google-start-bitrate=${startKbps}`,
            );
          }
        }
      }
      continue;
    }

    result.push(line);
  }

  return result.join('\r\n');
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
