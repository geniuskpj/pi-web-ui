// idb-cache.ts — IndexedDB body cache for the tail-first session loader
// (transfer plan 2026-10-24, grok-reviewed structure).
//
// WHY: localStorage quota (~5MB, UTF-16) cannot hold 2-7.3MB session bodies —
// today every open of a big session re-downloads it. IDB stores Blobs natively
// (no base64, no UTF-16 tax, quota in the hundreds of MB).
//
// THE WEDGE LESSON (the reason LocalStorageBackend exists): IDB must never be
// source of truth and must never hang the UI. Guardrails baked in below:
//   - lazy open (boot/list render NEVER touch IDB — first body access does)
//   - every op raced against a 2s timeout; a timeout is a MISS, not an error
//   - circuit breaker: 3 consecutive failures → degraded until next page load
//   - writes serialized per session (queue length 1, latest wins) — no txn pileup
//   - versioned schema (v1), single db, no multi-store migrations
//   - server fallback always available: a cache miss is just a range GET
//
// SHAPE (v2, 2026-10-24): per-session COVERAGE (sorted disjoint [fromSeq,toSeq)
// windows) in a tiny meta record PER GENERATION + per-chunk gzip blobs keyed
// `[sessionId, rewriteSeq, fromSeq]`.
// The miss-set is computed from meta alone (one small get) — a fully-cached
// session never pulls blobs to answer "do I have the tail?".
//
// V2 = GENERATIONS INSTEAD OF ERASURE (design update, grok 01a16c29; user asks:
// "chunk should be updated automatically without request", "local cache don't
// need to be erased immediately — it could be deleted by some logic after
// checking integrity (date, reload)", "only for cache"): a rewrite bumps
// rewriteSeq; the new generation has its own meta and its own chunk keys, so the
// old one is simply UNREACHABLE — there is no invalidate-and-wipe step any more.
// sweepStale() then collects superseded generations after an idle window and
// anything older than a hard TTL (date-based GC), and a chunk that fails the
// integrity check on read is dropped (coverage punched) instead of rendered.

const DB_NAME = "pi-session-cache";
const DB_VERSION = 2; // v2: compound keys carry rewriteSeq (old DB is abandoned, not migrated)
const SWEEP_MAX_AGE_MS = 5 * 60 * 1000; // superseded generation: grace period before GC
const SWEEP_HARD_TTL_MS = 30 * 24 * 60 * 60 * 1000; // anything idle this long goes, current gen included
const META_STORE = "meta";
const CHUNK_STORE = "chunks";
const OP_TIMEOUT_MS = 2000;
const CIRCUIT_THRESHOLD = 3;
const MAX_CACHE_BYTES = 200 * 1024 * 1024; // LRU cap (gzip blob bytes)

export interface IdbChunk {
	sessionId: string;
	fromSeq: number;
	toSeq: number; // exclusive
	rewriteSeq: number;
	blob: Blob; // raw gzip of the JSONL lines for [fromSeq, toSeq)
	bytes: number;
	storedAt: number;
}

