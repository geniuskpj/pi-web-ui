# Client — main.tsx, chat.tsx, storage, sync, connectivity

> Updated 2026-10-28 · See also: [architecture.md](architecture.md) (data flows, trust model) ·
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
- **Display by user turn (2026-10-27, `lib/display-gate.mjs` + `pi.turnWindow`):** the gate hides the
  messages BEFORE the N-th newest user turn, N = Settings → Composer → *Turns visible* (`localStorage
  pi.turnWindow`, default 3, `turnsVisiblePref()`/`setTurnsVisible()` in `chat.tsx` — the setter
  dispatches `pi-turn-window-changed`, ChatView re-gates live from the LAST turn). The gate is a SEQ
  (`gateSeqOfLastTurns`), so a prefix fill cannot invalidate it; `resolveGateSeq(gate, filledFrom,
  msgs, turns)` re-anchors only a gate that points OUTSIDE the loaded window. **A null gate stays null**
  — small sessions (no `sparse` envelope) and full state frames render EVERYTHING. Two user-reported
  bugs came from the opposite rule: `resolveGateSeq(null, …)` used to mean “the last user turn”, so
  every chat was gated (a one-turn session showed a ⤒ button that hid only its system message) and the
  gated view was hardcoded to ONE turn. ⤒ reveals one more turn per click (`prevUserSeq`, from memory
  when loaded, `/range` when not); the button appears only when something is really hidden and reports
  `displayFrom` (in view) and `filledFrom` (not loaded) separately. Test: `npm run test:gate`.
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

## Find (chat + file viewer, 2026-10-28)

**Chat** (`ui/find.tsx` + `chat.tsx`, `Ctrl/Cmd+F` or the header 🔍): the bar queries
`GET /api/agent/session/:id/search` (server-side, whole session — see [server.md](server.md) §Find) and lists
each hit as **role badge + turn + 1–2 lines of context** with the match marked by `<mark>` — the ONLY place
the app draws one (markdown input/memoization is never touched).

- **Seq-keyed, never index-keyed**: a prefix fill PREPENDS `state.messages`, so a hit is addressed by its
  absolute seq (`data-seq` on the `.pw-anchor` wrapper) and re-resolved at jump time.
- **Jump**: in the live window (and not behind the display gate) → `highlightSeq` outline + `details`
  opened + `scrollIntoView`, auto-scroll pinned off. Otherwise a **read-only PEEK sheet**: the loaded slice
  when the hit is already in memory, else ONE `/range` fetch (`ProxyAgent.peekRange` — fetch + gunzip +
  header-validated, **never spliced** into `state.messages`; `fillWindow` would have to prepend up to the
  hit and then mount everything behind the gate). The peek says `seq a–b · read-only peek · not in the live
  window`; hits are steppable with Enter/Shift+Enter and the sheet closes with Esc.
- **Staleness**: the response's `rewriteSeq` is compared with `state.sparse.rewriteSeq` — a rewrite
  (edit/retry/restore/compact) marks the list dirty (“search again”); appends never invalidate it. A
  mirror-only (`source: jsonl`) list is marked dirty as soon as the hub attaches. A session switch clears
  everything (and the query).
- **Honest status line**: `N matches · live transcript|saved mirror · M messages · K searched` (+`truncated`).
  Searches `user`+`assistant` text only (tool output/thinking excluded in v1).
- Ctrl/Cmd+F keeps the browser's native find when text is SELECTED in a field; otherwise it opens the bar.
  The debounce is IMPERATIVE (a `setTimeout` in the input handler) — a deps-array effect silently did not
  re-run in the live app during verification.
- `window.__piFind` exposes the bar's state for debugging (like `__piGate`/`__PI_PROVIDERS`).

**File viewer** (`ui/file-picker.tsx`): **ONE search box with a Name / Contents mode switch** (two stacked
inputs were the "not good" part — sonnet review 2026-10-28); switching preserves each query, and switching TO
Contents re-runs what is already typed. Contents searches the CURRENT directory on the server; the left pane
switches to grouped results (`path (n)` + `line: text` with `<mark>`), the active hit is highlighted, and the
status line sticks to the top of the scroller. Clicking a hit opens the file **at that line**; the preview head
gains a `n / m matches in file` stepper (▲▼ + ✕, Enter/Shift+Enter while the box is focused) and a warning when
the hit is past the 120k-char preview (never a silent landing at the end). `jumpTo()` carries the file's FULL
path (`selPath`), so a hit from another directory previews/attaches correctly (`attachSel()`).

