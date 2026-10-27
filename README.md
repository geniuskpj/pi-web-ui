# pi web

A browser UI for LLM chat built on `@earendil-works/pi-agent-core` + `@earendil-works/pi-ai`
with a **self-contained Preact UI** (`src/ui/`), bundled by **esbuild** (no Vite, no
pi-web-ui, no lit), served by a **Hono** server.

```
npm run build        # esbuild: src/main.tsx -> public/assets/ (hashed filenames + .br/.gz)
npm run build:debug  # readable output + sourcemaps (for debugging)
npm run start        # start server on :8787
npm run dev          # build + start
```

## Architecture

```
Browser (any device)              Node Server
┌──────────────────┐             ┌────────────────────────────────────┐
│ Preact UI        │◄──HTTP─────►│ Hono (static + REST + CORS proxy) │
│ Chat UI + dock   │◄──SSE/WS───►│ agent-hub (DEFAULT chat loop+tools)│
│ (sessions local) │             │ worker store (JSONL sessions)      │
│ LocalStorage     │             │ keys in .pi/auth.json              │
└──────────────────┘             └────────────────────────────────────┘
```

- The **agent loop runs SERVER-SIDE by default** (`agent-hub.mjs`, `/ws/agent`): a run SURVIVES closing
  the browser/phone, and every attached device (PC/phone) sees the same live streaming events — send
  from one device, watch or continue from another. Tools execute in-process on the server; LLM keys
  come from `.pi/auth.json`. `?local=1` → legacy in-browser loop (LLM calls through `/api/proxy`,
  undici-hardened, abort-propagating, stall-watchdog).
- **Sessions** persist to localStorage (LocalStorageBackend) + mirror to the server worker store
  (`data/sessions/*.jsonl`) after each turn.
- **Provider/model config** lives on the server (`/api/pi/config` from pi's `models-store.json`)
  and is cached client-side in localStorage (synchronous boot).
- **API keys** stay in `.pi/auth.json` on the server; import via the 🗄️ button or Settings.

## Documentation (docs/)

Function-level docs describing the actual implementation — written as the review substrate for
model-based code review (they cite exact function names and invariants, so reviewers can verify
claims without the raw source). Start with `architecture.md` — index + reading order:
[`docs/README.md`](docs/README.md).

| Doc | Covers |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | Big picture: module map (every file → responsibility), server + client boot sequences, the 5 core data flows (chat turn, persistence, session restore, bash exec, terminal), trust boundaries/auth model, env vars, known quirks |
| [`docs/server.md`](docs/server.md) | `server.mjs` + `agent-hub.mjs` + `session-worker.mjs`: token auth, every REST endpoint, system-prompt/trust resolution, pi extension loader (shim + staging), the builtin tools' algorithms (`assertInsideRoots` realpath walk, the edit tool's 4-form match pipeline + line-fuzzy pass, bash spawn/spill/kill-tree), exec bridge (NDJSON streaming, audit), LLM proxy (stall watchdog), static serving, JSONL worker store, `/ws/sync` + `/ws/agent` hubs |
| [`docs/terminal.md`](docs/terminal.md) | `terminal-hub.mjs` + `src/ui/terminal.tsx`: pty tier (auto-provisioned msys2 `script.exe`, sha256-pinned download) vs pipes tier (`bash -i` + ONLCR emulation), generated shell rc (OSC 133/7, adaptive PS1, stty), JSON frame protocol, session lifecycle (generation guards, reset recovery, TTL sweeper), Origin allowlist, and the client (wterm loader fallbacks, OSC scanner, mobile entry-bar diffing, click-to-move cursor math, key strip) |
| [`docs/features.md`](docs/features.md) | Per-feature implementation notes (moved out of this README): versions/edit-with-versions, retry + auto-retry, compact, `fetch`, `cdp-open.mjs`, terminal dock, bundling, theme vars, extensions + tools |
| [`docs/lessons.md`](docs/lessons.md) | Vendored-code contracts, debugging patterns, architecture decisions, incident lessons |
| [`bugs.md`](bugs.md) | Open bugs, known limitations, operational notes |
| [`docs/client.md`](docs/client.md) | Browser side: `main.tsx` boot (fetch/WS token monkeypatch, agent creation, session save/load/delete lifecycle), `chat.tsx` rendering rules (markdown memo, partials map, retry repair), storage layer (LocalStorageBackend, `pi.key.*` fast tier), session-sync protocol, proxy/key resolution, `pi-tools.ts` NDJSON bridge, markdown/XSS pipeline, file explorer |