export interface IdbMeta {
	sessionId: string;
	rewriteSeq: number;
	messageCount: number;
	updatedAt?: number; // last write (age-based GC; metas without it fall back to chunk storedAt)
	ranges: Array<{ fromSeq: number; toSeq: number; bytes?: number }>; // sorted, disjoint; bytes per chunk (LRU)
	totalBytes: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;
let degraded = false;
let failureStreak = 0;
// Highest generation seen per session (in memory): a write for an OLDER
// generation is pointless (unreachable by design) and is dropped, so a stale
// in-flight fetch can't resurrect a swept generation.
const currentGen = new Map<string, number>();
const sweepRunning = new Set<string>(); // one sweep per session at a time
const writeQueues = new Map<string, Promise<unknown>>();
// CLEAR-vs-INFLIGHT GUARD (user request: "click clear while chat is in progress"):
// clearSession bumps the generation; queued writes capture it at call time and
// skip their txn if it moved — a clear can never be resurrected by an older write.
const clearGen = new Map<string, number>();
// MEMORY WORKING SET (shader-cache style, user request): decompressed chunks the
// page already paid gunzip for — reads skip DecompressionStream entirely. Bounded
// (LRU), page-lifetime only (never persisted — localStorage would re-hit the 5MB
// quota this whole design exists to escape).
const memTier = new Map<string, { messages: any[]; at: number }>();
const MEM_TIER_MAX = 24;
const memKey = (sessionId: string, fromSeq: number) => `${sessionId}:${fromSeq}`;
function memPut(sessionId: string, fromSeq: number, messages: any[]) {
	memTier.set(memKey(sessionId, fromSeq), { messages, at: Date.now() });
	if (memTier.size > MEM_TIER_MAX) {
		const oldest = [...memTier.entries()].sort((a, b) => a[1].at - b[1].at)[0];
		if (oldest) memTier.delete(oldest[0]);
	}
}

function withTimeout<T>(op: (db: IDBDatabase) => Promise<T>): Promise<T | null> {
	if (degraded || !("indexedDB" in window)) return Promise.resolve(null);
	const MISS = Symbol("miss"); // sentinel: op itself failed/threw — distinct from a null RESULT
	dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, DB_VERSION);
		req.onupgradeneeded = (ev) => {
			const db = req.result;
			// v1 → v2: a keyPath CANNOT be changed in place, so the v1 stores are
			// dropped and recreated (the cache is disposable — a user's existing v1
			// cache is simply discarded on the first load of v2).
			const from = (ev as IDBVersionChangeEvent).oldVersion || 0;
			if (from > 0 && from < 2) {
				for (const name of [META_STORE, CHUNK_STORE]) {
					if (db.objectStoreNames.contains(name)) db.deleteObjectStore(name);
				}
			}
			// v2: one meta PER GENERATION, chunks keyed by [session, generation, fromSeq]
			if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: ["sessionId", "rewriteSeq"] });
			if (!db.objectStoreNames.contains(CHUNK_STORE)) {
				const store = db.createObjectStore(CHUNK_STORE, { keyPath: ["sessionId", "rewriteSeq", "fromSeq"] });
				store.createIndex("byStoredAt", "storedAt");
			}
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
		req.onblocked = () => reject(new Error("idb blocked by another tab"));
	});
	let timedOut = false;
	const slow = new Promise<null>((resolve) => setTimeout(() => { timedOut = true; resolve(null); }, OP_TIMEOUT_MS));
	return Promise.race([
		dbPromise.then((db) => op(db)).catch(() => null),
		slow,
	]).then((r) => {
		// ONLY a timeout (or thrown op) counts as failure — a successful op may
		// legitimately return null/undefined (grok review 01a16a54 #3: putChunk's
		// `return null` used to trip the circuit after 3 successful warms)
		if (timedOut || r === MISS) {
			if (++failureStreak >= CIRCUIT_THRESHOLD) degraded = true; // stop trying until next page load
			return null;
		}
		failureStreak = 0;
		return r;
	});
}

function txReq<T>(db: IDBDatabase, stores: string[], mode: IDBTransactionMode, fn: (tx: IDBTransaction) => IDBRequest<T>): Promise<T | null> {
	return new Promise<T | null>((resolve) => {
		try {
			const tx = db.transaction(stores, mode);
			const req = fn(tx);
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => resolve(null);
		} catch { resolve(null); }
	});
}

function rememberGen(sessionId: string, gen: number) {
	if (gen > (currentGen.get(sessionId) ?? -1)) currentGen.set(sessionId, gen);
}

/** Coverage of ONE generation (v2): exact hit by [sessionId, rewriteSeq].
 *  With no generation given, the NEWEST generation for that session wins.
 *  A missing generation is a MISS — never a reason to delete anything. */
async function coverageFor(sessionId: string, rewriteSeq?: number): Promise<IdbMeta | null> {
	if (rewriteSeq !== undefined) {
		const meta = await withTimeout((db) => txReq(db, [META_STORE], "readonly", (tx) => tx.objectStore(META_STORE).get([sessionId, rewriteSeq]) as IDBRequest<IdbMeta>));
		if (meta) rememberGen(sessionId, meta.rewriteSeq || 0);
		return meta;
	}
	const metas = (await withTimeout((db) => txReq(db, [META_STORE], "readonly", (tx) => tx.objectStore(META_STORE).getAll() as IDBRequest<IdbMeta[]>))) || [];
	const mine = metas.filter((m) => m.sessionId === sessionId);
	if (mine.length === 0) return null;
	const newest = mine.reduce((a, b) => ((b.rewriteSeq || 0) > (a.rewriteSeq || 0) ? b : a));
	rememberGen(sessionId, newest.rewriteSeq || 0);
	return newest;
}

