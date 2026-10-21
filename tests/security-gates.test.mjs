// security-gates.test.mjs — the 2026-10-21 hardening must hold: browser-origin
// gate (Host+Origin allowlist) on every /api/* route, always-token /api/pi/keys,
// proxy SSRF blocklist (all the spellings), and WS upgrade Origin gates.
//
// NOTE: fetch() STRIPS the Host header (forbidden per spec — undici sets it from
// the URL), so Host-override probes use node:http directly. WS Origin headers
// are delivered fine by the ws client.
// Usage: node tests/security-gates.test.mjs
import http from "node:http";
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
console.log(`\n[security-gates] ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