## Self-contained UI (replaces @earendil-works/pi-web-ui — plan.md)

| Concern | File | Notes |
|---|---|---|
| Chat panel (message list, streaming, editor, stop, retry) | `src/ui/chat.tsx` | plain text while streaming, markdown on message_end; tool rows keyed by toolCallId; UI-only partials map; **steering**: send mid-run → held as a pending chip (✎ pull back to composer / ✕ cancel), injected after the current step completes |
| Markdown + highlight + XSS | `src/ui/markdown.ts` | marked (GFM) + highlight.js lib/common + DOMPurify (style/id/name forbidden); memoized |
| LLM connectivity (proxy + keys) | `src/ui/proxy-stream.ts` | vendored proxy-utils + build patches: clone-before-proxy, localStorage-first settings, key resolver w/ bounded server race |
| Session list dialog | `src/ui/session-list.tsx` | server mirror + local metadata merge, load/delete |
| **Alive sessions dialog** | `src/ui/alive-sessions.tsx` | header activity button (count badge) → live view of running/error sessions: click-to-navigate, two-stage Kill (abort), "✓ done" grace, live/paused footer; every runtime emission advances the hub seq so deltas are never stale-dropped |
| Settings dialog | `src/ui/settings.tsx` | model, thinking level, keys (import/add/replace), proxy, token, quota |
| Model selector | `src/ui/model-selector.tsx` | pi-config models only (no built-in catalog) |
| Settings → Import from pi config | `src/ui/settings.tsx` | providers/defaults/key re-import (moved from the header 💾 button) |
| **Workspace file explorer** | `src/ui/file-picker.tsx` | two-pane: file list (mtime-sorted, checkboxes for multi-select) + live preview (line numbers + syntax highlighting via hljs; images; prose); opens at `ws/` by default, remembers last dir |
| **Terminal dock (no node-pty)** | `src/ui/terminal.tsx` + `terminal-hub.mjs` | wterm (prebuilt dist vendored to `public/vendor/wterm/`, lazy-loaded) in a bottom dock; server runs `bash -i` over pipes with a generated rc (readline gives echo/prompt/history/^C as a raw VT stream) — verified by `node term-smoke.mjs` (12 checks); ring-buffer replay, live exit codes via OSC 133, drag-resize; bash tool rows get "↗ terminal" |
| **Attachments** | `chat.tsx` + `server.mjs` `/api/ws/*` | workspace files (no uploads): text files inlined as fenced blocks, images as ImageContent; clipboard image paste (MIME allowlist + 8MB cap); attached files are clickable chips in the composer AND on sent messages → reopen the explorer at that file |
| Secure-context fallbacks | `src/id.ts` | `makeId()` (randomUUID → getRandomValues v4) + `copyText()` (clipboard → execCommand) — the UI works on `http://<LAN-IP>` |
| Storage layer | `src/storage.ts` | store classes over LocalStorageBackend; `pi.key.*` fast tier built in |
| LLM message conversion | `src/llm.ts` | vendored `defaultConvertToLlm` (role filter) + system-notification conversion |
| Theme | `main.tsx` | 3-state cycle (system/light/dark), same `theme` key + `.dark` class as before |

