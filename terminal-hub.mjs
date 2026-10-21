#!/usr/bin/env node
/**
 * terminal-hub.mjs — pseudo-terminal bridge for the pi web UI, WITHOUT node-pty.
 *
 * Strategy (Windows-first, zero native npm builds — every binary is prebuilt):
 *
 *   tier "pipes" (fallback): `bash --noprofile --rcfile <rc> -i` over plain
 *                  pipes. Readline still runs: it ECHOES input, renders the
 *                  prompt (with colors), handles arrow-key history redraws,
 *                  ^C (bell + abort) and multi-line continuations — all as a
 *                  plain VT stream the emulator renders natively (verified on
 *                  Git Bash 5.3). Gaps vs a real pty: no job control, native
 *                  console programs see pipes, grid size is fixed via
 *                  COLUMNS/LINES env hints. OSC 133/7 shell-integration
 *                  markers reach the client raw — wterm strips them, our
 *                  scanner reads exit codes + cwd from them.
 *   tier "pty" (default, auto-provisioned): msys2's util-linux `script.exe`
 *                  (downloaded once into data/bin/script/, links only against
 *                  Git's own runtime) allocates a REAL msys pty and bridges our
 *                  stdio — bash gets /dev/ptyN: nano/vim pass the isatty check
 *                  ("standard input is not a terminal" fixed), pty-native
 *                  ONLCR/echo/^C/job control, and the OSC markers still pass
 *                  through raw. The rc sizes the pty via stty (script defaults
 *                  80x25). Override/disable with PI_WEB_TERM_BRIDGE.
 *                  (winpty is NOT usable: its CLI asserts headless —
 *                  winpty.cc:924, cols/rows=0 — because it expects an msys tty
 *                  (mintty), where msys fakes the console-size API.)
 *   neither:       the session starts in phase "error"; the UI explains.
 *
 * Protocol (JSON frames over /ws/terminal, one object per text message):
 *   client → { t:"i", d:string }   stdin bytes (keystrokes/paste), ≤ MAX_INPUT
 *            { t:"reset" }         kill + respawn the shell
 *            { t:"kill" }          kill the shell (no respawn) — Exit button
 *            { t:"r" }             client grid resized (informational)
 *            { t:"ping" }          → { t:"ping" }
 *   server → { t:"replay", d }     ring-buffer history on (re)attach
 *            { t:"d", d }          shell output, stdout+stderr merged
 *            { t:"clear" }         other sockets should clear on reset
 *            { t:"state", s }      { phase, tier, exit, error, pid }
 *            { t:"ping" }          keepalive echo
 *
 * Lifecycle safety (grok review rounds 1+2): every proc handler is generation-
 * guarded (sess.gen); spawnShell never leaks a live child (kills via
 * proc.pid ?? pid, then abandons); reset uses one tracked unref'd recovery
 * timer; destroySession marks, closes clients, clears timers and orphans
 * nothing; eviction only ever removes DETACHED sessions; conn() flushes
 * BEFORE adding the new socket so replay never double-paints.
 *
 * Security: handleUpgrade() enforces a strict Origin allowlist (WS has no
 * CORS — browsers always send Origin; DNS-rebinding presents a mismatched
 * Origin/Host pair) and refuses guessable session ids. The non-loopback
 * token gate runs in server.mjs BEFORE handleUpgrade is called.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { WebSocketServer } from "ws";

const MAX_SESSIONS = 6;
const SESSION_TTL_MS = 15 * 60 * 1000; // detached idle lifetime (dead sessions expire even attached)
const SWEEP_INTERVAL_MS = 60 * 1000;
const REPLAY_MAX = 128 * 1024; // ring size; trims to half when exceeded
const MAX_INPUT = 64 * 1024; // per-frame stdin cap
const FLUSH_MS = 30; // output coalescing window (readline emits tiny chunks fast)
const FLUSH_FORCE_BYTES = 32 * 1024;
const PTY_FALLBACK_MS = 4000; // opt-in bridge exited non-zero this fast → try pipes
const RESET_RECOVERY_MS = 1500; // exit event lost after taskkill → force respawn

const TERM_COLS = Math.min(240, Math.max(40, Number(process.env.PI_WEB_TERM_COLS || 110)));
const TERM_LINES = Math.min(120, Math.max(10, Number(process.env.PI_WEB_TERM_LINES || 32)));

const isLegacyWslBash = (p) =>
	/^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/i.test(String(p).replace(/\//g, "\\"));

function findOnPath(exe) {
	try {
		const r = spawnSync("where", [exe], { encoding: "utf-8", timeout: 5000, windowsHide: true });
		if (r.status === 0 && r.stdout) {
			const first = r.stdout.trim().split(/\r?\n/)[0];
			if (first && fs.existsSync(first)) return first;
		}
	} catch {
		/* ignore */
	}
	return null;
}

// Git roots: explicit env override → portable installs → installed ones.
// usr\bin is checked before bin (msys DLLs live in usr\bin; from a bare spawn
// environment bin\bash.exe can fail to load them — observed on portable C:\Git).
function gitRoots() {
	const roots = [];
	if (process.env.PI_GIT_HOME) roots.push(process.env.PI_GIT_HOME);
	for (const base of ["C:\\Git", "C:\\PortableGit"]) roots.push(base);
	if (process.env.ProgramFiles) roots.push(path.join(process.env.ProgramFiles, "Git"));
	if (process.env["ProgramFiles(x86)"]) roots.push(path.join(process.env["ProgramFiles(x86)"], "Git"));
	if (process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA, "Programs", "Git"));
	return roots;
}