/** Schema v2 chunk key — PURE, so every writer (warm loop, expand, live
 *  write-through) lands on the same key for the same window. */
export function chunkKey(sessionId: string, rewriteSeq: number, fromSeq: number): [string, number, number] {
	return [sessionId, rewriteSeq, fromSeq];
}

/** Coverage update for one window: ranges stay DISJOINT and 1:1 with chunk keys
 *  (`range.fromSeq` IS the chunk's fromSeq — a merged range would read only its
 *  first blob, grok 01a16a54 #5). A window overlapping older ranges REPLACES
 *  them and the caller deletes those chunk records in the same txn. Overlap is a
 *  seam case (turn-aligned fetched windows meeting aligned live chunks); losing
 *  the older chunk costs at most one refetch and keeps the invariant intact. */
export function mergeRanges(
	ranges: Array<{ fromSeq: number; toSeq: number; bytes?: number }>,
	add: { fromSeq: number; toSeq: number; bytes?: number },
): { ranges: Array<{ fromSeq: number; toSeq: number; bytes?: number }>; replaced: Array<{ fromSeq: number; toSeq: number }> } {
	const replaced: Array<{ fromSeq: number; toSeq: number }> = [];
	const out: Array<{ fromSeq: number; toSeq: number; bytes?: number }> = [];
	for (const r of ranges) {
		if (r.toSeq <= add.fromSeq || r.fromSeq >= add.toSeq) { out.push(r); continue; } // disjoint
		replaced.push(r); // exact re-put / fully covered / partial — the new window wins
	}
	out.push({ fromSeq: add.fromSeq, toSeq: add.toSeq, bytes: add.bytes });
	out.sort((a, b) => a.fromSeq - b.fromSeq);
	return { ranges: out, replaced };
}

/** Which generations may be deleted now (PURE, unit-tested). Superseded = a
 *  newer generation exists AND the idle grace period has passed; expired = older
 *  than the hard TTL whatever the generations say. The current generation is
 *  never selected unless it is beyond the hard TTL. */
export function pickSweepCandidates(
	metas: Array<{ sessionId: string; rewriteSeq: number; updatedAt?: number }>,
	opts: { now: number; maxAgeMs: number; hardTtlMs: number; sessionId?: string },
): Array<{ sessionId: string; rewriteSeq: number; reason: "superseded" | "expired" }> {
	const newest = new Map<string, number>();
	for (const m of metas) newest.set(m.sessionId, Math.max(newest.get(m.sessionId) ?? -1, m.rewriteSeq || 0));
	const out: Array<{ sessionId: string; rewriteSeq: number; reason: "superseded" | "expired" }> = [];
	for (const m of metas) {
		if (opts.sessionId && m.sessionId !== opts.sessionId) continue;
		const age = opts.now - (m.updatedAt ?? 0);
		if (age > opts.hardTtlMs) { out.push({ sessionId: m.sessionId, rewriteSeq: m.rewriteSeq || 0, reason: "expired" }); continue; }
		if ((m.rewriteSeq || 0) < (newest.get(m.sessionId) ?? 0) && age > opts.maxAgeMs) out.push({ sessionId: m.sessionId, rewriteSeq: m.rewriteSeq || 0, reason: "superseded" });
	}
	return out;
}

/** Integrity check for a decompressed chunk body (PURE). The wire carries no
 *  per-message seq, so the checkable facts are: every line is JSON and the line
 *  count matches the claimed window exactly. */
export function verifyChunkText(text: string, fromSeq: number, toSeq: number): { ok: boolean; lines: number; reason?: string } {
	const lines = text.split("\n").filter(Boolean);
	if (lines.length !== toSeq - fromSeq) return { ok: false, lines: lines.length, reason: `line count ${lines.length} != window ${toSeq - fromSeq}` };
	for (let i = 0; i < lines.length; i++) {
		try { JSON.parse(lines[i]); } catch { return { ok: false, lines: lines.length, reason: `line ${i} is not JSON` }; }
	}
	return { ok: true, lines: lines.length };
}

