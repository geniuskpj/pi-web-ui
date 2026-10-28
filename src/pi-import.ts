// Pi provider/model config flow (slim build):
//   server /api/pi/config  ->  client localStorage cache (SYNCHRONOUS reads)
//   -> window.__PI_PROVIDERS (memory, read by the patched ModelSelector)
// NO IndexedDB on the boot path — providers/models must never block first paint.
import type { Model } from "@earendil-works/pi-ai";
import { getAppStorage } from "./storage.js"; // P0: own storage layer (was pi-web-ui)

export type AnyModel = Model<any>;

export interface PiProviderConfig {
	name: string;
	baseUrl: string;
	models: AnyModel[];
	/** where the provider came from: models.json (user-added endpoint) | models-store | builtin-catalog | auth */
	origin?: string;
	/** true = the endpoint needs no credential (models.json without/with apiKey "none") */
	keyless?: boolean;
}

export interface PiConfig {
	providers: PiProviderConfig[];
	defaults: {
		provider?: string;
		model?: string;
		thinkingLevel?: string;
	};
}

const CACHE_KEY = "pi.modelsCache";

declare global {
	interface Window {
		__PI_PROVIDERS?: Array<{ name: string; models: AnyModel[]; origin?: string; keyless?: boolean }>;
	}
}

/** SYNCHRONOUS: read the cached config from localStorage into memory. */
export function loadCachedConfig(): PiConfig | null {
	try {
		const s = localStorage.getItem(CACHE_KEY);
		if (!s) return null;
		const cfg = JSON.parse(s) as PiConfig;
		(window as any).__PI_PROVIDERS = cfg.providers.map((p) => ({
			name: p.name,
			models: p.models.map((m) => ({ ...m, provider: p.name })) as AnyModel[],
			origin: p.origin,
			keyless: p.keyless,
		}));
		return cfg;
	} catch {
		return null;
	}
}

/** Apply a fresh config to memory + localStorage cache. */
export function applyConfig(config: PiConfig) {
	(window as any).__PI_PROVIDERS = config.providers.map((p) => ({
		name: p.name,
		models: p.models.map((m) => ({ ...m, provider: p.name })) as AnyModel[],
		origin: p.origin,
		keyless: p.keyless,
	}));
	try {
		localStorage.setItem(
			CACHE_KEY,
			JSON.stringify({ providers: config.providers, defaults: config.defaults, fetchedAt: new Date().toISOString() }),
		);
		const def = pickDefaultModel(config);
		localStorage.setItem("pi.defaultModelId", def?.id || "");
		if (config.defaults.thinkingLevel) {
			localStorage.setItem("pi.defaultThinkingLevel", config.defaults.thinkingLevel);
		}
	} catch {
		/* quota — memory copy still works for this session */
	}
}

export async function fetchPiConfig(): Promise<PiConfig | null> {
	try {
		const res = await fetch("/api/pi/config");
		if (!res.ok) return null;
		const data = (await res.json()) as PiConfig;
		return data.providers.length > 0 ? data : null;
	} catch {
		return null; // server offline — cache keeps working
	}
}

export async function fetchAndApplyConfig(): Promise<PiConfig | null> {
	const config = await fetchPiConfig();
	if (config) applyConfig(config);
	return config;
}

/** Default model (synchronous, from the in-memory/cache config). */
export function defaultModelFromCache(cfg?: PiConfig | null): AnyModel | undefined {
	const config = cfg || loadCachedConfig();
	if (!config) return undefined;
	return pickDefaultModel(config);
}

/** Pick the default model object (pi settings.json defaults) from a config. */
export function pickDefaultModel(config: PiConfig): AnyModel | undefined {
	const { model, provider } = config.defaults;
	const all = config.providers.flatMap((p) => p.models);
	if (model) {
		const hit = all.find((m) => m.id === model && (!provider || m.provider === provider));
		if (hit) return { ...hit, provider: hit.provider } as AnyModel;
	}
	return all[0] as AnyModel | undefined;
}

/** Fetch the API key for a provider from pi's auth.json (explicit user action). */
export async function importPiKey(provider: string): Promise<string | undefined> {
	const res = await fetch("/api/pi/key", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ provider }),
	});
	if (!res.ok) return undefined;
	const data = (await res.json()) as { key?: string };
	if (!data.key) return undefined;
	// pi-web-ui resolves keys at request time via providerKeys.get(model.provider)
	await getAppStorage().providerKeys.set(provider, data.key);
	return data.key;
}
