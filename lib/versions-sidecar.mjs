// versions-sidecar.mjs — per-session delta records (edit / rewrite / switch-away).
// Extracted from session-worker.mjs (2026-10-24) so the dedupe + hash logic is
// unit-testable outside the worker thread (parentPort is null on plain import).
//
// Record shape: { vid, at, turn, firstId, count, reason, hash, messages[] } —
// one JSONL line per parked state in <id>.versions.jsonl.
//
// DEDUPE (user report 2026-10-24, live session d9120621): clicking "switch to"
// re-parked the SAME tail on every click — vid3 was byte-identical to vid1 and
// vid4 to vid2. One ✎ edit should yield ONE original + at most ONE switch-away
// copy of the new state, no matter how often the user flips between them.
// append() therefore hashes {turn, messages} and returns the EXISTING record
// (dup: true) instead of writing a second copy. Position is part of the hash:
// identical content parked at a different cut point is a DIFFERENT delta.
// Records written before the hash existed are hashed on the fly, so old
// sidecars dedupe too.
import { createHash } from "node:crypto";
import path from "node:path";
import fsp from "node:fs/promises";

const recordHash = (r) =>
	createHash("sha256")
		.update(JSON.stringify({ turn: r?.turn ?? null, messages: r?.messages ?? [] }))
		.digest("hex")
		.slice(0, 16);

export function makeVersionsStore(dir) {
	const file = (id) => path.join(dir, `${id}.versions.jsonl`);

	async function readAll(id) {
		let raw = "";
		try { raw = await fsp.readFile(file(id), "utf8"); } catch { return []; }
		return raw.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
	}

	// PER-ID APPEND CHAIN (review 2026-10-28): append() is a read-modify-write (readAll → dedupe →
	// next vid → appendFile) and the worker's parentPort handler is async, so two appends for ONE
	// session (two devices parking at once, or an edit racing a switch-away) both read the same
	// list, both compute the SAME next vid and write two DIFFERENT records under it. get() returns
	// the first match, so one parked transcript became unrestorable. Serialize per id — the same
	// chain the session store uses for its puts (session-worker.mjs putChains).
	const chains = new Map();
	function append(id, record) {
		const prev = chains.get(id) || Promise.resolve();
		const run = prev.then(() => appendOne(id, record));
		// the chain itself must never reject, or one failed append poisons every later one
		chains.set(id, run.then(() => undefined, () => undefined));
		return run;
	}

	async function appendOne(id, record) {
		const existing = await readAll(id);
		const hash = recordHash(record);
		const dup = existing.find((r) => (r.hash || recordHash(r)) === hash && (r.turn ?? null) === (record?.turn ?? null));
		if (dup) return { ...dup, dup: true };
		const vid = existing.reduce((m, r) => Math.max(m, Number(r.vid) || 0), 0) + 1;
		const full = { ...record, hash, vid, at: Date.now() };
		await fsp.appendFile(file(id), JSON.stringify(full) + "\n", "utf8");
		return full;
	}

	async function list(id) {
		// meta only — never ship the message bodies for a list. preview = first
		// text of the record's first message (80 chars) so the picker rows are
		// readable (arena review: users distinguish versions by content, not ids)
		const previewOf = (r) => {
			const m = (r.messages || [])[0];
			if (!m) return "";
			const t = typeof m.content === "string" ? m.content : (m.content || []).filter((b) => b?.type === "text").map((b) => b.text || "").join(" ");
			return String(t).replace(/\s+/g, " ").trim().slice(0, 80);
		};
		return (await readAll(id)).map((r) => ({ vid: r.vid, at: r.at, turn: r.turn, firstId: r.firstId, count: r.count, reason: r.reason, preview: previewOf(r) }));
	}

	async function get(id, vid) {
		return (await readAll(id)).find((r) => Number(r.vid) === Number(vid)) || null;
	}

	return { append, list, get };
}
