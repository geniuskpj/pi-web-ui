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
- Middleware (first `app.use`): 401 for any `/api/*` except `/api/health` when not authorized; logs
  every `/api/*` request (errors to console.error always, successes only in debug).

## Endpoints (all JSON unless noted)

| Route | Auth | Notes |
|---|---|---|
| `GET /api/health` | none | `{ok, bootId, buildId, piDir}` — buildId parsed from the hashed bundle filename |
| `GET /api/version` | blanket | same ids |
| `GET /api/pi/config` | blanket | re-reads `.pi/models-store.json` + `settings.json` → providers with models, defaults |
| `GET /api/pi/system` | blanket | system-prompt resolution (below) |
| `GET /api/pi/keys` | blanket | **returns ALL provider keys from `.pi/auth.json`** |
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
1. Argument repair: accepts `edits` as JSON string / single object; legacy flat `{oldText,newText}`;
   recovers a missing top-level `path` from `edits[].path|file|file_path|filePath` (rejects entries
   carrying DIFFERENT paths); strips stray keys; alias normalization `old_string/new_string` etc.
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
http/https. Origin check: `origin === new URL(c.req.url).origin` (Host-derived — see quirks).
`linkAborts()`: client `req.raw.signal` + incoming `aborted` + outgoing premature `close` → one
AbortController. `passRequestHeaders()` drops hop-by-hop + `cookie` + `x-pi-web-token` + others, forces
`accept-encoding: identity`. Body buffered via `c.req.arrayBuffer()` (≤25MB per `MAX_INBOUND`).
`undiciFetch` with a pinned `UndiciAgent` (16 connections, pipelining 1, keepAlive 30s, connect
timeout 30s, **headersTimeout/bodyTimeout 0** so SSE can stream forever).
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
`sessionsDir`, skips corrupt). `putOne`: update cache → write `<id>.jsonl.tmp` → rename (atomic).
`SESSION_ID_RE = /^[A-Za-z0-9_-]{1,80}$/` gates ids on both threads. Main thread wraps ops in
`storeOp()` (promise map keyed by a monotonically increasing id; worker replies resolve/reject).

## `/ws/sync` hub (`syncConn`)

Client set with per-client `watch` set; 20s ping/pong liveness sweep (`terminate` + drop on missed
pong). Inbound (`MAX_INBOUND` size guard): `list` (1s cache), `put` (id regex; accepts native `{jsonl}`
or the browser's legacy `{data:{messages...}, metadata}` — converted line-by-line, counted in
`legacySyncPuts` for shim removal), `get` (returns `{jsonl, metadata, data:{messages}}`), `watch`
(add + immediate `pushWatched`), `delete`. After put: `broadcastSessions()` (300ms-coalesced,
invalidates `listCache`) + `pushWatched(id)` to watchers (backpressure-aware via `MAX_BUFFERED` 4MB).

## Server-side agent hub (`agent-hub.mjs`, non-default path)

Agent per session; `getApiKey` reads `.pi/auth.json` server-side (keys never sent to clients);
`persist()` → worker store. Events: every event seq-stamped + broadcast to `/ws/agent` clients;
user-message ends persist immediately, others debounced 400ms with a 2s maxWait. `attach()` =
subscribe-first: temporarily swaps `this.broadcast` to buffer events while snapshotting, then delivers
snapshot + buffered (dedup by seq) — the swap/restore is not reentrant (quirk). `prompt()` queues ONE
follow-up while streaming (depth 2+ rejected). Eviction: idle >30min (flush first) or LRU beyond
HOT_AGENT_CAP+5; `flushAll()` on shutdown (note: no SIGINT wiring in server.mjs currently).
`onEvents()` backs the SSE endpoint the same (swap) way.

## Upgrade routing (`serve().on("upgrade")`)

1. Non-loopback without token → 401 + destroy.
2. Path dispatch: `/ws/sync` and `/ws/agent` → shared 25MB-maxPayload WSS; `/ws/terminal` →
   `terminalHub.handleUpgrade()` (its own size-capped WSS + Origin allowlist); anything else destroyed.
