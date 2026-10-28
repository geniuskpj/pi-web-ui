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
  previous user turn"). Body: raw `application/gzip` NDJSON (write-through into IDB). (C4) Both ends
  are then snapped to the **CHUNK_INTERVAL** (64-message) boundary, so a fetched window and a
  live-written chunk describe the same key.
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
   single-txn LRU eviction, per-chunk bytes in meta (no LRU inflation) — all verified in code;
   the IPv6-ULA `netClass` nit was **FIXED 2026-10-24** (`lib/net-class.mjs`, see the audit entry).

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
- IDB unavailable (private mode / disabled) → circuit opens → fetch-every-time behavior. The
  breaker now EXPIRES after 30s (and a success closes it early) instead of lasting the page load —
  a transient stall (slow disk, heavy work in another tab) costs one 30s window, not the session.
- No list virtualization: a fully-expanded 7.3MB session renders all nodes (the sparse display
  gate mitigates; full virtualization is a separate UI project).
- Deferred by measurement: brotli on ranges (chunking penalty), CBOR/MessagePack (<5-10% post-gzip),
  gzip-at-rest in IDB (adds 118ms decompress to the open path), zstd/fflate (v2 if quota binds).
- The mobile-decode numbers are desktop-derived; real-device check rides with PL-12.


## 7. C3 measurements (live, 2026-10-24)

All numbers from a **real 9.6MB / 1056-message session** (`60dfc94f`, gen 1) on isolated scratch
instances (fresh origins, scratch data dirs), measured from the page (`performance` resource entries +
IndexedDB reads) rather than estimated. Grok's accept/reject thresholds (design update `01a16c29` Q7)
are quoted where they apply.

| metric | measured | threshold | verdict |
|---|---|---|---|
| cold open, session body over HTTP (empty IDB) | **6 `/range` requests ≈ 2193 KB** (305/396/507/533/335/117 KB) — reproduced at 2250 KB on a second instance | — | baseline |
| **warm reopen (cache present)** | **0 requests, 0 KB** | wire bytes ↓ >80% | **pass (100%)** |
| IDB bytes written vs session body | 2.62 MB vs 9.59 MB raw = **27%** (vs ~1.92 MB gzipped full body = 1.36×) | reject at >1.5× raw | **pass (both framings)** |
| IDB transactions | 9 readwrite txns for a cold load (1 per chunk), ≈0.3/s during the load, **0/s idle** | <1/s | **pass** |
| framing cost per closed window (main thread: `toNdjson` over the window's objects) | **4.9–7.9 ms** for 242–523 KB windows | — | at a boundary/idle, never mid-stream |
| gzip cost per closed window (native `CompressionStream`) | **4.1–15.1 ms** wall for 242–523 KB, ratio 16–31% | "<3 ms per close" | **threshold unrealistic** — see note |

Notes:

- **The gzip threshold needs restating.** 64 messages is ~240–520 KB on these sessions; no compressor
  gzips half a megabyte in 3 ms (that would be ~170 MB/s). The real costs are ~5–8 ms of main-thread
  framing and 4–15 ms of off-thread `CompressionStream` work per *closed* window — i.e. once per 64
  messages or at idle/run-end/tab-hide, never during streaming. Suggest replacing grok's threshold with
  "main-thread framing <10 ms and gzip off the critical path", which is what is measured here.
- **What the warm 0 KB does and does not cover.** The attach snapshot still carries the tail (~1 MB → ~276 KB
  deflated for this session) over the WebSocket, because `/range` history is what the cache serves; the
  measured *HTTP* session traffic is what drops to zero. Removing the tail re-transfer is exactly what C4
  (server-side alignment / a "tail already cached" hint in the attach) would buy.
- **Transfer policy** (the gate that decides whether a cold open warms the whole history): unit-tested in
  `tests/idb-cache.test.mjs` T1–T7 — `saveData` ⇒ metered, 2g/3g ⇒ metered, `type: cellular` ⇒ metered,
  wifi/4g ⇒ fast, and with no Network Information API the server's `netClass` decides (`lan` ⇒ fast, else
  metered). A metered link therefore skips warming entirely and pays only the tail.
