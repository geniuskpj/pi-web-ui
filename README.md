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

## Bug fixes vs the naive implementation (history)

| Bug | Root cause | Fix |
|---|---|---|
| Streaming message vanished | `message_end` cleared container mid-run | our renderer replaces from state, never clears |
| STOP button stuck | `isStreaming` flipped after render | Editor re-syncs on `agent_end` → `waitForIdle` |
| Send hung on keys | IDB key read hung | localStorage `pi.key.*` fast tier (built into ProviderKeysStore) |
| Final message vanished | `finishRun` race after `agent_end` | idle re-sync (notify after waitForIdle) |
| 401 prompt never fired | checked `isStreaming` inside `agent_end` (always true) | check after `waitForIdle()` |
| Stale bundle | unhashed filename | content-hashed + no-cache + 304 |
| Tool calls failed off-localhost | `crypto.randomUUID` is secure-context-only | `makeId()` fallback (getRandomValues v4) in `src/id.ts` |
| Markdown showed only bold | Tailwind preflight (in vendored app.css) strips list markers + heading weights | `.pw-md` restores list-style/heading sizes |
| Picker: line numbers overlapped code on horizontal scroll | sticky gutter had no z-index | `z-index: 1` + solid bg (verified pinned at scrollLeft 500) |
| Picker: gutter vanished below first screen on vertical scroll | flex `align-items: stretch` squashed both `<pre>`s to the viewport; text overflowed and code painted over the gutter | `align-items: flex-start` (children size to content) |
| Picker: first chip click showed nothing | `select()` built the cache key from a stale closure `path` | `select(entry, dirOverride)` — fresh dir passed explicitly |
| Picker: gutter/code misaligned on long lines | per-line flex rows desync when lines wrap | sticky gutter + no-wrap `<pre>`s, shared `--code-line-h` |
| Session list empty | metadata not synced | server REST + local merge in dialog |
| Clicking a session opened fresh chat | loadSession ignored initialState | agent created WITH loaded messages |
| Saves lost during WS reconnect | push no-op'd on closed socket | pending-push queue flushed on open |
| Renamed session kept old position | updateTitle didn't bump lastModified | bumped + server sync push |
| Deleted session resurrected | save debounce + pagehide flush | `deletedSessionIds` guard + timer clear + id clear before nav |
| Every prompt 400'd after a server restart ("400 status code (no body)", nvidia NIM `missing field tool_call_id`) | `_writeSession` persisted only `{role, content, timestamp}` — `toolResult.toolCallId` was stripped from the JSONL mirror; after a reboot the rehydrated history converted to `role:"tool"` messages without `tool_call_id` (and pi-ai duplicated them), and the failed run's empty assistant message kept every retry broken | persist FULL message objects; `normalizeRestoredMessages()` re-links orphan toolResults by order on restore (strip dangling toolCalls, drop unmatchable orphans); one-time mirror repair `node tests/repair-mirror-toolcalls.mjs`; regression `tests/restore-toolcall.test.mjs` |
| IDB hangs | wedged LevelDB | LocalStorageBackend replacement |

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
| `PI_WEB_TERM_COLS` / `PI_WEB_TERM_LINES` | `110` / `32` | terminal grid size (stty in the pty tier, COLUMNS/LINES env in the pipe tier) |
| `PI_WEB_TERM_BRIDGE` | auto | `0`/`pipes` forces the pipe tier; a path uses that exe as an msys-pty-bridge; unset → auto-provision msys2 `util-linux` `script.exe` into `data/bin/script/` (sha256-pinned `util-linux-2.40.2-2` package from repo.msys2.org, 8MB size cap, extracts a 63KB exe — once) |
| `PI_WEB_TERM_ORIGIN` | auto | extra `host[:port]` entries for the /ws/terminal Origin allowlist (reverse proxies / custom DNS names) |
| `PROXY_IDLE_MS` | `150000` | LLM proxy stall timeout |

