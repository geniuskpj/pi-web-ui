// versions.test.mjs — edit-with-versions (user design 2026-10-23):
// "save delta jsonl with some id" — every ✎ edit parks the removed tail as a
// delta record (vid/turn/firstId/count + messages) in a per-session sidecar;
// restore swaps the tail back and captures the replaced one first, so version
// switching is LOSSLESS in both directions.
//
// Coverage:
//   1. rewrite(older message) captures a version delta: vid monotonic, turn =
//      cut index, count = removed length; active shrinks to the prefix
//   2. restore swaps the tail back (content identical), no switch-away when
//      the active tail is empty
//   3. round trip: edit → restore original → the intermediate tail is itself
//      captured as a switch-away delta → switching back is lossless
//   4. list() returns META ONLY (no message bodies over the wire)
//   5. rewrite of the LAST message captures a 1-message version
//   6. first-message edit (turn 0) round trips from an empty prefix
//   7. restore guards: streaming / unknown vid
import assert from "node:assert/strict";
import { AgentHub } from "../agent-hub.mjs";

let pass = 0;
const check = (name, cond, detail = "") => {
	if (cond) { pass++; console.log(`  ✓ ${name}`); }
	else { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); process.exitCode = 1; }
};

const asst = (text) => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: 1 });
const user = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });

const versionStore = new Map(); // id -> records[]
const versions = {
	append: async (id, record) => {
		const list = versionStore.get(id) || [];
		const full = { ...record, vid: list.reduce((m, r) => Math.max(m, r.vid || 0), 0) + 1, at: Date.now() };
		list.push(full); versionStore.set(id, list); return full;
	},
	list: async (id) => (versionStore.get(id) || []).map(({ messages, ...meta }) => meta),
	get: async (id, vid) => (versionStore.get(id) || []).find((r) => r.vid === vid) || null,
};

const broadcasted = [];
const hub = new AgentHub({
	modelsStore: { nvidia: { name: "nvidia", models: [{ id: "m1", api: "openai-completions", provider: "nvidia", reasoning: true }] } },
	persist: async () => {},
	broadcast: (sid, msg) => broadcasted.push({ sid, msg }),
	versions,
});
const S = "versionsbase000000000000000000000";
const base = [user("q1"), asst("a1"), user("q2"), asst("a2"), user("q3"), asst("a3")];
hub.getSession(S, { messages: base.map((m) => structuredClone(m)) });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// --- 1) edit an OLDER message (turn 2): delta captured, active truncated ------
const r1 = await hub.rewriteSession(S, 2);
check("rewrite captures a version delta", r1?.ok && r1.version?.vid === 1 && r1.version?.turn === 2 && r1.version?.count === 4, JSON.stringify(r1?.version && { vid: r1.version.vid, turn: r1.version.turn, count: r1.version.count }));
check("active shrinks to the prefix", hub.sessions.get(S).agent.state.messages.length === 2);
check("delta holds the removed tail verbatim", same(r1.version.messages, base.slice(2)));

// --- 2) restore v1: tail swaps back, content identical -------------------------
const r2 = await hub.restoreVersion(S, 1);
check("restore returns ok + count", r2?.ok && r2.restored === 1 && r2.count === 6, JSON.stringify(r2));
check("restored transcript is byte-identical to the original", same(hub.sessions.get(S).agent.state.messages, base));
const metas1 = await hub.listVersions(S);
check("no switch-away delta when the active tail was empty", metas1.length === 1, JSON.stringify(metas1));

// --- 3) round trip: edit → grow the tail → restore original → lossless -------
await hub.rewriteSession(S, 2); // vid 2 (same cut) — a fresh edit of the same turn
// grow the active tail (as if the user continued on the edited branch) so the
// upcoming restore has something to capture as a switch-away delta
hub.sessions.get(S).agent.state.messages.push(structuredClone(user("extra")), structuredClone(asst("extra-a")));
const r3 = await hub.restoreVersion(S, 1); // bring the ORIGINAL tail back
check("switch-away delta captured the grown tail", (await hub.listVersions(S)).some((v) => v.reason?.startsWith("switch-away") && v.turn === 2 && v.count === 2));
check("restored-original content identical again", same(hub.sessions.get(S).agent.state.messages, base));
check("intermediate tail still restorable (lossless)", (await hub.versions.get(S, 2))?.messages?.length === 4);
const switchAway = (await hub.listVersions(S)).find((v) => v.reason?.startsWith("switch-away"));
check("grown tail itself captured (restorable)", switchAway && (await hub.versions.get(S, switchAway.vid))?.messages?.length === 2);
const before = structuredClone(base.slice(0, 2));
check("prefix unchanged by all the switching", same(hub.sessions.get(S).agent.state.messages.slice(0, 2), before));

// --- 4) list is meta-only ------------------------------------------------------
const metas2 = await hub.listVersions(S);
check("list carries meta only (no messages key)", metas2.every((v) => !("messages" in v) && typeof v.vid === "number" && typeof v.turn === "number"));

// --- 5) edit of the LAST message captures a 1-message version ------------------
const n0 = hub.sessions.get(S).agent.state.messages.length;
const r5 = await hub.rewriteSession(S, n0 - 1);
check("last-message edit → 1-message delta", r5?.version?.count === 1 && r5.version.turn === n0 - 1, JSON.stringify(r5?.version && { turn: r5.version.turn, count: r5.version.count }));

// --- 6) first-message edit (turn 0) round trips --------------------------------
await hub.rewriteSession(S, 0);
check("first-message edit → turn 0 delta, empty active", (await hub.listVersions(S)).some((v) => v.turn === 0) && hub.sessions.get(S).agent.state.messages.length === 0);
const lastVid = Math.max(...(await hub.listVersions(S)).map((v) => v.vid));
await hub.restoreVersion(S, lastVid); // the most recent delta — splice from empty prefix
check("restore from empty prefix works", hub.sessions.get(S).agent.state.messages.length > 0);

// --- 7) guards ------------------------------------------------------------------
const entry = hub.sessions.get(S);
entry.agent.state.isStreaming = true;
let threw = "";
try { await hub.rewriteSession(S, 1); } catch (e) { threw = e.message; }
check("rewrite rejects while streaming", /streaming/.test(threw));
threw = "";
try { await hub.restoreVersion(S, 1); } catch (e) { threw = e.message; }
check("restore rejects while streaming", /streaming/.test(threw));
entry.agent.state.isStreaming = false;
threw = "";
try { await hub.restoreVersion(S, 999); } catch (e) { threw = e.message; }
check("restore rejects unknown vid", /not found/.test(threw));

console.log(`[versions] ${pass} check(s) passed`);
