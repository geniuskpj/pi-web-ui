// provider-models.test.mjs — the provider's OWN model list, merged into the picker
// (user request 2026-10-28: "show other model with user selected provider … you could get
// it when server is started — user written model + selected provider's model").
//
// Live check behind the design: nvidia's GET /v1/models returns 85 ids in ~360 ms, and the
// merge must add the 84 the user never wrote while leaving their own entries untouched.
//
// Usage: node tests/provider-models.test.mjs
import { parseModelList, mergeDiscoveredModels } from "../lib/provider-models.mjs";

let passed = 0, failed = 0;
const check = (name, ok, extra = "") => {
	if (ok) { passed++; console.log(`  ✓ ${name}${extra ? " — " + extra : ""}`); }
	else { failed++; console.error(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
};

// ── P) parsing the various /models shapes ────────────────────────────────────────────────
{
	check("P1 OpenAI shape ({data:[{id}]})", JSON.stringify(parseModelList({ data: [{ id: "a" }, { id: "b" }] })) === '["a","b"]');
	check("P1 bare array of strings", JSON.stringify(parseModelList(["x", "y"])) === '["x","y"]');
	check("P1 Ollama shape ({models:[{name}]}) falls back to the name", JSON.stringify(parseModelList({ models: [{ name: "llama3" }] })) === '["llama3"]');
	check("P1 duplicates and blanks are dropped", JSON.stringify(parseModelList({ data: [{ id: "a" }, { id: "a" }, { id: "  " }, {}, null] })) === '["a"]');
	check("P1 ids are trimmed", parseModelList({ data: [{ id: " spaced/id " }] })[0] === "spaced/id");
	check("P1 the cap is honoured", parseModelList({ data: Array.from({ length: 20 }, (_, i) => ({ id: "m" + i })) }, { cap: 5 }).length === 5);
	check("P1 junk input is empty, never a throw", parseModelList(null).length === 0 && parseModelList({ data: "nope" }).length === 0 && parseModelList(42).length === 0);
}

// ── M) merging into a provider the user already wrote ───────────────────────────────────
{
	const userModels = [
		{ id: "z-ai/glm-5.3-flash", name: "GLM-5.3-Flash", api: "openai-completions", baseUrl: "https://integrate.api.nvidia.com/v1", reasoning: true, compat: { supportsStore: false }, maxTokens: 131072 },
		{ id: "deepseek-ai/deepseek-v4-flash-0731", name: "DeepSeek V4 Flash", api: "openai-completions", baseUrl: "https://integrate.api.nvidia.com/v1", reasoning: true },
	];
	const merged = mergeDiscoveredModels("nvidia", userModels, ["z-ai/glm-5.3-flash", "meta/llama-3.1-8b-instruct", "01-ai/yi-large"]);
	check("M1 the user's own models come first and are untouched", merged.models[0].name === "GLM-5.3-Flash" && merged.models[0].compat.supportsStore === false && merged.models[0].maxTokens === 131072);
	check("M1 an id the user already wrote is NOT duplicated", merged.models.filter((m) => m.id === "z-ai/glm-5.3-flash").length === 1);
	check("M1 the provider's OTHER models are appended", merged.added.length === 2 && merged.models.length === 4);
	check("M1 they are flagged so the picker can label them", merged.models.find((m) => m.id === "01-ai/yi-large").discovered === true);
	check("M2 a discovered model inherits the provider's api/baseUrl", merged.models.find((m) => m.id === "01-ai/yi-large").api === "openai-completions" && merged.models.find((m) => m.id === "01-ai/yi-large").baseUrl === "https://integrate.api.nvidia.com/v1");
	check("M2 reasoning defaults to OFF for a model we have no metadata for", merged.models.find((m) => m.id === "01-ai/yi-large").reasoning === false);
	check("M3 no ids → the list is returned unchanged (same entries)", mergeDiscoveredModels("nvidia", userModels, []).models.length === 2);
	const capped = mergeDiscoveredModels("p", [{ id: "keep", api: "openai-completions" }], Array.from({ length: 50 }, (_, i) => "new" + i), { maxAdd: 3 });
	check("M3 maxAdd bounds how many a bad endpoint can inject", capped.added.length === 3 && capped.models.length === 4);
	const empty = mergeDiscoveredModels("p", [], ["a"]);
	check("M4 a provider with no models still gets a usable entry (openai-completions default)", empty.models[0].api === "openai-completions" && empty.models[0].baseUrl === undefined);
}

console.log(`\n[provider-models] ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
