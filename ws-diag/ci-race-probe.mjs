// ci-race-probe.mjs — reproduce the CI failure mode of tests/media-egress.e2e.mjs without CI.
//
// CI (2026-11-01) failed that suite with "0.0KB body", `E1b — {}` and `lines=1` while it passed locally.
// The mechanism: `GET /api/agent/session/:id` answers **200 with `exists:false`** for a session the worker
// has not written yet, and `/range` answers 200 with a lone metadata line. The suite's seed wait was
// "any `sessions` frame", and /ws/sync pushes that list ON CONNECT — before the server has processed the
// put — so a slow runner read an empty session and every later assertion failed.
//
// This probe shows the two halves of that: what a read looks like BEFORE the store answers (the CI state)
// and that the content-based readiness introduced in the suite converges instead of asserting a race.
//
// Usage: node ws-diag/ci-race-probe.mjs
import WebSocket from "ws";
import { startScratchServer } from "../tests/_scratch-server.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const srv = await startScratchServer();
const H = { "x-pi-web-token": srv.token };
const SESSION = "cirace00000000000000000000000001";
const MESSAGES = [
	{ role: "user", content: [{ type: "text", text: "photo" }, { type: "image", mimeType: "image/png", data: Buffer.alloc(200 * 1024, 7).toString("base64") }], timestamp: 1 },
	{ role: "assistant", content: "ok", timestamp: 2 },
];
const get = async (p) => {
	const r = await fetch(srv.url(p), { headers: H });
	const text = await r.text();
	let body = null;
	try { body = JSON.parse(text); } catch { /* ndjson */ }
	return { status: r.status, body, text };
};

try {
	const sync = new WebSocket(`ws://127.0.0.1:${srv.port}/ws/sync?token=${encodeURIComponent(srv.token)}`);
	const frames = [];
	sync.on("message", (raw) => { try { frames.push(JSON.parse(String(raw))); } catch { /* ignore */ } });
	await new Promise((res, rej) => { sync.on("open", res); sync.on("error", rej); });
	// the OLD wait: any sessions frame — satisfied by the connect-time push, i.e. before our put is processed
	let oldWaitMs = 0;
	for (let i = 0; i < 40 && !frames.some((f) => f.type === "sessions"); i++) { await sleep(100); oldWaitMs += 100; }

	sync.send(JSON.stringify({
		type: "put", id: SESSION,
		jsonl: [JSON.stringify({ id: SESSION, modelId: "faux-1", thinkingLevel: "high", title: "race", messageCount: MESSAGES.length }), ...MESSAGES.map((m) => JSON.stringify(m))].join("\n"),
	}));

	// 1) the read the OLD suite would have made right after that wait
	const early = await get(`/api/agent/session/${SESSION}`);
	console.log(`connect-time 'sessions' frame satisfied the old wait after ${oldWaitMs}ms (that is the trap)`);
	console.log(`immediate read: status=${early.status} exists=${early.body?.exists} messages=${early.body?.messages?.length ?? 0} body=${early.text.length}B`);
	const earlyRange = await get(`/api/agent/session/${SESSION}/range?fromSeq=0&toSeq=3`);
	const earlyLines = earlyRange.text.split(String.fromCharCode(10)).filter(Boolean).length;
	console.log(`immediate /range: status=${earlyRange.status} lines=${earlyLines} (the CI log said "lines=1")`);

	// 2) the CONTENT-based readiness the suite now uses
	const t0 = Date.now();
	let ready = null;
	for (let i = 0; i < 100; i++) {
		const r = await get(`/api/agent/session/${SESSION}`);
		if (r.body?.exists === true && (r.body?.messages?.length || 0) >= MESSAGES.length) { ready = r; break; }
		await sleep(100);
	}
	console.log(`content-based readiness: converged=${!!ready} after ${Date.now() - t0}ms exists=${ready?.body?.exists} messages=${ready?.body?.messages?.length}`);

	const img = (ready?.body?.messages || []).flatMap((m) => (Array.isArray(m?.content) ? m.content : [])).find((p) => p?.type === "image");
	console.log(`image part: ${img ? `hash=${String(img.hash).slice(0, 10)} bytes=${img.bytes} inline_data=${img.data !== undefined}` : "MISSING (the CI failure)"}`);
	console.log(`\nverdict: the CI failure is a READINESS RACE, not an egress regression — ${early.body?.exists === false ? "reproduced (the immediate read is empty)" : "not reproduced on this machine (the store answered immediately), but the readiness now does not depend on timing"}`);
	sync.close();
} finally {
	await srv.stop();
}