Dropped on purpose (plan.md §9): PDF/office attachment previews, artifacts/REPL panel, i18n,
katex, built-in model catalog, ollama/lmstudio/llama.cpp/vLLM discovery. `bash` covers files/REPL.
Workspace file attach + image paste are BACK (plan.md §12–14) — see the explorer row above.


## Configuration

| Env | Default | Purpose |
|---|---|---|
| `PI_DIR` | `C:/pi-windows-x64/.pi` | pi config dir (auth.json, models-store.json, extensions/) |
| `PI_WS` | parent of `PI_DIR` | workspace root — bash cwd + fs containment root |
| `PI_WEB_DATA_DIR` | `<repo>/data` | sessions mirror, auth-token.txt, pty bridge, ext-loader stage |
| `PORT` / `PI_WEB_PORT` | `8787` | HTTP port |
| `HOST` / `PI_WEB_HOST` | `0.0.0.0` | listen address |
| `PI_WEB_TOKEN` | auto-generated | blanket auth gate for every `/api/*` + `/ws/*` call from non-loopback peers — generated on first boot, persisted to `data/auth-token.txt` |
| `PI_WEB_TOOLS` | all | optional comma-separated allowlist for exec-bridge tools |
| `PI_WEB_BASH` / `PI_WEB_BASH_SHELL` | on / `C:\Git\usr\bin\bash.exe` | bash tool on/off + shell path override |
| `PI_GIT_HOME` | — | override the Git root (terminal shell env + bridge-provisioning tar fallback) |
| `PI_WEB_DEBUG` | off | verbose server logging |
| `PI_WEB_LOG_DIR` | `<PI_WEB_DATA_DIR>/logs` | console tee target — daily `server-YYYYMMDD.log` (ISO timestamps + info/warn/error); broken dir falls back to console-only |
| `PI_WEB_EXIT_ON_STDIN_CLOSE` | off | run the full graceful-shutdown sequence when the parent closes the server's stdin pipe (pipe-friendly Ctrl+C equivalent; used by tests — on Windows a cross-process `kill(SIGINT)` TerminateProcesses without running handlers) |
| `PI_WEB_WS_DEFLATE` | on | `off` disables permessage-deflate on ALL WebSockets (agent, sync **and terminal**) — state frames are the multi-MB path, terminal scrollback is the most compressible one; leave on unless profiling |
| `PI_WEB_MEDIA_TTL_DAYS` | `30` | age-based GC for the image store (`data/media`): blobs older than this are removed at boot. `0` keeps everything. The bytes are content-addressed, so a device that still has the image (or a transcript with inline data) can always re-populate it |
| `PI_WEB_MEDIA_CACHE_MB` | `64` | in-memory read cache for the image store in front of the disk |
| `PI_WEB_DATA_REDUCTION_DEBUG` | off | `1` logs one `[data-reduction]` line per block (modes · forwarded · dropped bytes · flushes) — the way to watch stream coalescing on a scratch port |
| `PI_WEB_TERM_COLS` / `PI_WEB_TERM_LINES` | `110` / `32` | terminal grid size (stty in the pty tier, COLUMNS/LINES env in the pipe tier) |
| `PI_WEB_TERM_BRIDGE` | auto | `conhost` forces Windows ConPTY; `0`/`pipes` forces the pipe tier; a path uses that exe as an msys-pty-bridge; unset → auto-provision msys2 `util-linux` `script.exe` into `data/bin/script/` (sha256-pinned `util-linux-2.40.2-2` package from repo.msys2.org, 8MB size cap, extracts a 63KB exe — once). The bridge is then **proven by running it** with the shell it will drive (that shell must get `isatty(stdin)==true`); a bridge that cannot allocate a pty is refused, and the reason appears in the dock instead of a silent downgrade |
| `PI_WEB_TERM_ORIGIN` | auto | extra `host[:port]` **names for the global Host/Origin allowlist** — every `/api/*` route and all three WS endpoints (`/ws/sync`, `/ws/agent`, `/ws/terminal`), not just the terminal. Comma-separated, scheme stripped. Matching is EXACT on `host:port`: a missing Origin port means the scheme default (http→80, https→443) and a portless Host is tried as the app port plus 80/443 — so a TLS reverse proxy needs its public form spelled out (`PI_WEB_TERM_ORIGIN=name:443`). Localhost, `os.hostname()` and every interface IP are always allowed |
| `PI_WEB_ORIGIN_GATE` | `auto` | how strictly the DNS-rebinding Host/Origin allowlist applies: `auto` = **loopback peers only** (a remote peer must present the API token — that is what lets the UI work on any domain/DDNS name with no config), `strict` = every peer (pre-2026-10-23 behaviour, only allowlisted names pass), `off` = no host check at all (**foot-gun**, warns at boot: a rebinding page can read `/api/sessions` with no token) |
| `PROXY_IDLE_MS` | `150000` | LLM proxy stall timeout |