/** Interval difference: subranges of [from,to) NOT covered by the sorted ranges. */
export function intervalDiff(from: number, to: number, ranges: Array<{ fromSeq: number; toSeq: number }>): Array<{ fromSeq: number; toSeq: number }> {
	const holes: Array<{ fromSeq: number; toSeq: number }> = [];
	let cursor = from;
	for (const r of ranges) {
		if (r.toSeq <= cursor) continue;
		if (r.fromSeq > cursor) holes.push({ fromSeq: cursor, toSeq: Math.min(r.fromSeq, to) });
		cursor = Math.max(cursor, r.toSeq);
		if (cursor >= to) break;
	}
	if (cursor < to) holes.push({ fromSeq: cursor, toSeq: to });
	return holes.filter((h) => h.toSeq > h.fromSeq);
}

/** Which parts of [from,to) are already cached — the client fetches only the rest.
 *  expectRewriteSeq: when provided, a generation mismatch (compaction/edits
 *  renumbered the transcript) invalidates the session and reports NO coverage —
 *  stale pre-rewrite chunks must never satisfy a read (COMPACT CHECK). */
export async function cachedRanges(sessionId: string, expectRewriteSeq?: number): Promise<Array<{ fromSeq: number; toSeq: number }>> {
	const meta = await coverageFor(sessionId, expectRewriteSeq);
	if (!meta) return []; // unknown generation ⇒ miss (the old generation stays for the GC)
	return meta.ranges ?? [];
}

/** Get CACHED decompressed message arrays covering [from,to) ENTIRELY — returns
 *  [] when any part of the window is a hole (grok review 01a16a54 #4: the old
 *  check was inverted — the cache could never hit). Ranges are 1:1 with chunk
 *  records (no merging — a merged meta range would read only its first blob).
 *  expectRewriteSeq: generation mismatch (compaction/edits) → invalidate + []. */
export async function getCachedChunks(sessionId: string, from: number, to: number, expectRewriteSeq?: number): Promise<Array<{ fromSeq: number; toSeq: number; messages: any[] }>> {
	const result = await withTimeout(async (db) => {
		const meta = await coverageFor(sessionId, expectRewriteSeq);
		if (!meta) return []; // unknown generation ⇒ miss; stale content can never satisfy a read
		const gen = meta.rewriteSeq || 0;
		const holes = intervalDiff(from, to, meta.ranges);
		if (holes.length > 0) return []; // partial coverage → caller fetches the whole window
		const out: Array<{ fromSeq: number; toSeq: number; messages: any[] }> = [];
		for (const r of meta.ranges) {
			if (r.toSeq <= from || r.fromSeq >= to) continue;
			// MEMORY TIER first (shader-cache): skip gunzip entirely on re-reads
			const hit = memTier.get(memKey(sessionId, r.fromSeq));
			if (hit) { hit.at = Date.now(); out.push({ fromSeq: r.fromSeq, toSeq: r.toSeq, messages: hit.messages }); continue; }
			const rec = await txReq(db, [CHUNK_STORE], "readonly", (tx) => tx.objectStore(CHUNK_STORE).get(chunkKey(sessionId, gen, r.fromSeq)) as IDBRequest<IdbChunk>);
			if (!rec || rec.toSeq !== r.toSeq) return []; // ghost range (blob gone) → fetch instead
			const text = await gunzip(rec.blob);
			if (text == null) { void dropChunk(sessionId, gen, r.fromSeq); return []; } // corrupt blob: never render, refetch
			const verdict = verifyChunkText(text, r.fromSeq, r.toSeq);
			if (!verdict.ok) { console.warn("[idb] dropping chunk", r.fromSeq, "—", verdict.reason); void dropChunk(sessionId, gen, r.fromSeq); return []; }
			const msgs = text.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
			memPut(sessionId, rec.fromSeq, msgs);
			out.push({ fromSeq: rec.fromSeq, toSeq: rec.toSeq, messages: msgs });
		}
		return out;
	});
	return result ?? [];
}

/** Put a fetched window: chunk blob + coverage update in ONE readwrite txn (a
 *  partial failure never claims a range it did not write). Ranges stay 1:1 with
 *  chunk records — NO adjacent merging (a merged range would read only its
 *  first blob, silently hiding messages — grok review 01a16a54 #5).
 *  EPOCH GUARD: meta from an older rewriteSeq is dropped; ranges below
 *  rewrittenFrom survive (same identity rule as the server). Serialized per
 *  session; overwrites of the same key adjust totalBytes (no LRU inflation). */
