// steering.e2e.mjs — mid-run steering end-to-end against a REAL server + LLM.
//
//   1. prompt a run that calls bash (sleep 4) — a solid tool window
//   2. send a second message WHILE the tool runs → hub holds it as PENDING
//      (steering frame), injects it at the turn boundary (user message_end
//      BEFORE agent_end), and the run continues to answer it
//   3. second run: steer then CANCEL (steering-cancel) → pending cleared, the
//      steered text never enters the transcript
//
// REQUIRES a working provider key in .pi/auth.json (costs TWO short LLM calls).
// Usage: node tests/steering.e2e.mjs
import WebSocket from "ws";
import { startScratchServer } from "./_scratch-server.mjs";

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = await startScratchServer();
const SESSION = "steer" + Math.random().toString(36).slice(2, 10) + "e2e";
const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws/agent?session=${SESSION}&token=${encodeURIComponent(srv.token)}`);

const state = { messages: [], isStreaming: false, agentEnds: 0, pending: null, pendingFrames: 0, userTexts: [], accepts: [] };
let pendingWaiters = [];
const waitPending = (pred, timeoutMs = 30000) => new Promise((resolve, reject) => {
	const timer = setTimeout(() => { const i = pendingWaiters.indexOf(w); if (i >= 0) pendingWaiters.splice(i, 1); reject(new Error("pending-wait timeout")); }, timeoutMs);
	const w = { pred, resolve: (v) => { clearTimeout(timer); resolve(v); } };
	pendingWaiters.push(w);
});
const waitEvent = (pred, timeoutMs = 90000, label = "event") => new Promise((resolve, reject) => {
	const t0 = Date.now();
	const check = () => {
		if (pred()) { clearInterval(iv); resolve(true); return; }
		if (Date.now() - t0 > timeoutMs) { clearInterval(iv); reject(new Error(`timeout waiting for ${label}`)); }
	};
	const iv = setInterval(check, 100);
	check();
});

ws.on("message", (raw) => {
	let m; try { m = JSON.parse(String(raw)); } catch { return; }
	if (m.type === "state") {
		state.messages = m.messages || [];
		state.isStreaming = !!m.isStreaming;
		if (m.pendingPrompt !== undefined) { state.pending = m.pendingPrompt; state.pendingFrames++; }
		log(`snapshot: msgs=${state.messages.length} streaming=${state.isStreaming}`);
	} else if (m.type === "agent-event") {
		const ev = m.event || {};
		if (ev.type === "agent_start") { state.isStreaming = true; log("agent_start"); }
		else if (ev.type === "agent_end") { state.isStreaming = false; state.agentEnds++; log(`agent_end (#${state.agentEnds})`); }
		else if (ev.type === "message_end") {
			state.messages.push(ev.message);
			const textOf = (msg) => (typeof msg?.content === "string" ? msg.content : (msg?.content || []).filter((c) => c.type === "text").map((c) => c.text).join(" "));
			if (ev.message?.role === "user") {
				const text = textOf(ev.message);
				state.userTexts.push(text);
				log(`user message_end: ${text.slice(0, 60).replace(/\n/g, " ")}`);
			} else if (ev.message?.role === "assistant") {
				const text = textOf(ev.message);
				if (text) log(`assistant: ${text.slice(0, 80).replace(/\n/g, " ")}`);
			}
		}
		else if (ev.type === "tool_execution_start") log(`tool start: ${ev.toolName || ev.toolCallId || "?"}`);
	} else if (m.type === "steering") {
		state.pending = m.pending; state.pendingFrames++;
		log(`steering frame: pending=${m.pending ? JSON.stringify(m.pending.text?.slice(0, 40)) : "null"}`);
		for (const w of [...pendingWaiters]) if (w.pred(state)) { pendingWaiters.splice(pendingWaiters.indexOf(w), 1); w.resolve(true); }
	} else if (m.type === "accepted") {
		if (m.id) state.accepts.push(m);
		log(`accepted id=${m.id || "-"} queued=${m.queued}${m.reason ? ` reason=${m.reason}` : ""}`);
	} else if (m.type === "error") {
		log("ERROR:", m.error);
	}
});
const send = (obj) => ws.send(JSON.stringify(obj));
const prompt = (content) => send({ type: "prompt", content });

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
	if (cond) { pass++; console.log(`  ✓ ${name}`); }
	else { fail++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};

