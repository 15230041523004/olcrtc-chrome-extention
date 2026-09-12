# Test A: handshake and liveness

Build **0.1.3** adds the required CRC32C trailer to every KCP datagram and verifies
and removes it on receive. It also includes the Chrome keyframe requests and
outbound RTP statistics from 0.1.2.

**Test B (data-plane payload):** on this stand srv keeps **data-epoch keepalives** (`src=0x66fe81a8 payload=0`) and puts tunnel bytes on the **control** plane (`src=0xe6fe81a8`). The Stage 1 `n=428` capture was another cnc in the room. B is **N/A** here unless a native cnc is also present. Control-plane `kcp.recv` after welcome is already covered by A.

**Live Test A is verified** on Telemost `vp8channel` (2026-09-12 12:20:42–12:20:57 UTC):
`kcpWire=crc32c`, `kcp.recv … crc32c=ok`, `kcp.ack … una=1`,
`handshake.welcome … peer=0x66fe81a8`, `liveness.pong`, `crcErrors=0`.
Control inbound used `src=0xe6fe81a8` `dst=<ourControlEpoch>`. This is not a VPN.

The 0.1.1 capture from 2026-09-12 11:46:31–11:47:50 UTC contains 38 KCP samples
(one key, 37 delta), 39 datagrams, sample sizes 312–320 bytes, no queue drops and
no backlog. Inbound traffic is exclusively server keepalives: no KCP payload or
ACK, `una=0`, handshake/ping false. It also reports that
`transformer.generateKeyFrame` is unavailable. The corresponding systemd journal
records peer creation for client epoch `0x431f6ccd` and creation of its control
KCP at 11:46:34 UTC. These messages establish that the server received a control
payload from this client. They precede the native KCP checksum check and do not
establish that KCP accepted the payload or that authentication succeeded.

## What changed

