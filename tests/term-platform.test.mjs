#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createNodePtyBackend, defaultBashPath, selectTerminalBackend } from "../terminal-backends.mjs";
import { killProcessTree } from "../process-tree.mjs";
import { execTool, startScratchServer } from "./_scratch-server.mjs";

assert.equal(selectTerminalBackend("win32", "pipes", false), "win32-bridge");
assert.equal(selectTerminalBackend("linux", "auto", true), "pipes");
assert.equal(selectTerminalBackend("linux", "auto", false), "pipes");
assert.equal(selectTerminalBackend("linux", "pipes", true), "pipes");
assert.equal(selectTerminalBackend("linux", "node-pty", false), "pipes");
assert.equal(selectTerminalBackend("linux", "node-pty", true), "node-pty");
assert.equal(selectTerminalBackend("linux", "unexpected", true), "invalid");

assert.equal(defaultBashPath("win32", {}), "C:\\Git\\usr\\bin\\bash.exe");
assert.equal(defaultBashPath("linux", { SHELL: "/usr/bin/bash" }), "/usr/bin/bash");
assert.equal(defaultBashPath("linux", { SHELL: "/bin/zsh" }), "/bin/bash");
assert.equal(defaultBashPath("linux", { PI_WEB_BASH_SHELL: "/custom/bash" }), "/custom/bash");

{
	const events = {};
	const terminal = {
		pid: 123,
		write: (data) => { events.write = data; },
		resize: (cols, rows) => { events.resize = [cols, rows]; },
		onData: (callback) => { events.data = callback; },
		onExit: (callback) => { events.exit = callback; },
	};
	const backend = createNodePtyBackend(
		{ spawn: (shell, args, options) => {
			events.spawn = { shell, args, options };
			return terminal;
		} },
		{ shell: "/bin/bash", shellArgs: ["-i"], cwd: "/tmp", env: { TERM: "xterm" }, cols: 90, rows: 30 },
	);
	assert.equal(backend.kind, "node-pty");
	assert.equal(backend.pid, 123);
	assert.deepEqual(events.spawn.options, { name: "xterm", cols: 90, rows: 30, cwd: "/tmp", env: { TERM: "xterm" } });
	backend.write("echo ok");
	backend.resize(100, 40);
	assert.equal(events.write, "echo ok");
	assert.deepEqual(events.resize, [100, 40]);
	backend.onData((data) => { events.received = data; });
	events.data("terminal output");
	assert.equal(events.received, "terminal output");
	let exitCode;
	backend.onExit((code) => { exitCode = code; });
	events.exit({ exitCode: 7, signal: 0 });
	assert.equal(exitCode, 7);
}

if (process.platform !== "win32") {
	const child = spawn("sh", ["-c", "sleep 300 & wait"], { detached: true, stdio: "ignore" });
	await new Promise((resolve, reject) => {
		child.once("spawn", resolve);
		child.once("error", reject);
	});
	killProcessTree(child.pid);
	const exit = await new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("process group did not stop")), 5000);
		child.once("exit", (code, signal) => {
			clearTimeout(timeout);
			resolve({ code, signal });
		});
	});
	assert.equal(exit.signal, "SIGTERM");

	const stubborn = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000)"], {
		detached: true,
		stdio: ["ignore", "pipe", "ignore"],
	});
	await new Promise((resolve, reject) => {
		stubborn.stdout.once("data", resolve);
		stubborn.once("error", reject);
	});
	killProcessTree(stubborn.pid);
	const forcedSignal = await new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("SIGKILL escalation did not stop process")), 5000);
		stubborn.once("exit", (_code, signal) => {
			clearTimeout(timeout);
			resolve(signal);
		});
	});
	assert.equal(forcedSignal, "SIGKILL");

	const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-bash-platform-"));
	const server = await startScratchServer({ workspaceDir });
	try {
		await execTool(server, {
			command: "sleep 300 & child=$!; printf '%s' \"$child\" > child.pid; wait",
			timeout: 1,
		}, "bash");
		const childPid = Number(fs.readFileSync(path.join(workspaceDir, "child.pid"), "utf8"));
		assert.ok(Number.isInteger(childPid) && childPid > 0, "bash child pid was written");
		const deadline = Date.now() + 3000;
		let alive = true;
		while (alive && Date.now() < deadline) {
			try {
				process.kill(childPid, 0);
				await new Promise((resolve) => setTimeout(resolve, 50));
			} catch (err) {
				if (err.code === "ESRCH") alive = false;
				else throw err;
			}
		}
		assert.equal(alive, false, "timed-out bash command left no orphaned sleep process");
	} finally {
		await server.stop();
		fs.rmSync(server.dataDir, { recursive: true, force: true });
		fs.rmSync(workspaceDir, { recursive: true, force: true });
	}
}

console.log("[term-platform] platform selection, shell paths, PTY adapter, and kill behavior passed");
