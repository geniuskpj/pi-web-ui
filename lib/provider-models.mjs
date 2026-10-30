/**
 * provider-models.mjs — discover the models a provider ACTUALLY serves, so the picker shows
 * the user's hand-written models AND the rest of that provider's catalogue.
 *
 * User request 2026-10-28: "you should show other model with user selected provider. You
 * could get it when server is started — user written model + selected provider's model."
 *
 * Why the request works: `.pi/auth.json` / `.pi/models.json` give us a usable baseUrl + key,
 * and every OpenAI-compatible endpoint answers `GET {baseUrl}/models` with `{data:[{id,…}]}`
 * (that is what NIM, Ollama, vLLM, LM Studio, OpenRouter … all do). A discovered id needs no
 * metadata of its own: it is merged into the provider's existing model list (whose entries
 * carry `api`/`baseUrl`/`compat`), so it inherits exactly the config the user already wrote.
 *
 * Pure parsing + merge (mocked in tests) with one thin fetch wrapper.
 */

/** Parse an OpenAI-compatible `/models` body. Accepts `{data:[…]}`, a bare array, or
 *  `{models:[…]}` (Ollama). Ids are deduped, trimmed, blank-free, and capped. */
export function parseModelList(json, { cap = 500 } = {}) {
	// ONLY arrays are iterated: `data: "nope"` would otherwise walk the string and yield
	// one "model" per character
	const raw = Array.isArray(json) ? json : [json?.data, json?.models].find(Array.isArray) ?? [];
	const out = [];
	const seen = new Set();
	for (const entry of raw) {
		const id = String(typeof entry === "string" ? entry : entry?.id ?? entry?.name ?? "").trim();
		if (!id || seen.has(id)) continue;
		seen.add(id);
		out.push(id);
		if (out.length >= cap) break;
	}
	return out;
}

/** GET {baseUrl}/models with the provider's credential. Never throws: returns
 *  `{ids, error}` so a dead/blocked endpoint just means "nothing discovered". */
export async function fetchProviderModelIds({ baseUrl, apiKey, headers, timeoutMs = 8000 } = {}) {
	const base = String(baseUrl || "").replace(/\/+$/, "");
	if (!/^https?:\/\//i.test(base)) return { ids: [], error: "no baseUrl" };
	const url = `${base}/models`;
	const h = { accept: "application/json", ...(headers || {}) };
	if (apiKey) h.authorization = `Bearer ${apiKey}`;
	try {
		const res = await fetch(url, { headers: h, signal: AbortSignal.timeout(timeoutMs) });
		if (!res.ok) return { ids: [], error: `HTTP ${res.status}` };
		const json = await res.json().catch(() => null);
		const ids = parseModelList(json);
		return { ids, error: ids.length ? undefined : "empty list" };
	} catch (err) {
		return { ids: [], error: String(err?.name === "TimeoutError" ? `timeout ${timeoutMs}ms` : err?.message || err) };
	}
}

/**
 * Merge discovered ids into ONE provider's model array.
 * - ids the user already wrote (or the catalog already had) are left UNTOUCHED
 * - a new id copies the provider's own shape: the template is the first existing model
 *   (api/baseUrl/headers/compat), with reasoning off and a plain name — safe defaults for a
 *   model we know nothing else about
 * @returns {{models: any[], added: string[]}}
 */
export function mergeDiscoveredModels(providerName, models, ids, { maxAdd = 300 } = {}) {
	const list = Array.isArray(models) ? [...models] : [];
	if (!ids?.length) return { models: list, added: [] };
	const have = new Set(list.map((m) => String(m?.id || "")));
	const template = list.find((m) => m?.api) || {};
	const added = [];
	for (const id of ids) {
		if (have.has(id)) continue;
		if (added.length >= maxAdd) break;
		list.push({
			id,
			name: id,
			api: template.api || "openai-completions",
			provider: providerName,
			...(template.baseUrl ? { baseUrl: template.baseUrl } : {}),
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			discovered: true, // the picker labels these "from the provider"
		});
		have.add(id);
		added.push(id);
	}
	return { models: list, added };
}
