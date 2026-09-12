/** CDP Fetch.request.postData is a latin1 string (one code unit per byte), not UTF-8. */

export function latin1ToBytes(s) {
  if (!s) return new Uint8Array(0);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

export function b64ToBytes(b64) {
  return latin1ToBytes(atob(b64));
}

export function decodeCdpPostData({ postData, postDataEntries } = {}) {
  if (Array.isArray(postDataEntries) && postDataEntries.length) {
    const parts = [];
    let total = 0;
    for (const e of postDataEntries) {
      if (!e?.bytes) continue;
      const p = b64ToBytes(e.bytes);
      parts.push(p);
      total += p.length;
    }
    if (parts.length) {
      const out = new Uint8Array(total);
      let o = 0;
      for (const p of parts) {
        out.set(p, o);
        o += p.length;
      }
      return { body: out, src: 'entries' };
    }
  }
  if (typeof postData === 'string' && postData.length) {
    return { body: latin1ToBytes(postData), src: 'paused' };
  }
  return { body: null, src: 'none' };
}

export async function resolveCdpPostBody(req, { getPostData, max } = {}) {
  let { body, src } = decodeCdpPostData(req);
  if (src === 'none' && req?.hasPostData && typeof getPostData === 'function') {
    try {
      const got = await getPostData();
      const decoded = decodeCdpPostData({
        postData: got?.postData,
        postDataEntries: got?.postDataEntries,
      });
      if (decoded.body) {
        body = decoded.body;
        src = 'get';
      }
    } catch (err) {
      return { body: null, src: 'none', error: err };
    }
  }
  if (body && Number.isFinite(max) && body.length > max) body = body.subarray(0, max);
  return { body, src };
}
