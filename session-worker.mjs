// session-worker.mjs — session store on a WORKER THREAD (JSONL format).
// Line 1 = metadata, subsequent lines = messages. Atomic writes via tmp+rename.
import { parentPort, workerData } from "node:worker_threads";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const SESSIONS_DIR = workerData.sessionsDir;
fs.mkdirSync(SESSIONS_DIR, { recursive: true });
// boot hygiene: stale .tmp leftovers from crashed writes must never be read as
// sessions (loadFromDisk filters by extension, but they'd still accumulate)
try { for (const f of fs.readdirSync(SESSIONS_DIR)) if (f.endsWith(".tmp")) fs.unlinkSync(path.join(SESSIONS_DIR, f)); } catch { /* ignore */ }

import { SESSION_ID_RE } from "./session-id.mjs";
import { makeVersionsStore } from "./lib/versions-sidecar.mjs";
const sessionFile = (id) => path.join(SESSIONS_DIR, `${id}.jsonl`);
// VERSIONS sidecar (user design 2026-10-23): per-session delta records — the
// removed tail of every edit/rewrite, keyed by a monotonic vid + turn number +
// first message id, with simple meta. Restoring a version swaps the tail back
// (the replaced tail is captured first → lossless round trip).
const versionsFile = (id) => path.join(SESSIONS_DIR, `${id}.versions.jsonl`);

const cache = new Map(); // id -> { metadata, messages }
let loaded = false;

async function loadFromDisk() {
	if (loaded) return;
	let files = [];
	try {
		// .versions.jsonl sidecars are NOT sessions — never load them into the cache
		files = fs.readdirSync(SESSIONS_DIR).filter((f) => (f.endsWith(".jsonl") || f.endsWith(".json")) && !f.endsWith(".versions.jsonl"));
	} catch { /* dir missing */ }
	for (const f of files) {
		try {
			const raw = await fsp.readFile(path.join(SESSIONS_DIR, f), "utf8");
			const nl = raw.indexOf("\n");
			const metadata = JSON.parse(nl === -1 ? raw : raw.slice(0, nl));
			const messages = nl === -1 ? [] : raw.slice(nl + 1).split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
			cache.set(metadata.id, { metadata, messages });
		} catch { /* skip corrupt */ }
	}
	loaded = true;
}

function listSessions() {
	const out = [];
	for (const j of cache.values()) out.push(j.metadata);
	out.sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));
	return out;
}

// per-id put chains: the parentPort handler is ASYNC — with the server-side
// agent persisting every turn AND browsers pushing /ws/sync puts, two puts for
// the SAME session interleaved on the SHARED .jsonl.tmp path (one rename moved
// it away, the other's rename → ENOENT, observed 2026-10-21) and concurrent
// writes could corrupt each other. Serialize per id + unique tmp names.
const putChains = new Map();
async function putOne(id, jsonl) {
	const prev = putChains.get(id) || Promise.resolve();
	const run = prev.then(() => _putOne(id, jsonl));
	putChains.set(id, run.then(() => undefined, () => undefined));
	return run;
}

async function _putOne(id, jsonl) {
	const lines = jsonl.split("\n").filter(Boolean);
	const metadata = JSON.parse(lines[0]);
	const messages = lines.slice(1).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
	cache.set(id, { metadata, messages });
	const tmp = `${sessionFile(id)}.${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`;
	try {
		await fsp.writeFile(tmp, jsonl, "utf8");
		await fsp.rename(tmp, sessionFile(id));
	} catch (err) {
		try { await fsp.unlink(tmp); } catch { /* already gone */ }
		throw err;
	}
}

async function delOne(id) {
	cache.delete(id);
	putChains.delete(id);
	try { await fsp.unlink(sessionFile(id)); } catch { /* gone */ }
	try { await fsp.unlink(versionsFile(id)); } catch { /* gone */ }
}

// --- versions sidecar (delta records with simple meta) -----------------------
// Extracted to lib/versions-sidecar.mjs (content-hash dedupe + sha — clickng
// "switch to" used to re-park byte-identical tails, user report 2026-10-24);
// same call signatures as before.
const versionsStore = makeVersionsStore(SESSIONS_DIR);
const versionsAppend = (id, record) => versionsStore.append(id, record);
const versionsList = (id) => versionsStore.list(id);
const versionsGet = (id, vid) => versionsStore.get(id, vid);

parentPort.on("message", async (msg) => {
	const { id, op } = msg || {};
	const payload = msg?.payload || {};
	const sid = String(payload.id || "");
	try {
		let result = null;
		if (op === "list") {
			await loadFromDisk();
			result = listSessions();
		} else if (op === "get" && SESSION_ID_RE.test(sid)) {
			await loadFromDisk();
			const entry = cache.get(sid);
			if (entry) {
				const lines = [JSON.stringify(entry.metadata)];
				for (const m of entry.messages || []) lines.push(JSON.stringify(m));
				result = { jsonl: lines.join("\n") + "\n", metadata: entry.metadata, messages: entry.messages };
			} else {
				result = null;
			}
		} else if (op === "meta" && SESSION_ID_RE.test(sid)) {
			// lightweight metadata probe (no 5MB message transfer) — the server's
			// non-regression guards for client session pushes: messageCount (stale
			// shrink guard) + firstIsSummary (compacted-mirror guard)
			await loadFromDisk();
			const entry = cache.get(sid);
			result = entry ? { metadata: entry.metadata, messageCount: (entry.messages || []).length, firstIsSummary: !!(entry.messages || [])[0]?.isCompactionSummary } : null;
		} else if (op === "put" && SESSION_ID_RE.test(sid) && payload.jsonl) {
			await putOne(sid, payload.jsonl);
			result = true;
		} else if (op === "delete" && SESSION_ID_RE.test(sid)) {
			await delOne(sid);
			result = true;
		} else if (op === "versions-append" && SESSION_ID_RE.test(sid)) {
			result = await versionsAppend(sid, payload.record || {});
		} else if (op === "versions-list" && SESSION_ID_RE.test(sid)) {
			result = await versionsList(sid);
		} else if (op === "versions-get" && SESSION_ID_RE.test(sid)) {
			result = await versionsGet(sid, payload.vid);
		} else {
			throw new Error("bad op: " + op);
		}
		parentPort.postMessage({ id, result });
	} catch (err) {
		parentPort.postMessage({ id, error: err?.message || String(err) });
	}
});
