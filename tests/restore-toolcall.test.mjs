// restore-toolcall.test.mjs — regression for the post-restart 400 bug (2026-10-22).
//
// The OLD _writeSession persisted {role, content, timestamp} only, stripping
// toolResult.toolCallId. After a server restart the hub rehydrated that mirror
// and pi-ai's openai-completions converter emitted role:"tool" messages without
// tool_call_id → nvidia NIM 400 "missing field tool_call_id" on EVERY prompt,
// permanently (each failed run appended an empty assistant message that the
// retries kept replaying).
//
// Coverage:
//   1. persist→restore round-trip keeps toolCallId (full-fidelity writer)
//   2. normalizeRestoredMessages repairs an old-format mirror (ids re-linked in
//      order, toolName backfilled)
//   3. dangling toolCalls (no toolResult anywhere) are stripped — openai-
//      completions 400s on tool_calls without a following tool message too
//   4. idempotent: already-linked input passes through byte-equal
import assert from "node:assert/strict";
import { AgentHub, normalizeRestoredMessages } from "../agent-hub.mjs";

let pass = 0;
const check = (name, cond, detail = "") => {
	if (cond) { pass++; console.log(`  ✓ ${name}`); }
	else { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); process.exitCode = 1; }
};

// --- fixtures -----------------------------------------------------------------
const tc = (id, name) => ({ type: "toolCall", id, name, arguments: {} });
const fullTurn = (callId, toolName, text) => [
	{ role: "assistant", content: [{ type: "thinking", thinking: "t", thinkingSignature: "reasoning_content" }, { type: "text", text }, tc(callId, toolName)], timestamp: 1 },
	{ role: "toolResult", toolCallId: callId, toolName, content: [{ type: "text", text: "result" }], timestamp: 2 },
];
const strippedTurn = (callId, toolName, text) => fullTurn(callId, toolName, text).map((m) =>
	m.role === "toolResult" ? { role: "toolResult", content: m.content, timestamp: m.timestamp } : m);

// 1) hub persist→restore round-trip: the writer must keep toolCallId
{
	const captured = [];
	const hub = new AgentHub({
		modelsStore: { nvidia: { name: "nvidia", models: [{ id: "m1", api: "openai-completions", provider: "nvidia", reasoning: true }] } },
		persist: async (id, jsonl) => captured.push({ id, jsonl }),
	});
	const SESSION = "roundtrip0000000000000000000000";
	hub.getSession(SESSION, {
		messages: [
			{ role: "user", content: [{ type: "text", text: "run it" }], timestamp: 0 },
			...fullTurn("call-1", "bash", "running"),
		],
	});
	// force a flush through the fake persist
	hub.persistSession(SESSION, true);
	await new Promise((r) => setTimeout(r, 20));
	check("persist captured the session", captured.length === 1, `got ${captured.length}`);
	const lines = captured[0].jsonl.trim().split("\n").map((l) => JSON.parse(l));
	const tr = lines.find((m) => m.role === "toolResult");
	check("persisted toolResult keeps toolCallId", tr?.toolCallId === "call-1", JSON.stringify(tr || {}).slice(0, 120));
	check("persisted toolResult keeps toolName", tr?.toolName === "bash");
	// restore through the same path the hub uses after a restart
	hub.sessions.delete(SESSION);
	hub.getSession(SESSION, { messages: lines.slice(1) });
	const state = hub.sessions.get(SESSION).agent.state.messages;
	check("restored history re-links ids", state.some((m) => m.role === "toolResult" && m.toolCallId === "call-1"));
}

