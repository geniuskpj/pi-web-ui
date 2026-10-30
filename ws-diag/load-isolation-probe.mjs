// load-isolation-probe.mjs — the decisive test for "assistant turn delayed while another
// session is generating" (user report 2026-10-28).
//
// Sets up a REAL load: one web session streaming a long answer through the hub (/ws/agent).
// While it streams, three probes fire and are timed:
//   (A) a direct pi-ai `streamSimple` call from this process   → bypasses the hub entirely
//   (B) the pi CLI in its own process (`pi.exe --no-session -p`)→ bypasses the hub entirely
//   (C) a prompt on ANOTHER web session through the hub        → the reported path
// A no-load baseline for (A) and (C) is taken first (and again after the load ends).
//
// If (A)/(B) stay fast while (C) is slow → the fault is in OUR server path.
// If all three slow down → the endpoint/GPU queues concurrent requests (provider capacity).
//
// Usage: node ws-diag/load-isolation-probe.mjs [baseUrl] [model] [provider]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PI_ROOT = path.resolve(ROOT, "..", "..");
const PI_DIR = process.env.PI_DIR || path.join(PI_ROOT, ".pi");
const argv = process.argv.slice(2);
const BASE = argv[0] || "http://localhost:8787";
const MODEL = argv[1] || "z-ai/glm-5.3-flash";
const PROVIDER = argv[2] || "nvidia";
const PROMPT = "Reply with exactly: OK";
const TOKEN = (() => { try { return fs.readFileSync(path.join(ROOT, "data", "auth-token.txt"), "utf8").trim(); } catch { return ""; } })();
const WS_URL = BASE.replace(/^http/, "ws") + "/ws/agent" + (TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : "");
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(path.join(PI_DIR, f), "utf8")); } catch { return null; } };
const auth = readJson("auth.json") || {};
const KEY = typeof auth[PROVIDER] === "string" ? auth[PROVIDER] : auth[PROVIDER]?.key;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Number(process.hrtime.bigint() / 1000000n);
const fmt = (r) => `${r.label}: first ${r.first == null ? "NONE" : Math.round(r.first) + "ms"} · total ${Math.round(r.total)}ms${r.err ? " · ERR " + r.err : ""}`;

const model = (() => { try { const m = (getBuiltinModels(PROVIDER) || []).find((x) => x.id === MODEL); return { ...m, provider: PROVIDER, apiKey: KEY }; } catch { return { id: MODEL, provider: PROVIDER, api: "openai-completions", baseUrl: "https://integrate.api.nvidia.com/v1", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }; } })();

async function directCall(label) {
	const t0 = now();
	let first = null, err = null, chars = 0;
	try {
		const stream = await streamSimple(model, { messages: [{ role: "user", content: [{ type: "text", text: PROMPT }] }] }, { apiKey: KEY, thinkingLevel: "off" });
		for await (const ev of stream) {
			if ((ev.type === "text_delta" || ev.type === "thinking_delta") && first == null) first = now() - t0;
			if (ev.type === "text_delta") chars += (ev.delta || "").length;
			if (ev.type === "error") err = ev.error?.errorMessage || "error event";
		}
	} catch (e) { err = e?.message || String(e); }
	return { label, first, total: now() - t0, chars, err };
}

function tuiCall(label) {
	return new Promise((resolve) => {
		const t0 = now();
		let first = null, chars = 0;
		const child = spawn(path.join(PI_ROOT, "pi.exe"), ["--no-session", "-p", PROMPT], { cwd: PI_ROOT, windowsHide: true });
		child.stdout.on("data", (b) => { if (first == null) first = now() - t0; chars += b.length; });
		child.stderr.on("data", () => {});
		child.on("close", () => resolve({ label, first, total: now() - t0, chars, err: null }));
		child.on("error", (e) => resolve({ label, first, total: now() - t0, chars, err: e.message }));
	});
}

async function webSession(sessionId) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(WS_URL);
		const c = { ws, first: null, total: null };
		ws.on("open", () => ws.send(JSON.stringify({ type: "attach", sessionId, modelId: MODEL, tailFirst: false })));
		ws.on("message", (raw) => {
			let m; try { m = JSON.parse(raw.toString()); } catch { return; }
			if (m.type === "state") { resolve(c); return; }
			if (m.type === "agent-event") {
				const ev = m.event || {};
				const dt = now() - c.sentAt;
				if (ev.type === "message_update" && c.first == null) {
					const parts = ev.message?.content || [];
					if (parts.some((p) => (p.text || p.thinking || "").length > 0)) c.first = dt;
				}
				if (ev.type === "agent_end") c.total = dt;
			}
		});
		ws.on("error", reject);
	});
}
const webPrompt = async (c, text) => {
	c.sentAt = now(); c.first = null; c.total = null;
	const t0 = now();
	c.ws.send(JSON.stringify({ type: "prompt", id: `p${Date.now()}`, content: text }));
	while (c.total == null && now() - t0 < 180000) await sleep(20);
	return { label: "web session (via hub)", first: c.first, total: c.total ?? now() - t0, chars: 0, err: null };
};

const newId = async () => (await (await fetch(`${BASE}/api/sessions`, { method: "POST" })).json()).sessionId;
console.log(`[probe] ${PROVIDER}/${MODEL} · key ${KEY ? "yes" : "MISSING"} · base ${BASE}`);
const loadId = await newId(), probeId = await newId();
const load = await webSession(loadId);
const probe = await webSession(probeId);

// ---------- baseline (no load) ----------
console.log("\n=== NO LOAD ===");
console.log("  " + fmt(await directCall("[A] direct pi-ai")));
console.log("  " + fmt(await webPrompt(probe, PROMPT)));

// ---------- with load ----------
console.log("\n=== LOAD: a second web session streaming a long answer ===");
load.sentAt = now();
load.ws.send(JSON.stringify({ type: "prompt", id: `load${Date.now()}`, content: "Write 150 numbered lines, one short sentence each. No preamble." }));
const tL = now();
while (load.first == null && now() - tL < 60000) await sleep(20);
console.log(`  [load] streaming (first output ${Math.round(load.first)}ms) — probing now`);
await sleep(1500);
console.log("  " + fmt(await directCall("[A] direct pi-ai")));
console.log("  " + fmt(await tuiCall("[B] pi CLI (tui)")));
console.log("  " + fmt(await webPrompt(probe, PROMPT)));
console.log(`  [load] still running: ${load.total == null ? "yes" : "no"}`);
const tEnd = now();
while (load.total == null && now() - tEnd < 300000) await sleep(100);

// ---------- after ----------
console.log("\n=== AFTER LOAD ===");
console.log("  " + fmt(await directCall("[A] direct pi-ai")));
console.log("  " + fmt(await webPrompt(probe, PROMPT)));

probe.ws.close(); load.ws.close();
for (const id of [loadId, probeId]) await fetch(`${BASE}/api/agent/discard`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: id }) }).catch(() => {});
console.log("\n[read] (A)/(B) fast + (C) slow → OUR hub path. All slow → the endpoint batches/queues concurrent requests.");
process.exit(0);
