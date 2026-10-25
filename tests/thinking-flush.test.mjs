// thinking-flush.test.mjs — the answer to "should the thinking turn be sent at the END, or at a
// paragraph / line threshold?" (user question, 2026-10-25), as an executable measurement.
//
// WHY THIS IS A COMPRESSION TEST AND NOT JUST A UI TEST
//   The agent socket negotiates `perMessageDeflate: { threshold: 1024, level: 6 }` (server.mjs).
//   `ws` SKIPS the compressor entirely for messages below the threshold, and a thinking_delta is a
//   few hundred bytes — so today's per-delta streaming travels UNCOMPRESSED. Coalescing reasoning
//   to paragraph/line/byte-sized chunks is therefore what MAKES compression engage; the frame-count
//   win is the visible half, the deflate win is the billed half.
//
// WHAT IS PINNED HERE
//   T  resolveThinkingPolicy           — presets, overrides, levels (atomic mode was dropped)
//   P  the gate                        — paragraph / lines / bytes / idle / end / off, rate limit,
//                                        no content loss, ordering of the triggers
//   S  simulateThinking                — frames + wait times for a realistic reasoning stream
//   W  wire bytes                      — REAL zlib deflate at the server's own threshold/level,
//                                        comparing off · paragraph · lines · end  (§7 measurement)
//   A  assistantThinkingText/StreamText — the extraction the server and client both need
//
// Usage: node tests/thinking-flush.test.mjs
import {
	THINKING_PRESETS, THINKING_MODES, THINKING_LEVELS, THINKING_LEVEL_MODES,
	STREAM_KINDS, STREAM_KIND_PRESETS,
	resolveThinkingPolicy, resolveStreamPolicy, createThinkingGate, simulateThinking, simulateStream,
	describeStreamPolicy, shortStreamParams, thinkingLevelOptions, thinkingLevelForNet,
	paragraphBoundaryEnd, countLineBreaks, assistantThinkingText, assistantStreamText,
} from "../lib/thinking-flush.mjs";
import { frameBytes, deflateEligible } from "../lib/data-reduction.mjs";
// the same wire model the benchmark printer uses (shared so the two cannot drift)
import { WS_DEFLATE, wireBytes } from "./_wire-bytes.mjs";

