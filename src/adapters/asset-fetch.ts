// Asset URLs come from third-party JSON and reach the anonymous caller as
// base64, so a URL that escapes the allowlist would read local files or
// loopback services out through the import result.

const TIMEOUT_MS = 15_000;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_HOPS = 3;

const allowed = (raw: string, hosts: readonly string[]): URL | null => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.port !== "" || url.username) return null;
  return hosts.includes(url.hostname.toLowerCase()) ? url : null;
};

export async function fetchImage(
  src: string,
  hosts: readonly string[],
): Promise<{ mimeType: string; base64: string } | undefined> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  try {
    let url = allowed(src, hosts);
    for (let hop = 0; url && hop <= MAX_HOPS; hop++) {
      const res = await fetch(url, { redirect: "manual", signal });
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel();
        const next = res.headers.get("location");
        url = next ? allowed(new URL(next, url).href, hosts) : null;
        continue;
      }
      const mimeType = res.headers.get("content-type") ?? "";
      if (!res.ok || !res.body || !/^image\//i.test(mimeType)) {
        await res.body?.cancel();
        return undefined;
      }
      if (Number(res.headers.get("content-length")) > MAX_BYTES) {
        await res.body.cancel();
        return undefined;
      }
      const reader = res.body.getReader();
      const parts: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const step = await reader.read();
        if (step.done) break;
        total += step.value.byteLength;
        if (total > MAX_BYTES) {
          await reader.cancel();
          return undefined;
        }
        parts.push(step.value);
      }
      return { mimeType, base64: Buffer.concat(parts).toString("base64") };
    }
  } catch {}
  return undefined;
}

// Same limits for fetches that run inside the page. Interpolated into
// page.evaluate sources as `(<this>)(src, fallbackType, init)`; resolves to
// { mimeType, base64 } or null.
export const READ_ASSET_IN_PAGE = `async (src, fallbackType, init) => {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ${TIMEOUT_MS});
  try {
    const r = await fetch(src, Object.assign({}, init, { signal: ctl.signal }));
    if (!r.ok || !r.body) return null;
    if (Number(r.headers.get("content-length")) > ${MAX_BYTES}) return null;
    const reader = r.body.getReader();
    const parts = [];
    let total = 0;
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      total += step.value.byteLength;
      if (total > ${MAX_BYTES}) return null;
      parts.push(step.value);
    }
    let bin = "";
    for (const part of parts) {
      for (let i = 0; i < part.length; i += 8192) {
        bin += String.fromCharCode.apply(null, part.subarray(i, i + 8192));
      }
    }
    return { mimeType: r.headers.get("content-type") || fallbackType, base64: btoa(bin) };
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
    ctl.abort();
  }
}`;
