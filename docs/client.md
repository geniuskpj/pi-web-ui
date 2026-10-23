# Client — main.tsx, chat.tsx, storage, sync, connectivity

> Updated 2026-10-21 · See also: [architecture.md](architecture.md) (data flows, trust model) ·
[server.md](server.md) (exec bridge, /ws/sync hub) · [terminal.md](terminal.md) (command bridge consumer)

Covers `src/main.tsx`, `src/ui/chat.tsx`, `src/storage.ts`, `src/local-storage-backend.js`,
`src/session-sync.ts`, `src/ui/proxy-stream.ts`, `src/pi-import.ts`, `src/pi-tools.ts`, `src/llm.ts`,
`src/id.ts`, `src/ui/markdown.ts`, `src/ui/file-picker.tsx`, `src/proxy-agent.ts`, `src/diag.ts`.

## Boot (`main.tsx init()`)

1. `?reset-storage`: delete IDB dbs (`pi-web-ui-app-v3`, legacy `pi-web-ui-app`) + clear localStorage →
   redirect. (The `?nosync=1` / `?noproxy=1` flags an older README listed were NEVER implemented — the
   sync client connects unconditionally and proxy state comes from localStorage; they were removed from
   the README on 2026-10-21. Also dead: `system-prompt-dialog.tsx` exists in src/ but is not rendered
   anywhere since the prompt-viewer button was removed.)
2. Theme class before first paint (`theme` = system|light|dark + `.dark` on `<html>`; matchMedia
   listener when in system mode).
