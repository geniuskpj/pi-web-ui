/**
 * Stub for `@mistralai/mistralai` (2.15MB + 0.95MB otel conventions — removed).
 * pi-ai only constructs the client when streaming via the mistral provider;
 * this build targets nvidia (openai-compatible) so the SDK is dead weight.
 */
export class Mistral {
	constructor() {
		throw new Error("Mistral provider is not included in this slim build (nvidia/openai-compatible only).");
	}
}
export default { Mistral };