- **Two defects found while measuring — BOTH NOW FIXED (see the log entry below):**
  1. **A fresh origin cannot open an existing session.** Opening `?session=<existing big id>` in a
     browser profile with no local state for that session rendered an EMPTY chat and made **zero**
     network requests for the body (observed twice, on two fresh origins, with the bundle that otherwise
     works). The stored transcript is not touched (the mirror stayed byte-identical), so this is a
     load-path gap on new devices/incognito — precisely the case the IDB cache exists for.
  2. **A hub entry created before hydration is never re-hydrated.** `agent-hub.mjs` `_ensureEntry()` opened
     with `if (entry && entry.agent.state.messages.length > 0) return entry;` — and a freshly created
     entry already holds one message (the materialized system prompt). So an attach that lands before the
     body load left that session EMPTY for the life of the process (reproduced: attach reported
     `messages: 1, sparse: null`; after a hub restart the same instance reported `messages: 132,
     sparse: [924,1056]`). **Fixed** — see the log entry: `entry.hydrated`, a hydrating `attach()`, and
     a store miss that no longer looks like a fresh session.

## 8. C4 — aligned windows + don't re-send the tail (2026-10-24)

The last item from the audit below. Two halves, both measured end-to-end on a scratch instance with the
real 9.6MB / 1056-message session (`data/tmp/c4-probe.mjs`).

**A. One boundary definition, aligned windows.** The chunk boundary lives in **`lib/chunk-window.mjs`**
(`CHUNK_INTERVAL = 64`, `chunkIndexOf/FromSeq/ToSeq`, `isChunkAligned`, `alignDown/alignUp`);
`src/idb-cache.ts` re-exports it (client API unchanged) and `server.mjs` + `agent-hub.mjs` import it
directly, so the two sides cannot drift. `/range` snaps the LOW end DOWN (after the user-turn pass, so a
turn is never cut) and the HIGH end UP (capped at the session end); the attach tail snaps DOWN too — but
never to 0, which would turn a huge-message tail into a full attach. A fetched window and a live-written
chunk now describe the SAME key: the seam is gone and a warm cache can serve a later attach.
Measured (pre-fix numbers, kept as measured): `[300,700)` → **`[576,704)`**, `[1000,…)` →
**`[960,1056)`**, `tailBytes=1MB` → **`[896,1056)`** — all aligned, all still adjacent to the loaded
tail. The 2026-10-25 review found the bounds bugs *inside this table* (a start of 960 for a request at
1000; an end of 704 for a request ending at 700); §9 states which rows the fix changes and why these
numbers looked right when they were taken.