- Every outgoing KCP datagram now ends with its four-byte big-endian CRC32C
  (Castagnoli). Incoming datagrams are verified and stripped before KCP input;
  each OLKB batch entry has its own checksum. The earlier extension omitted this
  trailer, so [native `kcpConn.deliver`](https://github.com/openlibrecommunity/olcrtc/blob/master/internal/transport/vp8channel/kcpconn.go)
  silently discarded the datagrams before KCP could ACK them. The epoch header
  continues to use CRC32-IEEE; bare keepalives remain 36 bytes.
- Every encoded video tick can carry KCP, including Chrome delta frames.
- Each sample holds at most two 1400-byte KCP datagrams: at most 2852 bytes
  including the epoch header, OLKB batch framing and KCP checksums. A burst stays in the queue
  and drains across ticks. Each plane's queue is bounded at 256 datagrams;
  overflow drops the oldest datagram and KCP can retransmit it.
- Bare data keepalives continue at least every two seconds during control/data
  traffic and on every idle encoder tick.
- Control epochs remain unsigned when comparing received source/destination IDs.
  Replies must target our control epoch. Foreign broadcast HELLOs are discarded;
  another client's keepalive cannot select the server for our handshake. This
  matches [native control routing](https://github.com/openlibrecommunity/olcrtc/blob/master/internal/transport/vp8channel/control.go).
- Keyframe hints use `sender.setParameters(parameters, {encodingOptions: [...]})`
  in the offscreen document. This is the Chrome API covered by the
  [Web Platform Test](https://github.com/web-platform-tests/wpt/blob/master/webrtc/RTCRtpSender-setParameters-keyFrame.html).
  The worker never calls the unavailable `transformer.generateKeyFrame`.
  A pending or failed hint never blocks video frames.
- `media.out` logs negotiated codec, packets/bytes sent, encoded frames/keyframes,
  accepted hint calls, and PLI/NACK counts. Accepted hint calls alone do not prove
  generation: compare `keys` with `keyRequests`.

## Local verification

Node.js 22+, no dependencies or install step:

```powershell
npm test
```

If a restricted environment prevents the test runner from spawning processes:

```powershell
node --test --experimental-test-isolation=none
```

The regression suite covers delta-only transmission, a 33-datagram backlog,
unsigned epoch routing, keepalives under load, queue overflow, a wire-format KCP
ACK, missing/corrupt KCP checksums, checksum byte order, mixed valid/corrupt batch
entries, malformed KCP input, Chrome keyframe options, publisher monitor lifecycle,
and a worker without `generateKeyFrame`. Its local protocol peer
exchanges HELLO/WELCOME and two PING/PONG pairs over more than ten seconds,
with a dropped first sample, reordered/duplicated replies and other-client traffic.
Both the local peer and browser receiver enforce the KCP checksum with an
independent implementation. CRC32C tests also use
[Go's published golden vectors](https://go.dev/src/hash/crc32/crc32_test.go).
The local peer uses this repository's JS KCP/OLC2 and independent smux/JSON framing;
it does **not** validate native crypto interoperability, Chrome RTP packetization
or Telemost delivery.

For the installed Chrome on Windows, a separate browser test uses two local
PeerConnections and the real extension sender transform:

```powershell
npm run test:chrome
```

An alternative Chrome binary can be passed as the first argument to
`node scripts/check-chrome.mjs`. The runner launches hidden headless Chrome with
a separate profile under `.tmp/`, serves test files only on `127.0.0.1`, and
closes the browser/server when done. No Telemost credentials or room are used.
The result is saved to `.tmp/chrome-loopback-result.json`.

Verified on installed Chrome 153: a request on unmodified VP8 increased encoded
keyframes from 1 to 2 while PLI stayed 0. During the tunnel phase, five periodic
requests increased keyframes from 2 to 7, and 11 KCP samples / 12 datagrams arrived
with no bad epoch headers, KCP conv values or CRC32C checksums. This checks local Chrome delivery,
not native server interoperability or Telemost forwarding.

## Live verification

1. In the extension, click **Disconnect**. Open `chrome://extensions`, reload the
   unpacked extension, and verify version **0.1.3**.
2. Open the popup. Keep the saved URI and select **tunnel**, then **Connect**.
3. Leave the session running for **60 seconds**. The popup may be closed and
   reopened while the offscreen document holds the connection.
4. Click **Download log** before starting another connection. It exports the full
   retained log (up to 800 entries), flags, build version and UTC timestamps.
   Starting a new connection clears the previous session's log.
5. Capture native `srv` logs for the same minute, including peer discovery and
   transport diagnostics. Use the actual epoch from `tunnel.ready` to identify
   this client; epochs change on reconnect. Server-local timestamps may differ
   from the extension's UTC (`Z`) timestamps.

Expected progress:

```text
tunnel.ready epoch=0x... control=0x... ... carrier=every-tick maxPackets=2 maxSample=2852 kcpWire=crc32c
vp8.out chromeType=delta stuffed=kcp n=1 ... queued=0
kcp.recv from=0x... n=... wire=... crc32c=ok
kcp.ack plane=ctrl sn=... una=...
handshake.welcome ... peer=0x...
liveness.pong
```

`n=2` is also valid. Keyframes may also carry KCP. An outbound sample is only
evidence that the extension supplied bytes to Chrome; it does not prove srv
received them. Successful HELLO transmission can finish quickly, so there need
not be many KCP samples after a successful handshake.

Pass: popup **handshake.ok** and **ping.ok**, a WELCOME from the server, and
repeated `liveness.pong` over the session. `sub.connected` / `pub.connected`
only establish the media connection. A fixed historical server epoch is not
required: it can change when srv restarts.

## Reading a failure

| Evidence | Next layer to inspect |
|---|---|
| Queued KCP grows, no `stuffed=kcp` | Encoder ticks / transform attachment |
| Small KCP samples leave, `kcp.stats in=0 ack=0`, srv never sees this epoch | Chrome RTP / SFU delivery; native logging must be enabled before treating silence as evidence |
| Srv sees the epoch, no ACK comes back | Check build 0.1.3 and `kcpWire=crc32c`, then native KCP parsing and the return media path |
| `vp8.kcp.crc bad` / increasing `crcErrors` | Received KCP checksum mismatch; compare the native wire format and received datagram sizes |
| `ack>0` / `una` advances, no WELCOME | OLC2, smux and handshake; compare both logs |
| `olc2.open ...` or `kcp.input ... error=...` | The named receive layer |
| WELCOME arrives, no `liveness.pong` | Control framing / ping-pong |

`handshake.pending after=15s` is a diagnostic marker. KCP keeps retransmitting;
it is not a report of a successful tunnel or an automatic new handshake.
No tab HTTP interception is implemented in this build.

## Srv logs on the current stand (systemd)

The supplied process cgroup is `/system.slice/olcrtc-srv.service`.
This stand runs srv as a systemd service. Read the journal for the supplied
0.1.1 session, with a small margin on either side:

```bash
sudo journalctl -u olcrtc-srv.service --utc --no-pager -o short-iso \
  --since '2026-09-12 11:46:00 UTC' \
  --until '2026-09-12 11:48:00 UTC'
```

If that interval has no entries, read the last 80 entries to determine what is
being recorded:

```bash
sudo journalctl -u olcrtc-srv.service -n 80 --utc --no-pager -o short-iso
```

These commands read logs without restarting the service. For a new extension
run, use the corresponding UTC time interval. Missing transport messages alone
do not prove packet loss; debug logging may be disabled.

## Alternative: srv installed in Podman

The standard [installer](https://github.com/openlibrecommunity/olcrtc/blob/master/install.sh)
starts a Podman container. In the server terminal, use the same account as during
installation and list its containers:

```bash
podman ps -a --format 'table {{.Names}}\t{{.Status}}'
```

If empty, try `sudo podman ps -a --format 'table {{.Names}}\t{{.Status}}'`.
Use the same `sudo` prefix on the following command if that is where the container
appears. Replace `CONTAINER_NAME` with its actual name, usually `olcrtc-server-…`:

```bash
podman logs --timestamps --since '2026-09-12T11:46:31Z' --until '2026-09-12T11:47:50Z' CONTAINER_NAME 2>&1
```

These commands only read state/logs. The timestamps above select the supplied
0.1.1 session; use the new session's UTC range after another run. An empty result
does not prove packet loss: the installer defaults to `debug: false`, so transport
diagnostics may not have been recorded. Determine that from the available logs
before changing the running server.
