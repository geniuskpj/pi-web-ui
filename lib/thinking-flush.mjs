// lib/thinking-flush.mjs — PURE gate that decides WHEN streamed reasoning ("thinking") is sent.
//
// THE QUESTION THIS ANSWERS (user, 2026-10-25): "should the client wait until the thinking turn
// ends, or send thinking at a paragraph / line threshold?"  Waiting for the end is the cheapest
// in frames and bytes but hides reasoning for the whole turn; streaming every delta costs a frame
// per delta AND — because the agent socket negotiates `perMessageDeflate: { threshold: 1024 }` —
// almost every one of those frames travels UNCOMPRESSED (below the threshold the compressor is
// skipped entirely). So this is a compression decision, not only a frame-count decision.
//
// WHERE THE DELTAS COME FROM (verified in the vendored types, pi-agent-core 1.4.0):
//   agent event `message_update` carries `assistantMessageEvent`, and for reasoning models that is
//   `{ type: "thinking_delta", contentIndex, delta, partial }` — a real incremental delta. The
//   `partial` AssistantMessage holds `{ type: "thinking", thinking, thinkingSignature? }` parts.
//   So the server-side wiring is: on thinking_delta → gate.push(delta, Date.now()) and forward the
//   emitted string; on thinking_end/message_end/error → gate.flush(). `assistantThinkingText()`
//   below is the same extraction used by the client renderer/state snapshot.
//
// TIME IS INJECTED (no timers here): the gate is deterministic, so the paragraph/line/byte/idle
// thresholds are unit-testable without sleeping. The caller owns the idle timer (a 500ms tick
// calling `gate.idle(now)` is enough) — lib/ stays pure, tests stay fast.

import { frameBytes, utf8Bytes } from "./data-reduction.mjs";

/** The MODE a gate runs in. "lines" is an internal variant (a pure line-count threshold); the
 *  USER picks one of THREE levels, which map straight onto these modes. */
export const THINKING_MODES = ["off", "paragraph", "lines", "end"];

/**
 * THE USER-FACING STREAM PRESET — three options:
 *   paragraph  send a frame per complete paragraph (plus the byte/idle caps)   → mode "paragraph"
 *   turnEnd    send ONE frame when the message/tool call ends                  → mode "end"
 *   none       no reduction at all: every delta goes out live (no wait)         → mode "off"
 *   auto       follow the link tier (all tiers default to paragraph today)
 * The SAME three levels drive the assistant's visible text and tool-call output, whose thresholds
 * differ per kind (see STREAM_KIND_PRESETS) — the user picks the policy once, not per stream.
 */
export const THINKING_LEVELS = ["auto", "paragraph", "turnEnd", "none"];
export const THINKING_LEVEL_MODES = { paragraph: "paragraph", turnEnd: "end", none: "off" };

/** Which level `auto` means on this link. Chunk thresholds still follow the tier; a metered link is
 *  simply not allowed to be chattier than paragraphing. */
export function thinkingLevelForNet() {
	return "paragraph";
}

/** Per-link presets. Metered links get BIGGER chunks (fewer frames, longer wait);
 *  a wired link can afford to show reasoning almost immediately.
 *  `minBytes` is the anti-fragmentation floor and it is NOT optional trivia: a reasoning stream of
 *  many TINY paragraphs (a checklist, a table, a stream of one-liners) would otherwise cost one
 *  frame PER PARAGRAPH, and the ~40-byte JSON wrapper would make paragraph framing bigger than
 *  per-delta streaming. Below the floor the gate merges paragraphs.
 *
 *  MEASURED LESSON (tests/data-reduction.bench.mjs): the floor must be at least the SOCKET's
 *  permessage-deflate threshold (1024B in server.mjs) or the coalesced frames still travel RAW —
 *  the first edition of these presets cut frames to ~740B and saved 60% instead of 93%.
 *
 *  `idleMs` (soft keep-alive) and `maxHoldMs` (hard visibility ceiling) are two different promises:
 *  the soft rule only fires once the buffer holds `minBytes` (so the frame is worth compressing),
 *  the hard rule fires no matter what (the user must never stare at a frozen reasoning block).
 *  Without the second number, a slow model would silently stall reasoning for the whole turn. */
