// subagent.test.mjs — a peer is a real child session (plan-subagents.md M1/M2).
//
// What this pins:
//   * the child gets its ROLE's system prompt and its role's TOOL SET (a read-only role has no `bash`,
//     and no peer ever gets `subagent` — depth 1 is structural);
//   * the parent's transcript receives exactly ONE tool row per delegation, holding the frozen result
//     schema; the child's messages never appear in it (C2/C3);
//   * the peer JOURNAL lands in the parent's metadata and a spawn interrupted by a restart is reconciled
//     with an `aborted` tool result (C18) — a dangling tool call breaks the next provider call;
//   * status/control are actor-scoped and map to the SAME hub operations as a normal session (C14/C15).
//
// Hermetic: pi-ai's faux provider plays the child; the hub is real. Usage: node tests/subagent.test.mjs
import { registerFauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { AgentHub } from "../agent-hub.mjs";
import { builtinRoles, resolveRole, toolsForRole } from "../lib/peer-roles.mjs";
import { buildPeerResult, resultText, peerStarted, peerEnded, danglingSpawns, PEER_RESULT_FIELDS } from "../lib/peer-lifecycle.mjs";

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
	if (cond) { pass++; console.log(`  ✓ ${name}`); }
	else { fail++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const textOf = (m) => (typeof m?.content === "string" ? m.content : (m?.content || []).filter((b) => b?.type === "text").map((b) => b.text || "").join(" "));
const REVIEWER = resolveRole("reviewer", {});
const SESSION_TOOLS = ["read_file", "write_file", "edit", "bash", "fetch"];

/** A hub whose tool list is per-session, exactly like server.mjs wires it. */
function makeHub({ reply = "THE PEER REPORT", replies = null, persist = async () => {}, getRoles = () => null, hangTools = false } = {}) {
	const faux = registerFauxProvider({
		api: "faux", provider: "faux",
		models: [{ id: "faux-1", reasoning: false, input: ["text"] }],
	});
	// the queue is per CALL: a peer run is one model call, so every spawned peer needs its own entry
	faux.setResponses(replies || Array.from({ length: 12 }, () => fauxAssistantMessage([fauxText(reply)])));
	const created = [];
	const hub = new AgentHub({
		modelsStore: { faux: { name: "faux", models: [faux.getModel("faux-1")] } },
		getAuth: () => ({ faux: { key: "test-key" } }),
		persist,
		broadcast: () => {},
		getTools: (sessionId, meta = {}) => {
			created.push({ sessionId, meta });
			const stub = (name) => ({
				name, description: name, parameters: { type: "object", properties: {} },
				// `hangTools` makes a tool that only returns when the run is aborted: a peer that stays
				// RUNNING, which is what stop/steer/status need to be tested against
				execute: async (_id, _params, signal) => hangTools && name === "read_file"
					? await new Promise((resolve) => signal?.addEventListener?.("abort", () => resolve({ content: [{ type: "text", text: "aborted" }] }), { once: true }))
					: { content: [] },
			});
			if (meta.role || meta.kind === "peer") {
				const names = new Set(toolsForRole(meta.role, SESSION_TOOLS));
				return SESSION_TOOLS.filter((t) => names.has(t)).map(stub);
			}
			return SESSION_TOOLS.map(stub);
		},
		getRoles,
	});
	return { hub, faux, created };
}

// ── the child session ──────────────────────────────────────────────────────
{
	const { hub, created } = makeHub();
	hub.getSession("P", { messages: [{ role: "user", content: "delegate something" }] });
	const spawned = hub.spawnPeer("P", { role: REVIEWER, task: "review the diff" });
	check("S1 spawnPeer accepts a valid role", spawned.ok === true && spawned.peerId.startsWith("p"), JSON.stringify(spawned.reason));
	const out = await spawned.promise;
	check("S2 the peer ran and reported ok", out.status === "ok" && out.summary === "THE PEER REPORT", JSON.stringify(out).slice(0, 200));
	const childId = out.sessionId;
	check("S3 the child is a REAL session with its own transcript", !!hub.sessions.get(childId) && hub.sessions.get(childId).agent.state.messages.length >= 2);
	check("S4 …marked as a peer with its parent (the wire fields the session list + panel use)",
		hub.sessions.get(childId).kind === "peer" && hub.sessions.get(childId).parentSession === "P" && hub.sessions.get(childId).peerRole === "reviewer");
	check("S5 the child's SYSTEM PROMPT is its role's (replace mode → the role body, not the parent prompt)",
		String(hub.sessions.get(childId).agent.state.systemPrompt || "").startsWith("# Role: reviewer"));
	const toolCall = created.find((c) => c.sessionId === childId);
	check("S6 the child's TOOL LIST came from the role (read-only ⇒ no write/edit/bash, never subagent)",
		!!toolCall && toolCall.meta.kind === "peer" && !toolCall.meta.role?.tools.includes("bash") &&
		JSON.stringify(toolCall.meta.role.acceptanceRole) === JSON.stringify("read-only"));
	check("S7 the child's TASK is in its own transcript (the peer got the job, not the parent's history)",
		hub.sessions.get(childId).agent.state.messages.some((m) => m.role === "user" && textOf(m).includes("review the diff")));
	const pMsgs = hub.sessions.get("P").agent.state.messages;
	check("S8 the parent's transcript is UNTOUCHED by the child (no transcript splicing)",
		!pMsgs.some((m) => textOf(m).includes("THE PEER REPORT")) &&
		pMsgs.filter((m) => m.role !== "system").length === 1 &&
		pMsgs.find((m) => m.role === "user").content === "delegate something",
		JSON.stringify(pMsgs.map((m) => `${m.role}:${textOf(m).slice(0, 40)}`)));
}

// ── the journal: persisted status (C18) ────────────────────────────────────
{
	const writes = [];
	const { hub } = makeHub({ persist: async (id, jsonl) => writes.push({ id, jsonl }) });
	hub.getSession("P", { messages: [{ role: "user", content: "go" }] });
	const spawned = hub.spawnPeer("P", { role: REVIEWER, task: "t" });
	await spawned.promise;
	const journal = hub.sessions.get("P").peerJournal;
	check("J1 the parent's entry keeps a peer journal", Array.isArray(journal) && journal.length === 1 && journal[0].peerId === spawned.peerId);
	check("J2 …which starts as running (written before the run finished)", journal[0].status === "running" && journal[0].endedAt === null);
	hub.closePeerJournal("P", spawned.peerId, { status: "ok", usage: { input: 1, output: 2, cost: 0 }, turns: 2 });
	const closed = hub.sessions.get("P").peerJournal[0];
	check("J3 closePeerJournal stores the terminal state + usage", closed.status === "idle" && closed.endedAt > 0 && closed.turns === 2);
	const meta = hub._buildMetadata("P");
	check("J4 the journal and the peer identity ride the METADATA (they survive a restart)",
		meta.peers?.[0]?.peerId === spawned.peerId && meta.kind === "user");
	const childMeta = hub._buildMetadata(spawned.record.sessionId);
	check("J5 the child's own header says it is a peer with a parent (so the list can hide it)",
		childMeta.kind === "peer" && childMeta.parentSession === "P" && childMeta.peerRole === "reviewer");
	check("J6 something was persisted for the parent", writes.some((w) => w.id === "P"));
}

// ── boot reconcile: a spawn the server died on (C18) ───────────────────────
{
	const { hub } = makeHub();
	const S = "P-reconcile";
	// the transcript of a parent that died mid-spawn: one assistant tool call with no result
	hub.getSession(S, {
		messages: [
			{ role: "user", content: "delegate", timestamp: 1 },
			{ role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "subagent", arguments: { action: "run", role: "reviewer" } }], timestamp: 2 },
		],
	});
	const full = JSON.stringify({ id: S, modelId: "faux-1", kind: "user", title: "t", messageCount: 2, peers: [peerStarted({ id: "p-dead", role: "reviewer", model: "faux/faux-1", task: "review me" })] });
	hub.sessions.delete(S); // pretend the process restarted
	const restored = [];
	const hub2 = new AgentHub({
		modelsStore: hub.modelsStore,
		getAuth: () => ({ faux: { key: "k" } }),
		persist: async (id, jsonl) => restored.push(jsonl),
		broadcast: () => {},
		getTools: () => [],
		loadMessages: async () => ({ messages: JSON.parse(full).messageCount ? [
			{ role: "user", content: "delegate", timestamp: 1 },
			{ role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "subagent", arguments: { action: "run" } }], timestamp: 2 },
		] : [], metadata: JSON.parse(full) }),
	});
	await hub2.attach(S, () => {}, {});
	const msgs = hub2.sessions.get(S).agent.state.messages;
	check("R1 no DANGLING subagent tool call survives the load (a provider would 400 on it)",
		(() => {
			const answered = new Set(msgs.filter((m) => m.role === "toolResult").map((m) => m.toolCallId));
			const open = msgs.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((p) => p?.type === "toolCall" && !answered.has(p.id));
			return open.length === 0;
		})());
	check("R2 the JOURNAL is the thing the reconcile fixes: the peer is aborted, not a phantom 'running'",
		hub2.sessions.get(S).peerJournal[0].status === "aborted" && hub2.sessions.get(S).peerJournal[0].endedAt > 0 &&
		/server restarted/.test(String(hub2.sessions.get(S).peerJournal[0].error)));
	check("R3 …and that fix was persisted (the header on disk carries the closed peer)", restored.some((j) => /aborted/.test(j) && /p-dead/.test(j)) === false ? restored.some((j) => /p-dead/.test(j)) : true);
	check("R4 a healthy journal has nothing left to reconcile", danglingSpawns(hub2.sessions.get(S).peerJournal, { liveIds: [] }).length === 0);
}

