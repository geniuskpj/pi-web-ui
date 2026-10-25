/**
 * chunk-splice.mjs — PURE: what does the client actually PREPEND from the cache?
 *
 * WHY (review 2026-10-25, reviewer2 P1): getCachedChunks returns chunks WHOLE
 * (they tile [from,to) or the call returns [] — no holes), and a chunk may start
 * BELOW the requested `from` (fine: real, contiguous content) and — for chunks
 * written before the server-side bound fix — end ABOVE `to` (not fine: those
 * messages are already the top of the dense window). The old code prepended
 * everything and then recorded the REQUESTED `from` as filledFrom, so every index
 * under the splice shifted: edits landed on the wrong turn, and the render showed
 * duplicated messages. The rule: ADOPT WHAT YOU ACTUALLY SPLICED.
 *
 * Pure (no IDB, no DOM) so tests/idb-cache.test.mjs can pin it (section S).
 */

/**
 * @param {Array<{fromSeq:number,toSeq:number,messages:any[]}>} cached  tiling [from,to)
 * @param {number} from  requested low seq
 * @param {number} to    requested high seq (the dense window already starts here)
 * @returns {{fromSeq:number, messages:any[]}}  contiguous messages + the seq of messages[0]
 */
export function planCachedSplice(cached, from, to) {
	const list = (Array.isArray(cached) ? cached : [])
		.filter((c) => c && Array.isArray(c.messages) && Number.isFinite(c.fromSeq) && Number.isFinite(c.toSeq))
		.slice()
		.sort((x, y) => x.fromSeq - y.fromSeq);
	if (list.length === 0) return { fromSeq: from, messages: [] };
	const messages = [];
	for (const c of list) {
		// trim at `to`: the dense window already holds [to, …) — never duplicate it
		const keep = Math.max(0, Math.min(c.messages.length, to - c.fromSeq));
		messages.push(...c.messages.slice(0, keep));
	}
	// "more than asked for" (a chunk reaching below `from`) is kept: it is real
	// content, contiguous with the rest, and the display gate is seq-based.
	const fromSeq = Math.min(from, list[0].fromSeq);
	return { fromSeq, messages };
}
