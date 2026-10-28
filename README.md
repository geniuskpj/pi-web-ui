# pi web

A browser UI for LLM chat built on `@earendil-works/pi-agent-core` + `@earendil-works/pi-ai`
with a **self-contained Preact UI** (`src/ui/`), bundled by **esbuild** (no Vite, no
pi-web-ui, no lit), served by a **Hono** server.

The server supports Windows and Linux. Windows retains the Git Bash `script.exe`
terminal bridge; Linux runs Bash through the system util-linux `script` command
for a real PTY when available, with a pipe-based Bash fallback. No native Node
terminal package is required. Bash execution and process-tree shutdown are
platform-aware.

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
- **Provider/model config** is built on the server (`/api/pi/config` → `lib/pi-catalog.mjs`) from the
  pi-ai builtin catalog + pi's `models-store.json` **+ your own `.pi/models.json`** (user-added
  compatible endpoints) + `auth.json`, and is cached client-side in localStorage (synchronous boot).
  An OpenAI-compatible endpoint needs **no API key**: declare it in `models.json` without `apiKey` (or
  `"apiKey": "none"`) and it runs — `Authorization: Bearer none` on the wire, which such servers ignore.
- **API keys** from `.pi/auth.json` and keys entered in Settings stay server-side; Settings keys are
  stored in the private `data/provider-keys.json` file so the server-side agent can use them.
  Import existing pi keys via the 🗄️ button or Settings.

## Documentation (docs/)

Function-level docs describing the actual implementation — written as the review substrate for
model-based code review (they cite exact function names and invariants, so reviewers can verify
claims without the raw source). Start with `architecture.md` — index + reading order:
[`docs/README.md`](docs/README.md).

| Doc | Covers |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | Big picture: module map (every file → responsibility), server + client boot sequences, the 5 core data flows (chat turn, persistence, session restore, bash exec, terminal), trust boundaries/auth model, env vars, known quirks |
| [`docs/server.md`](docs/server.md) | `server.mjs` + `agent-hub.mjs` + `session-worker.mjs`: token auth, every REST endpoint, system-prompt/trust resolution, pi extension loader (shim + staging), the builtin tools' algorithms (`assertInsideRoots` realpath walk, the edit tool's 4-form match pipeline + line-fuzzy pass, bash spawn/spill/kill-tree), exec bridge (NDJSON streaming, audit), LLM proxy (stall watchdog), static serving, JSONL worker store, `/ws/sync` + `/ws/agent` hubs |
| [`docs/terminal.md`](docs/terminal.md) | `terminal-hub.mjs` + `src/ui/terminal.tsx`: Windows pty tier (auto-provisioned msys2 `script.exe`, sha256-pinned download), Linux util-linux `script` PTY with pipes fallback, generated shell rc (OSC 133/7, adaptive PS1, stty), JSON frame protocol, session lifecycle, Origin allowlist, and the client |
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
| Settings dialog | `src/ui/settings.tsx` | model, thinking level, turns visible, keys (import/add/replace), proxy, token, quota |
| Model selector | `src/ui/model-selector.tsx` | the merged catalog: builtin catalog + `models-store.json` + `.pi/models.json` (marked `· custom`) + `auth.json` providers; re-fetched on every open |
| Settings → Import from pi config | `src/ui/settings.tsx` | providers/defaults/key re-import (moved from the header 💾 button) |
| **Workspace file explorer** | `src/ui/file-picker.tsx` | two-pane: file list (mtime-sorted, checkboxes for multi-select) + live preview (line numbers + syntax highlighting via hljs; images; prose); opens at `ws/` by default, remembers last dir |
| **Terminal dock** | `src/ui/terminal.tsx` + `terminal-hub.mjs` | wterm in a bottom dock; Windows uses msys2 `script.exe`, Linux uses system `script` to run Bash in a PTY (pipes fallback); ring-buffer replay, live exit codes via OSC 133, drag-resize; bash tool rows get "↗ terminal" |
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
| — | `3` | (*UI setting, not an env var*) turns a large session shows: Settings → Turns visible · `localStorage pi.turnWindow` |
| `PI_WEB_TERM_BRIDGE` | auto | `conhost` forces Windows ConPTY; `0`/`pipes` forces the pipe tier; a path uses that exe as an msys-pty-bridge; unset → auto-provision msys2 `util-linux` `script.exe` into `data/bin/script/` (sha256-pinned `util-linux-2.40.2-2` package from repo.msys2.org, 8MB size cap, extracts a 63KB exe — once). The bridge is then **proven by running it** with the shell it will drive (that shell must get `isatty(stdin)==true`); a bridge that cannot allocate a pty is refused, and the reason appears in the dock instead of a silent downgrade |
| `PI_WEB_TERM_ORIGIN` | auto | extra `host[:port]` **names for the global Host/Origin allowlist** — every `/api/*` route and all three WS endpoints (`/ws/sync`, `/ws/agent`, `/ws/terminal`), not just the terminal. Comma-separated, scheme stripped. Matching is EXACT on `host:port`: a missing Origin port means the scheme default (http→80, https→443) and a portless Host is tried as the app port plus 80/443 — so a TLS reverse proxy needs its public form spelled out (`PI_WEB_TERM_ORIGIN=name:443`). Localhost, `os.hostname()` and every interface IP are always allowed |
| `PI_WEB_ORIGIN_GATE` | `auto` | how strictly the DNS-rebinding Host/Origin allowlist applies: `auto` = **loopback peers only** (a remote peer must present the API token — that is what lets the UI work on any domain/DDNS name with no config), `strict` = every peer (pre-2026-10-23 behaviour, only allowlisted names pass), `off` = no host check at all (**foot-gun**, warns at boot: a rebinding page can read `/api/sessions` with no token) |
| `PROXY_IDLE_MS` | `150000` | LLM proxy stall timeout |

