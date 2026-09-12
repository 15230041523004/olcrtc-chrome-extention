/**
 * Tunnel CONNECT to olcrtc srv is JSON on a data smux stream, then a 1-byte ACK.
 * Local native cnc speaks SOCKS5 to apps; that is not what we send on smux.
 */
export const CONNECT_ACK_OK = 0x00;
export const CONNECT_ACK_UNREACHABLE = 0x04;

export function encodeTunnelConnect(host, port) {
  return new TextEncoder().encode(JSON.stringify({ cmd: 'connect', addr: host, port: Number(port) }));
}

export function encodeSocks5Connect(host, port) {
  const p = Number(port) & 0xffff;
  const name = String(host);
  const out = new Uint8Array(7 + name.length);
  out[0] = 5;
  out[1] = 1;
  out[2] = 0;
  out[3] = 3;
  out[4] = name.length;
  for (let i = 0; i < name.length; i++) out[5 + i] = name.charCodeAt(i) & 0xff;
  out[5 + name.length] = (p >>> 8) & 0xff;
  out[6 + name.length] = p & 0xff;
  return out;
}

export function encodeSocks5NoAuthHello() {
  return new Uint8Array([5, 1, 0]);
}
