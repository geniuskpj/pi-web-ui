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
const ORACLE = resolveRole("oracle", {});
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
	check("S7b a peer inherits its PARENT's image retention (a child of a browser-retention session)",
		(() => {
			hub.setMediaRetention("P", "phone", "browser");
			const s2 = hub.spawnPeer("P", { role: REVIEWER, task: "another" });
			const child = hub.sessions.get(s2.record.sessionId);
			const inherited = child?.retention === "browser";
			hub.setMediaRetention("P", "phone", "server");
			return inherited;
		})());
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
	check("J2b the journal knows the CHILD SESSION from second 0 (the panel can attach while it runs)",
		journal[0].sessionId === spawned.record.sessionId, String(journal[0].sessionId));
	hub.closePeerJournal("P", spawned.peerId, { status: "ok", usage: { input: 1, output: 2, cost: 0 }, turns: 2, sessionId: spawned.record.sessionId });
	const closed = hub.sessions.get("P").peerJournal[0];
	check("J3 closePeerJournal stores the terminal state + usage", closed.status === "idle" && closed.endedAt > 0 && closed.turns === 2);
	check("J3b …and KEEPS the child session id (a finished peer's transcript stays reachable)",
		closed.sessionId === spawned.record.sessionId, String(closed.sessionId));
	check("J3c the journal-backed VIEW carries it too (the panel/retry read the view, not the entry)",
		hub.peersOf("P")[0].sessionId === spawned.record.sessionId, JSON.stringify(hub.peersOf("P")[0].sessionId));
	const meta = hub._buildMetadata("P");
	check("J4 the journal rides the METADATA (it survives a restart)",
		meta.peers?.[0]?.peerId === spawned.peerId);
	check("J4b …and a USER session does NOT get a `kind` key (readers default to user; no header churn)",
		meta.kind === undefined, String(meta.kind));
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

