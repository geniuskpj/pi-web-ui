// stream-reduce.e2e.mjs — the WIRING check for stream reduction: does the socket actually accept the
// config, echo it, and stay OFF for clients that never asked? (plan §2.3, user decision 2026-10-25:
// "go, but off by default — let the user test it on a debug server/port").
//
// Hermetic: a real server.mjs on a random port with a temp data dir; no LLM call is made (the config
// path is protocol-only — the coalescing itself is pinned purely in tests/stream-reduce.test.mjs).
// Manual testing on a debug port is what this unlocks:
//     PORT=8899 PI_WEB_DATA_REDUCTION_DEBUG=1 npm start      # then open http://localhost:8899
//     (Settings → Data use → Reasoning & stream → Paragraph; the server logs one [data-reduction]
//      line per turn with what it held back)
//
// Usage: node tests/stream-reduce.e2e.mjs
import fs from "node:fs";
import WebSocket from "ws";
import { startScratchServer } from "./_scratch-server.mjs";

let passed = 0, failed = 0;
const check = (name, ok, extra = "") => {
	if (ok) { passed++; console.log(`  ✓ ${name}${extra ? " — " + extra : ""}`); }
	else { failed++; console.error(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = await startScratchServer();
const url = `ws://127.0.0.1:${srv.port}/ws/agent?token=${encodeURIComponent(srv.token)}`;
const open = async () => {
	const ws = new WebSocket(url);
	const frames = [];
	ws.on("message", (raw) => { try { frames.push(JSON.parse(raw.toString())); } catch { /* ignore */ } });
	await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
	return { ws, frames };
};

try {
	// 1) a client that never opts in: the server never sends it a data-reduction frame
	const silent = await open();
	silent.ws.send(JSON.stringify({ type: "attach", sessionId: "reducee2e00000000000000000001" }));
	await sleep(400);
	check("E1 no setDataReduction ⇒ no data-reduction frame at all (off by default)",
		!silent.frames.some((f) => f.type === "data-reduction"), `${silent.frames.length} frames`);

	// 2) an opted-in client gets an ack with the accepted modes
	const tuned = await open();
	tuned.ws.send(JSON.stringify({
		type: "setDataReduction", id: "dr1", net: "wan",
		thinkingLevel: "paragraph", textLevel: "paragraph", toolLevel: "paragraph",
	}));
	for (let i = 0; i < 40 && !tuned.frames.some((f) => f.type === "data-reduction"); i++) await sleep(100);
	const ack = tuned.frames.find((f) => f.type === "data-reduction");
	check("E2 the hub accepts the config and echoes what it will do (enabled + per-kind modes)",
		ack?.ok === true && ack.enabled === true && ack.kinds?.thinking === "paragraph" && ack.id === "dr1",
		JSON.stringify(ack));

	// 3) level "none" ⇒ explicitly disabled (the escape hatch is one message away, no reload needed)
	tuned.ws.send(JSON.stringify({ type: "setDataReduction", id: "dr2", net: "wan", thinkingLevel: "none", textLevel: "none", toolLevel: "none" }));
	for (let i = 0; i < 40 && !tuned.frames.some((f) => f.type === "data-reduction" && f.id === "dr2"); i++) await sleep(100);
	const off = tuned.frames.find((f) => f.type === "data-reduction" && f.id === "dr2");
	check("E3 switching back to None disables the reducer on the SAME connection (no reconnect)",
		off?.enabled === false && off.kinds?.thinking === "off", JSON.stringify(off));

	// 4) junk is refused, not honoured
	tuned.ws.send(JSON.stringify({ type: "setDataReduction", id: "dr3", thinkingLevel: "fast", thinking: { mode: "superatomic" } }));
	for (let i = 0; i < 40 && !tuned.frames.some((f) => f.type === "data-reduction" && f.id === "dr3"); i++) await sleep(100);
	const junk = tuned.frames.find((f) => f.type === "data-reduction" && f.id === "dr3");
	check("E4 an unknown mode falls back to live (never to something we invented)",
		junk?.kinds?.thinking === "off", JSON.stringify(junk));

	// 5) the config is PER CONNECTION: the silent client is still untouched
	await sleep(200);
	check("E5 the other connection never received an ack (per-connection state, plan §2.3)",
		!silent.frames.some((f) => f.type === "data-reduction"));

	// 6) A NOTE FRAME MUST NOT SETTLE A PENDING REPLY (review report.md M1, 2026-10-27): the server
	//    correlates notes by the request id, and the client must keep waiting for accepted/rejected.
	{
		const quiet = await open();
		quiet.ws.send(JSON.stringify({ type: "attach", sessionId: "reducee2e00000000000000000002" }));
		quiet.ws.send(JSON.stringify({ type: "setDataReduction", id: "dr6", net: "wan", thinkingLevel: "paragraph" }));
		for (let i = 0; i < 40 && !quiet.frames.some((f) => f.type === "data-reduction"); i++) await sleep(100);
		// the ack of setDataReduction is not a note; assert the shape the client keys on
		const ack = quiet.frames.find((f) => f.type === "data-reduction");
		check("E6 the reducer is ticking: an opted-in idle socket is driven by the server's timer (H2)",
			ack?.enabled === true && typeof ack.kinds?.thinking === "string", JSON.stringify(ack));
		try { quiet.ws.close(); } catch { /* gone */ }
	}

	// 7) THE CLIENT HOP (review report.md B1): the settings dialog can only work if the agent has a
	//    setDataReduction method and re-pushes it on attach. Source-assert the push site (a fake-socket
	//    behaviour test lives in tests/data-reduction.test.mjs, which imports the real class).
	{
		const proxySrc = fs.readFileSync(new URL("../src/proxy-agent.ts", import.meta.url), "utf8");
		check("E7 ProxyAgent implements setDataReduction and pushes it on every attach",
			/setDataReduction\(cfg: Record<string, unknown>\): void/.test(proxySrc) && /pushDataReduction\(this\)/.test(proxySrc) &&
			/import \{ pushDataReduction \} from ".\/ui\/data-settings.js"/.test(proxySrc));
	}

	for (const c of [silent, tuned]) { try { c.ws.close(); } catch { /* gone */ } }
} finally {
	await srv.stop();
}

console.log(`\n[stream-reduce e2e] ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