Full table with all defaults: [`docs/architecture.md`](docs/architecture.md).

### Data use (Settings → Data use) — how much leaves the device

- **Bundle**: ~1.0MB (0.20MB brotli). node_modules ~75MB. Only deps: preact,
  pi-agent-core, pi-ai, marked, dompurify, highlight.js (lib/common), diff + server-side
  hono/ws/undici. Provider SDKs stubbed to `stubs/empty` (openai-compatible only) — via
  `overrides` in package.json **and** an esbuild `alias` in build.mjs: npm 9/10 silently
  ignore `overrides` with `file:` specifiers, so the bundle must not depend on how npm
  resolved them (otherwise the build pulls in the real SDKs and their missing transitive
  deps, e.g. `@opentelemetry/api`, and fails — that is what broke CI on node 18/20/22).
- **Node ≥ 22** (`engines` in package.json; 18/20 are EOL — 18 never worked, `npm run
  build` fails there because npm 9 drops the file: overrides). CI: `.github/workflows/ci.yml`
  runs node 22 + 24 on Ubuntu and Windows; `npm ci` → `typecheck` → `build` → hermetic suites.
  The real-LLM suites (`test:agent`, `test:steer`, `test:killstop`) stay opt-in.
  Publishing a GitHub Release builds the app and attaches `pi-web-ui.tar.gz` with the built
  public assets, server runtime, and installed `node_modules`; extract it and run `npm start`.
  Runtime data and credentials are not included.
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
- **Edit-with-versions (2026-10-23, user design — REPLACES the fork/rewrite button pair)**: hover a user message → **✎ edit** (the only action; ⑂ fork button deleted). The bubble becomes an INLINE EDITOR (llama.cpp-webui parity — textarea in the bubble, NOT composer prefill; Enter=newline, Ctrl/Cmd+Enter or **Resubmit** button submits, Esc/cancel reverts; focus returns to ✎ on cancel, to the composer on save). The click is PURELY LOCAL — no server call, no version, no refresh. Only saving a DIFFERENT text commits: the server parks the old tail (prompt + responses) as a **VERSION delta** in `data/sessions/<id>.versions.jsonl` — `{vid (monotonic), turn (cut index), firstId, count, reason, messages[]}` — truncates the active mirror to the prefix, and re-prompts through the normal path (`editCommit`; identical text = no-op, NO version — versions exist only when a different message is saved). While editing, later messages DIM + a dashed divider ("messages below will be replaced"). **🕘 versions picker** (stats bar) lists deltas meta-only with a first-text preview and a lossless **switch to** (the CURRENT tail is captured first as a `switch-away` delta). Restores are hub-side (bypass the client-put guards) + broadcastState resyncs all devices; deletes remove the sidecar too. Deepwiki research: pi's append-only tree (id/parentId + leaf) REJECTED as over-engineered per the user's simpler delta design; llama.cpp-webui's sibling-branching is the UX analogue. `forkSession` survives server-side only (no UI button; pi /clone utility). Tests: `npm run test:versions` (24) + `npm run test:fork` (23).
- **Error retry (2026-10-23, user request)**: a failed run is retried **at the failure point**, not by re-sending the prompt. The old Retry button took the last user text and called `prompt()` — which appended a SECOND user message, and for a server-side session it mutated a transcript the server never sees. Now `hub.retry(id)` drops the trailing failure artifacts (assistant `stopReason: "error"`/`"aborted"` + toolResults orphaned by them, repairing a half-finished tool call) and calls **`agent.continue()`**: pi re-issues the failed model call against the SAME transcript, so the user turn appears exactly once and tool calls that already completed are **not** re-run. A fallback (tail is an assistant message) re-sends the user turn, dropping it first so it is never duplicated. Retry refuses when nothing failed (`{ok:false, reason:"nothing to retry…"}`) — it can never regenerate a healthy turn. WS `{type:"retry"}` → ack `{type:"retried"}` (the run streams as normal agent events); `{type:"set-auto-retry", enabled, attempts, delayMs}` → `{type:"auto-retry", …}`. Client: the Retry button on an error message calls it; the local `?local=1` loop mirrors the semantics in-browser (`agent.continue()` too).
- **Auto-retry (2026-10-23)**: setting **Settings → Retry → "Auto-retry on rate limit / network errors — 3 attempts, 3 s apart"** (default ON, `localStorage pi.autoRetry`, pushed to the hub on every (re)attach). Only transient failures are retried: **429 / rate-limit / quota / overloaded / 5xx / network** (ECONNRESET, ETIMEDOUT, "fetch failed", "socket hang up", …). **Not** retried: 401/403/invalid key (burning quota on a bad key is pointless) or context-overflow. The attempt counter resets on success and on every user action (prompt/steer/abort/edit/retry), so it only ever chains consecutive failures of the SAME turn; when the budget is spent the runtime preview says *"auto-retry gave up after N attempt(s) — press Retry to try again"*.
- **Versions survive a failed resubmit (2026-10-23)**: an ✎ edit parks its delta and truncates BEFORE the resubmit runs, so a 429 used to leave a parked version plus a dead turn. Now the version **stays parked** and the retry (manual or automatic) continues the edited turn as if the error had not happened — nothing is dropped from the 🕘 picker by a failure, and nothing is double-parked. Test: `npm run test:retry` (26 checks, hermetic — pi-ai's **faux provider** scripts `stopReason:"error"` responses, so no network/keys: resume-at-failure-point, no duplicated user turn, no re-run tool calls, auto-retry success + give-up, non-retryable classification, edit-version survival, refuse-when-healthy).

- **Compact (2026-10-22, pi /compact parity)**: ⤓ compact button in the stats bar (server-side mode, idle, >6 messages). Algorithm mirrors pi's compaction.md: cut point by backwards token-estimate walk (chars/4) to keepRecentTokens (default 20k), cut advanced past toolResults (never splits call/result), span starts AFTER any previous compaction summary (iterative folding), serialization `[User]/[Assistant]/[Assistant tool calls]/[Tool result (name)]` with thinking OMITTED and tool results truncated at 2000 chars, structured checkpoint summary (Goal/Constraints/Progress/Key Decisions/Next Steps/Critical Context) via a throwaway Agent on the session model (thinkingLevel off). Replacement = [flagged summary message, ...kept]; the summary renders as a COLLAPSIBLE context block (⤓ collapsed by default — click to view), carries NO usage (totals drop to the kept tail). Divergence from pi: our linear mirror is REWRITTEN, so a pre-compact backup lands in `data/tmp/precompact/<id>-<ts>.jsonl.gz` (GZIP, 31-day prune). Guards: idle-only, one at a time; prompt/steer/fork/rewrite reject with "compaction in progress". WS: `{type:"compact", id, keepRecentTokens}` → `{type:"compacted", id, …}` (10-min client await; an LLM run on a huge session can take minutes — a `compacting: true` state frame shows an elapsed-time progress banner above the composer on ALL devices, surviving client timeouts). STICKY TITLE: compaction never renames the session (the old logic re-derived the title from the first user message — post-compact that IS the summary → "## Conversation summary (auto-compacted)"); once a real title exists it stays. COMPACTED-MIRROR PUT GUARD: a client push onto a compacted mirror must also start with the summary — stale pre-compact copies are rejected (`put-rejected` + toast). Auto-threshold compaction NOT implemented (manual only, like /compact). Test: `npm run test:compact`.
- **`cdp-open.mjs` (2026-10-22)**: open a URL in the user's debugged browser — `node cdp-open.mjs
  <url>` (plus `--list` / `--close <id>`). **Chrome/Edge only** — the whole CDP tooling (cdp_eval,
  cdp-open, the :9222 target model) targets Chromium browsers; Firefox/Safari are not supported.
  Exists because every naive path fails: `window.open`
  from cdp_eval is popup-blocked, and Edge's `PUT /json/new?url=` creates the tab but NEVER
  navigates it (verified — the tab stays about:blank). The helper uses `Target.createTarget`
  over the browser-level WS + `Page.navigate` + `Page.loadEventFired` wait (pattern from
  ws/cdp_project's cdp.js/browser.js). Also the documented reason cdp_eval "open link" failed.
- **Terminal dock**: the 🖥 header button (or "↗ terminal"
  on a bash tool row) opens a bottom dock running **wterm** — the PREBUILT `@wterm/dom` dist
  vendored into `public/vendor/wterm/` (`node vendor-wterm.mjs` downloads the npm tarballs and
  esbuild-bundles them into one self-contained ESM file with the ~26KB Zig WASM core inlined;
  `build.mjs` fails early if the vendor output is missing). The stylesheet is linked statically.
  CDN URLs (esm.sh/jsdelivr) remain as runtime fallbacks only. The shell lives on the server
  (`terminal-hub.mjs`, WS `/ws/terminal`, JSON frames — replay ring 128KB on attach, output
  coalesced 30ms, idle TTL 15min, max 6 sessions, stdin cap 64KB):
  - Windows tier `pty` (default, auto-provisioned): **msys2 `script.exe`** allocates a REAL msys pty
    and bridges our stdio — bash gets `/dev/ptyN`, so interactive TUIs work: `nano`/`vim` pass
    the isatty check (the old "standard input is not a terminal" is fixed — verified with a
    scripted nano session), pty-native ONLCR/echo/`^C`/job control, and the OSC 133/7 markers
    still pass through raw. The bridge is a 63KB exe downloaded ONCE from repo.msys2.org into
    `data/bin/script/` and links only against Git's own runtime (msys-2.0/intl/iconv, verified
    via ldd). The generated rc runs `stty cols/rows`
    so nano/vim get the right layout (script defaults the pty to 80x25).
    (Why not winpty: Git's bundled CLI — and upstream 0.4.3 — ASSERT headless, winpty.cc:924:
    its resize poll reads TIOCGWINSZ on a pipe → 0x0 → `winpty_set_size(0,0)`.)
  - Linux tier `pty`: system util-linux `script` runs
    `bash --noprofile --rcfile data/term-shell.rc -i` with a real PTY, so TTY-aware programs such
    as nano can run. This uses the installed system utility, not a Node dependency. If `script` is
    unavailable, the terminal falls back to the pipes tier.
  - tier `pipes` (Linux fallback; also used on Windows if bridge provisioning is disabled):
    `bash --noprofile --rcfile data/term-shell.rc -i` over pipes. Readline still runs — it echoes input, renders a colored
    prompt, handles arrow-key history redraws, `^C` (bell + abort) and multi-line continuations,
    all as a plain VT stream (verified on Git Bash 5.3). The generated rc adds OSC 133 A/B/D
    markers + OSC 7 cwd, so the status bar shows live exit codes and the cwd. Two pty duties the
    hub emulates itself: **ONLCR** (bash emits bare `\n` over pipes — translated to `\r\n` or
    the emulator staircase-offsets the cursor after every Enter; `\r\n` and lone `\r` pass
    through) and **default env before launching bash** (profile is skipped by `--noprofile`, so
    the spawn env replicates what `git-bash.exe`'s login shell provides: Git's `usr/bin` +
    `mingw64/bin` + `bin` prepended to PATH, `HOME`, `SHELL`, `MSYSTEM`/`MSYSTEM_PREFIX`/
    `_CARCH`/`_CHOST`, `TERM`, `COLUMNS`/`LINES`). Remaining gaps: no job control, native
    console programs see pipes, fixed grid size. Interactive programs requiring a TTY, such as
    nano, are unsupported in this tier. On Windows, an auto-fallback (pty→pipes) triggers if the
    bridge dies within 4s of spawn.
  - Touch UI: the dock has an **Exit** button (ends the shell via a kill frame —
    safe from any foreground state), a **command-entry bar** that streams every
    character to the shell live (value-diff — bypasses wterm's compose-per-word
    touch overlay, so Tab completes without the space+backspace dance and no IME
    underline pollutes the terminal), a key strip with ↑ ↓ ← → Tab Esc **Paste**
    (hold-to-repeat on ↑/↓), and **click/tap-to-move the shell cursor** (click a
    character on the cursor's row → arrow-key deltas; pty tier, same-row rule).
    The strip/entry are desktop-hidden; a "Keys" head button toggles them.
  - `npm test`: boots a scratch server and drives /ws/terminal over a raw socket —
    cross-origin rejection, guessable-id rejection, attach → first prompt → echo round-trip →
    ONLCR (no bare `\n` reaches the emulator) → replay → reset → kill (12 checks).
  - `npm run test:term-platform` verifies shell discovery and POSIX process-group termination.
    `npm test` checks Bash receives a TTY through Linux `script` when installed; CI runs both
    terminal suites on Windows and Ubuntu.
  - Security: `/ws/terminal` inherits the non-loopback token gate AND enforces a strict Origin
    allowlist inside its own size-capped WSS (WS has no CORS — a drive-by page could otherwise
    dial the socket; DNS-rebinding presents a mismatched Origin/Host pair). 2026-10-21: the same
    allowlist now gates `/ws/sync` + `/ws/agent` WS upgrades and EVERY `/api/*` route except
    `/api/health` (Host + Origin match **exactly** on `host:port`; a missing Origin port is the
    scheme default — http→80, https→443 — a portless Host is tried as the app port plus 80/443,
    IPv6/trailing-dot normalized, malformed Origin fails closed; `Origin: http://localhost:3000`
    from another local app is NOT our origin and is rejected). Since 2026-10-23 the strictness is
    `PI_WEB_ORIGIN_GATE` (default `auto`): the gate applies to **loopback peers only**, because
    loopback is the one trust path that skips the token — a remote peer that presents the token is
    already authenticated and may use ANY hostname (this is what makes a DDNS/domain work with zero
    config; a rebinding page arriving as loopback is still rejected). The token exemption is tied to
    the HOST: a loopback caller is trusted only when it addresses us by a LOCAL name (localhost /
    hostname / interface IP), so a local reverse proxy serving a public name still has to send the
    token, and the gate mode never changes that. Custom names go in `PI_WEB_TERM_ORIGIN` (spell the
    public port for a TLS proxy). Session ids must be unguessable (≥16 chars, not numeric) — the id
    is the reattach auth for loopback peers. The token remains the trust boundary, exactly like
    `/api/exec/tool` (which, with `/api/pi/keys` and the workspace file reads, requires the token
    even from loopback).
  - **Accessing the UI on a custom domain**: open the server on that name and paste the token once
    (Settings → Server token, stored as `pi.webToken`) — with the default `auto` gate nothing else
    is needed. The token is a SETTINGS credential: it is never read from the URL and there are no
    share links — a URL token would hand whoever opens it full control (bash/exec + every session);
    a scoped read-only token is an open item. `?token=` in a query string is accepted **only on WS
    upgrades** (WS cannot set headers), and the upgrade log prints the path without the query string.
    If `/api/sessions` answers 401/403 the UI shows an amber banner with the reason instead of an
    empty list.
- **Workspace file endpoints** (picker/attachments): `GET /api/ws/files?path=` (structured
  listing, dotfiles hidden, dotfile paths 403) and `GET /api/ws/file?path=` (text w/ NUL-sniff
  or image → base64; 8MB cap; ALWAYS token-required like the exec bridge). All paths are
  workspace-relative and contained via the same realpath walk as the exec bridge.
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

- The **tool row** in the chat shows the command, a `running…` state with **live partial output**
  (throttled to 250ms, first byte flushes immediately), then `✓` / `✗ error`. Click the row to
  expand full args + output. Output tail is capped at the last **2000 lines / 50KB** — if
  truncated, the full output is saved to a temp file whose path is returned.
- **Stop** (or a session switch) kills the whole **process tree** (`taskkill` on Windows, POSIX
  process-group SIGTERM followed by SIGKILL) — no orphaned
  builds/dev-servers. An aborted/timeout command returns `isError: true` with the partial
  output attached.
- **Timeout**: optional per-call (`timeout: <seconds>` — the model decides). The bash tool clamps
  per-call timeouts to 600s, but the exec bridge wraps every call in `AbortSignal.timeout(120000)` →
  **effective cap 120s**.
  Non-zero exits are NOT errors — output + `exit <code>` are returned so the model can react
  (spawn failures/timeouts/aborts are `isError: true`).

## System prompt

- **cwd** = the workspace (`PI_WS`, or the parent of `PI_DIR`).
- **Shell**: resolved ONCE at boot — Git Bash at `C:\Git\usr\bin\bash.exe` on Windows and
  `$SHELL` (when Bash) or `/bin/bash` on POSIX. Override with `PI_WEB_BASH_SHELL`; a missing
  binary disables the tool with a boot log line instead of failing every call.
- **PATH** gets pi's `bin/` prepended — `fd` and `rg` are available.
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
- **Display by user turn:** sparse (large) sessions render the last **N conversational turns**
  (N = Settings → Composer → *Turns visible*, `pi.turnWindow`, **default 3**; from the N-th newest
  user message down); “⤒ Load earlier turns” reveals one more turn per click — pure view change
  when it is in memory, a range fetch when it isn't. **Small chats display fully** (a null gate is no
  gate — it never meant “one turn”). The button only appears when something is actually hidden. (Fixed
  2026-10-27: the gate was hardcoded to one turn AND applied to every session, so a one-turn chat showed
  a ⤒ button that hid nothing but its system message.)
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
