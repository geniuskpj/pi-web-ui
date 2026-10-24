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
- `src/idb-cache.ts`: chunk-granular IDB cache — **schema v2 (2026-10-24, C1)**: per-chunk gzip blobs
  keyed `[sessionId, rewriteSeq, fromSeq]` (1:1 with coverage ranges — no merging, grok #5) + a tiny meta
  record PER GENERATION (coverage = sorted disjoint ranges, `updatedAt` for the GC). Miss-set = interval
  diff from ONE small meta get. LRU 200MB with coverage punch-out (one txn; superseded generations are
  evicted first).
  **v2 = generations instead of erasure** (design update grok `01a16c29`; user asks "chunk should be
  updated automatically without request", "local cache don't need to be erased immediately … after
  checking integrity (date, reload)", "only for cache"): a rewrite bumps `rewriteSeq`, the new
  generation gets its own meta and chunk keys, so the old one is simply **unreachable** — the
  `invalidateSession()` wipe is gone (the epoch-mismatch path now just refuses to splice and lets
  `sweepStale()` collect it). `sweepStale()` = date GC: superseded generations go after a 5-minute grace,
  anything (current generation included) after a 30-day hard TTL; triggers are attach (a newer generation
  proves the old is stale) and tab focus. Integrity is checked on READ: `verifyChunkText()` (every line is
  JSON + line count == the claimed window) and a failing chunk is dropped with its coverage punched
  (`dropChunk`) so the next read refetches instead of rendering corrupt bytes. Overlapping windows
  (a turn-aligned fetched range meeting an aligned live chunk) REPLACE the older range via
  `mergeRanges()` — ranges stay disjoint and 1:1 with keys, the replaced chunk is deleted in the same txn.
  A write for an OLDER generation than one already seen is dropped, so a stale in-flight fetch cannot
  resurrect a collected generation. Guardrails unchanged: lazy open, 2s timeouts (timeout = miss),
  3-failure circuit breaker, per-session write serialization, clear-vs-inflight generation guard.
- Sparse state: `state.messages` stays **DENSE** (the loaded window — the first attempt with null
  holes crashed UI listeners and was user-reset); the window position lives in `state.sparse
  {fromSeq, messageCount, filledFrom}`; `editCommit` indices are translated `+filledFrom` at the
  single call site (grok #2: use filledFrom, not the frozen attach fromSeq).
- **Live write-through (C2, 2026-10-24)**: the tail the user is READING is the section every open
  re-downloads (measured 166KB gz for the 1MB window), so it is now written into IDB as the conversation
  grows — no request involved. The attach window seeds the buffer, every `message_end` appends to it, and
  a chunk boundary is a pure function of the seq (`CHUNK_INTERVAL = 64`, `planLiveChunk`): a complete
  ALIGNED window is written once (final), the trailing remnant is the open tail written under its own
  `fromSeq` and rewritten in place as it grows. Flush triggers: boundary completed, `agent_end`, a 5s
  idle debounce, tab hidden, `pagehide`. Compression is client-side `CompressionStream` on the SAME
  framing `/range` serves (NDJSON, no trailing newline), and every write passes the reader's own
  integrity check before it is stored. Cost: zero gzip/IDB work for a normal turn; one gzip (<64 messages)
  when a window closes. Nothing here touches the render — the sparse window, `filledFrom` and the display
  gate are unchanged.
- Backfill vs expand split: policy=fast warms **IDB only** (never the render — user complaint
  "loading all of chat at once"); the ⤒ button grows the render one server-clamped step per click,
  IDB-first, epoch-guarded (stale generation → refuse to splice; nothing is erased in v2 — the old
  generation is unreachable by key and the GC collects it), single-flight, session-pinned.
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
- A rewrite starts an EMPTY generation: the unchanged prefix below the rewrite span is re-warmed by the
  backfill loop instead of being carried over. Prefix survival (the server's `X-Rewritten-From` hint) is
  deliberately deferred — it needs the surviving chunks copied into the new generation, and a rewrite is
  rare next to the cost of getting identity wrong.
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
- **2026-10-24 — review (C2 implemented, author):** live write-through landed (design from grok
  `01a16c29` Q1–Q3, with one deviation: grok listed a 64KB byte threshold among the flush triggers, but a
  byte-triggered close would move a boundary away from the aligned window and leave the stored key
  disagreeing with what a later fetch asks for — boundaries stay purely seq-aligned, bytes only influence
  the idle flush). The attach window itself is now seeded into the buffer (grok's table treated it as a
  source but it was never written), which is what makes reopening an untouched session cheap: the window
  the next attach loads is already covered, so the warm loop's hole set for it is empty. Multi-tab stays
  last-writer-wins per key — correct because a closed window is the same NDJSON (semantically identical,
  NOT byte-identical: two browsers' gzip may differ), and the on-read integrity check catches anything
  malformed. `tests/idb-cache.test.mjs` grew to 46 checks (boundary math, `planLiveChunk` incl. the
  partial head at a turn-aligned start, NDJSON framing equality with the server, source assertions that
  message_end/agent_end/hidden/pagehide feed and flush the buffer under the attach generation).
  Next — C3: measure the win on a real long session (cold-open bytes wifi vs cellular, gzip ms per close,
  IDB txns/s); C4 (optional): align `/range` windows to the same boundaries server-side, which removes the
  seam overlap entirely.
- **2026-10-24 — review (C1 implemented, author):** the four user requirements landed in the cache only
  (`feat/idb-live-cache`): (1) generation-keyed chunks + `sweepStale()` + the `invalidateSession` wipe
  deleted — "don't erase immediately" is now structural, not a promise; (2) `verifyChunkText` on read and
  a dropped chunk refetches, so a corrupt/short blob can never render; (3) `mergeRanges` gives the
  overlapping-seam case explicit semantics (new window replaces the old range, replaced chunk deleted in
  the same txn) — this closes the open item from the 2026-10-24 growing-session review; (4) render path
  untouched (`filledFrom`/`messageCount`/`getCachedChunks` hole logic unchanged; reads simply miss for an
  unknown generation). `tests/idb-cache.test.mjs` (27 checks) pins keys, coverage math incl. the seam,
  sweep selection (grace period, hard TTL, current generation protected) and the integrity checker —
  plus source assertions that the wipe is gone and the v2 keys are what ships. Deferred to C2: automatic
  live write-through (aligned 64-message chunks + a rewritten-in-place partial tail, flush on boundary /
  `agent_end` / tab-hide) and the server-side alignment of `/range` windows to those boundaries.
- **2026-10-24 — user live test:** "loading all of chat at once" (backfill touched the render) →
  warming is IDB-only; "512KB too short" → 1MB tail; "button not responding" → unit-mismatch fixed;
  "display by user turn" → view gate + turn-aligned ranges; "how it works with compaction" →
  COMPACT CHECK + prefix survival. All addressed in `4e079e4`..`03becb7`.
- **2026-10-24 — author re-verification (PR 2):** at `6dfee3e` — retry 50, security 64, versions 30, zombie 11, range 13, compact 19, fork 23, store 7, runtime 6, ssrf 5, shutdown 9, edit-tool 7, typecheck + build green. The A1/A2 auto-retry regressions were caught by the internal cap test while writing this record (not by review) and folded into `b8f1aca`.
- **2026-10-24 — review (IDB cache vs a GROWING session; user question):** *"idb+compression works with a long
  session. It fetched a chunk at first. Assume the user chats until there is another chunk — is the new chunk
  appended automatically?"* — **No, and that is the design.** Only two code paths ever write chunks
  (`src/proxy-agent.ts:417` = the warm loop started by the sparse attach frame, `:478` = the expand/cache-miss
  fill) and both are fed by `GET …/range`; the attach snapshot itself and the live `agent-event` stream never
  touch IDB. Growth is also invisible to the cache *by construction*: chunks are seq-addressed and the seq space
  is APPEND-ONLY, so a warmed `[a,b)` stays valid indefinitely — only a rewrite bumps `rewriteSeq` /
  `rewrittenFrom` (✎ edit · 🕘 restore · retry tail-drop · compact) and invalidates. The cached `messageCount`
  does go stale as the session grows and is deliberately **not** a validity key (badge/telemetry only).
  Expected sequence across a chunk boundary: session ≈3MB → open renders the last ~1MB (seqs ~700–900) and the
  warm loop caches `[0,700)` in ~1MB chunks → the user chats; messages 901+ arrive live and only the RENDER
  grows (IDB untouched, `filledFrom` unchanged) → on the next open the server picks a NEW tail window
  (turn-aligned, keep-high clamp), the warm loop finds `[0,700)` already covered (no re-download) and fetches
  only the new hole `(700,780)` once, storing it as its own chunk under the server's returned
  `X-Range-From/To-Seq`. Net effect: **the cache grows lazily, one chunk per open/expand, never from live
  traffic.**
  - **Note — accepted trade-off with a real cost: the LIVE TAIL is never cached**, so every reload re-downloads
    ~1MB (≈170–270KB gzip; the measured 909–977 tail was 166KB gz). That is the most frequent network event on
    mobile. Cheap follow-up *if it ever matters*: write the attach tail through to IDB (server sends the tail as
    gzip, or the client re-serializes + gzips ≈30ms/1MB) validated by `rewriteSeq`. Not done on purpose —
    freshness won.
  - **Open — overlapping coverage needs a test before it needs a fix.** A warmed hole is `[700,780)`, while the
    next attach tail may begin INSIDE an already-cached chunk (the start is server-chosen alignment). `putChunk`'s
    coverage update (`keep` + sorted disjoint ranges, `idb-cache.ts` ~202–207) has no explicit overlap case:
    verify it splits rather than persisting two overlapping/adjacent ranges, and that `getCachedChunks` can never
    yield the same message twice after a prepend. Suggested: a case in `tests/range.test.mjs` (or a new
    `tests/idb-coverage.test.mjs`) — "overlapping put → coverage stays disjoint, messages deduplicated".
  - **Confirmed correct by reading it:** `intervalDiff(0, filledFrom, covered)` with oldest-hole-first warming
    means warm history is never re-fetched; a metered link skips warming entirely (policy gate at :395–397);
    a stale epoch drops the cache and refuses to splice (`fillWindow`, grok #6).
  - **Consequence for expectations (not a bug, worth stating in the PR):** a session the user chats in for hours
    writes NOTHING to IDB, so the session-list badge ("IDB x MB (n chunks)") describes cold history, not the
    current size. If the goal ever becomes "reopen instantly on mobile without the tail download", the fix is
    the tail write-through above, not more chunking.
- **2026-10-24 — live verification (author, isolated scratch instance on :8799):** C1 + C2 exercised
  end-to-end on a REAL 9.6MB / 1056-message session (`60dfc94f`, rewriteSeq 1) copied into a scratch data
  dir, opened in a separate origin so the user's live server, sessions and tabs were untouched. Peak
  numbers first: **a warm reload transferred 0 HTTP bytes for the session body** (the cold load had been
  6 `/range` requests ≈ 2.25MB).
  - **Cold load** — sparse attach window `[924,1056)` (132 msgs, `messageCount 1056`, gen 1) while the warm
    loop filled `[0,924)` in six server windows. The C2 seed then wrote **three chunks**: the partial head
    `[924,960)` — closed at the alignment boundary, NOT after 64 messages — the aligned window
    `[960,1024)`, and the open tail `[1024,1056)` written by the **idle flush 4s later** (storedAt ages
    88s/88s/84s = drain-then-debounce, exactly as designed). Coverage ended disjoint:
    `[[0,107],[107,311],[311,622],[622,766],[766,843],[843,924],[924,960],[960,1024],[1024,1056]]`.
  - **Schema** — `pi-session-cache` **v2** on a fresh origin: meta keyed `[sessionId, rewriteSeq]` with
    `updatedAt`, chunks keyed `[sessionId, 1, fromSeq]` (keys read back as
    `60dfc94f-…:1:1024` etc.). Generation isolation verified by construction (only gen 1 existed).
  - **Content equality (grok Q3, now measured not assumed)** — the live-written `[1024,1056)` chunk
    gunzipped to EXACTLY the server's `/range?fromSeq=1024&toSeq=1056` body: 32 lines, every line JSON,
    identical roles and content (`contentIdentical: true`). A live chunk and a fetched chunk really are
    interchangeable.
  - **Warm reload** — 0 HTTP session requests, 0 KB, same 9 chunks, and the seed rewrote its three windows
    (same keys, fresh `storedAt`); the sparse expand control is still rendered, i.e. the display path is
    unchanged.
  - **Instrumentation caveat (worth a test, not a bug report):** two heavy `getAll()` probes I ran from the
    debugger appeared to starve the page's own IDB ops (the module times every op out at 2s and trips a
    3-failure circuit breaker that lasts until the next page load) — one tab stopped writing while a
    pristine tab wrote normally. Follow-up worth considering: let `degraded` recover after a backoff, or
    exempt live write-through from the breaker, so a slow disk / a second tab cannot silently switch the
    cache off for the rest of the session.
  - Note for the user's own browser: the v1 → v2 upgrade discards the existing v1 chunks (~13MB observed)
    on the first load of the new bundle — by design (the cache is disposable); the warm loop refills it.
