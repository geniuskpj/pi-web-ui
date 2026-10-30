// server-agent.e2e.mjs — the DEFAULT chat path end-to-end: the agent loop runs
// SERVER-side (agent-hub.mjs), so a run survives any client disconnect and every
// attached device sees the same live event stream.
//
//   A (PC)    attach → prompt (with a real bash tool call) → DISCONNECT mid-run
//   B (phone) attach mid-run → snapshot streaming=true → receives ALL live events → agent_end
//   C (fresh) re-attach → full transcript from the JSONL mirror
//
// REQUIRES a working provider key in .pi/auth.json (costs ONE short LLM call).
// Usage: node tests/server-agent.e2e.mjs
import WebSocket from "ws";
// (D below uses a /ws/sync socket — the discovery channel)
import fs from "node:fs";
import path from "node:path";
import { startScratchServer } from "./_scratch-server.mjs";
import { MODEL_WAIT_MS } from "./_wait.mjs"; // provider latency can exceed 15s; the wait is env-tunable

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = await startScratchServer();
const SESSION = "serveragent" + Math.random().toString(36).slice(2, 10) + "e2e";
const url = `ws://127.0.0.1:${srv.port}/ws/agent?session=${SESSION}&token=${encodeURIComponent(srv.token)}`;

function client(name) {
	const ws = new WebSocket(url);
	const state = { events: [], messages: [], isStreaming: false, errors: 0 };
	ws.on("message", (raw) => {
		let m; try { m = JSON.parse(String(raw)); } catch { return; }
		if (m.type === "state") {
			state.messages = m.messages || [];
			state.isStreaming = !!m.isStreaming;
			log(`[${name}] snapshot: msgs=${state.messages.length} streaming=${state.isStreaming} model=${m.model?.id || "?"}`);
		} else if (m.type === "agent-event") {
			const ev = m.event || {};
			state.events.push(ev.type);
			if (ev.type === "agent_start") state.isStreaming = true; // poll trigger — was missing, broke the disconnect timing
			if (ev.type === "agent_end") { state.isStreaming = false; log(`[${name}] agent_end (events=${state.events.length})`); }
			if (ev.type === "message_end" && ev.message?.role === "assistant") {
				const text = (ev.message.content || []).filter((c) => c.type === "text").map((c) => c.text).join(" ");
				log(`[${name}] assistant: ${text.slice(0, 100).replace(/\n/g, " ")}`);
			}
			if (ev.type === "tool_execution_start") log(`[${name}] tool start`);
			if (ev.type === "tool_execution_update") log(`[${name}] tool partial (live)`);
		} else if (m.type === "accepted") log(`[${name}] accepted queued=${m.queued}`);
		else if (m.type === "error") { state.errors++; log(`[${name}] ERROR: ${m.error}`); }
	});
	return { ws, state, name };
}

try {
	const Dws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws/sync?token=${encodeURIComponent(srv.token)}`);
const runtimeFrames = [];
let Dopen = false;
Dws.on("open", () => (Dopen = true));
Dws.on("message", (raw) => { try { const m = JSON.parse(String(raw)); if (m.type === "runtime") runtimeFrames.push(m.runtime); if (m.type === "sessions") for (const x of m.sessions || []) if (x.id === SESSION && x.runtime) runtimeFrames.push(x.runtime); } catch {} });
await new Promise((r) => Dws.on("open", r));
log("--- D (third device, sync channel) listening for runtime frames ---");

const A = client("A-pc");
	await new Promise((r) => A.ws.on("open", r));
	A.ws.send(JSON.stringify({ type: "attach", sessionId: SESSION, modelId: "z-ai/glm-5.3-flash", thinkingLevel: "low" }));
	await sleep(600);
	log("--- A sends prompt (bash tool), will disconnect mid-run ---");
	// sleep 3 inside the tool call guarantees a long tool window — a fixed
	// disconnect delay raced fast models and let the whole run finish first
	A.ws.send(JSON.stringify({ type: "prompt", content: "Run the bash command `sleep 3 && echo pi-web-server-agent-test` and tell me its exit code. Be brief." }));
	// disconnect as soon as the run is OBSERVED streaming
	const d0 = Date.now();
	while (Date.now() - d0 < MODEL_WAIT_MS && !A.state.isStreaming) await sleep(100);
	await sleep(300);
	log("--- A DISCONNECTS mid-run (simulated browser close) ---");
	const aStreamingAtDisconnect = A.state.isStreaming;
	A.ws.terminate();
	await sleep(1500);

	log("--- B (phone) attaches mid-run ---");
	const B = client("B-phone");
	await new Promise((r) => B.ws.on("open", r));
	B.ws.send(JSON.stringify({ type: "attach", sessionId: SESSION }));
	const deadline = Date.now() + MODEL_WAIT_MS;
	while (Date.now() < deadline && !B.state.events.includes("agent_end")) await sleep(500);
	log("--- C re-attaches AFTER completion (fresh device) ---");
	const C = client("C-reconnect");
	await new Promise((r) => C.ws.on("open", r));
	C.ws.send(JSON.stringify({ type: "attach", sessionId: SESSION }));
	await sleep(1200);
	const lastAssistant = [...C.state.messages].reverse().find((m) => m.role === "assistant");
	const text = lastAssistant ? (lastAssistant.content || []).filter((c) => c.type === "text").map((c) => c.text).join(" ") : "";
	log("C transcript messages:", C.state.messages.length, "| last assistant:", text.slice(0, 140).replace(/\n/g, " "));

	const jsonlPath = path.join(srv.dataDir, "sessions", SESSION + ".jsonl");
	const jsonl = fs.existsSync(jsonlPath) ? fs.readFileSync(jsonlPath, "utf8") : "";
	const sawRunning = runtimeFrames.some((rt) => rt.sessionId === SESSION && rt.status === "running");
	const sawTerminal = runtimeFrames.some((rt) => rt.sessionId === SESSION && (rt.status === "idle" || rt.status === "error"));
	const lastRt = runtimeFrames.filter((rt) => rt.sessionId === SESSION).pop();
	const results = {
		"D saw runtime running (other-device discovery)": sawRunning,
		"D saw the terminal state (idle/error) after agent_end": sawTerminal,
		"lastText preview reached detached device": runtimeFrames.some((rt) => rt.sessionId === SESSION && typeof rt.lastText === "string" && rt.lastText.length > 0),
		"runtime carried seq (stale-guard ready)": typeof lastRt?.seq === "number",
		"A was streaming at disconnect": aStreamingAtDisconnect,
		"B saw the session complete (mid-run or after)": B.state.events.includes("agent_end") || B.state.messages.length >= 4,
		"tool executed server-side (bash)": B.state.events.includes("tool_execution_start") || A.state.events.includes("tool_execution_start") || jsonl.includes("toolResult"),
		"C got full transcript (>=4 msgs, written AFTER A left)": C.state.messages.length >= 4,
		"transcript mentions the echo output": /pi-web-server-agent-test/.test(text) || /pi-web-server-agent-test/.test(jsonl),
		"JSONL persisted server-side": jsonl.length > 100,
		"zero protocol errors on A/B/C": !A.state.errors && !B.state.errors && !C.state.errors,
	};
	console.log("\n=== RESULTS ===");
	let fail = 0;
	for (const [k, v] of Object.entries(results)) { console.log((v ? "  ✓ " : "  ✗ ") + k); if (!v) fail++; }
	process.exitCode = fail ? 1 : 0;
} finally {
	await srv.stop();
}