// 2) old-format mirror → normalizeRestoredMessages re-links in order
{
	const msgs = [
		{ role: "user", content: [{ type: "text", text: "q" }], timestamp: 0 },
		...strippedTurn("call-A", "read_file", "reading"),
		{ role: "user", content: [{ type: "text", text: "again" }], timestamp: 3 },
		...strippedTurn("call-B", "bash", "two calls"), // assistant with 2 toolCalls
		...strippedTurn("call-C", "bash", ""),
	];
	// strip the second turn's ids too (two toolResults after one 2-call assistant)
	const fixed = normalizeRestoredMessages(msgs);
	const ids = fixed.filter((m) => m.role === "toolResult").map((m) => m.toolCallId);
	check("re-linked all orphan ids in order", JSON.stringify(ids) === JSON.stringify(["call-A", "call-B", "call-C"]), JSON.stringify(ids));
	const names = fixed.filter((m) => m.role === "toolResult").map((m) => m.toolName);
	check("toolName backfilled from toolCall", JSON.stringify(names) === JSON.stringify(["read_file", "bash", "bash"]), JSON.stringify(names));
	// content untouched otherwise
	const asst = fixed.find((m) => m.role === "assistant" && m.content.some((b) => b.type === "text" && b.text === "two calls"));
	check("assistant content preserved", asst?.content.length === 3);
}

// 3) a toolCall with NO following toolResult is stripped (both-direction 400 guard);
//    an orphan toolResult that can't be linked (no assistant directly before it)
//    is dropped — role:"tool" without tool_call_id is itself a provider 400
{
	// call-2 is dangling: the only orphan toolResult sits directly after assistant
	// "A" (so it answers call-1), and a user message interrupts before "B"'s result
	// could ever arrive
	const fixed = normalizeRestoredMessages([
		{ role: "user", content: [{ type: "text", text: "q" }], timestamp: 0 },
		{ role: "assistant", content: [{ type: "text", text: "A" }, tc("call-1", "bash")], timestamp: 1 },
		{ role: "toolResult", content: [{ type: "text", text: "orphan answer" }], timestamp: 1.5 }, // no id
		{ role: "user", content: [{ type: "text", text: "next" }], timestamp: 2 },
		{ role: "assistant", content: [{ type: "text", text: "B" }, tc("call-2", "bash")], timestamp: 3 }, // result never followed
		{ role: "user", content: [{ type: "text", text: "after" }], timestamp: 4 },
	]);
	check("orphan consumed by nearest preceding assistant", fixed.some((m) => m.role === "toolResult" && m.toolCallId === "call-1"));
	const b = fixed.find((m) => m.role === "assistant" && Array.isArray(m.content) && m.content.some((x) => x.type === "text" && x.text === "B"));
	check("dangling toolCall stripped", b && !b.content.some((x) => x.type === "toolCall"), JSON.stringify(b?.content));
	check("no unconvertible toolResult remains", !fixed.some((m) => m.role === "toolResult" && !m.toolCallId));
	// assistant whose ONLY content was an unmatched toolCall gets placeholder text
	const fixed2 = normalizeRestoredMessages([
		{ role: "user", content: [{ type: "text", text: "q" }], timestamp: 0 },
		{ role: "assistant", content: [tc("call-Y", "bash")], timestamp: 1 }, // toolCall only
		{ role: "user", content: [{ type: "text", text: "interrupt" }], timestamp: 2 }, // orphan below can't link
		{ role: "toolResult", content: [{ type: "text", text: "orphan" }], timestamp: 3 }, // no id, no preceding assistant
	]);
	const empty = fixed2.find((m) => m.role === "assistant" && m.content?.[0]?.type === "text");
	check("emptied assistant gets placeholder text", empty?.content[0]?.text === "(tool call interrupted by error)", JSON.stringify(empty?.content));
}

// 4) idempotency + fast path
{
	const good = [
		{ role: "user", content: [{ type: "text", text: "q" }], timestamp: 0 },
		...fullTurn("call-1", "bash", "ok"),
	];
	check("linked input passes through untouched", normalizeRestoredMessages(good) === good);
	const once = normalizeRestoredMessages(strippedTurn("call-Z", "bash", "x").concat([{ role: "user", content: [{ type: "text", text: "y" }], timestamp: 5 }]));
	const twice = normalizeRestoredMessages(JSON.parse(JSON.stringify(once)));
	check("normalize is idempotent", JSON.stringify(twice) === JSON.stringify(once));
}

console.log(`\n${pass} check(s) passed${process.exitCode ? " (WITH FAILURES)" : ""}`);
