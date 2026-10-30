# pi-web-ui — Architecture

> Updated 2026-10-27 · Index + reading order: [docs/README.md](README.md)

Docs index: **architecture.md** (this file) · [server.md](server.md) · [terminal.md](terminal.md) · [client.md](client.md)

## What this is

A browser UI for LLM chat on `@earendil-works/pi-agent-core` + `@earendil-works/pi-ai`, served by a
**Hono** server (`server.mjs`) with **esbuild** bundling (no Vite). The **default chat path runs the
agent loop SERVER-SIDE** (`agent-hub.mjs`, `/ws/agent`) — a run survives closing the browser/phone,
and every attached device (PC/phone) sees the same live streaming events; the legacy in-browser loop
remains behind `?local=1`. Runs on Windows (msys Git Bash); designed to also be used from
phones over plain-http LAN (hence the secure-context fallbacks in `src/id.ts`).

```
Browser (any device)                 Node server (:8787)
┌───────────────────────────┐        ┌────────────────────────────────────────────┐
│ Preact UI (src/ui/*)      │ HTTP   │ Hono: static + REST + CORS LLM proxy       │
│ in-browser Agent loop     │◄──────►│ exec bridge (/api/exec/tool, token-gated)  │
│ (pi-agent-core)           │        │ workspace fs endpoints (/api/ws/*)         │
│ LocalStorageBackend       │ WS     │ worker store: data/sessions/*.jsonl        │
│  (settings/keys/sessions) │◄──────►│ /ws/sync (metadata)  /ws/agent (SSR agents)│
│ terminal dock (wterm)     │        │ terminal-hub.mjs  /ws/terminal (pty/pipes) │
└───────────────────────────┘        │ keys/PI config: .pi/auth.json, .pi/*.json  │
                                     └────────────────────────────────────────────┘
```

## Module map

| File | Responsibility |
|---|---|
| `server.mjs` (1570 L) | Hono app: auth gate, REST, exec bridge, fs endpoints, LLM proxy, static serving, WS routing/upgrade, builtin tools (read/write/edit/bash), pi extension loader |
| `terminal-hub.mjs` (998 L) | Pseudo-terminal hub: pty tier (msys2 `script.exe`) / pipes tier (`bash -i`), JSON-frame WS protocol, replay ring, session lifecycle |
| `agent-hub.mjs` | **Server-side agent sessions — the DEFAULT chat path**: Agent per session with in-process tools (builtin+pi extensions), effective system prompt, settings.json default model; subscribe-first attach, debounced persist, per-session SSE subscriber sets; `retry()` resumes a failed run AT THE FAILURE POINT (drop the error message → `agent.continue()`; no duplicated user turn, completed tools not re-run) with auto-retry (3×3 s) for rate-limit/network errors |
| `session-worker.mjs` (89 L) | Worker-thread JSONL session store (atomic tmp+rename writes) |
| `session-id.mjs` (5 L) | Shared `SESSION_ID_RE` (`^[A-Za-z0-9_-]{1,80}$`) used on both sides of the worker seam |
| `lib/pi-catalog.mjs` | merged provider catalog: builtin catalog ∪ `models-store.json` ∪ `.pi/models.json` ∪ `auth.json`; usable-only projection for the picker, keyless placeholder, `$ENV` keys |
| `lib/provider-models.mjs` | provider `/models` discovery (boot + 30 min): parse + merge new ids into a provider's list |
| `lib/session-search.mjs` | whole-session find: roles, turns, snippets with match offsets, caps |
| `lib/rg-json.mjs` | `rg --json` argv + parser for the workspace search (grouped, per-file caps) |
| `lib/image-dims.mjs` | pixel size from an image HEADER alone (PNG/JPEG/GIF/WebP/BMP) — lets the composer apply the resolution cap without decoding |
| `src/image-encode.ts` | browser-side encode (`encodeForModel`: decide → capped decode → plan → webp/jpeg) + binary upload (`uploadImage`) |
| `lib/display-gate.mjs` | which user turns a large session shows (seq-space gate) |
| `lib/turn-timing.mjs` | opt-in `PI_WEB_TIMING=1` turn timeline (fetch headers/first chunk + hub stages) |
| `build.mjs` (138 L) | esbuild bundle (`app-[hash].js`), hljs→lib/common alias, manifest.json, .br/.gz precompression, stale-bundle pruning |
| `vendor-wterm.mjs` (136 L) | Downloads prebuilt `@wterm/dom`+`@wterm/core` npm tarballs, esbuild-bundles one ESM file into `public/vendor/wterm/` |
| `src/main.tsx` (675 L) | Boot: storage init, token-aware fetch/WS monkeypatch, system-prompt resolve, tools prefetch, Agent creation, session load/save/delete, App shell |
| `src/ui/chat.tsx` (964 L) | Message rendering (markdown after end, plain while streaming), tool rows keyed by toolCallId, UI-only partials map, composer/editor, attachments, usage bar |
| `src/ui/terminal.tsx` (923 L) | Terminal dock client: wterm lifecycle, WS JSON protocol, OSC 133/7 scanner, mobile entry bar, click-to-move, key strip |
| `src/ui/file-picker.tsx` (491 L) | Workspace explorer dialog: two panes, preview cache, multi-select batch attach |
| `src/storage.ts` (248 L) | Store classes over LocalStorageBackend; `ProviderKeysStore` mirrors `pi.key.<provider>` to localStorage (fast tier) |
| `src/local-storage-backend.js` (189 L) | Synchronous localStorage-backed IDB replacement (memory map + per-store key index) |
| `src/session-sync.ts` (214 L) | `/ws/sync` client: metadata merge, push coalescing, pending-push queue, tombstones |
| `src/proxy-agent.ts` (188 L) | Client adapter for the SERVER-side agent loop (default chat path): WS event replay → local Agent-like state, survives reconnects |
| `src/ui/proxy-stream.ts` (135 L) | streamFn with CORS-proxy rewrite (clone-before-proxy) + getApiKey resolver races |
| `src/pi-tools.ts` (79 L) | Declares server tools to the browser agent; execute() → `/api/exec/tool` (NDJSON streaming for bash) |
| `src/pi-import.ts` (118 L) | pi config cache (`pi.modelsCache`, `window.__PI_PROVIDERS`), default-model pick |
| `src/llm.ts` (60 L) | Vendored `defaultConvertToLlm` (role filter) + system-notification → `<system>` user message |
| `src/id.ts` (43 L) | `makeId()` (randomUUID → getRandomValues v4) and `copyText()` (clipboard → execCommand) — secure-context fallbacks |
| `src/diag.ts` + `diag-panel.tsx` | Client log ring (2000 entries), levels, FAB diagnostics drawer |
| `src/ui/markdown.ts` (73 L) | marked(GFM) + hljs + DOMPurify (`FORBID_ATTR: style,id,name`), fence-language whitelist, 20k ReDoS cap |
| `src/ui/settings.tsx`, `session-list.tsx`, `model-selector.tsx`, `system-prompt-dialog.tsx` | Dialogs (write the exact localStorage keys the runtime reads) |
| `src/patches/*` | esbuild aliases: attachment-utils patch + stubs for dropped deps (docx/xlsx/jszip/mistral/model-discovery) |

