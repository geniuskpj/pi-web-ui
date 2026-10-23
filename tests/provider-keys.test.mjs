#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startScratchServer } from "./_scratch-server.mjs";

const piDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-provider-keys-"));
const authPath = path.join(piDir, "auth.json");
fs.writeFileSync(authPath, JSON.stringify({ existing: { type: "api", key: "server-auth-key" } }));

const server = await startScratchServer({ piDir });
try {
	const saveResponse = await fetch(server.url("/api/pi/key"), {
		method: "PUT",
		headers: { "Content-Type": "application/json", "x-pi-web-token": server.token },
		body: JSON.stringify({ provider: "nvidia", key: "browser-entered-key" }),
	});
	assert.equal(saveResponse.status, 200);
	assert.deepEqual(await saveResponse.json(), { ok: true, provider: "nvidia" });

	const storedPath = path.join(server.dataDir, "provider-keys.json");
	const stored = JSON.parse(fs.readFileSync(storedPath, "utf8"));
	assert.deepEqual(stored.nvidia, { type: "api", key: "browser-entered-key" });
	assert.equal(JSON.parse(fs.readFileSync(authPath, "utf8")).existing.key, "server-auth-key",
		"writing a browser-entered key leaves pi's auth.json unchanged");
	if (process.platform !== "win32") {
		assert.equal(fs.statSync(storedPath).mode & 0o777, 0o600, "provider keys are private to the server account");
	}

	const getKey = async (provider) => {
		const response = await fetch(server.url("/api/pi/key"), {
			method: "POST",
			headers: { "Content-Type": "application/json", "x-pi-web-token": server.token },
			body: JSON.stringify({ provider }),
		});
		return { response, body: await response.json() };
	};
	const savedKey = await getKey("nvidia");
	assert.equal(savedKey.response.status, 200);
	assert.equal(savedKey.body.key, "browser-entered-key",
		"the server-side key resolver can read keys saved from Settings");
	const originalKey = await getKey("existing");
	assert.equal(originalKey.body.key, "server-auth-key", "pi auth.json keys remain available");

	const invalid = await fetch(server.url("/api/pi/key"), {
		method: "PUT",
		headers: { "Content-Type": "application/json", "x-pi-web-token": server.token },
		body: JSON.stringify({ provider: "../auth", key: "invalid-provider-key" }),
	});
	assert.equal(invalid.status, 400);
	console.log("[provider-keys] server-side key save, lookup, and file isolation passed");
} finally {
	await server.stop();
	fs.rmSync(server.dataDir, { recursive: true, force: true });
	fs.rmSync(piDir, { recursive: true, force: true });
}
