/**
 * display-gate.mjs — the "display by user turn" gate, expressed in SEQ space.
 *
 * WHY (review 2026-10-25, finding #4 — MEDIUM UX): the gate used to be a raw
 * ARRAY INDEX captured when a sparse envelope arrived. But fillWindow() mutates
 * that envelope in place and PREPENDS older messages, so the index went stale the
 * moment the cache filled a prefix — and on the C4 headline path (a fully warm
 * reopen, where the attach sends an EMPTY window) the gate was computed on an
 * empty array, i.e. "show everything": the whole ~1MB window rendered, defeating
 * the user-requested one-turn view. A seq is invariant under prepends, so the
 * gate survives every fill; the index is derived per render instead.
 *
 * SCOPE (user report 2026-10-27, "Load earlier turns appeared at the first msg"
 * + "only one user turn is visible"):
 *   - a NULL gate means NO gate — small sessions (no sparse envelope) render in
 *     full. The old code turned a null gate into "the last user turn", which
 *     gated EVERY chat (hiding even the system message of a one-turn session and
 *     rendering the ⤒ button there).
 *   - the gated view shows the last N turns (settings, default 3 —
 *     `pi.turnWindow`), not exactly one: `gateSeqOfLastTurns`.
 *
 * Pure (no DOM, no state) so it can be pinned by tests/display-gate.test.mjs.
 */

/** Absolute seq of the user message that STARTS the `turns`-th newest turn
 *  (turns=1 → the last user message). When the loaded window holds fewer user
 *  messages than requested, the gate falls back to its OLDEST user message, and
 *  to the window start when it holds none at all. */
export function gateSeqOfLastTurns(messages, filledFrom, turns = 1) {
	const base = Number(filledFrom) || 0;
	const n = Math.max(1, Math.floor(Number(turns) || 1));
	const msgs = messages || [];
	let seen = 0;
	for (let i = msgs.length - 1; i >= 0; i--) {
		if (msgs[i]?.role !== "user") continue;
		seen += 1;
		if (seen === n) return base + i;
	}
	for (let i = 0; i < msgs.length; i++) {
		if (msgs[i]?.role === "user") return base + i;
	}
	return base;
}

/** Absolute seq of the LAST user message in the loaded window (`filledFrom` is the
 *  seq of messages[0]). Falls back to the window start when there is none. */
export function gateSeqOfLastUser(messages, filledFrom) {
	return gateSeqOfLastTurns(messages, filledFrom, 1);
}

/** Resolve the gate for the CURRENT window.
 *
 *  A NULL gate stays null: it means "this view is not gated" (small sessions and
 *  full state frames render everything — the gate is a large-session VIEW, never
 *  a default). A gate pointing OUTSIDE the window (the empty-window attach of a
 *  fully-warm reopen writes one, and a fill moves the window under it) is
 *  re-anchored to the last `turns` turns of what is loaded — a gate that hides
 *  EVERYTHING, or nothing at all, is never a valid view, and the attach fallback
 *  is not a user choice. A gate the user set (via ⤒ expand) always points inside
 *  the window and is therefore preserved verbatim. */
export function resolveGateSeq(gateSeq, filledFrom, messages, turns = 1) {
	const base = Number(filledFrom) || 0;
	const len = messages?.length || 0;
	if (gateSeq == null) return null;
	if (len === 0) return gateSeq;
	const idx = gateIndex(gateSeq, base, len);
	if (idx >= len) return gateSeqOfLastTurns(messages, base, turns);
	return gateSeq;
}

/** Index of the first message the gate KEEPS, for a window starting at `filledFrom`.
 *  null = no gate. Clamped to the loaded array: a gate above the window (not loaded
 *  yet) shows everything loaded, which is the only truthful thing it can do. */
export function gateIndex(gateSeq, filledFrom, len) {
	if (gateSeq == null) return null;
	const base = Number(filledFrom) || 0;
	return Math.max(0, Math.min(Number(len) || 0, Number(gateSeq) - base));
}

/** Seq of the previous user message at or below `index`, or null when the loaded
 *  window has none left (the caller then fetches an older window). */
export function prevUserSeq(messages, index, filledFrom) {
	const base = Number(filledFrom) || 0;
	for (let i = Math.min(index ?? 0, (messages?.length || 0) - 1); i >= 0; i--) {
		if (messages[i]?.role === "user") return base + i;
	}
	return null;
}
