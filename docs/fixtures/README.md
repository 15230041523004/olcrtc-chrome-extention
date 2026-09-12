# Frame fixtures

Place native `vp8channel` sample dumps here for Stage 2 unit tests.

- First 48 bytes as hex, plus total length, one sample per file.
- No room IDs, no PSK, no full tunnel payloads if they might contain key material.
- `*.bin` and `*.hex` are gitignored.

Expected prefix of a data sample: `vp8Keepalive` (20 bytes) then token/src/dst/crc (16 bytes). Batch samples continue with `OLKB` at offset 36.

A prefix-only fixture validates the epoch header, not the KCP body or checksum.
KCP checksum verification requires the complete datagram, including its final
four-byte big-endian CRC32C. Use synthetic payloads for committed checksum tests;
each OLKB entry includes its own checksum in the entry length.