**Per-line preview rendering** (`ui/line-split.ts`, user report 2026-10-28: "a bug in highlighting lines ui"):
the hit line used to be an absolutely positioned BAND whose `top` came from the CSS line-height against the
scroll container's padding box — off by the `<pre>`'s own padding, drifting with the sticky gutter, and
impossible in the PROSE preview (no `<pre>` at all: a hit in a `.md`/`.txt` jumped nowhere). Every source line
is now its own element (`<div class="pw-code-line" data-line="N">`, or `.pw-prose-line` for prose, both with a
min-height so blank lines keep their row), built with ONE `innerHTML` write per file (`codeLinesHtml`, rebuilt
on a jump so the hit carries `.pw-code-line-hit`) — the jump is then `querySelector('[data-line]')` +
`scrollIntoView`, exact for code and prose alike. hljs spans that CROSS newlines are closed/re-opened per line
by `splitHljsLines` (block comments, template literals) so the markup stays well-formed and copy still works.

**Input-driven work is IMPERATIVE here, not a deps-array effect** (measured 2026-10-28, see
[lessons.md](lessons.md) → "A deps-array useEffect can run with a stale closure"): both the chat find bar and
this viewer search debounce inside the input handler with a `setTimeout` ref. A `useEffect(..., [q])` ran with
the PREVIOUS query (Preact commits hook `_args` at diff time and the afterPaint flush invokes the previous
render's callback), so the search fired for the wrong text or not at all.

**Theme** (`ui/theme.ts`): `readTheme()/applyThemeClass()/setTheme()` own the `theme` key + `.dark` class; the
header cycle button is gone (user request) and Settings → Appearance holds the select. The shell only applies
the class at boot and follows the OS while `system` is selected.

**Mobile chrome**: `@media (max-width: 800px), (pointer: coarse)` tightens the header — 32px buttons, zero flex
`gap`, 4px padding (the visible spacing was the BUTTON's own slack, not the gap; `pointer: coarse` covers a
phone browsing in desktop mode).

## Model selector (`ui/model-selector.tsx`)

Reads `window.__PI_PROVIDERS` (pi-import.ts, `pi.modelsCache`) — the SERVER's merged catalog
(`lib/pi-catalog.mjs`; see [server.md](server.md) §Provider catalog), which now includes providers added
in `.pi/models.json` and providers that only exist in `auth.json`. Every OPEN re-fetches
`/api/pi/config` (async, `cfgTick` bumps the memo) so a hand-edited models.json is visible without a
reload, and the group header appends `· custom` (origin `models.json`) / `· no key` (keyless provider).

## Data use: the image pipeline (2026-10-25 — model + wiring contract)

**THE MODEL (user design, 2026-10-25):** the browser ENCODES every image (resize + webp/jpeg); only
the encoded bytes are ever stored, as **binary** — never the raw original, never base64. The server
keeps those bytes in the content-addressed media store (`data/media/<hash[0..1]>/<hash>`, disk-backed
so a restart keeps them) and produces **base64 only when the LLM request is built**
(`hydrateImageData`, at the one place a provider is called). Fetching a preview needs no decoding in JS:
`<img src="/api/agent/session/:id/media/:hash">` and the browser decompresses any `Content-Encoding`.

Two routes carry it: **`POST /api/agent/session/:id/media`** (body = the encoded image, `Content-Type`
= its mime → `{hash, mimeType, bytes, encodings}`) and **`GET …/media/:hash`** (binary out; br/gz only
when a stored variant pays — measured 0% for image formats, see
`tests/image-compression.test.mjs`). The transcript then carries `{type:"image", mimeType, hash, bytes}`
and a warm attach costs hashes instead of megabytes.

**Retention (Settings → Data use → *Image storage*, `pi.imageRetention`):** *server* is the DEFAULT — the
encoded bytes are persisted in the disk store, so any device can render them and a retry/fork/re-run
still reaches them. *browser* keeps the bytes on the device: the upload then carries
`x-pi-media-retention: browser`, the server stores them **in memory only** (`persist: false`) and forgets
them on restart, and the browser is the source of truth (it must re-upload when the server needs an old
image again). Both modes are one header apart, so switching later costs nothing.

**No gz/br for images** (user decision 2026-10-25): measured ~0% on webp/jpeg/PNG (a brotli pass is even a
few bytes bigger), so neither the store nor the media route compresses anything — one artefact, the
encoded binary. The JSON/NDJSON paths keep their generic >2KB gzip gate, which is what pays when a legacy
session still carries base64.

### The client hop (LIVE since 2026-10-27)

`ProxyAgent.setDataReduction(cfg)` exists, and the ATTACH handler re-pushes the stored levels on every
(re)attach (next to `pushAutoRetrySetting`), because the hub's config is PER CONNECTION — a reload used to
drop it and the whole feature read as "the setting does nothing" (report.md B1). Hub `note` frames now
reach the composer chip through `agent.onNote`, and they no longer settle a pending prompt/steer reply
(M1). The recalled images of ✎-edit AND Stop are hydrated before they go back into the composer (L1).

**Latency (2026-10-27):** the visible cost of coalescing is the FIRST chunk, not the total. Every preset
therefore carries `firstBytes` (thinking 64B, answer 32B, tool 512B): the first chunk of a block is
released immediately (like live streaming), everything after it is coalesced, and the idle rule + the
hard ceiling are driven by a per-socket 250ms tick on the server (`stream-reduce.mjs` `tick()`), so a
slow provider can no longer leave held text invisible past the ceiling (report.md H2). Measured: the
first text of a reasoning block now arrives +0.08s after the live baseline (was +1.6s), with the worst
chunk still bounded at 1.6s.

### What is still to wire (`src/ui/chat.tsx`)

Settings → **Data use** stores two LEVELS and prints their resolved parameters:
`pi.imageLevel` (`auto` · `high` · `medium` · `low` · `none`) and `pi.thinkingLevel`
(`auto` · `paragraph` · `turnEnd` · `none`), plus advanced overrides (`pi.imageMaxEdge`,
`pi.imageMinEdge`, `pi.imageMaxBytes`, `pi.imageQuality`, `pi.textLevel`, `pi.toolLevel`). All keys live in
`src/ui/data-settings.ts` (the `pi.autoRetry` pattern: read on render, written on change, pushed to the
hub through the optional `agent.setDataReduction()`).

Every DECISION is pure and tested (`lib/data-reduction.mjs` → `resolveDataReduction()` /
`planImageTransform()` / `planResizeTarget()`; `lib/thinking-flush.mjs` → `resolveThinkingPolicy()` /
`resolveStreamPolicy()`; pinned by `tests/data-reduction.test.mjs` and `tests/thinking-flush.test.mjs`).
The IMAGE half is enforced in the composer — **not wired yet**, and this is the contract for it.

### Where the bytes are born (`src/ui/chat.tsx`)

| step | code (names are the anchors — line numbers drift) | today | after wiring |
|---|---|---|---|
| file/folder picker | `addPicked(f)` — `GET /api/ws/file?path=…` returns `{kind:"image", base64, mimeType}` (8MB cap, token always required; `src/ui/file-picker.tsx` fetches it) | pushes `{name, data, mimeType, preview}` (base64) into `images` | `base64 → Blob → encodeForModel()` → `POST …/media` → push `{hash, mimeType, bytes, previewUrl}` |
| clipboard paste | `onAddImage(name, data, mimeType)` (Editor paste handler, data URL) | same shape | decode the data URL to a Blob → the same path |
| steer/stop recall | `onAddImage(...)` from the recalled `pendingPrompt.images` | inline base64 re-attached | hash parts → `media.ts` hydration (`hydrateImageParts`) |
| restored message attachments | `onRestoreAttachments(files, imgs)` (edit/regenerate an old turn) | inline base64 from the transcript | hydration only — **never re-encode** |
| chip render | `<img src={im.preview}>` | `preview` = full `data:` URL (a second copy of the base64 in memory) | `URL.createObjectURL(encodedBlob)` (revoked on remove/clear) or the media URL |
| pre-send guard | `imageBytes > 12MB → note(...)` | sums `data.length * 0.75` | the encoded size returned by the POST — should never fire |
| send | `images.map((im) => ({ type: "image", data, mimeType }))` → `agent.prompt(text, imgs)` | base64 in the frame | `{type:"image", mimeType, hash, bytes}` — no base64 up, none in the session file |

The composer still sends inline base64 today; the server redacts it on egress (attach/`/range`/history)
and stores the bytes. Wiring the composer is the step that removes the LAST base64 from the upload path.

### The one function to add (`src/image-encode.ts`)

```ts
// pure decision (tested) + browser bytes (not testable in CI)
export async function encodeForModel(file: Blob & { name?: string }, policy = resolvedImagePolicy()) {
  const plan = planImageTransform({ mimeType: file.type, bytes: file.size, width: 0, height: 0 }, policy);
  if (plan.action === "passthrough") return { blob: file, mimeType: file.type, note: plan.reason, resized: false };
  // ✔ downscale AT DECODE: 12MP is never fully materialized (the low-end-iOS OOM trap)
  const bmp = await createImageBitmap(file, {
    imageOrientation: "from-image",                       // EXIF is applied for us
    resizeWidth: plan.target.width, resizeHeight: plan.target.height, resizeQuality: "high",
  }).catch(() => null);
  if (!bmp) return { blob: file, mimeType: file.type, note: "couldn't recompress — sending original", resized: false };
  const canvas = typeof OffscreenCanvas === "function"
    ? new OffscreenCanvas(bmp.width, bmp.height)
    : Object.assign(document.createElement("canvas"), { width: bmp.width, height: bmp.height });
  canvas.getContext("2d").drawImage(bmp, 0, 0); bmp.close?.();   // one scale factor, both axes
  const blob = await toBlobWebpThenJpeg(canvas, plan.quality);    // OffscreenCanvas.convertToBlob | canvas.toBlob
  if (!blob || blob.size >= file.size) return { blob: file, mimeType: file.type, note: null, resized: false };
  return { blob, mimeType: blob.type, note: `${plan.reason} → ${plan.target.width}×${plan.target.height}`, resized: true };
}
```

Then `blob → base64` (FileReader/`arrayBuffer()`) **once**, and the four add/restore call sites above pass
through it.

Notes worth keeping:

1. **Never re-encode an attachment that came from a transcript** (restore, steer recall, stop recall): the
   model already saw those exact bytes; a retry must resend the same image, not a re-compressed one.
2. **The 4-image cap is applied after the plan** (`MAX_IMAGE_ATTACH`): a file that passes through
   (HEIC/exotic) still counts as one, but a file the plan drops must not consume a slot.
3. `imageLevel: "none"` means **do not decode at all** — zero cost, original bytes (the escape hatch).
4. Passthrough is **never silent**: `note(plan.reason)` puts it in the composer's attach note
   (HEIC on Chrome, SVG/GIF, tool screenshots, undecodable).
5. EXIF: `createImageBitmap` returns *oriented* dimensions, so pass the bitmap's dims + `orientation: 1`
   to `planImageTransform`; if you plan from metadata read before decoding, pass the raw dims + the EXIF
   orientation (the pure layer swaps the axes for 5–8).
6. Alpha: WebP keeps it, JPEG flattens onto white — that is why JPEG is only the runtime fallback
   (Safari / old Chrome return a non-webp blob).
7. Encode **on add**, not on send (≤4 images, bounded work; the send stays instant) and revoke the object
   URL on remove/clear so the preview cannot leak memory.

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
prompt, no key-replacement 401 flow — keys live in `.pi/auth.json` on the server). The browser ALSO
saves the mirrored transcript locally (session list stays instant offline) while the hub persists the
authoritative JSONL copy server-side after every turn.

## Diagnostics (`diag.ts`, `diag-panel.tsx`)

2000-entry ring buffer with weighted levels (`?log=` / panel sets the level; localStorage
`pi.logLevel`), warn/error always mirrored to console, trace ids, FAB drawer with warn/error filters,
"Copy Diagnostics" (client + `/api/debug/state` server snapshot), `buildId` parsed from the script tag.
