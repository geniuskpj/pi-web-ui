// session-worker.mjs — session store on a WORKER THREAD (JSONL format).
// Line 1 = metadata, subsequent lines = messages. Atomic writes via tmp+rename.
import { parentPort, workerData } from "node:worker_threads";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const SESSIONS_DIR = workerData.sessionsDir;
fs.mkdirSync(SESSIONS_DIR, { recursive: true });

import { SESSION_ID_RE } from "./session-id.mjs";
const sessionFile = (id) => path.join(SESSIONS_DIR, `${id}.jsonl`);

const cache = new Map(); // id -> { metadata, messages }
let loaded = false;

async function loadFromDisk() {
	if (loaded) return;
	let files = [];
	try {
		files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".jsonl") || f.endsWith(".json"));
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

async function putOne(id, jsonl) {
	const lines = jsonl.split("\n").filter(Boolean);
	const metadata = JSON.parse(lines[0]);
	const messages = lines.slice(1).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
	cache.set(id, { metadata, messages });
	const tmp = sessionFile(id) + ".tmp";
	await fsp.writeFile(tmp, jsonl, "utf8");
	await fsp.rename(tmp, sessionFile(id));
}

async function delOne(id) {
	cache.delete(id);
	try { await fsp.unlink(sessionFile(id)); } catch { /* gone */ }
}

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
		} else if (op === "put" && SESSION_ID_RE.test(sid) && payload.jsonl) {
			await putOne(sid, payload.jsonl);
			result = true;
		} else if (op === "delete" && SESSION_ID_RE.test(sid)) {
			await delOne(sid);
			result = true;
		} else {
			throw new Error("bad op: " + op);
		}
		parentPort.postMessage({ id, result });
	} catch (err) {
		parentPort.postMessage({ id, error: err?.message || String(err) });
	}
});
