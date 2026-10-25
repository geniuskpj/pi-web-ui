// data-reduction.bench.mjs — the READABLE benchmark table for "reduce mobile data".
//
// This is a PRINTER, not a gate (assertions live in tests/data-reduction.test.mjs and
// tests/thinking-flush.test.mjs, which check the same numbers). It answers exactly two questions:
//   1. how many PERCENT less data goes over the wire, and
//   2. how much LONGER does the user wait for that saving.
//
// WHAT IS MEASURED vs ESTIMATED — read before quoting a row:
//   measured : JSON frame bytes (real), the thinking frames (the shipped gate code), deflate
//              (real zlib level 6 at the socket's own threshold), frame counts, waits in ms
//              (from the injected clock, not from a sleep).
//   estimated: the encoded size of a re-encoded image (lib/data-reduction.mjs' bits-per-pixel
//              model — this project has no native encoder) and the browser's canvas time.
//   pending  : terminal scrollback deflate — the terminal WSS has no perMessageDeflate yet (P1).
//
// Usage: node tests/data-reduction.bench.mjs   (npm run bench:data)
import { resolveDataReduction, planImageTransform, frameBytes } from "../lib/data-reduction.mjs";
import { resolveThinkingPolicy, simulateThinking, simulateStream } from "../lib/thinking-flush.mjs";
import { redactImageData, createMediaStore } from "../lib/media-egress.mjs";
import { WS_DEFLATE, wireBytes, size, pct } from "./_wire-bytes.mjs";

// ── fixtures ────────────────────────────────────────────────────────────────────────────────
/** A reasoning turn: 6 paragraphs of prose, delivered as ~25-char thinking_delta frames. */
const para = (n) => Array.from({ length: n }, (_, i) => `Paragraph ${i}: ` + "reasoning about the problem and checking the assumption. ".repeat(25)).join("\n\n") + "\n\n";
const THINKING = para(6);
const deltaStream = (text, size = 25) => { const out = []; for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size)); return out; };
const DELTAS = deltaStream(THINKING);
const STEP_MS = 40;                        // a realistic delta cadence (~25 chars / 40 ms)
const TURN_MS = DELTAS.length * STEP_MS;   // how long the model takes to finish thinking

/** An 8-image session, exactly as attach / `/range` / full-GET serialized it before redaction. */
const imgB64 = (kb, fill) => Buffer.alloc(kb * 1024, fill).toString("base64");
const msg = (text, parts = []) => ({ role: "user", content: [{ type: "text", text }, ...parts], timestamp: 1700000000000 });
const SESSION = [
	msg("here are 8 photos of the whiteboard", Array.from({ length: 8 }, (_, i) => ({ type: "image", mimeType: i % 2 ? "image/jpeg" : "image/png", data: imgB64(900, 0x10 + i) }))),
	...Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `turn ${i} ` + "lorem ipsum ".repeat(12) })),
];

// ── the numbers ─────────────────────────────────────────────────────────────────────────────
// 1) egress: opening an 8-image session
const sessionInline = frameBytes(SESSION);
const { messages: sessionRedacted, media } = redactImageData(SESSION, { store: createMediaStore() });
const sessionRedactedBytes = frameBytes(sessionRedacted);
const mediaBytes = media.reduce((n, m) => n + m.bytes, 0);

// 2) upload: the same 12MP 3MB photo, per link (today: sent as-is on every link)
const PHOTO = { mimeType: "image/jpeg", bytes: 3 * 1024 * 1024, width: 4000, height: 3000 };
const uploads = ["lan", "wan", "metered"].map((net) => {
	const plan = planImageTransform(PHOTO, resolveDataReduction(net, {}));
	const outBytes = plan.action === "passthrough" ? PHOTO.bytes : plan.estimatedBytes;
	return {
		net,
		outBytes,
		pct: pct(PHOTO.bytes, outBytes),
		label: plan.action === "passthrough" ? "passthrough (within budget)" : `webp ${plan.target.width}x${plan.target.height} q${plan.target.quality} ~${size(outBytes)}`,
	};
});

