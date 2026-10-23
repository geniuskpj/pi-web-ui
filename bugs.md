# bugs.md — Known bugs, fixes, and patterns for reuse

This file documents every bug found during development, its root cause, and the fix pattern. Use these patterns when building similar features or debugging in other sessions.

---

## 1. Streaming message vanishes mid-generation

**Symptom**: The assistant's reply appears, grows, then suddenly disappears from the UI while still generating.

**Root cause**: `AgentInterface` in pi-web-ui clears the streaming container on every `message_end` event. But pi-agent-core emits `message_end` **mid-run** — for the user's prompt, for tool results, and for multi-segment model streams. Each one blanks the UI.

**Fix pattern**: Only clear the streaming container when the agent run is actually finished (`!state.isStreaming`).

```js
// BEFORE (bug):
case "message_end":
    this._streamingContainer.setMessage(null, true); // always clears

// AFTER (fix):
case "message_end":
    if (this._streamingContainer && !this.session?.state?.isStreaming) {
        this._streamingContainer.setMessage(null, true);
    }
```

Applied via build.mjs `must()` patch on `components/AgentInterface.js`.

---

## 2. STOP button stuck after response finishes

**Symptom**: The editor shows the Stop button forever after the reply completes. Cannot send a new message.

**Root cause**: pi-agent-core flips `state.isStreaming = false` in `finishRun()`, which runs **after** all `agent_end` listeners settle (documented in the library). AgentInterface rendered at `agent_end` while `isStreaming` was still `true`. No further event fires to trigger a re-render.

**Fix pattern**: After the run is fully idle (`agent.waitForIdle()`), force a UI re-render.

```ts
agent.waitForIdle?.().then(() => {
    (chatPanel as any)?.agentInterface?.requestUpdate?.();
    notify();
});
```

Applied in `createAgent`'s subscription on `agent_end`.

---

## 3. Send hangs — API key read from IndexedDB

**Symptom**: `sendMessage` hangs silently. No network request is made.

**Root cause**: `AgentInterface.sendMessage` calls `providerKeys.get(provider)` which reads from IndexedDB. On wedged profiles, IDB reads hang indefinitely.

**Fix pattern**: Mirror API keys to `localStorage` (synchronous, reliable). Reads go localStorage-first, IDB as fallback.

```js
// provider-keys-store.js set():
async set(provider, key) {
    await this.getBackend().set("provider-keys", provider, key);
    try { localStorage.setItem("pi.key." + provider, key); } catch {}
}

// get():
async get(provider) {
    try { const ls = localStorage.getItem("pi.key." + provider); if (ls) return ls; } catch {}
    return this.getBackend().get("provider-keys", provider);
}
```

---

## 4. Proxy defaults not set (CORS-blocked sends)

**Symptom**: Messages go directly to the provider and get CORS-blocked. The proxy is never used even though the server is running.

**Root cause**: `proxy.enabled` and `proxy.url` are stored in IndexedDB settings. The seeding write hung on slow profiles, leaving the proxy disabled.

**Fix pattern**: Seed proxy settings into `localStorage` (synchronous) at boot. Patch `AgentInterface`'s streamFn to read localStorage first.

```js
// streamFn reads localStorage first (sync, never hangs):
const lsEnabled = localStorage.getItem("pi.proxyEnabled");
const lsUrl = localStorage.getItem("pi.proxyUrl") || location.origin + "/api/proxy";
if (lsEnabled !== "0" && lsUrl) return lsUrl; // default ON over http
```

---

## 5. Final message vanishes after generation completes

**Symptom**: Same as #2 — the reply disappears when the agent finishes.

**Root cause**: Same as #2. The `isStreaming` flip happens in `finishRun()` after `agent_end` listeners settle.

**Fix pattern**: Same as #2 — idle re-sync after `agent_end`.

---

## 6. Session store silently hanging (`p.res is not a function`)

**Symptom**: All session operations (save, list, get) hang. The server logs `p.res is not a function`.

**Root cause**: Typo in the worker message handler: `p.res(msg.result)` instead of `p.resolve(msg.result)`. Every `storeOp` promise never resolved.

