# pi-web-ui — Architecture

> Updated 2026-10-21 · Index + reading order: [docs/README.md](README.md)

Docs index: **architecture.md** (this file) · [server.md](server.md) · [terminal.md](terminal.md) · [client.md](client.md)

## What this is

A browser UI for LLM chat on `@earendil-works/pi-agent-core` + `@earendil-works/pi-ai`, served by a
**Hono** server (`server.mjs`) with **esbuild** bundling (no Vite). The **default chat path runs the
agent loop in the browser**; a server-side agent path (`agent-hub.mjs`, `/ws/agent`, `src/proxy-agent.ts`)
exists but is not the default. Runs on Windows (msys Git Bash); designed to also be used from
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
| `agent-hub.mjs` (263 L) | Server-side agent sessions (non-default path): Agent per session, subscribe-first attach, debounced persist |
| `session-worker.mjs` (89 L) | Worker-thread JSONL session store (atomic tmp+rename writes) |
| `session-id.mjs` (5 L) | Shared `SESSION_ID_RE` (`^[A-Za-z0-9_-]{1,80}$`) used on both sides of the worker seam |
| `build.mjs` (138 L) | esbuild bundle (`app-[hash].js`), hljs→lib/common alias, manifest.json, .br/.gz precompression, stale-bundle pruning |
| `vendor-wterm.mjs` (136 L) | Downloads prebuilt `@wterm/dom`+`@wterm/core` npm tarballs, esbuild-bundles one ESM file into `public/vendor/wterm/` |
| `src/main.tsx` (675 L) | Boot: storage init, token-aware fetch/WS monkeypatch, system-prompt resolve, tools prefetch, Agent creation, session load/save/delete, App shell |
| `src/ui/chat.tsx` (964 L) | Message rendering (markdown after end, plain while streaming), tool rows keyed by toolCallId, UI-only partials map, composer/editor, attachments, usage bar |
| `src/ui/terminal.tsx` (923 L) | Terminal dock client: wterm lifecycle, WS JSON protocol, OSC 133/7 scanner, mobile entry bar, click-to-move, key strip |
| `src/ui/file-picker.tsx` (491 L) | Workspace explorer dialog: two panes, preview cache, multi-select batch attach |
| `src/storage.ts` (248 L) | Store classes over LocalStorageBackend; `ProviderKeysStore` mirrors `pi.key.<provider>` to localStorage (fast tier) |
| `src/local-storage-backend.js` (189 L) | Synchronous localStorage-backed IDB replacement (memory map + per-store key index) |
| `src/session-sync.ts` (214 L) | `/ws/sync` client: metadata merge, push coalescing, pending-push queue, tombstones |
| `src/proxy-agent.ts` (188 L) | Client adapter for server-side agents (event replay → local Agent-like state) |
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

1. **Chat turn (default, browser loop)**: Editor send → pre-send key check (resolver) → `agent.prompt()`
   → pi-agent-core loop → `streamFn` (proxy-stream.ts rewrites baseUrl through `/api/proxy/?url=` when
   the provider lacks CORS) → events (`message_update/end`, `tool_execution_*`) → ChatView renders from
   `agent.state` (never appends deltas). Tools declared to the LLM = server tools from `pi-tools.ts`
   (read/write/edit/bash + extension tools); execution POSTs `/api/exec/tool` with the token.
2. **Persistence**: `message_end`/`agent_end` → debounced (1200 ms) `saveSession()` →
   SessionsStore (localStorage) + `sessionSync.push(id)` → `/ws/sync put` → server converts to JSONL →
   worker writes `data/sessions/<id>.jsonl` (tmp+rename) → `broadcastSessions()` fans metadata to other
   devices. `agent_end` also does a `flushSession()`; `pagehide`/`visibilitychange` flush too.
3. **Session restore**: `?session=` or list click → `loadSession()` pulls BOTH local store and
   `/api/agent/session/:id`, picks the copy with more messages, self-heals the server mirror, creates a
   new Agent WITH the loaded messages.
