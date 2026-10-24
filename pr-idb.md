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
