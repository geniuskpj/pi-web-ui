// subagent-server.e2e.mjs — the PEER surface over a REAL server (plan-subagents.md M1/M2).
//
// The hub-level suite (tests/subagent.test.mjs) proves the semantics; this proves the WIRING that only
// exists once server.mjs boots: the role catalog from disk, the `kind` filter that keeps peer sessions
// out of the sidebar (D10/C17), and the status/control routes the UI and the peer panel call.
//
// No model is needed: nothing here prompts a peer (that is the hub suite's job).
// Usage: node tests/subagent-server.e2e.mjs
import WebSocket from "ws";
import { startScratchServer } from "./_scratch-server.mjs";
import fs from "node:fs";
import path from "node:path";

let passed = 0, failed = 0;
const check = (name, ok, extra = "") => {
	if (ok) { passed++; console.log(`  ✓ ${name}${extra ? " — " + extra : ""}`); }
	else { failed++; console.error(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = await startScratchServer();
const H = { "x-pi-web-token": srv.token };
const json = async (p, init = {}) => {
	const r = await fetch(srv.url(p), { headers: H, ...init });
	const text = await r.text();
	let body = null;
	try { body = JSON.parse(text); } catch { /* ndjson */ }
	return { status: r.status, body, text };
};

try {
	// ── the role catalog comes from .pi/agents/*.md + the builtins ─────────────
	const roles = await json("/api/peer/roles");
	const names = (roles.body?.roles || []).map((r) => r.name);
	check("E1 GET /api/peer/roles lists the shipped roles",
		roles.status === 200 && ["reviewer", "oracle", "scout", "worker", "delegate"].every((n) => names.includes(n)), names.join(","));
	check("E1b …with the enforcement facts the UI needs (acceptanceRole + effective tool count)",
		roles.body.roles.every((r) => typeof r.tools === "number" && r.acceptanceRole) &&
		roles.body.roles.find((r) => r.name === "reviewer").acceptanceRole === "read-only");
	check("E1c the deploy dirs are reported (a missing dir is not an error)", Array.isArray(roles.body.dirs) && roles.body.dirs.length >= 1);
	check("E1d subagents are ENABLED by default (PI_WEB_PEERS is the kill switch)", roles.body.enabled === true);

	// ── a workspace role file shows up (and overrides the builtin) ────────────
	const agentsDir = path.join(srv.wsDir, ".pi", "agents");
	fs.mkdirSync(agentsDir, { recursive: true });
	fs.writeFileSync(path.join(agentsDir, "reviewer.md"), "---\nname: reviewer\ndescription: WORKSPACE OVERRIDE\ntools: read_file\nacceptanceRole: read-only\n---\noverridden body\n");
	fs.writeFileSync(path.join(agentsDir, "house-style.md"), "---\nname: house-style\ndescription: our own role\nacceptanceRole: read-only\n---\nhouse body\n");
	const roles2 = await json("/api/peer/roles");
	const rev = roles2.body.roles.find((r) => r.name === "reviewer");
	check("E2 a workspace .pi/agents/*.md OVERRIDES the builtin", rev.description === "WORKSPACE OVERRIDE", rev.description);
	check("E2b …and a NEW role file appears in the catalog", roles2.body.roles.some((r) => r.name === "house-style"));

	// ── kind: peer sessions stay out of the list (D10/C17) ───────────────────
	const PEER = "peer0000000000000000000000000001";
	const USER = "user0000000000000000000000000001";
	const sync = new WebSocket(`ws://127.0.0.1:${srv.port}/ws/sync?token=${encodeURIComponent(srv.token)}`);
	await new Promise((res, rej) => { sync.on("open", res); sync.on("error", rej); });
	const put = (id, kind) => sync.send(JSON.stringify({
		type: "put", id,
		jsonl: [JSON.stringify({ id, title: `${kind} session`, modelId: "x", thinkingLevel: "high", messageCount: 1, kind }), JSON.stringify({ role: "user", content: "hello", timestamp: Date.now() })].join("\n"),
	}));
	put(PEER, "peer");
	put(USER, "user");
	for (let i = 0; i < 40; i++) {
		const l = await json("/api/sessions");
		if ((l.body?.sessions || []).some((s) => s.id === USER)) break;
		await sleep(100);
	}
	const list = await json("/api/sessions");
	check("E3 GET /api/sessions EXCLUDES peer sessions (the sidebar stays clean)",
		!list.body.sessions.some((s) => s.id === PEER) && list.body.sessions.some((s) => s.id === USER));
	const all = await json("/api/sessions?kind=all");
	check("E3b …and ?kind=all includes them (the peer panel / debugging path)", all.body.sessions.some((s) => s.id === PEER));
	const peerSession = await json(`/api/agent/session/${PEER}`);
	check("E3c a peer is still reachable BY ID (that is how the panel opens it)", peerSession.status === 200 && peerSession.body?.exists !== undefined);

	// ── the status/control routes ────────────────────────────────────────────
	const peers = await json(`/api/agent/session/${USER}/peers`);
	check("E4 GET …/peers returns the snapshot shape the UI renders", peers.status === 200 && Array.isArray(peers.body.peers) && peers.body.peers.length === 0);
	check("E4b …plus the remaining budget (so the strip can warn before a refusal)",
		peers.body.budget && typeof peers.body.budget.spawns === "number" && typeof peers.body.budget.concurrent === "number");
	const stopUnknown = await json(`/api/agent/session/${USER}/peers/nope/stop`, { method: "POST", headers: { ...H, "content-type": "application/json" }, body: "{}" });
	check("E5 POST control on an unknown peer is a 409 with a reason, not a 500", stopUnknown.status === 409 && /unknown peer/.test(String(stopUnknown.body?.reason)), JSON.stringify(stopUnknown.body));
	const badAction = await json(`/api/agent/session/${USER}/peers/nope/launch`, { method: "POST", headers: { ...H, "content-type": "application/json" }, body: "{}" });
	check("E5b an unknown verb is a 400 (the route validates before it touches the hub)", badAction.status === 400);

	// ── the WS verbs exist and answer ────────────────────────────────────────
	const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws/agent?token=${encodeURIComponent(srv.token)}`);
	const frames = [];
	ws.on("message", (raw) => { try { frames.push(JSON.parse(raw.toString())); } catch { /* ignore */ } });
	await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
	ws.send(JSON.stringify({ type: "attach", sessionId: USER }));
	for (let i = 0; i < 40 && !frames.some((f) => f.type === "state"); i++) await sleep(100);
	check("E6 attach on a user session still works (no regression from the peer wiring)", frames.some((f) => f.type === "state"));
	ws.send(JSON.stringify({ type: "peers", id: "q1" }));
	for (let i = 0; i < 30 && !frames.some((f) => f.type === "peers" && f.id === "q1"); i++) await sleep(100);
	const peersFrame = frames.find((f) => f.type === "peers" && f.id === "q1");
	check("E7 the WS `peers` verb answers with the same snapshot the REST route returns",
		!!peersFrame && Array.isArray(peersFrame.peers) && !!peersFrame.budget);
	ws.send(JSON.stringify({ type: "peer", id: "q2", action: "stop", peerId: "nope" }));
	for (let i = 0; i < 30 && !frames.some((f) => f.type === "peer-result" && f.id === "q2"); i++) await sleep(100);
	const ctrl = frames.find((f) => f.type === "peer-result" && f.id === "q2");
	check("E8 the WS `peer` control verb echoes the outcome (the UI never guesses)",
		!!ctrl && ctrl.ok === false && /unknown peer/.test(String(ctrl.reason)), JSON.stringify(ctrl?.reason));
	check("E8b …and carries the refreshed peer list for the strip", !!ctrl && Array.isArray(ctrl.peers));
	ws.close();
} finally {
	await srv.stop?.().catch?.(() => {});
}

console.log(`\n[subagent-server e2e] ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