export async function putChunk(sessionId: string, fromSeq: number, toSeq: number, rewriteSeq: number, messageCount: number, gzipBlob: Blob, _rewrittenFrom = Number.MAX_SAFE_INTEGER): Promise<void> {
	// STALE-WRITE GUARD (v2): a window fetched for an older generation can no
	// longer be reached by any read — don't resurrect it (the _rewrittenFrom
	// prefix-survival hint is intentionally unused here; a rewrite starts a fresh
	// generation and the warm loop refills it).
	const known = currentGen.get(sessionId);
	if (known !== undefined && rewriteSeq < known) return;
	rememberGen(sessionId, rewriteSeq);
	const genAtCall = clearGen.get(sessionId) || 0; // clear-vs-inflight guard
	const run = () => withTimeout(async (db) => {
		if ((clearGen.get(sessionId) || 0) !== genAtCall) return true; // cleared mid-flight — drop silently
		const now = Date.now();
		const chunk: IdbChunk = { sessionId, fromSeq, toSeq, rewriteSeq, blob: gzipBlob, bytes: gzipBlob.size, storedAt: now };
		await new Promise<null>((resolve) => {
			try {
				const tx = db.transaction([META_STORE, CHUNK_STORE], "readwrite");
				const metaReq = tx.objectStore(META_STORE).get([sessionId, rewriteSeq]);
				metaReq.onsuccess = () => {
					const prev = (metaReq.result as IdbMeta | undefined) ?? { sessionId, rewriteSeq, messageCount, ranges: [], totalBytes: 0, updatedAt: now };
					const { ranges, replaced } = mergeRanges(prev.ranges || [], { fromSeq, toSeq, bytes: gzipBlob.size });
					let totalBytes = gzipBlob.size;
					for (const r of ranges) totalBytes += r.bytes || 0;
					// replaced ranges lose their chunk records in THIS txn (never a half-state)
					for (const r of replaced) tx.objectStore(CHUNK_STORE).delete(chunkKey(sessionId, rewriteSeq, r.fromSeq));
					tx.objectStore(CHUNK_STORE).put(chunk);
					tx.objectStore(META_STORE).put({ sessionId, rewriteSeq, messageCount: Math.max(prev.messageCount || 0, messageCount || 0), ranges, totalBytes, updatedAt: now });
				};
				tx.oncomplete = () => resolve(null);
				tx.onerror = () => resolve(null);
				tx.onabort = () => resolve(null);
			} catch { resolve(null); }
		});
		await evictIfNeeded(db);
		return true;
	});
	// serialize per session: latest-wins queue (chained, bounded by put frequency)
	const prev = writeQueues.get(sessionId) || Promise.resolve();
	const next = prev.then(run, run).catch(() => null);
	writeQueues.set(sessionId, next);
	await next;
}

/** Drop ONE chunk + punch its coverage (integrity failure on read, ghost blob).
 *  Reads then refetch that window; nothing else is touched. */
async function dropChunk(sessionId: string, rewriteSeq: number, fromSeq: number): Promise<void> {
	await withTimeout(async (db) => {
		await new Promise<null>((resolve) => {
			try {
				const tx = db.transaction([META_STORE, CHUNK_STORE], "readwrite");
				tx.objectStore(CHUNK_STORE).delete(chunkKey(sessionId, rewriteSeq, fromSeq));
				const metaReq = tx.objectStore(META_STORE).get([sessionId, rewriteSeq]);
				metaReq.onsuccess = () => {
					const meta = metaReq.result as IdbMeta | undefined;
					if (!meta) return;
					const gone = (meta.ranges || []).find((r) => r.fromSeq === fromSeq);
					const ranges = (meta.ranges || []).filter((r) => r.fromSeq !== fromSeq);
					tx.objectStore(META_STORE).put({ ...meta, ranges, totalBytes: Math.max(0, (meta.totalBytes || 0) - (gone?.bytes || 0)), updatedAt: Date.now() });
				};
				tx.oncomplete = () => resolve(null);
				tx.onerror = () => resolve(null);
				tx.onabort = () => resolve(null);
			} catch { resolve(null); }
		});
		return null;
	});
}

