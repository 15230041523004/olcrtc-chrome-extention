## olcRTC Research v0.2.2

- 4K / 120 Mbps YouTube path: default 120 FPS carrier (`vp8.fps: 120`), 128 batch size, SDP bitrate caps removed, proactive TLS pre-warm.
- Fingerprint follows Settings and stays the same across Connect. Screen and color scheme stay off unless you turn them on.
- Connect no longer hangs on a heavy tab (Gemini). Child targets are resumed immediately, Fetch pauses wait until debugger setup finishes, and each setup command times out after 3s.

Unzip `olcrtc-chrome-extension-*.zip` and load the folder that contains `manifest.json` via chrome://extensions (Developer mode → Load unpacked).

Experimental research software (PoC). Not a VPN, not a public proxy, and not a circumvention tool.
