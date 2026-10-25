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
//   8. INLINE EDIT COMMIT (editCommit): identical text = NO version + no truncation
//      (user rule: a version exists only when a DIFFERENT message is saved);
//      different text = version delta + truncate + re-prompt via the normal path
import assert from "node:assert/strict";
import { AgentHub } from "../agent-hub.mjs";
import { makeVersionsStore } from "../lib/versions-sidecar.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
	if (cond) { pass++; console.log(`  ✓ ${name}`); }
	else { fail++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); process.exitCode = 1; }
};

const asst = (text) => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: 1 });
const user = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });

// the REAL sidecar store (tmp dir) — exercises the production append/list/get
// including the content-hash dedupe (user report 2026-10-24: every "switch to"
// click re-parked a byte-identical tail)
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-versions-test-"));
const versions = makeVersionsStore(tmpDir);

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
// vid numbering is NOT stable across a dedupe: the sidecar parks a byte-identical
		// capture ONCE (user report 2026-10-24 — every "switch to" click re-parked the
		// same tail), so the second, identical edit reuses vid 1 and the switch-away
		// capture becomes vid 2. LOSSLESSNESS is the promise; a hard-coded vid is not.
// (This check used to assert versions.get(S, 2).messages.length === 4 and had been
// failing since the dedupe landed — unseen, because the summary only counted passes.)
check("a byte-identical re-edit is deduped (no new vid)", r3 != null && (await hub.listVersions(S)).filter((m) => m.reason === "edit").length === 1,
	JSON.stringify((await hub.listVersions(S)).map((m) => `${m.vid}:${m.reason}`)));
{
	const metas = await hub.listVersions(S);
	const recs = (await Promise.all(metas.map(async (m) => ({ m, rec: await hub.versions.get(S, m.vid) })))).filter((r) => r.rec);
	const holdsEditTail = recs.some((r) => same(r.rec.messages, base.slice(2)));
	const holdsGrownTail = recs.some((r) => (r.rec.messages || []).some((m) => m.content?.[0]?.text === "extra"));
	check("intermediate tail still restorable (lossless)", holdsEditTail && holdsGrownTail,
		`records=${metas.map((m) => `${m.vid}:${m.reason}:${m.count}`).join(",")}`);
}
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

// --- 8) inline edit commit ------------------------------------------------------
hub.sessions.set(S, hub.sessions.get(S)); // entry exists from above
entry.agent.state.messages = structuredClone(base);
const promptCalls = [];
(entry.agent).prompt = async (content) => { promptCalls.push(content); entry.agent.state.messages.push(user(content)); return { accepted: true, queued: false }; }; // stub the LLM run
const versionsBefore = (await hub.listVersions(S)).length;
const rc0 = await hub.editCommit(S, 2, "  q2  ");
const versionsAfter = (await hub.listVersions(S)).length;
check("identical text (trimmed) = noop, NO version, NO truncation", rc0?.ok && rc0.noop === true && versionsAfter === versionsBefore && hub.sessions.get(S).agent.state.messages.length === 6 && promptCalls.length === 0, JSON.stringify({ rc0, versionsBefore, versionsAfter }));
const rc1 = await hub.editCommit(S, 2, "edited q2");
check("different text captures the version + truncates", rc1?.ok && rc1.version?.turn === 2 && rc1.version?.count === 4 && !rc1.noop, JSON.stringify(rc1?.version && { turn: rc1.version.turn, count: rc1.version.count }));
check("active = prefix + the edited prompt", hub.sessions.get(S).agent.state.messages.length === 3 && hub.sessions.get(S).agent.state.messages[2]?.content?.[0]?.text === "edited q2");
check("edited text went through the NORMAL prompt path", promptCalls.length === 1 && promptCalls[0] === "edited q2");
check("old tail verbatim in the delta", same(rc1.version.messages, base.slice(2)));
let threw2 = "";
try { await hub.editCommit(S, 1, "x"); } catch (e) { threw2 = e.message; } // index 1 = assistant message
check("edit-commit rejects non-user messages", /user messages/.test(threw2), threw2);

// --- 9) SWITCH DEDUPE (user report 2026-10-24) --------------------------------
// flipping between versions must not re-park byte-identical tails (live test
// d9120621: vid3 == vid1, vid4 == vid2 — one edit + switches = 2 versions max)
const S2 = "versionsdedupe000000000000000000000";
hub.getSession(S2, { messages: [user("q1"), asst("a1"), user("q2"), asst("a2"), user("q3"), asst("a3")] });
hub.sessions.get(S2).agent.prompt = async (content) => { hub.sessions.get(S2).agent.state.messages.push(user(content)); return { accepted: true, queued: false }; }; // stub the LLM run
const rd = await hub.editCommit(S2, 2, "edited q2");
check("one edit creates exactly ONE version", rd?.ok && (await versions.list(S2)).length === 1, `n=${(await versions.list(S2)).length}`);
hub.sessions.get(S2).agent.state.messages.push(asst("a1x"), user("q2y"), asst("a2y")); // the run continues (3 more turns)
await hub.restoreVersion(S2, rd.version.vid); // switch to the ORIGINAL
check("switch to original captures the live tail once", (await versions.list(S2)).length === 2, `n=${(await versions.list(S2)).length}`);
check("switched state = the original tail", same(hub.sessions.get(S2).agent.state.messages.slice(2), base.slice(2)));
const swVid = (await versions.list(S2)).map((v) => v.vid).find((v) => v !== rd.version.vid);
await hub.restoreVersion(S2, swVid); // switch BACK to the edited state
check("switch back dedupes the re-parked original (still 2 versions)", (await versions.list(S2)).length === 2, `n=${(await versions.list(S2)).length}`);
check("switched-back state = the edited tail", hub.sessions.get(S2).agent.state.messages.length === 6 && hub.sessions.get(S2).agent.state.messages[2]?.content?.[0]?.text === "edited q2");
const rn = await hub.restoreVersion(S2, swVid); // click the version we are ALREADY on
check("re-clicking the current version is a NOOP (no new version, no epoch bump)", rn?.ok && rn.noop === true && (await versions.list(S2)).length === 2, JSON.stringify(rn));
await hub.restoreVersion(S2, rd.version.vid); // flip once more
check("flip again — still exactly 2 versions", (await versions.list(S2)).length === 2, `n=${(await versions.list(S2)).length}`);

console.log(`[versions] ${pass} passed, ${fail} failed`);
