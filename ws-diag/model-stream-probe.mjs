// model-stream-probe.mjs — is the delay (a) the provider, (b) pi-ai's stream for the model
// object WE build, or (c) something after that?
//
// User report 2026-10-28: "Assist turn is delayed while other session is generating. I
// checked tui got response in 1~2sec for glm-5.3-flash". A WS probe showed message_start at
// 6ms but NO assistant delta until the turn ended (first-any == first-text == turn end,
// 18-45s), while the pi CLI did the same prompt in 1.7s.
//
// This calls pi-ai's streamSimple DIRECTLY (no hub, no WS) with
//   1) the model object our merged catalog produces for the running server (models-store
//      entry + `.pi/models.json` overlay — it carries a `compat` block), and
//   2) the pristine builtin-catalog model object (what the pi CLI resolves),
// and prints every stream event with timing. thinking off/high × both objects.
//
// Usage: node ws-diag/model-stream-probe.mjs [modelId] [provider]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildProviderCatalog } from "../lib/pi-catalog.mjs";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PI_DIR = process.env.PI_DIR || "C:/pi-windows-x64/.pi";
const MODEL_ID = process.argv[2] || "z-ai/glm-5.3-flash";
const PROVIDER = process.argv[3] || "nvidia";
const PROMPT = "Reply with exactly: OK";
const now = () => Number(process.hrtime.bigint() / 1000000n);
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(path.join(PI_DIR, f), "utf8")); } catch { return null; } };

const auth = readJson("auth.json") || {};
const key = typeof auth[PROVIDER] === "string" ? auth[PROVIDER] : auth[PROVIDER]?.key;
console.log(`[probe] pi dir ${PI_DIR} · provider ${PROVIDER} · model ${MODEL_ID} · key ${key ? "yes" : "MISSING"}`);

// (1) what the SERVER builds (merged catalog: catalog + models-store + models.json + auth)
const merged = buildProviderCatalog({ store: readJson("models-store.json") || {}, modelsJson: readJson("models.json") || {}, auth, builtinModels: (n) => { try { return getBuiltinModels(n) || []; } catch { return []; } }, env: process.env });
const mine = merged.providers[PROVIDER]?.models.find((m) => m.id === MODEL_ID);

// (2) the pristine catalog entry (what the pi CLI uses when nothing overrides it)
const pure = (() => { try { return (getBuiltinModels(PROVIDER) || []).find((m) => m.id === MODEL_ID); } catch { return null; } })();

const brief = (m) => (m ? { id: m.id, api: m.api, baseUrl: m.baseUrl, reasoning: m.reasoning, compat: m.compat, headers: m.headers ? Object.keys(m.headers) : undefined, thinkingLevelMap: m.thinkingLevelMap } : null);
console.log("[probe] server model object:", JSON.stringify(brief(mine)));
console.log("[probe] catalog model object:", JSON.stringify(brief(pure)));

async function run(label, model, thinkingLevel) {
	if (!model) { console.log(`${label}: (model missing)`); return; }
	const t0 = now();
	const events = [];
	const texts = [];
	let firstDelta = null, firstText = null, firstThinking = null;
	try {
		const stream = await streamSimple(
			{ ...model, provider: PROVIDER, apiKey: key },
			{ messages: [{ role: "user", content: [{ type: "text", text: PROMPT }] }] },
			{ apiKey: key, thinkingLevel },
		);
		for await (const ev of stream) {
			const dt = now() - t0;
			events.push(`${ev.type}@${Math.round(dt)}ms`);
			if (ev.type === "text_delta") { if (firstDelta == null) firstDelta = dt; texts.push(ev.delta || ""); }
			if (ev.type === "thinking_delta") { if (firstDelta == null) firstDelta = dt; if (firstThinking == null) firstThinking = dt; }
			if (ev.type === "text_end" && firstText == null) firstText = dt;
			if (ev.type === "error") events.push(`ERROR:${ev.error?.errorMessage || JSON.stringify(ev.error)}`);
		}
	} catch (err) {
		events.push(`THREW:${err?.message || err}`);
	}
	const total = now() - t0;
	const kinds = events.filter((e) => !e.startsWith("ERROR") && !e.startsWith("THREW"));
	const counts = kinds.reduce((acc, e) => { const k = e.split("@")[0]; acc[k] = (acc[k] || 0) + 1; return acc; }, {});
	console.log(`${label}:
   thinking=${thinkingLevel} · total ${Math.round(total)}ms · first delta ${firstDelta == null ? "NONE" : Math.round(firstDelta) + "ms"} · first text_end ${firstText == null ? "NONE" : Math.round(firstText) + "ms"} · text ${JSON.stringify(texts.join("").slice(0, 20))}
   events: ${JSON.stringify(counts)}${events.some((e) => e.startsWith("ERROR") || e.startsWith("THREW")) ? " " + events.filter((e) => e.startsWith("ERROR") || e.startsWith("THREW")).join(" ") : ""}`);
}

await run("[1] SERVER model object", mine, "high");
await run("[2] catalog model object", pure, "high");
await run("[3] SERVER model object", mine, "off");
await run("[4] catalog model object", pure, "off");
process.exit(0);
