#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultBashPath } from "../terminal-backends.mjs";
import { killProcessTree } from "../process-tree.mjs";
import { execTool, startScratchServer } from "./_scratch-server.mjs";

assert.equal(defaultBashPath("win32", {}), "C:\\Git\\usr\\bin\\bash.exe");
assert.equal(defaultBashPath("linux", { SHELL: "/usr/bin/bash" }), "/usr/bin/bash");
assert.equal(defaultBashPath("linux", { SHELL: "/bin/zsh" }), "/bin/bash");
assert.equal(defaultBashPath("linux", { PI_WEB_BASH_SHELL: "/custom/bash" }), "/custom/bash");

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

console.log("[term-platform] shell paths and POSIX process-group termination passed");
