// fetch-tool.test.mjs — the agent's server-side fetch tool (builtinTools entry
// "fetch" in server.mjs, executed here through the /api/exec/tool bridge like
// the real agent loop calls it).
//
// Deterministic checks: SSRF blocks (loopback target, CDP port on localhost,
// non-http(s) protocol) and tool listing. One network-dependent positive
// (https://example.com) verifying the markdown conversion pipeline end-to-end —
// same pattern as the security tests' "network-dependent" checks.
import { startScratchServer, execTool } from "./_scratch-server.mjs";

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
	if (cond) { pass++; console.log(`  ✓ ${name}`); }
	else { fail++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};
const textOf = (r) => (r?.content || []).map((c) => c.text || "").join("\n");

const srv = await startScratchServer();
try {
	// tool registered + visible via /api/exec/tools (PI_WEB_TOOLS allowlist flows through)
	const tools = await (await fetch(srv.url("/api/exec/tools"), { headers: { "x-pi-web-token": srv.token } })).json();
	const names = (tools.tools || tools || []).map((t) => t.name || t);
	check("fetch tool listed in /api/exec/tools", names.includes("fetch"), JSON.stringify(names));

	// SSRF depth-1: the scratch server itself is loopback → blocked
	const r1 = await execTool(srv, { url: srv.url("/") }, "fetch");
	check("loopback target blocked", r1.isError === true && /blocked/i.test(textOf(r1)), JSON.stringify(r1).slice(0, 160));

	// SSRF depth-1: CDP port on localhost (the metadata-endpoint case)
	const r2 = await execTool(srv, { url: "http://localhost:9222/json" }, "fetch");
	check("localhost:9222 (CDP) blocked", r2.isError === true && /blocked/i.test(textOf(r2)), JSON.stringify(r2).slice(0, 160));

	// non-http(s) scheme
	const r3 = await execTool(srv, { url: "ftp://example.com/pub" }, "fetch");
	check("ftp:// blocked (protocol)", r3.isError === true && /protocol/i.test(textOf(r3)), JSON.stringify(r3).slice(0, 160));

	// invalid URL
	const r4 = await execTool(srv, { url: "not a url" }, "fetch");
	check("garbage URL rejected", r4.isError === true, JSON.stringify(r4).slice(0, 160));

	// positive path — NETWORK-DEPENDENT: real conversion pipeline (fetch →
	// stripBoilerplate → markdown head)
	const r5 = await execTool(srv, { url: "https://example.com/" }, "fetch");
	const t5 = textOf(r5);
	check("example.com fetched (network-dependent)", r5.isError !== true && /200/.test(t5), t5.slice(0, 160));
	check("HTML converted to markdown with title", /Example Domain/.test(t5) && /fetch https:\/\/example\.com\/ → 200/.test(t5), t5.slice(0, 200));
	check("stripped: no <script>/<style> noise survives", !/<script/i.test(t5) && !/<style/i.test(t5));

	// raw mode returns the untouched body
	const r6 = await execTool(srv, { url: "https://example.com/", raw: true }, "fetch");
	const t6 = textOf(r6);
	check("raw:true returns verbatim HTML", r6.isError !== true && /<!doctype html>/i.test(t6), t6.slice(0, 160));
} catch (err) {
	fail++;
	console.error("FATAL:", err.message);
} finally {
	await srv.stop();
}
console.log(`\n[fetch-tool] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
