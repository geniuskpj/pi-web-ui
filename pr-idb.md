# PR — tail-first session loader: range endpoint, IndexedDB cache, display-by-turn

**Branch:** `feat/retry-mobile-transfer` · **Base:** `916c0ef` (mobile long-press/Enter) · **Commits:** 6
**Diff:** 12 files, +909 / −14 · **Status:** local (not pushed — see `pr.md` *Before pushing*)
**Design consults:** grok-4.6-high `01a169e1` (structure + review `01a16a54`), sonnet-5-search `01a169e8` (codec survey)
**Review log:** bottom of this file (append-only, pr.md convention)

> Companion to `pr.md` (auth-gate/retry track). This PR covers the session-transfer track only:
> commits `23dd005`, `4e079e4`, `93034c6`, `dc123bd`, `dadad8e`, `03becb7`.

---

## 1. Problem

Sessions grew past localStorage's quota (~5MB, UTF-16): bodies >512KiB serialized chars were
marked `bodyLocation:"server"` and **re-downloaded whole on every open** (2–7.3MB observed, 667ms
uncompressed loopback, multi-second on mobile). Three user asks drove the design: stop re-fetching
what's already cached, load the tail first + expand, and compress the wire.

## 2. Measured basis (real sessions, node zlib ≈ browser CompressionStream)

| session | size | JSON.parse | gzip-6 | ratio | gunzip | tail-0.5MB parse |
|---|---|---|---|---|---|---|
| 656aacb0 | 2.0MB | 11ms | 53ms | 26.9% | 10ms | 4.0ms |
| 60dfc94f | 3.5MB | 17ms | 104ms | 26.6% | 16ms | 4.4ms |
| ac4dd1f1 | 7.3MB | 60ms | 263ms | 26.4% | 118ms | 8.1ms |

Chunk matrix (browser, 20×/5× avg): per-chunk decompress 3.4ms @512KB / 5.0ms @1MB / 9.7ms @2MB;
full walk 34.2ms @1MB ≈ single-shot 31.7ms. **gzip chunking ratio penalty nil; brotli's is steep**
(10% single → 16.8% @512KB → 12.1% @2MB). Codec survey (sonnet): native CompressionStream wins
for v1; lz4-wasm decompresses 4× faster but ratio is 40% worse (solves nothing here); fzstd/fflate
are the recorded v2 options; brotli wasm (150KB–1.8MB) rejected — wire brotli is native.

## 3. Design (what shipped)

**Server**
- `entry.rewriteSeq` / `entry.rewrittenFrom`: bumped on EVERY transcript rewrite (✎ edit / 🕘
  restore / retry tail-drop / compact), **persisted in mirror metadata**, restored on hydration —
  the identity contract: seqs `< rewrittenFrom` are stable across generations (this product never
  rewrites a prefix in place). Compaction inserts the summary at `from`, so chunks below `from`
  survive.
