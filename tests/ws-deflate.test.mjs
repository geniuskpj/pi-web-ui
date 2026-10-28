// ws-deflate.test.mjs — plan-mobile-data.md item 2 ("compressed websocket transmission by
// deflate") and §6 (the P1 acceptance test).
//
// WHAT THIS PINS
//   D1/D2  the agent WSS (/ws/agent and /ws/sync) negotiates permessage-deflate  → PASSES today
//   D3     the client can refuse the extension (a client that does not offer it gets none)
//   D4     PI_WEB_WS_DEFLATE=off removes the extension server-side (the escape hatch, §2.1)
//   D5     the negotiated socket still carries the protocol (a real frame arrives deflated)
//   D6/D7  the TERMINAL WSS negotiates it — PENDING: terminal-hub.mjs has no perMessageDeflate yet
//   D8     source assertions that keep the config shape honest (threshold 1024 / level 6 / env key)
//
// PENDING (⚠) checks are reported and do NOT fail the suite: they are the P1 work item, and they
// flip to ✓ on their own once the terminal WSS gets the block. This is deliberate — a red CI for
// unwritten code is noise, but a silent gap in the plan is worse.
//
// NOT TESTED HERE (and why): the actual byte savings need a real scrollback fixture (a 5MB build
// log), which means a pty/bash and seconds of wall time — plan §7's measurement table, not CI.
// What CI *can* prove cheaply is the W suite of tests/thinking-flush.test.mjs, which deflates the
// frames at the socket's own threshold/level.
//
// Usage: node tests/ws-deflate.test.mjs
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import { startScratchServer, ROOT } from "./_scratch-server.mjs";

