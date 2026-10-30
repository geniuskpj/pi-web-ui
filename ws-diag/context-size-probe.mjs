// context-size-probe.mjs — does the FIRST-TOKEN time depend on the PROMPT SIZE?
//
// The web path always sends the whole transcript (pi web sessions grow to hundreds of
// messages), while a "pi --no-session -p" TUI run sends almost nothing. If TTFT scales with
// the prompt, then "the assistant turn is delayed" is mostly PREFILL cost (worse while the
// endpoint is busy with another generation), not a per-session lock in our hub.
//
// Usage: node ws-diag/context-size-probe.mjs [modelId] [provider]
import fs from "node:fs";
import path from "node:path";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";

const PI_DIR = process.env.PI_DIR || "C:/pi-windows-x64/.pi";
const MODEL = process.argv[2] || "z-ai/glm-5.3-flash";
const PROVIDER = process.argv[3] || "nvidia";
const auth = (() => { try { return JSON.parse(fs.readFileSync(path.join(PI_DIR, "auth.json"), "utf8")); } catch { return {}; } })();
const KEY = typeof auth[PROVIDER] === "string" ? auth[PROVIDER] : auth[PROVIDER]?.key;
const base = (() => { try { return (getBuiltinModels(PROVIDER) || []).find((m) => m.id === MODEL); } catch { return null; } })();
const model = { ...base, id: MODEL, provider: PROVIDER, apiKey: KEY };
const now = () => Number(process.hrtime.bigint() / 1000000n);
const LINE = "Context line: the quick brown fox jumps over the lazy dog, again and again. ";

async function run(label, lines) {
	const text = LINE.repeat(lines) + "\nReply with exactly: OK";
	const t0 = now();
	let first = null, err = null;
	try {
		const stream = await streamSimple(model, { messages: [{ role: "user", content: [{ type: "text", text }] }] }, { apiKey: KEY, thinkingLevel: "low" });
		for await (const ev of stream) {
			if ((ev.type === "text_delta" || ev.type === "thinking_delta") && first == null) first = now() - t0;
			if (ev.type === "error") err = ev.error?.errorMessage || "error";
		}
	} catch (e) { err = e?.message || String(e); }
	console.log(`${label.padEnd(22)} prompt ≈${String(Math.round(text.length / 4)).padStart(7)} tokens · first output ${String(first == null ? "NONE" : Math.round(first) + "ms").padStart(7)} · total ${String(Math.round(now() - t0) + "ms").padStart(7)}${err ? " · " + err : ""}`);
}

console.log(`[ctx] ${PROVIDER}/${MODEL} · key ${KEY ? "yes" : "MISSING"}`);
await run("tiny", 0);
await run("~20k tokens", 5000);
await run("~80k tokens", 20000);
process.exit(0);
