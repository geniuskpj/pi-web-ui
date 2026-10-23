import path from "node:path";

export function selectTerminalBackend(platform, override, nodePtyAvailable) {
	if (platform === "win32") return "win32-bridge";
	if (override && override !== "auto" && override !== "node-pty" && override !== "pipes") return "invalid";
	if (override === "pipes") return "pipes";
	if (override === "node-pty") return nodePtyAvailable ? "node-pty" : "pipes";
	return "pipes";
}

export function defaultBashPath(platform, env = process.env) {
	if (env.PI_WEB_BASH_SHELL) return env.PI_WEB_BASH_SHELL;
	if (platform === "win32") return "C:\\Git\\usr\\bin\\bash.exe";
	const shell = env.SHELL;
	return shell && path.basename(shell) === "bash" ? shell : "/bin/bash";
}

export function createNodePtyBackend(pty, { shell, shellArgs, cwd, env, cols, rows }) {
	const terminal = pty.spawn(shell, shellArgs, {
		name: env.TERM || "xterm-256color",
		cols,
		rows,
		cwd,
		env,
	});
	return {
		kind: "node-pty",
		pid: Number(terminal.pid) || null,
		write: (data) => terminal.write(data),
		resize: (nextCols, nextRows) => terminal.resize(nextCols, nextRows),
		onData: (callback) => terminal.onData(callback),
		onExit: (callback) => terminal.onExit(({ exitCode }) => callback(exitCode)),
	};
}