## Boot sequence

**Server** (`node server.mjs`): constants (PI_DIR, DATA_DIR, PORT, HOST) → auto-generate
`data/auth-token.txt` if unset → Hono middleware (blanket `/api/*` auth + request log) → route
registration (order matters: static catch-all LAST) → extension staging (`loadPiExtensions()` fired
async) → worker store (`new Worker(session-worker.mjs)`) → AgentHub + terminal hub (provisions the
pty bridge in the background) → `serve()` with an `upgrade` handler that gates `/ws/*` then dispatches
by pathname.

**Client** (`src/main.tsx init()`): `?reset-storage` wipe → theme class → monkeypatch `fetch` (attach
`x-pi-web-token`, 401 → prompt+retry) and `WebSocket` (append `?token=`) → resolve `piSystemPrompt`
(`/api/pi/system`) → prefetch server tools (`/api/exec/tools`) → seed proxy localStorage keys →
`createAgent()` (streamFn + getApiKey wired) → render → `sessionSync.connect()` → background: config
refresh, `?session=` restore.

## Core data flows

1. **Chat turn (default, SERVER-side loop, 2026-10-21)**: Editor send → `ProxyAgent.prompt()` → WS
   `/ws/agent` `{prompt, content, images}` → `agent-hub.mjs` runs the Agent **in Node**: tools
   (read/write/edit/bash + pi extensions) execute IN-PROCESS (same objects as the exec bridge), API
   keys come from `.pi/auth.json` (then a provider's own `apiKey` in `.pi/models.json`; a models.json
   provider with none resolves to the keyless placeholder — see [server.md](server.md) §Provider
   catalog), system prompt = `WEB_SYSTEM.md`/`SYSTEM.md` precedence. EVERY event
   (message_update, tool_execution_update partials, agent_end) is broadcast to ALL attached devices —
   send from the PC, watch live from the phone, close the phone and the run keeps going.
   `?local=1` → legacy browser loop (`streamFn` via `/api/proxy` when the provider lacks CORS).