// 2b) the RESIZE RULE itself: two thresholds (pixels AND bytes), one scale factor for both axes
const resizeCases = [
	{ src: [4000, 3000], bytes: 3 * 1024 * 1024, net: "metered", settings: {} },
	{ src: [4000, 3000], bytes: 3 * 1024 * 1024, net: "wan", settings: {} },
	{ src: [4000, 3000], bytes: 3 * 1024 * 1024, net: "metered", settings: { imageMaxEdge: 6000 } },
	{ src: [3000, 4000], bytes: 3 * 1024 * 1024, net: "metered", settings: {} },
	{ src: [1536, 1024], bytes: 900 * 1024, net: "metered", settings: {} },
].map((c) => {
	const pol = resolveDataReduction(c.net, c.settings);
	const plan = planImageTransform({ mimeType: "image/jpeg", bytes: c.bytes, width: c.src[0], height: c.src[1] }, pol);
	const t = plan.target ?? { width: c.src[0], height: c.src[1] };
	const ratio = (a, b) => (a / b).toFixed(2);
	return {
		src: `${c.src[0]}x${c.src[1]}`,
		link: `${c.net} ${pol.maxEdge}px / ${Math.round(pol.maxBytes / 1024)}KB`,
		target: plan.action === "passthrough" ? "passthrough" : `${t.width}x${t.height} q${t.quality}`,
		bound: plan.action === "passthrough" ? "under both budgets" : (t.bytesBind ? "BYTE cap" : "pixel cap"),
		est: plan.action === "passthrough" ? size(c.bytes) : size(plan.estimatedBytes),
		ratio: `${ratio(c.src[0], c.src[1])} -> ${ratio(t.width, t.height)}`,
	};
});

// 2c) the four image LEVELS a user can actually pick (the settings dropdown)
const levels = ["high", "medium", "low", "none"].map((level) => {
	const pol = resolveDataReduction("wan", { imageLevel: level });
	const plan = planImageTransform(PHOTO, pol);
	const out = plan.action === "passthrough" ? PHOTO.bytes : plan.estimatedBytes;
	return { level, out, pct: pct(PHOTO.bytes, out), target: plan.action === "passthrough" ? "original" : `${plan.target.width}x${plan.target.height} q${plan.target.quality}` };
});

// 3) streaming: the thinking turn, five policies (the compression question)
const preset = resolveThinkingPolicy("wan", {});
const modes = [
	{ label: "live - today (every delta)", policy: { mode: "off" }, today: true },
	{ label: `wan preset (floor ${preset.minBytes}B, hold <=${preset.maxHoldMs}ms)`, policy: { ...preset } },
	{ label: `paragraph only (floor ${preset.minBytes}B, no idle)`, policy: { mode: "paragraph", minBytes: preset.minBytes, maxLines: 1e9, maxBytes: 1e9, minIntervalMs: 0, idleMs: 1e9 } },
	{ label: `line threshold >=${preset.maxLines} breaks`, policy: { mode: "lines", maxLines: preset.maxLines, minBytes: preset.minBytes, maxBytes: 1e9, minIntervalMs: 0, idleMs: 1e9 } },
	{ label: "hold until turn end (atomic)", policy: { mode: "end" } },
];
const thinking = modes.map(({ label, policy, today }) => {
	const sim = simulateThinking(DELTAS, { policy, stepMs: STEP_MS });
	const wire = wireBytes(sim.frames.map((f) => f.text), WS_DEFLATE);
	return {
		label, today,
		frames: wire.frames,
		bytes: wire.compressed,
		saved: wire.saved, // fraction the compressor removed from the coalesced text
		// "how long until the user sees ANY reasoning" — measured from the first delta
		firstTextMs: sim.frames[0]?.waitedMs ?? 0,
		worstMs: sim.stats.maxWaitMs,
		medianMs: sim.stats.medianWaitMs,
		// how many of this policy's frames are actually big enough for the socket to compress
		eligible: sim.stats.frameBytes.filter((b) => b >= WS_DEFLATE.threshold).length,
	};
});
const live = thinking[0];
const vs = (t) => ({ bytes: pct(live.bytes, t.bytes), frames: pct(live.frames, t.frames) });
const secs = (ms) => (ms / 1000).toFixed(2);

