// lib/stream-reduce.mjs — PER-CONNECTION stream reduction on the agent socket (item 3's cheap
// 80/20, plan §2.3), written as a PURE reducer so it is fully unit-testable before it is trusted
// with a live turn.
//
// WHERE IT SITS: server.mjs's `broadcast(sessionId, msg)` loops over the sockets attached to a
// session and sends each one the same `{type:"agent-event", seq, event}` payload. That loop is the
// delivery boundary — the ONLY place that can be per-connection — so the reducer returns, for one
// socket and one payload, either the payload to forward, a MODIFIED payload, or null (= drop).
//
// OFF BY DEFAULT (user decision, 2026-10-25): with no config (`cfg == null`) the reducer is a
// pass-through and costs one `if`. Nothing changes for any client until it sends
// `{type:"setDataReduction", …}` (Settings → Data use), and the hub echoes what it accepted.
//
// WHY TRUNCATED SNAPSHOTS AND NOT DELTAS: `message_update` carries a FULL assistant snapshot and the
// client renders `state.streamingMessage = ev.message` (src/proxy-agent.ts). So a coalesced frame is
// a snapshot truncated to what has been DELIVERED so far — never a delta. The user then sees
// reasoning/text appear in the chunks the gate chose, and `message_end` still delivers the complete
// final message (history, IDB write-through and `haveTo` are untouched by design).
//
// GUARANTEES (the plan's non-negotiables, each pinned by tests/stream-reduce.test.mjs):
//   1. an error/abort/retry/turn-end ALWAYS flushes what is buffered — nothing is lost when a turn dies;
//   2. per-connection memory is bounded (the gate's maxBytes/maxHoldMs) — no unbounded buffering;
//   3. `end` mode holds text but still lets `runtime`/ping/state frames through (no silent socket);
//   4. history/shape: message_end, tool results, runtime, retry, versions are forwarded unchanged;
//   5. a steer mid-block is unaffected (steering frames are not `message_update`s).
import { createThinkingGate, resolveStreamPolicy, STREAM_KINDS, THINKING_MODES } from "./thinking-flush.mjs";
import { utf8Bytes } from "./data-reduction.mjs";

/** Which stream a `message_update` delta belongs to (thinking vs the visible answer). */
export function deltaKind(assistantMessageEvent) {
	const t = assistantMessageEvent?.type;
	if (t === "thinking_delta") return "thinking";
	if (t === "text_delta") return "text";
	return null; // toolcall_delta / start / end: forwarded verbatim
}

/** The delta text of a `message_update` (pi-ai: {type:"thinking_delta"|"text_delta", delta}). */
export function deltaText(assistantMessageEvent) {
	const d = assistantMessageEvent?.delta;
	return typeof d === "string" ? d : "";
}

/**
 * Truncate an assistant message to `delivered` characters per part type, cumulative across parts.
 * delivered: { thinking?: number, text?: number }. Pure; unknown part types are kept as-is (a
 * toolCall part must never be hidden — the client draws its chip from the snapshot).
 */
export function truncateStreamSnapshot(message, delivered = {}) {
	if (!Array.isArray(message?.content)) return message;
	let changed = false;
	const budget = { thinking: delivered.thinking ?? 0, text: delivered.text ?? 0 };
	const content = message.content.map((part) => {
		if (part?.type !== "thinking" && part?.type !== "text") return part;
		const field = part.type === "thinking" ? "thinking" : "text";
		const full = typeof part[field] === "string" ? part[field] : "";
		const left = budget[part.type];
		if (left >= full.length) { budget[part.type] = left - full.length; return part; }
		budget[part.type] = 0;
		changed = true;
		return { ...part, [field]: full.slice(0, Math.max(0, left)) };
	});
	return changed ? { ...message, content } : message;
}

