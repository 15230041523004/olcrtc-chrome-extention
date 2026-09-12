# Stand

One live `olcrtc srv`, one Telemost room, one PSK. Native `cnc` and this unpacked extension join the **same** room.

**Do not commit** the room ID or the 64-hex key. Paste the URI in the extension popup; it is stored in `chrome.storage.local` on this machine only.

## URI (local)

```
olcrtc://telemost?vp8channel@<ROOM_ID>#<64_HEX_KEY>
```

Optional: `<vp8-fps=30&vp8-batch=64>` after `vp8channel`. Comment after `$` is UI-only.

Room ID may be the Telemost hash or `https://telemost.yandex.ru/j/<hash>`.

## Native check (before the extension)

`srv` is already running (your stand). On the client machine:

```yaml
# client.yaml — local file, not in this repo
mode: cnc
auth:
  provider: telemost
room:
  id: "<ROOM_ID>"
crypto:
  key: "<64_HEX_KEY>"
net:
  transport: vp8channel
  dns: "8.8.8.8:53"
vp8:
  fps: 30
  batch_size: 64
socks:
  host: "127.0.0.1"
  port: 8808
```

Expect `Link connected` in the native log. Keep that `cnc` (or `srv` alone) in the room while the extension joins as a third participant.

## Capture fixtures (optional, Stage 2)

With native `cnc` up, dump a few outbound VP8 **samples** (not RTP): first 48 bytes hex + total length. Strip any key material. Drop files under `docs/fixtures/` (gitignores `*.bin` / `*.hex`).

Useful log lines from native `vp8channel`:

- `KCP started localEpoch=0x…`
- `authenticated peer epoch=0x…`
- `incoming frame token mismatch` — binding token is wrong (URI `@` room string ≠ native `room.id`)

If the candidate list still misses the live token, print it from native:

```go
package main
import (
  "fmt"
  "hash/fnv"
)
func main() {
  for _, s := range []string{"YOUR_ROOM_ID", "https://telemost.yandex.ru/j/YOUR_ROOM_ID"} {
    h := fnv.New32a()
    h.Write([]byte(s))
    t := h.Sum32()
    if t == 0 { t = 1 }
    fmt.Printf("%q → 0x%08x\n", s, t)
  }
}
```

Hard-code the matching string in the extension only for that stand.

## Chrome

141+ (Encoded Transform). `chrome://version`. In the offscreen console, `typeof RTCRtpSender.prototype.transform` must not be `undefined`.

## ICE / hosts (from native + Telemost)

| Role | Value |
|---|---|
| REST | `https://cloud-api.yandex.ru/telemost_front/v2/telemost` |
| Conference UI | `https://telemost.yandex.ru/j/<id>` |
| Bootstrap STUN | `stun:stun.rtc.yandex.net:3478` |
| Signaling WS | `client_configuration.media_server_url` from REST (host only in logs) |
| Extra ICE | `serverHello.rtcConfiguration.iceServers` |

## Stage 1 pass/fail

See `README.md` log checklist. Identity transform must fire **before** any KCP/OLC2 work.
