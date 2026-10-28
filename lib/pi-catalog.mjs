/**
 * pi-catalog.mjs — the model/provider catalog the web UI offers.
 *
 * WHY (user reports 2026-10-27):
 *   - "model selector should show user added provider's model": the picker read ONLY
 *     `models-store.json` (pi's own discovery CACHE). A provider the user added —
 *     `models.json` (pi's documented "configure a compatible endpoint" file) or a
 *     provider they merely logged into (auth.json, store entry with zero models, e.g.
 *     google) — never appeared, or appeared with an empty model list.
 *   - "let openai compatible api/provider accept apiKey none": an endpoint that needs
 *     no credential (local llama.cpp / vLLM / Ollama / a header-authenticated proxy)
 *     could not be used at all — pi-ai's openai-completions client throws
 *     `No API key for provider: X` when the key string is empty. `apiKey: "none"`
 *     (or an absent key on a models.json provider) is now legitimate.
 *
 * Precedence mirrors pi: auth.json > models.json `apiKey` > keyless placeholder,
 * and models.json (user-authored) > models-store.json (cache) > builtin catalog,
 * per MODEL ID (a user entry replaces the same id, never the whole provider list).
 *
 * Pure — no fs, no process (env + readers are injected) so tests/pi-catalog.test.mjs
 * can pin every rule.
 */

/** The dummy key that keeps an openai-compatible client constructible. It travels as
 *  `Authorization: Bearer none`, which an endpoint that needs no auth ignores. */
export const KEYLESS_PLACEHOLDER = "none";

/** Is this declared key a "needs no credential" marker? '' too (an empty string in
 *  models.json is what a hand-edited file looks like). */
export function isKeylessKey(raw) {
	if (raw == null) return true;
	const v = String(raw).trim().toLowerCase();
	return v === "" || v === "none" || v === "null" || v === "no" || v === "nokey" || v === "no-key" || v === "-" || v === "false";
}

/** `$NAME` / `${NAME}` → env (empty when unset, i.e. "no key yet"); a literal key
 *  passes through. `!command` keys are pi's per-request feature and are NOT executed
 *  here — the web UI has no key-command runner, and the placeholder would turn a
 *  missing credential into a confusing 401, so report it as unresolved. */
export function resolveModelsJsonKey(raw, env = {}) {
	if (raw == null) return "";
	const v = String(raw).trim();
	if (!v) return "";
	if (v.startsWith("!")) return "";
	const m = v.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/);
	if (m) return String(env[m[1]] ?? "");
	return v;
}

const str = (v) => (typeof v === "string" ? v : "");

/** One model entry, normalized: the provider name is authoritative (pi's catalog and
 *  models.json both allow a per-model provider field to be absent) and the model's
 *  own baseUrl wins over the provider's. */
function normalizeModel(m, provider, providerBaseUrl) {
	const out = { ...m, provider };
	if (!out.baseUrl && providerBaseUrl) out.baseUrl = providerBaseUrl;
	// credentials are resolved at the PROVIDER level and never travel in a model record
	delete out.apiKey;
	delete out.api_key;
	return out;
}

/**
 * Merge every source into ONE provider map.
 * @param {object} args
 * @param {object} args.store      parsed models-store.json ({name:{models:[…]}})
 * @param {object} args.modelsJson parsed .pi/models.json ({providers:{name:{…}}})
 * @param {object} args.auth       parsed auth.json ({provider: key|{key}})
 * @param {(name:string)=>any[]} args.builtinModels  pi-ai builtin catalog lookup
 * @param {Record<string,string>} args.env  environment (for $VAR interpolation)
 * @returns {{providers: Record<string,{name,baseUrl,api,models,apiKey,keyless,origin,modelCount}>, names: string[]}}
 */