Full table with all defaults: [`docs/architecture.md`](docs/architecture.md).

## Notes

- **Bundle**: ~1.0MB (0.20MB brotli). node_modules ~75MB. Only deps: preact,
  pi-agent-core, pi-ai, marked, dompurify, highlight.js (lib/common), diff + server-side
  hono/ws/undici. Provider SDKs stubbed to `stubs/empty` (openai-compatible only).
- **Theme variables** come from the vendored `public/assets/app.css` (pi-web-ui's compiled
  tailwind output, kept as a static asset — no runtime dependency). New-component styles live
  in `public/style.css`.
- **Sessions**: stored in localStorage + mirrored to `data/sessions/*.jsonl` on the server.
  Survive page reloads and server restarts.
- **pi extensions + workspace tools**: the chat agent gets the user's real pi extensions
  (`.pi/extensions/*.ts`, loaded server-side with a lightweight shim) plus built-in workspace
  tools (`read_file`, `write_file`, `edit`, `bash`, `fetch` — no `ls` builtin, mirroring pi's default
  tool set; bash covers listing) and the **`cdp_eval` extension**
  (evaluate JS in the user's debugged browser on :9222 — UI automation/verification, modeled
  on the `cdp-*.mjs` helper scripts) via `POST /api/exec/tool`. The `edit` tool also recovers
  a path nested inside `edits[]` and fails with the exact call shape when `path` is missing.
  Path containment on fs tools; exec bridge always requires the API token; executions audited
  via `/api/debug/state`; optional per-tool allowlist `PI_WEB_TOOLS`. Tool list: `GET /api/exec/tools`.
- **`fetch` tool (2026-10-22)**: server-side GET for web pages — HTML → clean markdown by the
  vendored boilerplate stripper (`lib/hp2.mjs`, from the ws/boilerplate-htmlparser2 prototype:
  per-domain content selection for Wikipedia/GitHub/MDN/HF/Docusaurus, token-matched chrome
  dropping, code fences; ~230KB of deps, no jsdom/DOMPurify [DOMPurify silently no-ops on
  linkedom], no html2markdown.exe). SSRF-guarded with the LLM proxy's machinery
  (`proxyTargetBlocked` + `llmAgent`'s depth-2 `proxyLookup` + manual redirect loop re-validating
  every hop). Inline output = first 50KB (web content reads from the top); LARGER RESULTS SPILL
  to `data/tmp/fetch/<slug>.md` (7-day prune) so `rg`/`read_file` can extract sections; `raw:true`
  returns the untouched body; body cap 3MB, timeout 20s default/60s max. Test: `npm run test:fetch`.