export const THINKING_PRESETS = {
	lan:     { mode: "paragraph", maxLines: 4,  maxBytes: 1024, minBytes: 256,  minIntervalMs: 150, idleMs: 800,  maxHoldMs: 1200, firstBytes: 64 },
	wan:     { mode: "paragraph", maxLines: 8,  maxBytes: 2048, minBytes: 1024, minIntervalMs: 250, idleMs: 1500, maxHoldMs: 2500, firstBytes: 64 },
	metered: { mode: "lines",     maxLines: 16, maxBytes: 4096, minBytes: 1024, minIntervalMs: 400, idleMs: 2500, maxHoldMs: 4000, firstBytes: 64 },
};

/**
 * FIRST FRAME, IMMEDIATELY — the user-visible half of the whole feature (review 2026-10-27, the
 * "thinking returns too slowly" report). A coalescing gate that waits for a paragraph/1KB/idle would
 * leave the chat showing "thinking…" for 1.5-2.5 s SECOND time a block starts, which reads as a
 * regression even though the total byte count is tiny. So the FIRST chunk of every block is released
 * as soon as it holds `firstBytes` (a few words): the UI starts exactly like live streaming, and
 * everything after it is coalesced. Cost: one extra frame per block (~60-160B, and it is itself
 * deflate-eligible only above the threshold, i.e. it is cheap by construction).
 */
export const FIRST_BYTES = 64;

/**
 * THE THREE STREAMS the same thresholds apply to (user request: "apply same/similar threshold on
 * assist's last turn or Tool call too"):
 *   thinking — reasoning deltas. Big frames are fine; nobody reads them word by word.
 *   text     — the assistant's VISIBLE answer. The floors are small and the idle rule is tight
 *              (600ms): a reader must see prose arriving, so we never trade latency for frames here.
 *   tool     — tool output (build logs, `ls`, test runs). Line- AND byte-thresholded, big frames
 *              (≥2KB, 40 lines), because tool output is bulk nobody reads token by token.
 * A stream's LEVEL always comes from the user's choice (text/tool may be pinned separately, and
 * default to the thinking level), so "turnEnd" really does hold the last assistant turn and the
 * tool result too — not just the reasoning.
 */
export const STREAM_KINDS = ["thinking", "text", "tool"];
export const STREAM_KIND_PRESETS = {
	// the ANSWER is what a reader follows word by word: the floor and the ceiling are deliberately
	// small so prose keeps arriving (a 1.2 s stall in the visible answer IS the latency regression
	// users notice), while bursts still collapse.
	text: { mode: "paragraph", maxLines: 6,  maxBytes: 2048, minBytes: 128,  minIntervalMs: 120, idleMs: 300,  maxHoldMs: 600, firstBytes: 32 },
	tool: { mode: "lines",     maxLines: 40, maxBytes: 8192, minBytes: 2048, minIntervalMs: 250, idleMs: 1000, maxHoldMs: 3000, firstBytes: 512 },
};

/** How long a full turn-end wait looks to the user: only used for docs/tests, never for logic. */
export const THINKING_HELD_REASON = "held";

/** net: "lan" | "wan" | "metered" (or transferPolicy()'s "fast"/"metered").
 *  settings: pi.thinkingLevel (the three-option preset), pi.thinkingFlush (internal override),
 *  pi.thinkingMaxLines / pi.thinkingMaxBytes / pi.thinkingIdleMs / pi.thinkingMaxHoldMs. */