**B. `haveTo` — the client says what it already has.** The attach carries `haveTo` (the end of this
device's cached coverage, read from the IDB meta). The hub trims the low end to `alignDown(claim)` — a
sub-chunk claim snaps DOWN, so the server never forces a client to fetch a partial chunk it cannot use —
and a claim that **reaches the session end sends nothing at all**. The envelope gains `sentFrom`; the
client treats `sentFrom` as the start of its dense window (`filledFrom`) and fills `[fromSeq, sentFrom)`
from IDB via `fillWindow`, which falls back to `/range` on a miss — so a stale or wrong claim costs one
fetch, never a wrong window. A return visit with new turns pays only for the new turns plus at most one
partial chunk.
Measured (WS state frame for the 1MB tail): `haveTo=0` → **160 msgs / 1,489,906 bytes**; a claim below
the window start → unchanged; `haveTo=count` → **0 msgs / 0 bytes (100% off)**.

The render path is untouched: dense window, `filledFrom`, the turn-gated display and the edit-index
translation keep their semantics — the cache only supplies the prefix.

## 9. REVIEW 2026-10-25 — every finding dispositioned

Two external reviews of this branch (32 commits) plus one user report. **Every code
finding was reproduced against the code before anything changed**; two claims did not
survive that step and are recorded as such. The theme of the pass: the C4 seam and the
cache tiers are where a wrong *bound* or a missing *key component* turns into silently
wrong content — and my own suites could not see it, because (below) **none of them ran
in CI**.

| # | Finding (source) | Verdict | Fix |
|---|---|---|---|
| 1 | `/range` snapped the low end BELOW the requested `fromSeq` → negative `slice()` (JS counts from the array END) → body ≠ `X-Range-From/To-Seq`, client splices at wrong seqs, ~400 msgs/expand unreachable (reviewer1 #1 / reviewer2 #1, both P1) | **CONFIRMED** | `lib/range-window.mjs`: `start = max(alignedStart, fromSeq)` — see the note below on why §8's measurements could not have caught it |
| 2 | Memory tier keyed `(session, fromSeq)` without the generation → post-rewrite read renders pre-rewrite content (reviewer1 #2 / reviewer2 #3, P1) | **CONFIRMED** | `memKey(sessionId, rewriteSeq, fromSeq)`; `dropChunk` punches the mem entry; `clearSession`'s prefix wipe unchanged |
| 3 | High end `alignUp` could exceed the requested `toSeq` → chunk claims more lines than it holds → dropped by `verifyChunkText` on EVERY read (reviewer1 #3) | **CONFIRMED** | `end = min(alignedEnd, messageCount, toSeq)` |
| 4 | Display gate was an array INDEX captured at attach; a prefix fill moves it, and a fully-warm reopen (empty window) resolved to 0 → the whole window rendered (reviewer1 #4) | **CONFIRMED** | `lib/display-gate.mjs` + seq-space gate + `resolveGateSeq` re-anchor (`tests/display-gate.test.mjs`) |
| 5 | Fetched windows were stored/spliced without `verifyChunkText` (live writes were checked) (reviewer1 #5) | **VALID (hardening)** | gunzip → verify → `putChunk` → splice; a bad body is a logged miss |
| 6 | `sweepStale` cleared `currentGen` for every target, incl. old generations of live sessions (reviewer1 #6) | **VALID** | forget only when the NEWEST collected generation is the remembered one |
| 7 | 204 carried a gzip body (RFC 9110) (reviewer1 #7) | **VALID** | 204 with no body, same headers; the client now bails on `re <= rs` |
| 8 | Full-GET gzip gate used `payload.length` (UTF-16 units) (reviewer1 #8) | **VALID** | `Buffer.byteLength(payload, "utf8")` |
| 9 | `coverageFor()`/`idbStats()` full-store `getAll()` per attach (reviewer1 #9) | **DEFERRED** | the meta store holds ONE record per generation, so `coverageFor` is already tiny; an index on the chunk store needs a schema v3 bump — not worth it for a single-user cache |
| 10 | Cached expansion appended WHOLE chunks (incl. above `to`) but recorded the REQUESTED `from` as `filledFrom` → indices shift under the splice, edits land on the wrong turn (reviewer2 #2, P1) | **CONFIRMED** | `lib/chunk-splice.mjs` (`planCachedSplice`): trim at `to`, adopt the lowest chunk start |
| 11 | `npm run test:versions` fails in CI (reviewer2 #4) | **CONFIRMED, different cause** | see below |
| 12 | "script.exe has gone and terminal with nano is not working in this branch" (user) | **NOT a regression — a real defect anyway** | see below |

**Why §8's measurements did not catch it — and which of them change:** the 9.6MB session averages
~9.1KB per message, so the 1MB keep-high clamp pushes the start far above the requested `fromSeq`
(a 400-message request clamps to ~110 messages). Where that clamp landed ABOVE the request, the
snap-down was a no-op and §8 still holds (`[300,700) → [576,704)`, tailBytes `→ [896,1056)`). But
where the requested `fromSeq` sat above the snapped boundary, the old code answered BELOW the
request — §8's own row measured `from=960` for a request at `fromSeq=1000`, so the defect was
sitting in the measurement table: that window now reads `[1000,1056)`. It took a reader who
trusted the arithmetic over my table to see it, which is the whole argument for section W (both
shapes, plus a 400-window sweep).

### 11 — versions: the failing check, and why nobody saw it

Reproduced: the check `intermediate tail still restorable (lossless)` failed **and the
suite still printed "30 check(s) passed"** — its `check()` counted only passes, and the
✗ goes to stderr, so every "green" read of it (mine included) was stdout-only. Root
cause is NOT the reviewer's dedupe story in the way it was told: the sidecar's
content-hash dedupe parks a byte-identical capture ONCE, so the test's second identical
edit **reuses vid 1** and the switch-away capture becomes vid 2 — the assertion
`versions.get(S, 2).messages.length === 4` therefore fails while the PRODUCT promise
(everything restorable) still holds, verified by dumping the store: vid 1 = the edit
tail, vid 2 = the grown tail, active transcript byte-identical to the original.
Fixed on the test side (assert losslessness + the dedupe, not a vid) **and** in the
summary (`32 passed, 0 failed`). The dedupe commit (`c3d166b`) exists only on this
branch, so this red test was this branch's to fix.

### 12 — the terminal: environment, not branch — RESOLVED by a second bridge kind

**Outcome (2026-10-25):** `script.exe` stays unusable on this machine, but the dock has nano back —
through **Windows ConPTY** (`conhost.exe --headless`), which the hub now probes and prefers as a
second bridge kind. Verified end to end through the real hub + WS protocol: `tier=pty`,
`bridge="conhost --headless (ConPTY)"`, `IS_TTY=yes TERM=xterm-256color`, nano renders its UI, Ctrl-X
returns to the prompt. No download, no native module, no node-pty.

The environment root cause is now evidence-backed and is NOT a descriptor limit (a suggested
`ulimit -n` fix was tested and ruled out: the soft limit is already the hard max, 3200, and raising
it changes nothing — `/dev/ptmx` fails from a fresh process with three open fds):

| Signal | Value |
|---|---|
| Kernel `Events` objects | **16,813,072** |
| `conhost.exe` processes | **144** (130 created 2026-10-20…23) |
| `bash.exe` processes | **133** (same days, one per console) |
| Uptime | **293 days** |

Those 130 pairs are shells whose owning server was killed hard (`taskkill /F` — which skips the
hub's shutdown reap): killing a server leaves its shells and consoles alive, and after ~130 of them
the kernel-object counters are in the tens of millions, which is the plausible reason new pty
allocations fail while long-lived ones keep working (the user's own terminal). Two consequences:
(1) a **restart** should restore the msys route (the fallback makes it unnecessary for nano);
(2) **the hub should reap orphaned shells at boot** — proposed, not yet implemented — so a leaked
console cannot accumulate again. Reaping the stale pairs *may* fix `/dev/ptmx` without a reboot;
that is the operator's call (they are not attached to any live server).

### 12a — the original report

`terminal-hub.mjs`, `src/ui/terminal.tsx` and the vendored bridge are **byte-identical
to main** on this branch, and `data/bin/script/script.exe` is byte-identical to a freshly
extracted copy of the sha256-pinned msys2 package (pin re-verified: MATCHES). It still
cannot allocate a pty here:

```
script: failed to create pseudo-terminal: No such file or directory
```

Git for Windows ships `msys-2.0.dll 3.6.7` (built 2026-04-21) and `/dev/ptmx` is
equally broken for a plain `bash -lc 'exec 3<>/dev/ptmx'` ("Too many open files"), so no
msys pty can exist in this environment at all — the hub fell back to the pipe tier, where
nano/vim hit "standard input is not a terminal". **The product defect the report exposed
is real**: the bridge was validated as a FILE (PE header + size), never as a CAPABILITY,
so a bridge that cannot create a pty was adopted, died at once, and the tier silently
became `pipes` with nothing explaining it. Now:

- `bridgeProbe(exe, bashPath)` RUNS the candidate with the shell it will drive
  (`-e`/--return ⇒ bash must see isatty(stdin)=true) and caches the verdict + the
  bridge's own stderr;
- `pickBridge()` refuses a bridge that fails the probe; provisioning refuses to PUBLISH
  one ("pinned bridge cannot create a pty: …");
- the reason reaches the client as `state.bridgeNote` and is rendered as a dock warning
  ("⚠ no pty — nano/vim need one. …") with the status line saying `bash — pipes (no pty:
  nano/vim unavailable)`;
- `tests/term-pty.test.mjs` reports the capability and asserts the product behaviour
  (probe agrees with the raw observation, names the reason, is cached); `PI_REQUIRE_PTY=1`
  makes a working pty a hard requirement for CI on a known-good runner.

Environment remediation is documented (repair/reinstall Git for Windows; or
`PI_WEB_TERM_BRIDGE` → a script.exe built for that runtime). **The terminal dock stays on
the pipe tier on this machine until the Git runtime is repaired** — that is not something a
branch can fix, and it is now visible instead of silent.

### The process finding: the new suites were never in CI

`test:range`, `test:idb` and `test:hydration` were written for this branch and **never
wired into `.github/workflows/ci.yml`** (which ran store/runtime/ssrf/zombie/versions +
security only). Two reviewers found bounds bugs in covered-by-those-suites code within a
day — including one that a W/invariant sweep now catches in 400 random windows. CI now
runs range, idb, hydration, gate and pty.

### Verification after the pass

typecheck + build + **18/18 suites**: range **22**, idb-cache **76**, hub-hydration **19**,
display-gate **19**, retry 50, security-gates 69, store 7, runtime 6, ssrf 5, zombie 11,
versions **32** (was 30 + a hidden failure), compact 19, fork 23, shutdown 9, edit-tool 7,
fetch 9, term-pty **8**, term-smoke 12. Working-tree churn check clean
(`git diff --stat` == `git diff -w --stat`). The C4 measurements still hold
(`haveTo=count` → 0 bytes).

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

### 2026-10-24 — audit: EVERY review item checked against the code (author)

Asked to check every item in this file, not the handful I had grepped. Dispositions, with the invariant
each one rests on today:

| # | item (source) | status |
|---|---|---|
| 1 | /range clamp keeps the HIGH end (grok #1) | **in code** — `server.mjs` range handler + `range` suite (13) |
| 2 | `withTimeout` counts only timeouts/MISS as failures (grok #2) | **in code** — `MISS` sentinel + `timedOut` flag in `idb-cache.ts` |
| 3 | `editCommit` translates by `filledFrom` (grok #3) | **in code** — `chat.tsx` reads `sparse.filledFrom` |
| 4 | `getCachedChunks` hole-check + ghost-range guard (grok #4) | **in code** — `intervalDiff` + `rec.toSeq !== r.toSeq` bail |
| 5 | 1:1 ranges, single-txn put, byte accounting (grok #5) | **in code** — `mergeRanges` + one readwrite txn |
| 6 | rewrite identity honoured on read/warm/network (grok #6, COMPACT CHECK #8) | **in code** — `expectRewriteSeq` on read, epoch guard in `fillWindow`, generation-keyed writes (C1) |
| 7 | expand/warm races: single-flight, session pinned (grok #7) | **in code** — `backfillRunning`/`expandRunning` + `sessionIdAtStart` |
| 8 | 204 handling, expand toast, single-txn LRU, per-chunk bytes (grok #9) | **in code** — 204 returns without splicing, eviction is one txn, `bytes` per range |
| 9 | **IPv6-ULA `netClass` nit** (grok #9 residual) | **FIXED today** — was `host.split(":")[0]` with no IPv6 ranges (every IPv6 host, loopback included, reported "remote"); now `lib/net-class.mjs`, pure and unit-tested |
| 10 | **overlapping coverage untested** (growing-session review) | **FIXED today** — `mergeRanges` semantics + idb-cache **P8** (40 random overlap bursts) |
| 11 | **breaker never recovers** (live-verification caveat) | **FIXED today** — 30s expiry, success closes it, `breakerOpenAt` unit-tested |
| 12 | live tail never cached (growing-session review) | **FIXED earlier in C2** — attach tail seeded + live write-through; measured live: warm reopen 0 HTTP bytes |
| 13 | v1→v2 upgrade discards a browser's v1 cache | **by design** (disposable cache; the warm loop refills) |
| 14 | two tabs: last-writer-wins per key, metas self-heal | **by design** (closed windows are the same NDJSON; the on-read integrity check catches anything malformed) |
| 15 | a rewrite starts an EMPTY generation (prefix survival via `X-Rewritten-From`) | **deferred** (needs surviving chunks copied into the new generation; rewrites are rare) |
| 16 | no list virtualization for a fully expanded 7.3MB session | **deferred** (separate UI project; the sparse gate mitigates) |
| 17 | brotli on ranges / CBOR / gzip-at-rest / zstd | **deferred by measurement** (§2/§6) |
| 18 | mobile-decode numbers are desktop-derived | **open — needs a real device** (rides with PL-12; not closable from here) |
| 19 | C4: server-side `/range` alignment + "don't re-send a cached tail" | **DONE (`6fe0924`)** — see §8: aligned windows + `haveTo`; measured: the 1.49MB attach tail → **0 bytes** when the client has it |
| 20 | PR 2: auto-retry A1 (disable cancels timers) / A2 (fire-time re-check, synchronous attempt commit) | **fixed in `b8f1aca`**; PR 2's suites cover it |

Rebased onto the new main (auth merged) before this audit and re-verified there with the branch's own
deps (`npm ci`, pi-ai 1.4.0): `idb-cache` 58, `security-gates` 69, `retry` 50, `range` 13,
`hub-hydration` 12, `atomic-write` 26, `zombie` 11, `store` 7, `runtime` 6, `ssrf` 5, `versions` 30,
`compact` 19, `fork` 23, `shutdown` 9, `edit-tool` 7, `fetch` 9, `term-smoke` 12 + typecheck + build.

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
  - **FIXED (test added, audit entry) — overlapping coverage.** A warmed hole is `[700,780)`, while the
    next attach tail may begin INSIDE an already-cached chunk (the start is server-chosen alignment). `putChunk`'s
    coverage update (`keep` + sorted disjoint ranges, `idb-cache.ts` ~202–207) has no explicit overlap case:
    verify it splits rather than persisting two overlapping/adjacent ranges, and that `getCachedChunks` can never
    yield the same message twice after a prepend. Suggested: a case in `tests/range.test.mjs` (or a new
    `tests/idb-coverage.test.mjs`) — "overlapping put → coverage stays disjoint, messages deduplicated".
    **DONE:** `mergeRanges()` gives overlap explicit semantics (the new window replaces the older range and
    the replaced chunk is deleted in the same txn) and `tests/idb-cache.test.mjs` **P8** runs 40 random
    overlap bursts asserting the coverage stays pairwise disjoint, every range still has a blob behind it,
    and a read over the final coverage can never hand out the same message twice.
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
    pristine tab wrote normally. **FIXED (audit entry):** the breaker now carries an expiry —
    `degradedUntil = now + 30s` on the third failure and `0` again on any success — so a slow disk / a
    second tab cannot silently switch the cache off for the rest of the session.
  - Note for the user's own browser: the v1 → v2 upgrade discards the existing v1 chunks (~13MB observed)
    on the first load of the new bundle — by design (the cache is disposable); the warm loop refills it.
- **2026-10-24 — fix (hydration; the defect that faked a measurement, author):** `agent-hub.mjs` no
  longer uses `messages.length > 0` as a hydration proxy. `getSession()` marks `entry.hydrated` when the
  caller SUPPLIES messages; `_ensureEntry()` gates on that flag, fills an entry only when it holds no
  real (non-system) messages — a live transcript is never overwritten — and marks the entry hydrated when
  the store genuinely has nothing (a store *throw* still leaves it unmarked so a later call retries).
  `attach()` is now async and awaits hydration before building its snapshot (the WS call site awaits it),
  so the first frame can never be a pre-hydration empty state. `tests/hub-hydration.test.mjs` (12 checks,
  `npm run test:hydration`) pins the exact regressions: attach-before-hydration delivers the transcript,
  a pre-created empty entry gets filled, a live transcript survives `_ensureEntry`, a store miss does not
  cause a reload per attach, and a SPARSE attach on a pre-created entry carries the tail +
  `{fromSeq, messageCount}` envelope with the LAST messages. Finding #1 ("a fresh origin cannot open an
  existing session") turned out to be a CONSEQUENCE of this one — no client change was needed: on a new
  port with a pre-seeded 9.6MB session, the same attach-first scenario that used to render an empty chat
  now renders the session (4569 chars, session content visible) and fills the cache (6 chunks, 1.69MB).
- **2026-10-24 — measurements (C3, author):** cold/warm pair on the real 9.6MB session from a fresh origin: **cold = 6 /range requests ≈ 2193 KB, warm = 0 requests / 0 KB**, IDB written 2.62MB (27% of the raw body, 1.36x the gzipped body), 9 readwrite txns per load and 0/s idle, framing 4.9-7.9ms and gzip 4.1-15.1ms per closed 242-523KB window. Full table + threshold verdicts in §7. Two threshold corrections in the write-up: grok’s “<3ms gzip per close” is unreachable for a 64-message window (restated as main-thread framing <10ms, gzip off the critical path), and the warm 0 KB covers HTTP session traffic only — the tail still rides the WS attach (~276KB deflated), which is what C4 would address. §7 also records two defects found while measuring (fresh-origin ?session= never fetches the body; _ensureEntry’s length>0 guard leaves a pre-hydration entry empty for the process’s life) — both pre-existing, neither caused by this work, both recommended for a separate fix.
