// term-debug.mjs — manual terminal debugging harness: boots a scratch server,
// opens /ws/terminal, sends one command, prints the raw WS frames as they
// arrive (timing + escape sequences visible). Use when term-smoke fails and
// you need to see WHY. Usage: node tests/term-debug.mjs
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8790;
const srv = spawn(process.execPath, [path.join(HERE, "..", "server.mjs")], {
	env: { ...process.env, PORT: String(PORT), PI_WEB_PORT: String(PORT), PI_WEB_DEBUG: "1" },
	stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
srv.stdout.on("data", (d) => (log += d));
srv.stderr.on("data", (d) => (log += d));
await new Promise((r) => setTimeout(r, 2500));
await new Promise((resolve, reject) => {
	const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/terminal?session=debug0123456789abcdef`, { origin: `http://127.0.0.1:${PORT}` });
	const t0 = Date.now();
	ws.on("open", () => {
		console.log("[open]");
		ws.send(JSON.stringify({ t: "i", d: "echo DEBUG_$((6*7))\r" }));
	});
	ws.on("message", (raw) => {
		const s = raw.toString();
		console.log(`[+${Date.now() - t0}ms]`, JSON.stringify(s.slice(0, 240)));
		if (s.includes("DEBUG_42") || Date.now() - t0 > 12000) {
			try { spawnSync("taskkill", ["/F", "/T", "/PID", String(srv.pid)], { stdio: "ignore" }); } catch {}
			process.exit(s.includes("DEBUG_42") ? 0 : 1);
		}
	});
	ws.on("error", (e) => {
		console.log("[err]", e.message, "\n[server log tail]", log.slice(-800));
		try { spawnSync("taskkill", ["/F", "/T", "/PID", String(srv.pid)], { stdio: "ignore" }); } catch {}
		process.exit(2);
	});
});