// 3b) the three thinking LEVELS (the settings dropdown) on the same turn
const thinkingLevelRows = ["paragraph", "turnEnd", "none"].map((level) => {
	const sim = simulateStream(DELTAS, { kind: "thinking", net: "wan", settings: { thinkingLevel: level }, stepMs: STEP_MS });
	const wire = wireBytes(sim.frames.map((f) => f.text), WS_DEFLATE);
	const eligible = sim.stats.frameBytes.filter((b) => b >= WS_DEFLATE.threshold).length;
	return {
		label: level,
		bytes: wire.compressed,
		frames: wire.frames,
		today: false,
		deflate: eligible === wire.frames ? `${wire.frames}/${wire.frames} compressed` : `${eligible}/${wire.frames} compressed`,
		vsBytes: pct(live.bytes, wire.compressed),
		vsFrames: pct(live.frames, wire.frames),
		delay: sim.frames.length === 0 ? "0 ms" : `+${secs(sim.frames[0].waitedMs)} s (worst ${secs(sim.stats.maxWaitMs)} s)`,
	};
});

// ── print ───────────────────────────────────────────────────────────────────────────────────
const W = [46, 30, 34, 12, 12, 46]; // +2 gutter between columns
const pad = (s, n) => String(s).padEnd(n + 2);
const rule = "-".repeat(W.reduce((a, b) => a + b, 0) + 2 * W.length);
const line = (cells) => cells.map((c, i) => pad(c, W[i])).join("");

console.log("");
console.log("MOBILE DATA: HOW MUCH LESS, AND HOW MUCH LONGER TO WAIT");
console.log("(bytes = on the wire, i.e. after real deflate where the socket applies it)");
console.log("");
console.log(line(["SCENARIO", "TODAY (default)", "WITH THE POLICY", "BYTES", "FRAMES", "EXTRA WAIT VS TODAY"]));
console.log(rule);
console.log(line([
	"open/attach an 8-image session",
	`inline base64 ${size(sessionInline)}`,
	`hash + media route ${size(sessionRedactedBytes)}`,
	pct(sessionInline, sessionRedactedBytes), "same",
	"+1 HTTP fetch/image, cached after (0 B warm)",
]));
console.log(line([
	"terminal scrollback (5 MB build log)",
	"no deflate on /ws/terminal",
	"permessage-deflate (P1, not built)",
	"n/a", "same",
	"0 ms (lossless) - expect 60-80% on text",
]));
console.log(`  · the media bytes are served once per device: ${size(mediaBytes)} stays server-side, only hashes travel`);

console.log("");
console.log("UPLOAD: ONE 12MP 3.00 MB PHOTO (today: send it as-is on every link)");
console.log(rule);
for (const u of uploads) {
	console.log(line([
		`    ${u.net}`, "as-is 3.00 MB", u.label, u.pct, "1",
		u.net === "lan" ? "+100-300 ms to encode (browser-only, NOT measured)" : "same",
	]));
}
console.log("  · the result bytes are ESTIMATED from the quality/size model (no native encoder in this project)");

