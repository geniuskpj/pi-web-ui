# server.mjs — Server internals

> Updated 2026-10-21 · See also: [architecture.md](architecture.md) (module map, trust model) ·
[client.md](client.md) (browser caller) · [terminal.md](terminal.md) (terminal WS security)

Covers `server.mjs`, `agent-hub.mjs`, `session-worker.mjs`, `session-id.mjs`.
See [architecture.md](architecture.md) for the module map and trust-boundary summary.

## Auth (`tokenMatches`, `authorized`, `isLoopback`)

- `AUTH_TOKEN`: env `PI_WEB_TOKEN` → else `data/auth-token.txt` → else generate
  `crypto.randomBytes(24).toString("base64url")` and persist (file mode = platform default — no chmod
  anywhere in server.mjs; the boot log prints only the file PATH, never the token).
- `requestToken()`: header `x-pi-web-token` OR `?token=` query. The query form exists for WebSocket
  (WS cannot set custom headers) but is accepted on plain HTTP too — query tokens leak via reverse-proxy
  logs, Referer and history; only the WS upgrade path actually needs it.
- `tokenMatches()`: length check + `crypto.timingSafeEqual` (timing-safe).
- `authorized()`: loopback OR token. Loopback = remoteAddress `127.0.0.1` / `::1` / `::ffff:127.0.0.1`.
- **Browser-origin gate (2026-10-21, r2 after re-review, DNS-rebinding defense)**: `ALLOWED_HOSTS`
  (localhost, 127.0.0.1, [::1], `os.hostname()`, ALL non-internal interfaces — IPv4 AND bracketed IPv6,
  zone ids stripped, `PI_WEB_TERM_ORIGIN` extras with scheme stripped + bare IPv6 bracket-wrapped — all
  lowercased `host:port`) + `browserOriginAllowed(req)` require the `Host` header AND the `Origin`
  header (when present) to be allowlisted. `headerHostAllowed` NORMALIZES: FQDN trailing dot stripped,
  portless Host (browsers omit :80/:443) gets `:PORT` appended before the lookup. Applied by middleware
  to **every `/api/*` route except `/api/health`** (r2: the original prefix list left
  `/api/agent/session/:id` — which returns message BODIES — un-gated), and at upgrade to `/ws/sync` +
  `/ws/agent` (a missing Origin = non-browser client → token gate only). `TERM_ALLOWED_ORIGINS =
  ALLOWED_HOSTS` (shared with the terminal hub). Rationale: loopback trust is not a browser boundary —
  a rebinding or `*.nip.io` hostname makes an attacker page same-origin over a loopback socket.
- Middleware (first `app.use`): 401 for any `/api/*` except `/api/health` when not authorized; logs
  every `/api/*` request (errors to console.error always, successes only in debug).

## Endpoints (all JSON unless noted)

| Route | Auth | Notes |
|---|---|---|
| `GET /api/health` | none | `{ok, bootId, buildId, piDir}` — buildId parsed from the hashed bundle filename |
| `GET /api/version` | blanket | same ids |
| `GET /api/pi/config` | blanket | re-reads `.pi/models-store.json` + `settings.json` → providers with models, defaults |
| `GET /api/pi/system` | blanket | system-prompt resolution (below) |
| `GET /api/pi/keys` | **always token** (2026-10-21) | **returns ALL provider keys from `.pi/auth.json`** — strongest secrets oracle; no client call path uses it |
| `POST /api/pi/key` | blanket + env-TOKEN check | `{provider}` → that provider's key |
| `GET /api/sessions` | blanket | worker `list` (metadata only), 1s-cached (`listCached`) |
| `POST /api/sessions` | blanket | returns a fresh `crypto.randomUUID()` (creates nothing) |
| `GET /api/exec/tools` | blanket (+env-TOKEN if set) | tool defs minus `execute`; `stream:true` for bash |
| `POST /api/exec/tool` | **always token** | exec bridge (below) |
| `GET /api/ws/files?path=` | blanket | directory listing (picker) |
| `GET /api/ws/file?path=` | **always token** | file content: image → base64, text → NUL-sniff, 8MB cap |
| `GET /api/debug/state` | blanket + same-origin Origin check | boot/build ids, counters, `execAudit` tail (20) |
| `ANY /api/proxy` + `/api/proxy/*` | blanket | LLM CORS proxy (below) |
| `GET /` | none | injected index.html (manifest-fitted hashed asset names, no-cache) |
| `GET *` | none | static catch-all (below) |
| `WS /ws/sync`, `WS /ws/agent` | token for non-loopback at upgrade | hubs below |
| `WS /ws/terminal` | token for non-loopback + hub Origin allowlist | see [terminal.md](terminal.md) |
| `POST /api/agent/*`, `GET /api/agent/session/:id`, `GET /api/agent/events` (SSE) | blanket | server-side agent path |