let passed = 0, failed = 0;
const check = (name, ok, extra = "") => {
	if (ok) { passed++; console.log(`  ✓ ${name}${extra ? " — " + extra : ""}`); }
	else { failed++; console.error(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
};

const para = (n, words = 40) => Array.from({ length: n }, (_, i) => `Paragraph ${i}: ` + "reasoning about the problem and checking the assumption. ".repeat(words / 8)).join("\n\n") + "\n\n";

/** A reasoning stream the way pi-ai delivers it: thinking_delta events, ~25 chars each. */
function deltaStream(text, size = 25) {
	const out = [];
	for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
	return out;
}
// 6 paragraphs × ~1.4KB of reasoning: big enough that a per-paragraph frame crosses the socket's
// 1024-byte deflate threshold (that is the whole point of the byte accounting below).
const THINKING = para(6, 200);
const PARAGRAPHS = 6;

// ─────────────────────────────────────────────── T: policy resolution (settings surface)
{
	const auto = resolveThinkingPolicy("wan", {});
	check("T1 the wan default is paragraph-driven with explicit caps (byte floor = the socket threshold)",
		auto.net === "wan" && auto.mode === "paragraph" && auto.maxLines === 8 && auto.maxBytes === 2048 &&
		auto.minBytes === 1024 && auto.idleMs === 1500 && auto.maxHoldMs === 2500);

	check("T2 fast/metered map onto lan/metered", resolveThinkingPolicy("fast", {}).net === "lan" && resolveThinkingPolicy("metered", {}).net === "metered");
	check("T3 an unknown link falls back to wan", resolveThinkingPolicy(undefined, {}).net === "wan" && resolveThinkingPolicy("x", {}).maxBytes === THINKING_PRESETS.wan.maxBytes);

	check("T4 metered asks for BIGGER chunks (fewer frames, longer wait) than lan",
		THINKING_PRESETS.metered.maxBytes > THINKING_PRESETS.wan.maxBytes && THINKING_PRESETS.metered.maxBytes > THINKING_PRESETS.lan.maxBytes &&
		THINKING_PRESETS.metered.idleMs > THINKING_PRESETS.lan.idleMs);

	check("T5 only the four known modes are accepted",
		THINKING_MODES.join(",") === "off,paragraph,lines,end" &&
		resolveThinkingPolicy("lan", { thinkingFlush: "lines" }).mode === "lines" &&
		resolveThinkingPolicy("lan", { thinkingFlush: "auto" }).mode === "paragraph" &&
		resolveThinkingPolicy("lan", { thinkingFlush: "wait" }).mode === "paragraph");

	check("T6 an ATOMIC stream value is no longer a thing (dropped 2026-10-25) — junk falls back to tier/live",
		resolveThinkingPolicy("lan", { stream: "atomic" }).mode === "paragraph" &&
		resolveThinkingPolicy("lan", { stream: "atomic", thinkingLevel: "turnEnd" }).mode === "end");

	const over = resolveThinkingPolicy("lan", { thinkingMaxLines: "12", thinkingMaxBytes: 8192, thinkingIdleMs: 0, thinkingMinIntervalMs: 0, thinkingMinBytes: 0 });
	check("T7 overrides are honoured and clamped to sane values",
		over.maxLines === 12 && over.maxBytes === 8192 && over.idleMs === 0 && over.minIntervalMs === 0 && over.minBytes === 0);
	check("T8 garbage / negative overrides fall back to the preset",
		resolveThinkingPolicy("lan", { thinkingMaxLines: "abc", thinkingMaxBytes: -1, thinkingIdleMs: "x", thinkingMinBytes: -1 }).maxBytes === THINKING_PRESETS.lan.maxBytes &&
		resolveThinkingPolicy("lan", { thinkingMinBytes: -1 }).minBytes === THINKING_PRESETS.lan.minBytes);
	check("T9 lan keeps the lowest floor (fastest visible reasoning) and every link can clear the socket threshold",
		THINKING_PRESETS.lan.minBytes < THINKING_PRESETS.wan.minBytes && THINKING_PRESETS.wan.minBytes >= 1024 &&
		THINKING_PRESETS.wan.maxHoldMs > THINKING_PRESETS.wan.idleMs);
}

// ─────────────── U: the three user-facing LEVELS (paragraph · turn end · none)
{
	check("U1 the three levels (+auto) are exactly paragraph · turnEnd · none",
		THINKING_LEVELS.join(",") === "auto,paragraph,turnEnd,none");
	check("U1b each level maps onto an existing mode",
		THINKING_LEVEL_MODES.paragraph === "paragraph" && THINKING_LEVEL_MODES.turnEnd === "end" && THINKING_LEVEL_MODES.none === "off");
	check("U1c auto means paragraph on every tier today",
		thinkingLevelForNet("lan") === "paragraph" && thinkingLevelForNet("metered") === "paragraph" && resolveThinkingPolicy("metered", {}).level === "paragraph" &&
		resolveThinkingPolicy("metered", {}).levelSource === "auto");

	check("U2 paragraph selected → the paragraph gate (frames ≥1KB, hard ceiling kept)",
		(() => { const p = resolveThinkingPolicy("wan", { thinkingLevel: "paragraph" }); return p.mode === "paragraph" && p.level === "paragraph" && p.levelSource === "user" && p.minBytes === 1024; })());
	check("U3 turn end selected → ONE frame per block (mode end), thresholds irrelevant",
		resolveThinkingPolicy("wan", { thinkingLevel: "turnEnd" }).mode === "end" &&
		simulateThinking(deltaStream(THINKING, 25), { policy: resolveThinkingPolicy("wa" + "n", { thinkingLevel: "turnEnd" }) }).stats.frames === 1);
	check("U4 none selected → live, every delta goes out (the user asked for zero reduction)",
		resolveThinkingPolicy("wan", { thinkingLevel: "none" }).mode === "off" &&
		simulateThinking(deltaStream(THINKING, 25), { policy: resolveThinkingPolicy("wan", { thinkingLevel: "none" }) }).stats.frames === deltaStream(THINKING, 25).length);
	check("U5 a junk level falls back to auto (never silently to none)",
		resolveThinkingPolicy("wan", { thinkingLevel: "fast" }).mode === "paragraph" && resolveThinkingPolicy("wan", { thinkingLevel: "fast" }).levelSource === "auto");
	check("U5b the older/internal overrides still work (lines, off) — same code path, no branch fork",
		resolveThinkingPolicy("wan", { thinkingFlush: "lines" }).mode === "lines" && resolveThinkingPolicy("wan", { thinkingFlush: "off" }).mode === "off");
	check("U5c the level is the only thing that decides the mode (no hidden 'atomic' override left)",
		resolveThinkingPolicy("lan", { stream: "atomic", thinkingLevel: "paragraph" }).mode === "paragraph" &&
		resolveThinkingPolicy("lan", { stream: "coalesced", thinkingLevel: "paragraph" }).mode === "paragraph");

	// the three levels drive the SAME three outcomes whether it is reasoning, the answer or tool output
	check("U6 the level reaches the assistant TEXT and TOOL output too (same policy, kind thresholds)",
		(() => {
			const s = { thinkingLevel: "turnEnd" };
			return resolveStreamPolicy("text", "wan", s).mode === "end" && resolveStreamPolicy("tool", "wan", s).mode === "end" &&
				resolveStreamPolicy("text", "wan", { thinkingLevel: "none" }).mode === "off" && resolveStreamPolicy("tool", "wan", { thinkingLevel: "none" }).mode === "off";
		})());
	check("U6b each kind still gets its OWN thresholds (the answer arrives fast, tool output in bulk)",
		(() => {
			const t = resolveStreamPolicy("text", "wan", {}), k = resolveStreamPolicy("tool", "wan", {}), th = resolveStreamPolicy("thinking", "wan", {});
			return t.minBytes === 256 && t.maxHoldMs === 1200 && t.idleMs === 600 &&
				k.minBytes === 2048 && k.maxLines === 40 && k.maxBytes === 8192 && k.mode === "lines" &&
				th.minBytes === 1024 && STREAM_KINDS.join(",") === "thinking,text,tool";
		})(), `text ${STREAM_KIND_PRESETS.text.minBytes}B/${STREAM_KIND_PRESETS.text.maxHoldMs}ms · tool ${STREAM_KIND_PRESETS.tool.minBytes}B/${STREAM_KIND_PRESETS.tool.maxLines} lines`);
	check("U6c a kind may be pinned apart from the thinking level (pi.textLevel / pi.toolLevel)",
		resolveStreamPolicy("text", "wan", { thinkingLevel: "paragraph", textLevel: "turnEnd" }).mode === "end" &&
		resolveStreamPolicy("text", "wan", { thinkingLevel: "turnEnd", textLevel: "paragraph" }).mode === "paragraph" &&
		resolveStreamPolicy("tool", "wan", { thinkingLevel: "none", toolLevel: "paragraph" }).mode === "lines");
	check("U6d text/tool honour level none independently of the thinking level",
		resolveStreamPolicy("text", "wan", { thinkingLevel: "none", textLevel: "paragraph" }).mode === "paragraph" &&
		resolveStreamPolicy("text", "wan", { thinkingLevel: "paragraph", textLevel: "none" }).mode === "off");
	check("U6e an unknown kind is treated as thinking (never as a silent no-op)",
		resolveStreamPolicy("reasoning", "wan", {}).kind === "thinking" && resolveStreamPolicy("reasoning", "wan", {}).mode === "paragraph");

	// "show param when it is selected"
	check("U7 describeStreamPolicy states the real parameters per kind and per level",
		describeStreamPolicy(resolveStreamPolicy("thinking", "wan", {})).includes("≥1 KB/frame") &&
		describeStreamPolicy(resolveStreamPolicy("thinking", "wan", {})).includes("2.5 s") &&
		describeStreamPolicy(resolveStreamPolicy("text", "wan", {}), "text").includes("the answer") &&
		describeStreamPolicy(resolveStreamPolicy("tool", "wan", {}), "tool").includes("tool output"),
		describeStreamPolicy(resolveStreamPolicy("thinking", "wan", {})));
	check("U7b …and describes the two non-paragraph levels in words a user can act on",
		/^None — reasoning streams live/.test(describeStreamPolicy(resolveStreamPolicy("thinking", "wan", { thinkingLevel: "none" }))) &&
		/Turn end — reasoning is held and sent as ONE frame when the message ends/.test(describeStreamPolicy(resolveStreamPolicy("thinking", "wan", { thinkingLevel: "turnEnd" }))) &&
		/tool call ends/.test(describeStreamPolicy(resolveStreamPolicy("tool", "wan", { thinkingLevel: "turnEnd" }), "tool")));
	check("U8 the dropdown option lists carry a label and a short params string for every level",
		thinkingLevelOptions().length === 4 && thinkingLevelOptions().every((o) => o.value && o.label && o.params) &&
		thinkingLevelOptions("tool").find((o) => o.value === "paragraph").params.includes("40 lines") &&
		shortStreamParams("turnEnd") === "one frame at the end" && shortStreamParams("none") === "live, no reduction" &&
		thinkingLevelOptions().find((o) => o.value === "auto").resolved === "paragraph",
		thinkingLevelOptions().map((o) => `${o.value}: ${o.params}`).join(" | "));
}

// ─────────── V: the SAME thresholds on the assistant text and on a TOOL CALL (frames + deltas)
{
	// text deltas: prose arrives per paragraph, small floor, tight ceiling
	const prose = "Here is what I found. ".repeat(60) + "\n\n" + "And the second paragraph. ".repeat(60) + "\n\n";
	const textRun = simulateStream(deltaStream(prose, 25), { kind: "text", net: "wan", stepMs: 40 });
	check("V1 the visible answer is gated by the TEXT policy (paragraph mode, 256B floor)",
		textRun.stats.policy.kind === "text" && textRun.stats.policy.mode === "paragraph" &&
		textRun.frames.every((f) => f.bytes >= 256 || f.reason === "end") && textRun.frames.some((f) => f.bytes >= 256),
		`${textRun.stats.frames} frames: ${textRun.stats.reasons.join(",")}`);
	check("V1b …and its wait is bounded by the TIGHT text ceiling, not the thinking one",
		textRun.stats.maxWaitMs <= textRun.stats.policy.maxHoldMs + 80, `max wait ${textRun.stats.maxWaitMs}ms ≤ ${textRun.stats.policy.maxHoldMs}ms`);
	check("V1c no text is lost or reordered", textRun.frames.map((f) => f.text).join("") === prose);
	check("V1d turnEnd holds the whole answer, then sends it once (the 'last assistant turn' case)",
		(() => { const r = simulateStream(deltaStream(prose, 25), { kind: "text", net: "wan", settings: { thinkingLevel: "turnEnd" } }); return r.stats.frames === 1 && r.frames[0].text === prose; })());

	// tool output: line- and byte-thresholded, one frame per 40 lines or 2KB
	const log = Array.from({ length: 200 }, (_, i) => `[build] step ${i} ok\n`).join("");
	const toolRun = simulateStream(deltaStream(log, 25), { kind: "tool", net: "wan", stepMs: 20 });
	check("V2 tool output is gated by the TOOL policy: ~1 frame per 40 lines, never per delta",
		toolRun.stats.policy.kind === "tool" && toolRun.stats.frames > 1 && toolRun.stats.frames <= 8 && toolRun.stats.frames < deltaStream(log, 25).length / 10,
		`${toolRun.stats.frames} frames for 200 lines / ${deltaStream(log, 25).length} deltas`);
	check("V2b the tool frames are big enough to be COMPRESSED (≥ the socket threshold)",
		toolRun.frames.every((f) => deflateEligible(frameBytes({ type: "tool_output", text: f.text }), WS_DEFLATE)));
	check("V2c tool output is never lost", toolRun.frames.map((f) => f.text).join("") === log);
	check("V2d turnEnd holds the whole tool output and sends it once (the 'tool call' case)",
		(() => { const r = simulateStream(deltaStream(log, 25), { kind: "tool", net: "wan", settings: { thinkingLevel: "turnEnd" } }); return r.stats.frames === 1 && r.frames[0].text === log; })());
	check("V2e level none = live tool output (no reduction, the debugging case)",
		(() => { const r = simulateStream(deltaStream(log, 25), { kind: "tool", net: "wan", settings: { thinkingLevel: "none" } }); return r.stats.frames === deltaStream(log, 25).length; })());
}

// ─────────────────────────────────────────────── P: the gate itself (pure, time injected)
{
	check("P1 a blank line is a paragraph boundary (with \\r\\n and trailing spaces tolerated)",
		paragraphBoundaryEnd("a\n\nb") === 3 && paragraphBoundaryEnd("a\r\n\r\nb") === 5 &&
		paragraphBoundaryEnd("a\n   \nb") === 6 && paragraphBoundaryEnd("a\nb\nc") === -1);
	check("P1b the LAST boundary wins (everything complete is emitted at once)",
		paragraphBoundaryEnd("a\n\nb\n\nc") === 6);
	check("P1c line counting counts breaks, not lines", countLineBreaks("a\nb\nc") === 2 && countLineBreaks("abc") === 0);
}

{
	// the headline case: nothing is emitted until a paragraph is COMPLETE
	const gate = createThinkingGate({ mode: "paragraph", maxLines: 99, maxBytes: 1e6, minBytes: 0, minIntervalMs: 0, idleMs: 1e6 });
	const r1 = gate.push("The user asks about", 1000);
	const r2 = gate.push(" data transfer.\n", 1040);
	check("P2 an unfinished paragraph is buffered, not sent", r1.emit === null && r2.emit === null && gate.snapshot().pendingBytes > 20);
	const r3 = gate.push("\nNext thought", 1080);
	check("P3 crossing a paragraph boundary emits the COMPLETE paragraph only",
		r3.reason === "paragraph" && r3.emit === "The user asks about data transfer.\n\n" && gate.snapshot().pending === "Next thought");
	const r4 = gate.flush(1120);
	check("P3b the trailing partial paragraph is sent at turn end", r4.reason === "end" && r4.emit === "Next thought" && gate.snapshot().pending === "");
}

{
	// the end-of-turn answer: one frame per turn, at the cost of visible latency
	const gate = createThinkingGate({ mode: "end", idleMs: 0, maxBytes: 1e9, maxLines: 1e9 });
	const stream = deltaStream(THINKING, 25);
	let emits = 0;
	for (const d of stream) if (gate.push(d, 1000).emit) emits++;
	const last = gate.flush(9000);
	check("P4 mode:\"end\" sends nothing while thinking (even with idle=0 and no caps)",
		emits === 0, `${stream.length} deltas, ${emits} frames`);
	check("P4b and exactly one frame at turn end, with the whole text",
		last.emit === THINKING && gate.snapshot().frames === 1);
}

{
	const gate = createThinkingGate({ mode: "paragraph", minBytes: 0, minIntervalMs: 250, idleMs: 1e9, maxBytes: 1e9, maxLines: 1e9 });
	const first = gate.push("one\n\n", 1000);   // no previous frame → the first paragraph is never held
	const held = gate.push("two\n\n", 1100);   // boundary only 100ms after that frame → rate-limited
	const later = gate.push("three\n\n", 1400); // 400ms after → allowed, ships everything complete
	check("P5 the min-interval rate limit holds a boundary back instead of spamming frames",
		first.emit === "one\n\n" && held.emit === null && held.deferred === true && later.reason === "paragraph",
		JSON.stringify({ first: first.reason, held: held.reason, deferred: held.deferred, later: later.reason }));
	check("P5b a rate-limited boundary is not lost — it ships with the next one", later.emit === "two\n\nthree\n\n" && gate.snapshot().pending === "");
}

{
	const gate = createThinkingGate({ mode: "paragraph", maxBytes: 200, maxLines: 1e9, minIntervalMs: 1e9, idleMs: 1e9 });
	const emit = gate.push("y".repeat(250), 1000);
	check("P6 the byte cap fires even when the rate limit says wait (bound the memory)", emit.reason === "bytes" && emit.emit.length === 250);
	const gate2 = createThinkingGate({ mode: "paragraph", minBytes: 0, maxLines: 3, maxBytes: 1e9, minIntervalMs: 1e9, idleMs: 1e9 });
	const lines = gate2.push("a\nb\nc\n", 1000);
	check("P7 the line threshold fires on the Nth break (the user's \"line threshold\")",
		lines.reason === "lines" && lines.emit === "a\nb\nc\n");
	// …but a natural boundary obeys the byte floor too (40 tiny lines are not worth a raw frame)
	const gated = createThinkingGate({ mode: "lines", minBytes: 1024, maxLines: 40, maxBytes: 1e9, minIntervalMs: 0, idleMs: 1e9, maxHoldMs: 1e9 });
	let gatedFrames = 0;
	for (let i = 0; i < 60; i++) if (gated.push(`x${i}\n`, 1000 + i * 10).emit) gatedFrames++;
	check("P7b the line threshold is gated by the SAME minBytes floor (60 short lines = 0 frames so far)",
		gatedFrames === 0 && gated.snapshot().pendingBytes < 1024, `${gatedFrames} frames, ${gated.snapshot().pendingBytes}B buffered`);
	const gatedFlush = gated.flush(9999);
	check("P7c …and the hard ceiling/hard caps still guarantee it eventually ships", gatedFlush.emit.length > 0 && gatedFrames + 1 === 1);
}

{
	// idle keep-alive, soft rule: with minBytes:0 a paragraph-less block is emitted once idleMs passes
	const gate = createThinkingGate({ mode: "paragraph", maxLines: 1e9, maxBytes: 1e9, minBytes: 0, minIntervalMs: 1e9, idleMs: 500, maxHoldMs: 1e9 });
	gate.push("a long single paragraph, no breaks at all…", 1000);
	const idle = gate.idle(1700);
	check("P8 idle keep-alive emits a paragraph-less reasoning block (never looks frozen)",
		idle.reason === "idle" && idle.emit.startsWith("a long single paragraph"));
	check("P8b a tick before the idle window emits nothing",
		createThinkingGate({ mode: "paragraph", minBytes: 0, maxLines: 1e9, maxBytes: 1e9, idleMs: 500, maxHoldMs: 1e9 }).idle(100).emit === null);
}

{
	// THE TWO PROMISES of the idle rule (the fix the benchmark table forced):
	//   soft: after idleMs, but only once the buffer is worth compressing (`minBytes`)
	//   hard: after maxHoldMs, always
	const soft = createThinkingGate({ mode: "paragraph", minBytes: 1024, maxLines: 1e9, maxBytes: 1e9, minIntervalMs: 0, idleMs: 500, maxHoldMs: 5000 });
	soft.push("short reasoning", 1000);
	const tooSmall = soft.idle(1700);
	check("P8c the SOFT idle rule waits for minBytes: a 15B buffer is not worth a frame yet",
		tooSmall.emit === null && tooSmall.reason === "none", `reason=${tooSmall.reason}`);
	const bigEnough = soft.push("y".repeat(1024), 2100); // 1039B buffered, 1.1s since the buffer started
	check("P8d …and fires as soon as the buffer clears the floor (a compressible frame, not a raw one)",
		bigEnough.reason === "idle" && bigEnough.emit.length === 1039 && deflateEligible(frameBytes({ t: bigEnough.emit }), WS_DEFLATE),
		`${bigEnough.emit?.length}B text → ${frameBytes({ t: bigEnough.emit })}B frame ≥ ${WS_DEFLATE.threshold}B`);
	check("P8d2 the soft rule is monotone: a bigger buffer never waits longer than a smaller one",
		(() => {
			const t = (bytes) => { const g = createThinkingGate({ mode: "paragraph", minBytes: 1024, maxLines: 1e9, maxBytes: 1e9, minIntervalMs: 0, idleMs: 500, maxHoldMs: 1e9 }); g.push("a".repeat(bytes), 0); let at = 0; while (at < 5000 && !g.idle(at + 100).emit) at += 100; return at + 100; };
			return t(2048) <= t(1024) && t(1024) <= t(512);
		})());
	const hard = createThinkingGate({ mode: "paragraph", minBytes: 1e6, maxLines: 1e9, maxBytes: 1e9, minIntervalMs: 0, idleMs: 500, maxHoldMs: 2500 });
	hard.push("tiny", 1000);
	check("P8e the HARD ceiling fires regardless of minBytes (a frozen block is worse than a small frame)",
		hard.idle(2000).emit === null && hard.idle(3600).reason === "idle" && hard.snapshot().pending === "");
	check("P8f maxHoldMs is never below idleMs (the OUTER bound of the soft one)",
		resolveThinkingPolicy("wan", { thinkingIdleMs: 3000, thinkingMaxHoldMs: 1000 }).maxHoldMs === 3000 &&
		resolveThinkingPolicy("wan", { thinkingMaxHoldMs: 9000 }).maxHoldMs === 9000);
}

{
	const gate = createThinkingGate({ mode: "off" });
	const e = gate.push("delta", 1000);
	check("P9 mode:\"off\" is a transparent passthrough (the measurement's control)",
		e.reason === "off" && e.emit === "delta" && gate.flush(1001).emit === null);
}

{
	const gate = createThinkingGate({ mode: "paragraph", maxLines: 4, maxBytes: 4096, minIntervalMs: 200, idleMs: 5000 });
	const stream = deltaStream(THINKING, 20);
	const seen = [];
	for (let i = 0; i < stream.length; i++) {
		const r = gate.push(stream[i], 1000 + i * 40);
		if (r.emit) seen.push(r.emit);
	}
	const tail = gate.flush(9000);
	check("P10 emit order is preserved and NOTHING is lost",
		seen.join("") + (tail.emit || "") === THINKING, `${seen.length + (tail.emit ? 1 : 0)} frames, ${(seen.join("") + (tail.emit || "")).length}/${THINKING.length} chars`);
	check("P10b every frame ends on a boundary or is the final flush",
		seen.every((s) => /\n\n$/.test(s)) && (tail.emit === "" || !/\n\n$/.test(tail.emit)));
	check("P11 no empty frame is ever emitted", seen.every((s) => s.length > 0));
	check("P12 reset() clears pending but keeps the per-turn frame counter",
		(() => { const g = createThinkingGate({ mode: "paragraph", minBytes: 0, minIntervalMs: 0 }); g.push("x\n\n", 10); g.reset(20); return g.snapshot().pending === "" && g.snapshot().frames === 1; })());
	check("P13 an unknown mode falls back to paragraph (never to off)", createThinkingGate({ mode: "nope" }).mode === "paragraph");
	check("P14 an empty/undefined delta is a no-op, not a frame", (() => { const g = createThinkingGate({ mode: "paragraph", idleMs: 0 }); return g.push("", 10).emit === null && g.push(undefined, 20).emit === null; })());
}

{
	// the anti-fragmentation floor: tiny paragraphs are MERGED, not framed one by one
	const gate = createThinkingGate({ mode: "paragraph", minBytes: 256, minIntervalMs: 0, idleMs: 1e9, maxBytes: 1e9, maxLines: 1e9 });
	const emitted = [];
	for (let i = 0; i < 20; i++) { const r = gate.push(`short point ${i}\n\n`, 1000 + i * 100); if (r.emit) emitted.push(r.emit); }
	const tailFloor = gate.flush(9000, "end");
	const allText = emitted.join("") + (tailFloor.emit || "");
	const mergedIn = (emitted[0] || "").split("\n\n").length - 1;
	check("P15 a stream of one-line paragraphs is merged up to minBytes (a frame costs ~40B of wrapper)",
		emitted.length <= 2 && mergedIn >= 15,
		`${emitted.length} frames for 20 paragraphs; first frame carries ${mergedIn}`);
	check("P15b nothing is lost while merging", (allText.match(/\n\n/g) || []).length === 20);
	const two = createThinkingGate({ mode: "paragraph", minBytes: 0, minIntervalMs: 0, idleMs: 1e9 });
	let f2 = 0;
	for (let i = 0; i < 20; i++) if (two.push(`short point ${i}\n\n`, 1000 + i * 100).emit) f2++;
	check("P15c with minBytes:0 the same stream fragments into 20 frames (the control)", f2 === 20);
	const idleBreak = createThinkingGate({ mode: "paragraph", minBytes: 4096, minIntervalMs: 0, idleMs: 500, maxHoldMs: 500, maxBytes: 1e9, maxLines: 1e9 });
	idleBreak.push("tiny\n\n", 1000);
	const r = idleBreak.idle(1600);
	check("P15d the floor never defeats the idle rule (a small paragraph still shows up, boundary-aligned)",
		r.emit === "tiny\n\n" && (r.reason === "paragraph" || r.reason === "idle"), `reason=${r.reason}`);
}

// ─────────────────────────────────────────────── S: simulation stats (the measurement harness)
{
	const stream = deltaStream(THINKING, 25);
	let primary = "";
	const PURE_PARAGRAPH = { mode: "paragraph", maxLines: 1e9, maxBytes: 1e9, minBytes: 0, minIntervalMs: 0, idleMs: 1e9 };
	const sim = simulateThinking(stream, { policy: PURE_PARAGRAPH, stepMs: 40 });
	check("S1 the simulated stream reproduces the reasoning text exactly",
		sim.frames.map((f) => f.text).join("") === THINKING);
	check("S2 paragraph mode emits one frame per completed paragraph, not one per delta",
		sim.stats.frames === PARAGRAPHS && sim.stats.pushes === stream.length,
		`${sim.stats.frames} frames / ${sim.stats.pushes} deltas`);
	check("S3 every frame carries a reason (auditable in the hub log)",
		sim.stats.reasons.every((r) => ["paragraph", "lines", "bytes", "idle", "end"].includes(r)));

	// with a REALISTIC preset the wait is bounded by the idle rule + one push of granularity
	// the soft idle rule, isolated (minBytes:0): the wait is the idle window + one push of granularity
	const softIdle = simulateThinking(stream, { policy: { mode: "paragraph", minBytes: 0, maxLines: 1e9, maxBytes: 1e9, minIntervalMs: 0, idleMs: 1500, maxHoldMs: 1e9 }, stepMs: 40 });
	check("S4 the visible wait stays inside the idle window (reasoning never stalls for a whole turn)",
		softIdle.stats.maxWaitMs <= 1500 + 2 * 40, `max wait ${softIdle.stats.maxWaitMs}ms, median ${softIdle.stats.medianWaitMs}ms`);
	check("S4b the SHIPPED wan preset bounds every wait by its hard ceiling and keeps frames modest",
		(() => {
			const wan = resolveThinkingPolicy("wan", {});
			const p = simulateThinking(stream, { policy: wan, stepMs: 40 });
			primary = `wan: ${p.stats.frames} frames, max wait ${p.stats.maxWaitMs}ms (ceiling ${wan.maxHoldMs}ms), median ${p.stats.medianWaitMs}ms`;
			return p.stats.maxWaitMs <= wan.maxHoldMs + 2 * 40 && p.stats.frames >= PARAGRAPHS && p.stats.frames <= stream.length / 10;
		})(), primary);

	// isolated thresholds (no idle/byte cap in the way) → a clean ordering to quote in the review
	const lines = simulateThinking(stream, { policy: { mode: "lines", maxLines: 8, maxBytes: 1e9, minBytes: 0, minIntervalMs: 0, idleMs: 1e9 }, stepMs: 40 });
	const end = simulateThinking(stream, { policy: { mode: "end" }, stepMs: 40 });
	const off = simulateThinking(stream, { policy: { mode: "off" }, stepMs: 40 });
	check("S5 frame counts are ordered: off >> paragraph > lines > end",
		off.stats.frames === stream.length && off.stats.frames > sim.stats.frames && sim.stats.frames > lines.stats.frames && lines.stats.frames > end.stats.frames,
		`off=${off.stats.frames} paragraph=${sim.stats.frames} lines=${lines.stats.frames} end=${end.stats.frames}`);
	check("S5b end-of-turn mode is exactly one frame per thinking block", end.stats.frames === 1);
	check("S6 the total TEXT is identical across every mode (only the piping changes)",
		off.stats.characters === sim.stats.characters && sim.stats.characters === lines.stats.characters && lines.stats.characters === end.stats.characters);
	check("S7 an empty stream emits nothing at all",
		simulateThinking([], { policy: { mode: "paragraph" } }).stats.frames === 0);
	check("S8 a scripted { delta, at } stream is honoured (tests the real timing paths)",
		(() => { const s = simulateThinking([{ delta: "a\n\n", at: 5000 }, { delta: "b", at: 5040 }], { policy: { mode: "paragraph", minBytes: 0, minIntervalMs: 0, idleMs: 9999 } }); return s.frames.length === 2 && s.frames[0].at === 5000; })());
}

// ───────────────────────────── W: the billed half — real deflate at the socket's own settings
{
	const stream = deltaStream(THINKING, 25);
	const texts = (mode, policy = {}) => simulateThinking(stream, { policy: { mode, ...policy } }).frames.map((f) => f.text);

	const live = wireBytes(texts("off"));
	// pure paragraph boundaries (no idle/byte caps) → every frame is a whole paragraph
	const paraFrames = texts("paragraph", { maxLines: 1e9, maxBytes: 1e9, minBytes: 0, minIntervalMs: 0, idleMs: 1e9 });
	const endFrames = texts("end");
	const paraWire = wireBytes(paraFrames);
	const endWire = wireBytes(endFrames);

	check("W1 per-delta frames sit under the 1024B threshold → deflate is SKIPPED (§8.13)",
		simulateThinking(stream, { policy: { mode: "off" } }).stats.frameBytes.every((b) => !deflateEligible(b, WS_DEFLATE)) &&
		live.compressed === live.raw,
		`every frame < ${WS_DEFLATE.threshold}B → 0 savings on the wire`);
	check("W2 coalesced thinking wakes the compressor up (every frame ≥ threshold)",
		paraFrames.length === PARAGRAPHS && paraFrames.every((t) => deflateEligible(frameBytes({ type: "thinking_update", text: t }), WS_DEFLATE)),
		paraFrames.map((t) => frameBytes({ type: "thinking_update", text: t })).join(","));
	check("W3 paragraph mode cuts the wire bytes substantially with real level-6 deflate",
		paraWire.compressed < live.compressed * 0.5,
		`live ${live.compressed}B → paragraph ${paraWire.compressed}B (saved ${(paraWire.saved * 100).toFixed(0)}% of the ${paraWire.raw}B of text)`);
	check("W3b …and cuts the FRAME count at the same time",
		paraWire.frames < live.frames / 5, `${live.frames} → ${paraWire.frames} frames`);
	check("W4 end-of-turn is the cheapest possible framing, and the latest",
		endWire.compressed <= paraWire.compressed && endWire.frames === 1,
		`end ${endWire.compressed}B / 1 frame vs paragraph ${paraWire.compressed}B / ${paraWire.frames} frames`);

	// THE COUNTER-CASE that decides the preset numbers: 400 one-line paragraphs (a checklist, a table,
	// a stream of ids/hashes) with mostly UNCOMPRESSIBLE bytes. Here deflate buys almost nothing, so
	// the frame count and the ~45B JSON wrapper per frame are the whole story — and a paragraph
	// boundary that is SMALLER than the socket's deflate threshold is a frame that travels raw.
	let seed = 0x2f6e2b1;
	const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed; };
	const noisy = Array.from({ length: 400 }, (_, i) => `${i}: ${(rnd() % 36 ** 6).toString(36).padStart(6, "0")}\n\n`).join("");
	const noisyStream = deltaStream(noisy, 25);
	const HUGE = { maxLines: 1e9, maxBytes: 1e9, minIntervalMs: 0, idleMs: 1e9 };
	const noisyWire = (minBytes) => wireBytes(simulateThinking(noisyStream, { policy: { mode: "paragraph", minBytes, ...HUGE } }).frames.map((f) => f.text));
	const noisyLive = wireBytes(simulateThinking(noisyStream, { policy: { mode: "off" } }).frames.map((f) => f.text));
	const noisyNoFloor = noisyWire(0);
	const noisyPara = noisyWire(256);
	const noisyBig = noisyWire(2048);
	check("W5 with uncompressible tiny paragraphs the frame count is the win",
		noisyPara.frames < noisyNoFloor.frames && noisyPara.compressed < noisyNoFloor.compressed,
		`one frame per paragraph-boundary ${noisyNoFloor.frames} → floor256 ${noisyPara.frames} frames, bytes ${noisyNoFloor.compressed} → ${noisyPara.compressed}`);
	check("W5b the minBytes floor is what removes the per-frame wrapper cost",
		noisyPara.compressed < noisyLive.compressed && noisyPara.frames < noisyLive.frames,
		`live ${noisyLive.compressed}B / ${noisyLive.frames} frames vs paragraph+floor ${noisyPara.compressed}B / ${noisyPara.frames} frames`);
	// the design rule this measurement produces: a coalesced frame only gets COMPRESSED when it
	// clears the socket's threshold, so the floor should sit at (or above) it.
	const bigFrames = simulateThinking(noisyStream, { policy: { mode: "paragraph", minBytes: 2048, ...HUGE } }).frames.map((f) => f.text);
	check("W7 frames below the deflate threshold are sent RAW — the floor must clear it",
		noisyWire(256).frames > 0 && simulateThinking(noisyStream, { policy: { mode: "paragraph", minBytes: 256, ...HUGE } }).stats.frameBytes.some((b) => !deflateEligible(b, WS_DEFLATE)),
		`floor256 frames: ${simulateThinking(noisyStream, { policy: { mode: "paragraph", minBytes: 256, ...HUGE } }).stats.frameBytes.slice(0, 3).join(",")}B (<${WS_DEFLATE.threshold})`);
	check("W7b …and with a floor at the threshold every coalesced frame is compressed",
		bigFrames.slice(0, -1).every((t) => deflateEligible(frameBytes({ type: "thinking_update", text: t }), WS_DEFLATE)) && bigFrames.length < noisyPara.frames,
		`floor2048: ${bigFrames.length} frames, wire ${noisyBig.compressed}B vs floor256 ${noisyPara.compressed}B`);
	check("W7c …so every shipped preset's floor IS the socket threshold (that is the fix the bench forced)",
		THINKING_PRESETS.wan.minBytes >= WS_DEFLATE.threshold && THINKING_PRESETS.metered.minBytes >= WS_DEFLATE.threshold,
		`lan ${THINKING_PRESETS.lan.minBytes}B (fast lane, may stay small), wan ${THINKING_PRESETS.wan.minBytes}B, metered ${THINKING_PRESETS.metered.minBytes}B vs threshold ${WS_DEFLATE.threshold}B`);

	// and the threshold experiment from plan §2.1 (1024 → 256), on LARGER deltas (400 chars — the
	// only ones a lower threshold can help at all): it wins on those frames but still loses to
	// coalescing, which is why the flush thresholds come first and the threshold flip is optional.
	const chunky = simulateThinking(deltaStream(THINKING, 400), { policy: { mode: "off" } }).frames.map((f) => f.text);
	const chunky1024 = wireBytes(chunky);
	const chunky256 = wireBytes(chunky, { threshold: 256 });
	check("W6 a 400-char delta stream is invisible to deflate at 1024 and compresses at 256",
		chunky1024.compressed === chunky1024.raw && chunky256.compressed < chunky1024.compressed,
		`live@1024 ${chunky1024.compressed}B → live@256 ${chunky256.compressed}B`);
	check("W6b but even then coalescing to paragraphs beats it",
		paraWire.compressed <= chunky256.compressed,
		`paragraph@1024 ${paraWire.compressed}B vs live@256 ${chunky256.compressed}B`);
}

// ─────────────────────────────────────────── A: the extraction both sides need
{
	const message = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "first thought", thinkingSignature: "sig" },
			{ type: "text", text: "the answer" },
			{ type: "thinking", thinking: " second thought" },
			{ type: "toolCall", name: "read", arguments: {} },
		],
	};
	check("A1 assistantThinkingText joins every thinking part in order",
		assistantThinkingText(message) === "first thought second thought");
	check("A2 assistantStreamText takes text parts only (not thinking, not tool calls)",
		assistantStreamText(message) === "the answer");
	check("A3 a redacted/empty thinking part contributes nothing",
		assistantThinkingText({ content: [{ type: "thinking", redacted: true }] }) === "" &&
		assistantThinkingText({ content: [{ type: "thinking", thinking: "" }] }) === "");
	check("A4 non-message input is an empty string, never a throw",
		assistantThinkingText(null) === "" && assistantThinkingText({ content: "plain" }) === "" && assistantStreamText({ content: "plain" }) === "plain");
}

console.log(`\n[thinking-flush] ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
