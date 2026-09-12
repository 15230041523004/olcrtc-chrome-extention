import { parseEpochHeader, splitKCPPayload, keepaliveBuffer } from '../../extension/lib/vp8-wire.js';
import { nativeOpenKcp } from '../helpers/native-wire.js';

const stats = { frames: 0, dataSamples: 0, datagrams: 0, badHeaders: 0, badKcp: 0, badCrc32c: 0 };
let tunnelMode = false;
self.onmessage = ({ data }) => {
  if (data === 'tunnel') tunnelMode = true;
  else self.postMessage({ type: 'snapshot', ...stats });
};
self.onrtctransform = ({ transformer }) => {
  transformer.readable.pipeThrough(new TransformStream({
    transform(frame, controller) {
      stats.frames++;
      if (!tunnelMode) {
        controller.enqueue(frame);
        return;
      }
      const header = parseEpochHeader(frame.data);
      if (!header?.ok) stats.badHeaders++;
      else if (header.payload.length) {
        stats.dataSamples++;
        for (const wire of splitKCPPayload(header.payload)) {
          stats.datagrams++;
          const packet = nativeOpenKcp(wire);
          if (!packet) {
            stats.badCrc32c++;
            continue;
          }
          if (packet.length < 24 || new DataView(packet.buffer, packet.byteOffset).getUint32(0, true) !== 0xc0ffee01) stats.badKcp++;
        }
      }
      frame.data = keepaliveBuffer();
      controller.enqueue(frame);
    },
  })).pipeTo(transformer.writable).catch((error) => self.postMessage({ type: 'error', message: error.message }));
};
