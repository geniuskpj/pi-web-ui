// runtime-seq.test.mjs — runtime-only deltas must REACH the client (2026-10-21
// commit review P2). Before the fix, runtime-only emissions (attach/detach
// client counts, queued prompts) reused the last agent-event seq, and the
// client's stale-frame guard `rt.seq <= cur.seq` dropped them; now every
// emitRuntime advances the shared entry.seq, so each runtime frame is strictly
// forward and nothing is dropped.
//
// Deterministic without an API key: a temp PI_DIR maps the only model's baseUrl
// at a local HTTP sink that answers 500 → agent_start (running, stored) then
// agent_end (error, stored) with real frames on /ws/sync; attach/detach deltas
// follow at what used to be the SAME seq.
// Usage: node tests/runtime-seq.test.mjs
import WebSocket from "ws";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startScratchServer } from "./_scratch-server.mjs";

let passed = 0, failed = 0;
const check = (name, ok, extra = "") => {
	if (ok) { passed++; console.log(`  ✓ ${name}${extra ? " — " + extra : ""}`); }
	else { failed++; console.error(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// the sink: every LLM call fails fast with 500 → agent_end(stopReason error)
const sink = http.createServer((req, res) => { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "runtime-seq test sink" } })); });
await new Promise((r) => sink.listen(0, "127.0.0.1", r));

// temp PI_DIR: single failing provider + dummy key (isolated from the real .pi)
const tmpPi = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-rtseq-pi-"));
fs.writeFileSync(path.join(tmpPi, "models-store.json"), JSON.stringify({
	sink: {
		models: [{
			id: "sink-1", name: "Sink 1", api: "openai-completions", provider: "sink",
			baseUrl: `http://127.0.0.1:${sink.address().port}/v1`, reasoning: false, input: ["text"],
			contextWindow: 8192, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		}],
	},
}));
fs.writeFileSync(path.join(tmpPi, "auth.json"), JSON.stringify({ sink: { type: "api", key: "sk-dummy" } }));
process.env.PI_DIR = tmpPi; // _scratch-server spreads process.env

const srv = await startScratchServer();

// verbatim mirror of the client guard (src/session-sync.ts applyRuntime)
const runtimeMap = new Map();
let dropped = 0;
const applyRuntime = (rt) => {
	if (!rt?.sessionId) return false;
	const cur = runtimeMap.get(rt.sessionId);
	if (cur && typeof rt.seq === "number" && typeof cur.seq === "number" && rt.seq <= cur.seq) { dropped++; return false; }
	if (!rt.status || rt.status === "idle") runtimeMap.delete(rt.sessionId);
	else runtimeMap.set(rt.sessionId, rt);
	return true;
};

try {
	const SESSION = "rtseq" + Math.random().toString(36).slice(2, 10);
	const agentUrl = `ws://127.0.0.1:${srv.port}/ws/agent?session=${SESSION}&token=${encodeURIComponent(srv.token)}`;
	const frames = [];

	const sync = new WebSocket(`ws://127.0.0.1:${srv.port}/ws/sync?token=${encodeURIComponent(srv.token)}`);
	await new Promise((res, rej) => { sync.on("open", res); sync.on("error", rej); });
	sync.on("message", (d) => {
		try {
			const m = JSON.parse(d.toString());
			if (m.type !== "runtime") return;
			frames.push(m.runtime);
			applyRuntime(m.runtime);
		} catch {}
	});
	await sleep(300); // server registers the sync client

	const a = new WebSocket(agentUrl);
	await new Promise((res, rej) => { a.on("open", res); a.on("error", rej); });
	a.on("message", () => {});
	a.send(JSON.stringify({ type: "attach", sessionId: SESSION }));
	await sleep(300);

	// run → agent_start (running) → LLM 500 → agent_end (error, STORED client-side)
	a.send(JSON.stringify({ type: "prompt", content: "fail please" }));
	for (let i = 0; i < 100 && !frames.some((f) => f.status === "error"); i++) await sleep(100);
	check("error run produced a stored error frame", frames.some((f) => f.status === "error"), `frames=${frames.length}`);

	// attach device B mid/after the run — its delta must NOT be dropped
	const b = new WebSocket(agentUrl);
	await new Promise((res, rej) => { b.on("open", res); b.on("error", rej); });
	b.on("message", () => {});
	b.send(JSON.stringify({ type: "attach", sessionId: SESSION }));
	for (let i = 0; i < 40 && !frames.some((f) => f.clients >= 2); i++) await sleep(100);
	b.close(); // detach delta must not be dropped either
	for (let i = 0; i < 40 && frames[frames.length - 1]?.clients !== 1; i++) await sleep(100);
	await sleep(300);
	a.close();
	await sleep(200);
	sync.close();

	const seqs = frames.map((f) => f.seq);
	const strictlyForward = seqs.every((s, i) => i === 0 || s > seqs[i - 1]);
	check("every runtime frame strictly advances seq (fix)", strictlyForward, `seqs=${seqs.join(",")}`);
	check("guard dropped NOTHING (was 2+ drops pre-fix)", dropped === 0, `dropped=${dropped} of ${frames.length}`);
	check("attach delta (clients:2) emitted AND accepted", frames.some((f) => f.clients >= 2), `clients trace=${frames.map((f) => f.clients).join("→")}`);
	check("client map tracks the real final client count (0 — all devices gone)", runtimeMap.get(SESSION)?.clients === 0, `map clients=${runtimeMap.get(SESSION)?.clients}`);
	check("error status remains pinned in the client map", runtimeMap.get(SESSION)?.status === "error", `map: ${JSON.stringify(runtimeMap.get(SESSION) || null)}`);
} finally {
	await srv.stop();
	sink.close();
}
console.log(`\n[runtime-seq] ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