- `GET /api/agent/session/:id/range` (`fromSeq`/`toSeq` or `tailBytes=`): seq window of the LIVE
  entry, 1MB serialized cap **keeping the HIGH end** (grok #1 — windows must stay adjacent to the
  loaded tail), start aligned DOWN to the nearest **user turn** (user request: "reach until
  previous user turn"). Body: raw `application/gzip` NDJSON (write-through into IDB).
  Headers: `X-Session-Mutate-Epoch`, `X-Session-Message-Count`, `X-Range-From/To-Seq`,
  `X-Rewritten-From`.
- Full session GET gzips (`Content-Encoding`, 7.3MB → 1.92MB); `?meta=1` returns metadata only
  (the open-flow existence check no longer downloads the body); `/api/health` reports `netClass`.
- WS attach accepts `tailFirst`: large sessions deliver the last ~1MB + sparse envelope instead of
  the full snapshot. WS permessage-deflate (`PI_WEB_WS_DEFLATE=off` escape hatch).

**Client**
- `src/idb-cache.ts`: chunk-granular IDB cache (`pi-session-cache` v1): per-chunk gzip blobs keyed
  `[sessionId, fromSeq]` (1:1 with coverage ranges — no merging, grok #5) + a tiny per-session meta
  record (coverage = sorted disjoint ranges). Miss-set = interval diff from ONE small meta get.
  LRU 200MB with coverage punch-out (one txn). Guardrails: lazy open, 2s timeouts (timeout = miss),
  3-failure circuit breaker, per-session write serialization, clear-vs-inflight generation guard.
- Sparse state: `state.messages` stays **DENSE** (the loaded window — the first attempt with null
  holes crashed UI listeners and was user-reset); the window position lives in `state.sparse
  {fromSeq, messageCount, filledFrom}`; `editCommit` indices are translated `+filledFrom` at the
  single call site (grok #2: use filledFrom, not the frozen attach fromSeq).
- Backfill vs expand split: policy=fast warms **IDB only** (never the render — user complaint
  "loading all of chat at once"); the ⤒ button grows the render one server-clamped step per click,
  IDB-first, epoch-guarded (stale generation → invalidate via rewrittenFrom, refuse to splice),
  single-flight, session-pinned.
- Transfer policy: `navigator.connection` (saveData / 2g-3g / cellular → metered; wifi/ethernet/4g
  → fast) over the server's `netClass` fallback (peer/Host private-range classification — the
  user's `192.x` vs `xxxx.iptime.org` heuristic, demoted to second place).
- Display by user turn (sparse sessions only): render ONE turn (from its user message down);
  "⤒ Load earlier turns" reveals turn by turn — instant when in memory, a range fetch when not;
  anchored by message identity (indices shift on prepend). Small chats display fully.
- UI: IDB footprint badges on the session list ("IDB 1.2MB (7 chunks)"); 🧹 clear-beside-Kill in
  the alive dialog — safe during a live run (generation guard drops in-flight writes).
- Memory working set (shader-cache style): decompressed chunks kept in an LRU memory tier — reads
  skip gunzip on re-reads; page-lifetime, never persisted.

## 4. Review findings fixed (grok 01a16a54, all severities)

1. **CRITICAL** — /range 1MB clamp kept the LOW end → expand windows not adjacent to the loaded
   tail → silent seq gaps. Fixed: keep-the-high-end clamp; at least one message always returned.
2. **CRITICAL** — `withTimeout` counted successful puts as failures (null return) → circuit opened
   after 3 warms, cache write-only. Fixed: flag-based timeout; only timeouts/MISS trip it.
3. **CRITICAL** — editCommit translated with the frozen attach `fromSeq` → wrong turn after expand.
   Fixed: `filledFrom`, kept in lockstep with `fromSeq` on every prepend.
4. **HIGH** — getCachedChunks hole-check inverted → cache could never hit. Fixed (+ ghost-range
   guard: meta range must match its blob's toSeq).
5. **HIGH** — merged coverage ≠ chunk keys (merged range read only its first blob). Fixed: 1:1
   ranges; putChunk is a single readwrite txn; totalBytes adjusted on overwrite.
6. **HIGH** — rewrite identity never honored client-side. Fixed: fillWindow compares
   `X-Session-Mutate-Epoch` with the attach generation → invalidateSession (also fixed: resolves on
   tx complete, key-range cursor) + refuse to splice; `X-Rewritten-From` passed to putChunk.
7. **HIGH** — expand/warm races (double-click double-prepend; session switch mixing windows).
   Fixed: single-flight expand; sessionId pinned; sparse re-checked per step.
8. **COMPACT CHECK** (user ask "how it works with compaction") — the cache READ/WARM paths never
   verified the generation → pre-compaction content could render. Fixed: epoch check on all three
   paths (read/warm/network). Compaction preserves the prefix below its span start.
9. **LOW** — 204 handling (no splice, no filledFrom advance), expand button failure toast,
   single-txn LRU eviction, per-chunk bytes in meta (no LRU inflation), IPv6-ULA nit left open.

## 5. Tests

`tests/range.test.mjs` (13): range slice/clamp, edit@i keeps the prefix verbatim + rewrittenFrom
min-semantics, retry-drop point, metadata persistence + hydration (survives restart), restore fork
point, compact (first = 0). Suites after: range 13, compact 19, retry 50, versions 30, zombie 11,
security 64, store 7, runtime 6, typecheck + build. Live: range tail 909–977 (166KB gz), full GET
1.92MB gzip, expand window user-turn aligned (487–700, first role "user").

## 6. Known limitations / deferred

- Two tabs: last-writer-wins per chunk key; meta races self-heal on read. No BroadcastChannel sync.
- Stale generations DROP the whole cache conservatively when `rewrittenFrom = MAX` (no rewrite
  info); partial survival needs the server's `rewrittenFrom` on every response (present).
- IDB unavailable (private mode / disabled) → circuit opens → today's fetch-every-time behavior.
- No list virtualization: a fully-expanded 7.3MB session renders all nodes (the sparse display
  gate mitigates; full virtualization is a separate UI project).
- Deferred by measurement: brotli on ranges (chunking penalty), CBOR/MessagePack (<5-10% post-gzip),
  gzip-at-rest in IDB (adds 118ms decompress to the open path), zstd/fflate (v2 if quota binds).
- The mobile-decode numbers are desktop-derived; real-device check rides with PL-12.

---

# PR 2 — retry + mobile: the branch base (`c461dee`, `b8f1aca`, `916c0ef`, `7bdcd03`)

**Branch:** `feat/retry-mobile-transfer` · **Base:** `ea2dc63` (*retry: keep the toolcall + thinking when retrying a mid-round 429*)
**Covers:** `c461dee` pi-ai/pi-agent-core 1.4.0 + builtin model-catalog fallback · `b8f1aca` auto-retry UI (server-driven countdown + Cancel/Retry now) · `916c0ef` mobile long-press edit + Enter=newline · `7bdcd03` gitignore bench harness
**Diff:** 20 files, +707 / −131 (4 commits) · **Pushed:** only `c461dee`; the rest is local
**Design consult:** sonnet-5-high `01a169a9` (auto-retry pending UI + mobile input patterns)
**Review log:** shared footer (entries tagged **PR 2**)

> The transfer PR above takes `916c0ef` as its base — i.e. these four commits are the base it assumed
> without documenting. Same branch, same reviewers, so the record lives here rather than in a second file.

## 1. Problem — three user asks

1. "try to update pi related package to 1.4.0" — and, once upgraded, the model picker had to work for a
   user whose `models-store.json` is missing/empty.
2. The pending auto-retry was **invisible** (a `retryNote` that only flashed through `runtime.lastText`)
   and **uncancellable**; Settings could only toggle on/off with "3x / 3s" hardcoded in the label; and a
   `Retry-After` timer kept firing *after* the toggle was switched off.
3. "add multi line support for mobile if user uses long touch/click. It's inconvenient that i can't use
   return key" + "hide model name before `/` in mobile. change text `+files` into clip emoji" + a
   follow-up that the emoji was fixed-size and dark in BOTH themes.

## 2. Design (what shipped)

### 2.1 pi-ai + pi-agent-core 0.75.3 → 1.4.0, plus a builtin model catalog (`c461dee`)

- **npm could not reify at all** (`Cannot read properties of null (reading 'name')`): the lockfile still
  carried provider-stub LINK nodes (`link -> pi-ai/stubs/empty` for `@anthropic-ai/sdk`, `@aws-sdk/*`,
  `@google/genai`, `@mistralai/*`) from the 0.75.3-overrides era, and 1.4.0 no longer ships `stubs/`, so
  arborist resolved a null target. Fixed by regenerating `package-lock.json`; the six provider SDKs stay
  stubbed through **`build.mjs` aliases** (the `pr.md` CI work), not through npm overrides.
- **API migrations** (all mechanical): `AgentOptions.streamFn` is now REQUIRED → the hub, the `/compact`
  summary agent and the browser bootstrap pass the generic dispatcher from `@earendil-works/pi-ai/compat`
  (`streamSimple` routes on `model.api`; importing the compat subpath also auto-registers the builtin api
  providers); `getModel`/`streamSimple` moved to `compat` (`proxy-stream.ts`); `TextContent` stays a root
  type export; `tests/retry.test.mjs` imports the faux provider from `compat` (same registry).
  The mirror format is untouched — 1.4.0 kept the message shapes our toolResult repairs encode.
- **Model-catalog fallback**: 1.4.0 ships `providers/all` — 42 providers in exactly the `models-store.json`
  record shape (nvidia: 21 models with `baseUrl`/`api`/reasoning metadata), upstream-maintained, offline,
  key-free. Seeded in **two** places when the store is missing/empty: `/api/pi/config` — which now reports
  `modelSource: "models-store" | "builtin-catalog" | "none"` — and the hub's `modelsStore` (otherwise the
  picker would list models `_getModel` refuses to run). **Store entries always win** (custom ids/baseUrls
  the catalog lacks). Rejected: REST `GET {baseUrl}/v1/models` (needs a key + network, bare ids without
  metadata) and a checked-in `backup-model-store.json` (static, goes stale, duplicates upstream).
  Verified live: `PI_DIR` at an empty dir → `builtin-catalog`, 41 providers; real `.pi` → `models-store`,
  3 providers, nvidia 21.

### 2.2 Auto-retry: server-driven countdown + Cancel / Retry now (`b8f1aca`)

- `runtime.retry` on the runtime frame: `{state:"scheduled", attempt, attempts, retryAt, delayMs, epoch}`
  while pending, `{state:"given-up", note}` after the cap. **Presence is the signal** — every attached
  device renders the same server-driven state and ticks the countdown locally from `retryAt` (no extra
  pushes, no client-side drift between devices).
- New WS op `cancel-retry` → `cancelPendingRetry(sessionId)`: cancels THIS pending retry only — auto-retry
  stays enabled and the failed turn stays a plain error.
- **A1** — `setAutoRetry({enabled:false})` now cancels every session's already-scheduled timer and clears
  the notes (previously a 30s `Retry-After` timer still fired after disabling). **A2** — the timer callback
  re-checks `enabled`/`discarded`/`compacting`/epoch **at fire time**, so a superseded or guarded timer
  burns no attempt; the attempt counter commits **synchronously at dispatch** (committing in `.then()`
  lagged the next failure's `agent_end` and the cap over-ran — caught by the cap test).
- Client: `RetryCountdown` inside the error chrome ("Retrying in Ns — attempt n/N" + progress bar + Cancel
  + Retry now; give-up shows the note + a plain Retry), 44px targets, stacked full-width below `48rem`.
  Settings gains **Attempts (0–10)** and **Delay (1–60s)** inputs (disabled while off), persisted as
  `pi.autoRetryAttempts` / `pi.autoRetryDelayMs`; `set-auto-retry` pushes the full config.

### 2.3 Mobile: long-press edit + Enter=newline (`916c0ef`)

- **Long-press edit** is gated on `pointerType` (touch/pen only — a desktop mouse long-click never edits,
  so it cannot fight drag-select): 480ms hold, 10px move-slop cancels on scroll (no `preventDefault` on
  down/move — native scrolling stays intact), a **fire-time selection check** (a hold that ended in a
  selection never yanks the bubble into edit), `navigator.vibrate(12)` haptic (guarded, no-op on iOS),
  `contextmenu` suppressed on mutable bubbles, `-webkit-touch-callout` off so iOS does not show its own
  menu, pressed visual state (scale .98 + dim). ✎ remains the explicit control and is now always visible
  with 44px targets on coarse pointers (it used to be hover-hidden). Timer cleanup is unmount-safe.
- **Composer Enter** became a tri-state, per-device pref `pi.enterSends`: `auto` (default) | `always` |
  `never`. In `auto`: fine pointer → Enter sends **bit-for-bit as before**; coarse pointer → Enter inserts a
  newline and the always-visible Send button submits. Ctrl/Cmd+Enter always sends; desktop Shift/Alt+Enter
  still newline; `enterkeyhint` relabels the soft key to match actual behaviour; recomputed per render, so a
  settings change applies on the next keystroke. The desktop Enter-**steer** path is unchanged (mobile
  steers with one tap on Send).
- Tweaks: **ModelPill** hides the `provider/` prefix below 48rem (tooltip + picker keep the full id); the
  `+ files` text becomes an **SVG paperclip** (feather path, `stroke=currentColor`) after the emoji turned
  out fixed-size and dark in both themes.

### 2.4 gitignore (`7bdcd03`)

`public/tmp-bench/` + the decompression-bench harness HTML are ignored — the measurement artifacts behind
the transfer PR's §2 table stay out of the tree.

## 3. Tests (re-verified at `6dfee3e`, this branch)

| suite | result |
|---|---|
| `test:retry` | **50** (was 40 — runtime exposure, `cancelPendingRetry`, cancel-keeps-auto-retry, disable-cancels-pending A1, compacting fire-time guard + intact budget A2) |
| `test:security` | 64 |
| `test:versions` | 30 |
| `test:zombie` | 11 |
| `test:range` | 13 |
| `test:compact` | 19 |
| `test:fork` | 23 |
| store 7 · runtime 6 · ssrf 5 · shutdown 9 · edit-tool 7 | green |

`typecheck` + `build` clean.

## 4. Known limitations / deferred

- The builtin catalog is a **snapshot** of upstream's `providers/all`: correct at upgrade time, stale by
  design. Store entries win, and `modelSource` is reported so the UI can say where the list came from.
- REST model discovery stays deferred until a key+network path is genuinely needed.
- Input and retry prefs are per-device localStorage, deliberately not synced (a phone and a desktop want
  different Enter behaviour).
- Long-press edit is touch/pen only; pen-drag selection is not a second gesture (pen long-press is edit).

## Review log

- **2026-10-24 — grok-4.6-high (design, 01a169e1):** approved the layered structure; key course
  corrections: IDB as a disposable cache (not "localStorage but bigger"), tail as a seq-addressed
  dense window (not a sliced view), wire gzip first / gzip-at-rest deferred, CBOR rejected.
  Response: adopted in full.
- **2026-10-24 — sonnet-5-search (codec survey, 01a169e8):** native CompressionStream is the v1
  baseline; lz4-wasm solves a non-problem (ratio worse); fzstd/fflate = v2 options; brotli stays
  wire-only. Response: adopted; no browser compression dependency added.
- **2026-10-24 — sonnet-5-high (UI design, 01a169a9):** auto-retry pending UI + (this track) the
  expand banner inside the chat flow; coarse-pointer/mobile patterns. Response: adopted.
- **2026-10-24 — grok-4.6-high (implementation review, 01a16a54):** 3 critical + 4 high findings —
  ALL FIXED in `e4ac970` (see §4). Residual: IPv6-ULA netClass nit (open, low).
- **2026-10-24 — user live test:** "loading all of chat at once" (backfill touched the render) →
  warming is IDB-only; "512KB too short" → 1MB tail; "button not responding" → unit-mismatch fixed;
  "display by user turn" → view gate + turn-aligned ranges; "how it works with compaction" →
  COMPACT CHECK + prefix survival. All addressed in `4e079e4`..`03becb7`.
- **2026-10-24 — author re-verification (PR 2):** at `6dfee3e` — retry 50, security 64, versions 30, zombie 11, range 13, compact 19, fork 23, store 7, runtime 6, ssrf 5, shutdown 9, edit-tool 7, typecheck + build green. The A1/A2 auto-retry regressions were caught by the internal cap test while writing this record (not by review) and folded into `b8f1aca`.
