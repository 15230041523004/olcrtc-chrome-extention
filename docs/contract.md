# Stage 0 contract — telemost + vp8channel

Single-page wire contract for the Chrome prototype. Live room ID and PSK stay out of git (`docs/stand.md`). Source of truth: [openlibrecommunity/olcrtc](https://github.com/openlibrecommunity/olcrtc) `master` (captured 2026-09-12).

| Field | Value |
|---|---|
| Provider | `telemost` |
| Engine | `goolom` |
| Transport | `vp8channel` |
| Crypto | OLC2 (no v1 fallback) |
| Handshake | smux stream 0, proto version **3** |
| Environment | Chrome 141+ (`RTCRtpScriptTransform`) |

## URI v1

Parsed by this extension. Native `olcrtc` does not parse it; it uses YAML.

```
olcrtc://telemost?vp8channel<vp8-fps=30&vp8-batch=64>@<RoomID>#<64-hex-key>$<comment>
```

| Piece | Maps to |
|---|---|
| `telemost` | `auth.provider` |
| `vp8channel` | `net.transport` |
| `<vp8-fps>` / `<vp8-batch>` | `vp8.fps` / `vp8.batch_size` (omit the `<>` block for defaults 30 / 64) |
| `@RoomID` | `room.id` — Telemost hash or full `https://telemost.yandex.ru/j/<id>` |
| `#key` | `crypto.key` — 32 bytes as 64 hex chars |
| `$comment` | UI only |

## Telemost auth (Goolom credentials)

`GET https://cloud-api.yandex.ru/telemost_front/v2/telemost/conferences/{url-encoded-room}/connection`

Query: `next_gen_media_platform_allowed=true`, `display_name`, `waiting_room_supported=true`.

If `room.id` has no `https://` prefix, the room URL is `https://telemost.yandex.ru/j/` + id. The path segment is `QueryEscape` of that full URL.

Headers: Firefox-like UA, `Origin`/`Referer` `https://telemost.yandex.ru`, `X-Telemost-Client-Version: 187.1.0`, `Client-Instance-Id`, `Idempotency-Key`.

JSON: `room_id`, `peer_id`, `credentials`, `client_configuration.media_server_url` (signaling WebSocket).

## Goolom signaling

Two `RTCPeerConnection`s (Unified Plan): **subscriber** (SFU offer → answer) and **publisher** (local offer after ~300 ms). No DataChannel on this stand.

Bootstrap ICE: `stun:stun.rtc.yandex.net:3478`. After `serverHello`, apply `rtcConfiguration.iceServers`.

`hello.sdkInfo`: `implementation: "browser"`, `version: "5.27.0"`. `capabilitiesOffer` is the matrix in `internal/engine/goolom/capabilities.go` (`offerAnswerMode: SEPARATE`, `initialSubscriberOffer: ON_HELLO`, …). `sendVideo: true`, `disablePublisher: false`, `disableSubscriberAudio: true`.

After subscriber answer: `setSlots` with eight 1280×720 slots so the SFU forwards the `srv` video track.

Keepalive: WebSocket ping 30 s, app `ping` 5 s; answer server `ping` with `pong`. Optional HTTPS telemetry from `serverHello.telemetryConfiguration` (https endpoints only).

## VP8 sample (`frame.data`)

Chrome Encoded Transform exposes the VP8 **uncompressed data chunk + frame** (RFC 6386 §9.1). The RTP VP8 payload descriptor is **not** in `frame.data`. That buffer is what native pion `TrackLocalStaticSample.Data` is.

```
[0..20)   vp8Keepalive
[20..24)  binding token  u32 BE
[24..28)  src epoch      u32 BE
[28..32)  dst epoch      u32 BE   (0 = broadcast)
[32..36)  CRC32-IEEE(token || src || dst)  — IEEE polynomial, over those 12 bytes only
[36..)    one checksummed KCP datagram, or batch
```

`vp8Keepalive` (20 bytes), a minimal valid VP8 keyframe so Telemost SFU forwards the sample:

```
30 01 00 9d 01 2a 10 00 10 00 00 47 08 85 85 88 99 84 88 fc
```

Bare keepalive (header only, no KCP) is injected at least every **2 s** while data flows, and on idle every **100 ms**, so the SFU decoder does not stop the track (~40 s timeout).

**KCP checksum:** each datagram is `{ raw KCP | u32 BE CRC32C(raw KCP) }`.
CRC32C uses the Castagnoli polynomial; it is separate from the CRC32-IEEE in the
epoch header. Native [`kcpConn.deliver`](https://github.com/openlibrecommunity/olcrtc/blob/master/internal/transport/vp8channel/kcpconn.go)
silently drops a missing or invalid checksum and strips the four-byte trailer
before passing the datagram to KCP. A bare 36-byte keepalive has no KCP checksum.

**Batch:** if payload starts with ASCII `OLKB`, then repeated
`{ u16 BE length | raw KCP | u32 BE CRC32C(raw KCP) }` until the sample ends.
Each length includes that datagram's four-byte checksum. There is no checksum
over the whole batch. Invalid length → stop parsing.

**Epoch:** random u32 with high bit clear. Control plane src = data epoch `| 0x80000000`. Receivers drop `dst != 0 && dst != local && dst != local|flag`. Own-src loopback is dropped.

Native max assembled sample: 4 × 60 KiB. Native writer target payload ≤ 60 KiB.
The extension caps each sample at two 1400-byte KCP datagrams: 2852 bytes including
the epoch header, OLKB batch framing, and both KCP checksums.

## Binding token

`internal/transport/common/binding.go`:

```
source = channelID if non-empty else roomURL
token  = FNV-1a 32-bit of UTF-8(source)
if token == 0: token = 1
```

FNV-1a-32: offset `2166136261`, prime `16777619`. Source is `room.channel` if set, else **`room.id` exactly as in native YAML**.

Live stand (2026-09-12): wire token `0x2409c6c5` = FNV-1a of the **bare** Telemost id (`80374510690850`), not `https://telemost.yandex.ru/j/<id>` (`0x779bf6c3`). The URI `@` room string must match native `room.id`. Mismatch → native drops every frame (`token mismatch`).

`SERVER_WELCOME.peer_id` is `fmt.Sprintf("%08x", srvDataEpoch)` (8 hex chars, no `0x`). It is **not** a UUID. Live srv data epoch = `0x66fe81a8`. A data frame `dst=0x1459fb8e` is another client’s epoch, not the welcome id.

## KCP (Stage 2 — documented, not implemented in Stage 1)

| Knob | Value |
|---|---|
| conv | `0xC0FFEE01` |
| nodelay | 1, interval 5 ms, fastresend 2, nc 1 |
| windows | snd/rcv 4096 |
| mode | stream + 4-byte BE length prefix |
| max message | 8 MiB |

Two planes (data + control) share the VP8 track, distinguished by the epoch high bit.

## OLC2 (Stage 2)

PSK 32 bytes. HKDF-SHA256, salt empty, info `olcrtc/v2/client-to-server` and `olcrtc/v2/server-to-client`. Client sends with the first key, server with the second.

Record: magic `OLC2` \| u64 BE counter (starts at 1, never 0) \| 16-byte sender prefix \| ciphertext \| 16-byte Poly1305 tag. XChaCha20-Poly1305 nonce = prefix \| counter. AAD `olcrtc/muxconn/v2/data` or `olcrtc/muxconn/v2/control`. Replay: 64-counter window, 256 sender prefixes.

## Handshake (Stage 2)

First smux stream, 4-byte BE length + JSON. `version: 3`.

`CLIENT_HELLO` `{ version, type, device_id, challenge, claims? }` → `SERVER_WELCOME` `{ version, type, session_id, peer_id, challenge }` or `SERVER_REJECT`. Challenge is 16 random bytes hex (32 chars); the server echoes it.

Then `CONTROL_PING` / `CONTROL_PONG` on that stream.

## Encoded Transform note

Stage 1 identity: Chrome’s real VP8 goes out; inbound `srv` samples are keepalive+KCP and will upset the decoder. Identity is green if `rtctransform` fires and frames are written. Stage 2 rewrites both directions to the layout above.
