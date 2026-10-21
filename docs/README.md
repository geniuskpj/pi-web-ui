# pi-web-ui — docs index

> Updated 2026-10-21. These are REFERENCE docs: they describe the code as it is (function names,
> invariants, caps, failure modes) and double as the review substrate for model-based code review.
> Latest documentation review: [`../doc-report.md`](../doc-report.md).

## Reading order

1. **[architecture.md](architecture.md)** — start here. Module map (every file → responsibility),
   server + client boot sequences, the 5 core data flows, trust boundaries/auth model, env vars,
   known quirks.
2. **[client.md](client.md)** — the browser side: boot, agent/session lifecycle, rendering rules,
   storage, session sync, key/proxy resolution, markdown/XSS.
3. **[server.md](server.md)** — the server side: auth, endpoints, tools, exec bridge, LLM proxy,
   session worker store, WS hubs.
4. **[terminal.md](terminal.md)** — the terminal dock end-to-end (hub + client): tiers, provisioning,
   protocol, lifecycle, security.

## Read this if you are changing…

| You are touching… | Read first | Cross-seams with |
|---|---|---|
| `src/main.tsx`, `chat.tsx`, storage, sync | `client.md` | `server.md` (`/ws/sync` hub, exec bridge) |
| `server.mjs` routes, auth, builtin tools, proxy | `server.md` + `architecture.md` (trust model) | `client.md` (`pi-tools.ts` caller), `terminal.md` (upgrade gating) |
| `terminal-hub.mjs`, `terminal.tsx`, wterm | `terminal.md` | `server.md` (`killTree`, upgrade handler) |
| `build.mjs`, `vendor-wterm.mjs`, bundling | `architecture.md` (module map) + `.gitignore` (what's generated vs vendored) | — |
| Sessions format / sync bugs | `server.md` (worker store, `/ws/sync` hub) + `client.md` (session-sync, save lifecycle) | `architecture.md` (data flows 2–3) |
| Security posture | `architecture.md` (trust boundaries + known quirks) + `server.md` (auth) | `terminal.md` (Origin allowlist — the reference implementation) |

## Conventions

- Each doc carries an `Updated <date>` line — bump it when the described behavior changes.
- Facts are cited by file + function name so a reviewer can `rg` them; if you change a function that a
  doc describes, update the doc in the same commit.
- `README.md` (repo root) is the user-facing entry point; these docs are the maintainer/reviewer depth
  behind it. The README's Configuration table links here for the full env reference.
