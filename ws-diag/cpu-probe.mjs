// cpu-probe.mjs — is OUR server burning the CPU while a session streams (which would slow
// everything else on the machine, including a separate LLM client)?
//
// Context (2026-10-28): a direct pi-ai call in a SEPARATE process went 13s → 48s while a web
// session streamed; the TUI's own request shape is identical to ours (captured via
// ws-diag/log-proxy.mjs), and its time varies 2-30s for the same prompt. So the question is
// whether the streaming path costs real CPU here: per-delta frames carry the WHOLE
// in-flight message, each >1KB frame goes through permessage-deflate level 6, and the hub
// re-serializes + redacts per broadcast.
//
// Reports, over a load window (one web session streaming a long answer):
//   * the server process's CPU seconds consumed (PowerShell TotalProcessorTime delta)
//   * machine CPU% (os.cpus() deltas) avg/max
//   * this probe process's own event-loop lag (a 50ms timer; big overshoot = the box is busy)
//   * a direct pi-ai call time before/during (the "other client" experience)
//
// Usage: node ws-diag/cpu-probe.mjs [baseUrl] [model] [provider]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import WebSocket from "ws";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PI_DIR = process.env.PI_DIR || "C:/pi-windows-x64/.pi";
const argv = process.argv.slice(2);
const BASE = argv[0] || "http://localhost:8787";
const MODEL = argv[1] || "z-ai/glm-5.3-flash";
const PROVIDER = argv[2] || "nvidia";
const PROMPT = "Reply with exactly: OK";
const TOKEN = (() => { try { return fs.readFileSync(path.join(ROOT, "data", "auth-token.txt"), "utf8").trim(); } catch { return ""; } })();
const WS_URL = BASE.replace(/^http/, "ws") + "/ws/agent" + (TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : "");
const KEY = (() => { try { const a = JSON.parse(fs.readFileSync(path.join(PI_DIR, "auth.json"), "utf8")); return typeof a[PROVIDER] === "string" ? a[PROVIDER] : a[PROVIDER]?.key; } catch { return ""; } })();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Number(process.hrtime.bigint() / 1000000n);
const model = { ...( (() => { try { return (getBuiltinModels(PROVIDER) || []).find((m) => m.id === MODEL); } catch { return null; } })() || {}), id: MODEL, provider: PROVIDER, api: "openai-completions", baseUrl: "https://integrate.api.nvidia.com/v1" };

async function directCall() {
	const t0 = now();
	let first = null;
	try {
		const stream = await streamSimple(model, { messages: [{ role: "user", content: [{ type: "text", text: PROMPT }] }] }, { apiKey: KEY, thinkingLevel: "low" });
		for await (const ev of stream) { if ((ev.type === "text_delta" || ev.type === "thinking_delta") && first == null) first = now() - t0; }
	} catch { /* reported as NONE */ }
	return { first, total: now() - t0 };
}

function serverCpuSeconds() {
	try {
		const pid = execFileSync("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${process.argv[4] || SERVER_PID}).TotalProcessorTime.TotalSeconds`], { encoding: "utf8" }).trim();
		return Number(pid);
	} catch { return null; }
}

function machineCpuSnapshot() {
	let idle = 0, total = 0;
	for (const c of os.cpus()) { for (const t of Object.values(c.times)) total += t; idle += c.times.idle; }
	return { idle, total };
}

// server pid from the listening socket
const SERVER_PID = (() => {
	try {
		const out = execFileSync("netstat", ["-ano"], { encoding: "utf8" });
		for (const line of out.split("\n")) {
			if (line.includes(":8787") && line.includes("LISTENING")) return line.trim().split(/\s+/).pop();
		}
	} catch { /* noop */ }
	return "";
})();
console.log(`[cpu] server pid ${SERVER_PID || "(unknown)"} · ${PROVIDER}/${MODEL}`);

const newId = async () => (await (await fetch(`${BASE}/api/sessions`, { method: "POST" })).json()).sessionId;
const loadId = await newId();
const load = await new Promise((resolve, reject) => {
	const ws = new WebSocket(WS_URL);
	const c = { ws, total: null, chars: 0 };
	ws.on("open", () => ws.send(JSON.stringify({ type: "attach", sessionId: loadId, modelId: MODEL, tailFirst: false })));
	ws.on("message", (raw) => {
		let m; try { m = JSON.parse(raw.toString()); } catch { return; }
		if (m.type === "state") { resolve(c); return; }
		if (m.type === "agent-event" && m.event?.type === "agent_end") c.total = 1;
		if (m.type === "agent-event" && m.event?.type === "message_update") c.chars++;
	});
	ws.on("error", reject);
});
await sleep(800);

console.log("[cpu] direct pi-ai call BEFORE load…");
const before = await directCall();
console.log(`      first ${before.first == null ? "NONE" : Math.round(before.first) + "ms"} · total ${Math.round(before.total)}ms`);

// ---- load window ----
load.ws.send(JSON.stringify({ type: "prompt", id: `l${Date.now()}`, content: "Write 200 numbered lines, one short sentence each. No preamble." }));
const l0 = now();
const cpu0 = serverCpuSeconds();
const s0 = machineCpuSnapshot();
let lagMax = 0, cpuMax = 0, n = 0;
let last = now();
const timer = setInterval(() => {
	const t = now();
	lagMax = Math.max(lagMax, t - last - 250);
	last = t;
	const a = machineCpuSnapshot();
	const busy = 1 - (a.idle - s0.idle) / Math.max(1, a.total - s0.total);
	cpuMax = Math.max(cpuMax, busy);
	n++;
}, 250);
// keep the load going: re-prompt while it is running
const keepAlive = setInterval(() => { if (load.total == null) load.ws.send(JSON.stringify({ type: "prompt", id: `k${Date.now()}`, content: "Continue with the next 50 lines." })); }, 20000);
await sleep(30000);
const cpu1 = serverCpuSeconds();
clearInterval(timer); clearInterval(keepAlive);
const windowSec = (now() - l0) / 1000;
console.log(`[cpu] LOAD window ${windowSec.toFixed(1)}s · frames seen ${load.chars}`);
console.log(`      server CPU: ${cpu0 == null || cpu1 == null ? "n/a" : (cpu1 - cpu0).toFixed(2) + "s over " + windowSec.toFixed(1) + "s → " + (((cpu1 - cpu0) / windowSec) * 100).toFixed(0) + "% of one core"}`);
console.log(`      machine CPU (sampled ${n}x): max ${(cpuMax * 100).toFixed(0)}%`);
console.log(`      probe event-loop lag: max ${Math.round(lagMax)}ms`);

console.log("[cpu] direct pi-ai call DURING load…");
const during = await directCall();
console.log(`      first ${during.first == null ? "NONE" : Math.round(during.first) + "ms"} · total ${Math.round(during.total)}ms`);

load.ws.close();
await fetch(`${BASE}/api/agent/discard`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: loadId }) }).catch(() => {});
console.log("\n[read] server CPU near 100% of a core + big probe lag → our streaming path starves the box.");
process.exit(0);
