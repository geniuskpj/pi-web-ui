// range.test.mjs — tail-first cache server machinery (transfer plan 2026-10-24):
// rewriteSeq/rewrittenFrom tracking (the client's IDB chunk invalidation key),
// getRange slices from the LIVE entry, and the invalidation matrix:
//   append            → epoch unchanged, chunks all survive
//   ✎ edit at i       → rewrittenFrom = i  (chunks strictly below i survive)
//   restoreVersion@i  → same as edit-at-i
//   retry tail-drop   → rewrittenFrom = post-drop length
//   compact           → rewrittenFrom = 0 (everything invalid)
//   metadata          → rewriteSeq/rewrittenFrom persist (cache survives restarts)
import assert from "node:assert/strict";
import { AgentHub } from "../agent-hub.mjs";
import { registerFauxProvider, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/compat";

let pass = 0;
const check = (name, cond, detail = "") => {
	if (cond) { pass++; console.log(`  ✓ ${name}`); }
	else { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); process.exitCode = 1; }
};
const user = (t) => ({ role: "user", content: [{ type: "text", text: t }], timestamp: 1 });
const asst = (t) => ({ role: "assistant", content: [{ type: "text", text: t }], stopReason: "stop", timestamp: 1 });

function makeHub() {
	const faux = registerFauxProvider({ api: "faux", provider: "faux", models: [{ id: "faux-1", reasoning: false, input: ["text", "image"] }] });
	const persisted = new Map();
	const versionStore = new Map();
	const vstore = {
		append: async (id, record) => {
			const list = versionStore.get(id) || [];
			const full = { ...record, vid: list.reduce((m, r) => Math.max(m, r.vid || 0), 0) + 1, at: Date.now() };
			list.push(full); versionStore.set(id, list); return full;
		},
		list: async (id) => (versionStore.get(id) || []).map(({ messages, ...meta }) => meta),
		get: async (id, vid) => (versionStore.get(id) || []).find((r) => r.vid === vid) || null,
	};
	const hub = new AgentHub({
		modelsStore: { faux: { name: "faux", models: [faux.getModel("faux-1")] } },
		getAuth: () => ({ faux: { key: "test-key" } }),
		persist: async (id, content) => { persisted.set(id, content); },
		broadcast: () => {},
		getTools: () => [],
		versions: vstore,
	});
	return { hub, faux, persisted };
}
const S = "rangetest00000000000000000000001";

// --- 1) getRange slices the LIVE entry, clamps, reports identity -------------
{
	const { hub } = makeHub();
	hub.getSession(S, { messages: [user("q1"), asst("a1"), user("q2"), asst("a2"), user("q3"), asst("a3")] });
	const r = hub.getRange(S, { fromSeq: 2, toSeq: 4 });
	check("range slice [2,4)", r.fromSeq === 2 && r.toSeq === 4 && r.messages.length === 2 && r.messages[0].content[0].text === "q2", JSON.stringify(r.messages?.map((m) => m.content?.[0]?.text)));
	const r2 = hub.getRange(S, { fromSeq: 4 });
	check("open toSeq clamps to messageCount", r2.toSeq === 6 && r2.messages.length === 2);
	check("identity: fresh entry rewriteSeq=0, rewrittenFrom = MAX (everything stable)", r.rewriteSeq === 0 && r.rewrittenFrom >= r.messageCount);
	check("messageCount", r.messageCount === 6);
	const tail = hub.getRange(S, { fromSeq: 999 });
	check("fromSeq beyond the end clamps to empty", tail.fromSeq === 6 && tail.toSeq === 6 && tail.messages.length === 0);
}