2. **Persistence (dual, 2026-10-21)**: the server-side hub persists the AUTHORITATIVE JSONL after every
   turn (independent of any browser); the client additionally mirrors via debounced (1200 ms)
   `saveSession()` → SessionsStore (localStorage) + `sessionSync.push(id)` → `/ws/sync put` →
   `broadcastSessions()` fans metadata to other devices. `agent_end` also does a `flushSession()`;
   `pagehide`/`visibilitychange` flush too.
3. **Session restore**: `?session=` or list click → `loadSession()` pulls BOTH local store and
   `/api/agent/session/:id`, picks the copy with more messages, self-heals the server mirror, creates a
   new Agent WITH the loaded messages.
4. **Tool exec (bash)**: chat → NDJSON stream frames (`partial` → UI-only partials map, throttled
   250 ms server-side; final `result`). Stop/abort → client aborts fetch → server sees `close` →
   AbortController → taskkill /F /T the process tree.
5. **Session status discovery (fable5 design, 2026-10-21)**: the hub keeps an in-memory runtime per
   session `{status: running|idle|error, startedAt, turn, currentTool, lastText (≤120-char preview),
   pendingPrompts}`. BOUNDARY events (agent_start/end, tool start/end) and assistant message_end emit a
   tiny `{type:"runtime", runtime:{…, clients, seq}}` frame on **/ws/sync** — IMMEDIATE (bypasses the
   300ms coalesce + 1s list cache + the client 5s metadata merge); `message_update` refreshes lastText
   in memory only (broadcast ≤1/2s per running session); `/api/sessions` and full `sessions` frames
   embed NON-IDLE runtime. EVERY runtime emission advances the shared hub seq (2026-10-21 review P2:
   runtime-only deltas — attach/detach client counts via `agentHub.emitRuntime`, queued prompts —
   were dropped by the client's stale seq guard before). Client: seq-guarded runtimeMap (volatile —
   never persisted, never lastModified-merged) → session list pins running/error on top with badges
   + preview, header activity button + **AliveSessionsDialog** (`src/ui/alive-sessions.tsx` — live
   rows, click-to-navigate, two-stage Kill via `POST /api/agent/abort`, "✓ done" grace, live/paused
   footer), resume banner on bare boots, `document.title` prefix. Detached devices never get event
   deltas — the attached view already has subscribe-first snapshot+live.
6. **Terminal**: dock open → lazy `loadWterm()` (vendored bundle, CDN fallbacks) → WS
   `/ws/terminal?session=&cols=&rows=` → replay ring → live `{t:"d"}` frames → wterm.write; stdin via
   `{t:"i"}` frames (entry bar diffs value, key strip sends raw bytes).

## Trust boundaries & auth model (summary)

- **Token**: `AUTH_TOKEN` = env `PI_WEB_TOKEN` or auto-generated 24-byte base64url persisted to
  `data/auth-token.txt`. Constant-time compare (`crypto.timingSafeEqual`) via `tokenMatches()`.
- **Blanket gate**: every `/api/*` (except `/api/health`) from a **non-loopback** peer requires the
  token. Loopback peers are trusted unconditionally (OS boundary). Header `x-pi-web-token` by design —
  custom headers cannot be attached cross-origin, so CSRF is structurally impossible for browsers that
  honor CORS. **Browser-origin gate (2026-10-21 r2; retuned 2026-10-23)**: loopback trust is NOT a
  browser boundary (DNS rebinding / `*.nip.io` make an attacker page same-origin over a loopback
  socket), so the `Host` header AND the `Origin` header (when present) must name a host the server is
  actually reachable on — an EXACT `ALLOWED_HOSTS` entry per name, IPv6 bracketed, trailing dots
  stripped, a malformed Origin failing CLOSED, no suffix matching. A missing Origin port means the
  SCHEME DEFAULT (http→80, https→443) and a portless `Host` is tried as the app port plus 80/443, so a
  TLS reverse proxy works by listing its public form (`PI_WEB_TERM_ORIGIN=name:443`) — while
  `Origin: http://localhost:3000` (another local app) stays rejected, which "ignore the port" would
  have accepted (grok review 2026-10-23). The token exemption is ALSO tied to the Host: a loopback
  caller is trusted only when it names a LOCAL host (`isLocalHost()`), so a local reverse proxy serving
  a public name must present the token, in every gate mode.
  Strictness is `PI_WEB_ORIGIN_GATE`: **`auto` (default) applies the gate to LOOPBACK peers only** —
  loopback is the one trust path that skips the token, so a rebinding page still arrives as loopback and
  is still rejected, while a remote peer that presents the token may use ANY hostname (before this, every
  custom DNS name needed `PI_WEB_TERM_ORIGIN` and a TLS proxy could never work at all); `strict` gates
  every peer; `off` disables it and warns loudly at boot. Also 2026-10-23: the `?token=` query form is
  accepted on `/ws/*` upgrades ONLY. Non-browser clients send no Origin and are unaffected.