console.log("");
console.log("IMAGE LEVEL (settings dropdown) — same 12MP 3.00 MB photo on wan");
console.log(rule);
console.log(line(["    LEVEL", "TARGET", "BYTES (est)", "VS ORIGINAL", "", ""]));
for (const l of levels) console.log(line([`    ${l.level}`, l.target, size(l.out), l.pct, "", ""]));
console.log("  · \"auto\" picks high on lan/wired, medium on wifi/wan/remote, low on metered — never none");
console.log("");
console.log("THINKING LEVEL (settings dropdown) — the same 8.5 KB reasoning turn on wan");
console.log(rule);
console.log(line(["    LEVEL", "WIRE BYTES / FRAMES", "FRAMES COMPRESSED", "VS LIVE", "FRAMES", "DELAY TO FIRST TEXT"]));
for (const t of thinkingLevelRows) {
	console.log(line([`    ${t.label}`, `${size(t.bytes)} / ${t.frames} f`, t.deflate, t.today ? "baseline" : t.vsBytes, t.today ? "baseline" : t.vsFrames, t.delay]));
}
console.log("");
console.log("RESIZE RULE: pixels AND bytes are thresholds; the aspect ratio is preserved (one scale, both axes)");
console.log(rule);
console.log(line(["    SOURCE / BUDGET", "TARGET", "BOUND BY", "BYTES (est)", "ASPECT KEPT", ""]));
for (const r of resizeCases) console.log(line([`    ${r.src}  ${r.link}`, r.target, r.bound, r.est, r.ratio, ""]));
console.log("  · 1024px caps resolution; with a generous cap the BYTE budget sets the edge (~256KB at q0.65, scale 0.46)");
console.log("  · a floor (minEdge) stops the byte cap from shredding a screenshot — below it the quality ladder is spent instead");
console.log("");
console.log(`THINKING TURN: ${size(frameBytes({ t: THINKING }))} OF REASONING, ${DELTAS.length} DELTAS, ${Math.round(TURN_MS / 1000)} S OF MODEL TIME`);
console.log(`(today: live - ${size(live.bytes)} over ${live.frames} frames, first text at 0 ms)`);
console.log(rule);
console.log(line(["    POLICY", "WIRE BYTES / FRAMES", "FRAMES COMPRESSED", "VS LIVE", "FRAMES", "DELAY TO FIRST TEXT"]));
for (const t of thinking) {
	const delay = t.today ? "0 ms" : `+${secs(t.firstTextMs)} s (worst chunk ${secs(t.worstMs)} s)`;
	const deflateLabel = t.eligible === t.frames ? `${t.frames}/${t.frames} compressed`
		: t.eligible === 0 ? `none (all <${WS_DEFLATE.threshold}B)`
		: `${t.eligible}/${t.frames} compressed`;
	console.log(line([
		`    ${t.label}`,
		`${size(t.bytes)} / ${t.frames} f`,
		deflateLabel,
		t.today ? "baseline" : vs(t).bytes,
		t.today ? "baseline" : vs(t).frames,
		delay,
	]));
}
console.log(`  · live frames are ~67 B, below the socket threshold of ${WS_DEFLATE.threshold} B, so permessage-deflate is SKIPPED entirely`);
console.log(`  · coalescing is what makes deflate run at all: ${(thinking[2].saved * 100).toFixed(0)}% off the coalesced text (real zlib, level ${WS_DEFLATE.level})`);
console.log(`  · the presets' floor is ${preset.minBytes} B = the socket threshold, so a coalesced frame is never wasted on a skipped compressor`);

console.log("");
console.log("BOTTOM LINE");
console.log(`  attach     ${size(sessionInline)} -> ${size(sessionRedactedBytes)}   ${pct(sessionInline, sessionRedactedBytes)} bytes, no extra wait (warm reopen: 0 B)`);
console.log(`  upload     ${size(PHOTO.bytes)} -> ${size(uploads[2].outBytes)} ${uploads[2].pct} on metered, +0.1-0.3 s once before sending`);
console.log(`  thinking   ${size(live.bytes)} / ${live.frames} frames -> ${size(thinking[1].bytes)} / ${thinking[1].frames} frames   ${vs(thinking[1]).bytes} bytes, ${vs(thinking[1]).frames} frames, +${secs(thinking[1].firstTextMs)} s to first text`);
console.log("  terminal   pending (P1) - nothing to quote yet");
console.log("");
console.log("measured = JSON/zlib frames, counts and waits · estimated = image encode size · pending = terminal deflate");
console.log("");
process.exit(0);
