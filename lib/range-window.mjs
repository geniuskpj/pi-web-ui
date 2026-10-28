/**
 * range-window.mjs — PURE: which [start,end) window does a /range response carry?
 *
 * WHY THIS IS A SEPARATE MODULE (review 2026-10-25): this arithmetic used to live
 * inline in the server.mjs handler, where no test could reach it — and both
 * reviewers found the same two defects in it:
 *   #1 the low end snapped DOWN past the requested `fromSeq`, so slice(start -
 *      fromSeq, …) went NEGATIVE (JS counts from the array END): the body no
 *      longer matched X-Range-From/To-Seq and the client spliced messages at the
 *      wrong seqs, once losing ~400 messages per expand behind a view that claimed
 *      the window started at 0.
 *   #3 the high end snapped UP past the requested `toSeq` while the slice topped
 *      out at `toSeq`: the stored chunk claimed more lines than it held, so
 *      verifyChunkText dropped it on EVERY read and the cache could never serve
 *      that window.
 * The rule both fixes encode is one sentence: THE HEADERS MUST DESCRIBE EXACTLY
 * THE BYTES WE SEND. See tests/range.test.mjs (section W).
 */
import { chunkFromSeq, chunkIndexOf, chunkToSeq, isChunkAligned } from "./chunk-window.mjs";

export const RANGE_MAX_BYTES = 1024 * 1024; // serialized-JSON cap per response
const TURN_SCAN_MAX = 200; // bounded user-turn walk (a monster turn may only stretch)

/**
 * @param {object} o
 * @param {any[]} o.messages   messages for seqs [fromSeq, toSeq)
 * @param {number} o.fromSeq   the window the CALLER asked for (never send below it)
 * @param {number} o.toSeq     the window the CALLER asked for (never send above it)
 * @param {number} o.messageCount  session length (a tail request asks to Infinity)
 * @param {number} [o.maxBytes]
 * @returns {{start:number,end:number}}  fromSeq <= start <= end <= min(toSeq, messageCount)
 */
export function planRangeWindow({ messages, fromSeq, toSeq, messageCount, maxBytes = RANGE_MAX_BYTES }) {
	const msgs = Array.isArray(messages) ? messages : [];
	// 1) byte budget, KEEPING THE HIGH END (grok 01a16a54): the window must stay
	//    adjacent to the loaded tail, so low seqs are dropped, never high ones.
	let a = toSeq;
	let bytes = 0;
	while (a > fromSeq) {
		let sz = 256;
		try { sz = JSON.stringify(msgs[a - 1 - fromSeq]).length; } catch { /* unmeasurable → default */ }
		if (bytes + sz > maxBytes) break;
		bytes += sz;
		a--;
	}
	// 2) user-turn alignment (user request 2026-10-24: "reach until previous user
	//    turn"): a window starting MID-TURN (inside a tool chain) reads broken.
	let aligned = a;
	for (let k = 0; k < TURN_SCAN_MAX && aligned > fromSeq; k++, aligned--) {
		if (msgs[aligned - fromSeq]?.role === "user") break;
	}
	// 3) C4: return WHOLE CHUNK_INTERVAL windows where possible, so a fetched window
	//    and a live-written chunk share a key (no seam). Snapping down below the
	//    REQUESTED fromSeq is not allowed (#1); the result is then one partial chunk
	//    — the documented seam caveat — instead of a response that lies.
	let start = chunkFromSeq(chunkIndexOf(aligned));
	if (start < fromSeq) start = fromSeq;
	// 4) the high end snaps UP to a boundary so the next window starts exactly there
	//    — but never past the requested toSeq (#3) nor the session end.
	let end = Math.min(isChunkAligned(toSeq) ? toSeq : chunkToSeq(chunkIndexOf(toSeq)), messageCount, toSeq);
	if (end < start) end = start; // requested window sits above the clamped start → empty
	return { start, end };
}
