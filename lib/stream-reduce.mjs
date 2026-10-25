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
export function createStreamReducer(cfg = null, { seed = null } = {}) {
	const enabled = !!cfg && STREAM_KINDS.some((k) => cfg.kinds?.[k]?.mode && cfg.kinds[k].mode !== "off");

	let gates = null;         // kind → gate, created lazily per streaming block
	let delivered = { thinking: 0, text: 0 };   // characters already sent to THIS client
	let lastFull = null;      // the newest full assistant snapshot (for a flush)
	const toolSentAt = new Map();  // toolCallId → last forwarded time (per tool, not global)
	const toolPending = new Map(); // toolCallId → the newest update ENVELOPE not yet forwarded
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
		toolPending.clear();
	};
	/**
	 * What the CLIENT already has. attach/`GET`s deliver a full `streamingMessage` (they bypass this
	 * reducer), so without seeding, the first coalesced frame would TRUNCATE the client back to 0
	 * characters and the answer would visibly shrink (grok review 2026-10-25, blocker 3).
	 */
	const seedFrom = (message) => {
		if (!message) return;
		lastFull = message;
		delivered = {
			thinking: Math.max(delivered.thinking, kindText(message, "thinking").length),
			text: Math.max(delivered.text, kindText(message, "text").length),
		};
	};
	if (seed) seedFrom(seed);

	/**
	 * Forward the held text as a real SNAPSHOT — `message_update`, not the terminal event it was
	 * carried by (grok review 2026-10-25, blocker 1: an `error` frame with a `message` field is never
	 * rendered by the client, which only assigns `streamingMessage` on message_update/message_start).
	 */
	const flushSnapshot = (msg, reason = "flush") => {
		if (!enabled || !lastFull) return null;
		const full = { thinking: kindText(lastFull, "thinking").length, text: kindText(lastFull, "text").length };
		if (full.thinking <= delivered.thinking && full.text <= delivered.text) return null;
		delivered = { thinking: Math.max(delivered.thinking, full.thinking), text: Math.max(delivered.text, full.text) };
		stats.flushes++;
		return { type: "agent-event", sessionId: msg.sessionId, seq: msg.seq, event: { type: "message_update", message: lastFull }, reduction: reason };
	};

	/** the truncated snapshot form of an update (used for EVERY message_update we forward) */
	const snapshotOf = (ev) => truncateStreamSnapshot(ev.message, delivered);

	return {
		get enabled() { return enabled; },
		cfg,
		stats: () => ({ ...stats, enabled }),
		reset: resetBlock,
		/** Seed the counters/state from a snapshot the client ALREADY received (attach / GET). */
		seed: seedFrom,

		/** The one call site: server.mjs's per-socket broadcast loop. */
		transform(msg, now = Date.now()) {
			if (!enabled) return msg;
			if (!msg || msg.type !== "agent-event" || !msg.event) return msg; // runtime/state/pings pass
			const ev = msg.event;
			const type = ev.type;

			if (type === "message_start") {
				// a new block: anything still held belongs to the previous one
				const held = flushSnapshot(msg, "flush");
				resetBlock(); stats.blocks++;
				return held ? [held, msg] : msg;
			}

			if (type === "message_update" && ev.message?.role === "assistant") {
				lastFull = ev.message;
				const kind = deltaKind(ev.assistantMessageEvent);
				// NOT gated kinds (toolcall deltas, `end`, …) are still TRUNCATED: forwarding them verbatim
				// would ship the whole held text and undo the truncation of every earlier frame
				// (grok review 2026-10-25, blocker 2).
				if (!kind) {
					stats.forwarded++;
					return { ...msg, event: { ...ev, message: snapshotOf(ev) }, reduction: "verbatim" };
				}
				const gate = gateFor(kind);
				const res = gate.push(deltaText(ev.assistantMessageEvent), now);
				if (!res.emit) { stats.dropped++; stats.byKind[kind]++; stats.droppedBytes += utf8Bytes(deltaText(ev.assistantMessageEvent)); return null; }
				delivered[kind] += res.emit.length;
				stats.forwarded++;
				return { ...msg, event: { ...ev, message: snapshotOf(ev) }, reduction: res.reason };
			}

			if (type === "message_end" && ev.message?.role === "assistant") {
				// NO flush here: message_end carries the complete message and is HISTORY (the client pushes
				// it into state.messages + the IDB tail; `haveTo` counts it). A flush frame would be both
				// redundant and — if it replaced the frame — a lost final message. So: forward, then reset.
				resetBlock();
				return msg;
			}

			if (type === "tool_execution_update") {
				const policy = cfg.kinds.tool;
				const key = String(ev.toolCallId ?? ev.toolName ?? "?");
				if (policy.mode === "off") return msg;
				if (policy.mode === "end") { stats.dropped++; stats.byKind.tool++; return null; }
				// thinned (not gated), PER TOOL CALL: the client renders tool output from the RESULT
				// message, so a progress frame is a liveness hint — one per idleMs per tool, and the last
				// one is always forwarded before the tool ends (grok review 2026-10-25, should-fix).
				toolPending.set(key, msg); // the ENVELOPE: the server sends whatever we return verbatim
				const lastAt = toolSentAt.get(key) ?? -Infinity;
				if (now - lastAt >= (policy.idleMs || 0)) {
					toolSentAt.set(key, now);
					toolPending.delete(key);
					stats.forwarded++;
					return msg;
				}
				stats.dropped++; stats.byKind.tool++;
				return null;
			}
			if (type === "tool_execution_start") {
				const key = String(ev.toolCallId ?? ev.toolName ?? "?");
				toolSentAt.delete(key);           // the first update after a start is never swallowed
				toolPending.delete(key);
				return msg;
			}
			if (type === "tool_execution_end") {
				const key = String(ev.toolCallId ?? ev.toolName ?? "?");
				const held = toolPending.get(key);
				toolPending.delete(key); toolSentAt.delete(key);
				stats.forwarded++;
				return held ? [held, msg] : msg;  // the last progress frame ships, then the result
			}

			// A turn that DIED (or ends while text is still held) never sent a message_end for it — send the
			// held text as a SNAPSHOT first, then the event itself. Both frames are delivered by server.mjs.
			if (type === "error" || type === "aborted" || type === "retry" || type === "turn_end" || type === "agent_end") {
				const held = flushSnapshot(msg);
				resetBlock();
				return held ? [held, msg] : msg;
			}
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
