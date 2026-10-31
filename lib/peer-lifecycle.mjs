// peer-lifecycle.mjs — the bookkeeping a peer needs to be TRUTHFUL and BOUNDED.
//
// Two problems this module exists to solve (grok design review 2026-10-31, P0-2 and P1-5):
//
//   1. STATUS must survive a restart. In-memory runtime frames cannot answer "is this child still
//      running?" after the process died — the parent would show a phantom "running" peer forever, and
//      the transcript would keep a tool call that never gets a result. So every spawn writes a journal
//      entry (`peer_started`), every terminal state writes another (`peer_ended`/`peer_error`), the
//      journal rides in the parent's session metadata, and `peerStatusOf()` is a PURE function of
//      (journal, live agents). The hub may only UPGRADE a peer to `running`, never invent it.
//
//   2. BUDGETS must be checked BEFORE an Agent is constructed — a prompt cannot be trusted to stop a
//      spawn loop, and a peer must never spawn peers. `checkPeerBudget()` is pure so the rules are
//      testable without a model.
//
// It also freezes the tool-result shape (P1-6): one row for the parent, a 32 KB cap on the UTF-8
// `summary` ONLY (a truncated failure would make the parent retry blindly), and the structured fields
// kept for the UI.

import { PEER_LIMITS, MUTATING_TOOLS } from "./peer-roles.mjs";

export { PEER_LIMITS };

export const PEER_STATUSES = ["running", "idle", "error", "aborted", "timeout", "needs_result"];
export const TERMINAL_STATUSES = ["idle", "error", "aborted", "timeout"];
/** The TOOL-RESULT vocabulary is its own set: a finished peer is "ok", a live one is never a result. */
export const RESULT_STATUSES = ["ok", "error", "aborted", "timeout"];

/** The frozen tool-result schema (D12). Every field is always present. */
export const PEER_RESULT_FIELDS = ["status", "sessionId", "role", "model", "usage", "error", "summary", "truncated"];

// ─────────────────────────────────────────────────────────── the journal

/** One spawn. `at` is injected by the caller so tests can pin time. */
export function peerStarted({ id, role, model, task = "", parentSession = null, at = Date.now() }) {
	return { peerId: id, role, model: model || null, parentSession, status: "running", startedAt: at, endedAt: null, taskPreview: preview(task), error: null };
}

/** A terminal entry. `status` must be one of TERMINAL_STATUSES. */
export function peerEnded(entry, { status = "idle", error = null, at = Date.now(), usage = null, turns = 0 } = {}) {
	if (!TERMINAL_STATUSES.includes(status)) throw new Error(`peerEnded: bad status "${status}"`);
	return { ...entry, status, error: error || null, endedAt: at, usage, turns };
}

/** Append an entry to a journal, keeping it bounded (newest last, oldest dropped). */
export function appendJournal(journal, entry, { keep = PEER_LIMITS.journalKeep } = {}) {
	const next = [...(Array.isArray(journal) ? journal : []), entry];
	return next.length > keep ? next.slice(next.length - keep) : next;
}

export function findPeer(journal, peerId) {
	return (Array.isArray(journal) ? journal : []).find((p) => p?.peerId === peerId) || null;
}

/**
 * THE status function. `liveIds` = peers the hub currently has an Agent for.
 *   * a live agent wins (the hub may upgrade to `running`, never invent a peer)
 *   * otherwise the journal's terminal state decides
 *   * a spawn with no terminal entry and no live agent = `needs_result`: the process died mid-run and
 *     the parent's transcript still needs an answer (see `danglingSpawns` + the boot reconcile)
 */
export function peerStatusOf(peer, { liveIds = [] } = {}) {
	if (!peer) return null;
	const live = liveIds instanceof Set ? liveIds.has(peer.peerId) : Array.from(liveIds).includes(peer.peerId);
	if (live) return "running";
	if (peer.endedAt && TERMINAL_STATUSES.includes(peer.status)) return peer.status;
	return "needs_result";
}

/** Spawns that never finished AND have no live agent: the boot reconcile turns these into results. */
export function danglingSpawns(journal, { liveIds = [] } = {}) {
	const live = liveIds instanceof Set ? liveIds : new Set(liveIds);
	return (Array.isArray(journal) ? journal : []).filter((p) => p && !p.endedAt && !live.has(p.peerId));
}

/** The snapshot the client renders: status resolved, elapsed/turn/usage attached. */
export function peerView(peer, { liveIds = [], now = Date.now(), extra = {} } = {}) {
	const status = peerStatusOf(peer, { liveIds });
	return {
		id: peer.peerId,
		role: peer.role,
		model: peer.model || null,
		status,
		startedAt: peer.startedAt || null,
		endedAt: peer.endedAt || null,
		elapsedMs: peer.startedAt ? Math.max(0, (peer.endedAt || now) - peer.startedAt) : 0,
		turns: peer.turns || 0,
		usage: peer.usage || null,
		error: peer.error || null,
		taskPreview: peer.taskPreview || "",
		...extra,
	};
}

// ─────────────────────────────────────────────────────────── budgets

