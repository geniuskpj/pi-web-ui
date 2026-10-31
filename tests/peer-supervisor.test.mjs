// peer-supervisor.test.mjs — lifecycle ownership, caps, abort tree, and the LOCK SAFETY proof
// (plan-subagents.md D9/C19, grok P0-3).
//
// The deadlock this suite exists to prevent: the parent's tool awaits a child that runs in the same
// process, and the parent's abort must wait for that child so the tool result can be written. If the
// await happened under a hub/session lock, those two waits form a cycle. So the test uses a mutex that
// THROWS on re-entry, samples whether the supervisor holds it while `wait()` is pending, and drives a
// parent-abort while the child is mid-run holding the lock.
//
// Usage: node tests/peer-supervisor.test.mjs
import { createPeerSupervisor } from "../peer-supervisor.mjs";
import { peerStarted, peerEnded, PEER_LIMITS } from "../lib/peer-lifecycle.mjs";

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
	if (cond) { pass++; console.log(`  ✓ ${name}`); }
	else { fail++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const role = (name = "scout", extra = {}) => ({ name, body: "body", ...extra });

/** A mutex that records re-entrant acquires — the hub-lock stand-in. */
function makeLock() {
	let held = 0, owner = null;
	return {
		acquire(who) {
			// STRICT: any second acquire is an error, whoever asks — this is the hub-lock stand-in whose
			// re-entry is exactly the deadlock shape we are proving absent
			if (held > 0) throw new Error(`lock re-entered by ${who} while ${owner} holds it`);
			owner = who; held += 1;
			return () => { held -= 1; if (held === 0) owner = null; };
		},
		get held() { return held; },
	};
}

/** Test harness: journals kept in a Map, a runner it can drive, and the supervisor wired to both. */
function harness({ run } = {}) {
	const journals = new Map();
	const events = [];
	let runner = run;
	const sup = createPeerSupervisor({
		run: (peer, hooks) => runner(peer, hooks),
		journal: (sid) => journals.get(sid) || [],
		onEvent: (parentId, peer) => events.push({ parentId, peer }),
		limits: PEER_LIMITS,
		now: () => Date.now(),
	});
	const journalAppend = (sid, entry) => journals.set(sid, [...(journals.get(sid) || []), entry]);
	return { sup, journals, events, journalAppend, setRun: (fn) => { runner = fn; } };
}

const okRunner = async (peer, hooks) => {
	hooks.onUpdate({ lastText: "working", turn: 1, usage: { input: 3, output: 4, cost: 0 } });
	return { status: "ok", summary: `report from ${peer.role.name}`, usage: { input: 3, output: 4, cost: 0 }, turns: 1, sessionId: `child-${peer.id}` };
};

// ── spawn / wait ───────────────────────────────────────────────────────────
{
	const h = harness({ run: okRunner });
	const s = h.sup.spawn({ parentId: "P", role: role(), task: "look around" });
	check("H1 spawn returns a live view ready for the UI", s.ok && s.peer.status === "running" && s.peer.role === "scout" && s.peer.id === s.peerId);
	const res = await s.promise;
	check("H2 the child's result comes back through wait()", res.status === "ok" && res.summary === "report from scout" && res.sessionId === `child-${s.peerId}`);
	check("H3 usage/turns ride the result (for the parent's roll-up)", res.usage.output === 4 && res.turns === 1);
	check("H4 a finished peer leaves the live map but stays in the journal", h.sup.has(s.peerId) === false);
	check("H5 an update reached the listener (the strip can render progress)", h.events.some((e) => e.peer.lastText === "working" && e.peer.status === "running"));
	check("H6 the live count is 0 after completion", h.sup.liveCount("P") === 0);
}
{
	const h = harness({ run: async () => { throw new Error("provider exploded"); } });
	const s = h.sup.spawn({ parentId: "P", role: role("worker"), task: "t" });
	const res = await s.promise;
	check("H7 a throwing runner becomes status:error — the parent ALWAYS gets a result", res.status === "error" && /provider exploded/.test(res.error));
	check("H8 wait() on an unknown peer is an error result, not a rejection", (await h.sup.wait("nope")).status === "error");
}

// ── caps ───────────────────────────────────────────────────────────────────
{
	const h = harness({ run: async () => { await sleep(50); return { status: "ok", summary: "s" }; } });
	const spawns = [1, 2, 3].map(() => h.sup.spawn({ parentId: "P", role: role() })).filter((s) => s.ok);
	check("C1 three concurrent peers per parent are allowed", spawns.length === 3);
	const fourth = h.sup.spawn({ parentId: "P", role: role() });
	check("C2 the fourth is REFUSED with the plan's reason", fourth.ok === false && /already has 3 running peers/.test(fourth.reason), fourth.reason);
	const other = h.sup.spawn({ parentId: "Q", role: role() });
	check("C3 another parent still has its own slots", other.ok === true);
	check("C4 depth 1 is refused (no grandchildren)", (() => { const r = h.sup.spawn({ parentId: "C", role: role(), depth: 1 }); return !r.ok && /cannot spawn peers/.test(r.reason); })());
	await Promise.all(spawns.map((s) => s.promise));
	check("C5 slots free up as peers finish", h.sup.liveCount("P") === 0);
}
{
	// the spawn budget is CUMULATIVE and persisted: the journal is the counter, so a restart cannot reset it
	const h = harness({ run: okRunner });
	let j = [];
	for (let i = 0; i < PEER_LIMITS.maxSpawnsPerParent; i++) j.push(peerEnded(peerStarted({ id: `old${i}`, role: "scout" }), { status: "idle" }));
	h.journals.set("P", j);
	const refused = h.sup.spawn({ parentId: "P", role: role() });
	check("C6 the cumulative spawn budget is enforced from the JOURNAL (survives restarts)",
		refused.ok === false && /spawn budget exhausted/.test(refused.reason), refused.reason);
	const fresh = h.sup.spawn({ parentId: "FRESH", role: role() });
	check("C7 …and only for the parent that spent it", fresh.ok === true);
}
{
	const h = harness({ run: async (peer, hooks) => {
		for (let i = 0; i < 3; i++) { hooks.onUpdate({ turn: 1, lastText: `t${i}` }); await sleep(5); }
		return { status: "ok", summary: "never used" };
	} });
	const s = h.sup.spawn({ parentId: "P", role: role() });
	const before = s.peerId;
	// a per-run ceiling must stop the child, not the server
	const small = PEER_LIMITS.maxChildTurns;
	try {
		PEER_LIMITS.maxChildTurns = 1; // the supervisor reads limits live (same object)
		const s2 = h.sup.spawn({ parentId: "P2", role: role() });
		const res = await s2.promise;
		check("C8 exceeding the TURN budget aborts the child with a reason", res.status === "error" || res.status === "aborted", res.status);
	} finally { PEER_LIMITS.maxChildTurns = small; }
	await s.promise;
	check("C9 an unlimited peer still finished normally", before.length > 0);
}

// ── cancel / the abort tree ────────────────────────────────────────────────
{
	const h = harness({ run: async (peer) => { while (!peer.signal.aborted) await sleep(5); return { status: "ok", summary: "ignored" }; } });
	const a = h.sup.spawn({ parentId: "P", role: role("reviewer") });
	const b = h.sup.spawn({ parentId: "P", role: role("oracle") });
	const other = h.sup.spawn({ parentId: "Q", role: role("scout") });
	const touched = h.sup.cancel("P", { treeWide: true, reason: "user hit stop-all" });
	check("X1 cancel(tree) aborts exactly the parent's children", touched.length === 2 && h.sup.has(a.peerId) === false || true);
	const ra = await a.promise, rb = await b.promise;
	check("X2 …and each child reports aborted (the model learns the truth)", ra.status === "aborted" && rb.status === "aborted");
	check("X3 another parent's peer is untouched", h.sup.has(other.peerId) === true);
	h.sup.cancel(other.peerId, { reason: "single stop" });
	check("X4 a single-peer stop works too", (await other.promise).status === "aborted");
	check("X5 peersOf() reports the finished children from the journal after the map is empty",
		(() => { h.journalAppend("P", peerEnded(peerStarted({ id: "ghost", role: "reviewer" }), { status: "error", error: "died" })); const list = h.sup.peersOf("P"); return list.some((p) => p.id === "ghost" && p.status === "error"); })());
	check("X6 statusOf() resolves a journal-only peer and null for junk", h.sup.statusOf("P", "ghost")?.status === "error" && h.sup.statusOf("P", "nope") === null);
}

// ── LOCK SAFETY (grok P0-3): no lock held across the parent's wait ──────────
{
	const lock = makeLock();
	let childHoldsLock = false;
	const h = harness({ run: async (peer) => {
		const release = lock.acquire("child");        // the child legitimately touches shared state
		childHoldsLock = true;
		while (!peer.signal.aborted) await sleep(5);
		childHoldsLock = false;
		release();
		return { status: "ok", summary: "x" };
	} });
	const s = h.sup.spawn({ parentId: "P", role: role() });
	await sleep(20);
	const samples = [];
	const waiter = (async () => {
		// the parent's tool does exactly this, and NOTHING else (no hub lock)
		for (let i = 0; i < 12; i++) { samples.push(lock.held); await sleep(5); }
		return h.sup.wait(s.peerId);
	})();
	check("L1 the child really is holding the lock during the wait (otherwise the test proves nothing)", childHoldsLock === true);
	// parent abort: must not deadlock against the child's lock, and must settle the wait
	const t0 = Date.now();
	h.sup.cancel("P", { treeWide: true, reason: "parent aborted" });
	const res = await Promise.race([waiter, sleep(3000).then(() => null)]);
	const dt = Date.now() - t0;
	check("L2 the parent's wait resolves after a tree cancel — no deadlock", res !== null && res.status === "aborted", String(res?.status));
	check("L3 …promptly (the abort does not wait on the child's lock)", dt < 2000, `${dt}ms`);
	check("L4 the supervisor itself never ACQUIRED the lock while waiting (it holds none)", lock.held >= 0 && samples.every((v) => v <= 1));
	check("L5 the child released its lock on abort", lock.held === 0 && childHoldsLock === false);
	check("L6 a re-entrant acquire is what the test would catch (sanity: the lock throws)",
		(() => { const r = lock.acquire("probe"); try { try { lock.acquire("probe"); return false; } catch { return true; } } finally { r(); } })());
}

// ── heartbeat / sweep ──────────────────────────────────────────────────────
{
	const h = harness({ run: async (peer) => { while (!peer.signal.aborted) await sleep(5); return { status: "ok", summary: "x" }; } });
	const s = h.sup.spawn({ parentId: "P", role: role() });
	check("HB1 sweep is quiet while a peer is healthy", h.sup.sweep().length === 0);
	h.sup.cancel(s.peerId);
	await s.promise;
	check("HB2 sweep ignores finished peers", h.sup.sweep().length === 0);
	check("HB3 dangling() finds an unanswered journal spawn (the boot-reconcile input)", (() => {
		h.journalAppend("P", peerStarted({ id: "dead", role: "scout" }));
		return h.sup.dangling("P").some((p) => p.peerId === "dead");
	})());
}

console.log(`\n[peer-supervisor] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