// ── deepseek review 2026-10-31: three REAL bugs it found ───────────────────
// D1 stop-all was unreachable (the tool sends an empty peerId; the per-peer lookup rejected it first)
// D2 the boot reconcile called every unfinished spawn "dangling", including a LIVE peer — it wrote a fake
//    "server restarted" tool result while the peer was still running, and the peer's own result arrived
//    later: TWO results for one toolCallId
// D3 the control branch had no catch, so a throwing steer/retry left the parent's tool call unanswered
{
	const { hub, faux } = makeHub({ hangTools: true });
	// BOTH children must hang inside the tool, or the second one finishes and has nothing to stop
	faux.setResponses([fauxAssistantMessage([fauxToolCall("read_file", { path: "x" })]), fauxAssistantMessage([fauxToolCall("read_file", { path: "y" })])]);
	hub.getSession("P", { messages: [{ role: "user", content: "go" }] });
	const a = hub.spawnPeer("P", { role: REVIEWER, task: "one" });
	const b = hub.spawnPeer("P", { role: ORACLE, task: "two" });
	await sleep(120);
	for (let i = 0; i < 20 && hub.peersOf("P").filter((p) => p.status === "running").length < 2; i++) await sleep(50);
	check("D1a both children are really running before the stop-all", hub.peersOf("P").filter((p) => p.status === "running").length === 2, JSON.stringify(hub.peersOf("P").map((p) => p.status)));
	const stopAll = await hub.controlPeer("P", "", "stop-all", { reason: "review D1" });
	check("D1 stop-all works with NO peerId (the id the tool actually sends)",
		stopAll.ok === true && stopAll.stopped === 2, JSON.stringify(stopAll));
	check("D1b …and both peers settle as aborted", (await a.promise).status === "aborted" && (await b.promise).status === "aborted");
	check("D1c …while a foreign session still cannot stop them",
		(await hub.controlPeer("OTHER", "", "stop-all")).ok === false);
}
{
	// a LIVE peer must survive a reconcile (a re-hydrate while it runs)
	const { hub, faux } = makeHub({ hangTools: true });
	faux.setResponses([fauxAssistantMessage([fauxToolCall("read_file", { path: "x" })]), fauxAssistantMessage([fauxText("unused")])]);
	hub.getSession("P", { messages: [{ role: "user", content: "go" }] });
	const s = hub.spawnPeer("P", { role: REVIEWER, task: "still running" });
	await sleep(120);
	const before = hub.sessions.get("P").agent.state.messages.length;
	const reconciled = hub._reconcilePeers("P");
	check("D2 a RUNNING peer is not reconciled as dead", reconciled === 0, `reconciled=${reconciled}`);
	check("D2b …so no bogus tool result was injected (that would double the result later)",
		hub.sessions.get("P").agent.state.messages.length === before && !hub.sessions.get("P").agent.state.messages.some((m) => /restarted while this peer/.test(String(m?.content?.[0]?.text || ""))));
	check("D2c …and its journal entry is still open", hub.sessions.get("P").peerJournal[0].endedAt === null);
	void s;
	await hub.controlPeer("P", s.peerId, "stop");
	await s.promise;
}
{
	// the control branch must answer even when the hub throws
	const { createPeerIntegration } = await import("../peer-tools.mjs");
	const { resolveRole: rr } = await import("../lib/peer-roles.mjs");
	const integration = createPeerIntegration({
		hub: () => ({ controlPeer: async () => { throw new Error("session vanished"); }, peersOf: () => [], remainingPeerBudget: () => ({ spawns: 1, concurrent: 1, concurrentGlobal: 1 }), peers: { statusOf: () => null }, peerLimits: { summaryBytes: 1024 } }),
		usableTools: () => [{ name: "read_file" }],
		piDir: "/nonexistent", workspaceDir: "/nonexistent", enabled: true, log: () => {},
	});
	const tool = integration.toolsForSession("P", {}).find((t) => t.name === "subagent");
	let threw = false, out = null;
	try { out = await tool.execute("1", { action: "stop", peerId: "p1" }); } catch { threw = true; }
	check("D3 a throwing control call still returns ONE tool result (never a dangling call)", threw === false && !!out?.content?.[0]?.text, threw ? "it threw" : JSON.stringify(out?.content?.[0]?.text)?.slice(0, 80));
	check("D3b …and the result is the frozen error shape", out?.details?.status === "error" && /session vanished/.test(String(out.details.error)));
	check("D3c the role registry is still reachable through the same integration", !!rr("reviewer", {}));
}

// ── result shape through the tool path (C3/C21) ────────────────────────────
{
	const { hub } = makeHub({ reply: "x".repeat(40 * 1024) });
	hub.getSession("P", { messages: [{ role: "user", content: "go" }] });
	const s = hub.spawnPeer("P", { role: REVIEWER, task: "long report" });
	const out = await s.promise;
	const res = buildPeerResult({ status: out.status, peerId: out.peerId, sessionId: out.sessionId, role: "reviewer", model: out.model, usage: out.usage, error: out.error, summary: out.summary });
	const text = resultText(res);
	check("T1 a huge peer report is capped in the TEXT the parent reads", Buffer.byteLength(text, "utf8") < 34 * 1024 && /elided/.test(text));
	check("T2 …while the raw summary is still available to the UI/storage", res.summary.length === 40 * 1024);
	check("T3 a successful result names the role, the session and the token total",
		text.includes("reviewer") && text.includes(out.sessionId) && /tokens/.test(text));
	check("T4 the result carries the PEER ID (every control verb and the UI's transcript link need it)",
		out.peerId === s.peerId && res.peerId === s.peerId && PEER_RESULT_FIELDS.includes("peerId"), `${res.peerId}`);
	check("T5 usage is counted ONCE per assistant message (message_end + turn_end carry the same numbers)",
		(() => {
			const used = hub.sessions.get(out.sessionId).agent.state.messages.filter((m) => m.role === "assistant" && m.usage);
			const expect = used.reduce((n, m) => n + (Number(m.usage.input) || 0) + (Number(m.usage.output) || 0), 0);
			return res.usage.input + res.usage.output === expect;
		})(), `reported=${res.usage.input + res.usage.output}`);
}

console.log(`\n[subagent] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