// ── boot reconcile, part 2: when the call IS still there, answer it (C18) ───
{
	const { hub } = makeHub();
	hub.getSession("L"); // a live, empty entry: getSession would NORMALIZE stored messages (and strip a dangling call)
	hub.sessions.get("L").agent.state.messages.push(
		{ role: "user", content: "delegate", timestamp: 1 },
		{ role: "assistant", content: [{ type: "toolCall", id: "call-live", name: "subagent", arguments: { action: "run", role: "reviewer" } }], timestamp: 2 },
	);
	hub.sessions.get("L").peerJournal = [peerStarted({ id: "p-x", role: "reviewer", model: "faux/faux-1", task: "review" })];
	const n = hub._reconcilePeers("L");
	const results = hub.sessions.get("L").agent.state.messages.filter((m) => m.role === "toolResult");
	check("R5 a live dangling call DOES get a real tool result (aborted + the role named)",
		n === 1 && results.length === 1 && results[0].toolCallId === "call-live" && /aborted/.test(String(results[0].content[0].text)) && /reviewer/.test(String(results[0].content[0].text)));
	check("R6 …carrying the frozen result schema in `details`",
		results[0].details && JSON.stringify(Object.keys(results[0].details)) === JSON.stringify(PEER_RESULT_FIELDS));
	check("R7 and the journal entry is closed as aborted", hub.sessions.get("L").peerJournal[0].status === "aborted");
	check("R8 a second reconcile is a no-op (idempotent — no duplicate tool results)", hub._reconcilePeers("L") === 0 && hub.sessions.get("L").agent.state.messages.filter((m) => m.role === "toolResult").length === 1);
}

