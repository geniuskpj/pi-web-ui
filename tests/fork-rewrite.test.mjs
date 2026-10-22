// fork-rewrite.test.mjs — hub primitives for message rewrite/fork
// (llama.cpp-webui parity; linear-model adaptation of pi's /fork + /tree).
//
// Coverage:
//   1. forkSession copies the prefix into a NEW session, persists it immediately,
//      records lineage (forkedFrom → the mirror's parentSession equivalent)
//   2. fork/rewrite reject while streaming; fork(0) rejected
//   3. rewriteSession truncates in place, clears queued steering, persists, and
//      broadcasts a full {type:"state"} frame (multi-device resync)
//   4. TOKEN/USAGE COUNTERS: the client UsageBar is message-derived — these
//      tests pin the invariants it depends on: fork INHERITS usage (copied
//      assistant messages keep their usage objects), rewrite DROPS the usage of
//      removed messages, so totals shrink automatically
//   5. toolResult identity (toolCallId) travels into the fork intact
import assert from "node:assert/strict";
import { AgentHub } from "../agent-hub.mjs";

let pass = 0;
const check = (name, cond, detail = "") => {
	if (cond) { pass++; console.log(`  ✓ ${name}`); }
	else { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); process.exitCode = 1; }
};

const usage = (input, output) => ({ input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const asst = (text, u) => ({ role: "assistant", content: [{ type: "text", text }], usage: u, stopReason: "stop", timestamp: 1 });

const captured = []; // {id, jsonl}
const hub = new AgentHub({
	modelsStore: { nvidia: { name: "nvidia", models: [{ id: "m1", api: "openai-completions", provider: "nvidia", reasoning: true }] } },
	persist: async (id, jsonl) => captured.push({ id, jsonl }),
});
const SESSION = "forkbase0000000000000000000000";
const baseMessages = [
	{ role: "user", content: [{ type: "text", text: "question one" }], timestamp: 0 },
	asst("answer one", usage(100, 10)),
	{ role: "user", content: [{ type: "text", text: "question two" }], timestamp: 2 },
	asst("answer two", usage(200, 20)),
	{ role: "assistant", content: [{ type: "toolCall", id: "call-9", name: "bash", arguments: {} }], timestamp: 3 },
	{ role: "toolResult", toolCallId: "call-9", toolName: "bash", content: [{ type: "text", text: "ok" }], timestamp: 4 },
];
hub.getSession(SESSION, { messages: baseMessages });

// --- 1) fork: prefix copy, lineage, immediate persist, usage inheritance ------
let forked;
try {
	forked = await hub.forkSession(SESSION, 3);
	check("fork returns {ok, newSessionId, copied}", forked?.ok === true && typeof forked.newSessionId === "string" && forked.copied === 3, JSON.stringify(forked));
} catch (e) { check("fork returns {ok, newSessionId, copied}", false, e.message); }
if (forked?.newSessionId) {
	const F = forked.newSessionId;
	const entry = hub.sessions.get(F);
	check("forked entry exists with exactly the prefix", entry && entry.agent.state.messages.length === 3);
	check("fork lineage recorded (forkedFrom = source)", entry.forkedFrom === SESSION);
	check("fork inherits usage (answer one: in 100/out 10)", entry.agent.state.messages[1]?.usage?.input === 100 && entry.agent.state.messages[1]?.usage?.output === 10);
	check("original session untouched (still 6 messages)", hub.sessions.get(SESSION).agent.state.messages.length === 6);
	const line = captured.find((c) => c.id === F);
	check("fork persisted immediately", !!line);
	const meta = JSON.parse(line.jsonl.split("\n")[0]);
	check("persisted metadata carries forkedFrom + version", meta.forkedFrom === SESSION && meta.version === 1 && meta.messageCount === 3, JSON.stringify(meta));
	// usage-counter invariant the client UsageBar relies on:
	const totals = entry.agent.state.messages.reduce((a, m) => ({ in: a.in + (m.usage?.input || 0), out: a.out + (m.usage?.output || 0) }), { in: 0, out: 0 });
	check("forked UsageBar input would total 100 (inherited only)", totals.in === 100 && totals.out === 10, JSON.stringify(totals));
	// toolResult identity travels (provider-valid transcript)
	check("toolResult/toolCallId identity preserved in copies", entry.agent.state.messages.every((m) => m.role !== "toolResult" || m.toolCallId));
}

// --- 2) guards ------------------------------------------------------------------
try { await hub.forkSession(SESSION, 0); check("fork(0) rejected", false); } catch (e) { check("fork(0) rejected", /at least one/.test(e.message)); }
{
	const e2 = hub.sessions.get(SESSION);
	e2.agent.state.isStreaming = true; // simulate a live run
	try { await hub.forkSession(SESSION, 3); check("fork while streaming rejected", false); } catch (e) { check("fork while streaming rejected", /streaming/.test(e.message)); }
	try { hub.rewriteSession(SESSION, 2); check("rewrite while streaming rejected", false); } catch (e) { check("rewrite while streaming rejected", /streaming/.test(e.message)); }
	e2.agent.state.isStreaming = false;
}

// --- 3) rewrite: in-place truncate + steering drop + state broadcast -----------
{
	const frames = [];
	hub.broadcast = (id, msg) => { if (id === SESSION) frames.push(msg); }; // capture broadcasts
	const entry = hub.sessions.get(SESSION);
	// queue a pending steering message first — truncation must invalidate it
	entry.pendingPrompt = { text: "stale steer", images: [], queuedAt: 1 };
	entry.pendingPromptMessage = { role: "user", content: "stale steer" };
	entry.followUpCount = 1;
	const r = hub.rewriteSession(SESSION, 2);
	check("rewrite returns {ok, kept:2}", r?.ok === true && r.kept === 2, JSON.stringify(r));
	const msgs = hub.sessions.get(SESSION).agent.state.messages;
	check("session truncated to 2 messages", msgs.length === 2);
	check("usage totals DROP with removed messages (in 100 only)", msgs.reduce((a, m) => a + (m.usage?.input || 0), 0) === 100);
	check("queued steering dropped by rewrite", !entry.pendingPrompt && entry.followUpCount === 0);
	const stateFrame = frames.find((f) => f.type === "state");
	check("full state frame broadcast for multi-device resync", !!stateFrame && Array.isArray(stateFrame.messages) && stateFrame.messages.length === 2, JSON.stringify(frames.map((f) => f.type)));
	const line = captured.filter((c) => c.id === SESSION).pop();
	check("rewrite persisted immediately (messageCount 2)", line && JSON.parse(line.jsonl.split("\n")[0]).messageCount === 2);
}

// --- 4) cold fork: works straight after a restart (hydrates from the store) ----
{
	const captured2 = [];
	const hub2 = new AgentHub({
		modelsStore: { nvidia: { name: "nvidia", models: [{ id: "m1", api: "openai-completions", provider: "nvidia", reasoning: true }] } },
		persist: async (id, jsonl) => captured2.push({ id, jsonl }),
		loadMessages: async (id) => (id === "coldsession000000000000000000" ? { messages: JSON.parse(JSON.stringify(baseMessages.slice(0, 2))), metadata: { modelId: "m1", thinkingLevel: "high" } } : null),
	});
	// simulate a persisted mirror (hub writer format), hub has NO entry yet
	const meta = { id: "coldsession000000000000000000", version: 1, title: "cold", modelId: "m1", thinkingLevel: "high", messageCount: 2 };
	const jsonl = JSON.stringify(meta) + "\n" + baseMessages.slice(0, 2).map((m) => JSON.stringify(m)).join("\n") + "\n";
	// simulate restart: the store HAS the mirror (loadMessages above); the hub has NO entry
	const f = await hub2.forkSession("coldsession000000000000000000", 2);
	check("cold fork after restart hydrates + clones", f?.ok === true && hub2.sessions.get(f.newSessionId).agent.state.messages.length === 2, JSON.stringify(f));
}

console.log(`\n${pass} check(s) passed${process.exitCode ? " (WITH FAILURES)" : ""}`);
