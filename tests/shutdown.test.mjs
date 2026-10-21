// shutdown.test.mjs — Ctrl+C (SIGINT) must shut the server down GRACEFULLY and
// audit it in the log file (2026-10-21 user request):
//   1. console tees to <data>/logs/server-YYYYMMDD.log (boot marker + levels)
//   2. terminal hub closeAll() kill-trees every live bash (no orphans)
//   3. agent hub flushes sessions; the worker store drains before terminate
//   4. exit code 0 with a "[shutdown] complete" log line
//
// Windows note: child.kill('SIGINT') TerminateProcesses WITHOUT running the
// handler (verified — exit code null, no log), so this test drives the
// graceful path via PI_WEB_EXIT_ON_STDIN_CLOSE=1 + closing the child's stdin
// (the pipe-friendly equivalent used by parent shells).
// Usage: node tests/shutdown.test.mjs
import { spawn } from "node:child_process";
import WebSocket from "ws";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let passed = 0, failed = 0;
const check = (name, ok, extra = "") => {
	if (ok) { passed++; console.log(`  ✓ ${name}${extra ? " — " + extra : ""}`); }
	else { failed++; console.error(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOT = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

const port = 9100 + Math.floor(Math.random() * 500);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-shut-"));
const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-shut-ws-"));

const child = spawn(process.execPath, [path.join(ROOT, "server.mjs")], {
	env: {
		...process.env,
		PORT: String(port),
		PI_WEB_PORT: String(port),
		PI_WEB_DATA_DIR: dataDir,
		PI_WS: wsDir,
		PI_WEB_TERM_BRIDGE: "pipes", // no pty provisioning from tests
		PI_WEB_EXIT_ON_STDIN_CLOSE: "1",
	},
	stdio: ["pipe", "pipe", "pipe"],
});
let out = "";
child.stdout.on("data", (d) => (out += d));
child.stderr.on("data", (d) => (out += d));

try {
	// wait for health
	let up = false;
	for (let i = 0; i < 100 && !up; i++) {
		try { up = (await fetch(`http://127.0.0.1:${port}/api/health`)).ok; } catch { await sleep(200); }
	}
	check("server booted", up);

	// 1. a REAL persisted session (worker store put over /ws/sync)
	const SESSION = "shutsess" + Math.random().toString(36).slice(2, 10);
	const sync = new WebSocket(`ws://127.0.0.1:${port}/ws/sync`);
	await new Promise((res, rej) => { sync.on("open", res); sync.on("error", rej); });
	const jsonl = JSON.stringify({ id: SESSION, title: "shutdown test" }) + "\n" + JSON.stringify({ role: "user", content: "hello" });
	sync.send(JSON.stringify({ type: "put", id: SESSION, jsonl }));
	await sleep(500);
	sync.close();

	// 2. a LIVE terminal shell (pipes tier — bash -i)
	const term = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal?session=shutdownterm12345&cols=80&rows=24`);
	await new Promise((res) => { term.on("open", res); term.on("error", () => res()); });
	await sleep(1500); // shell spawn + prompt

	// graceful shutdown: close the parent's pipe end (the SIGINT equivalent on Windows)
	child.stdin.end();
	const exit = await new Promise((res) => {
		const t = setTimeout(() => res({ code: "TIMEOUT", signal: null }), 15000);
		child.on("exit", (code, signal) => { clearTimeout(t); res({ code, signal }); });
	});
	term.close();

	check("graceful exit with code 0", exit.code === 0, `code=${exit.code} signal=${exit.signal}`);
	check("log: trigger + terminal shells killed: 1 (no orphaned bash)", /\[shutdown\] .* received/.test(out) && /terminal shells killed: 1\b/.test(out), (out.match(/\[shutdown\][^\n]*/g) || []).join(" | ").slice(0, 220));
	check("log: store drained + worker terminated + complete", /store drained \(0 ops pending/.test(out) && /complete in \d+ms — bye/.test(out));

	// the daily log FILE exists with a boot marker + shutdown sequence
	const logDir = path.join(dataDir, "logs");
	const files = fs.existsSync(logDir) ? fs.readdirSync(logDir).filter((f) => /^server-\d{8}\.log$/.test(f)) : [];
	check("log directory + daily file created", files.length === 1, files.join(",") || "(none)");
	if (files.length) {
		const content = fs.readFileSync(path.join(logDir, files[0]), "utf8");
		check("log file: boot marker", /===== pi-web boot \S+ · pid \d+ · node v/.test(content));
		check("log file: shutdown sequence", content.includes("[shutdown]") && content.includes("— bye"));
		check("log file: info lines carry ISO timestamps", /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z \[info\]/.test(content));
	}

	// the persisted session survived (worker flushed before terminate)
	const jsonlPath = path.join(dataDir, "sessions", `${SESSION}.jsonl`);
	check("session JSONL survived the shutdown", fs.existsSync(jsonlPath), jsonlPath.replace(/^/, "").slice(0, 60));
} finally {
	try { child.kill(); } catch { /* already gone */ }
}

console.log(`\n[shutdown] ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
