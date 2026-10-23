import path from "node:path";

export function defaultBashPath(platform, env = process.env) {
	if (env.PI_WEB_BASH_SHELL) return env.PI_WEB_BASH_SHELL;
	if (platform === "win32") return "C:\\Git\\usr\\bin\\bash.exe";
	const shell = env.SHELL;
	return shell && path.basename(shell) === "bash" ? shell : "/bin/bash";
}