3. **fetch monkeypatch** (`src/server-auth.ts`, 2026-10-23): same-API = URL contains `/api/` or
   `/ws/`; attaches `x-pi-web-token` from `localStorage["pi.webToken"]`, then classifies the reply
   into the auth state the shell renders: `ok`, `no-token` (bare 401 → ONE `window.prompt` → store +
   replay), `bad-token` (401 WHILE a token is stored — never prompts in a loop), `host-blocked` (403;
   the banner shows the server's own reason, e.g. "Host/Origin not allowlisted") and `offline`. Both
   used to be SILENT (an empty session list with no message); now an amber banner in the App shell
   (Retry/Settings buttons) plus an inline note in the session dialog explain them.
   **WebSocket patch**: appends `?token=` for `/ws/*` paths (WS cannot set headers) — since
   2026-10-23 the server accepts the query form on `/ws/*` ONLY, so the token cannot leak through
   Referer/browser history/proxy logs on plain HTTP.
4. `piSystemPrompt` = resolvePiSystemPrompt(): `/api/pi/system` → base = wins-flagged WEB_SYSTEM.md or
   SYSTEM.md, + wins-flagged APPEND_SYSTEM.md, joined; offline → undefined (chat default).
5. `piServerTools` = fetchPiServerTools() — must be ready before Agent creation (tools are passed
   synchronously in the constructor; toolsFactory is not used in this UI).
6. Proxy defaults seeded synchronously: `pi.proxyEnabled` (default "1" over http) + `pi.proxyUrl`
   (default `location.origin + "/api/proxy"`).
7. `createAgent()` → render → `sessionSync.connect()` → `pagehide`/`visibilitychange` → flushSession.
8. Background (never blocks paint): `/api/health` status dot, `fetchAndApplyConfig()` (8s timeout) with
   default-model adoption, `?session=` restore (15s timeout).

## Agent lifecycle (`main.tsx`)

- `createAgent(initialState?)`: builds `new Agent` with systemPrompt/model/thinkingLevel/messages/tools
  (undefined-valued overrides filtered so an explicit undefined can't clobber defaults, e.g.
  `tools: undefined` crash), wires `agent.streamFn = createProxyStreamFn()` and
  `agent.getApiKey = createApiKeyResolver(providerKeys)` on EVERY creation (session switches construct
  a new Agent — losing this meant direct/unkeyed calls), subscribes:
  - `message_end|message_update`: derive title from first user message; lazily mint
    `currentSessionId = makeId()` (secure-context-safe v4) + URL `?session=`; `saveSessionSoon()`.
  - `agent_end`: `flushSession()` + sync push + **idle re-sync** — pi-agent-core flips `isStreaming`
    in `finishRun()` AFTER agent_end listeners, so `agent.waitForIdle().then(notify)`.
- Save pipeline: debounced 1200ms `saveSession()` (refuses deleted ids; requires both a user and an
  assistant message) → SessionsStore.save (data + metadata) → `sessionSync.push(id)`.
- `deleteSessionById`: `deletedSessionIds.add(id)` + clear save timer + clear `currentSessionId` BEFORE
  navigating — a deleted session can't resurrect via the debounce or pagehide flush.
- `loadSession(id)`: flush first; pull local store AND `/api/agent/session/:id`; winner = more
  messages (local authoritative on-device); missing everywhere → prune the metadata entry (self-heal);
  stale server mirror → re-push local; resolve the model object via the config cache (modelId →
  provider models list → local model object → last-used); `createAgent({messages,...})` WITH history.

## chat.tsx — rendering rules

- Final messages (`state.messages`) render text as **markdown** (`renderMarkdownCached` — exact-string
  memo, Map reset at 500 entries); the in-flight `state.streamingMessage` renders **plain text** (never
  mark per-delta). Always render FROM STATE — no delta appends, no clears on `message_end`.
- Thinking parts → collapsible `<details>` (open while streaming), plain text.
- Tool rows keyed by `toolCall.id` (never index); results matched via a `toolCallId → toolResult` map;
  running rows show UI-only partials (cap 4096 chars) replaced-not-concatenated; orphans (no result
  after abort/error) inherit the parent message's stopReason chrome instead of "queued".
- `msgIds` WeakMap gives stable keys across retries/edits so `<details>` collapse state survives.
- Auto-scroll: `stick` ref; user wheel/touch unsticks (programmatic scrollTop fires onScroll — it would
  re-stick and rubber-band during fast streams); re-stick near bottom (<10px).
- 401 flow: on `agent_end` → `waitForIdle()` → inspect ONLY the last assistant message →
  `looksLikeAuthError` (401/403/invalid-key regex) → prompt → store via providerKeys.
- Retry (2026-10-23): the button delegates to the HUB (`agent.retry()` → `{type:"retry"}` →
  `{type:"retried"}` ack; the run streams as normal agent events). The hub drops the 429/error message
  and calls `agent.continue()`, so the failed model call is re-issued against the SAME transcript: the
  user turn appears exactly once (the old version here called `prompt()` with the last user text, which
  APPENDED a second user message) and tool calls that already completed are NOT re-run; a failed resubmit
  of an ✎ edit keeps its parked version. The `?local=1` in-browser loop mirrors the semantics locally
  (`agent.continue()` + the dangling-toolCall repair — tool_use without tool_result is invalid for
  Anthropic/OpenAI-style APIs).
- Auto-retry (2026-10-23): Settings → Retry (default ON, `localStorage pi.autoRetry`), pushed to the hub
  after every attach (`{type:"set-auto-retry"}`). Only transient failures are retried (429/rate-limit/
  quota/5xx/network), 3 attempts 3 s apart; the counter resets on success or any user action, and auth /
  context-overflow errors are never retried. Progress shows in the runtime preview ("retrying (2/3)…").
- Composer: Enter=send / Shift+Enter=newline, IME-safe (isComposing/229), draft persisted
  (`pi.web.draft`), auto-grow ≤200px, Send↔Stop with text labels, `sending` ref + a ≤1s busy-wait for
  `isStreaming` as the double-send guard. Attachments: text files inlined as fenced blocks with a fence
  longer than any inner backtick run + `--- file: path ---` markers (chips re-open the explorer);
  images via the `images` param (MIME allowlist png/jpeg/gif/webp, 8MB cap, max 4; text max 6); empty
  text + images → single space (Anthropic rejects empty text blocks); failed sends restore draft AND
  attachments.
- Usage bar: last-call context % (prefers `usage.totalTokens`, else the 4-way sum; labeled "last-call"
  because provider usage shapes differ) + session totals ↑↓$.

## Storage (`storage.ts` + `local-storage-backend.js`)

- `LocalStorageBackend`: synchronous localStorage replacement for a wedged-IDB history. Layout:
  `<dbName>:<store>:<key>` + a per-store `__keys` index JSON; values live in a memory Map hydrated per
  store on first access; quota errors → evict the largest OTHER session once and retry → else keep in
  memory only (the server mirror is durable). `getAllFromIndex` = scan + sort by field (not a real
  index). `transaction()` is a plain sequential shim. `getDB()` throws (raw IDB is banned).
- `ProviderKeysStore`: localStorage `pi.key.<provider>` is the CANONICAL fast tier (get/has read it
  first; set/delete mirror it; list() unions both sources). Rationale: the IDB key read hung on some
  devices; the pre-send key check must be instant.
- `SessionsStore`: bodies in `sessions`, metadata in `sessions-metadata`; save/delete via the tx shim;
  `updateTitle` bumps `lastModified` in BOTH stores (re-sort + server sync).

## Session runtime status (fable5, 2026-10-21)

`session-sync` keeps a VOLATILE `runtimeMap` (id → {status, startedAt, turn, currentTool, lastText,
pendingPrompts, clients, seq}) fed by `{type:"runtime"}` delta frames (applied immediately, bypassing
the 5s metadata throttle; seq-guard: stale frames dropped, idle deletes) and FULL-REPLACED from the
embedded runtimes inside every "sessions" frame (restart/reconnect hygiene). `onRuntime(cb)` fires
immediately; `seedRuntime()` ingests a REST /api/sessions boot snapshot. `syncHealthy()` reports
whether the sync socket is OPEN — the runtime map is live only then. Consumers: session-list
(live rows pinned top, badge, preview), main.tsx header activity button + resume banner +
document.title, and the AliveSessionsDialog (below).

## Alive sessions dialog (`src/ui/alive-sessions.tsx`, 2026-10-21)

Dedicated live view of sessions with a RUNNING or ERROR server-side run (the full session list
still shows everything). Header activity button (heartbeat icon) — the badge counts alive sessions
EXCLUDING the current one ("other stuff needs me"), red when any error; the DIALOG lists ALL alive
incl. current. Rows are derived from the runtime map on every render (stable sort: error → running
→ done, startedAt desc — rows only reorder on status transitions, so Kill targets don't jitter);
a 1s tick re-renders elapsed time. Titles resolve metadata.title → runtime.lastText tail →
`Session <id8>`; metadata is fetched on open and re-fetched (throttled 3s) when an unknown
sessionId appears. Row click navigates (`loadSessionById`); the CURRENT session's row just closes
(no reload). Kill = two-stage inline confirm (Kill → "Confirm?" for 3s → `POST /api/agent/abort`)
→ "stopping…" until the runtime frame flips; abort failures are SILENT (the run may have finished
naturally in the same instant); error rows have no kill (nothing in-flight) but stay clickable.
A row whose run finishes while open lingers 2s as "✓ done" (grace map), then drops. Footer shows
live/paused via `syncHealthy()`. (Server-side counterpart: every runtime emission advances the hub
seq — see docs/server.md — so runtime-only deltas are never dropped by the stale-frame guard.)

## Session sync (`session-sync.ts`)

- Push coalescing: one in-flight put per id; new pushes during flight mark `pushDirty` → re-push after.
  Closed socket → `pendingPushes` set, flushed on open (with 0–400ms jitter after mass reconnect).
- Pull: explicit `getSession(id)` with 6s timeout; responses only fulfill waiters (never auto-write).
- Metadata merge (`sessions` broadcasts): throttled to 5s, `merging` guard (no overlapping passes),
  tombstones (`sync-tombstones` in settings, 30-day TTL) suppress deleted ids reappearing from other
  devices, per-id lastModified comparison, writes via the backend directly.

## Connectivity (`ui/proxy-stream.ts`)

- `shouldUseProxyForProvider`: zai/openai-codex/nvidia/unknown → proxy; anthropic only for
  `sk-ant-oat*` or JSON config keys; openai/google/groq/openrouter/cerebras/xai/ollama/lmstudio → direct.
- `applyProxyIfNeeded`: **clone-before-proxy** — returns a NEW model with
  `baseUrl = proxyUrl + "/?url=" + encodeURIComponent(model.baseUrl)`; never mutates the catalog model.
- `createProxyStreamFn`: proxy URL from localStorage-first getter → `streamSimple(target, ...)`.
- `createApiKeyResolver`: `pi.key.<provider>` → backend store → `POST /api/pi/key` raced with a 5s
  timeout, then a bounded second wait (8s) on the server promise only — a hung endpoint cannot hang the
  run. Resolved keys are mirrored back to `pi.key.*`.
- `looksLikeAuthError`: `/\b40[13]\b|unauthorized|forbidden|invalid[ _-]?(api[ _-]? )?key|api key|authentication/i`.

## Server tools bridge (`pi-tools.ts`)

`GET /api/exec/tools` once at boot (8s timeout, cached) → tool defs with an `execute()` that POSTs
`/api/exec/tool` (`{tool, params, stream}`; client abort signal forwarded). Streaming tools (bash):
parse NDJSON incrementally (buffer partial lines across chunks), `{type:"partial"}` →
`onUpdate(partialResult)`, `{type:"result"}` → final; stream ending without a result → isError result.
Non-stream JSON normalized to `{content:[{type:"text",text}]}`.

## Message conversion (`llm.ts`)

`defaultConvertToLlm` vendored (module-private upstream): keeps only user/assistant/toolResult roles
(toolResults MUST survive so the model sees tool errors). `customConvertToLlm` first rewrites
`system-notification` → user message wrapped in `<system>...</system>`.

## Secure-context fallbacks (`id.ts`)

`makeId()`: `crypto.randomUUID` → `getRandomValues`-built RFC4122 v4 (randomUUID is secure-context-only;
the app is served over plain-http LAN IPs). `copyText()`: async Clipboard API → hidden-textarea
`execCommand("copy")`.

## Markdown / XSS (`ui/markdown.ts`)

marked GFM + breaks; custom `code` renderer: fence info-string whitelisted (`/^[a-zA-Z0-9_+#.-]+$/`,
only the first token), hljs only if the language is registered and input ≤ 20KB (ReDoS guard), else
`escapeHtml`. Sanitize with DOMPurify `FORBID_ATTR: ["style","id","name"]` (no inline styles, no DOM
clobbering); afterSanitizeAttributes hook forces `target=_blank rel="noopener noreferrer nofollow"` on
links. Never throws (fallback = escaped source).

## File explorer (`ui/file-picker.tsx`)

Two panes: left = `/api/ws/files` listing (dirs first, files by mtime desc, name filter), right =
preview via `/api/ws/file` (cached per path; generation counters `loadGen`/`selectGen` supersede stale
responses). Preview cap 120KB chars; text attach cap 512KB (images exempt, server caps 8MB); prose
extensions (md/txt/log) render as flow text, code files as hljs-highlighted `<pre>` with a sticky
line-number gutter (no wrap so the gutter stays aligned). Multi-select checkboxes → sequential batch
attach. `initialFile` opens at a file: load its parent dir, then `select(entry, dirOverride)` with the
FRESH dir (the closure `path` is stale until the next render — the first-click bug). Last dir
persisted (`pi.filePickerDir`) with root fallback if it vanished.

## Server-side agent adapter (`proxy-agent.ts`, DEFAULT chat path since 2026-10-21)

State mirror of pi-agent-core's event application (message_start/update → streamingMessage, message_end
→ push, tool_execution_start/end → pendingToolCalls set copies, agent_start/end → isStreaming; partials
(`tool_execution_update`) flow to chat.tsx's UI-only map via the event subscription). One WS with
generation-guarded reconnect (exponential + jitter), subscribe-first attach semantics server-side,
`whenReady` polling, `waitForIdle` with a 5min cap, follow-ups via `prompt()` → WS (`prompt` now also
accepts `images`). `serverSide = true` flag drives the client behavior differences (no browser key
prompt, no key-replacement 401 flow — server keys come from `.pi/auth.json` or Settings' server key
store). Settings also keeps a local copy for `?local=1`. The browser ALSO
saves the mirrored transcript locally (session list stays instant offline) while the hub persists the
authoritative JSONL copy server-side after every turn.

## Diagnostics (`diag.ts`, `diag-panel.tsx`)

2000-entry ring buffer with weighted levels (`?log=` / panel sets the level; localStorage
`pi.logLevel`), warn/error always mirrored to console, trace ids, FAB drawer with warn/error filters,
"Copy Diagnostics" (client + `/api/debug/state` server snapshot), `buildId` parsed from the script tag.
