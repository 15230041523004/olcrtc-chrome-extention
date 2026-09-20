# Traffic matrix

What tab traffic this product intends to carry. Stage 3 fills **works / partial / no + reason**. Until that column is filled, do not call this a VPN.

| Kind | Need | Stage 3 mechanism | Result (Stage 3) |
|---|---|---|---|
| Document navigation | required | `chrome.debugger` + `Fetch.requestPaused` / `fulfillRequest` | **works** http://neverssl.com (3a). **works** https:// (3b/3c/4: rustls TLS + pool) |
| XHR / `fetch` | required | same | **works** — yandex internetometer IP API via tunnel. POST: latin1 CDP body + `Content-Length: 0` |
| Images / CSS / JS | required | same; response body fully buffered (32 MiB) | **works** (0.5.0) — smux cumulative flow control, keep-alive pool, HostGate concurrency 4 |
| Downloads | desired | fulfill needs the whole body | _open_ |
| Streaming (HLS / MSE) | required | keep-alive pool (32 MiB body), smux window updates, HostGate, CDP fulfill | **works** — YouTube, Rutube, VK Video; fast manifest load and continuous chunks |
| WebSocket / WebTransport | required block | Browser DNR rules + constructor stubs; no HTTP exception for these resource types | **blocked** new handshakes; native WebSocket tested independently of stubs |
| Page WebRTC | required block | `RTCPeerConnection` throws `NotAllowedError`; inject into page and child contexts | **partial**: new constructors blocked; previously created peer connections and native references are not revoked |
| Dedicated workers / cross-origin iframes | required | Recursive CDP auto-attach before execution; worker HTTP inherits owner Fetch interception; iframe gets its own Fetch session | **works** local Chrome fixture; shared/service workers outside attached targets are blocked by default |
| Service Workers | required block | `Network.setBypassServiceWorker` + `navigator.serviceWorker` stub + DNR for requests without a guarded tab | **partial**: bypasses page control; does not unregister or terminate pre-existing workers |
| HTML5 Geolocation | required protection | Browser `contentSettings.location=block` + tab coordinate stub and CDP override | **blocked** native location, including after detach; JS stub returns exit coordinates or the existing US fallback if lookup fails |
| Timezone | required spoof | CDP `Emulation.setTimezoneOverride` | **spoofed** to exit IANA zone |
| Language / `Accept-Language` | optional spoof | Settings toggle; CDP locale + header rewrite + `navigator.language` | **spoofed** when enabled (default on, auto from exit) |
| UA / Client Hints | optional spoof | Settings toggle; CDP `setUserAgentOverride` + `Sec-CH-UA*` rewrite + `userAgentData` | **spoofed** when enabled (default Chrome Windows, real Chrome major) |
| `hardwareConcurrency` | optional spoof | Settings toggle; CDP `Emulation.setHardwareConcurrencyOverride` + JS getter | **spoofed** when enabled (default 8) |
| `deviceMemory` / `maxTouchPoints` / `vendor` | optional spoof | JS getters aligned with UA preset + hw | **spoofed** with UA/hw (desktop `maxTouchPoints=0`, `deviceMemory` clamped to 8) |
| Screen / DPR | optional spoof | Settings toggle (default off); CDP `setDeviceMetricsOverride` + `screen.*` | **real window** by default; **emulated** when enabled (resizes the tab) |
| `prefers-color-scheme` | optional spoof | Settings select (default system); CDP `setEmulatedMedia` | **system** by default |
| Canvas / WebGL / Audio / fonts | optional spoof | Settings **Render fingerprint** (default on); seed is a hash of Settings (UA/hw/screen/locale/color), not Connect time; WebGL vendor/renderer follow UA preset; extra fonts hidden | **spoofed** when enabled; same settings → same seed every Connect; wrappers are detectable; rasterization is still this GPU |
| Google account cookies | optional strip | Settings toggle **Fresh Google session** (default off). When on, drop **pre-intercept** `SID`/`NID`/`__Secure-*PSID*` values on `*.google.com`; cookies Set-Cookie'd during Sign-In pass | **passed through** by default; **stripped** when the toggle is on |
| DNS | partial | Tunnel CONNECT sends destination hostname to server; `networkPredictionEnabled=false` suppresses browser prediction | **partial**: carrier DNS remains local; no system DNS routing or OS firewall |
| `chrome://`, extension pages | not needed | debugger cannot attach | n/a |

