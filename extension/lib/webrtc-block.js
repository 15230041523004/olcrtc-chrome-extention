/** Injected into the intercepted tab only (debugger). Does not touch offscreen Goolom. */
export const WEBRTC_BLOCK_SOURCE = `(function () {
  if (globalThis.__olcWebrtcBlocked) return;
  globalThis.__olcWebrtcBlocked = true;

  // 1. Hard-block WebRTC to prevent STUN/ICE real IP leaks
  function BlockedRTCPeerConnection() {
    throw new DOMException('WebRTC is blocked by olcRTC tunnel killswitch policy', 'NotAllowedError');
  }
  // Do not expose the native constructor via prototype.constructor or
  // Object.getPrototypeOf: either would let a page undo this wrapper.
  globalThis.RTCPeerConnection = BlockedRTCPeerConnection;
  if (globalThis.webkitRTCPeerConnection) globalThis.webkitRTCPeerConnection = BlockedRTCPeerConnection;

  // Fetch interception does not carry these transports. DNR also blocks their
  // handshakes, including from workers and frames without this script.
  for (const name of ['WebSocket', 'WebTransport']) {
    if (typeof globalThis[name] !== 'function') continue;
    globalThis[name] = function () {
      throw new DOMException(name + ' is not supported by the olcRTC tunnel', 'NotAllowedError');
    };
  }

  // 2. Disable Service Workers so page fetches cannot bypass CDP tab interception
  try {
    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      Object.defineProperty(navigator, 'serviceWorker', {
        get: () => undefined,
        configurable: false,
      });
    }
  } catch (_) {}
})();`;