Full table with all defaults: [`docs/architecture.md`](docs/architecture.md).

### Data use (Settings → Data use) — how much leaves the device

Two dropdowns, both persisted in localStorage next to `pi.autoRetry`, both showing the parameters of
the **selected** option (and the resolved policy, including any advanced override):

| Setting (key) | Options | What it does |
|---|---|---|
| **Images** (`pi.imageLevel`) | `auto` · `high` · `medium` · `low` · `none` | decides per image whether to re-encode, and to what. Two thresholds are applied together — a RESOLUTION cap on the long edge **and** a BYTE cap on the upload — with a resolution FLOOR; the aspect ratio is always preserved (one scale factor for both axes, never a fixed box). `high` 2048px/≤1MB/q0.85 · `medium` 1280px/≤512KB/q0.72 · `low` 1024px/≤256KB/q0.65 · `none` = original bytes, untouched. `auto` = high on lan/wired, medium on wifi/wan/remote, low on metered (`pi.netTier`, from `/api/health`) |
| **Reasoning & stream** (`pi.thinkingLevel`) | `auto` · `paragraph` · `turnEnd` · `none` | when the streamed **reasoning**, the assistant's **answer** and **tool output** are sent. `paragraph` = one frame per complete paragraph (or per N line breaks for tool output) with a byte floor, a soft idle rule and a hard visibility ceiling; `turnEnd` = hold and send ONE frame when the message/tool call ends; `none` = live, every delta (today's behaviour). Per-stream thresholds differ: the answer keeps a small 256B floor / 1.2s ceiling so prose still streams, tool output uses 2KB / 40 lines / 3s |
| **Image storage** (`pi.imageRetention`) | `server` (default) · `browser` | where the encoded image is KEPT. `server`: the bytes live in the server's media store (`data/media/<xx>/<sha256>`, disk-backed) so any device can render them and the model can be re-run on them; `browser`: the bytes stay on this device (the server holds them in memory only and forgets them on restart — the browser re-uploads when it must) |

Advanced overrides (no UI): `pi.imageMaxEdge`, `pi.imageMinEdge`, `pi.imageMaxBytes`,
`pi.imageQuality`, `pi.textLevel`, `pi.toolLevel`. EXISTING sessions are never rewritten, so their stored
images keep whatever form they had; a new session stores what the browser encoded. Nothing here changes
what the model reads on the next turn — only what travels and what is kept.

**How an image is stored (2026-10-25):** the browser ENCODES it (resize + webp/jpeg) and only the encoded
bytes are stored, as **binary** — never the raw original, never base64 (base64 is 33% bigger and buys
nothing). The server keeps them content-addressed under `data/media/<xx>/<sha256>` and builds base64
**only when the LLM request is built**. Two routes carry it: `POST /api/agent/session/:id/media` (binary
in → `{hash, bytes}`) and `GET …/media/:hash` (binary out, by content hash). **gz/br is dropped for
images**: it was measured at ~0% (webp/jpeg/PNG are already entropy-/deflate-coded — a brotli pass is
actually a few bytes BIGGER), and the only thing it ever paid for was base64, precisely the inflation
that storing binary removes (`tests/image-compression.test.mjs` keeps the numbers).

