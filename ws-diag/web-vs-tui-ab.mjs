// web-vs-tui-ab.mjs — the user's own comparison, measured in the SAME MINUTE, interleaved:
//
//   (1) the pi CLI, one simple prompt                          ← "TUI: 2-3s"
//   (2) a WEB session prompt while another WEB session is      ← "web UI: slow"
//       VERIFIABLY streaming (frames counted every 100ms)
//   (3) the SAME web session prompt with nothing else running  ← "web UI: 2-3s idle"
//
// The endpoint's TTFT swings 2s→50s within minutes (measured), so only back-to-back
// comparisons mean anything. Rounds repeat the trio; the load session is re-prompted so it
// is always mid-stream when the measured prompt fires.
//
// Usage: node ws-diag/web-vs-tui-ab.mjs [rounds] [model] [provider]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import WebSocket from "ws";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PI_ROOT = path.resolve(ROOT, "..", "..");
const PI_DIR = process.env.PI_DIR || path.join(PI_ROOT, ".pi");
const ROUNDS = Number(process.argv[2] || 3);
const MODEL = process.argv[3] || "z-ai/glm-5.3-flash";
const PROVIDER = process.argv[4] || "nvidia";
const QUESTION = "What tools can you see? Answer in one short sentence.";
const BASE = "http://localhost:8787";
const TOKEN = (() => { try { return fs.readFileSync(path.join(ROOT, "data", "auth-token.txt"), "utf8").trim(); } catch { return ""; } })();
const WS_URL = BASE.replace(/^http/, "ws") + "/ws/agent" + (TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Number(process.hrtime.bigint() / 1000000n);
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? Math.round(s[Math.floor(s.length / 2)]) : null; };

function wsClient(sessionId, tag) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(WS_URL);
		const c = { ws, tag, sessionId, first: null, total: null, frames: 0, sentAt: 0 };
		ws.on("open", () => ws.send(JSON.stringify({ type: "attach", sessionId, modelId: MODEL, tailFirst: false })));
		ws.on("message", (raw) => {
			let m; try { m = JSON.parse(raw.toString()); } catch { return; }
			if (m.type === "state") { resolve(c); return; }
			if (m.type === "agent-event") {
				const ev = m.event || {};
				const dt = now() - c.sentAt;
				if (ev.type === "message_update") {
					c.frames++;
					const parts = ev.message?.content || [];
					if (c.first == null && parts.some((p) => (p.text || p.thinking || "").length > 0)) c.first = dt;
				}
				if (ev.type === "agent_end") c.total = dt;
			}
		});
		ws.on("error", reject);
	});
}
const ask = (c, text) => { c.sentAt = now(); c.first = null; c.total = null; c.ws.send(JSON.stringify({ type: "prompt", id: `p${Date.now()}`, content: text })); };
const waitFirst = async (c, cap = 120000) => { const t0 = now(); while (c.first == null && now() - t0 < cap) await sleep(15); return c.first; };

// Some launchers (e.g. a shell spawned by the web server) pass the agent dir WITH surrounding
// quotes — `pi` then dies with `mkdir 'C:\…\'C:\…\.pi''`. Strip them so the control actually runs.
const cleanPath = (v, fallback) => {
	let s = String(v ?? "").trim();
	if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) s = s.slice(1, -1);
	return s ? s.replace(/\\/g, "/") : fallback;
};

function tuiPrompt() {
	return new Promise((resolve) => {
		const t0 = now();
		let first = null;
		const agentDir = cleanPath(process.env.PI_CODING_AGENT_DIR || process.env.PI_DIR, PI_DIR.replace(/\\/g, "/"));
		const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_DIR: agentDir, PI_WS: cleanPath(process.env.PI_WS, PI_ROOT.replace(/\\/g, "/")) };
		const child = spawn(path.join(PI_ROOT, "pi.exe"), ["--no-session", "-p", QUESTION, "--model", `${PROVIDER}/${MODEL}:low`, "--mode", "text"], { cwd: HERE, env, windowsHide: true });
		child.stdout.on("data", () => { if (first == null) first = now() - t0; });
		child.stderr.on("data", () => {});
		const k = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 150000);
		child.on("close", () => { clearTimeout(k); resolve({ first, total: now() - t0 }); });
		child.on("error", () => { clearTimeout(k); resolve({ first: null, total: now() - t0 }); });
	});
}

const newId = async () => (await (await fetch(`${BASE}/api/sessions`, { method: "POST" })).json()).sessionId;
const loadId = await newId(), probeId = await newId();
const load = await wsClient(loadId, "load");
const probe = await wsClient(probeId, "probe");
await sleep(1000);

const tui = [], webIdle = [], webBusy = [], frameRates = [];
for (let i = 1; i <= ROUNDS; i++) {
	console.log(`--- round ${i} @ ${new Date().toISOString().slice(11, 19)}`);
	// (1) TUI
	const t = await tuiPrompt();
	tui.push(t.first ?? t.total);
	console.log(`  (1) TUI            first output ${t.first == null ? "NONE" : Math.round(t.first) + "ms"} · total ${Math.round(t.total)}ms`);

	// (3) web, nothing else running (taken BEFORE starting the load: the TUI round just finished)
	ask(probe, QUESTION);
	const idle = await waitFirst(probe);
	while (probe.total == null) await sleep(50);
	webIdle.push(idle ?? probe.total);
	console.log(`  (2) web, idle      first output ${idle == null ? "NONE" : Math.round(idle) + "ms"} · total ${Math.round(probe.total)}ms`);

	// (2) web while the load session streams — verify frames are actually flowing
	if (load.total != null || load.frames === 0) ask(load, "Write 200 numbered lines, one short sentence each. No preamble.");
	else ask(load, "Continue with 100 more numbered lines.");
	const tL = now();
	while (load.frames < 3 && now() - tL < 90000) await sleep(50);
	const f0 = load.frames;
	ask(probe, QUESTION);
	const busy = await waitFirst(probe);
	const windowMs = now() - tL;
	while (probe.total == null) await sleep(50);
	const fps = Math.round(((load.frames - f0) / Math.max(1, windowMs)) * 1000);
	frameRates.push(fps);
	webBusy.push(busy ?? probe.total);
	console.log(`  (3) web + load     first output ${busy == null ? "NONE" : Math.round(busy) + "ms"} · total ${Math.round(probe.total)}ms · load stream ${fps} frames/s while measuring`);
	if (load.total != null) load.frames = 0; // load finished → next round restarts it
	// let the load run into the next round a bit
	await sleep(500);
}
console.log(`\n[summary] TUI median ${med(tui)}ms · web idle median ${med(webIdle)}ms · web+busy median ${med(webBusy)}ms`);
console.log(`[summary] load streaming during the busy rounds: ${frameRates.join(", ")} frames/s`);
probe.ws.close(); load.ws.close();
for (const id of [loadId, probeId]) await fetch(`${BASE}/api/agent/discard`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: id }) }).catch(() => {});
process.exit(0);
