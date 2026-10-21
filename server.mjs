#!/usr/bin/env node
/**
 * server.mjs — local server for the pi web UI (Hono + ws + worker store).
 *
 * Endpoints:
 *   GET  /                          static frontend (public/)
 *   GET  /api/health                -> { ok, bootId, piDir }
 *   GET  /api/version               -> { buildId, bootId }
 *   GET  /api/debug/state           -> diagnostics (connections, sessions, uptime)
 *   GET  /api/pi/config             -> providers + defaults from pi config
 *   GET  /api/pi/keys               -> all provider keys from auth.json
 *   POST /api/pi/key               -> { provider } -> key from auth.json
 *   GET  /api/sessions              -> session list from worker store
 *   POST /api/agent/session        -> create agent session
 *   GET  /api/agent/session/:id    -> session state
 *   POST /api/agent/prompt         -> send a user prompt
 *   POST /api/agent/abort          -> abort the current run
 *   POST /api/agent/model          -> set model
 *   POST /api/agent/thinking       -> set thinking level
 *   GET  /api/agent/events         -> SSE stream of agent events
 *   ANY  /api/proxy/?url=...       -> CORS proxy (undici-hardened)
 *   WS   /ws/sync                  -> session metadata sync
 *   WS   /ws/agent                 -> live agent events per session
 *
 * Env: PI_DIR, PORT/PI_WEB_PORT, HOST/PI_WEB_HOST, PI_WEB_TOKEN, PI_WEB_DEBUG, PI_WEB_DATA_DIR
 */
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { WebSocketServer } from "ws";
import { Agent as UndiciAgent, fetch as undiciFetch } from "undici";
import { AgentHub } from "./agent-hub.mjs";
import { createTerminalHub } from "./terminal-hub.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, "public");
const PI_DIR = path.resolve(process.env.PI_DIR || "C:/pi-windows-x64/.pi");
const DATA_DIR = path.resolve(process.env.PI_WEB_DATA_DIR || path.join(__dirname, "data"));
const PORT = Number(process.env.PORT || process.env.PI_WEB_PORT || 8787);
const HOST = process.env.HOST || process.env.PI_WEB_HOST || "0.0.0.0";
const TOKEN = process.env.PI_WEB_TOKEN || "";
const DEBUG = process.env.PI_WEB_DEBUG === "1" || process.argv.includes("--debug");
const BOOT_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const BUILD_ID = (fs.readdirSync(PUBLIC + "/assets").find((f) => /^app-[A-Z0-9]+\.js$/.test(f)) || "unknown").replace(".js", "");

const dlog = (...a) => { if (DEBUG) console.log("[pi-web:debug]", ...a); };

// keep alive through unexpected errors
process.on("uncaughtException", (err) => console.error("[pi-web] uncaught (kept alive):", err?.message || err));
process.on("unhandledRejection", (err) => console.error("[pi-web] unhandled rejection (kept alive):", err));

// --- pi config helpers --------------------------------------------------------
function readJsonSafe(file) {
	try { return JSON.parse(fs.readFileSync(path.join(PI_DIR, file), "utf8")); }
	catch { return null; }
}

function piConfig() {
	const store = readJsonSafe("models-store.json") || {};
	const settings = readJsonSafe("settings.json") || {};
	const providers = [];
	for (const [name, entry] of Object.entries(store)) {
		const models = Array.isArray(entry?.models) ? entry.models : [];
		if (models.length === 0) continue;
		providers.push({ name, baseUrl: models.find((m) => m.baseUrl)?.baseUrl || "", models });
	}
	return {
		providers,
		defaults: {
			provider: settings.default_provider || settings.defaultProvider || undefined,
			model: settings.default_model || settings.defaultModel || undefined,
			thinkingLevel: settings.defaultThinkingLevel || undefined,
		},
	};
}

// --- auth: auto-generated token for non-loopback access ----------------------
// Blanket gate: EVERY /api/* and /ws/* request from a non-loopback peer requires
// the token. Secure by default: on first boot a token is generated and persisted
// to data/auth-token.txt (print once in the log). Deliberately a HEADER token
// (x-pi-web-token), not a cookie — a custom header cannot be attached cross-origin
// by a random web page, so CSRF is structurally impossible; do NOT swap for cookies.
// Loopback peers skip the gate (OS loopback boundary already authenticates them).
let AUTH_TOKEN = process.env.PI_WEB_TOKEN || "";
const AUTH_TOKEN_FILE = path.join(DATA_DIR, "auth-token.txt");
if (!AUTH_TOKEN) {
	try { AUTH_TOKEN = fs.readFileSync(AUTH_TOKEN_FILE, "utf8").trim(); } catch { /* first boot */ }
	if (!AUTH_TOKEN) {
		AUTH_TOKEN = crypto.randomBytes(24).toString("base64url");
		fs.mkdirSync(DATA_DIR, { recursive: true });
		fs.writeFileSync(AUTH_TOKEN_FILE, AUTH_TOKEN);
	}
}
function isLoopback(req) {
	const ra = String(req?.socket?.remoteAddress || "");
	return ra === "127.0.0.1" || ra === "::1" || ra === "::ffff:127.0.0.1";
}
function requestToken(req) {
	return String(req?.headers?.["x-pi-web-token"] || new URL(req.url, "http://x").searchParams.get("token") || "");
}
function tokenMatches(req) {
	// constant-time compare (timing side-channel is low-severity here, but it's one line)
	const given = Buffer.from(requestToken(req));
	const want = Buffer.from(AUTH_TOKEN);
	return given.length === want.length && crypto.timingSafeEqual(given, want);
}
function authorized(req) {
	return isLoopback(req) || (AUTH_TOKEN && tokenMatches(req));
}

// --- browser-origin allowlist (DNS-rebinding defense) ------------------------
// Loopback-trust alone is not a browser boundary: a rebinding hostname (or a
// public DNS name that already points at 127.0.0.1, e.g. *.nip.io / localtest.me)
// makes an attacker page SAME-ORIGIN with this server while the socket is
// loopback — every loopback-exempt route becomes readable. Fix: privileged
// routes require BOTH the Host header AND the Origin header (when the browser
// sends one) to name a host this server is ACTUALLY reachable on. The same set
// backs the /ws/sync + /ws/agent upgrade gates and the terminal hub. Custom DNS
// names / reverse proxies: add them via PI_WEB_TERM_ORIGIN.
const ALLOWED_HOSTS = new Set();
(function buildAllowedHosts() {
	const port = String(PORT);
	const add = (h) => ALLOWED_HOSTS.add(`${String(h).toLowerCase()}:${port}`);
	add("localhost");
	add("127.0.0.1");
	add("[::1]");
	try { add(os.hostname()); } catch { /* hostname unavailable */ }
	try {
		for (const n of Object.values(os.networkInterfaces()).flat()) {
			if (!n || n.internal || !n.address) continue;
			const fam = String(n.family); // Node historically: "IPv4"/"IPv6" (older: 4/6)
			const addr = String(n.address).split("%")[0]; // strip IPv6 zone id
			if (fam === "IPv4" || fam === "4") add(addr);
			else if (fam === "IPv6" || fam === "6") add(`[${addr}]`);
		}
	} catch { /* ignore */ }
	// extra names (reverse proxy, custom DNS) — host or host:port, comma-separated
	// (scheme stripped, bare IPv6 bracket-wrapped — "http://box.local/" must match)
	for (const extra of (process.env.PI_WEB_TERM_ORIGIN || "").split(",")) {
		let v = extra.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
		if (!v) continue;
		const isV6 = !v.includes("]") && (v.match(/:/g) || []).length > 1;
		if (isV6) v = `[${v}]`;
		const hasPort = isV6 ? v.includes("]:") : v.includes(":");
		ALLOWED_HOSTS.add(hasPort ? v : `${v}:${port}`);
	}
})();
function headerHostAllowed(hostHeader) {
	let h = String(hostHeader || "").toLowerCase().trim();
	if (!h) return false;
	h = h.replace(/\.+$/, ""); // FQDN trailing dot: "localhost." → "localhost"
	// portless Host (browsers omit :80/:443): normalize to host:PORT before the set lookup
	if (/^\[[^\]]+\]$/.test(h)) h = `${h}:${PORT}`; // bracketed IPv6 without port
	else if (!h.includes(":")) h = `${h}:${PORT}`;
	return ALLOWED_HOSTS.has(h);
}
// Privileged scope (2026-10-21 r2): EVERY /api/* route except /api/health — a rebound page may not
// read session content via un-gated GETs either (/api/agent/session/:id returns message bodies).
function browserOriginAllowed(req) {
	if (!headerHostAllowed(req?.headers?.host)) return false; // rebinding/nip.io Host fails here
	const origin = req?.headers?.origin;
	if (!origin) return true; // non-browser — token gate still applies where required
	let oh = null;
	try { oh = new URL(origin).host.toLowerCase(); } catch { return false; } // malformed Origin
	return !!oh && ALLOWED_HOSTS.has(oh);
}

// --- MIME types -------------------------------------------------------------
const MIME = {
	".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
	".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".map": "application/json",
};

// --- app ----------------------------------------------------------------------
const app = new Hono();

app.use("*", async (c, next) => {
	// blanket auth gate: every /api/* call from a non-loopback peer needs the token
	// (health is exempt — it only reports build/uptime, no secrets)
	if (c.req.path.startsWith("/api/") && c.req.path !== "/api/health" && !authorized(c.env?.incoming)) {
		return c.json({ error: "unauthorized — set x-pi-web-token (see data/auth-token.txt)" }, 401);
	}
	// browser-origin gate for privileged routes (DNS-rebinding defense — see
	// browserOriginAllowed above): Host and Origin must be allowlisted even for
	// loopback peers. Runs AFTER the token gate: a valid non-loopback token holder
	// still needs a real Host.
	if (
		c.req.path.startsWith("/api/") &&
		c.req.path !== "/api/health" &&
		!browserOriginAllowed(c.env?.incoming)
	) {
		return c.json({ error: "forbidden — Host/Origin not allowlisted for /api/* routes (custom names: PI_WEB_TERM_ORIGIN)" }, 403);
	}
	const start = Date.now();
	await next();
	if (c.req.path.startsWith("/api/")) {
		const line = `${c.req.method} ${c.req.path} -> ${c.res.status} (${Date.now() - start}ms)`;
		if (c.res.status >= 400) console.error("[pi-web]", line);
		else dlog(line);
	}
});

