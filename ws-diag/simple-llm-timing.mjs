// simple-llm-timing.mjs — STAGE-BY-STAGE timing of the LLM request our server makes,
// in plain code with no server, no hub, no WebSocket and no spawned process.
//
// Why: every earlier probe timed a whole turn from the outside, so the number mixed our
// process, the spawn, the socket and the endpoint. This one prints, per request:
//
//   dns/socket → tls → headers(ttfb) → first byte → first reasoning token → first answer
//   token → end        (all ms from the moment we called request())
//
// It uses node's https module directly, so connect/TLS/TTFB are real socket events.
// Runs: 1 request alone · N requests in PARALLEL · 1 request alone again (drift check) ·
// optionally without the NVCF header and with a small max_tokens.
//
// Usage: node ws-diag/simple-llm-timing.mjs [burst] [model]
//   burst = how many parallel requests in the concurrency phase (default 3)
import https from "node:https";
import fs from "node:fs";

const PI_DIR = process.env.PI_DIR || "C:/pi-windows-x64/.pi";
const BURST = Number(process.argv[2] || 3);
const MODEL = process.argv[3] || "z-ai/glm-5.3-flash";
const HOST = "integrate.api.nvidia.com";
const PATH = "/v1/chat/completions";
const KEY = (() => {
	try {
		const a = JSON.parse(fs.readFileSync(`${PI_DIR}/auth.json`, "utf8"));
		return typeof a.nvidia === "string" ? a.nvidia : a.nvidia?.key;
	} catch { return ""; }
})();

const now = () => Number(process.hrtime.bigint() / 1000000n);
const f = (ms) => (ms == null ? "—" : String(Math.round(ms)));

/** One streaming request; every stage is stamped in `t`. */
function call({ label, maxTokens = 16, nvcf = true, prompt = "Reply with exactly: OK" }) {
	const t = { start: now() };
	const stage = (k) => { t[k] = now() - t.start; };
	const body = JSON.stringify({
		model: MODEL,
		messages: [{ role: "user", content: prompt }],
		stream: true,
		stream_options: { include_usage: true },
		max_tokens: maxTokens,
	});
	const headers = { authorization: `Bearer ${KEY}`, "content-type": "application/json", accept: "text/event-stream", "content-length": Buffer.byteLength(body) };
	if (nvcf) headers["NVCF-POLL-SECONDS"] = "3600";
	return new Promise((resolve) => {
		const req = https.request({ host: HOST, path: PATH, method: "POST", headers }, (res) => {
			stage("headers");
			t.status = res.statusCode;
			let buf = "", sawReasoning = false;
			res.on("data", (chunk) => {
				if (t.firstByte == null) stage("firstByte");
				buf += chunk.toString("utf8");
				let i;
				while ((i = buf.indexOf("\n")) >= 0) {
					const line = buf.slice(0, i).trim();
					buf = buf.slice(i + 1);
					if (!line.startsWith("data:")) continue;
					const payload = line.slice(5).trim();
					if (payload === "[DONE]") { stage("end"); continue; }
					let j; try { j = JSON.parse(payload); } catch { continue; }
					const d = j.choices?.[0]?.delta || {};
					if (d.reasoning_content && !sawReasoning) { sawReasoning = true; stage("firstReasoning"); }
					if (d.content && t.firstContent == null) stage("firstContent");
				}
			});
			res.on("end", () => { if (t.end == null) stage("end"); resolve({ label, t }); });
		});
		req.on("socket", (s) => {
			stage("socket");
			s.on("secureConnect", () => stage("tls"));
		});
		req.on("error", (e) => { t.error = e.message; stage("end"); resolve({ label, t }); });
		req.end(body);
	});
}

const row = (r) => {
	const t = r.t;
	const thinking = t.firstReasoning == null ? "no-thinking" : `thinking@${f(t.firstReasoning)}`;
	return `${r.label.padEnd(26)} status ${String(t.status ?? "-").padEnd(3)} socket ${f(t.socket).padStart(5)} tls ${f(t.tls).padStart(5)} ttfb ${f(t.headers).padStart(6)} firstByte ${f(t.firstByte).padStart(6)} firstContent ${f(t.firstContent).padStart(6)} end ${f(t.end).padStart(6)}  (${thinking})${t.error ? " ERR " + t.error : ""}`;
};

console.log(`[simple] ${MODEL} @ ${HOST} · burst=${BURST} · key ${KEY ? "yes" : "MISSING"}`);
console.log("\n(1) ONE request, nothing else:");
console.log("  " + row(await call({ label: "alone #1" })));

console.log(`\n(2) ${BURST} requests in PARALLEL (same key, same process):`);
const burst = await Promise.all(Array.from({ length: BURST }, (_, i) => call({ label: `parallel #${i + 1}` })));
for (const r of burst) console.log("  " + row(r));

console.log("\n(3) ONE request again (drift check):");
console.log("  " + row(await call({ label: "alone #2" })));

console.log("\n(4) A/B on the request fields (one at a time):");
console.log("  " + row(await call({ label: "no NVCF header", nvcf: false })));
console.log("  " + row(await call({ label: "max_tokens=131072", maxTokens: 131072 })));

console.log("\n[read] ttfb huge while socket/tls are small  → the ENDPOINT queued us (not our code).");
console.log("       socket/tls huge                        → local network/socket problem.");
console.log("       parallel #2+ much slower than #1       → the endpoint serializes concurrent calls on this key.");
process.exit(0);