export function buildProviderCatalog({ store = {}, modelsJson = {}, auth = {}, builtinModels = () => [], env = {} } = {}) {
	const custom = (modelsJson && typeof modelsJson === "object" && modelsJson.providers) || {};
	const names = [...new Set([...Object.keys(store || {}), ...Object.keys(custom), ...Object.keys(auth || {})])];
	const providers = {};
	for (const name of names) {
		const c = custom[name] || {};
		const customModels = Array.isArray(c.models) ? c.models.filter((m) => m && m.id) : [];
		const overrides = Array.isArray(c.modelOverrides) ? c.modelOverrides.filter((m) => m && m.id) : [];
		const providerBaseUrl = str(c.baseUrl || c.base_url);
		const byId = new Map();
		const add = (raw) => {
			if (!raw || !raw.id) return;
			const model = normalizeModel(raw, name, providerBaseUrl || str(raw.baseUrl));
			byId.set(model.id, { ...(byId.get(model.id) || {}), ...model }); // later source = override, per id
		};
		// weakest → strongest: builtin catalog, pi's store cache, user models.json, modelOverrides
		for (const m of builtinModels(name) || []) add(m);
		for (const m of store?.[name]?.models || []) add(m);
		for (const m of customModels) add(m);
		for (const m of overrides) add(m);
		if (byId.size === 0) continue; // e.g. a store entry pi recorded before any models were known

		// KEY RESOLUTION (server-side only): auth.json > models.json apiKey > placeholder.
		// A provider that is NOT declared in models.json never gets the placeholder — a
		// missing real key must stay a clear error, not a silent anonymous request.
		const authEntry = auth?.[name];
		const authKey = typeof authEntry === "string" ? authEntry : authEntry?.key;
		const declaredRaw = c.apiKey ?? c.api_key;
		const declared = resolveModelsJsonKey(declaredRaw, env);
		const fromModelsJson = Object.prototype.hasOwnProperty.call(custom, name);
		// a `!command` key is pi's per-request key source — the web UI cannot run it, and
		// treating it as keyless would turn "I have a credential, just not here yet" into a
		// silent anonymous request.
		const isCommand = typeof declaredRaw === "string" && declaredRaw.trim().startsWith("!");
		// "none" anywhere (or nothing at all) on a models.json provider = this endpoint
		// needs no credential; auth.json still wins when the user did store a real key.
		const keyless = fromModelsJson && !isCommand && isKeylessKey(authKey) && isKeylessKey(declared);
		let apiKey = keyless ? KEYLESS_PLACEHOLDER : str(authKey) || declared;

		providers[name] = {
			name,
			baseUrl: providerBaseUrl || str([...byId.values()].find((m) => m.baseUrl)?.baseUrl),
			api: str(c.api),
			models: [...byId.values()],
			apiKey,          // server-side only — never serialized to a client
			keyless,
			origin: fromModelsJson ? "models.json" : (store?.[name]?.models || []).length ? "models-store" : "builtin-catalog",
		};
	}
	const out = Object.keys(providers).sort((a, b) => a.localeCompare(b));
	return { providers, names: out };
}

/** Client-safe projection: models + baseUrl, NEVER a credential. */
export function clientProviders(providerMap) {
	return Object.values(providerMap || {}).map((p) => ({
		name: p.name,
		baseUrl: p.baseUrl,
		origin: p.origin,
		keyless: p.keyless || undefined,
		models: (p.models || []).map((m) => {
			const copy = { ...m };
			delete copy.apiKey;
			delete copy.api_key;
			return copy;
		}),
	}));
}

/** The `getAuth()`-shaped map the agent hub/tools consume: provider → key string.
 *  Keeps auth.json semantics (`string | {key}`) while adding models.json keys and the
 *  keyless placeholder, so a server-side run resolves exactly what the picker shows.
 *  A REAL auth.json key always wins (also when the caller passes an auth.json the
 *  catalog was not built from — the two are read at different moments). */
export function resolvedKeys(providerMap, auth = {}) {
	const out = {};
	for (const [p, e] of Object.entries(auth || {})) {
		const k = typeof e === "string" ? e : e?.key;
		if (k) out[p] = k;
	}
	for (const p of Object.values(providerMap || {})) {
		if (!p?.apiKey) continue;
		if (!out[p.name]) out[p.name] = p.apiKey;
	}
	return out;
}
