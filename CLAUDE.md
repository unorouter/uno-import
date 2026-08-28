> **Scope:** only things that stop you breaking something or send you down a wrong path for an hour. Not a tour of the code. When a change makes a rule here wrong, fix the rule in the same commit.

Bun + Elysia worker that turns a character-site URL into a uniform card. ONE gluetun VPN, ONE real Chrome, ONE job at a time. Every rule below follows from those three.

## Debugging a job that is not working

Do these in order. Most "the importer is broken" reports die at step 1 or 2.

### 1. Is there egress at all?

```bash
export KUBECONFIG=~/MEGA/Projects/ai-api/infra/kubeconfig
P=$(kubectl -n services get pod -l app=uno-import -o jsonpath='{.items[0].metadata.name}')
kubectl -n services exec "$P" -c vpn -- sh -c 'wget -qO- --timeout=8 http://127.0.0.1:8000/v1/publicip/ip'
kubectl -n services exec "$P" -c api -- sh -c 'curl -s -o /dev/null -w "%{http_code}\n" -m 20 https://datacat.run/fresh'
```

`{"public_ip":""}` plus `000` means the tunnel is up but carrying nothing, and EVERY job will fail on "navigation failed" until it is fixed. The container still reports itself Running, and `/api/health` still answers 200, so nothing else tells you.

### 2. Is the queue starved rather than broken?

```bash
kubectl -n services exec "$P" -c api -- sh -c 'curl -s localhost:4000/api/health'
kubectl -n services logs "$P" -c api --tail 20
```

A job stuck at `queued` for minutes is usually waiting, not hung: one browser, serial. Check whether the character ids in the log are the ones you submitted. If they are not, you are behind someone else's job.

### 3. Drive the live browser over CDP

The port is chosen by the driver, so read it back out of the process:

```bash
kubectl -n services exec "$P" -c api -- sh -c \
  'PORT=$(ps aux | grep -o "\-\-remote-debugging-port=[0-9]*" | head -1 | cut -d= -f2); \
   curl -s 127.0.0.1:$PORT/json | tr "," "\n" | grep url'
```

Then copy a script in and run it against that port to reproduce what the adapter does (`fetch` from inside the page, same origin, same clearance). This is the only way to tell "datacat rejected us" apart from "our own page died".

**`Inspected target navigated or closed` IS the bug, not a CDP quirk.** It means the tab moved under the evaluate, which is the same cause as `Runtime.evaluate timed out` in the job log: datacat's 18+ gate sets `location` to disney.com about a second after load, and the turnstile solver clicks it. `evaluateOnNewDocument` pre-sets `age_gate_ok` to stop that; if these errors return, check that flag is still the one the site reads.

## Traps that cost real time

- **`datacat: not_found` is TRANSIENT.** The same character id answers 404 on one exit and 200 on another, verified by hand. Do NOT add it to `PERMANENT`: that fails recoverable jobs instantly. The page loading at `datacat.run/characters/janitor/<id>` proves nothing either, since the API is a separate path.
- **The URL in a `not_found` error is the PAGE the evaluate ran on, not the API path that 404d.** Reading it as the request target sends you looking for a route that was never called.
- **gluetun picks a fresh server per restart from ~21k and races its own killswitch.** Without `SERVER_REGIONS` the OUTPUT chain holds an ACCEPT for the PREVIOUS server while OpenVPN dials a new one, so every handshake packet is dropped by our own firewall: no "Initialization Sequence Completed", empty `public_ip`, dead egress, container "healthy". Pin the region.
- **`SERVER_CITIES` crash-loops the container** on `for iptables: failed cleaning up test rule` before any tunnel is attempted. The region pin already lands on the working block; do not narrow further.
- **Do not shorten `HEALTH_VPN_DURATION_INITIAL`.** 15s restarts OpenVPN mid-negotiation so it can never finish, which manufactures the outage it was meant to cure.
- **PIA's Netherlands block is not uniformly healthy.** `195.78.54.x` completes its handshake; `212.102.35.x` and `143.244.41.x` returned `TLS Error: TLS handshake failed` 16 times out of 20 servers with no auth rejection, so credentials are not the cause when you see that.

## Invariants

- **`/api/health` is READINESS, `/api/health/live` is LIVENESS, and they must stay different.** Readiness answers 200 on a challenged exit on purpose: failing it pulls the pod out of the Service, so it stops accepting the very jobs that would prove egress works. Liveness 503s after `DEAD_AFTER_CONSECUTIVE_JOB_FAILURES` whole-job failures, which is what lets the kubelet restart a tunnel that is up but carrying nothing. A single endpoint serving both let a total outage run with the probe green.
- **Only deadline-exhausted jobs increment `failStreak`.** A permanent upstream verdict (private card, deleted card) says nothing about our egress, and counting it would restart a healthy pod because several users in a row imported missing cards.
- **The job deadline is conditional on `queueDepth()`.** One browser means a 15-minute retry holds every other caller behind it, and the per-user cap does not help because the queue in front of you is other people. Alone gets the long deadline; with company, `BUSY_JOB_DEADLINE_MS`, and the failure is tagged `busy:` so the client can say "try again" rather than "this card is missing".
- **Health/debug routes are NOT exempt from the API token** (`/api/health` and `/api/health/live` aside, which the kubelet probes tokenless). The OpenAI-shaped echo routes record prompt text.
- **The tunnel rule in `infra/cloudflared` routes only `/api/jobs*` and `/openapi/*`.** Everything else on `cards.unorouter.com` is a deliberate 404. Adding a route there makes it internet-reachable, so gate it first.

## JanitorAI specifics

Characters import through the **datacat** adapter, not `janitorai.ts`, which only handles standalone lorebooks and plugin scripts.

Two independent creator flags decide what is possible, both readable from the page's `window.mbxM` SSR payload before any fetch:

- `showdefinition: false` strips `personality`, `scenario` and `example_dialogs` from EVERY read path (character API, chat API, SSR) while still sending `token_counts` for them. An import of one of these silently produces a character with a name and no personality.
- `allow_proxy: false` means generation never routes anywhere the browser can read.

`showdefinition: false` + `allow_proxy: true` is recoverable: `/generateAlpha` in proxy mode returns the assembled prompt to its own caller, so one authenticated POST carries the definition. That is what `unorouter/public/janitor-extract.js` does, and it runs in the user's browser because janitorai answers 403 to a datacenter address. Both flags false is not recoverable by any means we will build.