/** The default config a client gets when it never sends `setDataReduction` — no reduction at all. */
export function liveReductionConfig() {
	return { streamMode: "live", kinds: { thinking: { mode: "off" }, text: { mode: "off" }, tool: { mode: "off" } } };
}

/**
 * Normalise a client `setDataReduction` payload into the config the reducer runs. Unknown values fall
 * back to LIVE (never to a stronger reduction than asked for) and per-kind policies may be given
 * either as a resolved policy (`{mode,minBytes,…}`, what src/ui/data-settings.ts sends) or omitted
 * (then they are derived from the net tier + levels, so a thin client still works).
 */
export function normalizeReductionConfig(raw, net = "wan") {
	if (!raw || typeof raw !== "object") return null;
	const settings = {
		thinkingLevel: raw.thinkingLevel, textLevel: raw.textLevel, toolLevel: raw.toolLevel,
		imageLevel: raw.imageLevel,
	};
	const kinds = {};
	for (const kind of STREAM_KINDS) {
		const given = raw[kind];
		const base = resolveStreamPolicy(kind, net, settings);
		if (given && typeof given === "object" && THINKING_MODES.includes(given.mode)) {
			kinds[kind] = { ...base, ...given }; // explicit numbers win…
		} else if (given && typeof given === "object" && given.mode !== undefined) {
			// …but an unrecognised mode must fall back to LIVE, never to a mode we invented
			kinds[kind] = { ...base, ...given, mode: "off" };
		} else {
			kinds[kind] = base;
		}
	}
	return { streamMode: String(raw.stream || "live"), net, kinds, imageLevel: raw.imageLevel || null };
}

/**
 * The reducer for ONE connection. Every connection that never opts in keeps `enabled === false`,
 * which makes `transform()` a no-op (`null` config, no gates, no buffers).
 * transform(msg, now) → the payload to forward (same object when untouched) or `null` to drop.
 */
