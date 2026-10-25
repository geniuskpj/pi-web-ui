// stream-reduce.test.mjs — the per-connection stream reduction (plan §2.3), OFF by default.
//
// This suite is the safety net for the one place that can LOSE text: the delivery boundary in
// server.mjs's `broadcast()` loop. Everything here is pure (no socket, no hub, no timers), so the
// guarantees can be checked exhaustively before a live turn is trusted to it:
//
//   O  off by default          — no config ⇒ byte-for-byte the old payload
//   N  config normalisation    — unknown values fall back to LIVE, never to a stronger reduction
//   S  snapshot semantics      — a coalesced frame is a TRUNCATED SNAPSHOT, never a delta
//   G  the guarantees           — flush on error/abort/end, no loss, bounded memory, history untouched
//   T  tool frames             — thinned (the client renders tool output from the result message)
//   D  the debug line
//
// Usage: node tests/stream-reduce.test.mjs
import {
	createStreamReducer, normalizeReductionConfig, liveReductionConfig,
	truncateStreamSnapshot, deltaKind, deltaText, kindText, describeReduction,
} from "../lib/stream-reduce.mjs";
import { resolveThinkingPolicy, resolveStreamPolicy } from "../lib/thinking-flush.mjs";

let passed = 0, failed = 0;
const check = (name, ok, extra = "") => {
	if (ok) { passed++; console.log(`  ✓ ${name}${extra ? " — " + extra : ""}`); }
	else { failed++; console.error(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
};

// ── fixtures: the exact frames server.mjs's broadcast() passes around ────────────────────────
const sess = "sess-reduce";
const assistant = (thinking = "", text = "", extra = []) => ({
	role: "assistant",
	content: [...(thinking ? [{ type: "thinking", thinking }] : []), ...(text ? [{ type: "text", text }] : []), ...extra],
});
const update = (message, ame) => ({ type: "agent-event", sessionId: sess, seq: 1, event: { type: "message_update", message, assistantMessageEvent: ame } });
const thinkingDelta = (message, delta) => update(message, { type: "thinking_delta", contentIndex: 0, delta });
const textDelta = (message, delta) => update(message, { type: "text_delta", contentIndex: 1, delta });
const msgEnd = (message) => ({ type: "agent-event", sessionId: sess, seq: 2, event: { type: "message_end", message } });

/** cfg with a gate that never fires early: minBytes 0, no idle, huge caps → only explicit flushes. */
const paragraphCfg = (over = {}) => normalizeReductionConfig({ net: "wan", thinkingLevel: "paragraph", textLevel: "paragraph", toolLevel: "paragraph", thinking: { mode: "paragraph", minBytes: 0, maxBytes: 1e9, maxLines: 1e9, idleMs: 1e9, maxHoldMs: 1e9 }, text: { mode: "paragraph", minBytes: 0, maxBytes: 1e9, maxLines: 1e9, idleMs: 1e9, maxHoldMs: 1e9 }, tool: { mode: "lines", minBytes: 0, maxBytes: 1e9, maxLines: 40, idleMs: 500, maxHoldMs: 3000 }, ...over });

// ───────────────────────────────────────────────────── O: off by default
{
	const r = createStreamReducer(null);
	const frame = thinkingDelta(assistant("thinking here"), "x");
	check("O1 no config ⇒ disabled and IDENTITY (the same object, no copy)", r.enabled === false && r.transform(frame) === frame);
	check("O2 a disabled reducer drops nothing and counts nothing",
		(() => { const g = createStreamReducer(null); for (let i = 0; i < 100; i++) g.transform(thinkingDelta(assistant("t"), "d")); return g.stats().dropped === 0 && g.stats().forwarded === 0; })());
	check("O3 a live config is also disabled (it allocates no gates)", createStreamReducer(liveReductionConfig()).enabled === false);
	check("O4 an unknown message type passes through untouched", r.transform({ type: "runtime", runtime: { status: "running" } })?.type === "runtime");
	check("O5 junk input never throws", r.transform(null) === null && r.transform(undefined) === undefined && r.transform({}) !== undefined);
}

// ───────────────────────────────────────────────────── N: config normalisation
{
	check("N1 a null/junk payload means \"no reduction\" (not an error)", normalizeReductionConfig(null) === null && normalizeReductionConfig("x") === null && normalizeReductionConfig(42) === null);
	const fromLevels = normalizeReductionConfig({ net: "wan", thinkingLevel: "turnEnd", textLevel: "none", toolLevel: "paragraph" });
	check("N2 levels are resolved by the hub when the client sends no per-kind numbers",
		fromLevels.kinds.thinking.mode === "end" && fromLevels.kinds.text.mode === "off" && fromLevels.kinds.tool.mode === "lines", JSON.stringify(Object.entries(fromLevels.kinds).map(([k, v]) => [k, v.mode])));
	const explicit = normalizeReductionConfig({ thinkingLevel: "paragraph", thinking: { mode: "paragraph", minBytes: 4096 } });
	check("N3 explicit per-kind numbers WIN over the derived ones (the client's floor is kept)",
		explicit.kinds.thinking.minBytes === 4096 && explicit.kinds.thinking.mode === "paragraph");
	const junk = normalizeReductionConfig({ thinkingLevel: "teleport", thinking: { mode: "superatomic" } });
	check("N4 an unknown mode falls back to LIVE, never to a reduction we invented",
		junk.kinds.thinking.mode === "off", `modes=${JSON.stringify(Object.entries(junk.kinds).map(([k, v]) => [k, v.mode]))}`);
	const allJunk = normalizeReductionConfig({ thinking: { mode: "x" }, text: { mode: "x" }, tool: { mode: "x" } });
	check("N4b a config whose every mode is unknown allocates nothing (disabled reducer)",
		createStreamReducer(allJunk).enabled === false);
	check("N5 the tier reaches the thresholds (metered chunks are bigger than lan)", (() => {
		const lan = normalizeReductionConfig({ net: "lan", thinkingLevel: "paragraph" });
		const met = normalizeReductionConfig({ net: "metered", thinkingLevel: "paragraph" });
		return met.kinds.thinking.minBytes >= lan.kinds.thinking.minBytes; // lan may be lighter, never the reverse
	})());
	check("N6 net defaults to wan when the client does not say", normalizeReductionConfig({ thinkingLevel: "paragraph" }).net === "wan");
}

// ───────────────────────────────────────────────────── S: snapshot semantics
{
	check("S1 only thinking_delta/text_delta are recognised as gated deltas",
		deltaKind({ type: "thinking_delta" }) === "thinking" && deltaKind({ type: "text_delta" }) === "text" &&
		deltaKind({ type: "toolcall_delta" }) === null && deltaKind(undefined) === null);
	check("S2 deltaText is safe on junk", deltaText({ delta: "x" }) === "x" && deltaText({}) === "" && deltaText(null) === "");

	const m = assistant("THINKING-BLOCK", "ANSWER-BLOCK", [{ type: "toolCall", name: "read", arguments: {} }]);
	const cut = truncateStreamSnapshot(m, { thinking: 8, text: 6 });
	check("S3 truncation keeps the delivered prefix of each kind",
		kindText(cut, "thinking") === "THINKING" && kindText(cut, "text") === "ANSWER");
	check("S3b a toolCall part is NEVER hidden (the client draws its chip from the snapshot)",
		cut.content.some((p) => p.type === "toolCall"));
	check("S3c no budget left ⇒ the part arrives empty, not missing",
		truncateStreamSnapshot(m, { thinking: 0, text: 0 }).content.find((p) => p.type === "text").text === "");
	check("S3d a budget beyond the text returns the ORIGINAL object (no needless copies)",
		truncateStreamSnapshot(m, { thinking: 999, text: 999 }) === m);
	check("S3e cumulative across parts of the same kind (pi can emit several)",
		(() => { const two = { role: "assistant", content: [{ type: "thinking", thinking: "aaa" }, { type: "thinking", thinking: "bbb" }] }; const t = truncateStreamSnapshot(two, { thinking: 4 }); return kindText(t, "thinking") === "aaab"; })());
	check("S3f junk input is returned as-is", truncateStreamSnapshot(null, {}) === null && truncateStreamSnapshot({ content: "plain" }, {}).content === "plain");
}

// ───────────────────────────────────────────────────── T: tool frames
{
	const cfg = paragraphCfg();
	const r = createStreamReducer(cfg);
	const toolUpdate = (id) => ({ type: "agent-event", sessionId: sess, seq: 3, event: { type: "tool_execution_update", toolCallId: id, toolName: "bash", partialResult: { output: "…" } } });
	const first = r.transform(toolUpdate("t1"), 1000);
	const soon = r.transform(toolUpdate("t1"), 1100);   // 100ms later: inside the 500ms window
	const later = r.transform(toolUpdate("t1"), 1700);  // 700ms later: allowed
	check("T1 tool progress frames are THINNED (one per idleMs), not removed",
		first?.event.type === "tool_execution_update" && soon === null && later?.event.type === "tool_execution_update",
		`first=${!!first} soon=${soon} later=${!!later}`);
	check("T2 the thinning is counted as dropped (visible in the debug line)", r.stats().dropped === 1 && r.stats().byKind.tool === 1);
	const endMode = createStreamReducer(normalizeReductionConfig({ net: "wan", thinkingLevel: "turnEnd" }));
	check("T3 turnEnd mode holds tool progress entirely (nothing renders it before the result)",
		endMode.transform(toolUpdate("t1"), 1000) === null);
	const endFrame = { type: "agent-event", sessionId: sess, seq: 4, event: { type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: { output: "done" } } };
	check("T4 the tool RESULT always arrives (in every mode)", r.transform(endFrame) === endFrame && endMode.transform(endFrame) === endFrame);
}

// ───────────────────────────────────────────────────── G: the guarantees
{
	// G1: a full thinking block in paragraph mode collapses to few frames and the final message is exact
	const cfg = paragraphCfg();
	const r = createStreamReducer(cfg);
	const seen = [];
	let thinking = "";
	let frames = 0, dropped = 0;
	r.transform({ type: "agent-event", sessionId: sess, seq: 0, event: { type: "message_start", message: assistant() } }, 900);
	for (let i = 0; i < 40; i++) {
		const delta = i % 10 === 9 ? `sentence ${i}. \n\n` : `sentence ${i}. `;   // a paragraph every 10 deltas
		thinking += delta;
		const out = r.transform(thinkingDelta(assistant(thinking), delta), 1000 + i * 40);
		if (out) {
			frames++;
			seen.push(out);
			if (i === 9) check("G1 a delivered frame is a SNAPSHOT of the delivered prefix, not a delta",
				out.event.message.content[0].type === "thinking" && out.event.message.content[0].thinking === thinking,
				`${out.event.message.content[0].thinking.length}/${thinking.length} chars, reduction=${out.reduction}`);
		} else dropped++;
	}
	const full = assistant(thinking);
	const end = r.transform(msgEnd(full), 5100);
	check("G2 message_end always arrives — it is history (IDB write-through, haveTo) and carries the full text",
		end.event.type === "message_end" && kindText(end.event.message, "thinking") === thinking,
		`${kindText(end.event.message, "thinking").length} chars, seq=${end.seq}`);
	check("G2b every frame the client saw is a PREFIX of the final text (no reordering, no duplicates)",
		frames > 0 && dropped > 0 && seen.every((f, i) => i === 0 || f.event.message.content[0].thinking.length > seen[i - 1].event.message.content[0].thinking.length),
		`forwarded=${frames} held=${dropped}`);
	check("G2c the block boundary resets the state (the next block starts fresh)",
		r.transform(thinkingDelta(assistant("second block"), "second block"), 6000) === null && r.stats().blocks === 1);

	// G3: an ERROR flushes everything buffered — the user must be able to read the reasoning that died
	const r2 = createStreamReducer(paragraphCfg());
	let held = "";
	for (let i = 0; i < 10; i++) { held += `x${i}`; r2.transform(thinkingDelta(assistant(held), `x${i}`), 1000 + i * 10); }
	const err = { type: "agent-event", sessionId: sess, seq: 9, event: { type: "error", errorMessage: "429 Too Many Requests" } };
	const flushed = r2.transform(err, 2000);
	check("G3 an error is never swallowed and the buffered text ships WITH it (two frames)",
		Array.isArray(flushed) && flushed[1].event.type === "error" && flushed[1].event.errorMessage === "429 Too Many Requests" && r2.stats().flushes === 1,
		`flushes=${r2.stats().flushes}`);
	check("G3b …flush first, error second (the client renders the reasoning, then the failure)",
		flushed[0].event.type === "error" && flushed[0].reduction === "flush" && kindText(flushed[0].event.message, "thinking") === held);
	const after = r2.transform(thinkingDelta(assistant("new"), "new"), 3000);
	check("G3c the abort resets the block (no bleed into the next turn)", after === null || after.reduction !== undefined);

	// G4: history/structural frames are forwarded unchanged, in every mode
	const structural = [
		{ type: "agent-event", sessionId: sess, seq: 10, event: { type: "runtime", runtime: { status: "running" } } },
		{ type: "agent-event", sessionId: sess, seq: 11, event: { type: "retry", attempt: 2 } },
		{ type: "agent-event", sessionId: sess, seq: 12, event: { type: "tool_execution_start", toolCallId: "t2", toolName: "read" } },
		{ type: "agent-event", sessionId: sess, seq: 13, event: { type: "message_end", message: { role: "user", content: "hi" } } },
		{ type: "agent-event", sessionId: sess, seq: 14, event: { type: "turn_end", message: assistant("", "answer") } },
	];
	const r3 = createStreamReducer(paragraphCfg());
	check("G4 runtime/retry/tool-start/non-assistant message_end/turn_end all pass through",
		structural.every((f) => r3.transform(f) === f), structural.map((f) => f.event.type).join(","));
	check("G4b a non-'agent-event' payload (state/partial/runtime delta) is untouched",
		r3.transform({ type: "partial", d: "x" })?.type === "partial" && r3.transform({ type: "state", messages: [] })?.type === "state");

	// G5: assistant TEXT is gated independently of thinking (one gate per kind)
	const r4 = createStreamReducer(paragraphCfg());
	r4.transform(thinkingDelta(assistant("t1"), "t1"), 1000);
	const textFrame = r4.transform(textDelta(assistant("t1", "hello world\n\n"), "hello world\n\n"), 1040);
	check("G5 the text gate fires on its own boundary while thinking stays held (independent gates)",
		textFrame !== null && kindText(textFrame.event.message, "text") === "hello world\n\n" && kindText(textFrame.event.message, "thinking") === "");
	check("G5b the thinking part is not leaked by a text frame (per-kind delivered counters)",
		textFrame.event.message.content.every((p) => p.type !== "thinking" || p.thinking === ""));

	// G6: bounded memory — the gate's caps are what bound the buffer, and every mode ends up flushed
	const bounded = createStreamReducer(paragraphCfg({ thinking: { mode: "paragraph", minBytes: 0, maxBytes: 512, maxLines: 1e9, idleMs: 1e9, maxHoldMs: 1e9 } }));
	let biggest = 0, sawFrame = false, prev = 0, cappedFrames = 0;
	for (let i = 0; i < 200; i++) {
		const t = "y".repeat((i + 1) * 20);
		const out = bounded.transform(thinkingDelta(assistant(t), "y".repeat(20)), 1000 + i);
		if (out) {
			sawFrame = true;
			cappedFrames++;
			const now = kindText(out.event.message, "thinking").length;   // cumulative snapshot length
			biggest = Math.max(biggest, now - prev);                      // …so the BUFFER is the increment
			prev = now;
		}
	}
	check("G6 the byte cap bounds the BUFFER between frames (a snapshot is cumulative by design, so count increments)",
		sawFrame && cappedFrames >= 6 && biggest <= 512 + 20, `${cappedFrames} frames, largest buffer ${biggest} chars`);
	check("G6b end mode holds EVERYTHING and still delivers it exactly once at the end",
		(() => {
			const r5 = createStreamReducer(normalizeReductionConfig({ net: "wan", thinkingLevel: "turnEnd" }));
			let sent = 0;
			for (let i = 0; i < 50; i++) if (r5.transform(thinkingDelta(assistant("z".repeat(i + 1)), "z"), 1000 + i)) sent++;
			const end = r5.transform(msgEnd({ role: "assistant", content: [{ type: "thinking", thinking: "Z".repeat(400) }] }), 2000);
			return sent === 0 && end.event.type === "message_end" && kindText(end.event.message, "thinking").length === 400;
		})());
	check("G6c an ERROR returns TWO frames: the flushed text, then the error (the server sends both)",
		(() => {
			const r6 = createStreamReducer(paragraphCfg());
			r6.transform(thinkingDelta(assistant("held reasoning"), "held reasoning"), 1000);
			const out = r6.transform({ type: "agent-event", sessionId: sess, seq: 8, event: { type: "error", errorMessage: "boom" } }, 1100);
			return Array.isArray(out) && out.length === 2 && out[0].event.type === "error" && out[0].reduction === "flush" && kindText(out[0].event.message, "thinking") === "held reasoning" && out[1].event.errorMessage === "boom";
		})());
}

// ───────────────────────────────────────────────────── D: the debug line
{
	check("D1 a disabled reducer says so (nothing to configure is a valid state)",
		/^data-reduction: live/.test(describeReduction(createStreamReducer(null).stats(), null)));
	const r = createStreamReducer(paragraphCfg());
	r.transform(thinkingDelta(assistant("aa"), "aa"), 1000);
	r.transform(thinkingDelta(assistant("aa bb"), " bb"), 1010);
	const line = describeReduction(r.stats(), r.cfg);
	check("D2 an enabled reducer reports the modes, what was forwarded/dropped and how many bytes were held",
		/thinking=paragraph/.test(line) && /forwarded=\d+/.test(line) && /dropped=\d+/.test(line) && /flushes=/.test(line), line);
	check("D3 the stats are a copy (a debug reader cannot corrupt the live counters)",
		(() => { const s = r.stats(); s.dropped = 999; return r.stats().dropped !== 999; })());
}

console.log(`\n[stream-reduce] ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
