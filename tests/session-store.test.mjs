// session-store.test.mjs — the JSONL worker must survive CONCURRENT puts for
// the same session: the parentPort handler is async, so the hub's persist plus
// browser /ws/sync pushes interleave. Before the per-id put-chain + unique-tmp
// fix (2026-10-21) two overlapping puts raced on the shared .jsonl.tmp path and
// one rename failed with ENOENT — breaking sync for that session.
// Usage: node tests/session-store.test.mjs
import { Worker } from "node:worker_threads";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-store-"));

let passed = 0, failed = 0;
const check = (name, ok, extra = "") => {
	if (ok) { passed++; console.log(`  ✓ ${name}${extra ? " — " + extra : ""}`); }
	else { failed++; console.error(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
};

const worker = new Worker(path.join(ROOT, "session-worker.mjs"), { workerData: { sessionsDir: dir } });
let mid = 0;
const pending = new Map();
worker.on("message", (m) => {
	const p = pending.get(m.id);
	if (!p) return;
	pending.delete(m.id);
	m.error ? p.rej(new Error(m.error)) : p.res(m.result);
});
worker.on("error", (e) => { for (const p of pending.values()) p.rej(e); pending.clear(); });
const op = (opName, payload = {}) => new Promise((res, rej) => {
	const id = ++mid;
	pending.set(id, { res, rej });
	worker.postMessage({ id, op: opName, payload });
});
const meta = (n) => ({ id: "racetest123456789", title: `race ${n}`, lastModified: new Date().toISOString(), messageCount: n });

try {
	// 15 concurrent puts for ONE id — increasing message counts (any interleaving
	// of the old shared-tmp implementation broke at least one with ENOENT)
	const PUTS = 15;
	const jobs = [];
	for (let n = 1; n <= PUTS; n++) {
		const jsonl = [JSON.stringify(meta(n)), ...Array.from({ length: n }, (_, i) => JSON.stringify({ role: i % 2 ? "assistant" : "user", content: `msg ${n}/${i + 1}` }))].join("\n") + "\n";
		jobs.push(op("put", { id: "racetest123456789", jsonl }).then((r) => ({ n, ok: r === true })));
	}
	const results = await Promise.all(jobs);
	check(`${PUTS} concurrent puts all succeeded (no ENOENT)`, results.every((x) => x.ok));

	const got = await op("get", { id: "racetest123456789" });
	check("get returns the last put's messages", got?.messages?.length === PUTS, `msgs=${got?.messages?.length}`);
	check("get includes jsonl + metadata", typeof got?.jsonl === "string" && got?.metadata?.title === `race ${PUTS}`);

	const list = await op("list");
	check("list has exactly one entry for the id", Array.isArray(list) && list.filter((m) => m.id === "racetest123456789").length === 1);

	// concurrent put + delete race must not throw unhandled
	const del = op("delete", { id: "racetest123456789" });
	const latePut = op("put", { id: "racetest123456789", jsonl: JSON.stringify(meta(1)) + "\n" + JSON.stringify({ role: "user", content: "after delete" }) + "\n" }).catch((e) => ({ err: e.message }));
	await del;
	const after = await latePut;
	check("put racing delete resolves (either order) without crash", after === true || typeof after?.err === "string");
	const listed = await op("list");
	check("final state consistent (0 or 1 entries, never corrupt)", Array.isArray(listed) && listed.filter((m) => m.id === "racetest123456789").length <= 1);

	const tmpLeft = fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));
	check("no .tmp leftovers on disk", tmpLeft.length === 0, tmpLeft.join(","));
} catch (e) {
	check("no unexpected failure", false, e.message);
} finally {
	await worker.terminate();
}
console.log(`\n[session-store] ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
