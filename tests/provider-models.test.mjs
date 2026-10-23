#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startScratchServer } from "./_scratch-server.mjs";

const piDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-provider-models-"));
const modelsPath = path.join(piDir, "models-store.json");
const initialModels = {
	openai: {
		name: "openai",
		models: [{
			id: "initial-model",
			name: "Initial model",
			api: "openai-completions",
			provider: "openai",
			baseUrl: "https://example.invalid/v1",
			reasoning: false,
			input: ["text"],
			contextWindow: 8192,
			maxTokens: 1024,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		}],
	},
};
fs.writeFileSync(modelsPath, JSON.stringify(initialModels));

const server = await startScratchServer({ piDir });
try {
	const addedModel = {
		id: "nvidia/llama-test",
		name: "NVIDIA test model",
		api: "openai-completions",
		provider: "nvidia",
		baseUrl: "https://integrate.api.nvidia.com/v1",
		reasoning: false,
		input: ["text"],
		contextWindow: 8192,
		maxTokens: 1024,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	fs.writeFileSync(modelsPath, JSON.stringify({
		...initialModels,
		nvidia: { name: "nvidia", models: [addedModel] },
	}));

	const configResponse = await fetch(server.url("/api/pi/config"));
	assert.equal(configResponse.status, 200);
	const config = await configResponse.json();
	assert.ok(config.providers.some((provider) => provider.name === "nvidia" && provider.models.some((model) => model.id === addedModel.id)),
		"fresh pi config includes the newly added NVIDIA model");

	const createResponse = await fetch(server.url("/api/agent/session"), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ sessionId: "provider-model-test-0000000001", modelId: addedModel.id }),
	});
	assert.equal(createResponse.status, 200);
	const { sessionId } = await createResponse.json();
	const stateResponse = await fetch(server.url(`/api/agent/session/${sessionId}`));
	assert.equal(stateResponse.status, 200);
	const state = await stateResponse.json();
	assert.equal(state.model?.id, addedModel.id, "server agent resolves the just-added NVIDIA model");
	assert.equal(state.model?.provider, "nvidia");
	console.log("[provider-models] runtime pi model-store refresh updates the server agent");
} finally {
	await server.stop();
	fs.rmSync(server.dataDir, { recursive: true, force: true });
	fs.rmSync(piDir, { recursive: true, force: true });
}
