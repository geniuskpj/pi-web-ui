// dump-model.mjs — print the model metadata from every source the server merges, so a
// "why is this request different from the TUI's" question can be answered from data.
// Usage: node ws-diag/dump-model.mjs [modelId] [provider]
import fs from "node:fs";
import path from "node:path";
import { buildProviderCatalog, clientProviders } from "../lib/pi-catalog.mjs";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";

const PI_DIR = process.env.PI_DIR || "C:/pi-windows-x64/.pi";
const ID = process.argv[2] || "z-ai/glm-5.3-flash";
const PROVIDER = process.argv[3] || "nvidia";
const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(PI_DIR, f), "utf8")); } catch { return null; } };
// JSONC-lite (the user's models.json has comments/trailing commas)
const readTolerant = (f) => {
	try {
		const raw = fs.readFileSync(path.join(PI_DIR, f), "utf8");
		try { return JSON.parse(raw); } catch { /* fall through */ }
		const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'\\])\/\/[^\n\r]*/g, "$1").replace(/,\s*([}\]])/g, "$1");
		return JSON.parse(stripped);
	} catch (e) { console.log(`  (${f} unreadable: ${e.message})`); return null; }
};

const show = (label, m) => {
	if (!m) { console.log(`${label}: (absent)`); return; }
	console.log(`${label}: ${JSON.stringify({ id: m.id, api: m.api, baseUrl: m.baseUrl, reasoning: m.reasoning, maxTokens: m.maxTokens, contextWindow: m.contextWindow, thinkingLevelMap: m.thinkingLevelMap, samplingParams: m.samplingParams, compat: m.compat, headers: m.headers }, null, 1)}`);
};

const store = read("models-store.json") || {};
const mine = readTolerant("models.json") || {};
const auth = read("auth.json") || {};
show("[1] models-store.json", (store[PROVIDER]?.models || []).find((m) => m.id === ID));
show("[2] .pi/models.json", (mine.providers?.[PROVIDER]?.models || []).find((m) => m.id === ID));
show("[3] builtin catalog", (() => { try { return (getBuiltinModels(PROVIDER) || []).find((m) => m.id === ID); } catch { return null; } })());
const merged = buildProviderCatalog({ store, modelsJson: mine, auth, builtinModels: (n) => { try { return getBuiltinModels(n) || []; } catch { return []; } }, env: process.env });
show("[4] MERGED (what the server uses)", (merged.providers[PROVIDER]?.models || []).find((m) => m.id === ID));

console.log("\nthinking-format usage in .pi/models.json (provider " + PROVIDER + "):");
for (const m of mine.providers?.[PROVIDER]?.models || []) {
	if (m.compat?.thinkingFormat) console.log(`  ${m.id} → ${m.compat.thinkingFormat}${m.compat.chatTemplateKwargs ? " " + JSON.stringify(m.compat.chatTemplateKwargs) : ""}${m.thinkingLevelMap ? " levelMap=" + JSON.stringify(m.thinkingLevelMap) : ""}`);
}
const withFmt = (store[PROVIDER]?.models || []).filter((m) => m.compat?.thinkingFormat);
console.log("thinking-format usage in models-store.json:", withFmt.length, withFmt.slice(0, 5).map((m) => `${m.id}→${m.compat.thinkingFormat}`).join(", "));