export function resolveThinkingPolicy(net, settings = {}) {
	const key = net === "fast" ? "lan" : net === "metered" ? "metered" : (THINKING_PRESETS[net] ? net : "wan");
	const base = THINKING_PRESETS[key];
	// the user's LEVEL wins; legacy/internal values ("lines", "off") are still accepted as overrides
	const chosen = settings.thinkingLevel;
	const want = THINKING_LEVELS.includes(chosen) && chosen !== "auto" ? THINKING_LEVEL_MODES[chosen] : settings.thinkingFlush;
	const mode = THINKING_MODES.includes(want) && want !== "auto" ? want : base.mode;
	const lines = Number(settings.thinkingMaxLines);
	const bytes = Number(settings.thinkingMaxBytes);
	const idle = Number(settings.thinkingIdleMs);
	const min = Number(settings.thinkingMinBytes);
	const hold = Number(settings.thinkingMaxHoldMs);
	return {
		net: key,
		// atomic turns suppress assistant deltas wholesale → hold reasoning with them
		level: THINKING_LEVELS.includes(chosen) && chosen !== "auto" ? chosen : thinkingLevelForNet(key),
		levelSource: THINKING_LEVELS.includes(chosen) && chosen !== "auto" ? "user" : "auto",
		mode,
		maxLines: Number.isFinite(lines) && lines > 0 ? Math.round(lines) : base.maxLines,
		maxBytes: Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes) : base.maxBytes,
		minBytes: Number.isFinite(min) && min >= 0 ? Math.round(min) : base.minBytes,
		// first paint, immediately (see FIRST_BYTES): the presets all carry it
		firstBytes: Number.isFinite(Number(settings.thinkingFirstBytes)) && Number(settings.thinkingFirstBytes) >= 0
			? Math.round(Number(settings.thinkingFirstBytes)) : (base.firstBytes ?? FIRST_BYTES),
		minIntervalMs: Number.isFinite(Number(settings.thinkingMinIntervalMs)) && Number(settings.thinkingMinIntervalMs) >= 0
			? Number(settings.thinkingMinIntervalMs) : base.minIntervalMs,
		idleMs: Number.isFinite(idle) && idle >= 0 ? Math.round(idle) : base.idleMs,
		// never below idleMs: the hard ceiling is the OUTER bound of the soft one
		maxHoldMs: Number.isFinite(hold) && hold > 0 ? Math.max(Math.round(hold), Number.isFinite(idle) && idle >= 0 ? Math.round(idle) : base.idleMs) : base.maxHoldMs,
	};
}

/**
 * The policy for ONE stream kind. thinking → the net-tier numbers; text/tool → their own kind
 * presets, with the LEVEL shared: `pi.thinkingLevel` (or `pi.textLevel` / `pi.toolLevel` when the
 * user pins them apart). This is the "same threshold on the assistant text and the tool call" rule,
 * expressed once instead of three times.
 */
export function resolveStreamPolicy(kind, net, settings = {}) {
	if (kind === "thinking" || !STREAM_KINDS.includes(kind)) return { ...resolveThinkingPolicy(net, settings), kind: "thinking" };
	const thinking = resolveThinkingPolicy(net, settings);
	const chosen = settings[`${kind}Level`];
	const level = THINKING_LEVELS.includes(chosen) && chosen !== "auto" ? chosen : thinking.level;
	const base = STREAM_KIND_PRESETS[kind];
	const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : null);
	return {
		kind,
		net: thinking.net,
		level,
		levelSource: THINKING_LEVELS.includes(chosen) && chosen !== "auto" ? "user" : thinking.levelSource,
		// "paragraph" means "chunk at the kind's natural boundary": prose breaks on blank lines, tool
		// output on LINES (a build log has no paragraphs). turnEnd/none are absolute.
		mode: level === "paragraph" ? base.mode : (THINKING_LEVEL_MODES[level] || base.mode),
		maxLines: num(settings[`${kind}MaxLines`]) ?? base.maxLines,
		maxBytes: num(settings[`${kind}MaxBytes`]) ?? base.maxBytes,
		minBytes: Number.isFinite(Number(settings[`${kind}MinBytes`])) && Number(settings[`${kind}MinBytes`]) >= 0
			? Math.round(Number(settings[`${kind}MinBytes`])) : base.minBytes,
		firstBytes: base.firstBytes ?? FIRST_BYTES,
		minIntervalMs: base.minIntervalMs,
		idleMs: base.idleMs,
		maxHoldMs: base.maxHoldMs,
	};
}