## System-prompt resolution (`/api/pi/system`)

Mirrors pi's resource loader: `projectNeedsTrust()` (`.pi` symlink or any of settings.json/mcp.json/
extensions/skills/prompts/themes/SYSTEM.md/APPEND_SYSTEM.md present) gates project files;
`isProjectTrusted()` walks UP from the project dir through `.pi/trust.json` entries (fail-closed on
unreadable). Precedence: `WEB_SYSTEM.md` (agent dir; web-UI-only filename, no trust gate) > project
`.pi/SYSTEM.md` (trusted) > global `agentDir/SYSTEM.md`; `APPEND_SYSTEM.md` appends. The server
computes `wins` flags so the client cannot drift. Content cap 1MB/file. `projectDir` = `PI_WS` or the
parent of `PI_DIR` (assumes `.pi` is a direct child of the workspace root — worktrees need `PI_WS`).

## Extension loader (`loadPiExtensions`)

Stages `AGENT_DIR/extensions/*.{ts,js}` into `data/ext-loader/extensions/` with a generated
`node_modules/@earendil-works/pi-coding-agent` shim (package.json + `index.mjs` exporting
`defineTool = t => t`), then dynamic-imports each. `mod.default(pi)` receives a Proxy: real props
(`registerTool` collects into `extensionTools` with `_from`, `cwd`, `agentDir`); any other `pi.*` access
returns a loud no-op function (`console.warn` per call, never silent). Failures are collected in
`extensionErrors` (surfaced by `/api/exec/tools`). `loadPiExtensions()` is fired async during boot —
an early `/api/exec/tools` call can race it and list no extension tools. Extension code is trusted by
definition — same as the pi TUI loading it; the token is the trust boundary.

## Builtin tools (`builtinTools`)

Common helpers:

- `normalizePathArg()`: strips wrapping quotes/backticks (incl. curly), expands `~`, rewrites Git Bash
  `/c/...` → `C:/...`, collapses over-escaped backslashes.
- `assertInsideRoots(p, {mustExist})`: normalize → resolve (relative anchors to WORKSPACE_DIR) → walk
  UP to the nearest **existing** ancestor, `realpathSync` it, require `rp === root || startsWith(root +
  sep)` for any root in {WORKSPACE_DIR, AGENT_DIR} realpathed → returns the resolved path. Symlinks and
  `..` escapes fail closed. (TOCTOU window exists between check and use; files are small.)
- `withFileMutationQueue(filePath, fn)`: per-file (realpath key) FIFO promise chain; a global
  `mutationRegistration` chain serializes queue registration. Different files run in parallel.
- `truncateTail(text, maxLines, maxBytes)`: keeps the LAST N lines within N bytes; on truncation spills
  the FULL text to `os.tmpdir()/pi-web-bash-*.log` and returns a note with the path.

**read_file**: 2MB cap, 1-based `offset`, `limit` clamped 1..2000 (default 400), `N| ` line prefixes,
"(more lines; use offset)" hint.

**write_file**: 2MB content cap, `createDirs` opt-in mkdir -p, ENOENT → actionable retry hint; runs
inside the mutation queue.

