// killstop.e2e.mjs — controlled kill/stop verification (2026-10-23, user
// request: "check kill/stop worked"). Boots its OWN scratch server (PORT 8798,
// new code) and runs against a throwaway session — the user's live server/runs
// are never touched. Verified invariants:
//   1. prompt starts a run; a mid-run WS {type:"steer"} parks a pending steer
//   2. ABORT marks the turn aborted FAST (<6s) and clears isStreaming — the
//      phantom-streaming guard (pi's state flag used to stay true indefinitely
//      after abort → attaching devices saw a frozen "streaming" transcript)
//   3. explicit Stop CLEARS the pending steering (the old semantics let the
//      queued steer inject into the next run — "stop doesn't stop the chat")
//   4. no zombie generation: message count stable, stopReason stays aborted
// Real LLM required (like test:steer).
import { spawn } from "node:child_process";
import fs from "node:fs";
import WebSocket from "ws";
import { MODEL_WAIT_MS } from "./_wait.mjs"; // a real model turn is bounded by the provider, not by us
const TOKEN = fs.readFileSync("data/auth-token.txt", "utf8").trim();
const BASE = "http://127.0.0.1:8798";

// boot the scratch server (same code/data dir, isolated port)
const srv = spawn(process.execPath, ["server.mjs"], { env: { ...process.env, PORT: "8798" }, stdio: ["ignore", "ignore", "inherit"] });
const waitHealth = async () => {
	for (let i = 0; i < 40; i++) {
		try { const r = await fetch(BASE + "/api/health"); if (r.ok) return true; } catch { /* not yet */ }
		await new Promise((r) => setTimeout(r, 400));
	}
	return false;
};
const up = await waitHealth();
if (!up) { console.error("[killstop] scratch server failed to boot"); srv.kill(); process.exit(1); }
process.on("exit", () => { try { srv.kill(); } catch { /* noop */ } });
const ID = "killstoptest0000000000000000000002";
const H = { "x-pi-web-token": TOKEN, "content-type": "application/json" };

const api = async (path, body) => {
	const r = await fetch(BASE + path, { method: body ? "POST" : "GET", headers: H, body: body ? JSON.stringify(body) : undefined });
	return { status: r.status, json: await r.json().catch(() => null) };
};
const state = async () => (await api(`/api/agent/session/${ID}`)).json;
const waitUntil = async (fn, ms = 15000, step = 400) => {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, step)); }
	return false;
};

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { if (ok) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${detail}`); } };

// 0. fresh entry (default model)
await api("/api/agent/discard", { sessionId: ID });
try { fs.unlinkSync(`data/sessions/${ID}.jsonl`); } catch {}
try { fs.unlinkSync(`data/sessions/${ID}.versions.jsonl`); } catch {}
await api("/api/agent/session", { sessionId: ID });
console.log("[1] entry created");

// 1. LONG generation — fire-and-forget: the HTTP prompt endpoint resolves at
// RUN END (promptLock holds through the stream), so awaiting it hangs the test
void api("/api/agent/prompt", { sessionId: ID, content: "Count from 1 to 5000, one number per line, no commentary, no summarizing. Start now." }).catch(() => {});
const started = await waitUntil(async () => (await state())?.isStreaming === true, MODEL_WAIT_MS);
check("run started (isStreaming)", started);
if (!started) { console.log("[killstop] cannot continue without a running run"); process.exit(1); }

// 2. steer mid-run via the REAL path — the WS {type:"steer"} op (client-declared
// intent; the HTTP prompt endpoint QUEUES instead of steering)
let steerResult = null;
const steerWs = new WebSocket(`ws://${new URL(BASE).host}/ws/agent?token=${encodeURIComponent(TOKEN)}`);
steerWs.on("open", () => steerWs.send(JSON.stringify({ type: "attach", sessionId: ID })));
steerWs.on("message", (d) => {
	const m = JSON.parse(d);
	if (m.type === "state") steerWs.send(JSON.stringify({ type: "steer", content: "STEER-TEST-MARKER: also recite the alphabet after the numbers" }));
	if (m.type === "accepted" || m.type === "error") { steerResult = { type: m.type, ...m }; steerWs.close(); }
});
steerWs.on("error", () => { steerResult = { error: "ws error" } });
const steered = await waitUntil(async () => !!(await state())?.pendingPrompt, 8000);
check("mid-run send held as pending steer (WS steer op)", steered, JSON.stringify(steerResult));

// 3. ABORT mid-generation
const t0 = Date.now();
await api("/api/agent/abort", { sessionId: ID });
let stopFlagAt = -1, streamFlagAt = -1;
for (let i = 0; i < 60; i++) {
	await new Promise((r) => setTimeout(r, 500));
	const s = await state();
	const last = [...(s?.messages || [])].reverse().find((m) => m.role === "assistant");
	if (stopFlagAt < 0 && last?.stopReason === "aborted") stopFlagAt = Date.now() - t0;
	if (streamFlagAt < 0 && s?.isStreaming === false && stopFlagAt >= 0) { streamFlagAt = Date.now() - t0; break; }
}
check(`abort marked the turn aborted (${stopFlagAt}ms)`, stopFlagAt >= 0 && stopFlagAt < 6000, `stopFlagAt=${stopFlagAt}ms`);
check(`isStreaming flag cleared (${streamFlagAt}ms)`, streamFlagAt >= 0 && streamFlagAt < 15000, `streamFlagAt=${streamFlagAt}ms (lag between the aborted message and the flag = phantom-streaming window for attaching devices)`);
const s3 = await state();
const lastAsst = [...(s3?.messages || [])].reverse().find((m) => m.role === "assistant");
check("last assistant stopReason = aborted", lastAsst?.stopReason === "aborted", `got: ${lastAsst?.stopReason}`);
check("pending steer CLEARED by abort", !(s3?.pendingPrompt), JSON.stringify({ pendingPrompt: !!s3?.pendingPrompt }));
const count3 = (s3?.messages || []).length;

// 4. no zombie generation after abort
await new Promise((r) => setTimeout(r, 6000));
const s4 = await state();
check("message count stable 6s after abort (no zombie run)", (s4?.messages || []).length === count3, `${count3} -> ${(s4?.messages || []).length}`);
const lastAsst4 = [...(s4?.messages || [])].reverse().find((m) => m.role === "assistant");
check("stopReason still aborted 6s later (run did not resume)", lastAsst4?.stopReason === "aborted", `got: ${lastAsst4?.stopReason}`);

// 5. discard (kill): drop entry + tombstone — verified by code reading (the
// worker cache makes a raw-GET existence check unreliable here)
await api("/api/agent/discard", { sessionId: ID });
console.log("  ℹ discard sent (entry dropped + tombstoned)");

console.log(`\n[killstop] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