/** One line of the ACTUAL parameters behind a stream policy — shown next to the selected option. */
export function describeStreamPolicy(policy = {}, kind = policy.kind || "thinking") {
	const what = { thinking: "reasoning", text: "the answer", tool: "tool output" }[kind] || kind;
	if (policy.mode === "off") return `None — ${what} streams live (every delta, no wait)${kind === "thinking" ? " · nothing is coalesced" : ""}`;
	if (policy.mode === "end") return `Turn end — ${what} is held and sent as ONE frame when the ${kind === "tool" ? "tool call" : "message"} ends`;
	const floor = policy.minBytes ? `≥${Math.round(policy.minBytes / 1024 * 10) / 10} KB/frame` : "no byte floor";
	const boundary = policy.mode === "lines"
		? `1 frame per ${policy.maxLines} line breaks or ${Math.round((policy.maxBytes || 0) / 1024)} KB`
		: `1 frame per paragraph or every ${((policy.idleMs || 0) / 1000).toFixed(1)} s, whichever comes first`;
	return `${policy.mode === "lines" ? "Line chunks" : "Paragraph"} · ${floor} · ${boundary} · first ${what} by ${(policy.maxHoldMs / 1000).toFixed(1)} s`;
}

/** Short form for a <select> option label. */
export function shortStreamParams(level, kind = "thinking") {
	if (level === "none") return "live, no reduction";
	if (level === "turnEnd") return "one frame at the end";
	if (level === "paragraph") return kind === "tool" ? "per paragraph / 2KB / 40 lines" : kind === "text" ? "per paragraph / 256B" : "per paragraph / 1KB";
	return "follows the connection";
}

/** The option list a settings dropdown renders. */
export function thinkingLevelOptions(kind = "thinking") {
	const label = { auto: "Auto", paragraph: "Paragraph (recommended)", turnEnd: "Turn end (one frame)", none: "None (live)" };
	return THINKING_LEVELS.map((value) => ({
		value,
		label: label[value],
		params: shortStreamParams(value, kind),
		resolved: value === "auto" ? "paragraph" : value,
	}));
}

/** Index just past the LAST blank line in `text` (a paragraph boundary), or -1.
 *  A blank line = "\n" + optional spaces/tabs (incl. \r) + "\n". */
export function paragraphBoundaryEnd(text) {
	const s = String(text ?? "");
	let best = -1;
	const re = /\r?\n[ \t]*\r?\n/g;
	let m;
	while ((m = re.exec(s))) best = m.index + m[0].length;
	return best;
}

/** Pending line breaks — `maxLines` is "this many newlines buffered", not logical lines. */
export function countLineBreaks(text) {
	const m = String(text ?? "").match(/\r?\n/g);
	return m ? m.length : 0;
}

/**
 * The gate. Deterministic, allocation-light, no timers.
 *   push(delta, now)   → { emit: string|null, reason, pendingBytes, pendingLines, frames }
 *   idle(now)          → same check as push("") (call it from a tick)
 *   flush(now, reason) → everything still pending (turn end / error / abort)
 *   reset(now)         → drop pending, keep the frame counter (per-turn state)
 * reasons: "off" | "first" | "paragraph" | "lines" | "bytes" | "idle" | "end" | "held" | "none"
 * `deferred: true` means a paragraph boundary was crossed but something held it back: the
 * min-interval rate limit, or the minBytes anti-fragmentation floor (tiny paragraphs merge).
 */
