// ssrf-depth2.test.mjs — the proxy must validate RESOLVED addresses, not just
// hostname patterns (2026-10-21 commit review P2). Before the fix a public DNS
// name pointing at 127.0.0.1 (localtest.me, *.nip.io) sailed past
// proxyTargetBlocked() and reached loopback; now proxyLookup() resolves,
// rejects disallowed addresses, and pins the validated one for the socket.
//
// Network-dependent probes (DNS names, public https) SKIP gracefully when DNS
// or the internet is unavailable — only a real block-bypass fails the suite.
// Usage: node tests/ssrf-depth2.test.mjs
import dns from "node:dns";
import { startScratchServer } from "./_scratch-server.mjs";

let passed = 0, failed = 0, skipped = 0;
const check = (name, ok, extra = "") => {
	if (ok === "skip") { skipped++; console.log(`  ⊘ SKIP ${name} (${extra})`); return; }
	if (ok) { passed++; console.log(`  ✓ ${name}${extra ? " — " + extra : ""}`); }
	else { failed++; console.error(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
};
const resolvable = (name) => new Promise((r) => dns.lookup(name, (e, a) => r(!e && a === "127.0.0.1")));

const srv = await startScratchServer();
try {
	const base = `http://127.0.0.1:${srv.port}`;
	const proxyGet = async (target) => {
		try {
			const r = await fetch(`${base}/api/proxy?url=${encodeURIComponent(target)}`, { signal: AbortSignal.timeout(20000) });
			return { status: r.status, body: await r.text() };
		} catch (e) { return { status: 0, body: "fetch failed: " + e.message }; }
	};

	// depth-1 intact: IP-literal hostnames still blocked at the URL check
	{
		const r = await proxyGet(`http://127.0.0.1:${srv.port}/api/health`);
		check("depth-1: direct 127.0.0.1 target → 403", r.status === 403, `status=${r.status}`);
	}

	// depth-2: DNS names that RESOLVE to loopback must be rejected at connect
	for (const name of ["localtest.me", "127.0.0.1.nip.io"]) {
		if (!(await resolvable(name))) { check(`depth-2: ${name} → loopback blocked`, "skip", "DNS unreachable"); continue; }
		const r = await proxyGet(`http://${name}:${srv.port}/api/health`);
		const blocked = r.status === 502 && /blocked proxy target \(resolved/.test(r.body);
		check(`depth-2: ${name} (resolves to 127.0.0.1) blocked at connect`, blocked, `status=${r.status} body=${r.body.slice(0, 90)}`);
	}

	// depth-2 must not break real destinations (public https still proxies)
	{
		const r = await proxyGet("https://api.github.com/");
		if (r.status === 0) check("public https still proxied", "skip", r.body.slice(0, 60));
		else check("public https still proxied (network-dependent)", r.status === 200, `status=${r.status}`);
	}

	// redirect hops re-enter the validated lookup: a public 302 → loopback-DNS-name
	// must be blocked at hop 2. Best-effort: needs httpbin.org to be reachable.
	{
		const target = `http://localtest.me:${srv.port}/api/health`;
		const r = await proxyGet(`https://httpbin.org/redirect-to?url=${encodeURIComponent(target)}&status_code=302`);
		if (r.status === 0 && /fetch failed/.test(r.body)) {
			check("redirect → loopback-DNS-name blocked at hop 2", "skip", "httpbin.org unreachable");
		} else if (!(await resolvable("localtest.me"))) {
			check("redirect → loopback-DNS-name blocked at hop 2", "skip", "DNS unreachable");
		} else {
			const blocked = (r.status === 502 && /blocked proxy target \(resolved/.test(r.body)) || r.status === 403;
			check("redirect → loopback-DNS-name blocked at hop 2 (network-dependent)", blocked, `status=${r.status} body=${r.body.slice(0, 90)}`);
		}
	}
} finally {
	await srv.stop();
}
console.log(`\n[ssrf-depth2] ${passed} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed ? 1 : 0);
