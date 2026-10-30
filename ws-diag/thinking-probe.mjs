// thinking-probe.mjs — why does the SAME prompt take 13-19s through pi-ai but 2-3s in the
// TUI? User: "you should use low effort for test. i confirm tui+low still got response in
// 2~3 sec".
//
// This calls pi-ai's streamSimple directly for thinkingLevel low/off/high, with and without
// the model's `NVCF-POLL-SECONDS` header, and DUMPS the request body we actually send (by
// wrapping global fetch) so the difference from the TUI is visible instead of guessed:
//   * if `low` arrives as no reasoning parameter at all → we never transmit the level
//   * if it arrives but the endpoint still thinks for 15s → the flag shape is wrong
//
// Usage: node ws-diag/thinking-probe.mjs [modelId] [provider]
import fs from "node:fs";
import path from "node:path";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";

const PI_DIR = process.env.PI_DIR || "C:/pi-windows-x64/.pi";
const MODEL_ID = process.argv[2] || "z-ai/glm-5.3-flash";
const PROVIDER = process.argv[3] || "nvidia";
const PROMPT = "Reply with exactly: OK";
const now = () => Number(process.hrtime.bigint() / 1000000n);
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(path.join(PI_DIR, f), "utf8")); } catch { return null; } };
const auth = readJson("auth.json") || {};
const KEY = typeof auth[PROVIDER] === "string" ? auth[PROVIDER] : auth[PROVIDER]?.key;

// ---- wrap global fetch to capture the request body we send -------------------
const realFetch = globalThis.fetch;
let lastBody = null;
globalThis.fetch = async (url, init) => {
	try { if (init?.body) lastBody = JSON.parse(String(init.body)); } catch { /* not JSON */ }
	return realFetch(url, init);
};

const base = (() => { try { return (getBuiltinModels(PROVIDER) || []).find((m) => m.id === MODEL_ID); } catch { return null; } })();
const model = { ...(base || {}), id: MODEL_ID, provider: PROVIDER, api: base?.api || "openai-completions", baseUrl: base?.baseUrl || "https://integrate.api.nvidia.com/v1", reasoning: base?.reasoning ?? true, input: base?.input || ["text"], cost: base?.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: base?.contextWindow || 128000, maxTokens: base?.maxTokens || 4096 };

const relevant = (b) => {
	if (!b) return "(no body captured)";
	const keys = ["model", "max_tokens", "max_completion_tokens", "reasoning_effort", "reasoning", "thinking", "chat_template_kwargs", "stream", "temperature", "top_p", "tool_choice", "stream_options"];
	const out = {};
	for (const k of keys) if (k in b) out[k] = b[k];
	out._messages = (b.messages || []).length;
	out._tools = (b.tools || []).length;
	return JSON.stringify(out);
};

async function run(label, { thinkingLevel, dropHeaders = false }) {
	const t0 = now();
	let first = null, think = 0, text = "", err = null;
	lastBody = null;
	try {
		const m = { ...model, apiKey: KEY };
		if (dropHeaders) m.headers = undefined;
		const stream = await streamSimple(m, { messages: [{ role: "user", content: [{ type: "text", text: PROMPT }] }] }, { apiKey: KEY, thinkingLevel });
		for await (const ev of stream) {
			if (ev.type === "thinking_delta") { think++; if (first == null) first = now() - t0; }
			if (ev.type === "text_delta") { if (first == null) first = now() - t0; text += ev.delta || ""; }
			if (ev.type === "error") err = ev.error?.errorMessage || "error";
		}
	} catch (e) { err = e?.message || String(e); }
	const total = now() - t0;
	console.log(`${label.padEnd(34)} total ${String(Math.round(total)).padStart(6)}ms · first ${String(first == null ? "NONE" : Math.round(first)).padStart(6)}ms · thinking-deltas ${String(think).padStart(4)} · text ${JSON.stringify(text.slice(0, 8))}${err ? " · ERR " + err : ""}`);
	console.log(`${"".padEnd(34)} → request: ${relevant(lastBody)}`);
}

console.log(`[probe] ${PROVIDER}/${MODEL_ID} · key ${KEY ? "yes" : "MISSING"} · model.headers=${JSON.stringify(model.headers || null)}`);
await run("low  (headers as-is)", { thinkingLevel: "low" });
await run("low  (no NVCF header)", { thinkingLevel: "low", dropHeaders: true });
await run("off  (headers as-is)", { thinkingLevel: "off" });
await run("high (headers as-is)", { thinkingLevel: "high" });
process.exit(0);