let passed = 0, failed = 0, pending = 0;
const check = (name, ok, extra = "") => {
	if (ok) { passed++; console.log(`  ✓ ${name}${extra ? " — " + extra : ""}`); }
	else { failed++; console.error(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
};
const todo = (name, open, extra = "") => {
	if (open) { passed++; console.log(`  ✓ ${name}${extra ? " — " + extra : ""}`); }
	else { pending++; console.warn(`  ⚠ PENDING ${name}${extra ? " — " + extra : ""}`); }
};

/** Open a socket and report the extension the SERVER accepted (or an error string). */
function handshake(url, { perMessageDeflate = true, origin = null, headers = {} } = {}) {
	return new Promise((resolve) => {
		const ws = new WebSocket(url, { perMessageDeflate, ...(origin ? { origin } : {}), ...(Object.keys(headers).length ? { headers } : {}) });
		let settled = false;
		const finish = (value) => { if (settled) return; settled = true; clearTimeout(t); try { ws.close(); } catch { /* gone */ } resolve(value); };
		const t = setTimeout(() => finish("timeout"), 8000);
		t.unref?.();
		ws.on("upgrade", (res) => finish(String(res.headers["sec-websocket-extensions"] || "")));
		ws.on("unexpected-response", (_req, res) => finish(`HTTP ${res.statusCode}`));
		ws.on("error", (err) => finish(`error: ${err.message}`));
	});
}
const negotiated = (ext) => /permessage-deflate/.test(ext);

const srv = await startScratchServer();
const wsToken = encodeURIComponent(srv.token);
const agentUrl = `ws://127.0.0.1:${srv.port}/ws/agent?token=${wsToken}`;
const syncUrl = `ws://127.0.0.1:${srv.port}/ws/sync?token=${wsToken}`;
const termUrl = `ws://127.0.0.1:${srv.port}/ws/terminal?session=deflate0000000000000000000001&cols=80&rows=24&token=${wsToken}`;
const origin = `http://127.0.0.1:${srv.port}`;

try {
	console.log("[ws-deflate] agent socket (server.mjs)");
	const agent = await handshake(agentUrl);
	check("D1 /ws/agent negotiates permessage-deflate", negotiated(agent), agent || "(no extension offered)");
	const sync = await handshake(syncUrl);
	check("D2 /ws/sync (same WSS) negotiates it too", negotiated(sync), sync);

	// a browser cannot switch the extension off; a non-browser client CAN decline it, and the
	// server must still work (that is what makes the extension safe to leave on)
	const declined = await handshake(agentUrl, { perMessageDeflate: false });
	check("D3 a client that declines the extension gets none (and still connects)", declined === "", declined || "(none — as expected)");

	console.log("[ws-deflate] protocol still works over the compressed socket");
	{
		const frame = await new Promise((resolve) => {
			const ws = new WebSocket(syncUrl, { perMessageDeflate: true });
			const t = setTimeout(() => resolve(null), 8000);
			t.unref?.();
			ws.on("message", (raw) => { clearTimeout(t); const m = JSON.parse(raw.toString()); try { ws.close(); } catch { /* gone */ } resolve(m); });
			ws.on("error", () => { clearTimeout(t); resolve(null); });
		});
		check("D4 a real frame arrives over the deflated socket (deflate does not corrupt the hub protocol)",
			frame?.type === "sessions" && Array.isArray(frame.sessions), frame ? String(frame.type) : "no frame");
	}

	console.log("[ws-deflate] terminal socket (terminal-hub.mjs) — P1 work item");
	{
		const ext = await handshake(termUrl, { origin });
		todo("D5 /ws/terminal negotiates permessage-deflate (plan §2.1 P1)", negotiated(ext), ext || "(no extension offered)");
		const hubSrc = fs.readFileSync(path.join(ROOT, "terminal-hub.mjs"), "utf8");
		const wssBlock = hubSrc.slice(hubSrc.indexOf("new WebSocketServer"), hubSrc.indexOf("new WebSocketServer") + 400);
		todo("D6 the terminal WSS carries the same block (threshold + env kill switch)", /perMessageDeflate/.test(wssBlock), wssBlock.split("\n")[0].trim().slice(0, 80));
	}

	console.log("[ws-deflate] source assertions (config shape the measurement relies on)");
	{
		const serverSrc = fs.readFileSync(path.join(ROOT, "server.mjs"), "utf8");
		const block = serverSrc.slice(serverSrc.indexOf("const wss = new WebSocketServer"), serverSrc.indexOf("const wss = new WebSocketServer") + 400);
		check("D7 the agent WSS keeps the env kill switch (PI_WEB_WS_DEFLATE=off)",
			/PI_WEB_WS_DEFLATE === "off"/.test(block) && /perMessageDeflate/.test(block));
		check("D8 …and the threshold/level the byte accounting assumes (1024 / level 6)",
			/threshold:\s*1024/.test(block) && /level:\s*6/.test(block), block.replace(/\s+/g, " ").slice(0, 140));
		check("D9 the terminal upgrade is routed to the hub (one WSS config, one upgrade path)",
			/pathname === "\/ws\/terminal"/.test(serverSrc) && /terminalHub\.handleUpgrade\(req, socket, head\)/.test(serverSrc));
	}

	// the kill switch, on a second server instance (env is read at startup)
	console.log("[ws-deflate] PI_WEB_WS_DEFLATE=off");
	{
		const off = await startScratchServer({ env: { PI_WEB_WS_DEFLATE: "off" } });
		try {
			const url = `ws://127.0.0.1:${off.port}/ws/agent?token=${encodeURIComponent(off.token)}`;
			const ext = await handshake(url);
			check("D10 with the kill switch set the server refuses the extension", ext === "" && !negotiated(ext), ext || "(none — as expected)");
			const frame = await new Promise((resolve) => {
				const ws = new WebSocket(`ws://127.0.0.1:${off.port}/ws/sync?token=${encodeURIComponent(off.token)}`);
				const t = setTimeout(() => resolve(null), 8000);
				t.unref?.();
				ws.on("message", (raw) => { clearTimeout(t); try { ws.close(); } catch { /* gone */ } resolve(raw.toString()); });
				ws.on("error", () => { clearTimeout(t); resolve(null); });
			});
			check("D10b and the socket still works uncompressed (the escape hatch is not a breakage)",
				typeof frame === "string" && /"type":"sessions"/.test(frame), frame ? frame.slice(0, 40) : "no frame");
		} finally {
			await off.stop();
		}
	}
} finally {
	await srv.stop();
}

console.log(`\n[ws-deflate] ${passed} passed, ${failed} failed, ${pending} pending (P1: terminal WSS)`);
process.exit(failed ? 1 : 0);
