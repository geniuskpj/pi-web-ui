// pi-catalog.test.mjs — the provider/model catalog the picker (and the hub) use.
//
// User reports 2026-10-27:
//   "model selector should show user added provider's model" — the picker read ONLY
//   models-store.json (pi's cache), so a provider added in `.pi/models.json`
//   (pi's documented compatible-endpoint file) or one that only exists in auth.json
//   (logged in via pi, zero cached models — e.g. google) never showed up.
//   "let openai compatible api/provider accept apiKey none" — pi-ai's
//   openai-completions client throws `No API key for provider: X` on an empty key,
//   so an endpoint that needs no credential was unusable.
//
// Usage: node tests/pi-catalog.test.mjs
import { buildProviderCatalog, clientProviders, resolvedKeys, isKeylessKey, resolveModelsJsonKey, KEYLESS_PLACEHOLDER } from "../lib/pi-catalog.mjs";

let passed = 0, failed = 0;
const check = (name, ok, extra = "") => {
	if (ok) { passed++; console.log(`  ✓ ${name}${extra ? " — " + extra : ""}`); }
	else { failed++; console.error(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
};
const model = (id, extra = {}) => ({ id, name: id, api: "openai-completions", baseUrl: "https://example.test/v1", ...extra });
// a tiny builtin catalog: "google" has models, "nvidia" has none (the store owns it)
const builtin = (name) => (name === "google" ? [model("gemini-3-pro"), model("gemini-3-flash")] : name === "nvidia" ? [model("catalog-only", { api: "openai-completions" })] : []);

// ── K) the keyless rule ──────────────────────────────────────────────────────
{
	check("K1 'none' / '' / 'null' are keyless markers", isKeylessKey("none") && isKeylessKey(" null ") && isKeylessKey("") && isKeylessKey(null) && isKeylessKey(undefined));
	check("K1 a real key is not keyless", !isKeylessKey("sk-abc") && !isKeylessKey("nvapi-xyz"));
	check("K2 $ENV interpolates (unset → no key)", resolveModelsJsonKey("$MY_PROVIDER_KEY", { MY_PROVIDER_KEY: "sk-1" }) === "sk-1" && resolveModelsJsonKey("${MY_PROVIDER_KEY}", {}) === "");
	check("K2 a literal key passes through", resolveModelsJsonKey("none", {}) === "none" && resolveModelsJsonKey("sk-literal", {}) === "sk-literal");
	check("K3 a !command key is NOT executed and NOT keyless", resolveModelsJsonKey("!pass show api/x", {}) === "");
}

// ── C) the merge ────────────────────────────────────────────────────────────
{
	const store = { google: { models: [] }, nvidia: { models: [model("z-ai/glm-5.3", { name: "GLM 5.3" })] } };
	const modelsJson = { providers: { ollama: { baseUrl: "http://localhost:11434/v1", api: "openai-completions", models: [{ id: "qwen3:8b" }] } } };
	const auth = { nvidia: "nvapi-real" };
	const { providers, names } = buildProviderCatalog({ store, modelsJson, auth, builtinModels: builtin });

	check("C1 a provider added in models.json is in the catalog", names.includes("ollama"));
	check("C1 its models come along", providers.ollama.models.length === 1 && providers.ollama.models[0].id === "qwen3:8b");
	check("C1 the provider baseUrl is pushed onto its models (pi does the same)", providers.ollama.models[0].baseUrl === "http://localhost:11434/v1");
	check("C1 origin marks it as user-added", providers.ollama.origin === "models.json");
	check("C2 a store provider with ZERO cached models gets the builtin catalog", providers.google.models.length === 2 && providers.google.origin === "builtin-catalog");
	check("C2 the store's own models survive the merge", providers.nvidia.models.some((m) => m.id === "z-ai/glm-5.3"));
	check("C2 builtin models are merged in per id (pi's own precedence)", providers.nvidia.models.some((m) => m.id === "catalog-only"));
	check("C2 no provider is invented without models", !names.includes("openai"));
	check("C3 auth.json alone is enough to offer a provider", buildProviderCatalog({ auth: { anthropic: "sk-ant-api" }, builtinModels: (n) => (n === "anthropic" ? [model("claude-sonnet-5")] : []) }).names.includes("anthropic"));
}

// ── O) models.json overrides the store per MODEL ID, not per provider ────────
{
	const store = { nvidia: { models: [model("z-ai/glm-5.3", { name: "Old name" }), model("deepseek-v4")] } };
	const modelsJson = { providers: { nvidia: { baseUrl: "https://mirror.test/v1", apiKey: "none", models: [{ id: "z-ai/glm-5.3", name: "User name" }, { id: "my-local-model" }] } } };
	const { providers } = buildProviderCatalog({ store, modelsJson, auth: {}, builtinModels: () => [] });
	const nv = providers.nvidia;
	check("O1 a user model entry replaces the same id", nv.models.find((m) => m.id === "z-ai/glm-5.3").name === "User name");
	check("O1 the store's other models are NOT dropped (no whole-list replacement)", nv.models.some((m) => m.id === "deepseek-v4"));
	check("O1 a brand-new user model is added", nv.models.some((m) => m.id === "my-local-model"));
	check("O1 the models.json baseUrl wins for the provider", nv.baseUrl === "https://mirror.test/v1");
	check("O2 apiKey 'none' → the keyless placeholder (openai-compatible without auth)", nv.keyless === true && nv.apiKey === KEYLESS_PLACEHOLDER);
}

// ── A) credential precedence: auth.json > models.json > placeholder ──────────
{
	const mk = (auth, apiKey) => buildProviderCatalog({
		modelsJson: { providers: { local: { baseUrl: "http://127.0.0.1:8080/v1", apiKey, models: [{ id: "m" }] } } },
		auth, builtinModels: () => [],
	}).providers.local;
	check("A1 an absent models.json apiKey is keyless", mk({}, undefined).keyless === true && mk({}, undefined).apiKey === KEYLESS_PLACEHOLDER);
	check("A1 apiKey: '' is keyless too (hand-edited file)", mk({}, "").keyless === true);
	check("A2 a literal models.json key is used", mk({}, "local-dummy").apiKey === "local-dummy" && mk({}, "local-dummy").keyless === false);
	check("A2 $ENV resolves", buildProviderCatalog({ modelsJson: { providers: { local: { apiKey: "$LOCAL_KEY", models: [{ id: "m" }] } } }, auth: {}, env: { LOCAL_KEY: "from-env" }, builtinModels: () => [] }).providers.local.apiKey === "from-env");
	check("A3 auth.json overrides models.json", mk({ local: { key: "from-auth" } }, "none").apiKey === "from-auth" && mk({ local: "from-auth" }, "none").keyless === false);
	check("A4 a `!command` key is never silently keyless", mk({}, "!pass show local").keyless === false && mk({}, "!pass show local").apiKey === "");
	check("A5 a provider NOT in models.json never gets the placeholder (a missing real key stays an error)", buildProviderCatalog({ store: { openai: { models: [model("gpt-5")] } }, builtinModels: () => [] }).providers.openai.apiKey === "" );
}

// ── S) what leaves the server ───────────────────────────────────────────────
{
	const { providers } = buildProviderCatalog({
		modelsJson: { providers: { local: { baseUrl: "http://127.0.0.1:8080/v1", apiKey: "sk-secret", models: [{ id: "m", apiKey: "sk-inner" }] } } },
		auth: {}, builtinModels: () => [],
	});
	const client = clientProviders(providers);
	const json = JSON.stringify(client);
	check("S1 the client payload never carries a provider key", !json.includes("sk-secret"));
	check("S1 a per-model apiKey is stripped from the model record", !json.includes("sk-inner"));
	check("S1 the provider shape the UI reads is intact", client.length === 1 && client[0].name === "local" && client[0].models.length === 1);
	check("S2 resolvedKeys is what the hub/summarizer resolve", resolvedKeys(providers, { local: "from-auth" }).local === "from-auth" && resolvedKeys(providers, {}).local === "sk-secret");
	check("S2 a keyless provider resolves to the placeholder (no 'No API key for provider' throw)", resolvedKeys(buildProviderCatalog({ modelsJson: { providers: { l: { apiKey: "none", models: [{ id: "m" }] } } }, builtinModels: () => [] }).providers, {}).l === KEYLESS_PLACEHOLDER);
}

// ── D) degenerate inputs never explode ──────────────────────────────────────
{
	const empty = buildProviderCatalog({});
	check("D1 no sources → an empty catalog (the UI shows its empty state)", empty.names.length === 0);
	const broken = buildProviderCatalog({ store: { p: null }, modelsJson: { providers: { q: { models: "nope" } } }, auth: { r: 42 }, builtinModels: () => [] });
	check("D1 null/garbage entries are skipped, not thrown", broken.names.length === 0, broken.names.join(","));
	const noProviders = buildProviderCatalog({ modelsJson: { providers: null }, builtinModels: () => [] });
	check("D1 models.json without a providers object is fine", noProviders.names.length === 0);
}

console.log(`\n[pi-catalog] ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
