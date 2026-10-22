// compact.test.mjs — hub compactSession (pi /compact parity).
//
// Coverage:
//   1. serialization: [User]/[Assistant]/[Assistant tool calls]/[Tool result
//      (name)], thinking OMITTED, tool results truncated at 2000 chars
//   2. cut point: backwards token-estimate walk to keepRecentTokens; cut
//      advances past toolResults; the tail user line stays KEPT (not summarized)
//   3. replacement: [flagged summary, ...kept]; UsageBar totals (message-derived)
//      drop to the kept tail
//   4. iterative folding: the second compaction passes the previous summary
//   5. guards: streaming, double-compact, prompt rejected while compacting
//   6. persist + state-frame broadcast + pre-compact backup invoked
import assert from "node:assert/strict";
import { AgentHub } from "../agent-hub.mjs";

let pass = 0;
const check = (name, cond, detail = "") => {
	if (cond) { pass++; console.log(`  ✓ ${name}`); }
	else { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); process.exitCode = 1; }
};
const textOf = (m) => (typeof m?.content === "string" ? m.content : (m?.content || []).filter((b) => b?.type === "text").map((b) => b.text || "").join("\n"));

const bigToolOutput = "x".repeat(5000);
const baseMessages = [
	{ role: "user", content: [{ type: "text", text: "goal: refactor the parser" }], timestamp: 0 },
	{ role: "assistant", content: [{ type: "thinking", thinking: "secret reasoning" }, { type: "text", text: "on it" }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }], usage: { input: 500, output: 50 }, timestamp: 1 },
	{ role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: bigToolOutput }], timestamp: 2 },
	{ role: "assistant", content: [{ type: "text", text: "found 3 files" }], usage: { input: 700, output: 30 }, timestamp: 3 },
	{ role: "user", content: [{ type: "text", text: "now write tests" }], timestamp: 4 },
	{ role: "assistant", content: [{ type: "text", text: "tests written" }], usage: { input: 800, output: 40 }, timestamp: 5 },
	{ role: "user", content: [{ type: "text", text: "what next?" }], timestamp: 6 },
];

const summarizeCalls = [];
let summarizeDelay = 0; // >0 holds compaction in-flight (guards observable)
const backups = [];
const frames = [];
const captured = [];
const hub = new AgentHub({
	modelsStore: { nvidia: { name: "nvidia", models: [{ id: "m1", api: "openai-completions", provider: "nvidia", reasoning: true }] } },
	persist: async (id, jsonl) => captured.push({ id, jsonl }),
	broadcast: (id, msg) => { if (id === SESSION) frames.push(msg); },
	summarize: async ({ serialized, previousSummary }) => {
		if (summarizeDelay) await new Promise((r) => setTimeout(r, summarizeDelay));
		summarizeCalls.push({ serialized, previousSummary });
		return "## Goal\nrefactor the parser\n\n## Progress\n### Done\n- [x] located 3 files";
	},
	backupMirror: async (id) => { backups.push(id); return "backup:" + id; },
});
const SESSION = "compacttest00000000000000000000";
hub.getSession(SESSION, { messages: JSON.parse(JSON.stringify(baseMessages)) });

// --- 1+2+3) compact with a small keepRecentTokens → the head summarized -------
const r = await hub.compactSession(SESSION, { keepRecentTokens: 100 });
check("compact returns {ok, summarized, kept}", r?.ok === true && r.summarized >= 2 && typeof r.kept === "number", JSON.stringify(r));

const msgs = hub.sessions.get(SESSION).agent.state.messages;
check("transcript = [summary, ...kept]", msgs[0]?.isCompactionSummary === true && msgs.length < baseMessages.length, `len=${msgs.length}`);
check("summary message flagged + headed", String(msgs[0]?.content?.[0]?.text || "").startsWith("## Conversation summary (auto-compacted)"));
check("UsageBar invariant: totals drop to kept usage only", msgs.reduce((a, m) => a + (m.usage?.input || 0), 0) < baseMessages.reduce((a, m) => a + (m.usage?.input || 0), 0));
check("kept tail keeps the last assistant usage verbatim", msgs.some((m) => m.usage?.input === 800));

check("summarizer called once", summarizeCalls.length === 1, String(summarizeCalls.length));
{
	const ser = summarizeCalls[0]?.serialized || "";
	check("serialization: [User] line (head span only)", ser.includes("[User]: goal: refactor the parser") && !ser.includes("[User]: now write tests"));
	check("serialization: [Assistant] + [Assistant tool calls] with args", ser.includes("[Assistant]: on it") && ser.includes('[Assistant tool calls]: bash({"command":"ls"})'));
	check("serialization: [Tool result (bash)]", ser.includes("[Tool result (bash)]:"));
	check("thinking blocks OMITTED", !ser.includes("secret reasoning"));
	check("tool result truncated at 2000 chars with marker", ser.includes("[… 3000 chars truncated]") && !ser.includes("x".repeat(2500)));
	check("no previous summary on first compact", summarizeCalls[0]?.previousSummary === "");
}
check("pre-compact backup invoked", backups.length === 1 && backups[0] === SESSION);
check("persist + state frame broadcast", captured.some((c) => c.id === SESSION) && frames.some((f) => f.type === "state"));

// --- 4) iterative folding: second compaction passes the previous summary ------
{
	while (summarizeCalls.length) summarizeCalls.pop(); // reset (let-binding avoided: single closure)
	const r2 = await hub.compactSession(SESSION, { keepRecentTokens: 8 }); // the post-compact tail is tiny (est ~16) — keep 8 cuts a 3-message span
	check("second compact ok", r2?.ok === true, JSON.stringify(r2));
	check("second compact passes the previous summary", summarizeCalls.length === 1 && /## Goal\nrefactor the parser/.test(summarizeCalls[0]?.previousSummary || ""), JSON.stringify((summarizeCalls[0]?.previousSummary || "").slice(0, 80)));
}

// --- 5) guards (compaction held in-flight so they are observable) -------------
{
	const G = "compactguards000000000000000000";
	hub.getSession(G, { messages: JSON.parse(JSON.stringify(baseMessages)) }); // content-rich: the double-compacted SESSION is too small to re-compact
	const entry = hub.sessions.get(G);
	const origBroadcast = hub.broadcast;
	entry.agent.state.isStreaming = true;
	try { await hub.compactSession(G, { keepRecentTokens: 100 }); check("compact while streaming rejected", false); } catch (e) { check("compact while streaming rejected", /streaming/.test(e.message)); }
	entry.agent.state.isStreaming = false;

	summarizeDelay = 150;
	hub.broadcast = () => {}; // silence for this segment
	const p1 = hub.compactSession(G, { keepRecentTokens: 100 });
	await new Promise((r2) => setTimeout(r2, 30)); // let it set entry.compacting
	try { await hub.compactSession(G, { keepRecentTokens: 100 }); check("double compact rejected", false); } catch (e) { check("double compact rejected", /already in progress/.test(e.message)); }
	const pr = await hub.prompt(G, "hello during compaction").catch((e) => ({ accepted: false, reason: e.message }));
	check("prompt rejected while compacting", pr?.accepted === false && /compaction/.test(pr?.reason || ""), JSON.stringify(pr));
	await p1.catch(() => {});
	summarizeDelay = 0;
	hub.broadcast = origBroadcast;
}

console.log(`\n${pass} check(s) passed${process.exitCode ? " (WITH FAILURES)" : ""}`);
