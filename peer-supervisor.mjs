// peer-supervisor.mjs — the object that owns peer LIFECYCLE, so neither the hub nor the tool has to.
//
// Why a separate module (grok design review 2026-10-31, P0-3): the parent's `subagent` tool awaits a
// child that runs in the SAME Node process. If that await happened while any non-reentrant lock was
// held (the hub's promptLock, a session map write, a broadcast that re-enters the parent), a parent
// abort — which must wait for the child to finish so the tool result can be written — would deadlock
// against the very lock the child needs. So:
//
//   * the tool does exactly one thing: `await supervisor.wait(peerId)` — no hub lock, no session lock;
//   * the supervisor holds the child promises, the abort TREE (parent → its children), the caps and a
//     heartbeat, and knows NOTHING about locks;
//   * `run()` is injected by the hub: `(peer, { onUpdate, signal }) => Promise<{status, summary, usage,
//     turns}>`. The hub may touch its own state inside `run`, but it must not hold a lock across it;
//   * a failure is a RESULT (`status:"error"`), never a rejected promise — the parent's transcript must
//     always get a tool result, or the next provider call fails on a dangling tool call;
//   * `cancel()` aborts subtrees with a timeout, then orphans (the zombie lesson: a wedged run must not
//     keep a "running" peer forever).
//
// Tested with a fake runner and a deliberately re-entrancy-throwing lock (tests/peer-supervisor.test.mjs).

import { PEER_LIMITS, checkPeerBudget, checkPeerRunBudget, peerStarted, peerEnded, appendJournal, findPeer, peerView, peerStatusOf, danglingSpawns } from "./lib/peer-lifecycle.mjs";

const CANCEL_GRACE_MS = 5000;

