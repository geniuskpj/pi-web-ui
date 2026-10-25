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
 * Pure (no DOM, no state) so it can be pinned by tests/display-gate.test.mjs.
 */

/** Absolute seq of the LAST user message in the loaded window (`filledFrom` is the
 *  seq of messages[0]). Falls back to the window start when there is none. */
export function gateSeqOfLastUser(messages, filledFrom) {
	const base = Number(filledFrom) || 0;
	for (let i = (messages?.length || 0) - 1; i >= 0; i--) {
		if (messages[i]?.role === "user") return base + i;
	}
	return base;
}

/** Resolve the gate for the CURRENT window.
 *
 *  A fully-warm attach (the C4 headline path) sends an EMPTY window, so at that
 *  moment the only truthful gate is "the last turn starts at the window end".
 *  Once a fill brings messages in, that fallback must be re-anchored — a gate that
 *  hides EVERYTHING is never a valid view, and a fallback is never a user choice.
 *  A gate the user actually set (via ⤒ expand) always points inside the window and
 *  is therefore preserved verbatim. */
export function resolveGateSeq(gateSeq, filledFrom, messages) {
	const base = Number(filledFrom) || 0;
	const len = messages?.length || 0;
	if (len === 0) return gateSeq ?? base;
	const idx = gateIndex(gateSeq, base, len);
	if (gateSeq == null || idx >= len) return gateSeqOfLastUser(messages, base);
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
