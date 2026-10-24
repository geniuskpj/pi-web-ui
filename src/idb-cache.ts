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
// SHAPE: per-session COVERAGE (sorted disjoint [fromSeq,toSeq) windows) in a
// tiny meta record + per-chunk gzip blobs keyed `${sessionId}:${fromSeq}`.
// The miss-set is computed from meta alone (one small get) — a fully-cached
// session never pulls blobs to answer "do I have the tail?".

const DB_NAME = "pi-session-cache";
const DB_VERSION = 1;
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
	ranges: Array<{ fromSeq: number; toSeq: number; bytes?: number }>; // sorted, disjoint; bytes per chunk (LRU)
	totalBytes: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;
let degraded = false;
let failureStreak = 0;
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
		req.onupgradeneeded = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: "sessionId" });
			if (!db.objectStoreNames.contains(CHUNK_STORE)) {
				const store = db.createObjectStore(CHUNK_STORE, { keyPath: ["sessionId", "fromSeq"] });
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

/** Sorted disjoint windows covered by the session's chunk records. */
async function coverage(sessionId: string): Promise<IdbMeta | null> {
	return withTimeout((db) => txReq(db, [META_STORE], "readonly", (tx) => tx.objectStore(META_STORE).get(sessionId) as IDBRequest<IdbMeta>));
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
	const meta = await coverage(sessionId);
	if (!meta) return [];
	if (expectRewriteSeq !== undefined && (meta.rewriteSeq || 0) !== expectRewriteSeq) {
		await invalidateSession(sessionId);
		return [];
	}
	return meta.ranges ?? [];
}

/** Get CACHED decompressed message arrays covering [from,to) ENTIRELY — returns
 *  [] when any part of the window is a hole (grok review 01a16a54 #4: the old
 *  check was inverted — the cache could never hit). Ranges are 1:1 with chunk
 *  records (no merging — a merged meta range would read only its first blob).
 *  expectRewriteSeq: generation mismatch (compaction/edits) → invalidate + []. */
export async function getCachedChunks(sessionId: string, from: number, to: number, expectRewriteSeq?: number): Promise<Array<{ fromSeq: number; toSeq: number; messages: any[] }>> {
	const result = await withTimeout(async (db) => {
		const meta = await coverage(sessionId);
		if (!meta) return [];
		if (expectRewriteSeq !== undefined && (meta.rewriteSeq || 0) !== expectRewriteSeq) {
			await invalidateSession(sessionId); // COMPACT CHECK: stale content must never render
			return [];
		}
		const holes = intervalDiff(from, to, meta.ranges);
		if (holes.length > 0) return []; // partial coverage → caller fetches the whole window
		const out: Array<{ fromSeq: number; toSeq: number; messages: any[] }> = [];
		for (const r of meta.ranges) {
			if (r.toSeq <= from || r.fromSeq >= to) continue;
			// MEMORY TIER first (shader-cache): skip gunzip entirely on re-reads
			const hit = memTier.get(memKey(sessionId, r.fromSeq));
			if (hit) { hit.at = Date.now(); out.push({ fromSeq: r.fromSeq, toSeq: r.toSeq, messages: hit.messages }); continue; }
			const rec = await txReq(db, [CHUNK_STORE], "readonly", (tx) => tx.objectStore(CHUNK_STORE).get([sessionId, r.fromSeq]) as IDBRequest<IdbChunk>);
			if (!rec || rec.toSeq !== r.toSeq) return []; // ghost range (blob gone) → fetch instead
			const text = await gunzip(rec.blob);
			if (text == null) return [];
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
export async function putChunk(sessionId: string, fromSeq: number, toSeq: number, rewriteSeq: number, messageCount: number, gzipBlob: Blob, rewrittenFrom = Number.MAX_SAFE_INTEGER): Promise<void> {
	const genAtCall = clearGen.get(sessionId) || 0; // clear-vs-inflight guard
	const run = () => withTimeout(async (db) => {
		if ((clearGen.get(sessionId) || 0) !== genAtCall) return true; // cleared mid-flight — drop silently
		const chunk: IdbChunk = { sessionId, fromSeq, toSeq, rewriteSeq, blob: gzipBlob, bytes: gzipBlob.size, storedAt: Date.now() };
		await new Promise<null>((resolve) => {
			try {
				const tx = db.transaction([META_STORE, CHUNK_STORE], "readwrite");
				const metaReq = tx.objectStore(META_STORE).get(sessionId);
				metaReq.onsuccess = () => {
					let meta = metaReq.result as IdbMeta | undefined;
					if (!meta) meta = { sessionId, rewriteSeq, messageCount, ranges: [], totalBytes: 0 };
					if ((meta.rewriteSeq || 0) !== rewriteSeq) {
						// EPOCH CHANGE: keep only ranges strictly below rewrittenFrom
						const keep = rewrittenFrom >= Number.MAX_SAFE_INTEGER ? [] : meta.ranges.filter((r) => r.toSeq <= rewrittenFrom);
						const keptBytes = keep.reduce((a, r) => a + (r.bytes || 0), 0);
						meta = { sessionId, rewriteSeq, messageCount, ranges: keep, totalBytes: meta.totalBytes - keptBytes + gzipBlob.size };
					} else {
						// same epoch: replace an existing overlapping record's byte count
						const old = meta.ranges.find((r) => r.fromSeq === fromSeq);
						meta.totalBytes = Math.max(0, meta.totalBytes - (old?.bytes || 0) + gzipBlob.size);
					}
					const ranges = [...meta.ranges.filter((r) => r.fromSeq !== fromSeq && r.toSeq <= fromSeq || r.fromSeq >= toSeq), { fromSeq, toSeq, bytes: gzipBlob.size }].sort((a, b) => a.fromSeq - b.fromSeq);
					tx.objectStore(CHUNK_STORE).put(chunk);
					tx.objectStore(META_STORE).put({ ...meta, ranges });
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

/** Drop ALL chunks of a session (rewrite invalidation when the client can't
 *  trust any cached range — e.g. epoch changed and no rewrittenFrom survived).
 *  Resolves on tx COMPLETE (the old version never resolved on the done path
 *  and always rode the 2s timeout — grok review 01a16a54 #6). */
export async function invalidateSession(sessionId: string): Promise<void> {
	await clearSession(sessionId);
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
				tx.objectStore(META_STORE).delete(sessionId);
				const range = IDBKeyRange.bound([sessionId, -Infinity], [sessionId, Number.MAX_SAFE_INTEGER]);
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
	for (const m of metas || []) out.set(m.sessionId, { bytes: m.totalBytes || 0, chunks: m.ranges?.length || 0 });
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
					for (const rec of chunks.sort((a, b) => a.storedAt - b.storedAt)) {
						if (total <= MAX_CACHE_BYTES) break;
						tx.objectStore(CHUNK_STORE).delete([rec.sessionId, rec.fromSeq]);
						total = Math.max(0, total - rec.bytes);
						const m = metas.find((x) => x.sessionId === rec.sessionId);
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
