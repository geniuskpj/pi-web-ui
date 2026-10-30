// concurrency-probe.mjs — is the "delayed while another session generates" latency the
// PROVIDER (per-key concurrency), the NVCF header, or the model?
//
// Evidence so far (2026-10-28):
//   * WS probe through the hub: first assistant output 18s idle-ish / 45s while a second
//     session streamed; /api/health stayed at 33ms (server loop NOT blocked).
//   * direct pi-ai `streamSimple` (separate process, no hub, no WS): 10-19s for the same
//     prompt — so the hub is not the cause.
//   * the pi CLI did the same prompt in 1.7s — in a window where NO other session was
//     streaming (the user's own observation: "2~3sec when there is no session generating").
//
// This runs, in ONE process against the SAME API key:
//   A) one call alone                    → baseline
//   B) two calls IN PARALLEL             → does a concurrent request get queued?
//   C) two calls running the same test with the NVCF-POLL-SECONDS header removed
//   D) two calls in parallel on a light non-reasoning nvidia model (if present)
//
// Usage: node ws-diag/concurrency-probe.mjs [modelId] [provider] [lightModelId]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PI_DIR = process.env.PI_DIR || "C:/pi-windows-x64/.pi";
const MODEL_ID = process.argv[2] || "z-ai/glm-5.3-flash";
const PROVIDER = process.argv[3] || "nvidia";
const LIGHT = process.argv[4] || "meta/llama-3.1-8b-instruct";
const PROMPT = "Reply with exactly: OK";
const now = () => Number(process.hrtime.bigint() / 1000000n);
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(path.join(PI_DIR, f), "utf8")); } catch { return null; } };
const auth = readJson("auth.json") || {};
const key = typeof auth[PROVIDER] === "string" ? auth[PROVIDER] : auth[PROVIDER]?.key;
const catalog = (id) => { try { return (getBuiltinModels(PROVIDER) || []).find((m) => m.id === id); } catch { return null; } };

/** One streamed call; returns {first, total, text, err}. */
async function call(model, { dropHeaders = false } = {}) {
	const t0 = now();
	let first = null, text = "", err = null;
	try {
		const m = { ...model, provider: PROVIDER, apiKey: key };
		if (dropHeaders) m.headers = undefined;
		const stream = await streamSimple(m, { messages: [{ role: "user", content: [{ type: "text", text: PROMPT }] }] }, { apiKey: key, thinkingLevel: "off" });
		for await (const ev of stream) {
			if (ev.type === "text_delta" || ev.type === "thinking_delta") { if (first == null) first = now() - t0; }
			if (ev.type === "text_delta") text += ev.delta || "";
			if (ev.type === "error") err = ev.error?.errorMessage || "error event";
		}
	} catch (e) { err = e?.message || String(e); }
	return { first, total: now() - t0, text: text.slice(0, 12), err };
}

const fmt = (r) => `first ${r.first == null ? "NONE" : Math.round(r.first) + "ms"} · total ${Math.round(r.total)}ms${r.err ? " · ERR " + r.err : ` · ${JSON.stringify(r.text)}`}`;

const glm = catalog(MODEL_ID) || { id: MODEL_ID, api: "openai-completions", baseUrl: "https://integrate.api.nvidia.com/v1", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 };
console.log(`[probe] ${PROVIDER}/${MODEL_ID} · key ${key ? "yes" : "MISSING"} · headers ${JSON.stringify(glm.headers || null)}`);

console.log("[A] single call (baseline)…");
console.log("    A:", fmt(await call(glm)));

console.log("[B] TWO calls in parallel (same key)…");
const b = await Promise.all([call(glm), call(glm)]);
b.forEach((r, i) => console.log(`    B${i + 1}:`, fmt(r)));

console.log("[C] TWO calls in parallel, NVCF header dropped…");
const c = await Promise.all([call(glm, { dropHeaders: true }), call(glm, { dropHeaders: true })]);
c.forEach((r, i) => console.log(`    C${i + 1}:`, fmt(r)));

const light = catalog(LIGHT);
if (light) {
	console.log(`[D] TWO calls in parallel on a LIGHT model (${LIGHT}, reasoning=${light.reasoning})…`);
	const d = await Promise.all([call(light), call(light)]);
	d.forEach((r, i) => console.log(`    D${i + 1}:`, fmt(r)));
} else {
	console.log(`[D] skipped — ${LIGHT} not in the catalog`);
}

console.log("\n[read] If B/C are much slower than A → the endpoint queues concurrent requests per key (provider-side, not our hub).");
console.log("       If D stays fast → it is model/endpoint capacity, not the key.");
process.exit(0);