try {
	await new Promise((r, j) => { ws.on("open", r); ws.on("error", j); setTimeout(() => j(new Error("ws connect timeout")), 10000); });
	send({ type: "attach", sessionId: SESSION, modelId: "z-ai/glm-5.3-flash", thinkingLevel: "low" });
	await sleep(400); // attach → store hydrate → state snapshot

	// --- run 1: a bash tool call gives a wide steering window -------------------
	prompt("Use the bash tool to run exactly: sleep 4 && echo done — then briefly confirm the exit code. Keep the final reply under 20 words.");
	await waitEvent(() => state.messages.some((m) => m.role === "user"), 30000, "first user message");
	// wait until a tool is actually running (steer must land mid-run)
	await waitEvent(() => state.messages.some((m) => m.role === "toolResult") || (state.isStreaming && state.messages.length >= 2), 60000, "run in progress");
	await sleep(300); // ensure the hub registered isStreaming

	// --- steer mid-run -----------------------------------------------------------
	const STEER = "steer-alpha-7741: after you finish, explicitly mention the word steer-alpha-7741 once.";
	send({ type: "steer", id: "steer-1", content: STEER });
	// hub must acknowledge the pending hold
	let ok = true;
	try { await waitPending((s) => s.pending && String(s.pending.text || "").includes("steer-alpha-7741"), 15000); } catch { ok = false; }
	check("mid-run send becomes PENDING (steering frame)", ok, JSON.stringify(state.pending)?.slice(0, 80));
	check("pending payload has text+queuedAt", !!state.pending?.queuedAt && typeof state.pending.text === "string");
	// the accepted reply is sent in a microtask AFTER the broadcast steering frame — wait for it
	try { await waitEvent(() => state.accepts.some((a) => a.id === "steer-1"), 5000, "steer-1 accepted"); } catch { /* asserted below */ }
	check("accepted reply echoes the request id (composer-restore correlation)", state.accepts.some((a) => a.id === "steer-1" && a.accepted === true && a.queued === true), JSON.stringify(state.accepts));

	// the held message must be INJECTED at the turn boundary — a user message_end
	// with its text while the run is STILL streaming, before agent_end
	try {
		await waitEvent(() => state.userTexts.some((t) => t.includes("steer-alpha-7741")) && state.isStreaming, 60000, "steered user message injection");
		check("steered message injected at the thinking/toolcall boundary", true);
	} catch (e) {
		check("steered message injected at the thinking/toolcall boundary", false, e.message);
	}
	try {
		await waitPending((s) => s.pending === null, 60000);
		check("pending chip cleared after consumption", true);
	} catch {
		check("pending chip cleared after consumption", state.pending === null, JSON.stringify(state.pending)?.slice(0, 60));
	}
	try { await waitEvent(() => state.agentEnds >= 1, 90000, "agent_end"); check("run 1 completed", true); } catch { check("run 1 completed", false); }

	// --- run 2: steer then CANCEL ------------------------------------------------
	const nMsgs = state.messages.length;
	const nUser = state.userTexts.length;
	prompt("Use the bash tool to run exactly: sleep 4 && echo done — then reply with just: done");
	await waitEvent(() => state.messages.slice(nMsgs).some((m) => m.role === "toolResult") || (state.isStreaming && state.messages.length > nMsgs), 60000, "run 2 in progress");
	await sleep(300);
	const CANCEL = "cancel-marker-9931: this must never be answered.";
	send({ type: "steer", id: "steer-2", content: CANCEL });
	try { await waitPending((s) => s.pending && String(s.pending.text || "").includes("cancel-marker-9931"), 15000); } catch { /* fallthrough — assert below */ }
	check("run 2 steer registered as pending", !!state.pending && String(state.pending.text || "").includes("cancel-marker-9931"), JSON.stringify(state.pending)?.slice(0, 80));
	send({ type: "steering-cancel" });
	try { await waitPending((s) => s.pending === null, 15000); } catch { /* fallthrough */ }
	check("cancel clears the pending chip", state.pending === null, JSON.stringify(state.pending)?.slice(0, 60));
	// give the run time to finish; the cancelled text must NEVER enter the transcript
	await waitEvent(() => state.agentEnds >= 2, 90000, "run 2 agent_end");
	await sleep(1500);
	check("cancelled text never injected", !state.userTexts.slice(nUser).some((t) => t.includes("cancel-marker-9931")), JSON.stringify(state.userTexts.slice(nUser)).slice(0, 120));

	// --- run 3 (grok P1): Stop mid-run, then SEND — must start a NEW run, not
	// park a leftover steer (the client flips isStreaming=false on abort while
	// the hub is still unwinding; a {type:"prompt"} must wait on the lock and run)
	const endsBefore = state.agentEnds;
	prompt("Use the bash tool to run exactly: sleep 30 && echo never — stop as soon as you can.");
	await waitEvent(() => state.agentEnds >= endsBefore + 1 || state.messages.some((m) => m.role === "toolResult" && m.timestamp > Date.now() - 120000), 60000, "run 3 started");
	// ensure it's actually mid-run, then abort
	await sleep(300);
	const streamingAtAbort = state.isStreaming;
	send({ type: "abort" });
	await waitEvent(() => state.agentEnds >= endsBefore + 1, 30000, "aborted run agent_end");
	await sleep(500); // let the client-side isStreaming flip settle (test emulates the browser)
	const userBefore = state.userTexts.length;
	send({ type: "prompt", id: "post-stop", content: "reply with exactly: after-stop-ok" });
	try { await waitEvent(() => state.userTexts.slice(userBefore).some((t) => t.includes("after-stop-ok")), 60000, "post-stop user message"); } catch { /* asserted below */ }
	// the accepted reply resolves at RUN END (prompt() awaits the whole run) — wait for it
	try { await waitEvent(() => state.accepts.some((a) => a.id === "post-stop"), 90000, "post-stop accepted reply"); } catch { /* asserted below */ }
	check("post-Stop send starts a NEW run (not a parked steer)", state.userTexts.slice(userBefore).some((t) => t.includes("after-stop-ok")), JSON.stringify(state.userTexts.slice(userBefore)).slice(0, 100));
	check("post-Stop send accepted as a run (queued=false)", state.accepts.some((a) => a.id === "post-stop" && a.accepted === true && a.queued === false), JSON.stringify(state.accepts.filter((a) => a.id === "post-stop")));
	check("no leftover pending after post-Stop run", state.pending === null || !String(state.pending?.text || "").includes("after-stop"), JSON.stringify(state.pending)?.slice(0, 60));
} catch (err) {
	fail++;
	console.error("FATAL:", err.message);
} finally {
	try { ws.close(); } catch {}
}
console.log(`\n[steering-e2e] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