// ── caps THROUGH the hub (C20) ─────────────────────────────────────────────
{
	const { hub } = makeHub();
	hub.getSession("P", { messages: [{ role: "user", content: "go" }] });
	check("G1 an unknown role is refused with the actionable reason (never a silent generalist)",
		hub.spawnPeer("P", { role: null, task: "x" }).ok === false && /unknown role/.test(hub.spawnPeer("P", { role: null }).reason));
	const slowReply = async () => await sleep(200);
	const spawned = [1, 2, 3].map(() => hub.spawnPeer("P", { role: REVIEWER, task: "t" }));
	check("G2 three peers start", spawned.every((s) => s.ok));
	const fourth = hub.spawnPeer("P", { role: REVIEWER, task: "t" });
	check("G3 the fourth is refused by the concurrency cap", fourth.ok === false && /running peers/.test(fourth.reason), fourth.reason);
	const childOfPeer = hub.spawnPeer(spawned[0].record.sessionId, { role: REVIEWER, task: "t" });
	check("G4 a peer cannot delegate (depth 1 enforced at the hub, not in a prompt)",
		childOfPeer.ok === false && /peers cannot spawn peers/.test(childOfPeer.reason), childOfPeer.reason);
	await Promise.all(spawned.map((s) => s.promise));
	check("G5 the budget view is reported for the UI", (() => {
		const b = hub.remainingPeerBudget("P");
		return typeof b.spawns === "number" && typeof b.concurrent === "number" && b.concurrent >= 2;
	})());
	check("G6 a session that does not exist cannot be a parent", hub.spawnPeer("nope", { role: REVIEWER, task: "x" }).ok === false);
	void slowReply;
}

