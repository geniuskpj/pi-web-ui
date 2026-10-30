// latency-probe.mjs — WHY is an assistant turn delayed while ANOTHER session generates?
//
// User report (2026-10-28): "Assist turn is delayed while other session is generating.
// I checked tui got response in 1~2sec for glm-5.3-flash".
//
// What it measures, against the RUNNING server, for one tiny prompt ("Reply with exactly: OK"):
//   message_start → first delta of ANY kind (thinking counts!) → first TEXT delta → turn end
// in three windows: idle, while a second session streams, and after it. It also samples
// `GET /api/health` (a trivial request: a slow answer = the server's event loop is blocked)
// and — the CONTROL — times the same prompt through the pi CLI in a separate process, so
// "the provider is just slow right now" can be told apart from "our path is slow".
//
// Usage: node ws-diag/latency-probe.mjs [baseUrl] [model] [--no-background] [--no-tui]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import WebSocket from "ws";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PI_ROOT = path.resolve(ROOT, "..", ".."); // C:/pi-windows-x64
const argv = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const NO_BG = process.argv.includes("--no-background");
const NO_TUI = process.argv.includes("--no-tui");
const BASE = argv[0] || "http://localhost:8787";
const MODEL = argv[1] || "z-ai/glm-5.3-flash";
const PROVIDER = argv[2] || "nvidia";
const TOKEN = (() => { try { return fs.readFileSync(path.join(ROOT, "data", "auth-token.txt"), "utf8").trim(); } catch { return ""; } })();
const WS_URL = BASE.replace(/^http/, "ws") + "/ws/agent" + (TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : "");
const PROMPT = "Reply with exactly: OK";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Number(process.hrtime.bigint() / 1000000n);
const fmt = (ms) => (ms == null ? "—" : `${Math.round(ms)}ms`);
const row = (label, r) => `${label.padEnd(30)} start ${fmt(r.start).padStart(7)} · first-any ${fmt(r.any).padStart(7)} · first-text ${fmt(r.text).padStart(7)} · turn ${fmt(r.total).padStart(7)} (${r.chars} chars)`;

const newSessionId = async () => (await (await fetch(`${BASE}/api/sessions`, { method: "POST" })).json()).sessionId;

function connect(sessionId, thinkingLevel) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(WS_URL);
		const c = { ws, sessionId, t: {} };
		ws.on("open", () => {
			ws.send(JSON.stringify({ type: "attach", sessionId, modelId: MODEL, thinkingLevel, tailFirst: false }));
			if (thinkingLevel) ws.send(JSON.stringify({ type: "set-thinking", level: thinkingLevel }));
		});
		ws.on("message", (raw) => {
			let m; try { m = JSON.parse(raw.toString()); } catch { return; }
			if (m.type === "state") { resolve(c); return; }
			if (m.type === "agent-event") {
				const ev = m.event || {};
				const dt = now() - c.sentAt;
				if (ev.type === "message_start" && c.t.start == null) c.t.start = dt;
				if (ev.type === "message_update" && ev.message?.role === "assistant") {
					const parts = ev.message.content || [];
					const anyLen = parts.reduce((n, p) => n + ((p.text || p.thinking || "")).length, 0);
					if (anyLen > 0 && c.t.any == null) c.t.any = dt;
					const textLen = parts.filter((p) => p.type === "text").map((p) => p.text || "").join("").length;
					if (textLen > 0 && c.t.text == null) c.t.text = dt;
					c.t.chars = Math.max(c.t.chars || 0, textLen);
				}
				if (ev.type === "agent_end") c.t.total = dt;
			}
			if (m.type === "error") console.log("   [ws error]", m.error);
		});
		ws.on("error", reject);
		setTimeout(() => reject(new Error("attach timeout")), 20000);
	});
}

const runPrompt = async (c, text = PROMPT, timeoutMs = 120000) => {
	c.sentAt = now();
	c.t = { chars: 0 };
	const t0 = now();
	c.ws.send(JSON.stringify({ type: "prompt", id: `p${Date.now()}`, content: text }));
	while ((c.t.total == null) && now() - t0 < timeoutMs) await sleep(20);
	return { start: c.t.start ?? null, any: c.t.any ?? null, text: c.t.text ?? null, total: c.t.total ?? null, chars: c.t.chars || 0 };
};

function pingSampler(intervalMs = 100) {
	let max = 0, samples = 0, over200 = 0;
	let stop = false;
	(async () => {
		while (!stop) {
			const t = now();
			try { await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(20000) }); } catch { /* slow */ }
			const dt = now() - t;
			samples++; if (dt > max) max = dt; if (dt > 200) over200++;
			await sleep(intervalMs);
		}
	})();
	return { stop: () => { stop = false; return { max, samples, over200 }; } };
}

/** CONTROL: the same prompt through the pi CLI (separate process — its own HTTP connections). */
function tuiPrompt() {
	return new Promise((resolve) => {
		const t0 = now();
		let firstByte = null;
		const child = spawn(path.join(PI_ROOT, "pi.exe"), ["--no-session", "-p", PROMPT], { cwd: PI_ROOT, windowsHide: true });
		child.stdout.on("data", () => { if (firstByte == null) firstByte = now() - t0; });
		child.stderr.on("data", () => {});
		child.on("close", () => resolve({ first: firstByte, total: now() - t0 }));
		child.on("error", () => resolve({ first: null, total: null }));
	});
}

console.log(`[probe] base=${BASE} model=${PROVIDER}/${MODEL} token=${TOKEN ? "yes" : "none"} bg=${!NO_BG} tuiControl=${!NO_TUI}`);
const bgId = await newSessionId();
const fgId = await newSessionId();
const bg = await connect(bgId);
const fg = await connect(fgId); // thinking = session default (high)
const fgOff = null;
await sleep(1200);

const a = await runPrompt(fg);
console.log(row("[a] idle (default thinking)", a));

if (!NO_TUI) {
	const tui = await tuiPrompt();
	console.log(`${"[control] pi CLI (tui)".padEnd(30)} first output ${fmt(tui.first)} · done ${fmt(tui.total)}`);
}

if (!NO_BG) {
	bg.sentAt = now();
	bg.ws.send(JSON.stringify({ type: "prompt", id: `bg${Date.now()}`, content: "Write 120 numbered lines, one short sentence each. No preamble." }));
	const tBg = now();
	while (bg.t.any == null && now() - tBg < 60000) await sleep(20);
	console.log(`[b] background first output ${fmt(bg.t.any)}`);
	await sleep(2000);
	const sampler = pingSampler();
	const b = await runPrompt(fg);
	const s = sampler.stop();
	console.log(row("[b] other session streaming", b));
	console.log(`${"[b] /api/health while busy".padEnd(30)} max ${Math.round(s.max)}ms · >200ms ${s.over200}/${s.samples}`);
	const tEnd = now();
	while (bg.t.total == null && now() - tEnd < 300000) await sleep(100);
	console.log(`[b] background done (${bg.t.chars} chars)`);
	await sleep(1500);
	const c = await runPrompt(fg);
	console.log(row("[c] idle again", c));
} else {
	console.log("[probe] --no-background: only the idle + control numbers above (compare them)");
}

fg.ws.close(); bg.ws.close();
for (const id of [bgId, fgId]) {
	await fetch(`${BASE}/api/agent/discard`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: id }) }).catch(() => {});
}
console.log("[probe] scratch sessions discarded");
process.exit(0);
