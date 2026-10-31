// peer-store.ts — the client's view of the subagents (plan-subagents.md M3).
//
// The server sends ONE snapshot (`peers`) and small deltas (`peer`); this module is the pure reducer
// that folds them into the list the strip and the panel render. Pure on purpose: the merge rules
// (upsert by id, newest first, terminal status wins over a stale delta) are the part worth testing, and
// they are the part a live socket cannot be trusted to deliver in order.
//
// Nothing here invents state: a peer the server did not mention does not exist, and the UI never flips a
// status optimistically — it renders what the echo said (plan §Status & control).

export type PeerStatus = "running" | "idle" | "error" | "aborted" | "timeout" | "needs_result";

export type Peer = {
	id: string;
	role: string | null;
	model: string | null;
	status: PeerStatus;
	startedAt: number | null;
	endedAt?: number | null;
	elapsedMs: number;
	turns?: number;
	usage?: { input: number; output: number; cost: number } | null;
	error?: string | null;
	taskPreview?: string;
	currentTool?: string | null;
	lastText?: string;
	sessionId?: string | null;
};

export type PeerBudget = { spawns: number; concurrent: number; concurrentGlobal: number };

export const EMPTY_BUDGET: PeerBudget = { spawns: 0, concurrent: 0, concurrentGlobal: 0 };

/** Newest first (the strip reads top-down), stable for equal timestamps. */
export function sortPeers(peers: Peer[]): Peer[] {
	return [...peers].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0) || String(a.id).localeCompare(String(b.id)));
}

/** Fold a snapshot in. A snapshot REPLACES the list: the server is the source of truth. */
export function applyPeers(current: Peer[], incoming: Peer[] | null | undefined): Peer[] {
	if (!Array.isArray(incoming)) return current;
	return sortPeers(incoming.filter((p) => p && typeof p.id === "string"));
}

/**
 * Fold ONE delta in. A delta for an unknown peer is ADDED (the snapshot may have been missed on a
 * reconnect); a terminal status always wins over a later running one (a late-arriving progress frame
 * must not resurrect a peer the user stopped).
 */
export function applyPeer(current: Peer[], peer: Peer | null | undefined): Peer[] {
	if (!peer || typeof peer.id !== "string") return current;
	const list = [...current];
	const i = list.findIndex((p) => p.id === peer.id);
	if (i < 0) return sortPeers([...list, peer]);
	const prev = list[i];
	const terminal = (s: PeerStatus) => s !== "running";
	const merged: Peer = { ...prev, ...peer };
	if (terminal(prev.status) && !terminal(peer.status)) merged.status = prev.status;
	list[i] = merged;
	return sortPeers(list);
}

/** How many peers are actually working (the strip's badge). */
export const runningCount = (peers: Peer[]) => peers.filter((p) => p.status === "running").length;

/** The label a chip shows: role · status · elapsed, plus the live tool when there is one. */
export function peerLabel(peer: Peer, now = Date.now()): string {
	// `||` would be wrong here: startedAt 0 (and a missing one) must fall back explicitly, or a peer that
	// started at the epoch — or a journal row without a timestamp — would render as "0s"
	const started = Number.isFinite(Number(peer.startedAt)) ? Number(peer.startedAt) : now;
	const ended = Number.isFinite(Number(peer.endedAt)) ? Number(peer.endedAt) : (peer.status === "running" ? now : started);
	const secs = Math.max(0, Math.round((ended - started) / 1000));
	const time = secs >= 60 ? `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, "0")}s` : `${secs}s`;
	const parts = [peer.role || "peer", peer.status, time];
	if (peer.currentTool) parts.push(peer.currentTool);
	return parts.join(" · ");
}

/** Status → the chip's tone (the CSS classes `.pw-peer-<tone>`). */
export function peerTone(status: PeerStatus): "run" | "ok" | "bad" | "gone" {
	if (status === "running") return "run";
	if (status === "idle") return "ok";
	if (status === "error" || status === "timeout") return "bad";
	return "gone"; // aborted / needs_result: not running, not a success
}
