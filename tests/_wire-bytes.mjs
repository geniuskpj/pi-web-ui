// _wire-bytes.mjs — the ONE place that models what permessage-deflate does to a frame.
//
// Used by tests/thinking-flush.test.mjs (assertions) and tests/data-reduction.bench.mjs (the
// printed benchmark table) so the two can never drift: if the socket's config changes, both the
// gate and the headline numbers move together. The settings are copied from server.mjs's agent WSS
// (`perMessageDeflate: { threshold: 1024, zlibDeflateOptions: { level: 6 } }`) and pinned by
// tests/ws-deflate.test.mjs (D8) so a silent change there fails CI.
import zlib from "node:zlib";

export const WS_DEFLATE = { threshold: 1024, level: 6 };
/** Per-frame deflate/WS framing overhead. Small, but this is a byte test. */
export const FRAME_OVERHEAD = 6;

/**
 * What the wire carries for a list of text frames, at the agent socket's own settings:
 * a frame >= threshold is really deflated (zlib level 6); anything below travels raw.
 * → { raw, compressed, frames, saved }  (saved = fraction saved vs raw)
 */
export function wireBytes(texts, { threshold = WS_DEFLATE.threshold, level = WS_DEFLATE.level, type = "thinking_update" } = {}) {
	let raw = 0, compressed = 0;
	for (const text of texts) {
		const frame = Buffer.from(JSON.stringify({ type, text }), "utf8");
		raw += frame.length + FRAME_OVERHEAD;
		compressed += (frame.length >= threshold ? zlib.deflateSync(frame, { level }).length : frame.length) + FRAME_OVERHEAD;
	}
	return { raw, compressed, frames: texts.length, saved: raw ? 1 - compressed / raw : 0, bytesPerFrame: texts.length ? compressed / texts.length : 0 };
}

/** Human-friendly size: below 100KB as "22.6 KB", above as "1.20 MB" (a frame count in KB is what a
 *  reader needs; "0.02 MB" hides whether the win is 2× or 200×). */
export function size(bytes) {
	const b = Number(bytes) || 0;
	if (b < 100 * 1024) return `${(b / 1024).toFixed(b < 10 * 1024 ? 1 : 0)} KB`;
	return `${(b / 1048576).toFixed(2)} MB`;
}

/** Signed percentage, e.g. "-99.3%" / "+2.1%" (”—“ when the baseline is 0). Above 99.9% we keep a
 *  second decimal: "-100.0%" reads as a lie next to a non-zero result (4.7KB is still not 0). */
export function pct(from, to) {
	if (!from) return "—";
	const d = (to / from - 1) * 100;
	return `${d > 0 ? "+" : ""}${d.toFixed(Math.abs(d) >= 99.9 ? 2 : 1)}%`;
}
