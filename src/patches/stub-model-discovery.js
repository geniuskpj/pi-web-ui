/**
 * Replacement for @earendil-works/pi-web-ui/dist/utils/model-discovery.js
 *
 * Local server auto-discovery (Ollama / llama.cpp / vLLM / LM Studio) removed
 * per user request — no `ollama` / `@lmstudio/sdk` dependencies.
 * Use manual providers (e.g. nvidia openai-compatible) with explicit model lists.
 */
export async function discoverOllamaModels() {
	throw new Error("Ollama auto-discovery is removed in this build.");
}
export async function discoverLlamaCppModels() {
	throw new Error("llama.cpp auto-discovery is removed in this build.");
}
export async function discoverVLLMModels() {
	throw new Error("vLLM auto-discovery is removed in this build.");
}
export async function discoverLMStudioModels() {
	throw new Error("LM Studio auto-discovery is removed in this build.");
}
export async function discoverModels(type) {
	throw new Error(
		`Local model auto-discovery is removed in this build (requested type: ${type}). ` +
			`Use a manual provider with an explicit model list instead ` +
			`(e.g. nvidia openai-compatible, or "Import from pi").`,
	);
}