- **Always-token endpoints** (even from loopback, in any gate mode): `POST /api/exec/tool`,
  `GET /api/pi/keys` (EVERY provider key — the strongest secrets oracle) and `GET /api/ws/file`
  (content). Content execution and secret reads justify it: a drive-by page can send simple cross-origin
  POSTs (text/plain, no preflight) and DNS-rebinding can reach loopback — the token header is unforgeable
  cross-origin. Contrast (blanket gate only, i.e. loopback-friendly or valid-token): `GET /api/exec/tools`
  (tool META, no execute), `GET /api/ws/files` (listings), `POST /api/pi/key` (one provider's key),
  `/api/sessions` and `/api/debug/state` (audit tail). Asserted by `npm run test:security` (the
  2026-10-23 rows run from a REAL non-loopback peer).
- **WS**: `/ws/*` upgrades are token-gated for non-loopback in `server.mjs`; `/ws/terminal` ADDITIONALLY
  enforces a strict Origin allowlist (real hosts: localhost, 127.0.0.1, hostname, LAN IPs,
  `PI_WEB_TERM_ORIGIN` extras) inside the hub, because WS has no CORS and DNS-rebinding presents a
  mismatched Origin/Host pair; a MISSING Origin is accepted only from loopback. `/ws/sync` and
  `/ws/agent` now validate a PRESENT Origin against the same allowlist at upgrade (browsers always send
  one; non-browser clients without Origin keep the token gate) — fixed 2026-10-21. Session ids must be
  unguessable (≥16 chars) — the id
  is the reattach auth for loopback peers (the client may still CHOOSE the id, so Origin remains the
  real gate).
- **Filesystem**: all fs paths (tools + picker) go through `assertInsideRoots()` (realpath walk, roots =
  workspace + agent dir). Dotfiles hidden/403 in the picker, with an allowlist for the three system
  prompt files (`.pi/WEB_SYSTEM.md` — the self-contained WEB prompt — and `.pi/SYSTEM.md`; resolved by
`lib/system-prompt.mjs`, which COMPOSES a built-in prompt when none exist; `.pi/APPEND_SYSTEM.md` is
pi's file and is not read here); `.pi/auth.json` etc. stay
  blocked. Tool execution is audited via `/api/debug/state` (keep last 50, EXPOSE last 20; that route
  has the same Host-derived Origin check as the proxy).

## Environment (all optional)

| Env | Default | Purpose |
|---|---|---|
| `PI_DIR` | `C:/pi-windows-x64/.pi` | pi config dir (`auth.json`, `models-store.json`, `models.json`, `extensions/`) |
| `PI_WS` | parent of `PI_DIR` | workspace root — bash cwd + fs containment root |
| `PI_WEB_DATA_DIR` | `<repo>/data` | sessions mirror, `auth-token.txt`, logs, media, pty bridge, ext-loader stage |
| `PORT` / `PI_WEB_PORT` | `8787` | HTTP port |
| `HOST` / `PI_WEB_HOST` | `0.0.0.0` | listen address |
| `PI_WEB_TOKEN` | auto-generated | blanket gate for every `/api/*` + `/ws/*` call from non-loopback peers; generated on first boot, persisted to `data/auth-token.txt` |
| `PI_WEB_TOOLS` | all | comma-separated allowlist for exec-bridge tools |
| `PI_WEB_BASH` / `PI_WEB_BASH_SHELL` | on / `C:\Git\usr\bin\bash.exe` | bash tool on/off + shell path |
| `PI_WEB_DEBUG` | off | verbose server logging |
| `PI_WEB_LOG_DIR` | `<PI_WEB_DATA_DIR>/logs` | console tee target: daily `server-YYYYMMDD.log` (ISO timestamps + info/warn/error); a broken dir falls back to console-only |
| `PI_WEB_EXIT_ON_STDIN_CLOSE` | off | run the graceful-shutdown sequence when the parent closes stdin (pipe-friendly Ctrl+C; used by tests) |
| `PI_WEB_WS_DEFLATE` | on | `off` disables permessage-deflate on ALL WebSockets (agent, sync, terminal) |
| `PI_WEB_MEDIA_TTL_DAYS` | `30` | age-based GC for the image store (`data/media`); `0` keeps everything |
| `PI_WEB_MEDIA_CACHE_MB` | `64` | in-memory read cache in front of the media disk store |
| `PI_WEB_DATA_REDUCTION_DEBUG` | off | `1` logs one `[data-reduction]` line per block (modes · forwarded · dropped bytes · flushes) |
| `PI_WEB_TERM_COLS` / `PI_WEB_TERM_LINES` | `110` / `32` | terminal grid (stty in the pty tier, `COLUMNS`/`LINES` in the pipe tier) |
| `PI_WEB_TERM_BRIDGE` | auto | `conhost` forces Windows ConPTY, `0`/`pipes` forces the pipe tier, a path uses that exe as an msys-pty bridge; unset → auto-provision msys2 `script.exe` into `data/bin/script/` (sha256-pinned, proven by running it) |
| `PI_WEB_TERM_ORIGIN` | auto | extra `host[:port]` names for the GLOBAL Host/Origin allowlist (every `/api/*` route and all three WS endpoints). Exact `host:port` matching — a TLS reverse proxy needs its public form (`name:443`). Localhost, `os.hostname()` and interface IPs are always allowed |
| `PI_WEB_ORIGIN_GATE` | `auto` | how strictly that allowlist applies: `auto` = loopback peers only (a remote peer must present the token — this is what lets any domain/DDNS name work), `strict` = every peer, `off` = no check (**foot-gun**) |
| `PI_GIT_HOME` | — | override the Git root (terminal shell env + bridge-provisioning tar fallback) |
| `PROXY_IDLE_MS` | `150000` | LLM proxy stall watchdog |

## Known quirks (factual, noticed while documenting — for the reviewer to verify)

- `server.mjs` static catch-all defines `body2()` whose return value is unused, then repeats the same
  compressed-serve logic → dead helper + duplicate disk reads of `.br`/`.gz`.
- `/api/exec/tools`, `/api/pi/key` check the env-derived constant `TOKEN = process.env.PI_WEB_TOKEN`
  with plain `!==` (not `tokenMatches`, not the auto-generated `AUTH_TOKEN`) — an extra layer that only
  activates when `PI_WEB_TOKEN` is set, and weaker (non-timing-safe) than the gate it duplicates.
- Origin/Host posture — **FIXED 2026-10-21 (r2: scope = every `/api/*` except `/api/health`)**:
  the browser-origin gate requires allowlisted Host+Origin on all API routes (an earlier prefix list
  left `/api/agent/session/:id` — message BODIES — reachable to a rebound page), `/ws/sync` +
  `/ws/agent` validate a present Origin at upgrade, and `/api/pi/keys` is always-token.
- `agent-hub.mjs` broadcast handling — **FIXED 2026-10-21**: `attach()` now buffers via a per-session
  `entry.buffer` hook and `onEvents()` fans out from a per-session subscriber Set — the old global
  `this.broadcast` swap/restore was not reentrant (overlapping attaches clobbered each other; the first
  unsubscribe stopped the second subscriber's delivery).
- Outbound WS backpressure: the SYNC hub's `safeSend` still silently drops frames when
  `ws.bufferedAmount > 4MB` (data-loss window for cross-device mirror metadata). The TERMINAL hub now
  CLOSES (terminate) a lagging socket past 4MB instead — the client reconnects and replays (fixed
  2026-10-21; a dropped terminal `d` frame used to desync the emulator with no recovery path).
- `main.tsx` fetch monkeypatch matches `url.includes("/api/") || url.includes("/ws/")` (same substring
  test in the WebSocket patch for `?token=`) — ANY url whose string contains those fragments gets the
  token attached (the LLM proxy strips `x-pi-web-token` before forwarding; other cross-origin URLs
  would not).
- The LLM proxy's SSRF filter (`proxyTargetBlocked` + `dottedFromInet`) is HOSTNAME-pattern based —
  hardened 2026-10-21 r2 against inet_aton spellings (`127.1`, `2130706433`), IPv4-mapped IPv6 in all
  forms, expanded IPv6 loopback, trailing dots, 198.18/15 — but a DNS name that RESOLVES to an internal
  IP (e.g. `localtest.me` as a proxy TARGET) is still reachable (no resolve-and-pin). Redirect hops are
  revalidated AND strip Authorization on cross-host hops.
- Editor `send()` busy-waits (25 ms poll loop, ≤1 s) for `isStreaming` to flip as a double-send guard.
- `LocalStorageBackend` quota handling evicts the largest *other* stored session without asking.