export function createPeerSupervisor({ run, journal, onEvent = () => {}, limits = PEER_LIMITS, now = () => Date.now() } = {}) {
	if (typeof run !== "function") throw new Error("createPeerSupervisor needs a run()");
	if (typeof journal !== "function") throw new Error("createPeerSupervisor needs a journal() accessor");

	const records = new Map();     // peerId → record (live only)
	const settled = new Map();     // peerId → the last result (bounded): wait() must be replayable,
	                               // because a parent tool may ask again (retry, UI re-open, reconcile)
	const tree = new Map();        // peerId → parentId
	const SETTLED_KEEP = 50;
	let seq = 0;

	/** The journal for a session (the caller persists it wherever it wants). */
	const journalOf = (sessionId) => journal(sessionId) || [];

	const countLive = (parentId = null) => {
		let n = 0;
		for (const r of records.values()) if (r.status === "running" && (parentId === null || r.parentId === parentId)) n += 1;
		return n;
	};

	const emit = (parentId, peer) => { try { onEvent(parentId, peer); } catch { /* a listener must not break a run */ } };

	function spawn({ parentId, role, task, model = null, thinking = null, depth = 0, sessionFactory }) {
		const spawnsPerParent = journalOf(parentId).length; // cumulative, persisted (D8): a loop cannot reset it
		const budget = checkPeerBudget({
			depth,
			livePerParent: countLive(parentId),
			liveGlobal: countLive(null),
			spawnsPerParent,
		}, limits);
		if (!budget.ok) return { ok: false, reason: budget.reason };

		const peerId = `p${++seq}-${Math.random().toString(36).slice(2, 8)}`;
		const entry = peerStarted({ id: peerId, role: role?.name || null, model, task, parentSession: parentId, at: now() });
		const controller = new AbortController();
		const record = {
			id: peerId, parentId, role: role?.name || null, model, controller,
			status: "running", turns: 0, tokens: 0, usage: { input: 0, output: 0, cost: 0 },
			lastText: "", currentTool: null, startedAt: now(), entry, sessionId: null,
		};
		records.set(peerId, record);
		tree.set(peerId, parentId);

		const timeout = setTimeout(() => {
			record.getsTimedOut = true;
			// the wall clock is a BUDGET, not a suggestion: settle it as `timeout` even if the run hangs
			cancelOne(peerId, { reason: `peer exceeded ${Math.round(limits.maxWallClockMs / 1000)}s`, status: "timeout" });
		}, limits.maxWallClockMs);
		timeout.unref?.();

		record.promise = (async () => {
			try {
				const out = await run({ id: peerId, parentId, role, task, model, thinking, signal: controller.signal }, {
					onUpdate: (patch) => noteUpdate(peerId, patch),
					setSession: (sid) => { record.sessionId = sid; },
				});
				// A CANCELLED run's verdict wins over whatever the runner returned: a budget/stop/timeout
				// abort must not be reported as "ok" just because the child happened to finish its step
				// (grok P0-3: the model has to learn the truth, or it retries a peer that was stopped).
				const cancelled = record.cancelledAs || (controller.signal.aborted ? "aborted" : null);
				const status = cancelled || (out?.status === "ok" || !out?.status ? "ok" : out.status);
				record.status = status === "ok" ? "idle" : status;
				if (cancelled) record.error = record.cancelReason || record.error || "stopped";
				record.usage = out?.usage || record.usage;
				record.turns = out?.turns ?? record.turns;
				record.summary = out?.summary || record.summary || "";
				return { ...out, status, error: cancelled ? record.error : (out?.error ?? null), sessionId: out?.sessionId ?? record.sessionId, role: role?.name || null, model, usage: record.usage, turns: record.turns, peerId };
			} catch (err) {
				const aborted = controller.signal.aborted || !!record.cancelledAs;
				record.status = record.cancelledAs || (aborted ? "aborted" : "error");
				record.error = record.cancelReason || String(err?.message || err);
				return { status: record.status, error: record.error, sessionId: record.sessionId, role: role?.name || null, model, usage: record.usage, turns: record.turns, peerId };
			} finally {
				clearTimeout(timeout);
				if (record.status === "running") record.status = "idle";
				record.endedAt = now();
				record.result = record.result || { status: record.status === "idle" ? "ok" : record.status, error: record.error || null, sessionId: record.sessionId, role: record.role, model: record.model, usage: record.usage, turns: record.turns, peerId, summary: record.summary || "" };
				settled.set(peerId, record.result);
				while (settled.size > SETTLED_KEEP) settled.delete(settled.keys().next().value);
				records.delete(peerId); // the journal keeps the history; the map is only live peers
				tree.delete(peerId);
				emit(parentId, peerView(record.entry ? peerEnded(record.entry, { status: record.status, error: record.error || null, at: now(), usage: record.usage, turns: record.turns }) : record.entry, { liveIds: [], now: now(), extra: { id: peerId } }));
			}
		})();
		return { ok: true, peer: peerView(entry, { liveIds: [peerId], now: now(), extra: { id: peerId, currentTool: null, lastText: "" } }), promise: record.promise, peerId, signal: controller.signal, record };
	}

	function noteUpdate(peerId, patch = {}) {
		const rec = records.get(peerId);
		if (!rec) return;
		if (patch.currentTool !== undefined) rec.currentTool = patch.currentTool;
		if (patch.lastText !== undefined) rec.lastText = String(patch.lastText).slice(-400);
		if (patch.usage) { rec.usage = patch.usage; rec.tokens = (Number(patch.usage.input) || 0) + (Number(patch.usage.output) || 0); }
		if (patch.turn) rec.turns += 1;
		emit(rec.parentId, viewOf(rec));
		const runBudget = checkPeerRunBudget({ turns: rec.turns, tokens: rec.tokens }, limits);
		if (!runBudget.ok) cancelOne(peerId, { reason: runBudget.reason, status: "error" });
	}

	function viewOf(rec) {
		return {
			id: rec.id, role: rec.role, model: rec.model, status: rec.status,
			startedAt: rec.startedAt, elapsedMs: Math.max(0, now() - rec.startedAt),
			currentTool: rec.currentTool, lastText: rec.lastText, turns: rec.turns, usage: rec.usage,
			sessionId: rec.sessionId,
		};
	}

	/** Per-parent snapshot for the UI + `subagent({action:"status"})`. */
	function peersOf(parentId) {
		const live = [];
		for (const rec of records.values()) if (rec.parentId === parentId) live.push(viewOf(rec));
		// journal entries that are no longer live (finished, or dangling after a restart)
		const liveIds = new Set(live.map((p) => p.id));
		const done = journalOf(parentId)
			.filter((e) => !liveIds.has(e.peerId))
			.map((e) => peerView(e, { liveIds: [], now: now() }));
		return [...live, ...done].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
	}

	function statusOf(parentId, peerId) {
		const rec = records.get(peerId);
		if (rec) return viewOf(rec);
		const entry = findPeer(journalOf(parentId), peerId);
		return entry ? peerView(entry, { liveIds: [], now: now() }) : null;
	}

	/** Cancel one peer (or a whole subtree). Returns the peers it touched. */
	function cancelOne(peerId, { reason = "stopped by the user", status = "aborted" } = {}) {
		const rec = records.get(peerId);
		if (!rec) return [];
		rec.cancelReason = reason;
		rec.cancelledAs = status;
		try { rec.controller.abort(reason); } catch { /* already aborted */ }
		return [peerId];
	}

	function cancel(parentIdOrPeerId, { treeWide = false, reason = "stopped by the user", status = "aborted" } = {}) {
		const touched = [];
		for (const [peerId, parentId] of tree) {
			if (treeWide ? parentId === parentIdOrPeerId : peerId === parentIdOrPeerId) touched.push(...cancelOne(peerId, { reason, status }));
		}
		return touched;
	}

	async function wait(peerId, parentId = null) {
		const rec = records.get(peerId);
		if (rec) return await rec.promise;
		// already finished in this process: the tool may be asked again (retry, a second client, the
		// boot reconcile) and must get the SAME verdict, not "unknown peer"
		const done = settled.get(peerId);
		if (done) return { ...done };
		// never seen here but present in the journal (a previous process): report its terminal state.
		// The caller names the parent, because a journal is looked up by session id.
		for (const pid of parentId ? [parentId] : parentIndex()) {
			const entry = findPeer(journalOf(pid), peerId);
			if (entry) {
				const status = peerStatusOf(entry, { liveIds: [] });
				return {
					status: status === "idle" ? "ok" : status === "needs_result" ? "aborted" : status,
					error: entry.error || (status === "needs_result" ? "the server restarted while this peer was running" : null),
					sessionId: null, role: entry.role, model: entry.model, usage: entry.usage || { input: 0, output: 0, cost: 0 }, turns: entry.turns || 0, peerId, summary: "",
				};
			}
		}
		return { status: "error", error: "unknown peer", peerId, usage: { input: 0, output: 0, cost: 0 } };
	}

	/** Parent ids known to THIS process (live records + the abort tree) — wait()'s best-effort index. */
	function parentIndex() {
		const ids = new Set([...tree.values()]);
		for (const rec of records.values()) ids.add(rec.parentId);
		return [...ids];
	}

	/** Heartbeat: settle anything that claims to run with no live record (the zombie lesson). */
	function sweep() {
		const settled = [];
		for (const rec of records.values()) {
			if (rec.status !== "running") continue;
			if (rec.signal?.aborted) settled.push(rec.id);
		}
		return settled;
	}

	return {
		spawn, wait, cancel, peersOf, statusOf, noteUpdate, sweep,
		limits,
		liveCount: countLive,
		has: (peerId) => records.has(peerId),
		parentOf: (peerId) => tree.get(peerId) ?? null,
		dangling: (parentId) => danglingSpawns(journalOf(parentId), { liveIds: [...records.keys()] }),
	};
}

export { PEER_LIMITS, CANCEL_GRACE_MS };
