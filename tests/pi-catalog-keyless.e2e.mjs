// pi-catalog-keyless.e2e.mjs — the "apiKey: none" path, end to end.
//
// WHY (user request 2026-10-27, "let openai compatible api/provider accept apiKey
// none"): pi-ai's openai-completions client calls getClientApiKey(), which THROWS
// `No API key for provider: X` when the key string is empty — so a local
// llama.cpp / vLLM / Ollama / header-auth proxy declared in .pi/models.json could
// not be used at all. lib/pi-catalog.mjs resolves such a provider to the keyless
// placeholder ("none"); this suite proves the placeholder reaches a real request:
// a mock OpenAI-compatible server receives `Authorization: Bearer none` and streams.
// It also pins the CONTRAST — no key → pi-ai throws the very error the fix removes.
//
// Usage: node tests/pi-catalog-keyless.e2e.mjs
import http from "node:http";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { buildProviderCatalog, resolvedKeys, KEYLESS_PLACEHOLDER } from "../lib/pi-catalog.mjs";

let passed = 0, failed = 0;
const check = (name, ok, extra = "") => {
	if (ok) { passed++; console.log(`  ✓ ${name}${extra ? " — " + extra : ""}`); }
	else { failed++; console.error(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
};

// ── a mock OpenAI-compatible endpoint (no auth check, records what it saw) ────
let seenAuth = "unset";
const server = http.createServer((req, res) => {
	seenAuth = req.headers.authorization ?? null;
	req.on("data", () => {});
	req.on("end", () => {
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		const chunk = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
		chunk({ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "hello from local" } }] });
		chunk({ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 } });
		res.write("data: [DONE]\n\n");
		res.end();
	});
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;

// ── a provider declared the way the user wants to declare one ─────────────────
const catalog = buildProviderCatalog({
	modelsJson: {
		providers: {
			local: {
				baseUrl,
				api: "openai-completions",
				apiKey: "none", // ← the request this suite exists for
				models: [{ id: "tiny", name: "Tiny (local)" }],
			},
			"local-nokey": { baseUrl, api: "openai-completions", models: [{ id: "tiny" }] }, // no apiKey at all
		},
	},
	builtinModels: () => [],
});
const model = catalog.providers.local.models[0];
check("E1 the model carries the provider baseUrl (pi's own models.json behaviour)", model.baseUrl === baseUrl, model.baseUrl);
check("E1 models.json records never carry a credential", !("apiKey" in model));

const keys = resolvedKeys(catalog.providers, {});
check("E2 both keyless declarations resolve to the placeholder", keys.local === KEYLESS_PLACEHOLDER && keys["local-nokey"] === KEYLESS_PLACEHOLDER);

const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const full = { ...model, provider: "local", api: "openai-completions", baseUrl, input: ["text"], cost, contextWindow: 8192, maxTokens: 1024 };

// ── E3) keyless + placeholder → a real stream ────────────────────────────────
{
	let text = "", err = null;
	try {
		const stream = await streamSimple(full, { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }, { apiKey: keys.local });
		for await (const ev of stream) {
			if (ev.type === "text_delta") text += ev.delta;
			if (ev.type === "error") err = ev.error?.errorMessage || "error event";
		}
	} catch (e) { err = e.message; }
	check("E3 the keyless provider streams a reply", !err && text.includes("hello from local"), err || JSON.stringify(text));
	check("E3 the placeholder goes out as a bearer header the endpoint ignores", seenAuth === `Bearer ${KEYLESS_PLACEHOLDER}`, String(seenAuth));
}

// ── E4) the contrast: no key at all is exactly the throw this fix removes ─────
{
	let err = null;
	try {
		const stream = await streamSimple(full, { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }, { apiKey: undefined });
		for await (const ev of stream) { if (ev.type === "error") err = ev.error?.errorMessage || "error event"; }
	} catch (e) { err = e.message; }
	check("E4 an EMPTY key still fails loudly (pi-ai's own guard, not a silent anonymous call)", /No API key/i.test(String(err)), String(err));
}

// ── E5) a store provider without a key is NOT silently keyless ───────────────
{
	const store = buildProviderCatalog({ store: { openai: { models: [{ id: "gpt-5", api: "openai-responses", baseUrl: "https://api.openai.com/v1" }] } }, builtinModels: () => [] });
	check("E5 a real provider keeps its clear missing-key error", !resolvedKeys(store.providers, {}).openai);
}

server.close();
console.log(`\n[pi-catalog-keyless] ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
