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
	ranges: Array<{ fromSeq: number; toSeq: number }>; // sorted, disjoint
	totalBytes: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;
let degraded = false;
let failureStreak = 0;
const writeQueues = new Map<string, Promise<unknown>>();

function withTimeout<T>(op: (db: IDBDatabase) => Promise<T>): Promise<T | null> {
	if (degraded || !("indexedDB" in window)) return Promise.resolve(null);
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
	const slow = new Promise<null>((resolve) => setTimeout(() => resolve(null), OP_TIMEOUT_MS));
	return Promise.race([
		dbPromise.then((db) => op(db)).catch(() => null),
		slow,
	]).then((r) => {
		if (r === null) {
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

/** Which parts of [from,to) are already cached — the client fetches only the rest. */
export async function cachedRanges(sessionId: string): Promise<Array<{ fromSeq: number; toSeq: number }>> {
	const meta = await coverage(sessionId);
	return meta?.ranges ?? [];
}

/** Get CACHED decompressed message arrays intersecting [from,to) — returns the
 *  windows found (never fetches). Caller fetches intervalDiff(cached) gaps. */
export async function getCachedChunks(sessionId: string, from: number, to: number): Promise<Array<{ fromSeq: number; toSeq: number; messages: any[] }>> {
	const result = await withTimeout(async (db) => {
		const meta = await coverage(sessionId);
		if (!meta) return [];
		const covered = intervalDiff(from, to, meta.ranges);
		const needed: Array<{ fromSeq: number; toSeq: number }> = [];
		let cursor = from;
		for (const h of covered) { if (h.fromSeq > cursor) needed.push({ fromSeq: cursor, toSeq: h.fromSeq }); cursor = h.toSeq; }
		if (cursor < to) needed.push({ fromSeq: cursor, toSeq: to });
		if (needed.length) return []; // some part of the asked window is a hole → caller must fetch anyway
		const out: Array<{ fromSeq: number; toSeq: number; messages: any[] }> = [];
		for (const r of meta.ranges) {
			if (r.toSeq <= from || r.fromSeq >= to) continue;
			const rec = await txReq(db, [CHUNK_STORE], "readonly", (tx) => tx.objectStore(CHUNK_STORE).get([sessionId, r.fromSeq]) as IDBRequest<IdbChunk>);
			if (!rec) continue;
			const text = await gunzip(rec.blob);
			if (text == null) continue;
			const msgs = text.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
			out.push({ fromSeq: rec.fromSeq, toSeq: rec.toSeq, messages: msgs });
		}
		return out;
	});
	return result ?? [];
}

/** Put a fetched window: chunk blob + coverage union in ONE txn (a partial
 *  failure never claims a range it did not write). Serialized per session. */
export async function putChunk(sessionId: string, fromSeq: number, toSeq: number, rewriteSeq: number, messageCount: number, gzipBlob: Blob): Promise<void> {
	const run = () => withTimeout(async (db) => {
		const chunk: IdbChunk = { sessionId, fromSeq, toSeq, rewriteSeq, blob: gzipBlob, bytes: gzipBlob.size, storedAt: Date.now() };
		const meta = (await coverage(sessionId)) || { sessionId, rewriteSeq, messageCount, ranges: [], totalBytes: 0 };
		// union [fromSeq,toSeq) into ranges
		const ranges = [...meta.ranges, { fromSeq, toSeq }].sort((a, b) => a.fromSeq - b.fromSeq);
		const merged: Array<{ fromSeq: number; toSeq: number }> = [];
		for (const r of ranges) {
			const last = merged[merged.length - 1];
			if (last && r.fromSeq <= last.toSeq) last.toSeq = Math.max(last.toSeq, r.toSeq);
			else merged.push({ ...r });
		}
		const bytes = gzipBlob.size;
		const nextMeta: IdbMeta = { sessionId, rewriteSeq, messageCount, ranges: merged, totalBytes: meta.totalBytes + bytes };
		await new Promise<null>((resolve) => {
			try {
				const tx = db.transaction([META_STORE, CHUNK_STORE], "readwrite");
				tx.objectStore(CHUNK_STORE).put(chunk);
				tx.objectStore(META_STORE).put(nextMeta);
				tx.oncomplete = () => resolve(null);
				tx.onerror = () => resolve(null);
				tx.onabort = () => resolve(null);
			} catch { resolve(null); }
		});
		await evictIfNeeded(db);
		return null;
	});
	// serialize per session: latest-wins queue of length 1
	const prev = writeQueues.get(sessionId) || Promise.resolve();
	const next = prev.then(run, run).catch(() => null);
	writeQueues.set(sessionId, next);
	await next;
}

/** Drop ALL chunks of a session (rewrite invalidation when the client can't
 *  trust any cached range — e.g. epoch changed and no rewrittenFrom survived). */
export async function invalidateSession(sessionId: string): Promise<void> {
	await withTimeout(async (db) => {
		await new Promise<null>((resolve) => {
			try {
				const tx = db.transaction([META_STORE, CHUNK_STORE], "readwrite");
				tx.objectStore(META_STORE).delete(sessionId);
				const idx = tx.objectStore(CHUNK_STORE).index("byStoredAt");
				// delete-by-prefix: open a cursor over chunks, remove this session's
				const store = tx.objectStore(CHUNK_STORE);
				const cursorReq = store.openCursor();
				cursorReq.onsuccess = () => {
					const cur = cursorReq.result;
					if (!cur) return;
					const rec = cur.value as IdbChunk;
					if (rec.sessionId === sessionId) cur.delete();
					cur.continue();
				};
			} catch { resolve(null); }
		});
		return null;
	});
}

async function evictIfNeeded(db: IDBDatabase): Promise<void> {
	const total = await txReq(db, [META_STORE], "readonly", (tx) => tx.objectStore(META_STORE).getAll() as IDBRequest<IdbMeta[]>);
	if (!total || total.reduce((a, m) => a + m.totalBytes, 0) <= MAX_CACHE_BYTES) return;
	// LRU: oldest storedAt chunks first, punching their range out of coverage
	const oldest = await txReq(db, [CHUNK_STORE], "readonly", (tx) => tx.objectStore(CHUNK_STORE).index("byStoredAt").getAll() as IDBRequest<IdbChunk[]>);
	if (!oldest) return;
	const sorted = [...oldest].sort((a, b) => a.storedAt - b.storedAt);
	for (const rec of sorted) {
		const after = await txReq(db, [META_STORE], "readonly", (tx) => tx.objectStore(META_STORE).getAll() as IDBRequest<IdbMeta[]>);
		if (after && after.reduce((a, m) => a + m.totalBytes, 0) <= MAX_CACHE_BYTES) break;
		await withTimeout(async (db2) => {
			await new Promise<null>((resolve) => {
				try {
					const tx = db2.transaction([META_STORE, CHUNK_STORE], "readwrite");
					tx.objectStore(CHUNK_STORE).delete([rec.sessionId, rec.fromSeq]);
					const metaReq = tx.objectStore(META_STORE).get(rec.sessionId);
					metaReq.onsuccess = () => {
						const m = metaReq.result as IdbMeta | undefined;
						if (m) {
							// punch [fromSeq,toSeq) out of ranges (split if middle)
							const out: IdbMeta["ranges"] = [];
							for (const r of m.ranges) {
								if (r.toSeq <= rec.fromSeq || r.fromSeq >= rec.toSeq) { out.push(r); continue; }
								if (r.fromSeq < rec.fromSeq) out.push({ fromSeq: r.fromSeq, toSeq: rec.fromSeq });
								if (r.toSeq > rec.toSeq) out.push({ fromSeq: rec.toSeq, toSeq: r.toSeq });
							}
							tx.objectStore(META_STORE).put({ ...m, ranges: out, totalBytes: Math.max(0, m.totalBytes - rec.bytes) });
						}
					};
					tx.oncomplete = () => resolve(null);
					tx.onerror = () => resolve(null);
				} catch { resolve(null); }
			});
			return null;
		});
	}
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
