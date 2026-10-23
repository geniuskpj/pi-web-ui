// security-gates.test.mjs — the 2026-10-21 hardening must hold: browser-origin
// gate (Host+Origin allowlist) on every /api/* route, always-token /api/pi/keys,
// proxy SSRF blocklist (all the spellings), and WS upgrade Origin gates.
//
// NOTE: fetch() STRIPS the Host header (forbidden per spec — undici sets it from
// the URL), so Host-override probes use node:http directly. WS Origin headers
// are delivered fine by the ws client.
// Usage: node tests/security-gates.test.mjs
import http from "node:http";
import os from "node:os";
import WebSocket from "ws";
import { startScratchServer } from "./_scratch-server.mjs";

let passed = 0, failed = 0;
const check = (name, ok, extra = "") => {
	if (ok) { passed++; console.log(`  ✓ ${name}${extra ? " — " + extra : ""}`); }
	else { failed++; console.error(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
};

const srv = await startScratchServer();
// GET with FULL header control (incl. Host) — node:http, not fetch
const get = (pathStr, headers = {}) => new Promise((resolve) => {
	const req = http.request({ host: "127.0.0.1", port: srv.port, path: pathStr, method: "GET", headers }, (res) => {
		res.resume();
		res.on("end", () => resolve(res.statusCode));
	});
	req.on("error", () => resolve(-1));
	req.setTimeout(15000, () => { req.destroy(); resolve(-2); });
	req.end();
});

try {
	const evil = { host: "evil.com" };
	const tok = { "x-pi-web-token": srv.token };

	// browser-origin gate: every /api/* except /api/health
	check("gate: /api/pi/config + evil Host → 403", (await get("/api/pi/config", evil)) === 403);
	check("gate: /api/sessions + evil Host → 403", (await get("/api/sessions", evil)) === 403);
	check("gate: /api/agent/session/x + evil Host → 403", (await get("/api/agent/session/x", evil)) === 403);
	check("gate: /api/exec/tools + evil Host → 403", (await get("/api/exec/tools", evil)) === 403);
	check("gate: /api/pi/config from loopback → 200", (await get("/api/pi/config")) === 200);

	// /api/pi/keys: always-token (strongest secrets oracle)
	check("keys: evil Host → 403", (await get("/api/pi/keys", evil)) === 403);
	check("keys: no token → 401", (await get("/api/pi/keys")) === 401);
	check("keys: + token → 200", (await get("/api/pi/keys", tok)) === 200);
	check("health is exempt → 200", (await get("/api/health")) === 200);

	// proxy SSRF blocklist — every spelling of "the server itself / private nets"
	const proxy = (target, host) => get(`/api/proxy/?url=${encodeURIComponent(target)}`, host ? { host } : {});
	check("proxy: 127.0.0.1 → 403", (await proxy(`http://127.0.0.1:${srv.port}/`)) === 403);
	check("proxy: [::1] → 403", (await proxy(`http://[::1]:${srv.port}/`)) === 403);
	check("proxy: 169.254.169.254 (metadata) → 403", (await proxy("http://169.254.169.254/")) === 403);
	check("proxy: 10.0.0.1 → 403", (await proxy("http://10.0.0.1/")) === 403);
	check("proxy: 172.16.5.5 → 403", (await proxy("http://172.16.5.5/")) === 403);
	check("proxy: 192.168.1.1 → 403", (await proxy("http://192.168.1.1/")) === 403);
	check("proxy: 198.18.0.1 → 403", (await proxy("http://198.18.0.1/")) === 403);
	check("proxy: inet_aton 2130706433 → 403", (await proxy("http://2130706433/")) === 403);
	check("proxy: inet_aton 127.1 → 403", (await proxy("http://127.1/")) === 403);
	check("proxy: inet_aton 0177.0.0.1 → 403", (await proxy("http://0177.0.0.1/")) === 403);
	check("proxy: [::ffff:7f00:1] → 403", (await proxy("http://[::ffff:7f00:1]/")) === 403);
	check("proxy: [0:0:0:0:0:0:0:1] → 403", (await proxy("http://[0:0:0:0:0:0:0:1]/")) === 403);
	check("proxy: localhost. (trailing dot) → 403", (await proxy("http://localhost./")) === 403);
	check("proxy: evil Host → 403 (origin gate)", (await proxy("https://api.github.com/", "evil.com")) === 403);
	{
		const pub = await proxy("https://api.github.com/");
		check("proxy: public https → 200 (network-dependent)", pub === 200, `got ${pub}`);
	}

	// WS upgrade Origin gates (/ws/sync, /ws/agent — browsers always send Origin;
	// Origin: null from sandboxed iframes must be REJECTED, never "missing")
	const wsProbe = (pathStr, origin) => new Promise((resolve) => {
		const ws = new WebSocket(`ws://127.0.0.1:${srv.port}${pathStr}`, origin ? { headers: { origin } } : {});
		const done = (r) => { try { ws.terminate(); } catch {} resolve(r); };
		const t = setTimeout(() => done("TIMEOUT"), 5000);
		ws.on("open", () => { clearTimeout(t); done("OPEN"); });
		ws.on("unexpected-response", (q, res) => { clearTimeout(t); done(`HTTP ${res.statusCode}`); });
		ws.on("error", (e) => { clearTimeout(t); done("ERR " + e.message); });
	});
	check("ws: /ws/sync + evil Origin → 403", (await wsProbe("/ws/sync", "http://evil.com")) === "HTTP 403");
	check("ws: /ws/sync + localhost Origin → OPEN", (await wsProbe("/ws/sync", `http://localhost:${srv.port}`)) === "OPEN");
	check("ws: /ws/sync + Origin null → 403", (await wsProbe("/ws/sync", "null")) === "HTTP 403");
	check("ws: /ws/sync + no Origin (non-browser) → OPEN", (await wsProbe("/ws/sync", null)) === "OPEN");
	check("ws: /ws/agent + evil Origin → 403", (await wsProbe("/ws/agent", "http://evil.com")) === "HTTP 403");
	check("ws: /ws/agent + localhost Origin → OPEN", (await wsProbe("/ws/agent", `http://localhost:${srv.port}`)) === "OPEN");
	check("ws: /ws/terminal + evil Origin → 403 (hub allowlist)", (await wsProbe("/ws/terminal?session=termtest123456789", "http://evil.com")) === "HTTP 403");
} finally {
	await srv.stop();
}

// ---------------------------------------------------------------------------
// 2026-10-23 (session-sharing incident): the origin gate became MODE-dependent and
// hostname-based. Row groups below are the regression set from the grok review —
// loopback must stay locked down, remote peers with a token must work on ANY name.
// ---------------------------------------------------------------------------
const LAN = Object.values(os.networkInterfaces()).flat().find((n) => n && !n.internal && n.family === "IPv4")?.address;

/** Request against an arbitrary scratch server. `via` switches the SOURCE address:
 *  connecting to the machine's own LAN IP makes the server see a NON-loopback peer
 *  (verified: remote + no token → 401), which is how the remote rows are exercised. */
const req = (s, pathStr, headers = {}, via = "loopback") => new Promise((resolve) => {
	const host = via === "remote" ? LAN : "127.0.0.1";
	const r = http.request({ host, port: s.port, path: pathStr, method: "GET", headers }, (res) => {
		res.resume();
		res.on("end", () => resolve(res.statusCode));
	});
	r.on("error", () => resolve(-1));
	r.setTimeout(15000, () => { r.destroy(); resolve(-2); });
	r.end();
});
const wsUp = (s, pathStr, headers = {}, via = "loopback") => new Promise((resolve) => {
	const r = http.request({ host: via === "remote" ? LAN : "127.0.0.1", port: s.port, path: pathStr, headers: { ...headers, Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==" } });
	r.on("upgrade", () => resolve(101));
	r.on("response", (x) => { x.resume(); resolve(x.statusCode); });
	r.on("error", () => resolve(-1));
	r.on("socket", (sock) => sock.on("error", () => {}));
	r.end();
});

// --- auto (default): rebinding defense intact on loopback, token is enough remotely
{
	const s = await startScratchServer();
	try {
		check("auto: loopback + evil Host → 403 (rebinding)", (await req(s, "/api/sessions", { Host: "evil.com" })) === 403);
		check("auto: loopback + evil Host + VALID token → still 403", (await req(s, "/api/sessions", { Host: "evil.com", "x-pi-web-token": s.token })) === 403);
		check("auto: loopback + suffix trick localhost.evil.com → 403", (await req(s, "/api/sessions", { Host: `localhost.evil.com:${s.port}` })) === 403);
		check("auto: loopback + Origin null → 403 (fail closed)", (await req(s, "/api/sessions", { Host: `localhost:${s.port}`, Origin: "null" })) === 403);
		check("auto: loopback + localhost Host → 200", (await req(s, "/api/sessions", { Host: `localhost:${s.port}` })) === 200);

		// EXACT port matching (grok review must-fix 1): a page from ANOTHER local app
		// (`http://localhost:3000`) must not be accepted as our own origin — otherwise any
		// drive-by local page could POST to the non-always-token routes.
		check("auto: loopback + localhost Host + Origin localhost:3000 → 403", (await req(s, "/api/sessions", { Host: `localhost:${s.port}`, Origin: "http://localhost:3000" })) === 403);
		check("auto: loopback + Host on another local port → 403", (await req(s, "/api/sessions", { Host: "127.0.0.1:3000" })) === 403);
		if (LAN) {
			check("auto: remote + no token → 401", (await req(s, "/api/sessions", { Host: `${LAN}:${s.port}` }, "remote")) === 401);
			check("auto: remote + token + ANY domain Host → 200 (the fix)", (await req(s, "/api/sessions", { Host: `pi.example.com:${s.port}`, "x-pi-web-token": s.token }, "remote")) === 200);
			check("auto: remote + token + evil Origin → 200 (token is the boundary)", (await req(s, "/api/sessions", { Host: `pi.example.com:${s.port}`, Origin: "http://evil.com", "x-pi-web-token": s.token }, "remote")) === 200);
			check("auto: remote + ?token= on HTTP → 401 (WS-only query token)", (await req(s, `/api/sessions?token=${encodeURIComponent(s.token)}`, { Host: `pi.example.com:${s.port}` }, "remote")) === 401);
			check("auto: remote + X-Forwarded-For:127.0.0.1 → 401 (never trusted)", (await req(s, "/api/sessions", { Host: `${LAN}:${s.port}`, "X-Forwarded-For": "127.0.0.1" }, "remote")) === 401);
			check("auto: remote + token + WS /ws/sync → 101", (await wsUp(s, "/ws/sync", { Host: `pi.example.com:${s.port}`, Origin: `http://pi.example.com:${s.port}`, "x-pi-web-token": s.token }, "remote")) === 101);
			check("auto: remote + no token + WS → 401", (await wsUp(s, "/ws/sync", { Host: `pi.example.com:${s.port}` }, "remote")) === 401);
		}
		// always-token routes stay always-token, mode notwithstanding
		check("auto: /api/pi/keys loopback no token → 401", (await req(s, "/api/pi/keys", { Host: `localhost:${s.port}` })) === 401);
		check("auto: /api/ws/file loopback no token → 401", (await req(s, "/api/ws/file?path=README.md", { Host: `localhost:${s.port}` })) === 401);
	} finally { await s.stop(); }
}

// --- PI_WEB_TERM_ORIGIN: portless (TLS proxy) shapes now match (PL-3)
{
	process.env.PI_WEB_TERM_ORIGIN = "pi.example.com,pi.example.com:443";
	const s = await startScratchServer();
	try {
		// A portless Origin means the SCHEME DEFAULT (https→443), so the operator lists the
		// public form explicitly — "any port on this name" is never accepted (must-fix 1).
		check("name: loopback + portless https Origin, no token → 401", (await req(s, "/api/sessions", { Host: "pi.example.com", Origin: "https://pi.example.com" })) === 401);
		check("name: loopback + portless https Origin + token → 200", (await req(s, "/api/sessions", { Host: "pi.example.com", Origin: "https://pi.example.com", "x-pi-web-token": s.token })) === 200);
		check("name: loopback + https://evil.com + token → 403", (await req(s, "/api/sessions", { Host: "pi.example.com", Origin: "https://evil.com", "x-pi-web-token": s.token })) === 403);
		check("name: WS loopback + allowlisted Origin, no token → 401", (await wsUp(s, "/ws/sync", { Host: "pi.example.com", Origin: "https://pi.example.com" })) === 401);
		check("name: WS loopback + allowlisted Origin + token → 101", (await wsUp(s, "/ws/sync", { Host: "pi.example.com", Origin: "https://pi.example.com", "x-pi-web-token": s.token })) === 101);
		// grok must-fix 2: a LOOPBACK peer naming a PUBLIC Host must still present the token
		// (a local reverse proxy makes the peer loopback — that must not be a token-free path)
		check("name: loopback + public Host + token → 200", (await req(s, "/api/sessions", { Host: `pi.example.com:${s.port}`, "x-pi-web-token": s.token })) === 200);
		check("name: loopback + public Host, no token → 401", (await req(s, "/api/sessions", { Host: `pi.example.com:${s.port}` })) === 401);
		if (LAN) check("name: remote + token + portless Origin → 200", (await req(s, "/api/sessions", { Host: "pi.example.com", Origin: "https://pi.example.com", "x-pi-web-token": s.token }, "remote")) === 200);
	} finally { await s.stop(); delete process.env.PI_WEB_TERM_ORIGIN; }
}

// --- strict: the pre-2026-10-23 behaviour must remain selectable (Host pinned even
// for token holders — only names in the allowlist pass)
{
	process.env.PI_WEB_ORIGIN_GATE = "strict";
	process.env.PI_WEB_TERM_ORIGIN = "pi.example.com";
	const s = await startScratchServer();
	try {
		check("strict: loopback + evil Host → 403", (await req(s, "/api/sessions", { Host: "evil.com" })) === 403);
		if (LAN) {
			check("strict: remote + token + UNLISTED name → 403 (old behaviour)", (await req(s, "/api/sessions", { Host: `other.example.net:${s.port}`, "x-pi-web-token": s.token }, "remote")) === 403);
			check("strict: remote + token + ALLOWLISTED name → 200", (await req(s, "/api/sessions", { Host: `pi.example.com:${s.port}`, "x-pi-web-token": s.token }, "remote")) === 200);
			check("strict: remote + token + WS unlisted Origin → 403", (await wsUp(s, "/ws/sync", { Host: `pi.example.com:${s.port}`, Origin: "http://other.example.net", "x-pi-web-token": s.token }, "remote")) === 403);
		}
	} finally { await s.stop(); delete process.env.PI_WEB_ORIGIN_GATE; delete process.env.PI_WEB_TERM_ORIGIN; }
}

// --- off: the documented foot-gun (must be LOUD at boot)
{
	process.env.PI_WEB_ORIGIN_GATE = "off";
	const s = await startScratchServer();
	try {
		check("off: loopback + LOCAL Host, no token → 200 (gate disabled)", (await req(s, "/api/sessions", { Host: `localhost:${s.port}` })) === 200);
		// the token rule is INDEPENDENT of the gate mode: with the gate off, a loopback caller
		// that names a FOREIGN Host is still not trusted (grok review must-fix 2)
		check("off: loopback + foreign Host, no token → 401", (await req(s, "/api/sessions", { Host: "evil.com" })) === 401);
		check("off: loopback + foreign Host + token → 200", (await req(s, "/api/sessions", { Host: "evil.com", "x-pi-web-token": s.token })) === 200);
		check("off: /api/pi/keys still requires the token → 401", (await req(s, "/api/pi/keys", { Host: "evil.com" })) === 401);
		check("off: boot log carries the WARNING", s.log().includes("WARNING: PI_WEB_ORIGIN_GATE=off"));
	} finally { await s.stop(); delete process.env.PI_WEB_ORIGIN_GATE; }
}

console.log(`\n[security-gates] ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
