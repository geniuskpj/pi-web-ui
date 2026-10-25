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

// ─────────────────────────────────────────────────────────────────────────────
// W. /range WINDOW PLANNING (review 2026-10-25, findings #1 + #3 — both reviewers)
//
// The handler used to inline this arithmetic, so no suite could see it. Both
// reviewers found the same two defects: the low end could snap BELOW the
// requested fromSeq (negative slice → body ≠ headers → the client spliced
// messages at the wrong seqs) and the high end could snap ABOVE the requested
// toSeq (a chunk claiming more lines than it held → dropped on every read).
// The contract tested here is the fix: fromSeq <= start <= end <= min(toSeq,count)
// and the response headers describe exactly the messages carried.
{
	const { planRangeWindow } = await import("../lib/range-window.mjs");
	const CH = 64;
	const msgs = (tx, n) => {
		const out = [];
		for (let i = 0; i < n; i++) out.push(i % 3 === 0 ? user("u" + i) : asst("a" + i));
		return out;
	};
	const plan = (o) => planRangeWindow({ messages: msgs(0, o.toSeq - o.fromSeq), ...o });

	// W1 — the reported bug: an UNALIGNED request whose window fits the 1MB cap.
	//      start must never fall below fromSeq (it used to snap 497 → 448).
	{
		const o = { fromSeq: 497, toSeq: 560, messageCount: 1056 };
		const { start, end } = plan(o);
		check("W1 unaligned fromSeq: start is NOT snapped below the request", start >= o.fromSeq, `start=${start} (fromSeq=${o.fromSeq})`);
		check("W1 body length matches the reported window", end - start === msgs(0, o.toSeq - o.fromSeq).slice(start - o.fromSeq, end - o.fromSeq).length,
			`[${start},${end})`);
	}
	// W2 — the high end never exceeds the requested toSeq (the "chunk claims more
	//      lines than it holds" case: start=foo.toSeq=930 unaligned, count above).
	{
		const o = { fromSeq: 800, toSeq: 930, messageCount: 1056 };
		const { start, end } = plan(o);
		check("W2 alignUp never exceeds the requested toSeq", end <= o.toSeq, `end=${end} toSeq=${o.toSeq}`);
		check("W2 end >= start (never an inverted window)", end >= start, `[${start},${end})`);
	}
	// W3 — alignment IS kept when it costs nothing (an aligned request stays aligned).
	{
		const o = { fromSeq: 512, toSeq: 1024, messageCount: 1056 };
		const { start, end } = plan(o);
		check("W3 an aligned request yields an aligned window", start % CH === 0 && end % CH === 0, `[${start},${end})`);
	}
	// W4 — a partial request (fromSeq 10 into a chunk) stays honest: it may start at
	//      10, and then end must still be <= toSeq.
	{
		const o = { fromSeq: 10, toSeq: 40, messageCount: 1056 };
		const { start, end } = plan(o);
		check("W4 partial chunk request: bounds hold (10 <= start <= end <= 40)", start >= 10 && start <= end && end <= 40, `[${start},${end})`);
	}
	// W5 — the byte cap KEEPS THE HIGH END (a window too big for 1MB drops low seqs).
	{
		const heavy = Array.from({ length: 4000 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: [{ type: "text", text: "x".repeat(2000) }] }));
		const { start, end } = planRangeWindow({ messages: heavy, fromSeq: 0, toSeq: 4000, messageCount: 4000 });
		check("W5 the 1MB cap keeps the HIGH end", end === 4000 && start > 0, `[${start},${end})`);
	}
	// W6 — an empty window is expressed as start === end (the client's re <= rs bail).
	{
		const o = { fromSeq: 1000, toSeq: 1010, messageCount: 1010 };
		const { start, end } = plan(o);
		check("W6 a window at the session end is empty, not inverted", end >= start && end <= o.toSeq, `[${start},${end})`);
	}
	// W7 — property sweep over random (un)aligned windows: the invariant both
	//      reviewers' bugs violated must hold for every one of them.
	{
		let bad = 0, checked = 0;
		let seed = 12345;
		const rnd = (n) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
		for (let i = 0; i < 400; i++) {
			const count = 100 + rnd(1000);
			const fromSeq = rnd(count);
			const toSeq = Math.min(count, fromSeq + 1 + rnd(300));
			const { start, end } = planRangeWindow({ messages: msgs(0, toSeq - fromSeq), fromSeq, toSeq, messageCount: count });
			checked++;
			if (!(fromSeq <= start && start <= end && end <= Math.min(toSeq, count))) bad++;
		}
		check(`W7 invariant sweep (400 random windows): fromSeq <= start <= end <= min(toSeq,count)`, bad === 0, `${bad}/${checked} violated`);
	}
}

console.log(`\n[range] ${pass} passed`);
process.exit(process.exitCode ? 1 : 0);