export function createStreamReducer(cfg = null) {
	const enabled = !!cfg && STREAM_KINDS.some((k) => cfg.kinds?.[k]?.mode && cfg.kinds[k].mode !== "off");

	let gates = null;         // kind → gate, created lazily per streaming block
	let delivered = { thinking: 0, text: 0 };   // characters already sent to THIS client
	let lastFull = null;      // the newest full assistant snapshot (for a flush)
	let lastToolForwardAt = -Infinity;
	let currentToolId = null;
	const stats = { forwarded: 0, dropped: 0, flushes: 0, blocks: 0, byKind: { thinking: 0, text: 0, tool: 0 }, droppedBytes: 0 };

	if (enabled) { gates = {}; }
	/** one gate per kind, built from the (already normalised) policy for that kind */
	const gateFor = (kind) => {
		if (!gates[kind]) gates[kind] = createThinkingGate(cfg.kinds[kind]);
		return gates[kind];
	};

	const resetBlock = () => {
		if (!enabled) return;
		gates = {}; delivered = { thinking: 0, text: 0 }; lastFull = null;
	};
	/** forward the newest snapshot with everything delivered (used before a terminal event) */
	const flushBlock = (event, now) => {
		if (!enabled || !lastFull) return null;
		const stillHeld = { thinking: 0, text: 0 };
		for (const kind of ["thinking", "text"]) {
			const full = kindText(lastFull, kind);
			if (full.length > delivered[kind]) stillHeld[kind] = full.length;
		}
		if (!stillHeld.thinking && !stillHeld.text) return null;
		delivered = { thinking: stillHeld.thinking || delivered.thinking, text: stillHeld.text || delivered.text };
		stats.flushes++;
		return { type: "agent-event", sessionId: event.sessionId, seq: event.seq, event: { ...event.event, message: lastFull }, reduction: "flush" };
	};

	return {
		get enabled() { return enabled; },
		cfg,
		stats: () => ({ ...stats, enabled }),
		reset: resetBlock,

		/** The one call site: server.mjs's per-socket broadcast loop. */
		transform(msg, now = Date.now()) {
			if (!enabled) return msg;
			if (!msg || msg.type !== "agent-event" || !msg.event) return msg; // runtime/state/pings pass
			const ev = msg.event;
			const type = ev.type;

			if (type === "message_start") { resetBlock(); stats.blocks++; return msg; }

			if (type === "message_update" && ev.message?.role === "assistant") {
				lastFull = ev.message;
				const kind = deltaKind(ev.assistantMessageEvent);
				if (!kind) return msg;                                // toolcall deltas etc.: verbatim
				const gate = gateFor(kind);
				const res = gate.push(deltaText(ev.assistantMessageEvent), now);
				if (!res.emit) { stats.dropped++; stats.byKind[kind]++; stats.droppedBytes += utf8Bytes(deltaText(ev.assistantMessageEvent)); return null; }
				delivered[kind] += res.emit.length;
				stats.forwarded++;
				return { ...msg, event: { ...ev, message: truncateStreamSnapshot(ev.message, delivered) }, reduction: res.reason };
			}

			if (type === "message_end" && ev.message?.role === "assistant") {
				// NO flush here: message_end carries the complete message and is HISTORY (the client pushes
				// it into state.messages + the IDB tail; `haveTo` counts it). A flush frame would be both
				// redundant and — if it replaced the frame — a lost final message. So: forward, then reset.
				resetBlock();
				return msg;
			}

			if (type === "tool_execution_update") {
				currentToolId = ev.toolCallId ?? currentToolId;
				const policy = cfg.kinds.tool;
				if (policy.mode === "off") return msg;
				if (policy.mode === "end") { stats.dropped++; stats.byKind.tool++; return null; }
				// thinned (not gated): the client renders tool output from the RESULT message, so a
				// progress frame is a liveness hint — one per idleMs, plus the last one before the end
				if (now - lastToolForwardAt < (policy.idleMs || 0)) { stats.dropped++; stats.byKind.tool++; return null; }
				lastToolForwardAt = now;
				stats.forwarded++;
				return msg;
			}
			if (type === "tool_execution_end" || type === "tool_execution_start") {
				lastToolForwardAt = now; currentToolId = type === "tool_execution_start" ? (ev.toolCallId ?? null) : null;
				return msg;
			}

			// A turn that DIED never sent a message_end for the held text — flush it, then the event.
			// Two frames, both sent (server.mjs's loop handles an array): the user can still read the
			// reasoning that was in flight, and the error/abort is never swallowed.
			if (type === "error" || type === "aborted") {
				const flushed = flushBlock(msg, now);
				resetBlock();
				return flushed ? [flushed, msg] : msg;
			}
			// retry/turn_end/agent_end: the message was already delivered by its message_end (or is being
			// replaced by the retry) — forward unchanged, drop the block state.
			if (type === "retry" || type === "turn_end" || type === "agent_end") { resetBlock(); return msg; }
			return msg;
		},
	};
}

/** The joined text of one kind inside an assistant message (same rule as the client's renderer). */
export function kindText(message, kind) {
	const content = message?.content;
	if (!Array.isArray(content)) return typeof content === "string" ? content : "";
	const field = kind === "thinking" ? "thinking" : "text";
	return content.filter((c) => c?.type === kind).map((c) => c?.[field] || "").join("");
}

/** One debug line per block for the user to watch (`PI_WEB_DATA_REDUCTION_DEBUG=1`). */
export function describeReduction(stats, cfg = null) {
	if (!stats.enabled) return "data-reduction: live (no reduction)";
	const kinds = cfg ? STREAM_KINDS.map((k) => `${k}=${cfg.kinds[k].mode}`).join(" ") : "";
	return `data-reduction: ${kinds} · forwarded=${stats.forwarded} dropped=${stats.dropped} (${stats.droppedBytes}B) flushes=${stats.flushes} blocks=${stats.blocks}`;
}