4. **Tool exec (bash)**: chat → NDJSON stream frames (`partial` → UI-only partials map, throttled
   250 ms server-side; final `result`). Stop/abort → client aborts fetch → server sees `close` →
   AbortController → taskkill /F /T the process tree.
5. **Terminal**: dock open → lazy `loadWterm()` (vendored bundle, CDN fallbacks) → WS
   `/ws/terminal?session=&cols=&rows=` → replay ring → live `{t:"d"}` frames → wterm.write; stdin via
   `{t:"i"}` frames (entry bar diffs value, key strip sends raw bytes).

## Trust boundaries & auth model (summary)

- **Token**: `AUTH_TOKEN` = env `PI_WEB_TOKEN` or auto-generated 24-byte base64url persisted to
  `data/auth-token.txt`. Constant-time compare (`crypto.timingSafeEqual`) via `tokenMatches()`.
- **Blanket gate**: every `/api/*` (except `/api/health`) from a **non-loopback** peer requires the
  token. Loopback peers are trusted unconditionally (OS boundary). Header `x-pi-web-token` by design —
  custom headers cannot be attached cross-origin, so CSRF is structurally impossible for browsers that
  honor CORS. **Browser-origin gate (2026-10-21, r2)**: loopback trust is NOT a browser boundary (DNS
  rebinding / `*.nip.io` make an attacker page same-origin over a loopback socket), so **every `/api/*`
  route except `/api/health`** additionally requires the `Host` header AND the `Origin` header (when
  present) to name a host in `ALLOWED_HOSTS` (localhost, 127.0.0.1, [::1], hostname, all LAN IPs v4+v6,
  `PI_WEB_TERM_ORIGIN` extras; portless Host normalized, trailing dots stripped). Non-browser clients
  send no Origin and are unaffected.
- **Always-token endpoints** (even loopback): `POST /api/exec/tool` and `GET /api/ws/file` — content
  execution/reading is a secrets oracle; drive-by simple POSTs (text/plain, no preflight) and
  DNS-rebinding are named in the code as the reason. Contrast: `GET /api/pi/keys` (ALL provider keys),
  `GET /api/ws/files` (listings), `/api/sessions` and `/api/debug/state` (audit tail) are blanket-gate
  only — reachable after any loopback bypass.
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
  prompt files (`.pi/WEB_SYSTEM.md`, `.pi/SYSTEM.md`, `.pi/APPEND_SYSTEM.md`); `.pi/auth.json` etc. stay
  blocked. Tool execution is audited via `/api/debug/state` (keep last 50, EXPOSE last 20; that route
  has the same Host-derived Origin check as the proxy).

## Environment (all optional)

| Env | Default | Purpose |
|---|---|---|
| `PI_DIR` | `C:/pi-windows-x64/.pi` | pi config dir (auth.json, models-store.json, extensions/) |
| `PI_WS` | parent of PI_DIR | workspace root (cwd for bash + fs containment root) |
| `PI_WEB_DATA_DIR` | `<repo>/data` | sessions mirror, auth-token.txt, pty bridge, ext stage |
| `PORT`/`PI_WEB_PORT`, `HOST`/`PI_WEB_HOST` | 8787 / 0.0.0.0 | listener |
| `PI_WEB_TOKEN` | auto-generated | API token (persisted to data/auth-token.txt) |
| `PI_WEB_TOOLS` | all | comma allowlist for exec-bridge tools |
| `PI_WEB_BASH` / `PI_WEB_BASH_SHELL` | on / `C:\Git\usr\bin\bash.exe` | bash tool on/off + shell path |
| `PI_WEB_TERM_COLS/LINES` | 110/32 | terminal grid clamp (40–240 / 10–120) |
| `PI_WEB_TERM_BRIDGE` | auto | `0`/`pipes` forces pipe tier; path uses that bridge exe |
| `PI_WEB_TERM_ORIGIN` | — | extra host[:port] entries for the terminal Origin allowlist |
| `PI_GIT_HOME` | — | override the Git root (terminal shell env; tar fallback in bridge provisioning) |
| `PROXY_IDLE_MS` | 150000 | LLM proxy stall watchdog |
| `PI_WEB_DEBUG` | off | verbose server logging |

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