app.get("/api/health", (c) => c.json({ ok: true, bootId: BOOT_ID, buildId: BUILD_ID, piDir: PI_DIR }));
app.get("/api/version", (c) => c.json({ buildId: BUILD_ID, bootId: BOOT_ID }));
app.get("/api/pi/config", (c) => { refreshModelsStore(); agentHub.defaultModelId = piDefaultModelId(); return c.json(piConfig()); });
// pi system-prompt files — mirror pi-coding-agent resource-loader resolution exactly:
// trusted-project .pi/SYSTEM.md wins over agentDir SYSTEM.md (per-name, NOT combined);
// SYSTEM.md REPLACES pi's default prompt, APPEND_SYSTEM.md appends to it.
// Trust gate mirrors @agegr/pi-web: a project needs trust only if its .pi holds
// config resources; trust.json read failure = fail-closed (untrusted).
const TRUST_REQUIRED_FILES = ["settings.json", "mcp.json", "extensions", "skills", "prompts", "themes", "SYSTEM.md", "APPEND_SYSTEM.md"];
function projectNeedsTrust(projectDir) {
	try {
		const dotPi = path.join(projectDir, ".pi");
		if (fs.lstatSync(dotPi).isSymbolicLink()) return true;
		return TRUST_REQUIRED_FILES.some((n) => { try { fs.lstatSync(path.join(dotPi, n)); return true; } catch { return false; } });
	} catch { return false; }
}
function isProjectTrusted(projectDir, agentDir) {
	// pi's ProjectTrustStore.getEntry uses findNearestTrustEntry: walk UP from the
	// project dir to the nearest trust.json entry (ancestors count). Mirror that.
	try {
		const trust = JSON.parse(fs.readFileSync(path.join(agentDir, "trust.json"), "utf8"));
		let dir = path.resolve(projectDir);
		for (;;) {
			const v = trust[dir];
			if (v === true || v === false) return v;
			const parent = path.dirname(dir);
			if (parent === dir) return false; // reached root with no entry → untrusted (fail-closed)
			dir = parent;
		}
	} catch { return false; } // unreadable trust.json → fail-closed, like pi-web
}
// Effective system prompt for the SERVER-SIDE agent (same precedence the client
// sees from /api/pi/system): WEB_SYSTEM.md > trusted project SYSTEM.md > global
// SYSTEM.md; APPEND_SYSTEM.md appends. undefined → pi's built-in chat default.
// Runtime-safe: AGENT_DIR/WORKSPACE_DIR are initialized before any call.
function effectiveSystemPrompt() {
	const needsTrust = projectNeedsTrust(WORKSPACE_DIR);
	const trusted = !needsTrust || isProjectTrusted(WORKSPACE_DIR, AGENT_DIR);
	const read = (p) => { try { const st = fs.statSync(p); return st.isFile() && st.size <= 1024 * 1024 ? fs.readFileSync(p, "utf8") : undefined; } catch { return undefined; } };
	const base = read(path.join(AGENT_DIR, "WEB_SYSTEM.md"))
		|| (trusted ? read(path.join(WORKSPACE_DIR, ".pi", "SYSTEM.md")) : undefined)
		|| read(path.join(AGENT_DIR, "SYSTEM.md"));
	const append = (trusted ? read(path.join(WORKSPACE_DIR, ".pi", "APPEND_SYSTEM.md")) : undefined)
		|| read(path.join(AGENT_DIR, "APPEND_SYSTEM.md"));
	if (!base && !append) return undefined;
	return [base, append].filter(Boolean).join("\n\n");
}
function systemFileMeta(p, scope, name) {
	try {
		const st = fs.statSync(p);
		return { name, scope, path: p, exists: true, size: st.size, mtimeMs: Math.round(st.mtimeMs), content: st.size <= 1024 * 1024 ? fs.readFileSync(p, "utf8") : undefined };
	} catch { return { name, scope, path: p, exists: false }; }
}
app.get("/api/pi/system", (c) => {
	const agentDir = path.resolve(PI_DIR);
	// "same ws as local pi": the workspace pi runs in — PI_WS env, else the dir
	// containing the agent dir (C:/pi-windows-x64/.pi → C:/pi-windows-x64)
	const projectDir = path.resolve(process.env.PI_WS || path.resolve(PI_DIR, ".."));
	const needsTrust = projectNeedsTrust(projectDir);
	const trusted = !needsTrust || isProjectTrusted(projectDir, agentDir);
	const files = [
		systemFileMeta(path.join(agentDir, "WEB_SYSTEM.md"), "web", "WEB_SYSTEM.md"),
		systemFileMeta(path.join(projectDir, ".pi", "SYSTEM.md"), "project", "SYSTEM.md"),
		systemFileMeta(path.join(agentDir, "SYSTEM.md"), "global", "SYSTEM.md"),
		systemFileMeta(path.join(projectDir, ".pi", "APPEND_SYSTEM.md"), "project", "APPEND_SYSTEM.md"),
		systemFileMeta(path.join(agentDir, "APPEND_SYSTEM.md"), "global", "APPEND_SYSTEM.md"),
	];
	const pick = (name) => files.find((f) => f.name === name && f.scope === "project" && f.exists && trusted) || files.find((f) => f.name === name && f.scope === "global" && f.exists) || null;
	// base precedence: WEB_SYSTEM.md (web-UI-only filename — the TUI never reads
	// it, so it can't leak; research-confirmed exact-filename discovery) >
	// SYSTEM.md (project trusted > global) > pi default. No trust gate on the
	// web file: it is the web UI's own config, not a repo-supplied resource.
	const webBase = files.find((f) => f.name === "WEB_SYSTEM.md" && f.exists) || null;
	const base = webBase || pick("SYSTEM.md");
	const append = pick("APPEND_SYSTEM.md");
	// server computes precedence so the client can't drift from pick() (sonnet review)
	for (const f of files) f.wins = f === base || f === append;
	// NOTE: projectDir = PI_WS env || parent of agentDir — assumes .pi is a direct
	// child of the workspace root. Git worktrees with a non-standard .pi location
	// would need PI_WS set explicitly (same caveat @agegr's UI handles via its
	// roots-from-pi-sessions discovery).
	// 1MB content cap (vs 256KB in generic file browsers): these are 4 fixed,
	// typically-tiny config files, not arbitrary user files.
	return c.json({
		agentDir, projectDir, needsTrust, trusted,
		effective: { base: base ? base.path : "pi default", append: append ? append.path : null },
		files,
	}, 200, { "Cache-Control": "no-cache" });
});
// --- pi extension + workspace tool bridge -------------------------------------
// Loads the user's pi extensions (.pi/extensions/*.ts) server-side with a tiny
// shim for @earendil-works/pi-coding-agent (defineTool identity — extensions only
// need registerTool; type-only imports are erased by node's TS stripping), and
// exposes their tools + built-in workspace tools to the web agent via an exec
// bridge. Built-in fs tools are path-contained to allowedRoots (realpath both
// sides); extension code is trusted by definition (same as the pi TUI loading it).
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { diffLines } from "diff";

const WORKSPACE_DIR = path.resolve(process.env.PI_WS || path.resolve(PI_DIR, ".."));
const AGENT_DIR = path.resolve(PI_DIR);
const EXT_STAGE = path.join(DATA_DIR, "ext-loader");

function allowedRootsReal() {
	const roots = new Set();
	for (const r of [WORKSPACE_DIR, AGENT_DIR]) {
		try { roots.add(fs.realpathSync(r)); } catch { roots.add(path.resolve(r)); }
	}
	return roots;
}
// GLM/agent path-arg normalization: strip wrapping quotes/backticks, expand ~,
// collapse over-escaped backslashes, convert Git Bash /c/... → C:/...
function normalizePathArg(p) {
	let s = String(p ?? "").trim();
	s = s.replace(/^["'`“”‘’]+/, "").replace(/["'`“”‘’]+$/, "").trim();
	if (s === "~" || s.startsWith("~/")) s = path.join(os.homedir(), s.slice(1));
	const gm = s.match(/^\/(?:c|d|e)\/(.*)$/i); // Git Bash /c/...
	if (gm) s = `${gm[0][1].toUpperCase()}:/${gm[1]}`;
	s = s.replace(/\\{2,}/g, "\\"); // collapse over-escaped backslashes
	return s;
}
// GLM pastes read_file output WITH line-number prefixes — strip as a match variant
const LINE_NUM_PREFIX = /^\s*\d+\s*[|:]\s?/;
function stripLineNumberPrefixes(s) {
	const lines = s.split("\n");
	if (!lines.every((l) => l === "" || LINE_NUM_PREFIX.test(l))) return s;
	return lines.map((l) => l.replace(LINE_NUM_PREFIX, "")).join("\n");
}
const ZW_CHARS = /[\u200B-\u200F\uFEFF\u2060\u00AD]/g;

function assertInsideRoots(p, { mustExist = false } = {}) {
	const pathArg = normalizePathArg(p);
	// relative paths anchor to the workspace (not server cwd)
	const resolved = path.isAbsolute(pathArg) ? path.resolve(pathArg) : path.resolve(WORKSPACE_DIR, pathArg);
	let probe = resolved;
	// walk up to the nearest existing ancestor, realpath it (defeats symlink/.. escapes)
	while (true) {
		let rp;
		try { rp = fs.realpathSync(probe); } catch { /* not found — go up */ }
		if (rp) {
			if (![...allowedRootsReal()].some((root) => rp === root || rp.startsWith(root + path.sep))) throw new Error("path outside workspace: " + p);
			break;
		}
		const parent = path.dirname(probe);
		if (parent === probe) throw new Error("path outside workspace: " + p);
		probe = parent;
	}
	if (mustExist && !fs.existsSync(resolved)) throw new Error("not found: " + p);
	return resolved;
}

// bash: mirrors pi-coding-agent's bash tool (see tool comment below)
const PI_BIN_DIR = path.join(PI_DIR, "bin");
function getShellEnv() {
	// PATH prepend: PI bin dir (fd/rg) + the bash dir (msys DLL resolution —
	// without usr\bin on PATH, bin\bash.exe runs silently from a bare environment)
	// + the RUNNING node's dir (user report: `node` must work inside bash even
	// when the server itself was launched from a shell without node on PATH)
	const key = Object.keys(process.env).find((k) => k.toLowerCase() === "path") ?? "PATH";
	const cur = process.env[key] ?? "";
	const entries = cur.split(path.delimiter).filter(Boolean);
	const add = [PI_BIN_DIR, path.dirname(BASH_PATH), path.dirname(process.execPath)].filter((d) => !entries.includes(d));
	return { ...process.env, [key]: [...add, cur].filter(Boolean).join(path.delimiter) };
}
const sanitizeOutput = (s) => s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFF9-\uFFFB]/g, "");
function killProcessTree(pid) {
	// System32 taskkill (PATH-independent), /F /T = tree; detached + consumed error
	try {
		const tk = spawn(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", detached: true, windowsHide: true });
		tk.once("error", () => {});
	} catch { /* ignore */ }
}
function waitForChildProcess(child, onSettled) {
	// port of pi's waitForChildProcess: resolve on exit only after stdout/stderr pipes
	// end or fall idle (100ms grace, re-armed per chunk) — a short-lived child can exit
	// while a detached descendant keeps the pipe open (hang) or still writes (lost tail).
	// Single finalize guard shared by exit/idle/error paths (no double-resolve).
	// onSettled fires exactly once when finalization starts (timeout-race visibility).
	return new Promise((resolve) => {
		const GRACE = 100;
		let settled = false, exited = false, code = null, errMessage = null, idleTimer;
		let soEnd = !child.stdout, seEnd = !child.stderr;
		const fin = (err) => { if (settled) return; settled = true; clearTimeout(idleTimer); try { onSettled?.(); } catch {} try { child.stdout?.destroy(); child.stderr?.destroy(); } catch {} resolve({ code, err: err ?? errMessage }); };
		const maybe = () => { if (exited && soEnd && seEnd) fin(); };
		const arm = () => { if (settled) return; clearTimeout(idleTimer); idleTimer = setTimeout(() => fin(), GRACE); };
		child.stdout?.once("end", () => { soEnd = true; maybe(); });
		child.stderr?.once("end", () => { seEnd = true; maybe(); });
		child.stdout?.on("data", () => { if (exited && !settled) arm(); });
		child.stderr?.on("data", () => { if (exited && !settled) arm(); });
		child.once("error", (err) => { errMessage = String(err?.message || err); fin(errMessage); });
		child.once("exit", (c) => { exited = true; code = c; maybe(); if (!settled) arm(); });
		child.once("close", (c) => { code = code ?? c; fin(); });
	});
}
function truncateTail(text, maxLines, maxBytes) {
	// pi truncate.js: keep the LAST maxLines lines within maxBytes; spill full output
	// to a temp file when truncated and return a note with its path
	const lines = text.split("\n");
	if (lines.length <= maxLines && Buffer.byteLength(text) <= maxBytes) return { text, truncated: false };
	let out = lines.slice(-maxLines).join("\n");
	if (Buffer.byteLength(out) > maxBytes) out = out.slice(-maxBytes);
	let fullPath;
	try {
		fullPath = path.join(os.tmpdir(), `pi-web-bash-${Date.now()}.log`);
		fs.writeFileSync(fullPath, text, "utf8");
	} catch { /* temp spill best-effort */ }
	const shown = out.split("\n").length;
	return { text: out, truncated: true, note: `[Showing last ${shown} of ${lines.length} lines. Full output: ${fullPath ?? "(spill failed)"}]` };
}

// edit tool: port of pi-coding-agent's edit-diff.js + file-mutation-queue.js
function detectLineEnding(content) {
	const crlfIdx = content.indexOf("\r\n"), lfIdx = content.indexOf("\n");
	if (lfIdx === -1 || crlfIdx === -1) return "\n";
	return crlfIdx < lfIdx ? "\r\n" : "\n";
}
const normalizeToLF = (text) => text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
const restoreLineEndings = (text, ending) => (ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text);
function normalizeForFuzzyMatch(text) {
	return text.normalize("NFKC").split("\n").map((l) => l.trimEnd()).join("\n")
		.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
		.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
		.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
		.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}
function splitLinesWithEndings(content) { return content.match(/[^\n]*\n|[^\n]+/g) ?? []; }
function getLineSpans(content) {
	let offset = 0;
	return splitLinesWithEndings(content).map((line) => { const span = { start: offset, end: offset + line.length }; offset = span.end; return span; });
}
function fuzzyFindText(content, oldText) {
	const exactIndex = content.indexOf(oldText);
	if (exactIndex !== -1) return { found: true, index: exactIndex, matchLength: oldText.length, usedFuzzyMatch: false };
	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);
	if (fuzzyIndex === -1) return { found: false, index: -1, matchLength: 0, usedFuzzyMatch: false };
	return { found: true, index: fuzzyIndex, matchLength: fuzzyOldText.length, usedFuzzyMatch: true };
}
function countOccurrences(content, oldText) {
	const fc = normalizeForFuzzyMatch(content), fo = normalizeForFuzzyMatch(oldText);
	return fc.split(fo).length - 1;
}
function applyReplacements(content, replacements, offset = 0) {
	let result = content;
	for (let i = replacements.length - 1; i >= 0; i--) {
		const r = replacements[i], mi = r.matchIndex - offset;
		result = result.substring(0, mi) + r.newText + result.substring(mi + r.matchLength);
	}
	return result;
}
function getReplacementLineRange(lines, replacement) {
	const rs = replacement.matchIndex, re = replacement.matchIndex + replacement.matchLength;
	let startLine = -1;
	for (let i = 0; i < lines.length; i++) { if (rs >= lines[i].start && rs < lines[i].end) { startLine = i; break; } }
	if (startLine === -1) throw new Error("Replacement range is outside the base content.");
	let endLine = startLine;
	while (endLine < lines.length && lines[endLine].end < re) endLine++;
	if (endLine >= lines.length) throw new Error("Replacement range is outside the base content.");
	return { startLine, endLine: endLine + 1 };
}
function applyReplacementsPreservingUnchangedLines(originalContent, baseContent, replacements) {
	const originalLines = splitLinesWithEndings(originalContent);
	const baseLines = getLineSpans(baseContent);
	if (originalLines.length !== baseLines.length) throw new Error("Cannot preserve unchanged lines because the base content has a different line count.");
	const groups = [];
	for (const replacement of [...replacements].sort((a, b) => a.matchIndex - b.matchIndex)) {
		const range = getReplacementLineRange(baseLines, replacement);
		const current = groups[groups.length - 1];
		if (current && range.startLine < current.endLine) { current.endLine = Math.max(current.endLine, range.endLine); current.replacements.push(replacement); continue; }
		groups.push({ ...range, replacements: [replacement] });
	}
	let originalLineIndex = 0, result = "";
	for (const group of groups) {
		result += originalLines.slice(originalLineIndex, group.startLine).join("");
		const gs = baseLines[group.startLine].start, ge = baseLines[group.endLine - 1].end;
		result += applyReplacements(baseContent.slice(gs, ge), group.replacements, gs);
		originalLineIndex = group.endLine;
	}
	return result + originalLines.slice(originalLineIndex).join("");
}
function applyEditsToNormalizedContent(normalizedContent, edits, path) {
	const normalizedEdits = edits.map((e) => ({ oldText: normalizeToLF(String(e.oldText ?? "")), newText: normalizeToLF(String(e.newText ?? "")) }));
	for (let i = 0; i < normalizedEdits.length; i++) {
		if (normalizedEdits[i].oldText.length === 0) throw new Error(`edits[${i}].oldText must not be empty in ${path}.`);
	}
	const initialMatches = normalizedEdits.map((e) => fuzzyFindText(normalizedContent, e.oldText));
	const usedFuzzyMatch = initialMatches.some((m) => m.usedFuzzyMatch);
	const base = usedFuzzyMatch ? normalizeForFuzzyMatch(normalizedContent) : normalizedContent;
	const matched = [];
	for (let i = 0; i < normalizedEdits.length; i++) {
		const m = fuzzyFindText(base, normalizedEdits[i].oldText);
		if (!m.found) throw new Error(`Could not find edits[${i}] in ${path}. The oldText must match exactly including all whitespace and newlines.`);
		const occ = countOccurrences(base, normalizedEdits[i].oldText);
		if (occ > 1) throw new Error(`Found ${occ} occurrences of edits[${i}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`);
		matched.push({ editIndex: i, matchIndex: m.index, matchLength: m.matchLength, newText: normalizedEdits[i].newText });
	}
	matched.sort((a, b) => a.matchIndex - b.matchIndex);
	for (let i = 1; i < matched.length; i++) {
		const prev = matched[i - 1], cur = matched[i];
		if (prev.matchIndex + prev.matchLength > cur.matchIndex) throw new Error(`edits[${prev.editIndex}] and edits[${cur.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`);
	}
	const newContent = usedFuzzyMatch
		? applyReplacementsPreservingUnchangedLines(normalizedContent, base, matched)
		: applyReplacements(base, matched);
	if (normalizedContent === newContent) throw new Error(`No changes made to ${path}. The replacements produced identical content.`);
	return { baseContent: normalizedContent, newContent };
}
const fileMutationQueues = new Map();
let mutationRegistration = Promise.resolve();
async function withFileMutationQueue(filePath, fn) {
	// serialize mutations per file (realpath key — symlink aliases queue together);
	// different files still run in parallel (pi file-mutation-queue.js)
	const registration = mutationRegistration.then(async () => {
		let key = path.resolve(filePath);
		try { key = fs.realpathSync(key); } catch { /* missing → resolved path */ }
		const current = fileMutationQueues.get(key) ?? Promise.resolve();
		let releaseNext;
		const nextQueue = new Promise((r) => (releaseNext = r));
		fileMutationQueues.set(key, current.then(() => nextQueue));
		return { current, releaseNext };
	});
	mutationRegistration = registration.then(() => undefined, () => undefined);
	const { current, releaseNext } = await registration;
	await current;
	try { return await fn(); } finally { releaseNext(); }
}
function generateDiffString(oldContent, newContent, contextLines = 4) {
	const parts = diffLines(oldContent, newContent);
	const output = [];
	const oldLines = oldContent.split("\n"), newLines = newContent.split("\n");
	const w = String(Math.max(oldLines.length, newLines.length)).length;
	let oldNum = 1, newNum = 1, lastWasChange = false, firstChangedLine;
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		const raw = part.value.split("\n");
		if (raw[raw.length - 1] === "") raw.pop();
		if (part.added || part.removed) {
			if (firstChangedLine === undefined) firstChangedLine = newNum;
			for (const line of raw) {
				if (part.added) { output.push(`+${String(newNum).padStart(w, " ")} ${line}`); newNum++; }
				else { output.push(`-${String(oldNum).padStart(w, " ")} ${line}`); oldNum++; }
			}
			lastWasChange = true;
		} else {
			const nextIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);
			const hasLeading = lastWasChange, hasTrailing = nextIsChange;
			if (hasLeading && hasTrailing) {
				if (raw.length <= contextLines * 2) { for (const line of raw) { output.push(` ${String(oldNum).padStart(w, " ")} ${line}`); oldNum++; newNum++; } }
				else {
					for (const line of raw.slice(0, contextLines)) { output.push(` ${String(oldNum).padStart(w, " ")} ${line}`); oldNum++; newNum++; }
					output.push(` ${"".padStart(w, " ")} ...`); oldNum += raw.length - contextLines * 2; newNum += raw.length - contextLines * 2;
					for (const line of raw.slice(raw.length - contextLines)) { output.push(` ${String(oldNum).padStart(w, " ")} ${line}`); oldNum++; newNum++; }
				}
			} else if (hasLeading) {
				const shown = raw.slice(0, contextLines);
				for (const line of shown) { output.push(` ${String(oldNum).padStart(w, " ")} ${line}`); oldNum++; newNum++; }
				if (raw.length > shown.length) { output.push(` ${"".padStart(w, " ")} ...`); oldNum += raw.length - shown.length; newNum += raw.length - shown.length; }
			} else if (hasTrailing) {
				const skipped = Math.max(0, raw.length - contextLines);
				if (skipped > 0) { output.push(` ${"".padStart(w, " ")} ...`); oldNum += skipped; newNum += skipped; }
				for (const line of raw.slice(skipped)) { output.push(` ${String(oldNum).padStart(w, " ")} ${line}`); oldNum++; newNum++; }
			} else { oldNum += raw.length; newNum += raw.length; }
			lastWasChange = false;
		}
	}
	return { diff: output.join("\n"), firstChangedLine };
}
function generateUnifiedPatch(pathArg, oldContent, newContent, contextLines = 4) {
	// minimal unified patch from jsdiff line parts (pi uses Diff.createTwoFilesPatch)
	const parts = diffLines(oldContent, newContent);
	const oldLines = oldContent.split("\n"), newLines = newContent.split("\n");
	let out = [`--- ${pathArg}`, `+++ ${pathArg}`];
	let on = 1, nn = 1;
	const hunk = [];
	const flush = (ctxBefore, ctxAfter) => {
		if (!hunk.length) return;
		out.push(`@@ -${on - ctxBefore},${ctxBefore + hunk.filter((l) => !l.startsWith("+")).length} +${nn - ctxAfter},${ctxAfter + hunk.filter((l) => !l.startsWith("-")).length} @@`);
		out.push(...hunk);
		hunk.length = 0;
	};
	// simple whole-file hunk (context-limited hunking is cosmetic for details.diff)
	for (const part of parts) {
		const raw = part.value.split("\n");
		if (raw[raw.length - 1] === "") raw.pop();
		for (const line of raw) {
			if (part.added) { hunk.push("+" + line); nn++; }
			else if (part.removed) { hunk.push("-" + line); on++; }
			else { hunk.push(" " + line); on++; nn++; }
		}
	}
	flush(0, 0);
	return out.join("\n") + (contextLines ? "" : "");
}