function findBash() {
	const env = process.env.PI_WEB_BASH_SHELL;
	if (env && fs.existsSync(env) && !isLegacyWslBash(env)) return env;
	for (const root of gitRoots()) {
		for (const sub of [path.join("usr", "bin", "bash.exe"), path.join("bin", "bash.exe")]) {
			const p = path.join(root, sub);
			if (fs.existsSync(p) && !isLegacyWslBash(p)) return p;
		}
	}
	const onPath = findOnPath("bash.exe");
	return onPath && !isLegacyWslBash(onPath) ? onPath : null;
}

function shellEnv(agentDir, gitRoot, sessCols, sessLines, workspaceDir) {
	const binDir = path.join(agentDir, "bin");
	const key = Object.keys(process.env).find((k) => k.toLowerCase() === "path") ?? "PATH";
	const cur = process.env[key] ?? "";
	const entries = cur.split(path.delimiter).filter(Boolean);
	// DEFAULTS before launching bash (user requirement): --noprofile skips
	// /etc/profile, so replicate what a real Git Bash session gets. Verified
	// against git-bash.exe → login shell (`bash -l -c env`): PATH head is
	// ~/bin:/usr/local/bin:/usr/bin:/bin — Git's own dirs MUST be on PATH or
	// the shell only has builtins + whatever Windows PATH carries (no
	// ls/grep/sed/awk; `find` would resolve to System32's).
	const gitPaths = gitRoot
		? [path.join(gitRoot, "usr", "bin"), path.join(gitRoot, "mingw64", "bin"), path.join(gitRoot, "bin")].filter((p) => fs.existsSync(p))
		: [];
	const nodeDir = path.dirname(process.execPath); // the running node — `node` must work in the shell
	// guard (grok r3): if node.exe ever lived AT the workspace root, prepending
	// its dir would let a workspace find.exe/git.exe shadow the Git ones — skip
	const nodeDirSafe = nodeDir.toLowerCase() !== String(workspaceDir || "").toLowerCase() ? nodeDir : null;
	const seen = new Set([binDir, nodeDirSafe, ...gitPaths].map((p) => p.toLowerCase()).filter(Boolean));
	const rest = entries.filter((e) => !seen.has(e.toLowerCase()));
	const env = {
		...process.env,
		[key]: [binDir, nodeDirSafe, ...gitPaths, ...rest].filter(Boolean).join(path.delimiter),
	};
	env.HOME = process.env.HOME || process.env.USERPROFILE || ""; // msys tools expect HOME
	env.SHELL = "/usr/bin/bash";
	env.MSYSTEM = "MINGW64"; // a bare login shell defaults to MSYS; Git Bash launches MINGW64
	env.MSYSTEM_PREFIX = "/mingw64";
	env.MSYSTEM_CARCH = "x86_64";
	env.MSYSTEM_CHOST = "x86_64-w64-mingw32";
	env.TERM = "xterm-256color"; // programs that honor TERM without a tty emit colors
	env.COLUMNS = String(sessCols);
	env.LINES = String(sessLines);
	// dedicated size vars for the rc's stty: bash OVERWRITES $COLUMNS/$LINES at
	// interactive startup (it queries the tty it just got — the 80x25 default),
	// so the rc must read these instead (empirically verified)
	env.PI_TERM_COLS = String(sessCols);
	env.PI_TERM_LINES = String(sessLines);
	return env;
}

// C:\Git\usr\bin\bash.exe → C:\Git   (usr\bin layout)
// C:\Program Files\Git\bin\bash.exe → C:\Program Files\Git   (bin layout)
function gitRootFromBash(bashPath) {
	const dir = path.dirname(bashPath); // ...\usr\bin | ...\bin
	const parent = path.dirname(dir); // ...\usr     | ...\<root>
	if (path.basename(dir).toLowerCase() === "bin" && path.basename(parent).toLowerCase() === "usr") {
		return path.dirname(parent);
	}
	return parent;
}

// ONLCR emulation — the pipe tier has no tty line discipline, so bash emits
// BARE \n; a VT emulator moves down WITHOUT returning to column 0 → the
// staircase/cursor offset the user sees after every Enter. Translate \n →
// \r\n exactly like a pty's OPOST|ONLCR would: existing \r\n passes through,
// lone \r (progress bars) is untouched. State carries across chunk boundaries.
function onlcr(sess, s) {
	if (s.indexOf("\n") === -1) {
		sess.onlcrCR = s.length > 0 && s.charCodeAt(s.length - 1) === 13;
		return s;
	}
	let lastCR = sess.onlcrCR;
	let out = "";
	let from = 0;
	for (;;) {
		const i = s.indexOf("\n", from);
		if (i === -1) {
			out += s.slice(from);
			break;
		}
		// is the \n already preceded by \r? (within this string, else the carried
		// flag from the previous chunk)
		const prevIsCR = i > from ? s.charCodeAt(i - 1) === 13 : lastCR;
		if (prevIsCR) out += s.slice(from, i + 1);
		else out += s.slice(from, i) + "\r\n";
		lastCR = false;
		from = i + 1;
	}
	sess.onlcrCR = s.charCodeAt(s.length - 1) === 13;
	return out;
}

function safeSend(ws, obj) {
	if (ws.readyState !== 1) return;
	try {
		ws.send(JSON.stringify(obj));
	} catch {
		/* socket raced closed */
	}
}