## Cost of the required path (to record in Stage 3)

- Debugger infobar on the attached tab
- Existing background tabs are not force-reloaded. The active tab and newly opened tabs whose initial navigation was guarded are recovered once the tunnel is ready.
- Path `/unsupported-country` is replaced by origin `/` instead of reloading the block page in place
- Tab recoveries are serialized so a document GET is not dropped behind a CDP fulfill storm
- HTTPS: JSON CONNECT `:443` + **Rustls WASM** (TLS 1.3, Mozilla CA, ALPN `http/1.1`), then HTTP/1.1
- Keep-alive pool: 4 idle/host, 8 total, 30 s TTL; max 8 in-flight proxies; HostGate concurrency 2
- `connect ack 4` = srv host unreachable
- Large bodies buffered in the extension (32 MiB cap)
- WebRTC and fingerprint stubs are target-scoped. Global WebRTC policy is unchanged to keep Telemost working. Only network prediction and native geolocation permissions are changed for the profile; explicit Disconnect clears this extension's overrides.
- Offscreen Telemost UA/ICE is unchanged (carrier path)
- Google auth cookies (`SID`, `NID`, `__Secure-*PSID*`, …) are forwarded by default so Connect/Disconnect keeps the current login. **Fresh Google session** (default off) snapshots those values at Connect and omits them on Google hosts; sign-in must then happen through the tunnel, and the next Connect with the toggle still on logs you out again

## Network guard and limits

Connect installs persistent browser block rules before starting the carrier or looking up its location. HTTP(S) exceptions are installed only for configured debugger tabs. Fetch errors and tunnel outages never intentionally continue a request to the network. WebSocket and WebTransport have no exception. Only requests initiated by this extension are exempt from the default subresource block; there are no destination-domain exemptions.

Chrome applies DNR navigation blocks before Fetch interception, so a blanket block cannot coexist with this HTTP tunnel. The per-tab exceptions are necessary. Unexpected debugger detach is reported asynchronously; removing its exception is also asynchronous. This leaves a possible race window, and the extension cannot claim an atomic kill switch. A service-worker restart clears stale tab exceptions; browser restarts retain dynamic blocks but discard session exceptions. Disconnect explicitly releases the guard. Disabling/uninstalling the extension also removes protection.

Already established WebRTC/WebSocket/WebTransport connections are not closed by new DNR rules or constructor replacement. A fresh browser profile avoids old page connections and account history; this is still not a guarantee against every IP, DNS or fingerprint leak. Incognito, protected Chrome pages, other applications, browser internals and traffic outside the extension's permissions are outside verified coverage. A system tunnel with OS firewall rules is required for whole-computer routing.

Sites still see the exit IP and may infer its country. Accounts, cookies, language and prior activity may also influence regional decisions. Coordinate spoofing cannot change the server's IP or guarantee access to any particular site.

For Flow regional errors, use **Check exit through tunnel** after connecting. The lookup goes through the tunnel and reports its IP and provider-reported country; that provider's geolocation may differ from Google's. A failed lookup now shows **Exit: unknown** rather than presenting the fallback US browser profile as an observed exit. Download log includes `spoof.exit`, `spoof.exitLookup` (provider statuses/timings), `spoof.browserGeo` and `networkGuard`, even if the text event buffer has rolled over. No geo provider response bodies are recorded.

Flow and Google sign-in requests bypass the extension's response cache and request coalescing, so a previous eligibility result is not reused after signing in. Documents and responses marked `no-store`, `no-cache`, `private` or containing `Set-Cookie` are not stored in the response cache. The pre-tunnel cookie snapshot is taken once per interception session and is not refreshed when an active tunnel recovers.

Run `npm run test:privacy` for the isolated Chrome fixture: page fetch, dedicated worker, cross-origin iframe, native WebSocket denial, native geolocation denial, new tabs during an outage, detached/unattached navigation, carrier exception and explicit release. It uses local fixture responses, not a live Telemost server, and does not claim to test all protocols or all races.

## Product language

| Coverage | Allowed description |
|---|---|
| Stage 2 not green | Channel prototype (join + frames), not a tunnel |
| Stage 2 green, Stage 3 documents/XHR only | HTTP(S) intercept in a tab, not a profile VPN |
| Every required row green | Still not “whole profile / any protocol” unless WebSocket, page WebRTC, and DNS are also closed — current extension APIs do not do that |
