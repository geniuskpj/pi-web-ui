// peer-store.test.mjs — the CLIENT's peer reducer (plan-subagents.md M3).
//
// The strip and the panel both read this one list, fed by a socket that can deliver a delta before the
// snapshot, or a stale progress frame after a stop. The merge rules are therefore the part worth
// pinning: newest first, upsert by id, and a TERMINAL status can never be resurrected by a late delta
// (the UI must not show a peer as running after the user stopped it).
//
// Usage: node tests/peer-store.test.mjs
import { applyPeer, applyPeers, sortPeers, runningCount, peerLabel, peerTone, EMPTY_BUDGET } from "../src/ui/peer-store.ts";

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
	if (cond) { pass++; console.log(`  ✓ ${name}`); }
	else { fail++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};
const peer = (id, extra = {}) => ({ id, role: "reviewer", model: "faux/faux-1", status: "running", startedAt: 1000, elapsedMs: 0, ...extra });

// ── snapshot ───────────────────────────────────────────────────────────────
{
	const snap = applyPeers([], [peer("a", { startedAt: 100 }), peer("b", { startedAt: 300 }), peer("c", { startedAt: 200 })]);
	check("S1 a snapshot is sorted newest-first (the strip reads top-down)", snap.map((p) => p.id).join("") === "bca", snap.map((p) => p.id).join(""));
	check("S2 a snapshot REPLACES the list (the server is the source of truth)", applyPeers(snap, [peer("z")]).length === 1);
	check("S3 junk is ignored instead of crashing the strip (a null list keeps the current view)", applyPeers(snap, null).length === 3);
	check("S3b …and junk ENTRIES are filtered out of a snapshot", applyPeers(snap, [null, { noId: true }, peer("k")]).length === 1);
	check("S4 sortPeers is stable for equal timestamps", sortPeers([peer("b"), peer("a")]).map((p) => p.id).join("") === "ab");
}

// ── deltas ─────────────────────────────────────────────────────────────────
{
	let list = applyPeers([], [peer("a")]);
	list = applyPeer(list, peer("a", { status: "running", currentTool: "bash", lastText: "working" }));
	check("D1 a delta updates fields in place (no duplicate chip)", list.length === 1 && list[0].currentTool === "bash" && list[0].lastText === "working");
	list = applyPeer(list, peer("b", { startedAt: 5 }));
	check("D2 a delta for an unknown peer is ADDED (a snapshot may have been missed on a reconnect)", list.length === 2);
	check("D3 an unknown id is ignored", applyPeer(list, null).length === 2 && applyPeer(list, { id: 7 }).length === 2);
}
{
	// the important one: a late progress frame must not resurrect a stopped peer
	let list = applyPeers([], [peer("a")]);
	list = applyPeer(list, peer("a", { status: "aborted", error: "stopped by the user" }));
	list = applyPeer(list, peer("a", { status: "running", lastText: "still here?" }));
	check("D4 a TERMINAL status wins over a later `running` delta (no zombie chip)",
		list[0].status === "aborted" && list[0].lastText === "still here?", list[0].status);
	list = applyPeer(list, peer("a", { status: "error", error: "boom" }));
	check("D5 …but a terminal→terminal update still lands (error replaces aborted)", list[0].status === "error" && list[0].error === "boom");
	list = applyPeer(list, peer("a", { status: "running" }));
	check("D6 and it can never leave the terminal state again", list[0].status === "error");
}

// ── the strip's derived values ─────────────────────────────────────────────
{
	const peers = [peer("a"), peer("b", { status: "idle", startedAt: 0, endedAt: 5000 }), peer("c", { status: "error" })];
	check("V1 runningCount counts only running peers (the badge)", runningCount(peers) === 1);
	check("V2 the label is role · status · elapsed", peerLabel(peers[0], 6000) === "reviewer · running · 5s", peerLabel(peers[0], 6000));
	check("V3 …and switches to m/s past a minute", peerLabel(peer("x", { startedAt: 0 }), 95_000) === "reviewer · running · 1m35s", peerLabel(peer("x", { startedAt: 0 }), 95_000));
	check("V4 a finished peer's elapsed FREEZES (it does not keep ticking)", peerLabel(peers[1], 999_999) === "reviewer · idle · 5s", peerLabel(peers[1], 999_999));
	check("V5 the live tool is part of the label", peerLabel(peer("t", { currentTool: "edit" }), 1000).includes("edit"));
	check("V6 tones map to the CSS classes the stylesheet defines",
		peerTone("running") === "run" && peerTone("idle") === "ok" && peerTone("error") === "bad" && peerTone("timeout") === "bad" &&
		peerTone("aborted") === "gone" && peerTone("needs_result") === "gone");
	check("V7 the default budget is a real object (the strip can render it before any frame)", EMPTY_BUDGET.spawns === 0 && typeof EMPTY_BUDGET.concurrent === "number");
	check("V8 a missing role/id never produces an empty label", peerLabel({ id: "x", status: "idle", startedAt: 0 }, 1000).startsWith("peer · idle"), peerLabel({ id: "x", status: "idle", startedAt: 0 }, 1000));
}

console.log(`\n[peer-store] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