**Status (2026-10-27):** the stream half is DONE, **off by default**, and *reachable from the UI* — the
levels are re-pushed by the agent on every (re)attach (`ProxyAgent.setDataReduction`), so the dropdown
actually takes effect ([`docs/server.md` → "Data reduction on the agent path"](docs/server.md); debug it
with `PORT=8899 PI_WEB_DATA_REDUCTION_DEBUG=1 npm start`). The FIRST chunk of every block ships
immediately (`firstBytes`: thinking 64B / answer 32B / tool 512B) and the idle rule + visibility ceiling
are driven by a per-socket 250 ms tick, so coalescing costs **+0.08 s to first text** (was +1.6 s) while
still saving ~94% of the bytes. `GET …/range` (the backfill path) is redacted too, so a warm client no
longer re-downloads inline base64 (`tests/media-egress.e2e.mjs`). Atomic turns were DROPPED (the `turnEnd` level gives
the same one-frame result). The image storage side is DONE too (binary store, the two routes, retention
setting). Still to wire: the composer — encode on attach, `POST` the bytes, keep `{hash, bytes}` in the
message instead of base64 — see [`docs/client.md` → "the image pipeline"](docs/client.md); until that
lands the composer keeps sending base64 and the server redacts it on the way out.

**Why frames are sized the way they are:** the agent socket negotiates
`perMessageDeflate: { threshold: 1024 }` and `ws` SKIPS the compressor below that, so a 67-byte
per-delta frame travels **uncompressed**. Coalescing to ≥1KB frames is what makes compression engage at
all — measured: an 8.5KB reasoning turn goes from 23KB/346 frames (live) to 1.4KB/9 frames (paragraph)
to 0.2KB/1 frame (turn end), with +1.6s / +13.8s to first text respectively (`npm run bench:data` prints
the table; `tests/thinking-flush.test.mjs` pins the numbers).


## System prompt

The agent's prompt is resolved in one place (`lib/system-prompt.mjs`, shared by the hub, the
in-browser agent and `/api/pi/system`): `.pi/WEB_SYSTEM.md` (the web prompt, **one self-contained
file**) > trusted project `.pi/SYSTEM.md` > `.pi/SYSTEM.md`. `.pi/APPEND_SYSTEM.md` is pi's own file
and is **not** read by the web path. If **no** prompt file exists (e.g. `PI_DIR` points at a path that
does not exist) the server composes a built-in
prompt in code — pi-style `<preamble>/<tools>/<rules>/<cwd>` sections — so a fresh deployment still gets
tool docs and its working directory instead of an agent with no prompt. `/api/pi/system` shows which
case applies (`effective.source`: `file` | `builtin`).

## Session loading (tail-first) & IndexedDB cache

Large sessions (2–7.3MB observed) no longer re-download their whole body on every open.
Layered design — the server decides transfer sizes, the client decides display granularity:

- **Wire compression (every chat):** the full session GET gzips (>2KB bodies, 7.3MB → 1.92MB
  measured); WS state frames use permessage-deflate (`PI_WEB_WS_DEFLATE=off` to disable).
- **Tail-first attach (large chats):** a client advertising `tailFirst` receives only the last
  ~1MB of serialized messages plus a sparse envelope `{fromSeq, messageCount, rewriteSeq,
  rewrittenFrom}`; small chats attach fully as before.
- **`GET /api/agent/session/:id/range`** serves a seq window (`fromSeq`/`toSeq`, or `tailBytes=`)
  as **raw application/gzip** NDJSON (write-through: the same bytes go into IndexedDB and
  DecompressionStream on read). The 1MB cap keeps the HIGH end of the requested window (windows
  stay adjacent to the loaded tail) and aligns the start down to the nearest **user turn**.
  Identity headers: `X-Session-Mutate-Epoch` (rewrite generation), `X-Session-Message-Count`,
  `X-Range-From/To-Seq`, `X-Rewritten-From` (chunks strictly below this seq survive rewrites).