/**
 * May this spawn happen? Pure. `state`:
 *   { depth, livePerParent, liveGlobal, spawnsPerParent, turns, tokens }
 * Returns `{ ok, reason }` — the caller turns a refusal into a terminal ERROR tool result (never a
 * hang, never a silent downgrade to a generalist).
 */
export function checkPeerBudget(state = {}, limits = PEER_LIMITS) {
	const s = {
		depth: Number(state.depth ?? 0),
		livePerParent: Number(state.livePerParent ?? 0),
		liveGlobal: Number(state.liveGlobal ?? 0),
		spawnsPerParent: Number(state.spawnsPerParent ?? 0),
		turns: Number(state.turns ?? 0),
		tokens: Number(state.tokens ?? 0),
	};
	if (s.depth >= limits.maxDepth) return { ok: false, reason: `peers cannot spawn peers (max depth ${limits.maxDepth})` };
	if (s.livePerParent >= limits.maxConcurrentPerParent) return { ok: false, reason: `this session already has ${s.livePerParent} running peers (max ${limits.maxConcurrentPerParent})` };
	if (s.liveGlobal >= limits.maxConcurrentGlobal) return { ok: false, reason: `the server already runs ${s.liveGlobal} peers (max ${limits.maxConcurrentGlobal})` };
	if (s.spawnsPerParent >= limits.maxSpawnsPerParent) return { ok: false, reason: `spawn budget exhausted (${s.spawnsPerParent}/${limits.maxSpawnsPerParent}); ask the user before delegating again` };
	return { ok: true, reason: null };
}

/** Per-turn/token ceiling for a RUNNING child (checked on every turn, not only at spawn). */
export function checkPeerRunBudget({ turns = 0, tokens = 0 } = {}, limits = PEER_LIMITS) {
	if (turns > limits.maxChildTurns) return { ok: false, reason: `peer exceeded ${limits.maxChildTurns} turns` };
	if (tokens > limits.maxChildTokens) return { ok: false, reason: `peer exceeded ${limits.maxChildTokens} tokens` };
	return { ok: true, reason: null };
}

/** Remaining budget for the UI / for `subagent({action:"status"})`. */
export function remainingBudget(state = {}, limits = PEER_LIMITS) {
	return {
		spawns: Math.max(0, limits.maxSpawnsPerParent - Number(state.spawnsPerParent ?? 0)),
		concurrent: Math.max(0, limits.maxConcurrentPerParent - Number(state.livePerParent ?? 0)),
		concurrentGlobal: Math.max(0, limits.maxConcurrentGlobal - Number(state.liveGlobal ?? 0)),
	};
}

// ─────────────────────────────────────────────────────────── the tool result

/**
 * Cut a string to `maxBytes` UTF-8 bytes on a character boundary (never mid-codepoint), keeping the
 * TAIL (a child's conclusion matters more than its first paragraph) and marking the cut explicitly.
 */
export function truncateUtf8(text, maxBytes = PEER_LIMITS.summaryBytes) {
	const s = String(text ?? "");
	const total = Buffer.byteLength(s, "utf8");
	if (total <= maxBytes) return { text: s, truncated: false };
	const marker = `\n\n… [truncated: ${total - maxBytes} of ${total} bytes elided — the full report is in the peer session transcript] …\n\n`;
	const budget = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"));
	// keep the tail: walk back from the end until it fits, then snap off any split codepoint
	const tail = Buffer.from(s, "utf8").subarray(Buffer.byteLength(s, "utf8") - budget).toString("utf8").replace(/^\uFFFD/, "");
	return { text: `…${marker}${tail}`, truncated: true };
}

/** The frozen result object. Unknown fields are dropped on purpose (the schema is the contract). */
export function buildPeerResult({ status, sessionId = null, role = null, model = null, usage = null, error = null, summary = "", truncated = false } = {}) {
	return {
		status: RESULT_STATUSES.includes(status) ? status : "error",
		sessionId,
		role,
		model,
		usage: usage ? { input: Number(usage.input) || 0, output: Number(usage.output) || 0, cost: Number(usage.cost) || 0 } : { input: 0, output: 0, cost: 0 },
		error: error ? String(error) : null,
		summary: String(summary ?? ""),
		truncated: !!truncated,
	};
}

/** The result → the ONE text block the parent model sees (plus the fields as tool `details`). */
export function resultText(result, { limits = PEER_LIMITS } = {}) {
	const r = result;
	if (r.status !== "ok") {
		// a failure is NEVER truncated: the parent must see the reason to decide what to do next
		return `peer (${r.role || "?"}) ${r.status}${r.error ? `: ${r.error}` : ""}${r.sessionId ? `\nsession: ${r.sessionId} (open it to see what the peer did)` : ""}`;
	}
	const { text, truncated } = truncateUtf8(r.summary, limits.summaryBytes);
	const head = `peer (${r.role || "?"}${r.model ? ` · ${r.model}` : ""}) finished — ${r.usage.input + r.usage.output} tokens`;
	return `${head}\nsession: ${r.sessionId}\n\n${text}${truncated ? "" : ""}`;
}

function preview(text, max = 180) {
	const s = String(text ?? "").replace(/\s+/g, " ").trim();
	return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Does this tool name mutate the machine? (used by the read-only role floor + tests) */
export const isMutatingTool = (name) => MUTATING_TOOLS.includes(String(name));