export function createThinkingGate(policy = {}) {
	const mode = THINKING_MODES.includes(policy.mode) ? policy.mode : "paragraph";
	// `kind` is informational (log/telemetry/description); the gate itself is stream-agnostic
	const maxLines = policy.maxLines > 0 ? policy.maxLines : THINKING_PRESETS.wan.maxLines;
	const maxBytes = policy.maxBytes > 0 ? policy.maxBytes : THINKING_PRESETS.wan.maxBytes;
	const minIntervalMs = policy.minIntervalMs >= 0 ? policy.minIntervalMs : THINKING_PRESETS.wan.minIntervalMs;
	const idleMs = policy.idleMs >= 0 ? policy.idleMs : THINKING_PRESETS.wan.idleMs;
	const minBytes = policy.minBytes >= 0 ? policy.minBytes : THINKING_PRESETS.wan.minBytes;
	const maxHoldMs = policy.maxHoldMs >= 0 ? policy.maxHoldMs : Math.max(idleMs, THINKING_PRESETS.wan.maxHoldMs);
	// DELIBERATELY 0 by default: createThinkingGate is the pure threshold machine, and the immediate
	// first frame is a USER-FACING policy the presets carry (resolveThinkingPolicy/resolveStreamPolicy).
	// Tests of the pure thresholds therefore keep their exact frame counts.
	const firstBytes = Number.isFinite(policy.firstBytes) && policy.firstBytes >= 0 ? policy.firstBytes : 0;

	let pending = "";
	let firstPendingAt = null;  // when the CURRENT buffer started — idle waits are measured from here
	let lastEmitAt = null;      // when the last frame left — the rate limit is measured from here
	let frames = 0;             // emitted frames
	let emittedBytes = 0;       // utf8 bytes emitted
	let deferred = false;

	const state = (emit, reason, now) => {
		if (emit) {
			lastEmitAt = now; frames++; emittedBytes += utf8Bytes(emit); deferred = false;
			if (!pending) firstPendingAt = null;
		}
		return { emit: emit || null, reason, deferred, pendingBytes: utf8Bytes(pending), pendingLines: countLineBreaks(pending), frames };
	};
	/** ms since the last frame left; before the first frame: ms since this buffer started (so the
	 *  FIRST paragraph is not emitted by the idle rule the instant a delta arrives). */
	const sinceEmit = (now) => (lastEmitAt !== null ? now - lastEmitAt : (firstPendingAt !== null ? now - firstPendingAt : 0));
	const take = (upto, reason, now) => {
		const emit = upto === null ? pending : pending.slice(0, upto);
		pending = upto === null ? "" : pending.slice(upto);
		if (upto !== null && pending) firstPendingAt = now; // the remainder is a NEW buffer (idle restarts)
		return state(emit, reason, now);
	};

	return {
		mode,
		push(delta, now = 0) {
			const d = String(delta ?? "");
			if (mode === "off") return state(d, "off", now);      // live passthrough (control)
			if (d && !pending) firstPendingAt = now;
			pending += d;
			if (!pending) return state("", "none", now);
			if (mode === "end") { deferred = true; return state("", THINKING_HELD_REASON, now); }

			// 0) FIRST FRAME, IMMEDIATELY: start the block like live streaming (see FIRST_BYTES), so a
			//    coalescing policy never reads as "thinking…" for seconds at the start of a block.
			if (firstBytes > 0 && frames === 0 && utf8Bytes(pending) >= firstBytes) return take(null, "first", now);

			// 1) hard thresholds — never rate-limited (memory + latency ceiling)
			if (utf8Bytes(pending) >= maxBytes) return take(null, "bytes", now);
			// the line threshold is a NATURAL boundary too, so the same floor gates it: 40 tiny lines are
			// not worth a frame that the socket then sends uncompressed (see the MEASURED LESSON above).
			// The hard caps above/below (maxBytes, maxHoldMs) still guarantee progress.
			if (countLineBreaks(pending) >= maxLines && (minBytes === 0 || utf8Bytes(pending) >= minBytes || sinceEmit(now) >= maxHoldMs)) {
				return take(null, "lines", now);
			}

			// 2) paragraph boundary — the semantic threshold the user asked for. Emit everything
			//    that is COMPLETE (through the LAST boundary), keep the in-progress tail.
			if (mode === "paragraph") {
				const end = paragraphBoundaryEnd(pending);
				if (end >= 0) {
					// rate limit: only against a PREVIOUS frame, so the first paragraph is never held
					const rateLimited = lastEmitAt !== null && now - lastEmitAt < minIntervalMs;
					// anti-fragmentation floor: a sub-floor paragraph merges with the next one (a frame costs
					// ~40B of wrapper).
					const belowFloor = minBytes > 0 && utf8Bytes(pending.slice(0, end)) < minBytes;
					if (!rateLimited && !belowFloor) return take(end, "paragraph", now);
					// held back — but FALL THROUGH: the idle rules below must still be able to fire, or a
					// tiny/complete paragraph would block the visibility ceiling forever.
					deferred = true;
				}
			}

			// 3) idle keep-alive. Two promises, both kept:
			//    soft  — after idleMs, but only once the buffer is worth a compressed frame
			//            (a 740B frame is below the socket's threshold, so the bytes were wasted)
			//    hard  — after maxHoldMs, always: a frozen reasoning block is worse than a small frame
			const since = sinceEmit(now);
			if (since >= maxHoldMs) return take(null, "idle", now);
			if (since >= idleMs && (minBytes === 0 || utf8Bytes(pending) >= minBytes)) return take(null, "idle", now);
			return state("", "none", now);
		},
		idle(now = 0) { return this.push("", now); },
		flush(now = 0, reason = "end") {
			if (mode === "off") return state("", "off", now);
			if (!pending) return state("", "none", now);
			return take(null, reason, now);
		},
		reset(now = 0) { pending = ""; firstPendingAt = null; lastEmitAt = now; deferred = false; },
		snapshot() { return { mode, pending, pendingBytes: utf8Bytes(pending), pendingLines: countLineBreaks(pending), frames, emittedBytes, deferred, firstPendingAt, lastEmitAt, minBytes, maxHoldMs }; },
	};
}