**edit** (port of pi's edit + hardening):
1. Argument repair (**hardened 2026-10-21 — recovers the maintainer's own live failures**): accepts
   `edits` as a JSON string (single- AND double-encoded `{"edits":...}` wrappers), a single object, or
   the legacy flat `{oldText,newText}` on params; `edits[i]` may be a JSON string (parsed) or a bare
   old-text string (treated as a deletion); numeric/boolean entries coerced; `path` recovered from
   top-level `file|file_path|filePath` aliases, an object `{path}`, or `edits[].path` (rejects entries
   carrying DIFFERENT paths); strips stray keys; alias normalization `old_string/new_string` etc.
   Every recovery is reported as `Repaired malformed call:` notes in the result; empty/missing
   `oldText` fails EARLY with actionable guidance (prepend pattern / use write_file).
2. `assertInsideRoots(mustExist)` + 10MB cap; read → BOM strip → CRLF detect → normalize to LF.
3. Candidate match FORMS (each must still be unique + non-overlapping): as-is → line-number-prefixes
   stripped (`N| ` / `N: `) → backslashes collapsed → both. Fuzzy match normalizes NFKC, trailing
   whitespace, curly quotes/dashes/nbsp; when fuzzy matched, unchanged lines are preserved verbatim from
   the original (`applyReplacementsPreservingUnchangedLines` groups replacements by line ranges).
4. LINE-FUZZY fallback: per-line trimmed comparison, sliding window, exactly ONE hit required per edit
   (ambiguous → reject with the line list), overlap check, bottom-up splice with **indent rebase**
   (file's base indent wins; relative delta of the model's newText preserved; tabs ≈ 4 spaces).
5. Failure error includes all attempt messages, whitespace-visualized first oldText line, and a
   read_file-formatted excerpt near a possible anchor.
6. Write-back restores BOM + original CRLF; `details` carries jsdiff context diff, unified patch,
   `firstChangedLine`, `matchForm`. No-op (identical content) is an error.

**bash**: spawn `BASH_PATH -c <cmd>` (verified constant path; `PI_WEB_BASH_SHELL` override), cwd =
WORKSPACE_DIR, env = `getShellEnv()` (prepends PI bin dir, bash's dir — msys DLL resolution — and the
running node's dir to PATH). Two sinks per stream: RAW-BYTE spill file (≤256MB, best-effort) and a
StringDecoder ring tail (last 256KB, decoder carries multibyte across chunks). `pushPartial()` throttles
`onUpdate` snapshots to 250 ms (first byte forced; harder 100-line/16KB cap). `waitForChildProcess()`
(port of pi's): resolves on exit only after stdout/stderr end OR fall 100ms-idle (re-armed per chunk)
— a detached descendant can't hang or lose its tail; single finalize guard. Abort/timeout (per-call
`timeout` seconds, server clamp 600s) → `killProcessTree` via System32 `taskkill /F /T /PID` (PATH-
independent, detached, errors consumed). Output sanitized of C0/UTF-8-ambiguous control chars.
Non-zero exits are NOT errors (`exit <code>` + details.exitCode); spawn-fail/timeout/abort →
`isError:true` with partial output. Spill deleted when the inline tail is complete.

No `ls` builtin — bash covers listing (mirrors pi's default tool set; an unadvertised-but-registered
tool gets used without steering is the stated rationale).

**forkSession/rewriteSession** (2026-10-22, message fork/rewrite): `forkSession(id, keepCount)` clones messages[0..keepCount) into a NEW session (new uuid, `forkedFrom` lineage in the mirror header, immediate persist, self-hydrates cold sessions via the `loadMessages` store accessor) — the original is untouched; `rewriteSession(id, keepCount)` truncates in place (idle only, drops queued steering, forced persist, `broadcastState()` so every attached device resyncs via a full state frame). The client UsageBar is message-derived: forks inherit copied usage, rewrites drop removed usage — no counter migration needed. Mirror metadata now carries `version:1` + optional `forkedFrom` (pi's own session format is a v3 id/parentId TREE — session-format.md — which the linear mirror intentionally does not adopt; the UI preserves abandoned paths by forking before editing non-tail messages). WS: `{type:"fork"|"rewrite", id, keepCount}` → `{type:"forked"|"rewritten", id, …}`.

**compactSession** (2026-10-22, pi /compact parity): cut point = backwards chars/4 estimate walk to keepRecentTokens (default 20000), advanced past toolResults (call/result integrity); span starts after any previous `isCompactionSummary` message (iterative folding); `serializeConversation()` (thinking omitted, tool results ≤2000 chars + marker); summary via the injected `summarize` dep (server.mjs: throwaway Agent on the session model, thinkingLevel off, structured Goal/…/Critical Context prompt) — the summary message is a user-role message flagged `isCompactionSummary` and carries no usage (UsageBar totals drop to the kept tail). Pre-compact mirror backup via `backupMirror` → `data/tmp/precompact/. Guards: idle-only, `entry.compacting` rejects prompt/steer/fork/rewrite. `mutateEpoch` bumped (queued prompts dropped). WS `{type:"compact"}` → `{type:"compacted"}`.

**fetch**: server-side GET for web pages (2026-10-22). Same SSRF machinery as the LLM proxy:
`proxyTargetBlocked(hostname)` depth-1, `llmAgent` dispatcher (its `connect.lookup = proxyLookup`
validates EVERY resolved address, depth-2), and a manual redirect loop (≤5 hops) that re-checks
protocol + hostname per hop (redirect:"follow" would hop unvalidated). Body read capped 3MB
(streamed `for await` + cancel — hostile huge bodies never balloon memory). HTML (by content-type
or `<` sniff) → `stripBoilerplate()` from the vendored `lib/hp2.mjs` (ws/boilerplate-htmlparser2
prototype: per-domain content selectors, token-matched chrome dropping — 'SharedPageLayout' never
matches a 'share' hint — code-fence protection); JSON/text verbatim; `raw:true` skips conversion;
empty strip falls back to the raw body. Inline output = first 50KB (HEAD, not bash's TAIL — web
content reads from the top); anything larger (or a 3MB-truncated body) SPILLS to
`data/tmp/fetch/<slug>-<ts>.md` (slug = hostname+path; 7-day prune on spill) and the result text
returns the path so `rg`/`read_file` can extract sections. Non-2xx statuses are content (model
reacts), not errors; invalid URL/protocol/blocked/timeout/abort → `isError:true`. Timeout default
20s, clamp 60s, wired to the tool `signal`. Test: `tests/fetch-tool.test.mjs` (SSRF blocks
deterministic; the positive path is network-dependent, like the security suite's public checks).

## Exec bridge (`POST /api/exec/tool`)

Always `tokenMatches` (even loopback — drive-by POST defense). Params coerced (JSON string → object;
null/array → `{value}`). `PI_WEB_TOOLS` allowlist. Audit entry `{at, tool, params(≤300ch), outcome}`
kept last 50, amended after execution, exposed via `/api/debug/state`.

- **Streaming path** (`body.stream && name === "bash"`): NDJSON `ReadableStream`; heartbeat `ping`
  every 15s; `onUpdate` → `{type:"partial", partialResult}`; final `{type:"result"}`; abort signal =
  `AbortSignal.any([AbortSignal.timeout(120000), client-disconnect signal])` — client disconnect kills
  the process tree. The 120s hard cap applies to the non-streaming path too (`AbortSignal.timeout(120000)`),
  which bounds bash BELOW its own 600s per-call clamp — the EFFECTIVE web cap via this bridge is 120s
  (README's "web cap 600s" does not survive this wrapper). No explicit body limit on this route.
- **Plain path**: `tool.execute(uuid, params, AbortSignal.timeout(120000))`; thrown errors return HTTP
  200 with `{isError:true}` so the model's retry framing sees tool output (a bare success would read as
  "edit worked").

## Workspace file endpoints (picker)

- `GET /api/ws/files`: `assertInsideRoots(mustExist)` → `hasDotSegment()` 403 (dotfile *segments*
  rejected; the allowlist `isPromptViewPath()` permits `.pi` itself for listing and the three prompt
  files) → `readdirSync(withFileTypes)`, dot-entries filtered (except allowlisted inside `.pi`), per-entry
  stat (size/mtime), dirs-first name-sort. Paths returned workspace-relative `/`-separated; errors have
  absolute paths stripped (`stripWs` → `~`).
- `GET /api/ws/file`: **token always required** (file content is a secrets oracle for anything not
  dot-prefixed). 8MB cap; `IMAGE_MIME` extension map → base64; text via 8KB NUL-sniff; binary → 400.

## LLM proxy (`/api/proxy`)

`buildTarget()`: `?url=` (optionally + path suffix after the mount), decoded once. Protocol allowlist
http/https. **SSRF guard (`proxyTargetBlocked` + `dottedFromInet`)**: rejects hostnames that are/become
private, loopback, link-local (incl. cloud metadata 169.254.169.254), CGNAT, benchmark 198.18/15,
multicast/reserved, `localhost`/`*.local`/`*.internal` — including **inet_aton forms** (`127.1`,
`2130706433`, `0177.0.0.1`, `0x7f.1`), **IPv4-mapped IPv6** in all spellings (`::ffff:127.0.0.1`,
`0:0:0:0:0:ffff:127.0.0.1`, `::ffff:7f00:1`), expanded IPv6 loopback/unspecified, and FQDN trailing
dots — applied to the initial target AND every redirect hop. **Depth-2 — resolved-address
validation (2026-10-21 commit review P2)**: `proxyLookup()` (the custom `dns.lookup` wired into the
agent via `connect.lookup`) resolves with `all:true`, classifies EVERY resolved address through
`ipAddressBlocked()` (loopback, RFC1918, CGNAT, link-local/metadata, ULA fc00::/7, fe80::/10,
multicast, unspecified/0.0.0.0/8, IPv4-mapped/compatible, 6to4-embedded v4; unparseable → fail
closed), rejects the connect when NOTHING allowed remains (error surfaces through the fetch's
`cause` — `handleProxy` unwraps `err.cause.message` so the block reason is visible instead of a
bare "fetch failed"), and PINS the allowed address(es) for the socket — `net.connect` uses exactly
what the lookup returned (no second, unvalidated lookup); TLS SNI/cert still verify against the
original hostname (the URL is never rewritten). A DNS name resolving to 127.0.0.1 (localtest.me,
*.nip.io) is therefore rejected at connect; every redirect hop re-enters the same lookup.
`ipAddressBlocked` is deliberately separate from `proxyTargetBlocked` — that function blocks
IP-literal HOSTNAMES by design and would reject every resolved address. Accepted residual: NAT
hairpin/DNAT (a public IP DNAT-ing to an internal host); env HTTP(S)_PROXY is irrelevant (per-request
dispatcher, undici does not honor env proxies by default). Origin check: `origin ===
new URL(c.req.url).origin` (Host-derived — kept as depth; the middleware browser-origin gate is the
primary boundary now).
`linkAborts()`: client `req.raw.signal` + incoming `aborted` + outgoing premature `close` → one
AbortController. `passRequestHeaders()` drops hop-by-hop + `cookie` + `x-pi-web-token` + others, forces
`accept-encoding: identity`. Body buffered via `c.req.arrayBuffer()` (≤25MB per `MAX_INBOUND`).
`undiciFetch` with a pinned `UndiciAgent` (16 connections, pipelining 1, keepAlive 30s, connect
timeout 30s, **headersTimeout/bodyTimeout 0** so SSE can stream forever). **Redirects are followed
MANUALLY** (max 5 hops): each hop re-applies the protocol allowlist + `proxyTargetBlocked`, and a
**cross-host hop strips `Authorization`** from the forwarded headers (spec-fetch behavior; the proxy
otherwise forwards caller auth to the first hop BY DESIGN — that is how provider keys reach the
upstream). 303 (and 301/302 on POST) downgrade to GET without a body.
`pinAndPipe()`: manual `ReadableStream` pulling `upstream.body`; **stall watchdog** every 5s — no bytes
for `PROXY_IDLE_MS` (150s) → `reader.cancel` + `controller.error("upstream stalled")`; abort → cancel +
close. `passResponseHeaders()` drops `set-cookie` etc., forces `no-cache, no-transform` +
`x-accel-buffering: no`. No `Access-Control-Allow-Origin` is added (same-origin use only).

## Static serving

`getIndexHtml()`: injects manifest-hashed `/assets/app-*.js|.css` into index.html, cached by
manifest mtime. Catch-all `app.get("*")` (registered AFTER all /api routes): decodes the path,
rejects `api` prefixes, resolves under PUBLIC (prefix containment, not realpath), ETag
`W/"size-mtime"` with 304 support, `Cache-Control: no-cache`, serves precompressed `.br`/`.gz` for
>2KB files when the client accepts. Quirk: a `body2()` helper is defined and called but its return
value ignored, then identical logic repeated (double reads) — dead code.

## Session worker store (`session-worker.mjs`)

JSONL: line 1 = metadata, remaining lines = messages. Worker holds an in-memory `cache` (id →
{metadata, messages}); first `list/get/put` triggers `loadFromDisk()` (reads all `*.jsonl|*.json` in
`sessionsDir`, skips corrupt). `putOne` is **serialized per id** through a promise chain and writes a
**unique** `.tmp` (timestamp+rand) before rename — the parentPort handler is async, and with the hub
persisting every turn while browsers push `/ws/sync` puts, two overlapping puts for the same id used
to race on the shared `.jsonl.tmp` path (rename → ENOENT, breaking sync — fixed 2026-10-21). Failed
writes clean their tmp; boot deletes stale `.tmp` leftovers; `delOne` drops the chain. Corrupt files
are skipped on load. `SESSION_ID_RE = /^[A-Za-z0-9_-]{1,80}$/` gates ids on both threads. Main thread
wraps ops in `storeOp()` (promise map keyed by a monotonically increasing id; worker replies
resolve/reject).

## `/ws/sync` hub (`syncConn`)

Client set with per-client `watch` set; 20s ping/pong liveness sweep (`terminate` + drop on missed
pong). Inbound (`MAX_INBOUND` size guard): `list` (1s cache), `put` (id regex; accepts native `{jsonl}`
or the browser's legacy `{data:{messages...}, metadata}` — converted line-by-line, counted in
`legacySyncPuts` for shim removal), `get` (returns `{jsonl, metadata, data:{messages}}`), `watch`
(add + immediate `pushWatched`), `delete`. After put: `broadcastSessions()` (300ms-coalesced,
invalidates `listCache`) + `pushWatched(id)` to watchers — same body shape as the explicit `get`
branch (`{type:"session", id, data:{messages}, metadata, jsonl}`; before 2026-10-21 `pushWatched`
serialized `data: j.data` which was undefined, so watched updates carried NO body). Backpressure-aware
via `MAX_BUFFERED` 4MB.

## Runtime status frames (fable5, 2026-10-21)

The hub tracks an in-memory runtime per session (status/startedAt/turn/currentTool/lastText/
pendingPrompts); boundaries + assistant message_end fire `onRuntimeChange` → `sendRuntime()` pushes
`{type:"runtime", runtime:{...rt, clients}}` to ALL syncClients IMMEDIATELY (no coalesce/cache — the
client applies it outside its 5s throttle, seq-guarded: stale seq dropped, idle deletes the entry,
MAX-seq idle from discard()). `enrichedSessions()` embeds NON-IDLE runtime (idle = absence) into
`/ws/sync` sessions frames and `GET /api/sessions`. Memory-only: a restart leaves everything idle.

## Server-side agent hub (`agent-hub.mjs`, non-default path)

Agent per session (**the DEFAULT chat path since 2026-10-21**); `getApiKey` reads `.pi/auth.json`
server-side (keys never sent to clients); `persist()` → worker store. **The loop is fully server-side**:
tools = `builtinTools + extensionTools` run IN-PROCESS via `getTools()` (same objects as the exec
bridge), `systemPrompt = effectiveSystemPrompt()` (WEB_SYSTEM.md precedence), default model from pi
`settings.json default_model` via `defaultModelId`. `prompt(sessionId, content, images)` repairs
dangling toolCalls (Anthropic/OpenAI validity) and inlines composer images for queued follow-ups;
`/ws/agent` attach ALWAYS ensures the hub session exists (fresh sessions have no store entry —
`setThinkingLevel` was a crash on `entry.agent` before 2026-10-21). Events: every event seq-stamped +
broadcast to `/ws/agent` clients;
user-message ends persist immediately, others debounced 400ms with a 2s maxWait. **Steering** (2026-10-22):
`prompt()` checks `isStreaming` BEFORE the promptLock (the lock serializes whole runs — the old in-lock
queued path was effectively dead) and holds a mid-run send via `agent.steer()`: pi-agent-core injects
it at the next turn boundary (after the current thinking/toolcall completes). Depth 1
(`followUpCount`); pending state lives on the entry (`pendingPrompt` UI payload + the exact message
object for reference-equality consumption tracking), is part of every state snapshot, and deltas go
to all devices via `emitSteering()` (`{type:"steering"}` frames, buffered during attach like agent
events). `cancelSteering()` clears pi's queue + entry tracking (✎ edit = cancel + client-side
composer prefill; ✕ = cancel). A pending message survives abort/error and injects at the next run's
start (pi's initial steering poll). `_writeSession`
persists FULL message objects (2026-10-22 — the old `{role, content, timestamp}` projection stripped
toolResult.toolCallId, so after a restart the rehydrated history produced `role:"tool"` messages
without `tool_call_id` and nvidia NIM 400'd every prompt, permanently; error/stopReason/usage now
survive restarts too). `getSession` runs restored messages through `normalizeRestoredMessages()` —
re-links orphan toolResults to the preceding assistant's toolCall blocks in order, strips still-
unmatched toolCalls, drops unmatchable orphans (idempotent; one-time bulk repair:
`node tests/repair-mirror-toolcalls.mjs`). `attach()` =
subscribe-first: buffers events via a per-session `entry.buffer` hook while snapshotting (2026-10-21 —
the old global broadcast swap was not reentrant), then delivers snapshot + buffered (dedup by seq).
`prompt()` queues ONE follow-up while streaming (depth 2+ rejected). Eviction: idle >30min (flush
first) or LRU beyond HOT_AGENT_CAP+5 — non-streaming sessions only, so a live run is never evicted.
`flushAll()` exists for bulk flush; the shutdown path uses `shutdown()` (abort live runs + immediate
persist per session) — wired to SIGINT/SIGTERM/SIGBREAK/stdin-close in server.mjs since 2026-10-21.
`onEvents()` backs the SSE endpoint via the per-session subscriber Set (no swapping).

## Logging + graceful shutdown (2026-10-21)

**Tee logger** (top of server.mjs): `console.log/warn/error` are wrapped — the original prints to
stdout AND a line lands in `<data>/logs/server-YYYYMMDD.log` (PI_WEB_LOG_DIR overrides) as
`<ISO ts> [info|warn|error] <formatted args>` (util.inspect depth 4, continuation lines indented).
The fd is opened once and reopened on day rollover; writes are SYNCHRONOUS (low volume — WS/LLM
streams never go through console) so the shutdown sequence is on disk even if exit follows.
`logBootMarker()` appends a `===== pi-web boot <bootId> · pid · node · port · build · dir =====`
banner. The session worker's console is NOT patched (separate thread, negligible output).

**Graceful shutdown** (`shutdown(reason)` at the bottom): SIGINT/SIGTERM/SIGBREAK handlers + the
opt-in `PI_WEB_EXIT_ON_STDIN_CLOSE=1` stdin-end trigger (Windows: cross-process signals cannot run
handlers — TerminateProcess — so the test drives the pipe trigger). Sequence, each step logged:

1. `[shutdown] <reason> received` — stop accepting work: `httpServer.close()` +
   `closeAllConnections()` (keep-alive, SSE and both WS sets die here).
2. `terminalHub.closeAll()` — clears the TTL sweeper, `destroySession()`s every terminal session
   (gen-guard + kill-tree → no orphaned `bash.exe`/`script.exe`), closes the hub WSS; logs the count
   of LIVE shells killed.
3. `agentHub.shutdown()` — aborts every streaming agent (clean `agent_end`/stopReason "aborted"),
   clears preview timers, and immediate-persists EVERY hub session (empty ones are skipped by
   `_writeSession`).
4. drain: wait (≤5s) for `storePending` (in-flight worker-store ops) to hit 0, then
   `sessionWorker.terminate()`.
5. `[shutdown] complete in <ms>ms — bye` → `process.exit(0)`. A second signal force-exits(1).

Tested by `tests/shutdown.test.mjs`: real terminal shell + worker-store put, stdin-close → exit 0,
log file assertions (boot marker, `terminal shells killed: 1`, drained, bye), session JSONL
survived on disk.

## Upgrade routing (`serve().on("upgrade")`)

1. Non-loopback without token → 401 + destroy.
2. **Browser-origin gate for `/ws/sync` + `/ws/agent` (2026-10-21)**: browsers ALWAYS send Origin on WS
   handshakes (WS has no CORS) — a present Origin must be in `ALLOWED_HOSTS` even from loopback
   (rebinding presents an attacker Origin over a loopback socket); a MISSING Origin = non-browser
   client and keeps the token-gate behavior.
3. Path dispatch: `/ws/sync` and `/ws/agent` → shared 25MB-maxPayload WSS; `/ws/terminal` →
   `terminalHub.handleUpgrade()` (its own size-capped WSS + Origin allowlist, missing Origin allowed
   only for loopback); anything else destroyed.
