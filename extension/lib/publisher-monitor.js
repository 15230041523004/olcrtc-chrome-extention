/** Chrome's keyframe request API is the second argument of setParameters().
 * https://w3c.github.io/webrtc-extensions/#rtcrtpsender-setparameters-keyframe
 */
export async function requestPublisherKeyframe(sender) {
  const parameters = sender.getParameters();
  if (!parameters.encodings?.length) return false; // negotiation is not ready
  await sender.setParameters(parameters, {
    encodingOptions: parameters.encodings.map(() => ({ keyFrame: true })),
  });
  return true;
}

export function monitorPublisher(pc, sender, log, isTunnel) {
  let stopped = false;
  let pending = false;
  let requests = 0;
  let lastStats = -Infinity;
  let errorLogged = false;
  let hintErrorLogged = false;
  const tick = async () => {
    if (stopped || pending || pc.connectionState !== 'connected') return;
    pending = true;
    try {
      if (isTunnel()) {
        try {
          if (await requestPublisherKeyframe(sender)) requests++;
          hintErrorLogged = false;
        } catch (err) {
          if (!stopped && !hintErrorLogged) log(`keyframe.hint error=${err.message}`);
          hintErrorLogged = true;
        }
      }
      if (stopped) return;
      if (performance.now() - lastStats >= 1900) {
        lastStats = performance.now();
        const report = await sender.getStats();
        if (stopped) return;
        for (const stat of report.values()) {
          if (stat.type !== 'outbound-rtp' || stat.kind !== 'video') continue;
          const codec = report.get(stat.codecId)?.mimeType || 'unknown';
          log(`media.out codec=${codec} packets=${stat.packetsSent ?? 0} bytes=${stat.bytesSent ?? 0} frames=${stat.framesEncoded ?? 0} keys=${stat.keyFramesEncoded ?? 0} keyRequests=${requests} pli=${stat.pliCount ?? 0} nack=${stat.nackCount ?? 0}`);
        }
      }
      errorLogged = false;
    } catch (err) {
      if (!stopped && !errorLogged) log(`media.monitor ${err.message}`);
      errorLogged = true;
    } finally {
      pending = false;
    }
  };
  log('keyframe.hint api=sender.setParameters encodingOptions');
  const timer = setInterval(() => void tick(), 1000);
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