// --- 2) edit at i: rewrittenFrom = i, rewriteSeq bumps, prefix stays stable --
{
	const { hub } = makeHub();
	hub.getSession(S, { messages: [user("q1"), asst("a1"), user("q2"), asst("a2"), user("q3"), asst("a3")] });
	hub.sessions.get(S).agent.prompt = async (content) => { hub.sessions.get(S).agent.state.messages.push(user(content)); return { accepted: true }; };
	const before = hub.getRange(S, { fromSeq: 0, toSeq: 2 });
	await hub.editCommit(S, 4, "edited q3");
	const r = hub.getRange(S, { fromSeq: 0, toSeq: 4 });
	check("edit@4 → rewrittenFrom=4, rewriteSeq=1", r.rewrittenFrom === 4 && r.rewriteSeq === 1, JSON.stringify({ rs: r.rewriteSeq, rf: r.rewrittenFrom }));
	check("prefix [0,4) UNCHANGED after the edit (chunks below i survive)", JSON.stringify(before.messages) === JSON.stringify(hub.getRange(S, { fromSeq: 0, toSeq: 2 }).messages));
	const r2 = hub.getRange(S, { fromSeq: 0, toSeq: 2 });
	check("second, LATER edit keeps rewrittenFrom conservative (min)", (await hub.editCommit(S, 2, "edited q2"), hub.getRange(S, { fromSeq: 0 }).rewrittenFrom === 2));
}

// --- 3) retry tail-drop: rewrittenFrom = post-drop length --------------------
{
	const { hub } = makeHub();
	hub.getSession(S, {
		messages: [
			user("run"),
			{ role: "assistant", content: [{ type: "text", text: "" }], stopReason: "error", errorMessage: "429", timestamp: 2 },
		],
	});
	const dropped = hub._dropFailedTail(hub.sessions.get(S));
	check("retry drop bumps rewrittenFrom = post-drop length", dropped === 1 && hub.getRange(S, {}).rewrittenFrom === 1 && hub.getRange(S, {}).rewriteSeq === 1, JSON.stringify(hub.getRange(S, {})));
}

// --- 4) metadata persistence + hydration (cache survives a restart) ----------
{
	const { hub, persisted } = makeHub();
	hub.getSession(S, { messages: [user("q1"), asst("a1"), user("q2"), asst("a2")] });
	await hub.editCommit(S, 2, "edited q2");
	const metaLine = (persisted.get(S) || "").split("\n")[0];
	const meta = JSON.parse(metaLine);
	check("metadata carries rewriteSeq/rewrittenFrom", meta.rewriteSeq === 1 && meta.rewrittenFrom === 2, metaLine.slice(0, 160));
	// restart: fresh hub hydrates from the persisted metadata — identity survives
	const { hub: hub2 } = makeHub();
	hub2.getSession(S, { messages: [user("q1"), asst("a1"), user("q2"), asst("a2")], rewriteSeq: meta.rewriteSeq, rewrittenFrom: meta.rewrittenFrom });
	const r = hub2.getRange(S, { fromSeq: 0 });
	check("hydration restores rewriteSeq/rewrittenFrom (cache survives restart)", r.rewriteSeq === 1 && r.rewrittenFrom === 2, JSON.stringify({ rs: r.rewriteSeq, rf: r.rewrittenFrom }));
}

// --- 5) restoreVersion: rewrittenFrom = the fork point ------------------------
{
	const { hub } = makeHub();
	hub.getSession(S, { messages: [user("q1"), asst("a1"), user("q2"), asst("a2"), user("q3"), asst("a3")] });
	hub.sessions.get(S).agent.prompt = async (content) => { hub.sessions.get(S).agent.state.messages.push(user(content)); return { accepted: true }; };
	const rw = await hub.rewriteSession(S, 4); // edit-style truncate at 4 (parks the tail)
	await hub.restoreVersion(S, rw.version.vid);
	const r = hub.getRange(S, { fromSeq: 0 });
	check("restore@4 → rewrittenFrom=4 (two rewrites: seq=2)", r.rewrittenFrom === 4 && r.rewriteSeq === 2, JSON.stringify({ rs: r.rewriteSeq, rf: r.rewrittenFrom }));
}

// --- 6) compact: rewrittenFrom = 0 (invalidate everything) --------------------
{
	const { hub } = makeHub();
	const big = [];
	for (let i = 0; i < 30; i++) big.push(user("q" + i), asst("a" + i));
	hub.getSession(S, { messages: big });
	hub.summarize = async () => "## summary";
	await hub.compactSession(S, { keepRecentTokens: 10 });
	const r = hub.getRange(S, { fromSeq: 0 });
	check("compact → rewrittenFrom=0 (all cached chunks invalid)", r.rewrittenFrom === 0, JSON.stringify(r.rewrittenFrom));
}

console.log(`\n[range] ${pass} passed`);
process.exit(process.exitCode ? 1 : 0);