/**
 * Batch simulation of one thinking turn: feed deltas, collect the frames the gate would send.
 * Used by tests AND by the measurement harness (plan §7) — same code path, so the numbers we
 * quote come from the shipped decision logic, not from a spreadsheet.
 * deltas: string[] (or { delta, at } to script your own timing).
 */
export function simulateStream(deltas, { policy = null, kind = "thinking", net = "wan", settings = {}, frameType = null, t0 = 1000, stepMs = 40, endReason = "end" } = {}) {
	const pol = policy || (kind === "thinking" ? resolveThinkingPolicy(net, settings) : resolveStreamPolicy(kind, net, settings));
	const gate = createThinkingGate(pol);
	const wireType = frameType || { thinking: "thinking_delta", text: "text_delta", tool: "tool_output" }[kind] || "stream_delta";
	const frames = [];
	let at = t0, heldSince = null, pushed = 0;
	for (const d of deltas) {
		const delta = typeof d === "string" ? d : String(d?.delta ?? "");
		if (typeof d === "object" && d && Number.isFinite(d.at)) at = d.at; else at += stepMs;
		pushed++;
		const r = gate.push(delta, at);
		if (r.emit) {
			frames.push({ at, text: r.emit, reason: r.reason, bytes: utf8Bytes(r.emit), waitedMs: heldSince === null ? 0 : at - heldSince });
			heldSince = null;
		} else if (heldSince === null) heldSince = at;
	}
	const last = gate.flush(at + stepMs, endReason);
	if (last.emit) frames.push({ at: at + stepMs, text: last.emit, reason: last.reason, bytes: utf8Bytes(last.emit), waitedMs: heldSince === null ? 0 : at + stepMs - heldSince });
	const total = frames.reduce((n, f) => n + f.bytes, 0);
	const waits = frames.map((f) => f.waitedMs).sort((a, b) => a - b);
	return {
		frames,
		stats: {
			pushes: pushed,
			frames: frames.length,
			bytes: total,
			characters: frames.map((f) => f.text).join("").length,
			reasons: frames.map((f) => f.reason),
			maxWaitMs: waits.length ? waits[waits.length - 1] : 0,
			medianWaitMs: waits.length ? waits[waits.length >> 1] : 0,
			frameBytes: frames.map((f) => frameBytes({ type: wireType, text: f.text })),
			policy: pol,
		},
	};
}

/** The reasoning-delta case of simulateStream (kept as the readable name in the suites). */
export function simulateThinking(deltas, opts = {}) {
	return simulateStream(deltas, opts);
}

/** The reasoning text of an AssistantMessage (the same extraction the client renders). */
export function assistantThinkingText(message) {
	const content = message?.content;
	if (!Array.isArray(content)) return "";
	return content.filter((c) => c?.type === "thinking").map((c) => c.thinking || "").join("");
}

/** Text parts only — the counterpart used by the preview/coalesceTurn paths. */
export function assistantStreamText(message) {
	const content = message?.content;
	if (!content) return "";
	if (typeof content === "string") return content;
	return content.filter((c) => c?.type === "text").map((c) => c.text || "").join("");
}