- **Message fork/rewrite (2026-10-22, llama.cpp-webui parity; UX clarified 2026-10-23)**: hover a user message → ⑂ fork (copy the transcript UP TO AND INCLUDING this message into a NEW session; you STAY in the original — nothing disappears; the fork is marked with a `⑂` title suffix so the two are distinguishable in the sidebar; the assistant response AFTER the clicked message belongs to the original's continuation, not the fork) and ✎ edit (tail message → in-place rewrite: truncate + prefill the composer; older message → fork first, NAVIGATE to the fork + prefill — pi's "the branch you leave survives" semantics, linear-model adaptation). Server: `forkSession`/`rewriteSession` (idle only; rewrite drops queued steering + broadcasts a full state frame for multi-device resync + writes a PRE-REWRITE gzip backup via `backupMirror` — the dropped tail is recoverable; fork self-hydrates cold sessions from the mirror via the `loadMessages` dep). STICKY TITLE: the entry's title is now actually maintained (`entry.title` seeded from mirror metadata, saved on every persist) — compaction/rewrites never rename the session, and forks inherit `title + " ⑂"`. JSONL: mirror metadata gains `version:1` + `forkedFrom` (pi's `parentSession` equivalent; pi itself stores v3 TREE entries with id/parentId, which the linear mirror deliberately does not adopt). **Usage counters need no migration**: the client UsageBar is message-derived — forks INHERIT the copied messages' usage (those tokens were spent), rewrites DROP removed usage; asserted in tests. Test: `npm run test:fork`.
- **Compact (2026-10-22, pi /compact parity)**: ⤓ compact button in the stats bar (server-side mode, idle, >6 messages). Algorithm mirrors pi's compaction.md: cut point by backwards token-estimate walk (chars/4) to keepRecentTokens (default 20k), cut advanced past toolResults (never splits call/result), span starts AFTER any previous compaction summary (iterative folding), serialization `[User]/[Assistant]/[Assistant tool calls]/[Tool result (name)]` with thinking OMITTED and tool results truncated at 2000 chars, structured checkpoint summary (Goal/Constraints/Progress/Key Decisions/Next Steps/Critical Context) via a throwaway Agent on the session model (thinkingLevel off). Replacement = [flagged summary message, ...kept]; the summary renders as a COLLAPSIBLE context block (⤓ collapsed by default — click to view), carries NO usage (totals drop to the kept tail). Divergence from pi: our linear mirror is REWRITTEN, so a pre-compact backup lands in `data/tmp/precompact/<id>-<ts>.jsonl.gz` (GZIP, 31-day prune). Guards: idle-only, one at a time; prompt/steer/fork/rewrite reject with "compaction in progress". WS: `{type:"compact", id, keepRecentTokens}` → `{type:"compacted", id, …}` (10-min client await; an LLM run on a huge session can take minutes — a `compacting: true` state frame shows an elapsed-time progress banner above the composer on ALL devices, surviving client timeouts). STICKY TITLE: compaction never renames the session (the old logic re-derived the title from the first user message — post-compact that IS the summary → "## Conversation summary (auto-compacted)"); once a real title exists it stays. COMPACTED-MIRROR PUT GUARD: a client push onto a compacted mirror must also start with the summary — stale pre-compact copies are rejected (`put-rejected` + toast). Auto-threshold compaction NOT implemented (manual only, like /compact). Test: `npm run test:compact`.
- **`cdp-open.mjs` (2026-10-22)**: open a URL in the user's debugged browser — `node cdp-open.mjs
  <url>` (plus `--list` / `--close <id>`). **Chrome/Edge only** — the whole CDP tooling (cdp_eval,
  cdp-open, the :9222 target model) targets Chromium browsers; Firefox/Safari are not supported.
  Exists because every naive path fails: `window.open`
  from cdp_eval is popup-blocked, and Edge's `PUT /json/new?url=` creates the tab but NEVER
  navigates it (verified — the tab stays about:blank). The helper uses `Target.createTarget`
  over the browser-level WS + `Page.navigate` + `Page.loadEventFired` wait (pattern from
  ws/cdp_project's cdp.js/browser.js). Also the documented reason cdp_eval "open link" failed.
- **Terminal dock (pseudo-terminal WITHOUT node-pty)**: the 🖥 header button (or "↗ terminal"
  on a bash tool row) opens a bottom dock running **wterm** — the PREBUILT `@wterm/dom` dist
  vendored into `public/vendor/wterm/` (`node vendor-wterm.mjs` downloads the npm tarballs and
  esbuild-bundles them into one self-contained ESM file with the ~26KB Zig WASM core inlined;
  `build.mjs` fails early if the vendor output is missing). The stylesheet is linked statically.
  CDN URLs (esm.sh/jsdelivr) remain as runtime fallbacks only. The shell lives on the server
  (`terminal-hub.mjs`, WS `/ws/terminal`, JSON frames — replay ring 128KB on attach, output
  coalesced 30ms, idle TTL 15min, max 6 sessions, stdin cap 64KB):
  - tier `pty` (default, auto-provisioned): **msys2 `script.exe`** allocates a REAL msys pty
    and bridges our stdio — bash gets `/dev/ptyN`, so interactive TUIs work: `nano`/`vim` pass
    the isatty check (the old "standard input is not a terminal" is fixed — verified with a
    scripted nano session), pty-native ONLCR/echo/`^C`/job control, and the OSC 133/7 markers
    still pass through raw. The bridge is a 63KB exe downloaded ONCE from repo.msys2.org into
    `data/bin/script/` and links only against Git's own runtime (msys-2.0/intl/iconv, verified
    via ldd) — no node-pty, no native builds, no compiler. The generated rc runs `stty cols/rows`
    so nano/vim get the right layout (script defaults the pty to 80x25).
    (Why not winpty: Git's bundled CLI — and upstream 0.4.3 — ASSERT headless, winpty.cc:924:
    its resize poll reads TIOCGWINSZ on a pipe → 0x0 → `winpty_set_size(0,0)`.)
  - tier `pipes` (fallback, also used until provisioning finishes): `bash --noprofile --rcfile
    data/term-shell.rc -i` over pipes. Readline still runs — it echoes input, renders a colored
    prompt, handles arrow-key history redraws, `^C` (bell + abort) and multi-line continuations,
    all as a plain VT stream (verified on Git Bash 5.3). The generated rc adds OSC 133 A/B/D
    markers + OSC 7 cwd, so the status bar shows live exit codes and the cwd. Two pty duties the
    hub emulates itself: **ONLCR** (bash emits bare `\n` over pipes — translated to `\r\n` or
    the emulator staircase-offsets the cursor after every Enter; `\r\n` and lone `\r` pass
    through) and **default env before launching bash** (profile is skipped by `--noprofile`, so
    the spawn env replicates what `git-bash.exe`'s login shell provides: Git's `usr/bin` +
    `mingw64/bin` + `bin` prepended to PATH, `HOME`, `SHELL`, `MSYSTEM`/`MSYSTEM_PREFIX`/
    `_CARCH`/`_CHOST`, `TERM`, `COLUMNS`/`LINES`). Remaining gaps: no job control, native
    console programs see pipes, fixed grid size. An auto-fallback (pty→pipes) triggers if the
    bridge dies within 4s of spawn.
  - Touch UI: the dock has an **Exit** button (ends the shell via a kill frame —
    safe from any foreground state), a **command-entry bar** that streams every
    character to the shell live (value-diff — bypasses wterm's compose-per-word
    touch overlay, so Tab completes without the space+backspace dance and no IME
    underline pollutes the terminal), a key strip with ↑ ↓ ← → Tab Esc **Paste**
    (hold-to-repeat on ↑/↓), and **click/tap-to-move the shell cursor** (click a
    character on the cursor's row → arrow-key deltas; pty tier, same-row rule).
    The strip/entry are desktop-hidden; a "Keys" head button toggles them.
  - `node term-smoke.mjs`: boots a scratch server and drives /ws/terminal over a raw socket —
    cross-origin rejection, guessable-id rejection, attach → first prompt → echo round-trip →
    ONLCR (no bare `\n` reaches the emulator) → replay → reset → kill (12 checks).
  - Security: `/ws/terminal` inherits the non-loopback token gate AND enforces a strict Origin
    allowlist inside its own size-capped WSS (WS has no CORS — a drive-by page could otherwise
    dial the socket; DNS-rebinding presents a mismatched Origin/Host pair). 2026-10-21: the same
    allowlist now gates `/ws/sync` + `/ws/agent` WS upgrades and EVERY `/api/*` route except
    `/api/health` (Host + Origin must be real, incl. portless-Host and IPv6 normalization) — custom DNS
    names must be added to `PI_WEB_TERM_ORIGIN` (details: docs/server.md). Session ids must be
    unguessable (≥16 chars, not numeric) — the id is the reattach auth for loopback peers.
    The token remains the trust boundary, exactly like `/api/exec/tool`.
- **Workspace file endpoints** (picker/attachments): `GET /api/ws/files?path=` (structured
  listing, dotfiles hidden, dotfile paths 403) and `GET /api/ws/file?path=` (text w/ NUL-sniff
  or image → base64; 8MB cap; ALWAYS token-required like the exec bridge). All paths are
  workspace-relative and contained via the same realpath walk as the exec bridge.

## Using the bash tool

The chat agent has a real `bash` tool (same machine trust as the pi TUI). You don't configure
anything per-conversation — just ask in plain language:

- *"run `ls -la src`"*, *"build the project and show me the errors"*, *"find every TODO in
  `src/` with rg"*, *"what's listening on port 3000?"* — the model writes the command and calls
  the tool itself. Non-English requests work too; the command is always visible before/while it
  runs.

While it runs:

- The **tool row** in the chat shows the command, a `running…` state with **live partial output**
  (throttled to 250ms, first byte flushes immediately), then `✓` / `✗ error`. Click the row to
  expand full args + output. Output tail is capped at the last **2000 lines / 50KB** — if
  truncated, the full output is saved to a temp file whose path is returned.
- **Stop** (or a session switch) kills the whole **process tree** (taskkill) — no orphaned
  builds/dev-servers. An aborted/timeout command returns `isError: true` with the partial
  output attached.
- **Timeout**: optional per-call (`timeout: <seconds>` — the model decides). The bash tool clamps
  per-call timeouts to 600s, but the exec bridge wraps every call in `AbortSignal.timeout(120000)` →
  **effective cap 120s**.
  Non-zero exits are NOT errors — output + `exit <code>` are returned so the model can react
  (spawn failures/timeouts/aborts are `isError: true`).

Environment & resolution:

- **cwd** = the workspace (`PI_WS`, or the parent of `PI_DIR`).
- **Shell**: resolved ONCE at boot from a verified constant — `C:\Git\usr\bin\bash.exe`
  on this machine (portable Git at `C:\Git`; `bin\bash.exe` silently fails to load msys DLLs
  from a bare environment — the original "No bash found" + silent-output bugs). Override with
  `PI_WEB_BASH_SHELL` (must be a `usr\bin\bash.exe`); a missing binary disables the tool with
  a boot log line instead of failing every call.
- **PATH** gets pi's `bin/` prepended — `fd` and `rg` are available.

Requirements & limits:

- On by default; `PI_WEB_BASH=0` disables registration entirely.
- Tool execution **always requires the API token** (even from localhost — drive-by POST
  defense). On LAN devices, set the token once (Settings → Server token; stored as
  `pi.webToken`); a missing token prompts automatically.
- Every invocation is audited (last 50, with outcomes) via `GET /api/debug/state`.
- For scripting outside the browser: `POST /api/exec/tool` with JSON
  `{ "tool": "bash", "args": { "command": "..." } }` and the `x-pi-web-token` header.
- **System prompt**: `.pi/WEB_SYSTEM.md` is the ACTIVE system prompt for the WEB agent — a
  filename pi's TUI/CLI never reads (prompt discovery matches exactly `SYSTEM.md` /
  `APPEND_SYSTEM.md`; research-confirmed via sonnet-5-search), so the web prompt cannot leak
  into the TUI. It is pi-default revised for the web UI (tool set incl. the explicit `edit`
  call shape, web-environment section). `.pi/WEB_SYSTEM.md` and `.pi/APPEND_SYSTEM.md` (user
  addendum, appended after) are editable by the user and the agent via the **file viewer**
  (those + `.pi/SYSTEM.md` are the only dotfile paths the picker allowlists — auth.json etc.
  stay blocked). The old 📄 prompt-viewer button is gone — read the file itself.
  **Model-review workflow** (for the agent): UI-code changes → `claude-sonnet-5-high` via
  arena_chat; server/extension/prompt changes → `grok-4.6-high`; web research →
  `claude-sonnet-5-search` (arena_search tool); manual chat → the arena.ai tab.
- **Diagnostics**: tap the FAB (bottom-right) → Copy Diagnostics → paste for bug reports.
- **`?reset-storage`**: wipes localStorage + IDB for a clean slate. (The previously listed
  `?nosync=1` / `?noproxy=1` were never implemented in the client — removed 2026-10-21; see
  `docs/client.md`.)
- **Cross-device session status** (fable5 design): the hub broadcasts per-session runtime
  (running/idle/error · turn · current tool · a ≤120-char live progress preview · queued prompts ·
  attached-client count) as tiny `{type:"runtime"}` frames on /ws/sync + embedded in `/api/sessions`.
  EVERY emission advances the shared hub seq (2026-10-21 commit review P2 — runtime-only deltas
  previously reused the last agent-event seq and were dropped by the client's stale-frame guard),
  and attach/detach deltas go through `agentHub.emitRuntime` for the same reason. Devices: the
  header **activity button** (heartbeat icon, count badge of alive sessions excluding the current
  one, red when any error) opens the **AliveSessionsDialog** — live rows (status dot, title fallback
  metadata → lastText → `Session <id8>`, turn/tool/queued/devices/elapsed), click-to-navigate (the
  current session just closes), and a two-stage **Kill** button (Kill → "Confirm?" 3s →
  `POST /api/agent/abort` → "stopping…" until the runtime flips; silent no-op aborts; error rows
  have no kill; rows that finish while open linger 2s as "✓ done"; footer shows live/paused sync
  state via `sessionSync.syncHealthy()`). Running sessions also pin in the full session list with a
  live preview line, and a "Resume" banner appears after reopening the app. No polling, no event
  deltas to detached devices, runtime is memory-only (restart ⇒ all idle).
- **Steering (2026-10-22)**: a message sent WHILE a run is in progress no longer blocks (the old editor rejected it) and no longer waits for the run to END (the old hub queued it via `followUp()`, whose in-lock `isStreaming` check was effectively dead — the promptLock serializes whole runs, so the queued path only fired for simultaneous sends). Flow: the editor's guard lifts for server-side agents (⏩ Steer button / Enter), the hub's `prompt()` checks `isStreaming` BEFORE the promptLock and holds the message via `agent.steer()` — pi-agent-core injects it at the next turn boundary (after the current thinking/toolcall completes, before the next assistant response). The pending message shows as an amber chip on EVERY attached device (`{type:"steering"}` frames + `pendingPrompt` in the state snapshot) with ✎ edit (cancel + prefill the composer, images re-attach) and ✕ cancel (`steering-cancel` → `agent.clearSteeringQueue()`). Depth 1; an unconsumed pending message survives an abort/error and is injected at the next run's start (pi semantics). Test: `npm run test:steer` (real server + LLM, 8 checks).
- **Server-side agents** (`src/proxy-agent.ts`, `/ws/agent`): now the **DEFAULT chat path** — tools
  (read/write/edit/bash + pi extensions) run in-process, keys stay in `.pi/auth.json`, every event is
  broadcast to all attached devices, and runs survive browser closes. `?local=1` restores the old
  in-browser loop.
- **Server logging** (2026-10-21): every `console.log/warn/error` is TEE'D to
  `<data>/logs/server-YYYYMMDD.log` (daily file, ISO timestamp + level per line, boot marker with
  pid/port/build). `PI_WEB_LOG_DIR` overrides the directory; a broken dir falls back to console-only.
- **Graceful shutdown** (2026-10-21): SIGINT/SIGTERM/SIGBREAK run a deliberate, LOGGED sequence —
  stop the HTTP listener + destroy connections, `terminalHub.closeAll()` (kill-tree every live bash
  — no orphans), `agentHub.shutdown()` (abort live runs + flush all sessions), drain the worker
  store, terminate the worker, `[shutdown] complete — bye`. A second signal force-exits.