- **Aligned windows + no re-send (C4)**: `/range` windows and live-written chunks share one 64-message
  boundary (`lib/chunk-window.mjs`, imported by both sides — no seam), and the WS attach takes the
  boundary (`lib/chunk-window.mjs`, imported by both sides — no seam), every fetched window is BOUNDED
  to the seqs that were asked for (the headers always describe exactly the bytes sent), and the WS attach takes the
  client's cached reach (`haveTo`) so it does not re-send it: measured, the 1.49MB tail → **0 bytes** when
  the cache covers it, with the client filling that prefix from IndexedDB (a miss falls back to `/range`).
- **IndexedDB cache** (`pi-session-cache`, **schema v2**): per-chunk gzip blobs keyed
  `[sessionId, rewriteSeq, fromSeq]` + a tiny coverage record PER GENERATION. Miss-set = interval diff
  (one small meta get). LRU 200MB (superseded generations evicted first). A rewrite never erases
  anything — the new generation is a fresh key space and the old one is unreachable — a date-based
  `sweepStale()` collects it (5-minute grace once superseded, 30-day hard TTL) on attach and on tab
  focus, and a chunk that fails the on-read integrity check is dropped so the next read refetches.
  **Live write-through:** the attached tail and every later turn are written into IDB as they arrive
  (aligned 64-message windows; the remnant is rewritten in place on `agent_end`/idle/tab-hide), so
  reopening an untouched session no longer re-downloads the tail — nothing about the render changes.
  Wedge-proof by design: lazy open (boot never touches IDB), 2s timeout on every op (a timeout
  is a MISS, not an error), 3-failure circuit breaker, per-session serialized writes, server
  fallback always available.
- **Rewrite invalidation:** every transcript rewrite (✎ edit / 🕘 restore / retry tail-drop /
  compact) bumps a persisted `rewriteSeq` and records `rewrittenFrom` — the seq where the rewrite
  started. Cached chunks strictly below it survive (an edit at 950 of 976 keeps chunks 0–799;
  compaction keeps the prefix below its span start). The client validates the generation on
  every cache read and refetches on mismatch. The generation also survives server restarts.
- **Display by user turn:** sparse (large) sessions render ONE conversational turn (from its
  user message down); “⤒ Load earlier turns” reveals the previous turn per click — pure view
  change when it is in memory, a range fetch when it isn't. Small chats display fully.
- **Transfer policy:** `navigator.connection` (saveData / effectiveType / type) decides — fast
  links background-warm the whole body into IDB; metered links stay manual (expand per click).
  Server fallback: `/api/health` reports `netClass: lan | remote` (peer/Host classification).
- **UI:** the session list shows each session's IDB footprint (“IDB 1.2MB (7 chunks)”); the
  active-sessions dialog has a 🧹 clear button beside Kill — safe during a live run (the cache
  is read-only data; in-flight backfill writes are dropped via a generation guard).

Measured on real sessions: gzip chunking ratio penalty nil (26.4% single vs 26.5–26.6% chunked);
per-chunk browser decompress 3.4–5ms (512KB–1MB); repeat open of a warm 7.3MB session = zero
network. Full analysis: `pr-idb.md`.


## Feature notes, lessons, open items

- **[docs/features.md](docs/features.md)** — the long-form feature write-ups (edit-with-versions,
  retry + auto-retry, compact, the `fetch` tool, `cdp-open.mjs`, the terminal dock, bundling/node
  requirements, theme variables, pi extensions + workspace tools), moved out of this README verbatim.
- **[docs/lessons.md](docs/lessons.md)** — vendored-code contracts to re-check on upstream bumps,
  debugging patterns, standing architecture decisions, incident lessons.
- **[bugs.md](bugs.md)** — open bugs + known limitations + operational notes (the historical fix log
  was dropped; it is in git).
