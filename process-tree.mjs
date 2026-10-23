import { spawn } from "node:child_process";
import path from "node:path";

export function killProcessTree(pid) {
	if (!pid) return;
	if (process.platform === "win32") {
		try {
			const taskkill = spawn(
				path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
				["/F", "/T", "/PID", String(pid)],
				{ stdio: "ignore", detached: true, windowsHide: true },
			);
			taskkill.once("error", () => {});
		} catch {
			// The process may already have exited.
		}
		return;
	}

	const signalGroup = (signal) => {
		try {
			process.kill(-pid, signal);
		} catch (err) {
			if (err?.code !== "ESRCH") console.error(`[pi-web] failed to send ${signal} to process group ${pid}:`, err);
		}
	};
	signalGroup("SIGTERM");
	const timer = setTimeout(() => signalGroup("SIGKILL"), 2000);
	timer.unref?.();
}