// the two known bash-interactive startup warnings (pipe tier) — noise on every
// spawn, printed to stderr before the first prompt. Matched as literal PREFIXES
// so a localized LC_MESSAGES simply shows the lines instead of hiding output.
const STARTUP_NOISE_TEXTS = ["bash: cannot set terminal process group", "bash: no job control"];

// --- msys pty bridge (msys2 util-linux `script`) --------------------------------
// Interactive TUIs (nano/vim) need isatty(stdin)=true; the pipe tier can't
// provide it ("standard input is not a terminal") and winpty's CLI asserts
// headless (winpty.cc:924). msys2's script.exe allocates a REAL msys pty and
// bridges our stdio — bash/nano/vim then see /dev/ptyN, with pty-native ONLCR,
// echo, ^C, job control. It links ONLY against Git's own runtime
// (msys-2.0/intl/iconv — verified via ldd) so we vendor the single exe.
const SCRIPT_EXE_NAME = "script.exe";
const SCRIPT_PKG_URL = "https://repo.msys2.org/msys/x86_64/util-linux-2.40.2-2-x86_64.pkg.tar.zst";
// pinned: sha256 of util-linux-2.40.2-2-x86_64.pkg.tar.zst (verified locally) —
// a re-uploaded/compromised package fails provisioning instead of executing
const SCRIPT_PKG_SHA256 = "969edb185d37986e6feddb3c54807598e3cc6774b736fec3a27d5d27731f7fdd";
const SCRIPT_PKG_MAX_BYTES = 8 * 1024 * 1024;
const PROVISION_RETRY_MS = 60 * 1000; // backoff after a failed provision

export function scriptBridgeDir(dataDir) {
	return path.join(dataDir, "bin", "script");
}

function scriptBridgePath(dataDir) {
	return path.join(scriptBridgeDir(dataDir), SCRIPT_EXE_NAME);
}

// PI_WEB_TERM_BRIDGE: "0"/"pipes" forces the pipe tier; a path uses that exe as
// a script-compatible bridge; unset → auto-provision into data/bin/script/.
// A configured path that doesn't exist is INVALID (fails loudly), not "unset" —
// a typo must not silently trigger the auto-download.
function bridgeOverride() {
	const v = String(process.env.PI_WEB_TERM_BRIDGE || "").trim();
	if (!v) return "auto";
	if (v === "0" || v.toLowerCase() === "pipes") return "pipes";
	return fs.existsSync(v) ? path.resolve(v) : "invalid";
}

// integrity gate for the vendored bridge: PE header + sane size (a crashed
// extract or AV-truncated file must not be treated as a working bridge)
function bridgeUsable(p) {
	try {
		const st = fs.statSync(p);
		if (!st.isFile() || st.size < 8 * 1024 || st.size > 2 * 1024 * 1024) return false;
		const fd = fs.openSync(p, "r");
		const head = Buffer.alloc(2);
		fs.readSync(fd, head, 0, 2, 0);
		fs.closeSync(fd);
		return head[0] === 0x4d && head[1] === 0x5a; // "MZ"
	} catch {
		return false;
	}
}

function provisionScriptBridge(dataDir, debug) {
	const exe = scriptBridgePath(dataDir);
	if (bridgeUsable(exe)) return Promise.resolve(exe);
	return (async () => {
		try {
			const zlib = await import("node:zlib");
			if (typeof zlib.zstdDecompressSync !== "function") {
				throw new Error("node zlib lacks zstdDecompressSync (need node >= 22.15)");
			}
			fs.mkdirSync(scriptBridgeDir(dataDir), { recursive: true });
			const res = await fetch(SCRIPT_PKG_URL, { signal: AbortSignal.timeout(60000) });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const len = Number(res.headers.get("content-length") || 0);
			if (len > SCRIPT_PKG_MAX_BYTES) throw new Error(`package too large (${len} bytes)`);
			let zst = Buffer.from(await res.arrayBuffer());
			if (zst.length > SCRIPT_PKG_MAX_BYTES) throw new Error(`package too large (${zst.length} bytes)`);
			// pinned digest — a changed upstream package never executes
			const got = crypto.createHash("sha256").update(zst).digest("hex");
			if (got !== SCRIPT_PKG_SHA256) throw new Error(`sha256 mismatch: got ${got}`);
			const tarBuf = zlib.zstdDecompressSync(zst);
			zst = null; // release before the blocking tar
			// unique temp dir + atomic rename: two node processes sharing dataDir
			// must not clobber each other's extraction (grok P1-8)
			const tmpDir = path.join(scriptBridgeDir(dataDir), `.tmp-${process.pid}-${Date.now()}`);
			fs.mkdirSync(tmpDir, { recursive: true });
			try {
				const tarFile = path.join(tmpDir, "util-linux.pkg.tar");
				fs.writeFileSync(tarFile, tarBuf);
				// System32 tar (Win10+ bsdtar) first — never search PATH for a tool
				// we're about to hand an archive to (grok P1-4)
				const sysroot = process.env.SystemRoot || "C:\\Windows";
				const tars = [path.join(sysroot, "System32", "tar.exe")];
				if (process.env.PI_GIT_HOME) tars.push(path.join(process.env.PI_GIT_HOME, "usr", "bin", "tar.exe"));
				const tarExe = tars.find((t) => fs.existsSync(t));
				if (!tarExe) throw new Error("no tar.exe found (System32\\tar.exe missing)");
				// RELATIVE member + cwd: GNU tar reads "C:\..." as a remote host spec
				const r = spawnSync(
					tarExe,
					["-xf", "util-linux.pkg.tar", "--strip-components=2", `usr/bin/${SCRIPT_EXE_NAME}`],
					{ cwd: tmpDir, stdio: "pipe", timeout: 30000, windowsHide: true },
				);
				if (r.status !== 0) throw new Error(`tar exited ${r.status}: ${String(r.stderr || "").slice(0, 200)}`);
				const extracted = path.join(tmpDir, SCRIPT_EXE_NAME);
				if (!bridgeUsable(extracted)) throw new Error("script.exe missing or invalid after extraction");
				fs.renameSync(extracted, exe); // atomic publish
				debug("[term] provisioned msys pty bridge:", exe);
				return exe;
			} finally {
				try {
					fs.rmSync(tmpDir, { recursive: true, force: true });
				} catch {
					/* ignore */
				}
			}
		} catch (err) {
			debug("[term] pty bridge provisioning failed — pipe tier stays:", err?.message || err);
			return null; // retried with backoff (ensureBridge)
		}
	})();
}

