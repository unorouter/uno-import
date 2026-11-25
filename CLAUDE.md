> Scope is only what stops you breaking something or sends you down a wrong path for an hour. When a change makes a rule here wrong, fix the rule in the same commit.

Bun plus Elysia worker that turns a character site URL into a uniform card. ONE gluetun VPN, ONE real Chrome (`rebrowser-puppeteer-core`, headful on Xvfb, profile on the `/profile` volume, puppeteer-real-browser was dropped because sites detect it), ONE job at a time. Every rule below follows from those three.

## Debugging a job, in order

1. Egress. `{"public_ip":""}` plus `000` means the tunnel is up but carries nothing, and EVERY job fails with "navigation failed" while the pod looks Running and `/api/health` answers 200.

```bash
export KUBECONFIG=~/.kube/teleport-unorouter.yaml
P=$(kubectl -n uno-import get pod -l app=uno-import -o jsonpath='{.items[0].metadata.name}')
kubectl -n uno-import exec "$P" -c vpn -- sh -c 'wget -qO- --timeout=8 http://127.0.0.1:8000/v1/publicip/ip'
kubectl -n uno-import exec "$P" -c api -- sh -c 'curl -s -o /dev/null -w "%{http_code}\n" -m 20 https://datacat.run/fresh'
```

2. Starved, not broken. A job `queued` for minutes is usually behind someone else's job. Compare the character ids in the log with yours.

```bash
kubectl -n uno-import exec "$P" -c api -- sh -c 'curl -s localhost:4000/api/health'
kubectl -n uno-import logs "$P" -c api --tail 20
```

3. Drive the live browser. The CDP port is in the profile's `DevToolsActivePort`. Run an in-page `fetch` there to tell "datacat rejected us" from "our own page died".

```bash
kubectl -n uno-import exec "$P" -c api -- sh -c \
  'PORT=$(head -1 /profile/DevToolsActivePort); curl -s 127.0.0.1:$PORT/json | tr "," "\n" | grep url'
```

`Inspected target navigated or closed` and `Runtime.evaluate timed out` ARE the bug. datacat's 18+ gate navigates the tab away when its Exit button is clicked. `evaluateOnNewDocument` presets `age_gate_ok` to stop it. If these errors return, check the site still reads that flag.

## Traps

- `datacat: not_found` is TRANSIENT (404 on one exit, 200 on another). Never add it to `PERMANENT`, that fails recoverable jobs instantly. The character page loading proves nothing, the API is a separate path.
- The URL in a `not_found` error is the PAGE the evaluate ran on, not the API path that 404d.
- Never shorten `HEALTH_VPN_DURATION_INITIAL`. 15s restarts OpenVPN mid negotiation and manufactures the outage.
- gluetun dials PIA through its `custom` provider, not the PIA provider, whose hardcoded server list went stale twice in November 2026 (`TLS handshake failed`, then `no egress`). `start.sh` in the `uno-import-pia` ConfigMap resolves `nl-amsterdam.privacy.network` on every start and writes the IP into `netherlands.ovpn` (custom rejects a hostname on `remote`). If handshakes fail, check the hostname resolves and refresh from `https://www.privateinternetaccess.com/openvpn/openvpn-strong.zip`. A rotate (`PUT /v1/vpn/status`) reuses the server picked at container start.

## Invariants

- `/api/health` is READINESS, `/api/health/live` is LIVENESS, and they must stay different. Readiness stays 200 on a challenged exit, since failing it would stop the jobs that prove egress works. Liveness 503s after `DEAD_AFTER_CONSECUTIVE_JOB_FAILURES` so the kubelet restarts a dead tunnel. One endpoint for both once let a total outage run with the probe green.
- The tab is replaced after EVERY job and Chrome restarts between jobs past `BROWSER_RESTART_AT` of the cgroup limit. A reused tab OOM killed the container and dropped the in-memory queue (2026-11-04). A restart costs one JanitorAI relogin via `ensureJanitorLogin`.
- Only deadline exhausted jobs increment `failStreak`. A permanent upstream verdict (private or deleted card) says nothing about egress.
- The job deadline depends on `queueDepth()`. Alone gets the long deadline. With others queued it gets `BUSY_JOB_DEADLINE_MS` and the failure is tagged `busy:` so the client says "try again", not "card missing".
- Health and debug routes are NOT exempt from the API token, except `/api/health` and `/api/health/live` for the kubelet. The echo routes record prompt text.
- The tunnel rule in `infra/cloudflared` routes only `/api/jobs*` and `/openapi/*` on `cards.unorouter.com`. Everything else is a deliberate 404. Gate a route before adding it there.

## JanitorAI

Characters import through the datacat adapter. `janitorai.ts` only handles standalone lorebooks and plugin scripts.

Two creator flags, readable from the page's `window.mbxM` SSR payload before any fetch, decide what is possible.

- `showdefinition: false` strips `personality`, `scenario` and `example_dialogs` from EVERY read path while still sending their `token_counts`. The import silently yields a name with no personality.
- `allow_proxy: false` means generation never routes anywhere the browser can read.

`showdefinition: false` with `allow_proxy: true` is recoverable. `/generateAlpha` in proxy mode returns the assembled prompt to its caller. `unorouter/public/janitor-extract.js.txt` does this in the user's browser and `janitorai-proxy.ts` through the importer's own session. Both flags false is not recoverable by anything we will build.

Private lorebooks come back the same way.

- One prompt is a random draw. Entries fire by keyword and chance under a per prompt cap, even with no keywords. Only many prompts separate the definition (in every prompt) from entries (lines that come and go together). Keys never reach the prompt, they are read off each entry's heading.
- Entries also land after `</example_dialogs>`, outside every block.
- `/generateAlpha` is rate limited per account (a burst of about 6, then one per 2s, then 429 `RATE_LIMIT_EXCEEDED`). Recovery paces at 2.1s. Never parallelize it.
- The prompt writes the account's persona name wherever the definition says `{{user}}`. Recovery sends a placeholder name and maps it back.