// bash: verified working at C:\Git\usr\bin\bash.exe (portable Git at C:\Git —
// NOT Program Files; bin\bash.exe silently fails to load msys DLLs from a bare
// environment). Override with PI_WEB_BASH_SHELL if Git ever moves.
const BASH_PATH = process.env.PI_WEB_BASH_SHELL || "C:\\Git\\usr\\bin\\bash.exe";
const BASH_ENABLED = process.env.PI_WEB_BASH !== "0" && fs.existsSync(BASH_PATH); // on by default; PI_WEB_BASH=0 to disable
const builtinTools = [
	{
		name: "read_file", label: "Read file", source: "builtin",
		description: "Read a text file from the local pi workspace. Path must be inside the workspace.",
		parameters: { type: "object", properties: { path: { type: "string", description: "file path (absolute or workspace-relative)" }, offset: { type: "number", description: "1-based line offset (optional)" }, limit: { type: "number", description: "max lines (optional, default 400)" } }, required: ["path"] },
		async execute(_id, params) {
			const p = assertInsideRoots(params.path, { mustExist: true });
			const st = fs.statSync(p);
			if (st.size > 2 * 1024 * 1024) throw new Error("file too large (>2MB): " + p);
			const lines = fs.readFileSync(p, "utf8").split("\n");
			const off = Math.max(0, Number(params.offset || 1) - 1);
			const lim = Math.max(1, Math.min(2000, Number(params.limit || 400)));
			const slice = lines.slice(off, off + lim).map((l, i) => `${off + i + 1}| ${l}`).join("\n");
			return { content: [{ type: "text", text: `${p} (${lines.length} lines)\n${slice}${off + lim < lines.length ? "\n... (more lines; use offset)" : ""}` }] };
		},
	},
	{
		name: "write_file", label: "Write file", source: "builtin",
		description: "Create or overwrite a text file in the local pi workspace. Parent dirs are created automatically (createDirs defaults to true). For existing files prefer the edit tool.",
		parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" }, createDirs: { type: "boolean", description: "create missing parent directories (default true)" } }, required: ["path", "content"] },
		async execute(_id, params, signal) {
			const p = assertInsideRoots(params.path);
			const content = String(params.content ?? "");
			if (Buffer.byteLength(content) > 2 * 1024 * 1024) throw new Error("content too large (>2MB)");
			return await withFileMutationQueue(p, async () => {
				if (params.createDirs === true && !fs.existsSync(path.dirname(p))) fs.mkdirSync(path.dirname(p), { recursive: true });
				try {
					fs.writeFileSync(p, content, "utf8");
				} catch (err) {
					if (String(err?.message || err).includes("ENOENT")) throw new Error(`Parent directory missing: ${path.dirname(p)}. Retry with createDirs:true.`);
					throw err;
				}
				return { content: [{ type: "text", text: `wrote ${Buffer.byteLength(content)} bytes to ${p} (prefer edit for existing files)` }] };
			});
		},
	},
	{
		name: "edit", label: "edit", source: "builtin",
		// Port of pi-coding-agent dist/core/tools/edit.js + edit-diff.js + file-mutation-queue.js:
		// multi-edit per call (each edit matched against the ORIGINAL file, non-overlapping),
		// uniqueness validation, fuzzy-match fallback (trailing-ws/quotes/dashes normalization
		// with unchanged-line preservation), BOM strip/restore, CRLF preserve, no-op rejection,
		// per-file mutation queue, diff details via jsdiff.
		description: "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. Copy oldText VERBATIM from read_file output (never include line-number prefixes); include 3+ unique surrounding lines; keep the file's indentation. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
		parameters: { type: "object", properties: { path: { type: "string", description: "Path to the file to edit (relative or absolute)" }, edits: { type: "array", description: "One or more targeted replacements. Each edit is matched against the original file, not incrementally.", items: { type: "object", properties: { oldText: { type: "string", description: "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call." }, newText: { type: "string", description: "Replacement text for this targeted edit." } }, required: ["oldText", "newText"] } } }, required: ["path", "edits"] },
		async execute(_id, params, signal) {
			// prepareEditArguments — hardened 2026-10-21 (the maintainer's own live
			// failures while using this very tool): recover the malformed shapes
			// models/agents actually send. Every recovery is reported in the result.
			const repairNotes = [];
			const args = { path: params.path, edits: params.edits };
			// path aliases at the TOP level ("path: must have required properties path")
			if (args.path === undefined || args.path === null || String(args.path).trim() === "") {
				for (const k of ["file", "file_path", "filePath"]) {
					if (typeof params[k] === "string" && params[k].trim()) { args.path = params[k]; repairNotes.push(`path was missing — recovered from params.${k}`); break; }
				}
			}
			// path sent as an object {path: "..."} — unwrap
			if (args.path && typeof args.path === "object" && typeof args.path.path === "string") {
				args.path = args.path.path;
				repairNotes.push("path was an object — unwrapped .path");
			}
			// edits: unwrap JSON strings repeatedly (single- AND double-encoded)
			let unwrapGuard = 0;
			while (typeof args.edits === "string" && unwrapGuard++ < 4) {
				let parsed;
				try { parsed = JSON.parse(args.edits); } catch { break; }
				if (typeof parsed === "string") { args.edits = parsed; continue; } // deeper encoding — unwrap again
				if (Array.isArray(parsed)) { args.edits = parsed; repairNotes.push("edits was a JSON string — parsed"); continue; }
				if (parsed && typeof parsed === "object") {
					if (Array.isArray(parsed.edits)) {
						if ((args.path === undefined || args.path === null || String(args.path).trim() === "") && typeof parsed.path === "string") { args.path = parsed.path; repairNotes.push("path was missing — recovered from the edits-string wrapper"); }
						args.edits = parsed.edits;
						repairNotes.push("edits was a double-encoded JSON string — unwrapped {edits}");
						continue;
					}
					if (parsed.oldText !== undefined || parsed.old_string !== undefined) { args.edits = [parsed]; repairNotes.push("edits was a JSON string — parsed to a single object"); continue; }
				}
				break; // parsed to a scalar — handled by the entries step below
			}
			// edits: single object → one-element array
			if (args.edits && typeof args.edits === "object" && !Array.isArray(args.edits) && (args.edits.oldText !== undefined || args.edits.old_string !== undefined)) {
				args.edits = [args.edits];
			}
			if (params.oldText !== undefined && params.newText !== undefined) {
				args.edits = [...(Array.isArray(args.edits) ? args.edits : []), { oldText: params.oldText, newText: params.newText }];
			}
			if (!Array.isArray(args.edits) || args.edits.length === 0) {
				throw new Error('Edit tool input is invalid. Call as {"path": "<file>", "edits": [{"oldText": "exact existing text", "newText": "replacement"}]}. Accepted shapes for `edits`: array, single object, JSON string, or the legacy flat {oldText, newText} directly on params.');
			}
			// robustness (user report: edit calls failing with missing path): models
			// sometimes omit the top-level path and nest it inside edits[] — recover
			// from edits[].path, then strip stray keys so entries carry ONLY
			// oldText/newText. A still-missing path fails with the exact call shape.
			if (args.path === undefined || args.path === null || String(args.path).trim() === "") {
				const pathKeys = ["path", "file", "file_path", "filePath"];
				const nested = (Array.isArray(args.edits) ? args.edits : []).find((e) => e && typeof e === "object" && pathKeys.some((k) => typeof e[k] === "string" && e[k].trim()));
				if (nested) args.path = String(nested.path ?? nested.file ?? nested.file_path ?? nested.filePath);
			}
			if (args.path === undefined || args.path === null || String(args.path).trim() === "") {
				throw new Error('Edit tool: missing `path`. Call as {"path": "<file>", "edits": [{"oldText": "...", "newText": "..."}]} — path is a TOP-LEVEL string, never inside edits[].');
			}
			if (Array.isArray(args.edits)) {
				const recoveredPaths = new Set(args.edits.filter((e) => e && typeof e === "object").map((e) => String(e.path ?? e.file ?? e.file_path ?? e.filePath ?? "")).filter(Boolean));
				if (recoveredPaths.size > 1) {
					throw new Error(`Edit tool: edits[] entries carry ${recoveredPaths.size} DIFFERENT paths (${[...recoveredPaths].join(", ")}) — one edit call edits ONE file. Split into separate calls.`);
				}
				args.edits = args.edits.map((e, i) => {
					if (typeof e === "string") {
						// edits[i] as a JSON string ("edits.0: must be object") or a bare old-text string
						let handled = false;
						try {
							const parsed = JSON.parse(e);
							if (parsed && typeof parsed === "object" && (parsed.oldText !== undefined || parsed.newText !== undefined || parsed.old_string !== undefined)) {
								repairNotes.push(`edits[${i}] was a JSON string — parsed to an object`);
								e = parsed;
								handled = true;
							}
						} catch { /* not JSON */ }
						if (!handled) {
							if (e.length > 0) repairNotes.push(`edits[${i}] was a bare string — treated as oldText with an empty replacement (deletion)`);
							e = { oldText: e, newText: "" };
						}
					} else if (typeof e === "number" || typeof e === "boolean") {
						repairNotes.push(`edits[${i}] was a ${typeof e} — treated as oldText with an empty replacement (deletion)`);
						e = { oldText: String(e), newText: "" };
					}
					if (!e || typeof e !== "object") return e;
					// alias normalization (grok r1): other tools' schemas leak into calls
					const oldText = e.oldText ?? e.old_string ?? e.oldtext;
					const newText = e.newText ?? e.new_string ?? e.newtext;
					const { path: _p, file: _f, file_path: _fp, filePath: _fp2, old_string: _os, new_string: _ns, ...rest } = e;
					return { ...rest, oldText, newText };
				});
			}
			// early actionable validation (before the file is even read): empty/missing
			// oldText cannot be matched — say so with the fix instead of a bare length error
			for (let i = 0; i < args.edits.length; i++) {
				const e = args.edits[i];
				if (!e || typeof e !== "object") throw new Error(`Edit tool: edits[${i}] must be an object {oldText, newText} (got ${e === null ? "null" : typeof e}).`);
				if (typeof e.oldText !== "string" || e.oldText.length === 0) {
					throw new Error(`Edit tool: edits[${i}].oldText must be a non-empty verbatim excerpt of the file (got ${e.oldText === undefined ? "undefined" : JSON.stringify(e.oldText)}). An empty oldText cannot be matched — to prepend, include the first existing line in oldText and repeat it in newText; to create a file, use write_file.`);
				}
			}
			const repairPrefix = repairNotes.length ? "Repaired malformed call:\n" + repairNotes.map((n) => "- " + n).join("\n") + "\n\n" : "";
			const p = assertInsideRoots(args.path, { mustExist: true });
			const st = fs.statSync(p);
			if (st.size > 10 * 1024 * 1024) throw new Error("file too large (>10MB): " + p);
			return await withFileMutationQueue(p, async () => {
				const throwIfAborted = () => { if (signal?.aborted) throw new Error("Operation aborted"); };
				throwIfAborted();
				const rawContent = fs.readFileSync(p, "utf8");
				throwIfAborted();
				// strip BOM before matching — the model never includes an invisible BOM in oldText
				const bom = rawContent.startsWith("\uFEFF") ? "\uFEFF" : "";
				const content = rawContent.slice(bom.length);
				const originalEnding = detectLineEnding(content);
				const normalizedContent = normalizeToLF(content);
				// Candidate match forms: the model's args may be mis-escaped through the JSON
				// layers (Windows paths → \n corruption, double-escaped \\n) or carry read_file
				// line-number prefixes. Try as-is first, then each repair form (every form still
				// requires unique, non-overlapping matches).
				const collapseBackslashes = (x) => x.replace(/\\{2,}/g, "\\");
				const baseEdits = args.edits.map((e) => ({ oldText: String(e?.oldText ?? "").replace(ZW_CHARS, ""), newText: String(e?.newText ?? "").replace(ZW_CHARS, "") }));
				const forms = [{ oldText: baseEdits.map((e) => e.oldText), newText: baseEdits.map((e) => e.newText), label: "as-is" }];
				forms.push({ oldText: baseEdits.map((e) => stripLineNumberPrefixes(e.oldText)), newText: baseEdits.map((e) => stripLineNumberPrefixes(e.newText)), label: "line-numbers-stripped" });
				forms.push({ oldText: baseEdits.map((e) => collapseBackslashes(e.oldText)), newText: baseEdits.map((e) => collapseBackslashes(e.newText)), label: "backslashes-collapsed" });
				forms.push({ oldText: baseEdits.map((e) => collapseBackslashes(stripLineNumberPrefixes(e.oldText))), newText: baseEdits.map((e) => collapseBackslashes(stripLineNumberPrefixes(e.newText))), label: "line-num+collapse" });
				let applied = null;
				const attempts = [];
				for (const form of forms) {
					try {
						applied = applyEditsToNormalizedContent(normalizedContent, form.oldText.map((o, i) => ({ oldText: o, newText: form.newText[i] })), args.path);
						applied.form = form.label;
						break;
					} catch (err) { attempts.push(form.label + ": " + err.message); applied = null; }
				}
				// LINE-LEVEL fuzzy pass (grok design): after exact + pi-fuzzy fail — trim both
				// ends per line, sliding window, uniqueness in trimmed space (reject-and-list),
				// INDENT REBASE (file's indent wins, relative delta from model newText kept).
				// Gated: skipped for single short lines (brace/short-token collisions).
				if (!applied && args.edits.length >= 1) {
					try {
						const fileLinesAll = normalizedContent.split("\n");
						const norm = (x) => normalizeForFuzzyMatch(x).replace(ZW_CHARS, "").trim();
						const fileTrim = fileLinesAll.map(norm);
						const plan = [];
						for (let i = 0; i < args.edits.length; i++) {
							const oldLines = collapseBackslashes(stripLineNumberPrefixes(baseEdits[i].oldText)).split("\n").map(norm);
							if (oldLines.length < 2 && oldLines.join("").length < 20) throw new Error("too short for line-fuzzy");
							const hits = [];
							for (let st2 = 0; st2 + oldLines.length <= fileTrim.length; st2++) {
								let ok = true;
								for (let j = 0; j < oldLines.length; j++) if (fileTrim[st2 + j] !== oldLines[j]) { ok = false; break; }
								if (ok) hits.push(st2);
							}
							if (hits.length !== 1) throw new Error(hits.length === 0 ? "no trimmed-line match" : "ambiguous: matches at lines " + hits.map((h) => h + 1).join(", "));
							plan.push({ editIndex: i, lineIndex: hits[0], oldText: baseEdits[i].oldText, newText: baseEdits[i].newText });
						}
						plan.sort((a, b) => a.lineIndex - b.lineIndex);
						for (let i = 1; i < plan.length; i++) {
							const prevEnd = plan[i - 1].lineIndex + plan[i - 1].oldText.split("\n").length;
							if (prevEnd > plan[i].lineIndex) throw new Error("overlapping line-fuzzy matches — merge the edits");
						}
						// apply bottom-up with indent rebase (file's indent wins, relative delta kept)
						const outLines = [...fileLinesAll];
						const leadW = (l) => { const m = l.match(/^[ \t]*/); return m ? m[0].replace("\t", "    ").length : 0; };
						for (const step of [...plan].reverse()) {
							const oldN = step.oldText.split("\n").length;
							const newLines = step.newText.split("\n");
							const fileBase = (outLines[step.lineIndex].match(/^[ \t]*/) || [""])[0];
							const firstNonEmpty = newLines.find((l) => l.trim().length > 0) || "";
							const newBase = (firstNonEmpty.match(/^[ \t]*/) || [""])[0];
							const usesTabs = fileBase.includes("\t");
							const rebased = newLines.map((l) => {
								if (l.trim().length === 0) return ""; // empty lines stay empty (not padded)
								const rel = Math.max(0, leadW(l) - leadW(newBase));
								const pad = usesTabs ? "\t".repeat(Math.floor(rel / 4)) + " ".repeat(rel % 4) : " ".repeat(rel);
								return fileBase + pad + l.trim();
							});
							outLines.splice(step.lineIndex, oldN, ...rebased);
						}
						const newContent2 = outLines.join("\n");
						if (newContent2 === normalizedContent) throw new Error("line-fuzzy produced identical content");
						applied = { baseContent: normalizedContent, newContent: newContent2, form: "line-fuzzy" };
					} catch (err) { attempts.push("line-fuzzy: " + err.message); }
				}
				if (!applied) {
					// error with a copy-pasteable excerpt (read_file format) + whitespace viz
					const firstLine = (baseEdits[0]?.oldText || "").split("\n").map((l) => l.trim()).find((l) => l.length > 0) || "";
					const fileTrim2 = normalizedContent.split("\n").map((l) => normalizeForFuzzyMatch(l).replace(ZW_CHARS, "").trim());
					const anchor = firstLine.length > 3 ? fileTrim2.indexOf(firstLine) : -1;
					let excerpt = "";
					{
						const allLines = normalizedContent.split("\n");
						if (anchor === -1) {
							excerpt = allLines.slice(0, Math.min(12, allLines.length)).map((l, i) => (i + 1) + "| " + l).join("\n");
							if (allLines.length > 12) excerpt += "\n... (" + (allLines.length - 12) + " more lines)";
						} else {
							const s2 = Math.max(0, anchor - 2);
							excerpt = allLines.slice(s2, s2 + 12).map((l, i) => (s2 + i + 1) + "| " + l).join("\n");
						}
					}
					const viz = (baseEdits[0]?.oldText || "").split("\n")[0].replace(/ /g, "\u00b7").replace(/\t/g, "\u2192");
					throw new Error(repairPrefix + "Could not apply edit to " + args.path + ". Attempts:\n" + attempts.map((a) => "- " + a).join("\n") + "\n\nFirst oldText line (whitespace visualized): " + viz + (excerpt ? "\n\nFile excerpt near a possible anchor:\n" + excerpt + "\n" : "") + "\nCopy oldText VERBATIM from read_file output (no line-number prefixes), keep the file's indentation, and include 3+ unique surrounding lines.");
				}
				throwIfAborted();
				fs.writeFileSync(p, bom + restoreLineEndings(applied.newContent, originalEnding), "utf8");
				throwIfAborted();
				const diffResult = generateDiffString(applied.baseContent, applied.newContent);
				return { content: [{ type: "text", text: repairPrefix + "Successfully replaced " + args.edits.length + " block(s) in " + args.path + " (match: " + applied.form + ").\n" + diffResult.diff }], details: { diff: diffResult.diff, patch: generateUnifiedPatch(args.path, applied.baseContent, applied.newContent), firstChangedLine: diffResult.firstChangedLine, matchForm: applied.form } };
			});
		},
	},
	// NOTE: no `ls` builtin — bash covers directory listing (mirrors pi's default
	// tool set: read/bash/edit/write; grok r2: an unadvertised-but-registered tool
	// gets used WITHOUT steering, the worst quadrant)
	...(BASH_ENABLED ? [{
		name: "bash", label: "Bash", source: "builtin",
		description: "Execute a bash command in the workspace. Returns stdout and stderr. Output is truncated to the last 2000 lines or 50KB (whichever is hit first); if truncated, full output is saved to a temp file and its path is returned. fd/rg are on PATH. Optional timeout in seconds (default none, web cap 600s).",
		parameters: { type: "object", properties: { command: { type: "string", description: "bash command to execute" }, timeout: { type: "number", description: "timeout in seconds (optional)" } }, required: ["command"] },
		// Mirrors pi-coding-agent dist/core/tools/bash.js + utils (shell.js, child-process.js,
		// truncate.js, output-accumulator.js): Git Bash on Windows (ProgramFiles → where, skip
		// legacy WSL bash; cmd.exe fallback so the tool still exists without Git), PATH prepend
		// of PI bin dir (fd/rg), System32 taskkill process-tree kill, exit+pipe-idle wait so
		// detached descendants don't hang us or lose their tail output (pi#5303), tail-truncate
		// last 2000 lines / 50KB with full-output temp spill, control-char sanitization.
		async execute(_id, params, signal, onUpdate) {
			const cmd = String(params.command || "");
			const toMs = (s) => { const n = Number(s); if (!Number.isFinite(n) || n <= 0) throw new Error("Invalid timeout: must be a positive number of seconds"); return Math.min(n, 600) * 1000; }; // server-side clamp: web cap 600s regardless of client
			const timeoutMs = params.timeout !== undefined ? toMs(params.timeout) : undefined;
			// bash location is a verified constant (BASH_PATH) — no runtime discovery
			if (!fs.existsSync(BASH_PATH)) throw new Error("bash not found at " + BASH_PATH + " — set PI_WEB_BASH_SHELL");
			const child = spawn(BASH_PATH, ["-c", cmd], { cwd: WORKSPACE_DIR, env: getShellEnv(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
			// Two independent sinks for one data stream, neither lying about completeness:
			//  - spill file: RAW BYTES streamed unconditionally (full capture, no decode issue)
			//  - inline tail: StringDecoder ring (last 256KB decoded — decoder carries
			//    multi-byte sequences across chunk boundaries)
			const decoder = new StringDecoder("utf8");
			let tail = "", spillBytes = 0, finished = false;
			const TAIL_KEEP = 256 * 1024, SPILL_MAX = 256 * 1024 * 1024;
			const spillPath = path.join(os.tmpdir(), `pi-web-bash-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.log`);
			let spill = fs.createWriteStream(spillPath, { flags: "w" });
			spill.on("error", () => { spill = null; }); // spill best-effort, never fatal
			let lastPartial = 0;
			const pushPartial = (force) => {
				if (!onUpdate) return;
				const now = Date.now();
				if (!force && now - lastPartial < 250) return;
				lastPartial = now;
				const snap = truncateTail(sanitizeOutput(tail), 100, 16 * 1024); // partials: harder cap than the final result
				try { onUpdate({ content: [{ type: "text", text: snap.text || "(running...)" }], details: { partial: true } }); } catch { /* loop errors must not kill the tool */ }
			};
			const append = (buf) => {
				if (spill && spillBytes < SPILL_MAX) { try { spill.write(buf); spillBytes += buf.length; } catch {} }
				tail += decoder.write(buf);
				if (tail.length > TAIL_KEEP) tail = tail.slice(-TAIL_KEEP);
				pushPartial(false); // throttled 250ms; first byte flushes via force below
			};
			child.stdout?.on("data", append);
			child.stderr?.on("data", append);
			if (onUpdate) setTimeout(() => pushPartial(true), 0); // first-byte flush
			let timedOut = false;
			let timeoutHandle;
			const killTree = () => { if (child.pid) killProcessTree(child.pid); };
			const onAbort = () => killTree();
			if (signal?.aborted) onAbort(); else signal?.addEventListener("abort", onAbort, { once: true });
			if (timeoutMs !== undefined) timeoutHandle = setTimeout(() => { if (finished) return; timedOut = true; killTree(); }, timeoutMs);
			const { code: exitCode, err: spawnErr } = await waitForChildProcess(child, () => { finished = true; });
			pushPartial(true); // final partial flush before the result frame
			signal?.removeEventListener("abort", onAbort);
			clearTimeout(timeoutHandle);
			await new Promise((r) => (spill ? spill.end(() => r()) : r())); // flush spill before referencing/deleting
			const sanitized = sanitizeOutput(tail);
			const truncated = truncateTail(sanitized, 2000, 50 * 1024);
			if (!truncated.truncated && spill) { try { fs.unlinkSync(spillPath); } catch {} } // complete inline → no spill needed
			const spilledNote = truncated.truncated && spillPath ? `\n${truncated.note}` : truncated.truncated ? "\n[Full output spill unavailable]" : "";
			const aborted = signal?.aborted;
			if (timedOut || aborted) {
				// pi appends partial output to the timeout/abort error (appendStatus) and
				// surfaces thrown tool errors with isError: true — mirror both
				const text = `${truncated.text}${spilledNote}\n\n${timedOut ? `Command timed out after ${params.timeout} seconds` : "Command aborted"}`.trim();
				return { isError: true, content: [{ type: "text", text }] };
			}
			if (spawnErr) {
				return { isError: true, content: [{ type: "text", text: `bash failed to spawn: ${spawnErr}` }] };
			}
			const code = exitCode ?? 1;
			const text = `${truncated.text || "(no output)"}${spilledNote}`.replace(/^\n+/, "");
			return { content: [{ type: "text", text: `cwd: ${WORKSPACE_DIR}\n${text}\nexit ${code}` }], details: { exitCode: code } };
		},
	}] : []),
];

// extension loading: stage .pi/extensions into data/ext-loader (which carries a
// node_modules shim for @earendil-works/pi-coding-agent), then dynamic-import.
const extensionTools = [];
const extensionErrors = [];
const execAudit = []; // last 50 tool invocations (timestamp/tool/params) — see /api/debug/state
async function loadPiExtensions() {
	try { fs.rmSync(EXT_STAGE, { recursive: true, force: true }); } catch {}
	fs.mkdirSync(path.join(EXT_STAGE, "node_modules", "@earendil-works", "pi-coding-agent"), { recursive: true });
	fs.mkdirSync(path.join(EXT_STAGE, "extensions"), { recursive: true });
	fs.writeFileSync(path.join(EXT_STAGE, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", type: "module", main: "index.mjs" }));
	fs.writeFileSync(path.join(EXT_STAGE, "node_modules", "@earendil-works", "pi-coding-agent", "index.mjs"),
		"// shim: extensions only need defineTool at runtime (types are erased);\n" +
		"// everything else comes through the pi-object Proxy in the loader.\n" +
		"export const defineTool = (t) => t;\n" +
		"export const createAgentTool = (t) => t;\n");
	let staged = [];
	try { staged = fs.readdirSync(path.join(AGENT_DIR, "extensions")).filter((f) => f.endsWith(".ts") || f.endsWith(".js")); } catch { /* no extensions dir */ }
	for (const f of staged) {
		try { fs.copyFileSync(path.join(AGENT_DIR, "extensions", f), path.join(EXT_STAGE, "extensions", f)); } catch (err) { extensionErrors.push(`${f}: copy failed: ${err.message}`); }
	}
	for (const f of staged) {
		const toolsBefore = extensionTools.length;
		try {
			const mod = await import(pathToFileURL(path.join(EXT_STAGE, "extensions", f)).href);
			if (typeof mod.default !== "function") throw new Error("no default export function");
			const pi = new Proxy({ registerTool: (t) => extensionTools.push({ ...t, _from: f }), cwd: WORKSPACE_DIR, agentDir: AGENT_DIR }, {
				get: (o, k) => {
					if (k in o) return o[k];
					// loud, not silent: an extension calling unimplemented pi.* APIs must
					// not appear to work while skipping logic
					return (...a) => console.warn(`[ext] ${f}: pi.${String(k)}() not implemented in web loader — no-op`);
				},
			});
			await mod.default(pi);
			console.log(`[ext] ${f}: ${extensionTools.length - toolsBefore} tool(s)`);
		} catch (err) {
			extensionErrors.push(`${f}: ${err?.message || err}`);
			console.warn(`[ext] ${f} failed: ${err?.message || err}`);
		}
	}
}
function normalizeToolResult(r) {
	if (r && Array.isArray(r.content)) return r;
	if (typeof r === "string") return { content: [{ type: "text", text: r }] };
	return { content: [{ type: "text", text: JSON.stringify(r ?? null).slice(0, 100000) }] };
}

// --- workspace file picker (user request: select workspace files, NOT uploads) ---
// Same containment (assertInsideRoots) + same token blanket-gate as the exec bridge.
// Dotfiles are HIDDEN and dotfile path segments REJECTED (grok p7): .pi/ contains
// auth.json (provider API keys) — a human-facing browser must not expose them.
// Paths are returned WORKSPACE-RELATIVE ("/"-separated) — absolute paths leak the
// server layout and made the client breadcrumbs wrong (grok p6/p7).
const IMAGE_MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp" };
const WORKSPACE_REAL = fs.realpathSync(WORKSPACE_DIR);
// the system prompt files are browsable in the file viewer (user request:
// "we can see it by file viewer") — ONLY these, nothing else under .pi
const PROMPT_VIEW_FILES = new Set(["web_system.md", "system.md", "append_system.md"]);
const isPromptViewPath = (p, forListing = false) => {
	try {
		const rel = path.relative(WORKSPACE_REAL, fs.realpathSync(p)).toLowerCase();
		if (rel.startsWith("..")) return false;
		const segs = rel.split(path.sep);
		if (forListing && segs.length === 1 && segs[0] === ".pi") return true; // the dir itself is listable (entries filtered below)
		return segs.length === 2 && segs[0] === ".pi" && PROMPT_VIEW_FILES.has(segs[1]);
	} catch {
		return false;
	}
};
const hasDotSegment = (p) => {
	if (isPromptViewPath(p)) return false; // allowlisted system-prompt files
	if (isPromptViewPath(p, true)) return false; // the .pi dir (listing filters entries)
	const rel = path.relative(WORKSPACE_REAL, fs.realpathSync(p)); // realpath BOTH sides (grok p7)
	if (rel.startsWith("..")) return true; // outside workspace (shouldn't happen post-containment)
	return rel.split(path.sep).some((seg) => seg.startsWith("."));
};
const toRel = (p) => path.relative(WORKSPACE_DIR, p).split(path.sep).join("/");
const stripWs = (msg) => String(msg || "").split(WORKSPACE_DIR).join("~"); // don't leak absolute paths in errors

app.get("/api/ws/files", (c) => {
	try {
		const p = assertInsideRoots(c.req.query("path") || WORKSPACE_DIR, { mustExist: true });
		if (hasDotSegment(p)) return c.json({ error: "access denied: hidden paths are not browsable" }, 403);
		if (!fs.statSync(p).isDirectory()) return c.json({ error: "not a directory" }, 400);
		const inPiDir = path.basename(p).toLowerCase() === ".pi";
		const entries = fs.readdirSync(p, { withFileTypes: true })
			.filter((e) => !e.name.startsWith(".") || (inPiDir && PROMPT_VIEW_FILES.has(e.name.toLowerCase())))
			.map((e) => {
				let size = 0, mtime = 0;
				try { const s = fs.statSync(path.join(p, e.name)); size = s.size; mtime = s.mtimeMs; } catch { /* unreadable entry — still listable */ }
				return { name: e.name, dir: e.isDirectory(), size, mtime };
			})
			.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
		const rel = toRel(p);
		const parentRel = rel ? toRel(path.dirname(p)) : null;
		return c.json({ path: rel, parent: parentRel, workspace: "", entries });
	} catch (err) {
		return c.json({ error: stripWs(err?.message || err) }, 400);
	}
});

app.get("/api/ws/file", (c) => {
	// ALWAYS token-required — file CONTENT is a secrets oracle for anything not
	// dot-prefixed (credentials.csv, id_rsa, .env lookalikes); loopback CSRF /
	// DNS-rebinding is in the threat model, same as /api/exec/tool (grok p7).
	if (!tokenMatches(c.env?.incoming)) {
		return c.json({ error: "unauthorized — workspace file access needs x-pi-web-token (see data/auth-token.txt)" }, 401);
	}
	try {
		const p = assertInsideRoots(c.req.query("path"), { mustExist: true });
		if (hasDotSegment(p)) return c.json({ error: "access denied: hidden paths are not readable" }, 403);
		const st = fs.statSync(p);
		if (!st.isFile()) return c.json({ error: "not a file" }, 400);
		if (st.size > 8 * 1024 * 1024) return c.json({ error: "file too large (>8MB)" }, 400);
		const mime = IMAGE_MIME[path.extname(p).toLowerCase()];
		if (mime) {
			return c.json({ path: toRel(p), kind: "image", mimeType: mime, base64: fs.readFileSync(p).toString("base64"), size: st.size });
		}
		const buf = fs.readFileSync(p);
		if (buf.subarray(0, 8192).includes(0)) return c.json({ error: "binary file (not text, not image)" }, 400); // NUL sniff
		return c.json({ path: toRel(p), kind: "text", content: buf.toString("utf8"), size: st.size });
	} catch (err) {
		return c.json({ error: stripWs(err?.message || err) }, 400);
	}
});

app.get("/api/exec/tools", (c) => {
	if (TOKEN) { const t = c.req.header("x-pi-web-token"); if (t !== TOKEN) return c.json({ error: "unauthorized" }, 401); }
	const allow = (process.env.PI_WEB_TOOLS || "").split(",").map((s) => s.trim()).filter(Boolean); // optional per-tool allowlist
	const all = [...builtinTools, ...extensionTools].filter((t) => !allow.length || allow.includes(t.name)).map(({ execute, ...rest }) => ({ stream: rest.name === "bash",
		...rest,
		description: typeof rest.description === "function" ? rest.description() : rest.description,
	}));
	return c.json({ workspace: WORKSPACE_DIR, tools: all, errors: extensionErrors, trust: "extension tools run with full machine trust (same as the pi TUI loading them) — the API token is the trust boundary; narrow with PI_WEB_TOOLS" }, 200, { "Cache-Control": "no-cache" });
});
app.post("/api/exec/tool", async (c) => {
	// ALWAYS token-required — even loopback. A drive-by web page can send simple
	// cross-origin POSTs (no preflight for text/plain) and read nothing back, but
	// execution would still happen server-side; the token header is unforgable
	// cross-origin, which closes that hole. Tool defs (GET) stay loopback-friendly.
	if (!tokenMatches(c.env?.incoming)) {
		return c.json({ error: "unauthorized — tool execution needs x-pi-web-token (see data/auth-token.txt)" }, 401);
	}
	const body = await c.req.json().catch(() => ({}));
	const name = String(body?.tool || "");
	// param coercion (GLM shapes): JSON-string params, null, arrays → object
	let toolParams = body?.params;
	if (typeof toolParams === "string") { try { toolParams = JSON.parse(toolParams); } catch { toolParams = { value: toolParams }; } }
	if (!toolParams || typeof toolParams !== "object" || Array.isArray(toolParams)) toolParams = toolParams ? { value: toolParams } : {};
	const allow = (process.env.PI_WEB_TOOLS || "").split(",").map((s) => s.trim()).filter(Boolean);
	const tool = [...builtinTools, ...extensionTools].find((t) => t.name === name);
	if (!tool || (allow.length && !allow.includes(name))) return c.json({ content: [{ type: "text", text: `unknown or disallowed tool: ${name}` }] }, 404);
	// audit trail for the highest-trust surface in the stack (sonnet review):
	// timestamp, tool, trimmed params — outcome amended after execution; surfaced
	// via /api/debug/state
	const t0 = Date.now();
	const auditEntry = { at: new Date().toISOString(), tool: name, params: JSON.stringify(toolParams).slice(0, 300), outcome: null };
	execAudit.push(auditEntry);
	if (execAudit.length > 50) execAudit.shift();
	const finishAudit = (outcome) => { auditEntry.outcome = { isError: !!outcome?.isError, exitCode: outcome?.details?.exitCode, error: outcome?.error, ms: Date.now() - t0 }; };
	// STREAMING: bash pushes partial snapshots via onUpdate → NDJSON frames
	// idle-kill a quiet build. Client disconnect aborts the tool (taskkill).
	if (body?.stream && name === "bash") {
		const encoder = new TextEncoder();
		const abortCtrl = new AbortController();
		const onClientGone = () => abortCtrl.abort(new Error("client disconnected"));
		c.env?.incoming?.once("close", onClientGone);
		let closed = false;
		const stream = new ReadableStream({
			async start(controller) {
				const send = (obj) => { if (closed) return; try { controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n")); } catch { closed = true; } };
				const heartbeat = setInterval(() => send({ type: "ping", at: Date.now() }), 15000);
				const onUpdate = (partialResult) => send({ type: "partial", partialResult });
				const sig = AbortSignal.any([AbortSignal.timeout(120000), abortCtrl.signal]);
				try {
					const result = await tool.execute(crypto.randomUUID(), toolParams, sig, onUpdate);
					finishAudit(result);
					send({ type: "result", result: normalizeToolResult(result) });
				} catch (err) {
					finishAudit({ isError: true, error: String(err?.message || err) });
					send({ type: "result", result: { isError: true, content: [{ type: "text", text: `Error: ${err?.message || err}` }] } });
				} finally {
					clearInterval(heartbeat);
					c.env?.incoming?.removeListener("close", onClientGone);
					closed = true;
					try { controller.close(); } catch { /* already closed */ }
				}
			},
		});
		return c.body(stream, 200, { "content-type": "application/x-ndjson", "cache-control": "no-cache", "x-accel-buffering": "no" });
	}
	try {
		const result = await tool.execute(crypto.randomUUID(), toolParams, AbortSignal.timeout(120000));
		finishAudit(result);
		return c.json(normalizeToolResult(result), 200, { "Cache-Control": "no-cache" });
	} catch (err) {
		finishAudit({ isError: true, error: String(err?.message || err) });
		// tool errors go back to the MODEL as tool output (200) with isError — the loop's
		// retry framing needs it, and a bare success would read as 'edit worked'
		return c.json({ isError: true, content: [{ type: "text", text: `Error: ${err?.message || err}` }] });
	}
});
loadPiExtensions();

app.get("/api/pi/keys", (c) => {
	// ALWAYS token-required (P1): this single endpoint dumps EVERY provider key in
	// auth.json — the strongest secrets oracle in the stack. No client call path
	// uses it (the browser resolves keys via POST /api/pi/key per provider); the
	// browser-origin gate above already blocks rebinding pages, the token closes
	// the loopback drive-by case too.
	if (!tokenMatches(c.env?.incoming)) {
		return c.json({ error: "unauthorized — /api/pi/keys needs x-pi-web-token (see data/auth-token.txt)" }, 401);
	}
	const auth = readJsonSafe("auth.json") || {};
	const out = {};
	for (const [p, e] of Object.entries(auth)) { const k = typeof e === "string" ? e : e?.key; if (k) out[p] = k; }
	return c.json({ keys: out });
});
app.post("/api/pi/key", async (c) => {
	if (TOKEN) { const t = c.req.header("x-pi-web-token"); if (t !== TOKEN) return c.json({ error: "unauthorized" }, 401); }
	const body = await c.req.json().catch(() => ({}));
	const provider = String(body?.provider || "");
	if (!provider) return c.json({ error: "provider required" }, 400);
	const auth = readJsonSafe("auth.json");
	const key = typeof auth?.[provider] === "string" ? auth[provider] : auth?.[provider]?.key;
	if (!key) return c.json({ error: `no key for "${provider}"` }, 404);
	return c.json({ provider, key });
});
app.get("/api/debug/state", (c) => {
	const origin = c.req.header("origin");
	if (origin && origin !== new URL(c.req.url).origin) return c.json({ error: "forbidden" }, 403);
	return c.json({
		buildId: BUILD_ID, bootId: BOOT_ID, uptimeMs: Math.round(process.uptime() * 1000),
		agentSessions: agentHub ? agentHub.sessions.size : 0, syncClients: syncClients.size,
		terminalSessions: terminalHub.size(),
		legacySyncPuts, lastLegacyPutAt,
		execAudit: execAudit.slice(-20),
		piDir: PI_DIR, node: process.version,
	});
});

// --- LLM proxy (pi-web-ui ProxyTab format, undici-hardened) -------------------
const PROXY_MOUNT = "/api/proxy";
const MAX_INBOUND = 25 * 1024 * 1024;
const PROXY_IDLE_MS = Number(process.env.PROXY_IDLE_MS || 150000);
const MAX_BUFFERED = 4 * 1024 * 1024;

const llmAgent = new UndiciAgent({
	connections: 16, pipelining: 1,
	keepAliveTimeout: 30_000, keepAliveMaxTimeout: 60_000, connectTimeout: 30_000,
	headersTimeout: 0, bodyTimeout: 0,
});

function buildTarget(reqUrl, reqPath) {
	const u = new URL(reqUrl);
	let target = u.searchParams.get("url");
	if (!target) return null;
	try { target = decodeURIComponent(target); } catch { /* ok */ }
	const suffix = reqPath.slice(PROXY_MOUNT.length);
	if (suffix && suffix !== "/") target = target.endsWith("/") ? target.slice(0, -1) + suffix : target + suffix;
	return target;
}

function linkAborts(c) {
	const ac = new AbortController();
	const abort = () => { if (!ac.signal.aborted) ac.abort(); };
	const sig = c.req.raw.signal;
	if (sig) { if (sig.aborted) abort(); else sig.addEventListener("abort", abort, { once: true }); }
	const incoming = c.env?.incoming, outgoing = c.env?.outgoing;
	incoming?.on?.("aborted", abort);
	outgoing?.on?.("close", () => { if (outgoing && !outgoing.writableFinished) abort(); });
	return ac;
}

function passRequestHeaders(src) {
	const h = new Headers();
	const drop = ["host","connection","keep-alive","proxy-connection","transfer-encoding","content-length","content-encoding","accept-encoding","origin","referer","cookie","x-pi-web-token","te","trailer","upgrade"];
	for (const [k, v] of src.entries()) { if (!drop.includes(k.toLowerCase())) h.set(k, v); }
	h.set("accept-encoding", "identity");
	return h;
}

function passResponseHeaders(src) {
	const h = new Headers();
	const drop = ["connection","keep-alive","proxy-connection","transfer-encoding","content-length","content-encoding","set-cookie","trailer","upgrade"];
	for (const [k, v] of src.entries()) { if (!drop.includes(k.toLowerCase())) h.set(k, v); }
	h.set("cache-control", "no-cache, no-transform");
	h.set("x-accel-buffering", "no");
	return h;
}

function pinAndPipe(upstream, ac) {
	const body = upstream.body;
	if (!body) return null;
	return new ReadableStream({
		async start(controller) {
			const reader = body.getReader();
			let lastByteAt = Date.now();
			const idleTimer = setInterval(() => {
				if (Date.now() - lastByteAt > PROXY_IDLE_MS) {
					console.error("[proxy] stalled:", Math.round((Date.now() - lastByteAt) / 1000) + "s idle — aborting");
					clearInterval(idleTimer);
					try { reader.cancel("stalled"); } catch {}
					controller.error(new Error(`upstream stalled (${PROXY_IDLE_MS / 1000}s)`));
				}
			}, 5000);
			try {
				while (true) {
					if (ac.signal.aborted) { clearInterval(idleTimer); try { await reader.cancel("abort"); } catch {} controller.close(); return; }
					const { done, value } = await reader.read();
					if (done) { clearInterval(idleTimer); controller.close(); return; }
					lastByteAt = Date.now();
					controller.enqueue(value);
				}
			} catch (err) {
				clearInterval(idleTimer);
				try { await reader.cancel(err); } catch {}
				controller.error(err);
			}
		},
		async cancel(reason) {
			ac.abort();
			try { await body.cancel(reason); } catch {}
		},
	});
}

// inet_aton semantics: "2130706433" · "127.1" · "127.0.0.1" · "0177.0.0.1" · "0x7f.1" —
// all name 127.0.0.1 to the OS resolver; normalize before the range checks
function dottedFromInet(parts) {
	if (!parts.length || parts.length > 4) return null;
	const nums = parts.map((p) => {
		if (/^0[xX][0-9a-fA-F]+$/.test(p)) return parseInt(p, 16);
		if (p.length > 1 && p[0] === "0" && /^[0-7]+$/.test(p)) return parseInt(p.slice(1), 8);
		if (!/^\d+$/.test(p)) return NaN;
		return parseInt(p, 10);
	});
	if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
	if (parts.length === 4) return nums.every((n) => n <= 255) ? nums.join(".") : null;
	const last = nums[nums.length - 1];
	const head = nums.slice(0, -1);
	if (head.some((n) => n > 255)) return null;
	if (parts.length === 1) return last <= 0xffffffff ? `${(last >>> 24) & 255}.${(last >>> 16) & 255}.${(last >>> 8) & 255}.${last & 255}` : null;
	if (parts.length === 2) return last <= 0xffffff ? [head[0], (last >>> 16) & 255, (last >>> 8) & 255, last & 255].join(".") : null;
	return last <= 0xffff ? [...head, (last >>> 8) & 255, last & 255].join(".") : null;
}

// SSRF guard: block destinations that name the server's own or private networks
// (metadata endpoints, loopback CDP on :9222, LAN hosts). Hostname-pattern based
// — a DNS name re-resolving to an internal IP is still possible in theory; the
// browser-origin gate above is the primary boundary, this is depth.
function proxyTargetBlocked(hostname) {
	const h = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, ""); // brackets + FQDN trailing dot
	if (!h) return true;
	if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
	function ipv4Blocked(a, b) { // shared by dotted-quad + inet_aton normalizations
		return (
			a === 0 || a === 10 || a === 127 ||
			(a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10
			(a === 169 && b === 254) || // link-local / cloud metadata
			(a === 172 && b >= 16 && b <= 31) || // RFC1918 private
			(a === 192 && b === 168) || // RFC1918 private
			(a === 192 && b === 0) || // reserved
			(a === 198 && (b === 18 || b === 19)) || // benchmark 198.18/15
			a >= 224 // multicast 224/4 + reserved 240/4
		);
	}
	if (/^[0-9.]+$/.test(h)) { // inet_aton forms ("127.1", "2130706433", "0177.0.0.1")
		const d = dottedFromInet(h.split("."));
		if (d) {
			const [a, b] = d.split(".").map(Number);
			return ipv4Blocked(a, b); // canonical quad — do NOT recurse (it re-matches this branch)
		}
	}
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
		const [a, b] = h.split(".").map(Number);
		return ipv4Blocked(a, b);
	}
	if (h.includes(":")) { // IPv6 literal
		// IPv4-mapped: "::ffff:127.0.0.1" · "0:0:0:0:0:ffff:127.0.0.1" · "::ffff:7f00:1"
		const v4d = h.match(/^(?:::ffff:|(?:0{1,4}:){5}ffff:)(\d{1,3}(?:\.\d{1,3}){3})$/i);
		if (v4d) {
			const [a, b] = v4d[1].split(".").map(Number);
			return ipv4Blocked(a, b); // mapped dotted — evaluate inline, no recursion
		}
		const v4h = h.match(/^(?:::ffff:|(?:0{1,4}:){5}ffff:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
		if (v4h) {
			const a = parseInt(v4h[1], 16), b = parseInt(v4h[2], 16);
			return proxyTargetBlocked(`${(a >>> 8) & 255}.${a & 255}.${(b >>> 8) & 255}.${b & 255}`);
		}
		const groups = h.split(":");
		if (groups.length === 8) { // expanded "::" / "::1" ("0:0:0:0:0:0:0:1" etc.)
			const norm = groups.map((g) => g.padStart(4, "0")).join(":");
			if (norm === "0000:0000:0000:0000:0000:0000:0000:0000" || norm === "0000:0000:0000:0000:0000:0000:0000:0001") return true;
		}
		if (h === "::" || h === "::1") return true;
		if (/^f[cd]/.test(h)) return true; // fc00::/7 unique-local
		if (/^fe[89ab]/.test(h)) return true; // fe80::/10 link-local
	}
	return false;
}

async function handleProxy(c) {
	const target = buildTarget(c.req.url, c.req.path);
	if (!target) return c.json({ error: "missing ?url=" }, 400);
	let parsed;
	try { parsed = new URL(target); } catch { return c.json({ error: "invalid url" }, 400); }
	if (!["http:", "https:"].includes(parsed.protocol)) return c.json({ error: "bad protocol" }, 400);
	if (proxyTargetBlocked(parsed.hostname)) return c.json({ error: "blocked proxy target (private/loopback/link-local)" }, 403);
	const origin = c.req.header("origin");
	if (origin && origin !== new URL(c.req.url).origin) return c.json({ error: "cross-origin forbidden" }, 403);

	const ac = linkAborts(c);
	let init = { method: c.req.method, headers: passRequestHeaders(c.req.raw.headers), redirect: "manual", signal: ac.signal, dispatcher: llmAgent };
	if (!["GET", "HEAD"].includes(c.req.method)) init.body = await c.req.arrayBuffer();

	// manual redirect loop: re-apply the protocol + SSRF checks on EVERY hop — a
	// public URL must not be able to redirect into the private network (with
	// redirect:"follow" undici hopped for us, unvalidated)
	let currentUrl = parsed.toString();
	let upstream = null;
	for (let hop = 0; hop < 6; hop++) {
		try { upstream = await undiciFetch(currentUrl, init); }
		catch (err) { if (ac.signal.aborted) return new Response(null, { status: 499 }); return c.json({ error: err.message }, 502); }
		const loc = upstream.status >= 300 && upstream.status < 400 ? upstream.headers.get("location") : null;
		if (loc) {
			if (hop === 5) return c.json({ error: "too many redirects" }, 502);
			let next;
			try { next = new URL(loc, currentUrl); } catch { return c.json({ error: "bad redirect location" }, 502); }
			if (!["http:", "https:"].includes(next.protocol)) return c.json({ error: "bad protocol" }, 403);
			if (proxyTargetBlocked(next.hostname)) return c.json({ error: "blocked redirect target (private/loopback/link-local)" }, 403);
			if (next.host !== new URL(currentUrl).host) {
				// cross-origin redirect: drop caller credentials (spec fetch would too)
				const hd = new Headers(init.headers);
				hd.delete("authorization");
				init = { ...init, headers: hd };
			}
			// 303 always becomes GET; 301/302 turn non-GET into GET (browser behavior)
			if (upstream.status === 303 || ((upstream.status === 301 || upstream.status === 302) && !["GET", "HEAD"].includes(init.method))) {
				init = { ...init, method: "GET", body: undefined };
			}
			currentUrl = next.toString();
			continue;
		}
		break;
	}

	const pinned = pinAndPipe(upstream, ac);
	if (!pinned) return new Response(null, { status: upstream.status, headers: passResponseHeaders(upstream.headers) });
	return new Response(pinned, { status: upstream.status, statusText: upstream.statusText, headers: passResponseHeaders(upstream.headers) });
}

app.on(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"], PROXY_MOUNT, handleProxy);
app.on(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"], `${PROXY_MOUNT}/*`, handleProxy);

// --- static frontend (content-hashed bundle injection) -------------------------
let injectedHtml = null;
let injectedKey = "";
function getIndexHtml() {
	let manifest = { app: "app.js", css: "app.css" };
	try {
		const mf = path.join(PUBLIC, "assets", "manifest.json");
		const key = `${fs.statSync(mf).mtimeMs}`;
		if (injectedHtml && injectedKey === key) return injectedHtml;
		manifest = JSON.parse(fs.readFileSync(mf, "utf8"));
		injectedKey = key;
	} catch { /* defaults */ }
	const html = fs.readFileSync(path.join(PUBLIC, "index.html"), "utf8")
		.replace("/assets/app.css", `/assets/${manifest.css}`)
		.replace("/assets/app.js", `/assets/${manifest.app}`);
	injectedHtml = html;
	return html;
}

app.get("/", (c) => c.html(getIndexHtml(), 200, { "Cache-Control": "no-cache" }));

// --- session worker store (JSONL) --------------------------------------------
fs.mkdirSync(path.join(DATA_DIR, "sessions"), { recursive: true });
const sessionWorker = new Worker(new URL("./session-worker.mjs", import.meta.url), {
	workerData: { sessionsDir: path.join(DATA_DIR, "sessions") },
});
let storeSeq = 0;
const storePending = new Map();
sessionWorker.on("message", (msg) => {
	const p = storePending.get(msg.id);
	if (!p) return;
	storePending.delete(msg.id);
	msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result);
});
sessionWorker.on("error", (err) => console.error("[pi-web] session worker error:", err.message));

function storeOp(op, payload = {}) {
	return new Promise((resolve, reject) => {
		const id = ++storeSeq;
		storePending.set(id, { resolve, reject });
		sessionWorker.postMessage({ id, op, payload });
	});
}

// --- agent hub (server-side agents) -------------------------------------------
let piModelsStore = {};
function refreshModelsStore() {
	try { const j = readJsonSafe("models-store.json"); if (j && typeof j === "object") piModelsStore = j; } catch {}
}
refreshModelsStore();

function piDefaultModelId() {
	const s = readJsonSafe("settings.json") || {};
	return String(s.default_model || s.defaultModel || "");
}

const agentHub = new AgentHub({
	modelsStore: piModelsStore,
	getAuth: () => readJsonSafe("auth.json") || {},
	persist: async (id, jsonl) => { await storeOp("put", { id, jsonl }); broadcastSessions().catch(() => {}); },
	broadcast: (sessionId, msg) => {
		const payload = JSON.stringify({ type: "agent", sessionId, ...msg });
		for (const c of agentClients.get(sessionId) || []) { if (c.readyState === 1) c.send(payload); }
	},
	// server-side agent loop (2026-10-21, now the DEFAULT chat path): the same
	// tool objects the exec bridge exposes run IN-PROCESS; the system prompt and
	// pi settings.json default model mirror what the browser path used
	getTools: () => [...builtinTools, ...extensionTools],
	getSystemPrompt: () => effectiveSystemPrompt(),
	defaultModelId: piDefaultModelId(),
	onRuntimeChange: (sessionId, rt) => sendRuntime(sessionId, rt), // runtime deltas → tiny frame to ALL devices, bypasses all caches/throttles (fable5)
});

const syncClients = new Set();
import { SESSION_ID_RE } from "./session-id.mjs"; // shared with session-worker.mjs (bugs.md #14)
let legacySyncPuts = 0; // count of legacy {data,metadata} puts — compat shim (bugs.md #15)
let lastLegacyPutAt = 0; // epoch ms of last legacy put — decides when the shim can be removed
const agentClients = new Map();
const wss = new WebSocketServer({ noServer: true, maxPayload: 25 * 1024 * 1024 });

// --- pseudo-terminal hub (NO node-pty): winpty.exe ships with Git for Windows
// (real hidden console → echo/colors/^C/history); falls back to bash -i over
// pipes. /ws/terminal security: non-loopback token gate (upgrade handler above
// this file's dispatch) + strict Origin allowlist inside the hub.

// Origin allowlist for the terminal WS (SHARED with the HTTP browser-origin
// gate — built once above as ALLOWED_HOSTS): WS has no CORS, and matching
// against the Host header would NOT stop DNS-rebinding (attacker.com rebinds to
// 127.0.0.1, Host stays attacker.com — equal Origin+Host, game over). Compare
// against the hosts this server is ACTUALLY reachable on instead.
const TERM_ALLOWED_ORIGINS = ALLOWED_HOSTS;

const terminalHub = createTerminalHub({
	workspaceDir: WORKSPACE_DIR,
	agentDir: AGENT_DIR,
	dataDir: DATA_DIR,
	killTree: killProcessTree,
	allowedOrigins: TERM_ALLOWED_ORIGINS,
	isLoopback,
	debug: dlog,
	stripWs,
});

function safeSend(ws, obj) {
	if (ws.readyState !== 1) return;
	if (ws.bufferedAmount > MAX_BUFFERED) return;
	ws.send(JSON.stringify(obj));
}

// runtime delta frame: {type:"runtime", runtime:{sessionId,status,startedAt,turn,
// currentTool,lastText,pendingPrompts,clients,seq}} — sent IMMEDIATELY on hub
// boundary events and attach/detach (no 300ms coalesce, no 1s list cache — the
// client applies runtime frames outside its 5s metadata merge throttle)
function sendRuntime(sessionId, rt) {
	if (!rt) return;
	const frame = { type: "runtime", runtime: { ...rt, clients: agentClients.get(sessionId)?.size ?? 0 } };
	for (const c of syncClients) safeSend(c.ws, frame);
}

let listCache = null;
let listCacheAt = 0;
async function listCached() {
	const now = Date.now();
	if (!listCache || now - listCacheAt > 1000) { listCache = await storeOp("list"); listCacheAt = now; }
	return listCache;
}
// metadata + non-idle runtime per session (embedded "runtime" field — idle is
// the ABSENCE of the field; a server restart clears every runtime for free)
async function enrichedSessions() {
	const sessions = await listCached();
	return sessions.map((m) => {
		const rt = agentHub.getRuntime(m.id);
		return rt && rt.status !== "idle" ? { ...m, runtime: { ...rt, clients: agentClients.get(m.id)?.size ?? 0 } } : m;
	});
}

let broadcastPending = false;
async function broadcastSessions() {
	if (broadcastPending) return;
	broadcastPending = true;
	setTimeout(async () => {
		broadcastPending = false;
		listCache = null;
		try {
			const sessions = await enrichedSessions();
			for (const c of syncClients) safeSend(c.ws, { type: "sessions", sessions });
		} catch {}
	}, 300);
}

async function pushWatched(id) {
	const j = await storeOp("get", { id });
	if (!j) return;
	// same shape as the explicit "get" branch: the worker returns
	// {jsonl, metadata, messages} — the old `data: j.data` was undefined, so
	// watched-session notifications carried NO body (P2 fix)
	const payload = JSON.stringify({ type: "session", id, data: { messages: j.messages }, metadata: j.metadata, jsonl: j.jsonl });
	for (const c of syncClients) {
		if (c.watch.has(id) && c.ws.readyState === 1 && c.ws.bufferedAmount <= MAX_BUFFERED) c.ws.send(payload);
	}
}

setInterval(() => {
	for (const c of syncClients) {
		if (c.ws.isAlive === false) { try { c.ws.terminate(); } catch {} syncClients.delete(c); continue; }
		c.ws.isAlive = false;
		try { c.ws.ping(); } catch {}
	}
}, 20000).unref();

// --- WS handlers (single WSS, dispatch by pathname) ---------------------------
wss.on("connection", (ws, req) => {
	const pathname = ws.__piPath || (req ? new URL(req.url, "http://localhost").pathname : "/ws/sync");
	if (pathname === "/ws/agent") agentConn(ws);
	else if (pathname === "/ws/terminal") terminalHub.conn(ws, req);
	else syncConn(ws);
});

function syncConn(ws) {
	const client = { ws, watch: new Set() };
	syncClients.add(client);
	ws.isAlive = true;
	ws.on("pong", () => { ws.isAlive = true; });
	void listCached().then((sessions) => safeSend(ws, { type: "sessions", sessions }));
	ws.on("message", (raw) => {
		if (raw.length > MAX_INBOUND) return;
		let m;
		try { m = JSON.parse(raw.toString()); } catch { return; }
		void (async () => {
			const id = String(m?.id || "");
			if (m.type === "list") safeSend(ws, { type: "sessions", sessions: await listCached() });
			else if (m.type === "put" && SESSION_ID_RE.test(id)) {
				// Accept both formats: {jsonl} (native) and {data, metadata} (browser sessionSync legacy).
				// bugs.md #13: convert to the worker's JSONL format here — ALL writers/reader shapes.
				let jsonl = typeof m.jsonl === "string" ? m.jsonl : "";
				if (!jsonl && m.data && Array.isArray(m.data.messages)) {
					// COMPAT SHIM (added 2026-06-17, bugs.md #15): accept the browser client's
					// legacy {data, metadata} put and convert to JSONL. Canonical format is
					// {jsonl}. Remove this branch once legacySyncPuts stops increasing.
					// Shim scope: exactly the observed client shape {messages:[...]} — no
					// speculative format branches (that's how #15 happened).
					legacySyncPuts++;
					lastLegacyPutAt = Date.now();
					const messages = m.data.messages;
					const model = m.data.model;
					const meta = {
						...(m.metadata || {}),
						id,
						title: m.data.title ?? m.metadata?.title ?? "",
						modelId: (model && typeof model === "object") ? model.id : (model ?? m.metadata?.modelId),
						thinkingLevel: m.data.thinkingLevel ?? m.metadata?.thinkingLevel,
					};
					jsonl = JSON.stringify(meta) + "\n" + messages.map((x) => JSON.stringify(x)).join("\n") + "\n";
				}
				if (jsonl) {
					await storeOp("put", { id, jsonl });
					broadcastSessions().catch(() => {});
					pushWatched(id).catch(() => {});
				}
			} else if (m.type === "get" && SESSION_ID_RE.test(id)) {
				const j = await storeOp("get", { id });
				// worker returns {jsonl, metadata, messages} — expose as data:{messages} for clients
				if (j) safeSend(ws, { type: "session", id, data: { messages: j.messages }, metadata: j.metadata, jsonl: j.jsonl });
			} else if (m.type === "watch" && SESSION_ID_RE.test(id)) {
				client.watch.add(id);
				pushWatched(id).catch(() => {});
			} else if (m.type === "delete" && SESSION_ID_RE.test(id)) {
				await storeOp("delete", { id });
				broadcastSessions().catch(() => {});
			}
		})().catch((err) => { console.error("[sync] error:", err.message); safeSend(ws, { type: "error", error: err.message }); });
	});
	ws.on("close", () => syncClients.delete(client));
	ws.on("error", () => syncClients.delete(client));
}

function agentConn(ws) {
	console.log("[agent-ws] client connected");
	let currentSession = null;
	ws.on("message", async (raw) => {
		let m;
		try { m = JSON.parse(raw.toString()); } catch { return; }
		try {
			switch (m.type) {
				case "attach": {
					if (currentSession) detachAgentClient(currentSession, ws);
					currentSession = String(m.sessionId || "").slice(0, 80) || crypto.randomUUID();
					attachAgentClient(currentSession, ws);
					sendRuntime(currentSession, agentHub.getRuntime(currentSession)); // clients count changed (fable5)
					// ALWAYS ensure the hub session exists — fresh sessions have no store
					// entry, and set-thinking/prompt assume a registered agent (2026-10-21)
					try {
						const prev = await storeOp("get", { id: currentSession });
						if (prev?.messages && prev?.metadata) {
						agentHub.getSession(currentSession, {
							modelId: prev.metadata.modelId,
							thinkingLevel: prev.metadata.thinkingLevel,
							messages: prev.messages,
						});
						} else {
						// fresh session: honor the client's chosen model/effort (grok r3:
						// otherwise the UI shows model A while the first prompt runs model B)
						agentHub.getSession(currentSession, { modelId: m.modelId, thinkingLevel: m.thinkingLevel });
						}
					} catch (err) { console.warn("[agent-ws] cold-load:", err.message); }
					const state = agentHub.getState(currentSession);
					safeSend(ws, { type: "state", sessionId: currentSession, ...state });
					break;
				}
				case "prompt": {
					if (!currentSession) { safeSend(ws, { type: "error", error: "attach first" }); break; }
					// images: base64 ImageContent parts from the composer (validated + capped)
					const images = Array.isArray(m.images)
						? m.images.filter((im) => im && im.type === "image" && typeof im.data === "string" && typeof im.mimeType === "string").slice(0, 4)
						: undefined;
					agentHub.prompt(currentSession, String(m.content || ""), images?.length ? images : undefined).then((r) => safeSend(ws, { type: "accepted", ...r })).catch((err) => safeSend(ws, { type: "error", error: err.message }));
					break;
				}
				case "abort":
					if (currentSession) agentHub.abort(currentSession);
					break;
				case "set-model": {
					if (!currentSession) break;
					const ok = agentHub.setModel(currentSession, String(m.modelId || ""));
					safeSend(ws, { type: "model-set", ok, modelId: m.modelId });
					break;
				}
				case "set-thinking": {
					if (currentSession) agentHub.setThinkingLevel(currentSession, String(m.level || "high").slice(0, 12));
					break;
				}
				case "ping": safeSend(ws, { type: "pong" }); break;
				default: safeSend(ws, { type: "error", error: "unknown: " + (m?.type || "?") });
			}
		} catch (err) {
			console.error("[agent-ws] handler error:", err.message);
			safeSend(ws, { type: "error", error: err.message });
		}
	});
	ws.on("close", () => { if (currentSession) { detachAgentClient(currentSession, ws); sendRuntime(currentSession, agentHub.getRuntime(currentSession)); } });
	ws.on("error", () => { if (currentSession) { detachAgentClient(currentSession, ws); sendRuntime(currentSession, agentHub.getRuntime(currentSession)); } });
}

function attachAgentClient(sessionId, ws) {
	if (!agentClients.has(sessionId)) agentClients.set(sessionId, new Set());
	agentClients.get(sessionId).add(ws);
}
function detachAgentClient(sessionId, ws) {
	agentClients.get(sessionId)?.delete(ws);
	if (agentClients.get(sessionId)?.size === 0) agentClients.delete(sessionId);
}

// --- agent REST endpoints ------------------------------------------------------
app.post("/api/agent/prompt", async (c) => {
	try {
		const body = await c.req.json();
		const sessionId = String(body?.sessionId || "");
		const content = String(body?.content || "");
		if (!sessionId || !content) return c.json({ error: "sessionId and content required" }, 400);
		const result = await agentHub.prompt(sessionId, content);
		return c.json(result);
	} catch (err) { return c.json({ error: err.message }, 500); }
});
app.post("/api/agent/abort", async (c) => {
	try { const body = await c.req.json(); agentHub.abort(String(body?.sessionId || "")); return c.json({ ok: true }); }
	catch (err) { return c.json({ error: err.message }, 500); }
});
app.post("/api/agent/model", async (c) => {
	try {
		const body = await c.req.json();
		const ok = agentHub.setModel(String(body?.sessionId || ""), String(body?.modelId || ""));
		return c.json({ ok });
	} catch (err) { return c.json({ error: err.message }, 500); }
});
app.post("/api/agent/thinking", async (c) => {
	try {
		const body = await c.req.json();
		agentHub.setThinkingLevel(String(body?.sessionId || ""), String(body?.level || "high"));
		return c.json({ ok: true });
	} catch (err) { return c.json({ error: err.message }, 500); }
});
app.get("/api/agent/session/:id", async (c) => {
	try {
		const id = c.req.param("id");
		if (!agentHub.has(id)) {
			const stored = await storeOp("get", { id });
			if (stored?.metadata && stored?.messages) {
				agentHub.getSession(id, { modelId: stored.metadata.modelId, thinkingLevel: stored.metadata.thinkingLevel, messages: stored.messages });
			}
		}
		const state = agentHub.getState(id);
		return c.json({ sessionId: id, ...state });
	} catch (err) { return c.json({ error: err.message }, 500); }
});
app.post("/api/agent/session", async (c) => {
	try {
		const body = await c.req.json();
		const sessionId = String(body?.sessionId || crypto.randomUUID());
		const messages = Array.isArray(body?.messages) ? body.messages : undefined;
		agentHub.getSession(sessionId, { modelId: body?.modelId, thinkingLevel: body?.thinkingLevel, messages });
		if (messages?.length) agentHub.persistSession(sessionId, true); // migrate a local-only copy (grok r3 Q2)
		return c.json({ sessionId });
	} catch (err) { return c.json({ error: err.message }, 500); }
});
// delete-side hook: a session deleted on any device must not resurrect via a
// later hub persist — abort a live run, drop the in-memory entry, tombstone id
app.post("/api/agent/discard", async (c) => {
	try {
		const body = await c.req.json();
		agentHub.discard(String(body?.sessionId || ""));
		return c.json({ ok: true });
	} catch (err) { return c.json({ error: err.message }, 500); }
});

// --- SSE: live agent events per session ---------------------------------------
app.get("/api/agent/events", async (c) => {
	const sessionId = c.req.query("session") || "";
	if (!sessionId) return c.json({ error: "session required" }, 400);
	if (!agentHub.has(sessionId)) {
		const stored = await storeOp("get", { id: sessionId });
		if (stored?.metadata && stored?.messages) {
			agentHub.getSession(sessionId, { modelId: stored.metadata.modelId, thinkingLevel: stored.metadata.thinkingLevel, messages: stored.messages });
		}
	}
	const stream = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();
			const send = (data) => { try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)); } catch {} };
			const state = agentHub.getState(sessionId);
			send({ type: "state", sessionId, ...state });
			const unsub = agentHub.onEvents(sessionId, (event) => send(event));
			c.req.raw.signal.addEventListener("abort", () => { unsub(); try { controller.close(); } catch {} });
		},
	});
	return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" } });
});


// --- session list REST ----------------------------------------------------------
app.get("/api/sessions", async (c) => {
	try { return c.json({ sessions: await enrichedSessions() }); }
	catch (err) { return c.json({ error: err.message }, 500); }
});
app.post("/api/sessions", async (c) => {
	const sessionId = crypto.randomUUID();
	return c.json({ sessionId });
});

// static catch-all MUST be registered AFTER all /api routes (Hono matches in
// registration order — previously it shadowed /api/agent/* and /api/sessions GETs)
app.get("*", async (c) => {
	const rel = decodeURIComponent(new URL(c.req.url).pathname).replace(/^\/+/, "");
	if (rel === "api" || rel.startsWith("api/")) return c.text("not found", 404);
	const file = path.resolve(PUBLIC, rel);
	if (!file.startsWith(PUBLIC)) return c.text("forbidden", 403);
	try {
		const st = fs.statSync(file);
		const etag = `W/"${st.size}-${st.mtimeMs}"`;
		if (c.req.header("if-none-match") === etag) return c.body(null, 304, { ETag: etag, "Cache-Control": "no-cache" });
		const data = fs.readFileSync(file);
		const extra = {};
		const accept = c.req.header("accept-encoding") || "";
		if (data.length > 2048) {
			if (accept.includes("br") && fs.existsSync(file + ".br")) { body2(data, file + ".br", extra, "br"); }
			else if (accept.includes("gzip") && fs.existsSync(file + ".gz")) { body2(data, file + ".gz", extra, "gzip"); }
		}
		function body2(orig, compressedFile, hdrs, enc) {
			try { const cd = fs.readFileSync(compressedFile); return cd; } catch { return orig; }
		}
		let serveData = data;
		if (data.length > 2048) {
			const accept = c.req.header("accept-encoding") || "";
			if (accept.includes("br") && fs.existsSync(file + ".br")) { serveData = fs.readFileSync(file + ".br"); extra["Content-Encoding"] = "br"; }
			else if (accept.includes("gzip") && fs.existsSync(file + ".gz")) { serveData = fs.readFileSync(file + ".gz"); extra["Content-Encoding"] = "gzip"; }
		}
		return c.body(serveData, 200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache", ETag: etag, ...extra });
	} catch { return c.text("not found", 404); }
});

// --- server + upgrade routing ---------------------------------------------------
serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
	console.log(`[pi-web] serving ${PUBLIC}`);
	console.log(`[pi-web] pi dir: ${PI_DIR}`);
	console.log(`[pi-web] sessions mirror: ${path.join(DATA_DIR, "sessions")} (worker thread)`);
	const nets = Object.values(os.networkInterfaces()).flat();
	const lan = nets.filter((n) => n && n.family === "IPv4" && !n.internal).map((n) => n.address);
	console.log(`[pi-web] open:      http://localhost:${info.port}`);
	for (const ip of lan) console.log(`[pi-web]      also: http://${ip}:${info.port}   (mobile / LAN)`);
	if (lan.length > 0) console.log(`[auth] non-loopback callers need the API token: ${AUTH_TOKEN_FILE} (localhost is exempt)`);
}).on("upgrade", (req, socket, head) => {
	const { pathname } = new URL(req.url, "http://localhost");
	// /ws/* carries session metadata + agent streams — token-gate non-loopback peers
	if (!isLoopback(req) && !authorized(req)) { socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); socket.destroy(); return; }
	// browser-origin allowlist for sync/agent (P1): browsers ALWAYS send Origin on
	// WS handshakes and WS has no CORS — a rebinding page presents an attacker
	// Origin over a loopback socket (token-gated paths never fire for loopback).
	// Missing Origin = non-browser client: allowed (the token gate above still
	// applies to non-loopback peers). /ws/terminal does its own stricter check.
	if ((pathname === "/ws/sync" || pathname === "/ws/agent") && req.headers.origin) {
		let oh = null;
		try { oh = new URL(String(req.headers.origin)).host.toLowerCase(); } catch { oh = null; }
		if (!oh || !ALLOWED_HOSTS.has(oh)) { socket.write("HTTP/1.1 403 Forbidden\r\n\r\n"); socket.destroy(); return; }
	}
	if (pathname === "/ws/sync") wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
	else if (pathname === "/ws/agent") wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
	else if (pathname === "/ws/terminal") {
		// non-loopback peers already passed the token gate above; the hub enforces
		// the strict Origin allowlist + owns its own size-capped WSS
		terminalHub.handleUpgrade(req, socket, head);
	}
	else socket.destroy();
});