/** Date/integrity GC (user request: the cache "don't need to be erased
 *  immediately — it could be deleted by some logic after checking integrity
 *  (date, reload)"). Superseded generations go after SWEEP_MAX_AGE_MS, anything
 *  goes after SWEEP_HARD_TTL_MS. Never called for the current generation's
 *  fresh data. Triggers: attach (a newer generation proves the old is stale) and
 *  tab focus. Returns a small summary for tests/telemetry. */
export async function sweepStale(opts: { sessionId?: string; maxAgeMs?: number; hardTtlMs?: number; now?: number } = {}): Promise<{ scanned: number; dropped: number }> {
	const now = opts.now ?? Date.now();
	const key = opts.sessionId || "*";
	if (sweepRunning.has(key)) return { scanned: 0, dropped: 0 };
	sweepRunning.add(key);
	try {
		const metas = (await withTimeout((db) => txReq(db, [META_STORE], "readonly", (tx) => tx.objectStore(META_STORE).getAll() as IDBRequest<IdbMeta[]>))) || [];
		const targets = pickSweepCandidates(metas as Array<{ sessionId: string; rewriteSeq: number; updatedAt?: number }>, {
			now,
			maxAgeMs: opts.maxAgeMs ?? SWEEP_MAX_AGE_MS,
			hardTtlMs: opts.hardTtlMs ?? SWEEP_HARD_TTL_MS,
			sessionId: opts.sessionId,
		});
		if (targets.length === 0) return { scanned: metas.length, dropped: 0 };
		await withTimeout(async (db) => {
			await new Promise<null>((resolve) => {
				try {
					const tx = db.transaction([META_STORE, CHUNK_STORE], "readwrite");
					const metaStore = tx.objectStore(META_STORE);
					const chunkStore = tx.objectStore(CHUNK_STORE);
					for (const t of targets) {
						metaStore.delete([t.sessionId, t.rewriteSeq]);
						const range = IDBKeyRange.bound([t.sessionId, t.rewriteSeq, -Infinity], [t.sessionId, t.rewriteSeq, Number.MAX_SAFE_INTEGER]);
						const cur = chunkStore.openCursor(range);
						cur.onsuccess = () => { const c = cur.result; if (!c) return; c.delete(); c.continue(); };
					}
					tx.oncomplete = () => resolve(null);
					tx.onerror = () => resolve(null);
					tx.onabort = () => resolve(null);
				} catch { resolve(null); }
			});
			return null;
		});
		for (const t of targets) currentGen.delete(t.sessionId);
		return { scanned: metas.length, dropped: targets.length };
	} finally {
		sweepRunning.delete(key);
	}
}

/** USER-FACING CLEAR (session-list UI, "🧹 beside Kill"): wipes one session's
 *  IDB cache + memory tier. SAFE DURING A LIVE RUN — the run streams via WS
 *  and persists server-side; this cache is read-only data. An in-flight
 *  backfill write for this session is dropped (generation guard in putChunk). */
export async function clearSession(sessionId: string): Promise<void> {
	clearGen.set(sessionId, (clearGen.get(sessionId) || 0) + 1);
	for (const k of [...memTier.keys()]) if (k.startsWith(sessionId + ":")) memTier.delete(k);
	await withTimeout(async (db) => {
		await new Promise<null>((resolve) => {
			try {
				const tx = db.transaction([META_STORE, CHUNK_STORE], "readwrite");
				const metaStore = tx.objectStore(META_STORE);
				// v2: wipe EVERY generation of this session (the explicit 🧹 button)
				const metaRange = IDBKeyRange.bound([sessionId, -Infinity], [sessionId, Number.MAX_SAFE_INTEGER]);
				const metaCur = metaStore.openCursor(metaRange);
				metaCur.onsuccess = () => { const c = metaCur.result; if (!c) return; c.delete(); c.continue(); };
				const range = IDBKeyRange.bound([sessionId, -Infinity, -Infinity], [sessionId, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]);
				const cursorReq = tx.objectStore(CHUNK_STORE).openCursor(range);
				cursorReq.onsuccess = () => {
					const cur = cursorReq.result;
					if (!cur) return; // tx.oncomplete resolves
					cur.delete();
					cur.continue();
				};
				tx.oncomplete = () => resolve(null);
				tx.onerror = () => resolve(null);
				tx.onabort = () => resolve(null);
			} catch { resolve(null); }
		});
		return null;
	});
}