**Fix pattern**: Correct property names. Always use the exact property names from the Promise executor parameters.

```js
// BEFORE (bug):
msg.error ? p.rej(new Error(msg.error)) : p.res(msg.result);

// AFTER (fix):
msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result);
```

---

## 7. Blank page — missing closing brace

**Symptom**: Page shows nothing. No console errors. The module fails to parse.

**Root cause**: A code edit dropped the closing `}` of a function (e.g., `loadSession`). TypeScript catches this, but esbuild might produce a broken bundle if the error is in a template literal patch.

**Fix pattern**: Always verify with `tsc --noEmit` after edits. Use the depth counter to find unbalanced braces:
```js
const lines = s.split("\n"); let d = 0;
for (const l of lines) { for (const c of l) { if (c==="{") d++; if (c==="}") d--; } }
console.log("depth:", d); // must be 0
```

---

## 8. Stale bundle executing in browser

**Symptom**: Old code runs even after a rebuild. Console shows old log messages.

**Root cause**: Unhashed filenames + no cache headers. The browser heuristically caches `/assets/app.js` and serves the stale copy on reload.

**Fix pattern**: Content-hashed filenames (`app-[hash].js`) + `Cache-Control: no-cache` + ETag/304 revalidation. Every rebuild produces a new URL.

```js
// build.mjs
entryNames: "app-[hash]",
// server.mjs
"Cache-Control": "no-cache",
ETag: `W/"${st.size}-${st.mtimeMs}"`,
```

---

## 9. IndexedDB hangs indefinitely

**Symptom**: All IDB operations (get, set, transaction) hang for 10-30s+. No error thrown.

**Root cause**: Wedged LevelDB from hard-killed processes or interrupted upgrades. IDB at the same version skips `onupgradeneeded` even if stores are missing.

**Fix pattern**: Replace IDB entirely with a localStorage-backed backend implementing the same interface. If IDB is still needed for large data, add a self-healing `getDB()` that detects missing stores and bumps the version.

---

## 10. `loadSession` doesn't load messages

**Symptom**: Clicking a session in the list shows the model but `messages: 0`.

**Root cause**: `loadSession` fetched the session from the server but called `createAgent()` **without passing the messages**. `createAgent` ignored the `initialState` parameter and always created the agent with `messages: []`.

**Fix pattern**: `loadSession` must pass the loaded data to `createAgent` via `initialState`, and `createAgent` must use it:

```ts
await createAgent({
    model: resolvedModel,
    thinkingLevel: snap.thinkingLevel || "high",
    messages: snap.messages || [],
});

// in createAgent:
agent = new Agent({
    initialState: initialState || { messages: [], ... },
    ...
});
```

Also: after `setAgent`, call `notify()` + `requestUpdate()` to force the UI to render the loaded state (no agent events fire for history loading).