export function createTerminalHub({
	workspaceDir,
	agentDir,
	dataDir,
	killTree,
	allowedOrigins, // Set<host:port> — browsers' Origin must match (see header)
	isLoopback, // (req) => boolean
	debug = () => {},
	stripWs = (s) => s,
}) {
	// fail closed if the caller forgets the security inputs
	const origins = allowedOrigins instanceof Set ? allowedOrigins : new Set();
	const loopbackOf = typeof isLoopback === "function" ? isLoopback : () => false;

	// dedicated WSS: the shared 25MB maxPayload would let one oversized frame
	// allocate 25MB per socket; terminal frames are tiny
	const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_INPUT + 64 * 1024 });
	wss.on("connection", (ws, req) => conn(ws, req));

	const sessions = new Map(); // id → session
	let bashPath = null;
	let pathsResolved = false;
	let rcFile = null;

	// msys pty bridge provisioning — kicked at hub creation; failures back off
	// (PROVISION_RETRY_MS) so a dead network can't hammer repo.msys2.org on
	// every spawn
	let bridgePromise = null;
	let bridgeNextTryAt = 0;
	function ensureBridge() {
		if (Date.now() < bridgeNextTryAt) return null;
		if (!bridgePromise) {
			bridgePromise = provisionScriptBridge(dataDir, debug)
				.then((exe) => {
					if (!exe) {
						bridgePromise = null; // allow retry
						bridgeNextTryAt = Date.now() + PROVISION_RETRY_MS;
					}
					return exe;
				});
		}
		return bridgePromise;
	}

	function resolvePaths() {
		if (pathsResolved) return;
		pathsResolved = true;
		bashPath = findBash();
		debug("[term] bash:", bashPath || "(none)");
	}

	// interactive bash rc: colored prompt wrapped in OSC 133;A/B markers,
	// PROMPT_COMMAND emitting OSC 133;D;<exit> + OSC 7 cwd before each prompt.
	// Raw-over-pipes means the client SEES these markers — wterm strips them,
	// our scanner reads exit codes from them. PS1 is SINGLE-quoted with the raw
	// ESC/BEL bytes embedded directly (no $'' — its \uHHHH handling is a
	// landmine, and unknown escapes leaving the backslash in is bash-specific);
	// prompt escapes (\u \h \w \$ \[ \]) must stay literal for prompt expansion.
	// HISTFILE=/dev/null: web commands must not land in the user's real history.
	// ADAPTIVE PROMPT (user report): on a phone the grid is ~40 cols — the full
	// user@host:path prompt EXCEEDS the line width and readline's redraw math
	// breaks (garbled cursor, line-swap glitches when typing). The hostname is
	// noise anyway (single-host web UI): full prompt = user:cwd, narrow = cwd
	// basename only. PI_TERM_COLS is the session's real grid (set per spawn).
	function ensureRcFile() {
		if (rcFile) return rcFile;
		try {
			fs.mkdirSync(dataDir, { recursive: true });
			rcFile = path.join(dataDir, "term-shell.rc");
			const ESC = "\x1b";
			const BEL = "\x07";
			const ps1Full =
				`${ESC}]133;A${BEL}` +
				`\\[${ESC}[01;32m\\]\\u\\[${ESC}[0m\\]:\\[${ESC}[01;34m\\]\\w\\[${ESC}[0m\\]\\$ ` +
				`\\[${ESC}]133;B${BEL}\\]`;
			// narrow grid: cwd basename only — "pi-web-ui$ " fits where the full
			// prompt cannot; markers/colors preserved
			const ps1Narrow =
				`${ESC}]133;A${BEL}` +
				`\\[${ESC}[01;32m\\]\\W\\$ \\[${ESC}[0m\\]\\[${ESC}]133;B${BEL}\\]`;
			fs.writeFileSync(
				rcFile,
				"# pi-web terminal shell integration (generated — regenerated on server boot)\n" +
					"HISTFILE=/dev/null\n" +
					"HISTCONTROL=ignoredups:ignorespace\n" +
					// pty tier: script.exe defaults the msys pty to 80x25 — size it from
					// the SESSION env (COLUMNS/LINES = the client's actual grid, set per
					// spawn) so nano/vim fit exactly — user report: bottom UI cropped
					// when pty rows exceeded emulator rows. Harmless no-op in the pipe
					// tier (stty fails without a tty).
					`stty cols "$PI_TERM_COLS" rows "$PI_TERM_LINES" 2>/dev/null || true\n` +
					// stty fixes the pty, but bash/readline already snapshotted the
					// 80x25 default — a self-addressed WINCH makes them re-read it
					// immediately (grok r4)
					`kill -s WINCH $$ 2>/dev/null || true\n` +
					// adaptive prompt: choose by the session's REAL grid width
					`if [ "\${PI_TERM_COLS:-110}" -ge 60 ] 2>/dev/null; then\n` +
					`  PS1='${ps1Full}'\n` +
					`else\n` +
					`  PS1='${ps1Narrow}'\n` +
					`fi\n` +
					// spaces → %20: OSC 7 wants a URI; full percent-encoding isn't worth
					// the quoting pain in pure bash — the client decodes leniently
					`PROMPT_COMMAND='printf "\\033]133;D;%s\\007\\033]7;file://%s\\007" "$?" "\${PWD// /%20}"'\n`,
				"utf8",
			);
		} catch (err) {
			debug("[term] rc file write failed:", err?.message || err);
			rcFile = null;
		}
		return rcFile;
	}

	function newSession(id) {
		return {
			id,
			proc: null,
			pid: null,
			gen: 0, // every spawn increments; handlers capture their gen and no-op on mismatch
			tier: null, // "pty" | "pipes"
			phase: "starting", // starting | ready | dead | error
			exit: null,
			error: null,
			ring: "",
			clients: new Set(),
			createdAt: Date.now(),
			lastActivity: Date.now(),
			destroyed: false,
			resetting: false,
			resetTimer: null,
			fallbackTried: false,
			spawnedAt: 0,
			outBytes: 0,
			pending: "", // coalesced output
			flushTimer: null,
			errLineBuf: "", // stderr line filter (startup warnings), partial line
			onlcrCR: false, // ONLCR carry: previous chunk ended with \r
			wantCols: 0, // client grid — set from the connect query, used for
			wantRows: 0, // COLUMNS/LINES + the pty stty at (re)spawn
			decOut: new StringDecoder("utf8"),
			decErr: new StringDecoder("utf8"),
		};
	}

	function stateFrame(sess) {
		return {
			t: "state",
			s: { phase: sess.phase, tier: sess.tier, exit: sess.exit, error: sess.error ? stripWs(sess.error) : null, pid: sess.pid },
		};
	}

	function broadcast(sess, msg) {
		for (const ws of sess.clients) safeSend(ws, msg);
	}

	function touch(sess) {
		sess.lastActivity = Date.now();
	}

	function scheduleFlush(sess) {
		if (sess.flushTimer) return;
		const t = setTimeout(() => {
			sess.flushTimer = null;
			flush(sess);
		}, FLUSH_MS);
		t.unref?.(); // a pending 30ms flush must not pin shutdown
		sess.flushTimer = t;
	}

	function flush(sess) {
		if (sess.flushTimer) {
			clearTimeout(sess.flushTimer);
			sess.flushTimer = null;
		}
		if (!sess.pending) return;
		const d = sess.pending;
		sess.pending = "";
		broadcast(sess, { t: "d", d });
	}

	// append to ring + pending WITHOUT touching phase (banners, decoder tails)
	function append(sess, s) {
		if (sess.destroyed || !s) return;
		sess.outBytes += s.length;
		sess.ring += s;
		if (sess.ring.length > REPLAY_MAX) {
			// trim to half; the cut can split a UTF-8 pair/escape sequence —
			// emulators resync on invalid input, and replay accuracy is best-effort
			sess.ring = sess.ring.slice(Math.floor(REPLAY_MAX / 2));
		}
		sess.pending += s;
		if (sess.pending.length >= FLUSH_FORCE_BYTES) flush(sess);
		else scheduleFlush(sess);
	}

	function feed(sess, s) {
		if (sess.destroyed || !s) return;
		if (sess.phase === "starting") {
			sess.phase = "ready";
			// the stderr line filter may still hold the first prompt (bash prints
			// PS1 on stderr with NO trailing newline) — emit it before anything else
			if (sess.errLineBuf) {
				const rest = sess.errLineBuf;
				sess.errLineBuf = "";
				append(sess, rest);
			}
			broadcast(sess, stateFrame(sess));
		}
		append(sess, s);
	}

	// drop the known startup warnings (complete lines only); an incomplete tail
	// is held ONLY while it could still grow into a noise line — everything else
	// passes through immediately, and feed() flushes whatever is held on the
	// starting→ready flip so the first prompt can never be swallowed
	function filterStartupNoise(sess, s) {
		if (sess.phase !== "starting") return s;
		const buf = (sess.errLineBuf || "") + s;
		const parts = buf.split(/\r?\n/);
		const tail = parts.pop() ?? "";
		const kept = parts.filter((line) => !STARTUP_NOISE_TEXTS.some((t) => line.startsWith(t)));
		sess.errLineBuf = tail && STARTUP_NOISE_TEXTS.some((t) => t.startsWith(tail)) ? tail : "";
		const out = kept.length ? kept.join("\n") + "\n" : "";
		if (sess.errLineBuf) return out; // hold the possible noise line
		return out + tail; // tail can't be noise — emit it now
	}

	// single reset point for every (re)spawn: no stale ring/pending/decoders
	function beginSpawn(sess, tier) {
		if (sess.flushTimer) {
			clearTimeout(sess.flushTimer);
			sess.flushTimer = null;
		}
		sess.pending = "";
		sess.ring = "";
		sess.outBytes = 0;
		sess.errLineBuf = "";
		sess.onlcrCR = false;
		sess.decOut = new StringDecoder("utf8");
		sess.decErr = new StringDecoder("utf8");
		spawnShell(sess, tier);
	}

	// kill whatever is live, deriving the pid from the LIVE proc first (a nulled
	// sess.pid must never cause a missed kill — that leaks the old bash)
	function killLive(sess) {
		const proc = sess.proc;
		const pid = proc?.pid ?? sess.pid;
		sess.proc = null;
		sess.pid = null;
		if (pid) {
			try {
				killTree(pid);
			} catch {
				/* gen-guarded handlers make late events no-ops */
			}
		}
		return pid;
	}

	function onShellExit(sess, gen, code) {
		if (gen !== sess.gen || sess.destroyed) return; // stale proc — already replaced
		flush(sess);
		// emit any leftover multibyte fragment so the tail isn't dropped
		try {
			append(sess, sess.decOut.end());
		} catch {
			/* end() twice */
		}
		try {
			append(sess, sess.decErr.end());
		} catch {
			/* end() twice */
		}
		flush(sess);
		sess.proc = null;
		sess.pid = null;
		if (sess.resetTimer) {
			clearTimeout(sess.resetTimer);
			sess.resetTimer = null;
		}
		const elapsed = Date.now() - sess.spawnedAt;
		// auto-fallback (opt-in winpty only): the bridge dying non-zero within 4s
		// of spawn is a startup failure — a real shell exits 0 on "exit" and
		// never exits non-zero on its own otherwise
		if (sess.tier === "pty" && !sess.fallbackTried && !sess.resetting && code !== 0 && elapsed < PTY_FALLBACK_MS) {
			sess.fallbackTried = true;
			debug("[term] pty bridge died instantly — falling back to pipe tier");
			beginSpawn(sess, "pipes");
			// banner WITHOUT the phase flip: the noise filter must stay armed
			// until the new pipe-shell actually produces output
			append(sess, "\r\n\x1b[33m[console bridge failed — using pipe mode]\x1b[0m\r\n");
			return;
		}
		sess.exit = code ?? null;
		if (sess.resetting) {
			sess.resetting = false;
			beginSpawn(sess, respawnTier(sess));
		} else {
			// a spawn 'error' already set phase=error + broadcast — keep it and
			// just update the frame with the exit code
			if (sess.phase !== "error") sess.phase = "dead";
			broadcast(sess, stateFrame(sess));
		}
	}

	function spawnShell(sess, tier) {
		if (sess.destroyed) return;
		resolvePaths();
		// never leak a live child: kill (via proc.pid) + abandon before replacing
		if (sess.proc) killLive(sess);
		sess.gen += 1;
		const gen = sess.gen;
		if (!bashPath) {
			sess.phase = "error";
			sess.tier = null;
			sess.error = "no bash found — install Git for Windows or set PI_WEB_BASH_SHELL";
			broadcast(sess, stateFrame(sess));
			return;
		}
		const env = shellEnv(agentDir, gitRootFromBash(bashPath), sess.wantCols || TERM_COLS, sess.wantRows || TERM_LINES, workspaceDir);
		// bridge decision at spawn time — provisioning may complete between spawns
		let bridge = null;
		{
			const override = bridgeOverride();
			if (override === "pipes") bridge = null;
			else if (override === "invalid") {
				// a typo'd PI_WEB_TERM_BRIDGE must fail loudly, not auto-download
				sess.phase = "error";
				sess.tier = null;
				sess.error = `PI_WEB_TERM_BRIDGE points to a missing file: ${String(process.env.PI_WEB_TERM_BRIDGE).trim()}`;
				broadcast(sess, stateFrame(sess));
				return;
			} else if (override !== "auto") {
				bridge = override;
			} else {
				bridge = bridgeUsable(scriptBridgePath(dataDir)) ? scriptBridgePath(dataDir) : null;
				if (!bridge) void ensureBridge(); // keep provisioning in the background
			}
		}
		// sh -c injection guard (grok P1-7): the -c command string is parsed by sh —
		// paths containing shell metacharacters must not reach it (backslashes are
		// normalized away by fwd(); $ ` " are the dangerous survivors)
		const shUnsafe = (p) => /[$`"]/.test(String(p));
		let proc;
		try {
			if (tier === "pty" && bridge && !shUnsafe(bashPath) && !(rcFile && shUnsafe(rcFile))) {
				// msys pty bridge (msys2 util-linux script): a REAL /dev/ptyN for
				// bash — nano/vim get isatty(stdin)=true, pty-native ONLCR, ^C.
				// -c runs via sh → forward slashes + quoting; /dev/null typescript.
				const rc = ensureRcFile();
				const fwd = (p) => String(p).replace(/\\/g, "/");
				// NOTE: --rcfile must precede -i — "bash --noprofile -i --rcfile f"
				// dies with "--: invalid option" (verified on Git Bash 5.3)
				let cmdLine = `"${fwd(bashPath)}" --noprofile`;
				if (rc) cmdLine += ` --rcfile "${fwd(rc)}"`;
				cmdLine += " -i";
				proc = spawn(bridge, ["-q", "-f", "-c", cmdLine, "/dev/null"], {
					cwd: workspaceDir,
					env,
					stdio: ["pipe", "pipe", "pipe"],
					windowsHide: true,
				});
			} else {
				tier = "pipes";
				const rc = ensureRcFile();
				const args = ["--noprofile"];
				if (rc) args.push("--rcfile", rc);
				args.push("-i");
				proc = spawn(bashPath, args, {
					cwd: workspaceDir,
					env,
					stdio: ["pipe", "pipe", "pipe"],
					windowsHide: true,
				});
			}
		} catch (err) {
			if (tier === "pty" && !sess.fallbackTried) {
				sess.fallbackTried = true;
				beginSpawn(sess, "pipes");
				return;
			}
			sess.phase = "error";
			sess.error = String(err?.message || err);
			broadcast(sess, stateFrame(sess));
			return;
		}
		sess.proc = proc;
		sess.pid = proc.pid ?? null;
		sess.tier = tier;
		sess.phase = "starting";
		sess.exit = null;
		sess.error = null;
		sess.spawnedAt = Date.now();
		broadcast(sess, stateFrame(sess));
		debug(`[term] session ${sess.id}: spawned ${tier} pid=${sess.pid} gen=${gen}`);

		// every handler captures gen — a replaced/killed proc's events no-op.
		// onlcr() emulates the pty line discipline (bare \n → \r\n) — without it
		// the emulator staircase-offsets the cursor after every Enter.
		proc.stdout?.on("data", (buf) => {
			if (gen !== sess.gen || sess.destroyed) return;
			feed(sess, onlcr(sess, sess.decOut.write(buf)));
		});
		proc.stdout?.on("error", () => {}); // EPIPE on a killed child must not throw
		proc.stderr?.on("data", (buf) => {
			if (gen !== sess.gen || sess.destroyed) return;
			feed(sess, onlcr(sess, filterStartupNoise(sess, sess.decErr.write(buf))));
		});
		proc.stderr?.on("error", () => {});
		proc.stdin?.on("error", () => {});
		proc.once("error", (err) => {
			if (gen !== sess.gen || sess.destroyed) return;
			sess.phase = "error";
			sess.error = String(err?.message || err);
			broadcast(sess, stateFrame(sess));
		});
		proc.once("exit", (code) => onShellExit(sess, gen, code));
	}

	function writeInput(sess, data) {
		if (sess.destroyed) return false;
		touch(sess);
		if (!sess.proc || (sess.phase !== "ready" && sess.phase !== "starting")) return false;
		if (!data) return true;
		try {
			if (sess.proc.stdin.writableLength > 1024 * 1024) {
				debug("[term] input dropped (backpressure)");
				return false;
			}
			sess.proc.stdin.write(data);
			return true;
		} catch {
			return false;
		}
	}

	// Exit button semantics (sonnet r2): sending literal "exit\r" is a footgun
	// when a TUI owns the pty (vim would eat the keystrokes) — so Exit = kill the
	// shell now, no respawn. Unambiguous from any foreground state.
	function killShell(sess) {
		if (sess.destroyed) return;
		touch(sess);
		if (sess.resetTimer) {
			clearTimeout(sess.resetTimer);
			sess.resetTimer = null;
		}
		sess.resetting = false;
		killLive(sess);
		sess.phase = "dead"; // the exit event will confirm (same phase, second frame)
		broadcast(sess, stateFrame(sess));
	}

	function respawnTier(sess) {
		// P0 (grok r3): a session that started as pipes while provisioning was
		// still running MUST be allowed to upgrade to pty on its next respawn —
		// only a REAL bridge crash (fallbackTried) pins it to pipes
		return sess.tier === "pty" && sess.fallbackTried ? "pipes" : "pty";
	}

	function resetSession(sess) {
		if (sess.destroyed) return;
		touch(sess);
		sess.fallbackTried = false;
		if (sess.resetTimer) {
			clearTimeout(sess.resetTimer);
			sess.resetTimer = null;
		}
		if (sess.proc || sess.pid) {
			sess.resetting = true;
			killLive(sess); // pid stays derivable from sess.proc until exit fires
			broadcast(sess, { t: "clear" }); // other sockets: drop the dead shell's screen
			// if the exit event never arrives (taskkill race), force-recover.
			// beginSpawn() re-bumps gen, so a LATE exit of the old proc no-ops.
			const t = setTimeout(() => {
				sess.resetTimer = null;
				if (sess.destroyed || !sess.resetting) return; // exit already handled it
				sess.resetting = false;
				beginSpawn(sess, respawnTier(sess));
			}, RESET_RECOVERY_MS);
			t.unref?.();
			sess.resetTimer = t;
		} else {
			sess.resetting = false;
			broadcast(sess, { t: "clear" });
			beginSpawn(sess, respawnTier(sess));
		}
	}

	// only ever evicts DETACHED sessions (an attached session is live work)
	function evictOldestDetached() {
		let oldest = null;
		for (const s of sessions.values()) {
			if (s.clients.size === 0 && (!oldest || s.lastActivity < oldest.lastActivity)) oldest = s;
		}
		if (oldest) {
			debug("[term] evicting detached session", oldest.id);
			destroySession(oldest);
			return true;
		}
		return false;
	}

	function destroySession(sess) {
		if (sess.destroyed) return;
		sess.destroyed = true;
		if (sess.flushTimer) {
			clearTimeout(sess.flushTimer);
			sess.flushTimer = null;
		}
		if (sess.resetTimer) {
			clearTimeout(sess.resetTimer);
			sess.resetTimer = null;
		}
		sess.gen += 1; // orphan every proc handler
		for (const ws of sess.clients) {
			try {
				ws.close(4002, "terminal session ended");
			} catch {
				/* ignore */
			}
		}
		sess.clients.clear();
		killLive(sess);
		sess.phase = "dead";
		sessions.delete(sess.id);
	}

	function validSessionId(id) {
		// unguessable: the id IS the auth for reattaching to a live shell
		// (loopback peers share the no-token path) — UUID-ish length, not a
		// guessable word like "main" or "1"
		return id.length >= 16 && !/^[0-9_-]+$/.test(id);
	}

	function conn(ws, req) {
		const url = new URL(req.url, "http://x");
		const id = String(url.searchParams.get("session") || "")
			.replace(/[^a-zA-Z0-9_-]/g, "")
			.slice(0, 64);
		if (!validSessionId(id)) {
			ws.close(4000, "unguessable session id required");
			return;
		}
		// client grid → pty size: full-screen TUIs (nano/vim) paint exactly
		// cols×rows, so the pty MUST match the emulator or the bottom UI crops
		const clampDim = (v, lo, hi) => {
			const n = Math.round(Number(v));
			return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : 0;
		};
		const qCols = clampDim(url.searchParams.get("cols"), 20, 500);
		const qRows = clampDim(url.searchParams.get("rows"), 5, 200);
		let sess = sessions.get(id);
		if (!sess) {
			if (sessions.size >= MAX_SESSIONS && !evictOldestDetached()) {
				ws.close(4001, "too many terminal sessions");
				return;
			}
			sess = newSession(id);
			sess.wantCols = qCols;
			sess.wantRows = qRows;
			sessions.set(id, sess);
			// spawnShell demotes to the pipe tier itself when no bridge is available
			beginSpawn(sess, "pty");
			void ensureBridge(); // provisioning may not have finished yet
		}
		// flush BEFORE adding the new socket: existing clients get the pending
		// tail as a live frame, the new socket gets the same bytes in the replay
		// snapshot — never both (double paint)
		flush(sess);
		sess.clients.add(ws);
		touch(sess);
		safeSend(ws, { t: "replay", d: sess.ring });
		safeSend(ws, stateFrame(sess));

		ws.on("message", (raw) => {
			if (sess.destroyed) return;
			if (raw.length > MAX_INPUT + 1024) return;
			let m;
			try {
				m = JSON.parse(raw.toString());
			} catch {
				return;
			}
			if (!m || typeof m !== "object" || Array.isArray(m)) return; // JSON.parse("null")
			if (m.t === "i" && typeof m.d === "string") {
				if (m.d.length <= MAX_INPUT) writeInput(sess, m.d);
			} else if (m.t === "reset") {
				resetSession(sess);
			} else if (m.t === "kill") {
				killShell(sess);
			} else if (m.t === "r" || m.t === "ping") {
				touch(sess);
				// remember the client's latest grid: Restart/reset respawns the pty
				// at this size (no live-resize channel into script.exe's pty)
				if (m.t === "r") {
					const c = clampDim(m.cols, 20, 500);
					const r2 = clampDim(m.rows, 5, 200);
					if (c) sess.wantCols = c;
					if (r2) sess.wantRows = r2;
				}
				if (m.t === "ping") safeSend(ws, { t: "ping" });
			}
		});
		ws.on("close", () => {
			if (!sess.destroyed) {
				sess.clients.delete(ws);
				touch(sess);
			}
		});
		ws.on("error", () => {
			if (!sess.destroyed) sess.clients.delete(ws);
		});
	}

	// upgrade path: strict Origin allowlist (WS has no CORS; browsers always
	// send Origin — this defeats both drive-by WS dialing and DNS-rebinding,
	// where the Host header stays ours but Origin is the attacker page's).
	// The non-loopback token gate already ran in server.mjs before we get here.
	function handleUpgrade(req, socket, head) {
		const origin = req.headers.origin;
		if (origin) {
			let host = null;
			try {
				host = new URL(origin).host.toLowerCase();
			} catch {
				/* reject below */
			}
			if (!host || !origins.has(host)) {
				debug("[term] rejected cross-origin WS from", origin);
				socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
				socket.destroy();
				return;
			}
		} else if (!loopbackOf(req)) {
			socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
			socket.destroy();
			return;
		}
		wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
	}

	void ensureBridge(); // provision the msys pty bridge ASAP (first use may already be live)

	const sweeper = setInterval(() => {
		const now = Date.now();
		for (const s of [...sessions.values()]) {
			const idle = now - s.lastActivity;
			if (s.clients.size === 0 && idle > SESSION_TTL_MS) {
				debug("[term] TTL sweep: killing detached session", s.id);
				destroySession(s);
			} else if ((s.phase === "dead" || s.phase === "error") && s.clients.size > 0 && idle > SESSION_TTL_MS) {
				// a dead shell an abandoned tab still holds must not squat a slot
				debug("[term] TTL sweep: reaping dead session", s.id);
				destroySession(s);
			}
		}
	}, SWEEP_INTERVAL_MS);
	sweeper.unref?.();

	return {
		handleUpgrade,
		size: () => sessions.size,
		list: () =>
			[...sessions.values()].map((s) => ({
				id: s.id,
				tier: s.tier,
				phase: s.phase,
				clients: s.clients.size,
				pid: s.pid,
				idleMs: Date.now() - s.lastActivity,
				outBytes: s.outBytes,
			})),
	};
}
