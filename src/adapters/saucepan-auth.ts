// Saucepan mints a 30-day JWT from a plain handle/password login, so the token
// is fetched on first use and kept in memory rather than stored: a restart is
// far cheaper than a stale credential, and the pod is single-instance.
//
// Callers should treat any 401 as "log in again and retry once" rather than as
// a failure, since the token expires quietly.

const HANDLE = process.env.SAUCEPAN_HANDLE ?? "";
const PASSWORD = process.env.SAUCEPAN_PASSWORD ?? "";
const TIMEOUT_MS = 20_000;

export const hasSaucepanAuth = () => !!HANDLE && !!PASSWORD;

let cached: string | null = null;
let inFlight: Promise<string> | null = null;

async function login(): Promise<string> {
  const res = await fetch("https://saucepan.ai/api/v1/auth/sign_in_password", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle: HANDLE, password: PASSWORD }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`saucepan: sign-in ${res.status}`);
  const body = (await res.json()) as { token?: string };
  if (!body?.token) throw new Error("saucepan: sign-in returned no token");
  cached = body.token;
  return body.token;
}

// Single-flight: several lorebooks on one card would otherwise each open their
// own login while the first was still running.
export async function saucepanToken(force = false): Promise<string> {
  if (!hasSaucepanAuth()) throw new Error("saucepan: no credentials configured");
  if (!force && cached) return cached;
  if (force) cached = null;
  if (!inFlight) {
    inFlight = login().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

// Runs `send` with a bearer token, and on a 401 logs in again and retries ONCE.
// The retry is what makes a 30-day expiry a non-event.
export async function withSaucepanAuth<T>(
  send: (token: string) => Promise<Response>,
  parse: (res: Response) => Promise<T>,
): Promise<T> {
  let res = await send(await saucepanToken());
  if (res.status === 401) {
    res = await send(await saucepanToken(true));
  }
  return parse(res);
}
