/** WASM kcp-go is not built in this tree (no Go toolchain). JS fallback: ./kcp.js */
export const kcpBackend = 'js';
export function loadKcpWasm() {
  return Promise.resolve(null);
}
