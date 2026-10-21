// Vendored LLM connectivity layer (plan.md P2 — replaces pi-web-ui
// dist/utils/proxy-utils.js + the build.mjs patches to AgentInterface).
//
// Sources (verbatim behavior):
//   - shouldUseProxyForProvider / applyProxyIfNeeded / createStreamFn:
//       node_modules/@earendil-works/pi-web-ui/dist/utils/proxy-utils.js
//   - "nvidia + unknown default → proxy when configured":
//       build.mjs proxyDefaultNew patch (custom openai-compatible endpoints
//       usually send no CORS headers)
//   - proxy settings source: localStorage-first (build.mjs streamFnNew patch —
//       the IDB settings read hung on slow devices)
//   - apiKey resolution: localStorage pi.key.* → backend → server
//       /api/pi/key race (build.mjs keyAgentNew patch)
//
// Contract (plan §2.1, grok-reviewed):
//   - clone-before-proxy: NEVER mutate the catalog model — proxy on→off must
//     not leave it permanently proxied
//   - options spread verbatim: signal/temperature/reasoning are never swallowed
import { streamSimple, type Model } from "@earendil-works/pi-ai";

export function shouldUseProxyForProvider(provider: string | undefined, apiKey?: string): boolean {
	switch ((provider || "").toLowerCase()) {
		case "zai":
			return true; // Z-AI always requires proxy
		case "anthropic":
			// OAuth tokens (sk-ant-oat-*) and JSON config keys require proxy;
			// regular API keys (sk-ant-api-*) do not (verbatim from proxy-utils)
			return apiKey ? apiKey.startsWith("sk-ant-oat") || apiKey.startsWith("{") : false;
		case "openai-codex":
			return true; // chatgpt.com/backend-api has no CORS
		case "openai":
		case "google":
		case "groq":
		case "openrouter":
		case "cerebras":
		case "xai":
		case "ollama":
		case "lmstudio":
		case "github-copilot":
			return false;
		// nvidia / unknown custom providers: route through the proxy when one is
		// configured (their endpoints usually send no CORS headers)
		case "nvidia":
			return true;
		default:
			return true;
	}
}

/** Returns a NEW model object with the proxied baseUrl (clone-before-proxy). */
export function applyProxyIfNeeded(model: Model<any>, apiKey: string | undefined, proxyUrl?: string): Model<any> {
	if (!proxyUrl) return model;
	if (!model.baseUrl) return model;
	if (!shouldUseProxyForProvider(model.provider, apiKey)) return model;
	return {
		...model,
		baseUrl: `${proxyUrl}/?url=${encodeURIComponent(model.baseUrl)}`,
	};
}

/** Proxy settings, localStorage-first (synchronous — never hangs). */
export function getProxyUrlSync(): string | undefined {
	try {
		const enabled = localStorage.getItem("pi.proxyEnabled");
		const url =
			localStorage.getItem("pi.proxyUrl") ||
			(location.protocol.startsWith("http") ? location.origin + "/api/proxy" : undefined);
		if (enabled !== "0" && url) return url; // default ON over http
	} catch {
		/* localStorage unavailable */
	}
	return undefined;
}

/**
 * StreamFn with CORS-proxy support. Resolution order for the proxy URL:
 * localStorage (sync) → custom getter → undefined (direct call).
 */
export function createProxyStreamFn(getProxyUrl?: () => string | undefined | Promise<string | undefined>) {
	return async (model: Model<any>, context: any, options: any) => {
		const proxyUrl = (await getProxyUrl?.()) ?? getProxyUrlSync();
		// clone-before-proxy — never mutate the catalog model (plan §2.1)
		const target = proxyUrl ? applyProxyIfNeeded(model, options?.apiKey, proxyUrl) : model;
		return streamSimple(target, context, options);
	};
}

/**
 * Agent getApiKey resolver: localStorage fast tier → backend store →
 * server /api/pi/key race (5s cap) — mirrors the patched AgentInterface flow.
 */
export function createApiKeyResolver(providerKeys: { get(p: string): Promise<string | null> }) {
	return async (provider: string): Promise<string | undefined> => {
		try {
			const ls = localStorage.getItem("pi.key." + provider);
			if (ls) return ls;
		} catch {
			/* localStorage unavailable */
		}
		const serverKey = fetch("/api/pi/key", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ provider }),
		})
			.then((r) => (r.ok ? r.json() : null))
			.then((d) => d?.key || undefined)
			.catch(() => undefined);
		const storeKey = providerKeys
			.get(provider)
			.then((k) => k || undefined)
			.catch(() => undefined);
		const timeout = new Promise<undefined>((r) => setTimeout(() => r(undefined), 5000));
		let key = await Promise.race([storeKey, serverKey, timeout]);
		if (!key) {
			// allow the server a little longer — but BOUNDED (grok P2 review: a hung
			// /api/pi/key must not hang getApiKey → hang the run)
			key = await Promise.race([serverKey, new Promise<undefined>((r) => setTimeout(() => r(undefined), 8000))]);
		}
		if (key) {
			try {
				localStorage.setItem("pi.key." + provider, key);
			} catch {
				/* quota */
			}
		}
		return key ?? undefined;
	};
}

/** Heuristic: does this assistant error message look like a bad/missing key?
 *  nvidia returns 403 for bad keys, most others 401 — count both (grok P2). */
export function looksLikeAuthError(message: string | undefined): boolean {
	if (!message) return false;
	return /\b40[13]\b|unauthorized|forbidden|invalid[ _-]?(api[ _-]? )?key|api key|authentication/i.test(message);
}
