# Features & implementation notes (moved out of README.md, 2026-10-25)

The README kept a growing set of long-form write-ups (one per feature: what the problem was,
what was measured, what was rejected). They are implementation notes, not an overview, so they
live here verbatim — nothing was rewritten in the move.

## Notes

- **Bundle**: ~1.0MB (0.20MB brotli). node_modules ~75MB. Only deps: preact,
  pi-agent-core, pi-ai, marked, dompurify, highlight.js (lib/common), diff + server-side
  hono/ws/undici. Provider SDKs stubbed to `stubs/empty` (openai-compatible only) — via
  `overrides` in package.json **and** an esbuild `alias` in build.mjs: npm 9/10 silently
  ignore `overrides` with `file:` specifiers, so the bundle must not depend on how npm
  resolved them (otherwise the build pulls in the real SDKs and their missing transitive
  deps, e.g. `@opentelemetry/api`, and fails — that is what broke CI on node 18/20/22).
- **Node ≥ 22** (`engines` in package.json; 18/20 are EOL — 18 never worked, `npm run
  build` fails there because npm 9 drops the file: overrides). CI: `.github/workflows/ci.yml`
  runs node 22 + 24 on ubuntu + windows — `npm ci` → `typecheck` → `build` → the hermetic
  suites (store, runtime, ssrf, retry, security-gates). The real-LLM suites
  (`test:agent`, `test:steer`, `test:killstop`) and the Windows/pty-specific `term-smoke`
  stay opt-in; `compact`/`fork`/`shutdown` need a bash/pty host, so they are local too.
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
  on the removed `cdp-*.mjs` helper scripts) via `POST /api/exec/tool`. The `edit` tool also recovers
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
- **Terminal dock (pseudo-terminal WITHOUT node-pty)**: the 🖥 header button (or "↗ terminal"
  on a bash tool row) opens a bottom dock running **wterm** — the PREBUILT `@wterm/dom` dist
  vendored into `public/vendor/wterm/` (`node vendor-wterm.mjs` downloads the npm tarballs and
  esbuild-bundles them into one self-contained ESM file with the ~26KB Zig WASM core inlined;
  `build.mjs` fails early if the vendor output is missing). The stylesheet is linked statically.
  CDN URLs (esm.sh/jsdelivr) remain as runtime fallbacks only. The shell lives on the server
  (`terminal-hub.mjs`, WS `/ws/terminal`, JSON frames — replay ring 128KB on attach, output
  coalesced 30ms, idle TTL 15min, max 6 sessions, stdin cap 64KB):
  - **which tier is active is PROVED, not assumed**: the bridge must give the shell it drives a
    real tty. When it cannot (e.g. the msys runtime that Git for Windows ships cannot create
    `/dev/ptmx` on that install), the dock says so — "⚠ no pty — nano/vim need one" plus the
    bridge's own error — and runs the pipe tier. `node tests/term-pty.test.mjs` reports the same
    diagnosis headlessly (`PI_REQUIRE_PTY=1` makes a working pty a hard requirement); the fix is a
    repaired/reinstalled Git for Windows, or `PI_WEB_TERM_BRIDGE` pointing at a `script.exe` built
    for that runtime. **When the msys pty route is unavailable the hub falls back to Windows' own
    ConPTY server** (`conhost.exe --headless`: a real console for the shell, forwarded as VT over the
    hub's pipes — no download, no native module). Verified end to end: `isatty(stdin)=true`,
    `stty size` answers, OSC 133/7 still arrive, and **nano renders**. The dock names the bridge in
    use (`bash — pty (conhost)` / `bash — pty (msys)`).
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
- **System prompt**: resolved by `lib/system-prompt.mjs` (one definition for the hub and
  `/api/pi/system`): a prompt FILE when one exists, otherwise a built-in prompt composed in code
  (pi-style `<preamble>/<tools>/<rules>/<cwd>` sections) — see `docs/server.md`.
- **System prompt files**: `.pi/WEB_SYSTEM.md` is the ACTIVE system prompt for the WEB agent — a
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
- **Stranded-session recovery (2026-10-23 mobile incident)**: the ACTIVE session is per-device tab state (URL `?session=` via history.replaceState — never synced across devices), while the session LIST is synced (server metadata merged with local, lastModified-sorted). When a conversation continues under a NEW session id (server-restart reseed / client migration), other devices stay pinned to the dead id — which renders its last aborted/error turn and "never syncs". Detection: when the open transcript's LAST message ended aborted/error, ChatView calls `GET /api/agent/continuation/:id` (same-title + newer + more-messages candidate over the worker's session list) and shows an amber "This session ended — the conversation continues in a newer session [open it]" banner. WS upgrade rejections (401 token / 403 origin) are now LOGGED with path + host for diagnosability.
- **Steering (2026-10-22)**: a message sent WHILE a run is in progress no longer blocks (the old editor rejected it) and no longer waits for the run to END (the old hub queued it via `followUp()`, whose in-lock `isStreaming` check was effectively dead — the promptLock serializes whole runs, so the queued path only fired for simultaneous sends). Flow: the editor's guard lifts for server-side agents (⏩ Steer button / Enter), the hub's `prompt()` checks `isStreaming` BEFORE the promptLock and holds the message via `agent.steer()` — pi-agent-core injects it at the next turn boundary (after the current thinking/toolcall completes, before the next assistant response). The pending message shows as an amber chip on EVERY attached device (`{type:"steering"}` frames + `pendingPrompt` in the state snapshot) with ✎ edit (cancel + prefill the composer, images re-attach) and ✕ cancel (`steering-cancel` → `agent.clearSteeringQueue()`). Depth 1; an unconsumed pending message survives a run ERROR and is injected at the next run's start (pi semantics) — but an explicit STOP clears it (pi steering queue + hub pending payload + the pending chip on every device; 2026-10-23, user report: a surviving steer made a stopped chat keep going). Test: `npm run test:steer` (real server + LLM, 8 checks).
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

