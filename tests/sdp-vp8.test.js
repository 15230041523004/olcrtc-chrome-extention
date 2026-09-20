import test from 'node:test';
import assert from 'node:assert/strict';
import { preferVp8Sdp, enhanceSdpBandwidth, isIPv4IceCandidate } from '../extension/lib/sdp-vp8.js';

test('preferVp8Sdp moves VP8 payload type to the front of m=video line', () => {
  const inputSdp = [
    'v=0',
    'o=- 12345 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'm=video 9 UDP/TLS/RTP/SAVPF 100 96 97',
    'c=IN IP4 0.0.0.0',
    'a=rtpmap:100 H264/90000',
    'a=rtpmap:96 VP8/90000',
    'a=rtpmap:97 rtx/90000',
  ].join('\r\n');

  const result = preferVp8Sdp(inputSdp);
  assert.ok(result.includes('m=video 9 UDP/TLS/RTP/SAVPF 96 100 97'));
});

test('preferVp8Sdp handles multi-track video SDPs', () => {
  const inputSdp = [
    'v=0',
    'm=video 9 UDP/TLS/RTP/SAVPF 100 96',
    'a=rtpmap:100 H264/90000',
    'a=rtpmap:96 VP8/90000',
    'm=video 10 UDP/TLS/RTP/SAVPF 102 96',
    'a=rtpmap:102 VP9/90000',
  ].join('\r\n');

  const result = preferVp8Sdp(inputSdp);
  assert.ok(result.includes('m=video 9 UDP/TLS/RTP/SAVPF 96 100'));
  assert.ok(result.includes('m=video 10 UDP/TLS/RTP/SAVPF 96 102'));
});

test('enhanceSdpBandwidth injects b=AS, b=TIAS and VP8 bitrate format parameters', () => {
  const inputSdp = [
    'v=0',
    'o=- 12345 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'm=video 9 UDP/TLS/RTP/SAVPF 96 97',
    'c=IN IP4 0.0.0.0',
    'a=rtpmap:96 VP8/90000',
    'a=rtcp-fb:96 goog-remb',
    'a=rtcp-fb:96 transport-cc',
  ].join('\r\n');

  const enhanced = enhanceSdpBandwidth(inputSdp, 120_000);
  assert.ok(enhanced.includes('b=AS:120000'));
  assert.ok(enhanced.includes('b=TIAS:120000000'));
  assert.ok(enhanced.includes('a=fmtp:96 x-google-min-bitrate=25000;x-google-max-bitrate=120000;x-google-start-bitrate=50000'));
});

test('enhanceSdpBandwidth augments existing a=fmtp without duplicates', () => {
  const inputSdp = [
    'v=0',
    'm=video 9 UDP/TLS/RTP/SAVPF 96',
    'c=IN IP4 0.0.0.0',
    'a=rtpmap:96 VP8/90000',
    'a=fmtp:96 max-fr=60;max-fs=8192',
  ].join('\r\n');

  const enhanced = enhanceSdpBandwidth(inputSdp, 100_000);
  assert.ok(enhanced.includes('b=AS:100000'));
  assert.ok(enhanced.includes('b=TIAS:100000000'));
  assert.ok(enhanced.includes('a=fmtp:96 max-fr=60;max-fs=8192;x-google-min-bitrate=25000;x-google-max-bitrate=100000;x-google-start-bitrate=50000'));
});

test('enhanceSdpBandwidth handles multi-video sections independently', () => {
  const inputSdp = [
    'v=0',
    'm=video 9 UDP/TLS/RTP/SAVPF 96',
    'c=IN IP4 0.0.0.0',
    'a=rtpmap:96 VP8/90000',
    'm=video 10 UDP/TLS/RTP/SAVPF 96',
    'c=IN IP4 0.0.0.0',
    'a=rtpmap:96 VP8/90000',
  ].join('\r\n');

  const enhanced = enhanceSdpBandwidth(inputSdp, 120_000);
  const asCount = (enhanced.match(/b=AS:120000/g) || []).length;
  const tiasCount = (enhanced.match(/b=TIAS:120000000/g) || []).length;
  assert.equal(asCount, 2);
  assert.equal(tiasCount, 2);
});

test('isIPv4IceCandidate accurately filters candidate IPs', () => {
  assert.equal(isIPv4IceCandidate('candidate:1 1 UDP 2130706431 192.168.1.100 50000 typ host'), true);
  assert.equal(isIPv4IceCandidate('candidate:2 1 UDP 2130706431 test-uuid.local 50000 typ host'), true);
  assert.equal(isIPv4IceCandidate('candidate:3 1 UDP 2130706431 2001:db8::1 50000 typ host'), false);
  assert.equal(isIPv4IceCandidate(''), false);
  assert.equal(isIPv4IceCandidate(null), false);
});