> **Addendum (later):** the `initialState` half of this fix silently regressed — code shipped ignoring the param again (see #18), while the `notify()/requestUpdate()` half survived. Twice now a landed fix has been dropped without a trace. If you touch this code path, run `node cdp-restore.mjs` (CDP suite) before shipping — manual verification has failed on this exact seam twice.

---

## 11. Model choice clobbered by config refresh

**Symptom**: User selects glm-5.3-flash, but the next config refresh switches back to deepseek.

**Root cause**: The background config refresh unconditionally set the model to the server's default.

**Fix pattern**: Only apply the default model if the user hasn't chosen one (`!lastModelFromLocal()`).

---

## 12. First response takes 30-40s

**Symptom**: glm-5.3-flash takes 30-40s for the first visible token. The TUI takes 1-5s for the same model.

**Root cause**: Provider-side thinking latency. The model generates reasoning tokens before the first content token. Measured: nvidia TTFB = 88-121s for deepseek-v4.1-flash (direct and proxied — identical). Not a code bug.

**Mitigation**: Show a visible "thinking…" indicator during the silent window. The user can pick a faster model or lower thinking level via the model selector.

---

## 13. `/ws/sync` message errors after JSONL migration

**Symptom**: `[sync] message error: bad op: put` — the worker rejects puts.

**Root cause**: The `/ws/sync` handler sent `{data, metadata}` to the worker, but the worker was updated to expect `{jsonl}` format. Format mismatch.

**Fix pattern**: When changing the storage format, update ALL writers and readers simultaneously. The server's `/ws/sync` handler must convert to the new format before calling `storeOp`.

---

## 14. Shared validation constant not defined in all module scopes

**Symptom**: `[sync] error: SESSION_ID_RE is not defined` in the server console on every session sync op (put/get/watch/delete); only `list` worked. Session mirroring to the server fully broken.

**Root cause**: `SESSION_ID_RE` was defined only in `session-worker.mjs` (worker_threads module scope). `server.mjs`'s `syncConn()` referenced it at 4 sites. Worker module scope is isolated from the main thread — the constant simply didn't exist there. Every op threw `ReferenceError`, caught by the async handler, logged, and `{type:"error"}` sent to the browser.

**Fix pattern**: Constants used on both sides of a main-thread/worker seam must live in an imported shared module (not a copy-paste duplicate — duplicates drift):

```js
// session-id.mjs (imported by BOTH server.mjs and session-worker.mjs)
export const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
```

Fixing the crash only unmasked #15 (the ops then ran into the next broken layer).

---

## 15. Storage format migration conversion never implemented (regression of #13)

**Symptom**: No errors at all — but the server's session list stayed empty and `data/sessions/*.jsonl` was never written, despite the browser pushing after every turn.

**Root cause**: #13 said "the server's `/ws/sync` handler must convert to the new format before calling `storeOp`" — but the conversion was never implemented. The browser client sends `{type:"put", id, data, metadata}`; the handler required `m.jsonl`, so the condition was falsy and the put was **silently dropped**. Reverse direction too: the worker's get returns `{jsonl, metadata, messages}` but the server sent `data: j.data` (always `undefined`).

**Fix pattern**: A format migration is not done until every seam converts. Accept the legacy shape at the seam, convert explicitly, and mark the shim with a date + counter so it can be retired:

```js
if (!jsonl && m.data) {
    // COMPAT SHIM (dated, bugs.md #15) — remove once legacySyncPuts stops increasing
    legacySyncPuts++;
    const messages = Array.isArray(m.data) ? m.data : (m.data.messages || []);
    const meta = { ...m.metadata, id, title: m.data.title, modelId: modelObj?.id ?? model, thinkingLevel: m.data.thinkingLevel };
    jsonl = JSON.stringify(meta) + "\n" + messages.map((x) => JSON.stringify(x)).join("\n") + "\n";
}
```

Expose `legacySyncPuts` via `/api/debug/state` — when it stops increasing, delete the shim.

---

## 16. Framework catch-all route shadows API routes registered later

**Symptom**: `GET /api/agent/session/:id` returned 404 (body `not found`). Session restore after reload was 100% broken (`loadSession` always false → `newSession()`), with zero server-side errors.

**Root cause**: Hono matches routes in registration order. The static catch-all `app.get("*")` was registered near the top (line 263), BEFORE the API routes at 533+ (`/api/agent/session/:id`, `/api/agent/events`, `/api/sessions`). Any request hit the catch-all first, failed `statSync`, and returned the catch-all's 404.

**Fix pattern**: Register catch-all/static handlers LAST — after every API route — and add an explicit guard so future API routes can't be shadowed:

```js
app.get("*", async (c) => {
    const rel = ...;
    if (rel === "api" || rel.startsWith("api/")) return c.text("not found", 404); // never serve API paths from disk
    ...
});
```

---

## 17. Session restore consulted only the server mirror

**Symptom**: Clicking a session in the list opens a fresh chat instead of restoring it. List shows the sessions fine, but the chat is never recovered.

**Root cause**: `loadSession()` fetched `/api/agent/session/:id` (server mirror) and gave up on `exists:false` — never consulting localStorage, which is the authoritative, freshest store on the same device. For any session not yet mirrored (see #15), the server returned empty → `newSession()`. Two sub-symptoms: the dialog-click path never wrote `?session=` back to the URL (reload lost context), and dead metadata entries (no local body, no server copy) stayed in the list forever, re-triggering the failure on every click.

**Fix pattern**: Resolve from BOTH stores and take the more complete copy (compare `messages.length`, tie → local). On success call `updateUrl(sessionId)`. When local is richer than the server copy, trigger `sessionSync.push(id)` to self-heal the mirror (see #19 for the socket-timing catch). When BOTH are empty, prune the dead `sessions-metadata` entry so the list self-heals.

```ts
const localWin = !server || (!!local && local.messages.length >= server.messages.length);
const snap = localWin ? local : server;
if (!snap) { /* prune sessions-metadata entry; return false */ }
if (local && (!server || server.messages.length < local.messages.length)) sessionSync.push(sessionId);
updateUrl(sessionId);
```

Related: the Sessions button used to abort with a toast when `/api/sessions` failed (offline) — now it always opens the dialog with the local list; the server merge is best-effort.

---

## 18. `createAgent` ignored its `initialState` parameter (regression of #10)

**Symptom**: Even with correct messages passed in, the loaded chat rendered empty.

**Root cause**: `createAgent(initialState?: Partial<AgentState>)` accepted the param but constructed the Agent with a hardcoded literal (`messages: []`). bugs.md #10 said "createAgent must use it" — the fix was landed, documented, then silently dropped again. Second instance of the #15/#16 pattern: a previously-fixed seam regressed because nothing guarded it.

**Fix pattern**: Spread filtered overrides over defaults — filter out `undefined` values so an explicit `undefined` can't clobber a working default (e.g. `tools: undefined` → `agent.tools.map()` crash):

```ts
const overrides: Partial<AgentState> = initialState
	? (Object.fromEntries(Object.entries(initialState).filter(([, v]) => v !== undefined)) as Partial<AgentState>)
	: {};
agent = new Agent({ initialState: { ...defaults, ...overrides }, ... });
```

Guarded by `cdp-restore.mjs` (boots 4 real sessions via `?session=` and asserts the title + rendered content). A true unit test would need createAgent extracted from main.tsx's module scope — not done; the CDP assertion is the current regression tripwire. See addendum on #10.

---

## 19. `sessionSync.push()` silently dropped while the socket was down

**Symptom**: No error — but sessions loaded at boot (before `sessionSync.connect()`) never self-healed to the mirror, and any save landing in a WS reconnect window was lost.

**Root cause**: `send()` no-ops unless `readyState === OPEN`. `push()` went straight to `pushNow()`, which called `send()` on a closed/null socket. Boot order made this guaranteed for `?session=` loads: `loadSession` runs before `sessionSync.connect()`.

**Fix pattern**: Queue pushes made while disconnected and flush on `onopen` (after the initial `list`):

```ts
if (!this.ws || this.ws.readyState !== WebSocket.OPEN) { this.pendingPushes.add(id); return; }
// in ws.onopen: for (const id of this.pendingPushes) this.push(id); this.pendingPushes.clear();
```

---

## Discovered contracts

Behavioral guarantees of vendored/external code that the app depends on. NOT bugs —
permanently open: re-check on every upstream pi-web-ui / pi-ai version bump.

### Contract: toolsFactory must be synchronous
Observed in: ChatPanel (vendored dist, v0.75.3). Behavior: `setAgent` calls
`config?.toolsFactory?.(...)` without awaiting. Breaks if toolsFactory returns a
Promise — tools silently fail to register, no error. Detection: tool list empty at
boot with no console error. Last verified: 2026-10-18, v0.75.3.

### Contract: artifactsPanel.tool is prepended internally
Observed in: ChatPanel.setAgent. Behavior: ChatPanel injects its own artifacts tool
(`this.agent.state.tools = [this.artifactsPanel.tool, ...additionalTools]`) — explains
"mystery" tools not registered by our toolsFactory. Last verified: 2026-10-18, v0.75.3.

### Assumption: tool params schemas are never validated downstream
Observed in: exec bridge path (pi-ai providers). Behavior: typebox schemas are
JSON-serialized (symbols dropped) and passed to providers verbatim (`parameters:
tool.parameters`) with no schema validation in the path. Breaks if a future pi-ai
adds typebox validation — plain-JSON schemas would fail. Last verified: 2026-10-18.

### Assumption: pi trust lookup = nearest-ancestor walk
Observed in: pi-coding-agent trust-manager (`findNearestTrustEntry` walks up parents).
Our /api/pi/system mirrors it. Also assumed: `.pi` is a direct child of the workspace
root (breaks under git worktrees with non-standard .pi locations — set PI_WS then).
Last verified: 2026-10-18, pi-coding-agent 1.2.0.

---

## Debug patterns

### Seam-testing rule (from #14/#15/#16)
All three of these bugs were invisible because each layer was tested against its own well-formed fixtures (worker↔jsonl, client↔localStorage, static router↔real files) — never against what the OTHER side of the seam actually sends. Standing rule: any two components that exchange a format/protocol get at least one test driven by the real producer, not a hand-rolled fixture. Regression script: `cdp-e2e.mjs` (drives the live page over CDP :9222).

### Silent-failure observability
#14 degraded to a caught+logged ReferenceError, #15 to a falsy-condition skip, #16 to a 404 interpreted as "no session". Preventive measures: watch `[sync] error` counts in server logs, track ignored-put counters (`legacySyncPuts` in `/api/debug/state`), and never treat a 404 on a known `/api/*` path as benign. The next instance of this pattern should announce itself, not require CDP archaeology.

### Boot breadcrumbs (compile-time gated)
```ts
dlog.debug("[init]", since(), "boot model:", bootModel.id);
```
- Prod build: stripped (esbuild `define: { __DEBUG__: "false" }`)
- Debug build: visible (`npm run build:debug`)

### Runtime diagnostics (always available)
```ts
// ring buffer: last 2000 entries, levels, trace ids
diag.debug("source", "message", { key: "value" });
diag.warn("source", "message");
// in-app FAB → Copy Diagnostics → paste for bug reports
```

### CDP verification pattern
```js
// 1. navigate + wait for ready
// 2. probe state via Runtime.evaluate
// 3. capture console + exceptions
// 4. check network entries
```

### Brace depth check (catches missing `}`)
```js
const lines = s.split("\n"); let d = 0;
for (const l of lines) { for (const c of l) { if (c==="{") d++; if (c==="}") d--; } }
console.log("depth:", d); // must be 0
```

---

## Architecture decisions

| Decision | Reason |
|---|---|
| In-browser agent (not server-side) | Server-side agent works (agent-hub.mjs) but the client adapter (ProxyAgent over WS) needs more testing. In-browser is proven and simpler. Server-side can be enabled later. |
| LocalStorageBackend (not IDB) | IDB hangs on wedged profiles. localStorage is sync + reliable. Server mirror provides durability. |
| HTTP proxy for LLM (not direct) | Browser CORS blocks direct provider calls. The proxy runs on the same origin, uses undici with stall watchdog + abort propagation. |
| JSONL sessions (not single JSON) | One message per line, crash-safe partial writes, matches pi's native format. Metadata in line 1. |
| Custom-only model selector | The built-in catalog (~900 models) is unusable without browser-side keys. Custom providers from pi config are the actual models. |

## Retry after a provider error must resume at the failure point (2026-10-23)

**Symptom:** after a 429 (nvidia rate limit) or network error, pressing Retry re-sent the user
prompt: the transcript ended up with the SAME user message twice plus the error message, and for a
server-side session the "repair" happened in the browser against a mirror the server never sees
(the real transcript is on the server).

**Root cause:** retry was implemented client-side (`chat.tsx`): find the last user message → take
its text → `agent.prompt(text)`. `prompt()` always APPENDS a user message, so re-sending is a
duplicate turn, not a retry.

**Fix/pattern:** retry belongs to whoever owns the transcript (the hub). The semantics that match
user expectation:
1. drop the trailing failure artifacts — assistant messages with `stopReason` `"error"`/`"aborted"`
   plus toolResults orphaned by them; repair a dangling `toolCall` (no `toolResult`) the way
   `prompt()` already does;
2. `agent.continue()` (pi-agent-core) — it re-issues the model call against the SAME transcript, so
   the user turn stays exactly once and tool calls that already completed are NOT re-run;
3. fallback when the tail cannot be continued (assistant tail): re-send the last user turn, dropping
   it FIRST so it is never duplicated;
4. refuse when nothing failed (`dropped === 0`) — a retry must never regenerate a healthy turn;
5. leave the versions sidecar alone: an ✎ edit whose resubmit failed keeps its parked delta.
Auto-retry (`setAutoRetry`) hooks the same op from the `agent_end` handler: only transient failures
(429/rate-limit/quota/overloaded, 5xx, ECONNRESET/ETIMEDOUT/fetch failed/socket hang up), capped by
`attempts` (3 × 3 s by default), counter reset by success or any user action — never on 401/403/
invalid-key or context overflow.

**Test pattern (worth reusing):** pi-ai ships a FAUX provider —
`registerFauxProvider({api, provider, models})` → `setResponses([fauxAssistantMessage("", {stopReason:"error", errorMessage:"429 …"}), fauxAssistantMessage([fauxText("ok")])])` — so failure/retry
paths can be tested hermetically (no network, no keys, deterministic) against the real hub:
`npm run test:retry` (26 checks). See `tests/retry.test.mjs` for the hub harness
(`modelsStore` pointing at the faux model + fake `persist`/`broadcast`/`versions` deps).

**Editing pattern for this repo (agent-side):** an edit tool that "re-indents to match the anchor"
will flatten the nesting of a multi-level replacement (it turned a 5-tab block into `tab + space`
and collapsed a 130-line method block to one tab). For anything with nested levels, write the new
block to a file and splice it with an anchored script instead — normalise CRLF→LF for matching,
write back with the original EOL, and assert each anchor matches exactly once. Verify with
`git diff --stat` vs `git diff -w --stat`: their stats must be identical (no whitespace-only churn).

## "Ignore the port" is not the TLS-proxy fix (2026-10-23, grok PR review)

**Symptom that triggered it:** the origin allowlist stored entries as `name:PORT`, while a TLS reverse
proxy sends `Origin: https://name` (`new URL(...).host` drops the default 443) — so the check could
never pass and a domain behind a proxy was permanently 403.

**Wrong fix (mine, first attempt):** compare bare HOSTNAMES, ignoring ports entirely. It works for the
proxy case, but it also accepts `Origin: http://localhost:3000` against `Host: localhost:8787` — i.e.
any other app on the same machine becomes a trusted origin, and since loopback peers skip the token,
that is CSRF onto every non-always-token route (prompt/abort/session reads).

**Right fix:** keep EXACT `host:port` entries and resolve a MISSING port to the scheme default —
`http` → `:80`, `https` → `:443` — while a portless `Host` (what a proxy forwards) is tried as the app
port plus `:80`/`:443`. The operator declares the public form (`PI_WEB_TERM_ORIGIN=name:443`).
Malformed Origins fail closed; no suffix/includes matching.

**Related hardening from the same review:** the loopback token exemption must be tied to the HOST, not
just the peer — a reverse proxy on this machine makes the peer loopback while serving a PUBLIC name, so
`authorized()` trusts a loopback caller only when it names a LOCAL host (`isLocalHost()`), in every
`PI_WEB_ORIGIN_GATE` mode. Order matters: run the origin gate BEFORE the token gate, so a loopback
request naming a foreign Host still reports 403 (rebinding defence) instead of 401.

**Where the rules live now:** `hostName()` / `hostCandidates()` / `isLocalHost()` / `authorized()` in
server.mjs, and the terminal hub receives the same origin rule as a PREDICATE (`originAllowed`) so the
two checks cannot drift. Tests: `npm run test:security` (64 checks — other-port Origin, loopback +
public Host without token, portless proxy form, `off`-mode token independence).
