# Patterns, contracts and lessons (moved out of bugs.md, 2026-10-25)

These are not bugs: they are behavioral contracts of vendored/external code (re-check on every
upstream version bump), debugging patterns that paid off, standing architecture decisions, and
lessons from solved incidents. Keep them in mind when changing the corresponding code — the
incident *fixes* themselves are in git history.

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
All three of these bugs were invisible because each layer was tested against its own well-formed fixtures (worker↔jsonl, client↔localStorage, static router↔real files) — never against what the OTHER side of the seam actually sends. Standing rule: any two components that exchange a format/protocol get at least one test driven by the real producer, not a hand-rolled fixture. Regression check: drive the live page over CDP (`cdp_eval`, :9222) — the standalone `tests/cdp-*.mjs` scripts were removed as obsolete (2026-10-25).

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

## `length > 0` is not a hydration flag (2026-10-24)

**Symptom that exposed it:** a fresh browser origin opening `?session=<a 1056-message session>` rendered
an EMPTY chat; a direct WS attach probe against the same server reported `messages: 1, sparse: null`.
The mirror on disk was intact — the transcript was simply never loaded into that process.

**Cause:** `agent-hub.mjs` guarded hydration with `if (entry && entry.agent.state.messages.length > 0)
return entry;`. A freshly created entry ALREADY holds one message (pi materializes the system prompt into
`state.messages`), so a pre-hydration entry looked hydrated forever. Any path that creates the entry
before the transcript load — an attach that loses a race with the store read, a prompt on a cold hub, an
earlier attach — poisoned that session for the life of the process. A hub restart "fixed" it, which is
the tell: the data was never lost, only never loaded.

**Fix:** an explicit flag, plus let the attach do the loading. `entry.hydrated` is set when the caller
SUPPLIES messages (`getSession(id, {messages})` — the caller asserts the transcript), set after a
successful store load, and set on a store MISS (so a new session does not re-query the store on every
attach); a store *error* leaves it unset so a later call retries. Hydration fills an entry only when it
has no non-system messages, so a live transcript is never clobbered. And `attach()` became async: it
awaits `_ensureEntry()` before snapshotting, which makes the fix independent of WHO created the entry.

**Lesson:** never infer "this object is populated" from a count that includes an always-present element.
Track the fact you actually mean (`hydrated`) — and fix the *ordering* at the entry point (attach) rather
than only patching the guard, because the guard alone still lets the first frame be empty. Regression
suite: `npm run test:hydration` (12 checks, incl. the sparse-attach-on-a-pre-created-entry case).

## The suite that reported "30 passed" while failing (2026-10-25)

`npm run test:versions` printed `[versions] 30 check(s) passed` **and exited 1**: its `check()`
incremented a single counter on success and wrote ✗ to **stderr** on failure, so the summary could
not show a failure and every stdout-only read (mine included, twice) saw a green suite. The hidden
failure was real — the check hard-coded `versions.get(S, 2)` while the sidecar's content-hash dedupe
legitimately reuses vid 1 for a byte-identical re-edit, shifting the following capture to vid 2. It was
caught only because CI runs the suite.

**Lesson:** a summary that cannot count failures is worse than no summary — and a test must assert the
PROMISE (everything is restorable), never an identifier a valid implementation may reuse.

## "script.exe has gone" — validating a file instead of a capability (2026-10-25)

User report: "script.exe has gone and terminal with nano is not working". The exe was on disk,
byte-identical to a fresh extraction of its sha256-pinned package, and the branch does not touch
terminal code at all — but it could not create a pty in this environment (`script: failed to create
pseudo-terminal: No such file or directory`; `/dev/ptmx` fails even for a plain `bash -lc 'exec
3<>/dev/ptmx'`, so this Git install's msys runtime cannot provide ptys at all). The hub's
`bridgeUsable()` checked only the PE header + size, so the bridge was adopted, died immediately, and
the tier silently became `pipes` — where nano/vim fail with "standard input is not a terminal" and
NOTHING in the UI said why.

**Lesson:** an integrity check ("this is a plausible binary") is not a capability check ("this binary
can do the job I am about to give it"). Prove the capability by RUNNING it with the real collaborator,
and surface the reason when it fails — a silent downgrade reads as "the feature is gone".

**Resolution (2026-10-25):** the msys route stayed broken on that machine, and the fix came from a
SECOND bridge kind rather than a repair: **Windows ConPTY** (`conhost.exe --headless`) gives the shell a
real console with no download and no native module, and the hub now probes it after `script.exe` (it
prefers whichever PROVES it can give the shell a tty). Verified end to end: nano renders through the
dock. The environment itself turned out to be a resource leak, not a descriptor limit: 16.8M kernel
event objects, 293 days of uptime, and 130 leaked `bash`+`conhost` pairs from servers that were killed
hard (which skips the hub's reap). Corollary worth remembering: **killing a server leaves its terminal
shells and consoles alive** — reap them (or shut down gracefully), or the next pty allocation may fail.

