# tls-wasm

Rustls 0.23 client (TLS 1.2 + 1.3, Mozilla roots via `webpki-roots`, ALPN
`http/1.1`) compiled to WebAssembly for the extension worker.

The checked-in binary under `extension/lib/vendor/tls-wasm/` is the socksflare
0.4.0 build (TLS 1.3 + CA). Rebuild this crate to pick up TLS 1.2, `close`,
and `protocol_version`:

```
node scripts/build-tls-wasm.mjs
```

Needs `rustup` target `wasm32-unknown-unknown` and `wasm-pack`.