/** IDB footprint per session (session-list UI: "IDB 1.2MB" badges). */
export async function idbStats(): Promise<Map<string, { bytes: number; chunks: number }>> {
	const out = new Map<string, { bytes: number; chunks: number }>();
	const metas = await withTimeout(async (db) => txReq(db, [META_STORE], "readonly", (tx) => tx.objectStore(META_STORE).getAll() as IDBRequest<IdbMeta[]>));
	// v2: a session may hold several generations until the sweep — the badge is
	// the session's TOTAL footprint (that is what the user can reclaim).
	for (const m of metas || []) {
		const cur = out.get(m.sessionId) || { bytes: 0, chunks: 0 };
		out.set(m.sessionId, { bytes: cur.bytes + (m.totalBytes || 0), chunks: cur.chunks + (m.ranges?.length || 0) });
	}
	return out;
}

async function evictIfNeeded(db: IDBDatabase): Promise<void> {
	// ONE readwrite txn (grok review 01a16a54 #9 — the old version used nested
	// timeouts + read-then-write across txns: a partial evict could abort the
	// outer put, and two tabs could punch from stale meta)
	await new Promise<null>((resolve) => {
		try {
			const tx = db.transaction([META_STORE, CHUNK_STORE], "readwrite");
			const metasReq = tx.objectStore(META_STORE).getAll();
			metasReq.onsuccess = () => {
				const metas = (metasReq.result || []) as IdbMeta[];
				let total = metas.reduce((a, m) => a + m.totalBytes, 0);
				if (total <= MAX_CACHE_BYTES) return;
				const chunksReq = tx.objectStore(CHUNK_STORE).index("byStoredAt").getAll();
				chunksReq.onsuccess = () => {
					const chunks = (chunksReq.result || []) as IdbChunk[];
					const newestGen = new Map<string, number>();
					for (const m of metas) newestGen.set(m.sessionId, Math.max(newestGen.get(m.sessionId) ?? -1, m.rewriteSeq || 0));
					// superseded generations are dead weight — evict them first, then LRU
					const ordered = chunks.sort((a, b) => {
						const sa = (a.rewriteSeq || 0) < (newestGen.get(a.sessionId) ?? 0) ? 0 : 1;
						const sb = (b.rewriteSeq || 0) < (newestGen.get(b.sessionId) ?? 0) ? 0 : 1;
						return sa !== sb ? sa - sb : a.storedAt - b.storedAt;
					});
					for (const rec of ordered) {
						if (total <= MAX_CACHE_BYTES) break;
						tx.objectStore(CHUNK_STORE).delete(chunkKey(rec.sessionId, rec.rewriteSeq || 0, rec.fromSeq));
						total = Math.max(0, total - rec.bytes);
						const m = metas.find((x) => x.sessionId === rec.sessionId && (x.rewriteSeq || 0) === (rec.rewriteSeq || 0));
						if (!m) continue;
						// punch [fromSeq,toSeq) out of coverage (split if middle)
						const out: IdbMeta["ranges"] = [];
						for (const r of m.ranges) {
							if (r.toSeq <= rec.fromSeq || r.fromSeq >= rec.toSeq) { out.push(r); continue; }
							if (r.fromSeq < rec.fromSeq) out.push({ fromSeq: r.fromSeq, toSeq: rec.fromSeq });
							if (r.toSeq > rec.toSeq) out.push({ fromSeq: rec.toSeq, toSeq: r.toSeq });
						}
						m.ranges = out;
						m.totalBytes = Math.max(0, m.totalBytes - rec.bytes);
						tx.objectStore(META_STORE).put(m);
					}
				};
			};
			tx.oncomplete = () => resolve(null);
			tx.onerror = () => resolve(null);
			tx.onabort = () => resolve(null);
		} catch { resolve(null); }
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// LIVE WRITE-THROUGH (C2, 2026-10-24)
//
// The tail a user is reading is exactly the part that gets re-downloaded on the
// next open (measured 166KB gz for the 1MB tail). C2 writes it into IDB as the
// conversation grows — no request needed (user requirement 1) — using a chunk
// boundary that is a PURE function of the seq, so a live-written chunk and a
// fetched one describe the same window without negotiation (grok 01a16c29 Q1).
// ─────────────────────────────────────────────────────────────────────────────

/** Messages per aligned chunk (~550KB on the measured sessions — under the 1MB
 *  /range cap). Compiled into BOTH sides; a change invalidates nothing (keys
 *  carry the window, coverage is seq-addressed). */
export const CHUNK_INTERVAL = 64;
export const chunkIndexOf = (seq: number) => Math.floor(seq / CHUNK_INTERVAL);
export const chunkFromSeq = (index: number) => index * CHUNK_INTERVAL;
export const chunkToSeq = (index: number) => (index + 1) * CHUNK_INTERVAL; // exclusive
export const isChunkAligned = (seq: number) => seq >= 0 && seq % CHUNK_INTERVAL === 0;

export interface LiveChunkPlan {
	/** null = keep buffering (the run has not closed a window yet). */
	write: { fromSeq: number; toSeq: number; final: boolean } | null;
	consumed: number; // messages the caller may drop from the front of the buffer
	nextFromSeq: number | null; // where the next chunk starts once `consumed` are written
}

/**
 * What may be written after buffering `count` live messages that start at
 * `fromSeq` — PURE, unit-tested. A run closes a chunk exactly at an ALIGNED
 * boundary; a partial head (the first chunk after an attach, whose start is the
 * server's turn-aligned window start) closes at the next boundary. The trailing
 * remnant is deliberately NOT decided here: it is the open tail, flushed under
 * its own fromSeq by idle / agent_end / tab-hide and rewritten in place as it
 * grows (putChunk's mergeRanges replaces its own range).
 */
export function planLiveChunk(fromSeq: number, count: number): LiveChunkPlan {
	if (count <= 0 || fromSeq < 0) return { write: null, consumed: 0, nextFromSeq: null };
	if (isChunkAligned(fromSeq)) {
		if (count < CHUNK_INTERVAL) return { write: null, consumed: 0, nextFromSeq: null };
		return { write: { fromSeq, toSeq: fromSeq + CHUNK_INTERVAL, final: true }, consumed: CHUNK_INTERVAL, nextFromSeq: fromSeq + CHUNK_INTERVAL };
	}
	const boundary = chunkToSeq(chunkIndexOf(fromSeq)); // next aligned end strictly after fromSeq
	if (fromSeq + count < boundary) return { write: null, consumed: 0, nextFromSeq: null };
	return { write: { fromSeq, toSeq: boundary, final: true }, consumed: boundary - fromSeq, nextFromSeq: boundary };
}

/** NDJSON framing IDENTICAL to what /range serves (one JSON object per line, no
 *  trailing newline) — that is what makes a live chunk and a fetched chunk
 *  interchangeable on read (grok Q3). */
export function toNdjson(messages: any[]): string {
	return messages.map((m) => JSON.stringify(m)).join("\n");
}

/** gzip via the native CompressionStream (same codec the wire uses). */
export async function gzipText(text: string): Promise<Blob | null> {
	try {
		const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
		return await new Response(stream).blob();
	} catch { return null; }
}

/** Native DecompressionStream (Safari 16.4+/FF 113+/Chromium 80+). */
export async function gunzip(blob: Blob): Promise<string | null> {
	try {
		const ab = await new Response(blob.stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
		return new TextDecoder().decode(ab);
	} catch { return null; }
}

/** Transfer policy (user request: "wired → whole session, mobile → chunks").
 *  The browser's Network Information API outranks the server's netClass —
 *  it knows the real link (and saveData). Returns "fast" | "metered". */
export async function transferPolicy(netClassFromServer?: string): Promise<"fast" | "metered"> {
	try {
		const c = (navigator as any).connection;
		if (c?.saveData) return "metered";
		if (c?.effectiveType === "2g" || c?.effectiveType === "slow-2g" || c?.effectiveType === "3g") return "metered";
		if (c?.type === "cellular") return "metered";
		if (c?.type === "wifi" || c?.type === "ethernet") return "fast";
		if (c?.effectiveType === "4g") return "fast";
	} catch { /* NIA missing */ }
	return netClassFromServer === "lan" ? "fast" : "metered"; // Safari/Firefox remote: conservative
}
