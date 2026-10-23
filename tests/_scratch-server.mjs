// _scratch-server.mjs — shared helper for tests: boots a REAL server.mjs on a
// random port with a TEMP data dir (never touches the user's data/) and an
// isolated workspace (PI_WS). Resolves once /api/health responds.
// Terminal pty provisioning is disabled (PI_WEB_TERM_BRIDGE=pipes) so tests
// never hit the network for script.exe.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..");

export async function startScratchServer({ port = 9100 + Math.floor(Math.random() * 500), workspaceDir, piDir } = {}) {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-test-"));
	const wsDir = workspaceDir || fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-ws-"));
	const proc = spawn(process.execPath, [path.join(ROOT, "server.mjs")], {
		env: {
			...process.env,
			PORT: String(port),
			PI_WEB_PORT: String(port),
			PI_WEB_DATA_DIR: dataDir,
			PI_WS: wsDir,
			...(piDir ? { PI_DIR: piDir } : {}),
			PI_WEB_TERM_BRIDGE: "pipes", // no pty provisioning from tests
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	let log = "";
	proc.stdout.on("data", (d) => (log += d));
	proc.stderr.on("data", (d) => (log += d));
	const t0 = Date.now();
	for (;;) {
		if (Date.now() - t0 > 20000) {
			try { proc.kill(); } catch {}
			throw new Error(`scratch server on :${port} did not start — log tail:\n` + log.slice(-1500));
		}
		try {
			const r = await fetch(`http://127.0.0.1:${port}/api/health`);
			if (r.ok) break;
		} catch { /* not up yet */ }
		await new Promise((r) => setTimeout(r, 200));
	}
	const token = fs.readFileSync(path.join(dataDir, "auth-token.txt"), "utf8").trim();
	return {
		port,
		token,
		proc,
		dataDir,
		wsDir,
		log: () => log,
		url: (p = "/") => `http://127.0.0.1:${port}${p}`,
		async stop() {
			try { proc.kill(); } catch { /* already gone */ }
			await new Promise((r) => setTimeout(r, 300));
		},
	};
}

/** POST /api/exec/tool with the scratch token. Returns the parsed body. */
export async function execTool(srv, params, tool = "edit") {
	const r = await fetch(`${srv.url("/api/exec/tool")}`, {
		method: "POST",
		headers: { "x-pi-web-token": srv.token, "Content-Type": "application/json" },
		body: JSON.stringify({ tool, params }),
	});
	return r.json();
}