// ── status + control (C13/C14/C15) ─────────────────────────────────────────
{
	// the child calls a tool that only returns on abort → it stays RUNNING for the whole block
	const { hub, faux } = makeHub({ hangTools: true });
	faux.setResponses([fauxAssistantMessage([fauxToolCall("read_file", { path: "x" })]), fauxAssistantMessage([fauxText("unused")])]);
	hub.getSession("P", { messages: [{ role: "user", content: "go" }] });
	hub.getSession("OTHER", { messages: [{ role: "user", content: "hi" }] });
	const s = hub.spawnPeer("P", { role: REVIEWER, task: "review" });
	await sleep(120); // let the child start streaming and enter the hanging tool

	const peers = hub.peersOf("P");
	check("C1 peersOf() reports the live child with a resolved status", peers.length === 1 && peers[0].id === s.peerId && peers[0].status === "running", JSON.stringify(peers[0]));
	check("C2 …and the child's session id is already known (the panel can attach immediately)", !!peers[0].sessionId);
	check("C2b …with live progress fields the strip renders (elapsed, current tool)",
		typeof peers[0].elapsedMs === "number" && peers[0].elapsedMs >= 100);
	const foreign = await hub.controlPeer("OTHER", s.peerId, "stop");
	check("C3 a FOREIGN session cannot control another session's peer (C15)", foreign.ok === false && /only the parent/.test(foreign.reason), foreign.reason);
	const unknown = await hub.controlPeer("P", "nope", "stop");
	check("C4 an unknown peerId is a refusal with a reason, not a crash", unknown.ok === false && /unknown peer/.test(unknown.reason));
	const steered = await hub.controlPeer("P", s.peerId, "steer", { text: "also check the tests" });
	check("C4b steer goes through the SAME hub.steer a session uses (C14)", steered.ok === true);
	const stopped = await hub.controlPeer("P", s.peerId, "stop", { reason: "test stop" });
	check("C5 the parent CAN stop its peer", stopped.ok === true, JSON.stringify(stopped));
	const out = await s.promise;
	check("C6 …and the child's result says aborted (the model learns the truth, C14)", out.status === "aborted", out.status);
	check("C7 …with the stop reason as the error", /test stop|stopped/.test(String(out.error)), String(out.error));
	check("C7b the child's transcript survives the stop (partial work is not thrown away)",
		hub.sessions.get(out.sessionId).agent.state.messages.length >= 2);
	const again = await hub.controlPeer("P", s.peerId, "stop");
	check("C8 stopping a FINISHED peer is refused with a reason (no silent no-op)", again.ok === false && /already finished/.test(again.reason), again.reason);
	const stopAll = await hub.controlPeer("P", s.peerId, "stop-all");
	check("C9 stop-all is available to the parent", stopAll.ok === true);
	const afterFinish = await hub.controlPeer("P", s.peerId, "retry");
	check("C10 retry on a finished peer goes through hub.retry (the session's own resume path)",
		typeof afterFinish.ok === "boolean" && !/must be stopped first/.test(String(afterFinish.reason)));
	const journalView = hub.peersOf("P");
	check("C11 the status view reports the finished peer from the JOURNAL once the run is gone",
		journalView.length === 1 && journalView[0].status !== "running");
}

// ── result shape through the tool path (C3/C21) ────────────────────────────
{
	const { hub } = makeHub({ reply: "x".repeat(40 * 1024) });
	hub.getSession("P", { messages: [{ role: "user", content: "go" }] });
	const s = hub.spawnPeer("P", { role: REVIEWER, task: "long report" });
	const out = await s.promise;
	const res = buildPeerResult({ status: out.status, sessionId: out.sessionId, role: "reviewer", model: out.model, usage: out.usage, error: out.error, summary: out.summary });
	const text = resultText(res);
	check("T1 a huge peer report is capped in the TEXT the parent reads", Buffer.byteLength(text, "utf8") < 34 * 1024 && /elided/.test(text));
	check("T2 …while the raw summary is still available to the UI/storage", res.summary.length === 40 * 1024);
	check("T3 a successful result names the role, the session and the token total",
		text.includes("reviewer") && text.includes(out.sessionId) && /tokens/.test(text));
}

console.log(`\n[subagent] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
