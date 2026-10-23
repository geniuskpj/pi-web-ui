// agent-hub.mjs — SERVER-SIDE agent sessions (v2, hardened per Sonnet review).
//
// The agent loop (pi-agent-core) runs HERE in Node — never in the browser:
//   - LLM calls go directly to the provider (identical to the pi TUI path)
//   - API keys stay in .pi/auth.json on the server (never sent to clients)
//   - sessions persist to the worker store after every turn (atomic writes)
//   - every connected device (laptop/phone) is a viewer/controller via /ws/agent
// Clients can disconnect at any time — long jobs keep running server-side.
import { Agent } from "@earendil-works/pi-agent-core";
// pi-ai 1.4.0: AgentOptions.streamFn is REQUIRED — the compat subpath exports the
// generic streamSimple dispatcher (routes on model.api) and auto-registers the
// builtin api providers on import
import { streamSimple } from "@earendil-works/pi-ai/compat";
import crypto from "node:crypto";

const HOT_AGENT_CAP = 10;
const IDLE_EVICT_MS = 30 * 60 * 1000;

function extractPreviewText(content, maxLen = 120) {
	if (typeof content === "string") return content.trim().replace(/\s+/g, " ").slice(0, maxLen);
	if (Array.isArray(content)) {
		const tb = content.find((b) => b.type === "text" && b.text);
		if (tb) return tb.text.trim().replace(/\s+/g, " ").slice(0, maxLen);
	}
	return "";
}

/** Repair toolResult identity that the OLD mirror format dropped (pre-2026-10-22
 *  _writeSession wrote only {role, content, timestamp}, losing the top-level
 *  toolCallId/toolName). After a restart the hub hydrated such mirrors and the
 *  openai-completions converter emitted role:"tool" messages WITHOUT
 *  tool_call_id (and duplicated them) → provider 400 (nvidia NIM:
 *  "missing field tool_call_id"), permanently, because the failed run appended
 *  an empty assistant message that every retry kept in the history.
 *
 *  Re-links each orphan toolResult to an unclaimed toolCall of the preceding
 *  assistant (call order, skipping ids already claimed by linked results in the
 *  same group — commit-review P2: a linked "a" + orphan group with calls [a,b]
 *  must yield b, never a duplicate), backfills toolName, and strips toolCalls
 *  that still got no result (openai-completions also 400s on tool_calls without
 *  a following tool message). Idempotent: already-linked messages pass through
 *  untouched. Optional `stats` object collects exact repair counts:
 *  { relinked, dropped, danglingStripped } (commit-review P3 — dropped orphans
 *  must not be reported as re-linked). */
export function normalizeRestoredMessages(messages, stats) {
	if (!Array.isArray(messages)) return messages;
	const out = messages.map((m) => (Array.isArray(m?.content) ? { ...m, content: [...m.content] } : { ...m }));
	let changed = false;
	for (let i = 0; i < out.length; i++) {
		const m = out[i];
		if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
		const calls = m.content.filter((b) => b?.type === "toolCall");
		if (!calls.length) continue;
		// bounds of the consecutive toolResult group that follows this assistant
		let end = i + 1;
		while (end < out.length && out[end].role === "toolResult") end++;
		// pass 1 — ids already claimed by linked results in this group are trusted
		const claimed = new Set();
		for (let t = i + 1; t < end; t++) if (out[t].toolCallId) claimed.add(out[t].toolCallId);
		// pass 2 — each orphan gets the first UNCLAIMED call id (call order)
		for (let t = i + 1; t < end; t++) {
			if (out[t].toolCallId) continue;
			let c = 0;
			while (c < calls.length && claimed.has(calls[c].id)) c++;
			if (c < calls.length) {
				out[t] = { ...out[t], toolCallId: calls[c].id, toolName: out[t].toolName ?? calls[c].name };
				claimed.add(calls[c].id);
				changed = true;
				if (stats) stats.relinked++;
			}
		}
		// pass 3 — drop assistant toolCalls with no result in the group (dangling
		// tool_call is ALSO a provider 400)
		if (calls.some((c) => !claimed.has(c.id))) {
			const dangling = calls.filter((c) => !claimed.has(c.id)).length;
			const kept = m.content.filter((b) => b?.type !== "toolCall" || claimed.has(b.id));
			if (kept.length === 0) kept.push({ type: "text", text: "(tool call interrupted by error)" });
			out[i] = { ...m, content: kept };
			changed = true;
			if (stats) stats.danglingStripped += dangling;
		}
	}
	// toolResults that still have no id (not directly after their assistant) cannot
	// be converted — role:"tool" without tool_call_id is a provider 400. Drop them;
	// losing one orphan tool output beats a permanently dead session.
	const orphansBefore = out.filter((m) => m.role === "toolResult" && !m.toolCallId).length;
	const linked = out.filter((m) => !(m.role === "toolResult" && !m.toolCallId));
	if (linked.length !== out.length) {
		changed = true;
		if (stats) stats.dropped += orphansBefore;
	}
	return changed ? linked : messages;
}

// ---- compaction (pi /compact parity) ---------------------------------------
// Serialization: [User]/[Assistant]/[Assistant tool calls]/[Tool result (name)]
// plain text so the model treats it as MATERIAL to summarize, not a conversation
// to continue. Thinking blocks are OMITTED (pi: replayed thinking is often not
// in the live context — including it could make the request bigger than what it
// summarizes). Tool results truncated to 2000 chars with a marker (they are the
// biggest context contributors).
const serializeConversation = (messages) => {
	const textOf = (content) => (typeof content === "string" ? content : (Array.isArray(content) ? content.filter((b) => b?.type === "text").map((b) => b.text || "").join("\n") : ""));
	const out = [];
	for (const m of messages) {
		if (m.role === "user") out.push("[User]: " + textOf(m.content));
		else if (m.role === "assistant") {
			const t = textOf(m.content).trim();
			if (t) out.push("[Assistant]: " + t);
			const calls = (Array.isArray(m.content) ? m.content : []).filter((b) => b?.type === "toolCall").map((b) => `${b.name}(${JSON.stringify(b.arguments || {})})`).join("; ");
			if (calls) out.push("[Assistant tool calls]: " + calls);
		} else if (m.role === "toolResult") {
			let t = textOf(m.content);
			if (t.length > 2000) t = t.slice(0, 2000) + `\n[… ${t.length - 2000} chars truncated]`;
			out.push(`[Tool result${m.toolName ? " (" + m.toolName + ")" : ""}]: ` + t);
		}
	}
	return out.join("\n\n");
};

export class AgentHub {
	constructor({ modelsStore, getAuth, persist, broadcast, getTools, getSystemPrompt, defaultModelId, onRuntimeChange, loadMessages, summarize, backupMirror, versions }) {
		this.modelsStore = modelsStore;
		this.getAuth = getAuth;
		this.persist = persist; // async (id, data, metadata) — worker store (atomic)
		// optional store READ accessor (server.mjs wires storeOp("get")): lets
		// forkSession self-hydrate a cold session (hub restart, no attach yet)
		this.loadMessages = loadMessages || null; // async (id) → {messages, metadata} | null
		this.summarize = summarize || null; // async ({model, serialized, previousSummary, signal}) → summary text
		this.backupMirror = backupMirror || null; // async (id) → backup path | null (pre-compact safety copy)
		// VERSIONS (user design 2026-10-23): delta sidecar ops — {append(id, record),
		// list(id), get(id, vid)}; every ✎ edit parks the removed tail here with
		// simple meta (vid/turn/firstId/count) so versions are restorable
		this.versions = versions || null;
		this.broadcast = broadcast; // (sessionId, msg) — send to attached clients
		// server-side toolset (2026-10-21): the SAME builtin+extension tools the exec
		// bridge exposes — executed IN THIS PROCESS by the server-side agent loop, so
		// a run survives browser closes and every device sees live progress
		this.getTools = getTools || (() => []);
		// effective system prompt (WEB_SYSTEM.md > trusted project SYSTEM.md > global
		// SYSTEM.md, APPEND_SYSTEM.md appends) — same precedence the browser path uses
		this.getSystemPrompt = getSystemPrompt || (() => undefined);
		this.defaultModelId = String(defaultModelId || ""); // pi settings.json default
		this.onRuntimeChange = onRuntimeChange || null; // (sessionId, runtime) → server pushes the runtime delta frame
		this.sessions = new Map(); // sessionId -> entry
		this.subscribers = new Map(); // sessionId -> Set<SSE callbacks> — stable fan-out, NEVER a broadcast swap
		this.discarded = new Set(); // deleted session ids — persist skips them (no resurrection)
	}

	_getModel(modelId) {
		for (const p of Object.values(this.modelsStore)) {
			const m = (p.models || []).find((x) => x.id === modelId);
			if (m) return { ...m, provider: p.name || m.provider };
		}
		return undefined;
	}

	_defaultModel() {
		if (this.defaultModelId) {
			const hit = this._getModel(this.defaultModelId);
			if (hit) return hit;
		}
		for (const p of Object.values(this.modelsStore)) {
			const m = (p.models || [])[0];
			if (m) return { ...m, provider: p.name || m.provider };
		}
		return undefined;
	}

	getSession(sessionId, { modelId, thinkingLevel, title, messages } = {}) {
		this.discarded.delete(sessionId); // explicit re-open undeletes
		let entry = this.sessions.get(sessionId);
		if (!entry) {
			const model = this._getModel(modelId) || this._defaultModel();
			if (!model) throw new Error("no models available");
			const level = thinkingLevel || "high";
			const systemPrompt = this.getSystemPrompt(); // undefined → pi's built-in chat default
			const agent = new Agent({
				streamFn: streamSimple, // pi-ai 1.4.0: streamFn required (compat generic dispatcher)
				initialState: {
					model,
					thinkingLevel: level,
					// re-link toolResults that lost toolCallId in an old mirror (2026-10-22:
					// nvidia NIM 400s on tool messages without tool_call_id after restart)
					messages: messages ? normalizeRestoredMessages(messages) : [],
					...(systemPrompt ? { systemPrompt } : {}),
					tools: this.getTools(), // read/write/edit/bash + pi extensions — in-process
				},
			});
			agent.getApiKey = async (provider) => {
				const auth = this.getAuth();
				const e = auth[provider];
				return typeof e === "string" ? e : e?.key;
			};
			entry = {
				agent,
				model,
				thinkingLevel: level,
				seq: 0, // monotonic event sequence for attach dedup
				pending: new Map(), // attached-socket event buffer (subscribe-first attach)
				buffer: null, // attach() buffering hook — non-null ⇒ emit path queues events
				promptLock: null, // per-session prompt mutex (two devices racing an idle prompt)
				runtime: { status: "idle", startedAt: null, turn: 0, currentTool: null, lastText: null, pendingPrompts: 0 },
				previewTimer: null, // 2s trailing timer for the lastText preview (bounded chatter)
				lastActivity: Date.now(),
				persistTimer: null,
				persistMaxTimer: null,
				userPersisted: false,
				followUpCount: 0,
				mutateEpoch: 0, // bumped by rewriteSession — invalidates prompts queued pre-truncate
				pendingPrompt: null, // steering UI payload {text, images, queuedAt} while held
				pendingPromptMessage: null, // the exact AgentMessage — consumed on message_end
			};
			if (title) entry.title = title; // sticky-title source (mirror metadata)
			this.sessions.set(sessionId, entry);

			agent.subscribe((event) => {
				entry.seq += 1;
				// runtime status (fable5 design): BOUNDARY events emit a tiny
				// {type:"runtime"} delta frame to ALL devices; message_update only
				// refreshes the in-memory lastText preview, broadcast ≤ once per 2s
				if (event.type === "agent_start") {
					entry.runtime = {
						status: "running",
						startedAt: Date.now(),
						turn: entry.agent.state.messages.filter((m) => m.role === "user").length,
						currentTool: null,
						lastText: null,
						pendingPrompts: 0,
					};
					this.emitRuntime(sessionId);
				} else if (event.type === "tool_execution_start") {
					entry.runtime.currentTool = event.toolName || null;
					this.emitRuntime(sessionId);
				} else if (event.type === "tool_execution_end") {
					entry.runtime.currentTool = null;
					this.emitRuntime(sessionId);
				} else if (event.type === "message_update" && event.message?.role === "assistant") {
					const t = (event.message.content || []).filter((c) => c.type === "text").map((c) => c.text || "").join("");
					if (t) {
						entry.runtime.lastText = t.length > 120 ? "…" + t.slice(-119) : t;
						if (!entry.previewTimer) {
							const pt = setTimeout(() => {
								entry.previewTimer = null;
								if (entry.runtime.status === "running") this.emitRuntime(sessionId);
							}, 2000);
							pt.unref?.();
							entry.previewTimer = pt;
						}
					}
				} else if (event.type === "message_end" && event.message?.role === "assistant") {
					// preview also tracks COMPLETED assistant messages — some models stream
					// tool-call text without text-type message_update deltas (deepseek DSML)
					const t = (event.message.content || []).filter((c) => c.type === "text").map((c) => c.text || "").join("");
					if (t && entry.runtime.status === "running") {
						entry.runtime.lastText = t.length > 120 ? "…" + t.slice(-119) : t;
						this.emitRuntime(sessionId);
					}
				} else if (event.type === "message_end" && event.message?.role === "user" && entry.pendingPromptMessage && event.message === entry.pendingPromptMessage) {
					// the steered message was just injected at a turn boundary — clear the
					// pending chip everywhere (reference equality: pi re-emits the SAME object)
					entry.pendingPromptMessage = null;
					entry.pendingPrompt = null;
					entry.followUpCount = 0;
					entry.runtime.pendingPrompts = 0;
					this.emitRuntime(sessionId);
					this.emitSteering(sessionId);
				} else if (event.type === "agent_end") {
					if (entry.previewTimer) { clearTimeout(entry.previewTimer); entry.previewTimer = null; }
					// phantom-streaming guard (killstop test 2026-10-23): after ABORT pi's
					// state.isStreaming stayed true indefinitely — any device attaching in
					// that window saw a frozen "streaming" transcript that never updates
					// (no further events come). The terminal event is ground truth.
					// ONE implementation (main's _settleRuntime refactor): the retry
					// feature's note rides along so an alive-sessions row still previews
					// WHY the run failed.
					const { lastA, failed } = this._settleRuntime(sessionId, entry, { lastText: entry.retryNote || null });
					// RETRY policy (2026-10-23): a run that ended in an error either gets a
					// scheduled auto-retry (rate limit / network / transient 5xx — see
					// _isRetryableError) or stops retrying. The counter resets on success and
					// on every user action (prompt/steer/abort/edit/retry), so it only ever
					// chains consecutive failures of the same turn.
					if (failed) this._maybeScheduleAutoRetry(entry, sessionId, lastA);
					else { entry.retryAttempts = 0; entry.retryNote = null; entry.retryGivenUp = false; entry.retryPending = null; }
				}
				const payload = { type: "agent-event", sessionId, seq: entry.seq, event };
				// liveness heartbeat for the zombie self-heal (grok Q1): multi-turn runs
				// legitimately dip pi's isStreaming false between LLM calls — only a run
				// that has been QUIESCENT for the staleness floor is a zombie
				entry.lastEventAt = Date.now();
				// attach() buffering hook (2026-10-21: replaces the old global
				// this.broadcast swap, which was not reentrant when two attaches overlapped)
				if (entry.buffer) entry.buffer.push(payload);
				else this.broadcast(sessionId, payload);
				// SSE subscribers fan out from a per-session set (2026-10-21 P2 fix:
				// onEvents no longer wraps/restores the shared broadcast)
				const subs = this.subscribers.get(sessionId);
				if (subs) for (const cb of [...subs]) { try { cb({ type: "agent-event", event }); } catch { /* listener error — drop */ } }
				entry.lastActivity = Date.now();
				// persistence triggers: user message immediately; everything else debounced —
				// EXCEPT agent_end: the turn boundary flushes NOW (2026-10-22 postmortem:
				// the final reply of a turn was lost when the server was hard-killed while
				// the 400ms-debounced 5MB put was still in flight; a turn boundary is the
				// one point users cannot afford to lose)
				if (event.type === "message_end" && event.message?.role === "user") {
					this.persistSession(sessionId, true);
				} else if (event.type === "agent_end") {
					this.persistSession(sessionId, true);
				} else if (event.type === "message_end") {
					this.persistSession(sessionId, false);
				}
			});
		}
		entry.lastActivity = Date.now();
		return entry;
	}

	/** Subscribe-first attach: buffer events while building the snapshot, then
	 *  deliver snapshot + buffered (deduped by seq). Prevents event loss.
	 *  2026-10-21: per-session entry.buffer hook — the old implementation swapped
	 *  the GLOBAL this.broadcast, which was not reentrant when two attaches
	 *  interleaved (one restore clobbered the other's interception). */
	attach(sessionId, deliver) {
		const entry = this.getSession(sessionId);
		const queue = (entry.buffer = []); // emit path buffers while non-null
		const state = {
			exists: true,
			messages: entry.agent.state.messages,
			model: entry.agent.state.model,
			thinkingLevel: entry.agent.state.thinkingLevel,
			isStreaming: entry.agent.state.isStreaming,
			seq: entry.seq,
			pendingPrompt: entry.pendingPrompt ?? null,
		};
		entry.buffer = null; // stop buffering BEFORE delivering (synchronous — no interleave)
		deliver({ type: "state", sessionId, ...state });
		for (const msg of queue) deliver(msg);
		return entry;
	}

	persistSession(sessionId, immediate = false) {
		const entry = this.sessions.get(sessionId);
		if (!entry) return;
		clearTimeout(entry.persistTimer);
		clearTimeout(entry.persistMaxTimer);
		if (immediate) {
			return this._writeSession(sessionId);
		}
		entry.persistTimer = setTimeout(() => this._writeSession(sessionId), 400); // debounced: fire-and-forget
		// maxWait: a burst of message_end events can't push the flush out forever
		entry.persistMaxTimer = setTimeout(() => this._writeSession(sessionId), 2000);
	}

	_writeSession(sessionId) {
		const entry = this.sessions.get(sessionId);
		if (!entry) return;
		if (this.discarded.has(sessionId)) return; // deleted — never resurrect (grok r3 Q3)
		const state = entry.agent.state;
		if (!state.messages.some((m) => m.role === "user")) return; // nothing to persist — empty/model-only sessions must not pollute the list (grok r3 Q5)
		const now = new Date().toISOString();
		const firstUser = state.messages.find((m) => m.role === "user");
		const title = firstUser ? extractPreviewText(firstUser.content) || "Session" : "Session";
				const metadata = this._buildMetadata(sessionId);
		if (!entry.createdAt) entry.createdAt = now;
		const lines = [JSON.stringify(metadata)];
		// FULL message objects (2026-10-22): the old {role, content, timestamp}
		// projection stripped toolResult.toolCallId/toolName — after a restart the
		// rehydrated history produced tool messages without tool_call_id → provider
		// 400 on the first prompt ("missing field tool_call_id", nvidia NIM).
		// stopReason/errorMessage/usage also survive now, so the UI renders errors
		// and tool rows correctly after reload.
		for (const m of state.messages) {
			const out = { ...m };
			if (!out.timestamp) out.timestamp = Date.now();
			lines.push(JSON.stringify(out));
		}
		this.persist(sessionId, lines.join("\n") + "\n").catch((err) => {
			console.error(`Failed to persist session ${sessionId}:`, err);
		});
	}

	/** Queue a mid-run send as STEERING: held in pi-agent-core's steering queue
	 *  and injected at the next turn boundary — after the current
	 *  thinking/toolcall completes, before the next assistant response
	 *  (getSteeringMessages drains after each turn_end; followUp() would wait for
	 *  the whole run to END). Depth 1: one pending message, editable/cancellable
	 *  from any device. */
	_steer(entry, sessionId, content, images) {
		if (entry.compacting) return { accepted: false, queued: false, reason: "compaction in progress — try again shortly" };
		if (entry.followUpCount >= 1) {
			return { accepted: false, queued: false, reason: "A steering message is already pending — cancel or edit it first." };
		}
		entry.followUpCount += 1;
		const msg = {
			role: "user",
			content: images?.length ? [{ type: "text", text: content }, ...images] : content,
			timestamp: Date.now(),
		};
		entry.pendingPromptMessage = msg; // reference — consumed on message_end
		entry.pendingPrompt = { text: content, images: images || [], queuedAt: msg.timestamp };
		entry.agent.steer(msg);
		entry.runtime.pendingPrompts = (entry.runtime.pendingPrompts || 0) + 1;
		this.emitRuntime(sessionId); // other devices see "running · +1 queued"
		this.emitSteering(sessionId); // pending chip on every attached device
		return { accepted: true, queued: true };
	}

	/** Public steer entry (WS {type:"steer"}): the client says "hold this". If no
	 *  run is live (stale chip / the run just ended), deliver as a normal prompt
	 *  instead of parking a message that would only run at the NEXT run's start.
	 *  Async: server.mjs chains .then on the reply. */
	async steer(sessionId, content, images) {
		const entry = this.sessions.get(sessionId);
		if (!entry) return { accepted: false, queued: false, reason: "no live session" };
		if (!entry.agent.state.isStreaming) return this.prompt(sessionId, content, images);
		return this._steer(entry, sessionId, content, images);
	}

	async prompt(sessionId, content, images) {
		const entry = this.getSession(sessionId);
		// a user-initiated send ends any auto-retry chain (the user is driving again)
		this._cancelAutoRetry(entry);
		entry.retryAttempts = 0;
		entry.retryNote = null;
		// NOTE: no fast path here — "prompt" means "start a run". A send while a run
		// is streaming arrives as hub.steer() (the client says so); a prompt that
		// races a run just starting takes the lock and the in-lock check below
		// converts it to a steer. The old fast path here misrouted post-Stop sends
		// (client idle, server still unwinding) into leftover steers that never ran
		// (grok review P1).
		// per-session mutex: two devices prompting an IDLE session concurrently
		// would both pass the isStreaming check and race agent.prompt (which
		// throws on concurrent prompts). Serialized; the in-lock steer path
		// handles a run that started while this call waited.
		const epochAtCall = entry.mutateEpoch || 0;
		const prev = entry.promptLock || Promise.resolve();
		const run = async () => {
			if ((entry.mutateEpoch || 0) !== epochAtCall) return { accepted: false, queued: false, reason: "session was rewritten while this prompt was queued — dropped" };
			if (entry.compacting) return { accepted: false, queued: false, reason: "compaction in progress — try again shortly" };
			if (entry.agent.state.isStreaming) {
				return this._steer(entry, sessionId, content, images);
			}
			// repair dangling toolCalls (no matching toolResult) — ONLY when idle: a
			// mid-run repair would strip the live in-flight toolCall and corrupt the
			// active turn (grok r3: the old version ran BEFORE the isStreaming check)
			const msgs = entry.agent.state.messages;
			for (let i = msgs.length - 1; i >= 0; i--) {
				const m = msgs[i];
				if (m.role !== "assistant") continue;
				const trIds = new Set(msgs.filter((x) => x.role === "toolResult").map((x) => x.toolCallId));
				const filtered = Array.isArray(m.content) ? m.content.filter((p) => p.type !== "toolCall" || trIds.has(p.id)) : m.content;
				if (Array.isArray(m.content) && filtered.length !== m.content.length) {
					msgs[i] = { ...m, content: filtered.length > 0 ? filtered : [{ type: "text", text: "(tool call interrupted by error)" }] };
				}
				break; // only the last assistant message
			}
			await entry.agent.prompt(content, images);
			return { accepted: true, queued: false };
		};
		const next = prev.then(run, run);
		entry.promptLock = next.then(() => undefined, () => undefined);
		return next;
	}

	/** Error classes worth retrying automatically: the request never produced a
	 *  usable response (rate limit, network, transient 5xx). NOT retryable: auth /
	 *  invalid-key, context overflow, aborts — retrying those burns quota for
	 *  nothing. Matched on the provider error string (pi encodes provider failures
	 *  as an assistant message with stopReason "error" + errorMessage). */
	_isRetryableError(msg) {
		const s = String(msg?.errorMessage || "").toLowerCase();
		if (!s) return false;
		if (/401|403|unauthorized|invalid.?api.?key|authentication|permission/.test(s)) return false;
		if (/context length|too many tokens|maximum context|context.?window/.test(s)) return false;
		if (/429|too many requests|rate.?limit|quota exceeded|overloaded|capacity/.test(s)) return true;
		if (/500|502|503|504|bad gateway|service unavailable|gateway timeout|internal server error/.test(s)) return true;
		if (/econnreset|econnrefused|etimedout|epipe|enotfound|eai_again|socket hang up|fetch failed|network|connection (reset|closed|error)|timeout/.test(s)) return true;
		return false;
	}

	/** Auto-retry config (per hub; the client pushes its setting at attach/change). */
	setAutoRetry(cfg = {}) {
		this.autoRetry = {
			enabled: cfg.enabled !== undefined ? !!cfg.enabled : !!this.autoRetry?.enabled,
			attempts: Math.max(0, Math.min(10, Number(cfg.attempts ?? this.autoRetry?.attempts ?? 3) || 3)),
			delayMs: Math.max(0, Math.min(60000, Number(cfg.delayMs ?? this.autoRetry?.delayMs ?? 3000) || 3000)),
		};
		// A1 (reviewer1 #3, user report "cannot cancel auto-retry"): disabling must
		// also cancel ALREADY-SCHEDULED timers — the old code left entry.retryTimers
		// running and the callbacks never re-checked `enabled`, so a disable during a
		// 30 s Retry-After wait still fired. Cancel every session's pending retry.
		if (!this.autoRetry.enabled) {
			for (const [sid, e] of this.sessions) {
				if (!e.retryPending && !e.retryTimer) continue;
				this._cancelAutoRetry(e);
				e.retryNote = null;
				e.retryGivenUp = false;
				this.emitRuntime(sid);
			}
		}
		return { ...this.autoRetry };
	}

	/** Clear a session's pending auto-retry (timer + runtime marker + epoch bump).
	 *  Pure state clear — callers own retryNote cleanup + emitRuntime. The epoch
	 *  bump makes any timer callback that somehow still fires a no-op. */
	_cancelAutoRetry(entry) {
		if (entry?.retryTimer) { clearTimeout(entry.retryTimer); entry.retryTimer = null; }
		if (entry?.retryPending) { entry.retryPending = null; entry.retryEpoch = (entry.retryEpoch || 0) + 1; }
	}

	/** CANCEL the pending auto-retry of one session (new WS "cancel-retry", UI
	 *  Cancel button): cancels THIS pending retry only — auto-retry stays enabled
		*  for future failures, and the failed turn stays as-is (plain error + Retry). */
	cancelPendingRetry(sessionId) {
		const entry = this.sessions.get(sessionId);
		if (!entry) return { ok: false, reason: "no live session" };
		const had = !!entry.retryPending || !!entry.retryTimer;
		this._cancelAutoRetry(entry);
		entry.retryNote = null;
		entry.retryGivenUp = false;
		this.emitRuntime(sessionId);
		return { ok: true, cancelled: had };
	}

	/** Schedule ONE more attempt when a run died of a retryable error. Chained
	 *  attempts are capped by cfg.attempts; any user action (prompt/steer/abort/
	 *  edit/retry) and any success resets the counter, so it only ever retries the
	 *  same failing turn. */
	_maybeScheduleAutoRetry(entry, sessionId, failedMessage) {
		const cfg = this.autoRetry || { enabled: false };
		if (!cfg.enabled || !this._isRetryableError(failedMessage)) return;
		if (this.discarded.has(sessionId)) return;
		if ((entry.retryAttempts || 0) >= cfg.attempts) {
			entry.retryNote = `auto-retry gave up after ${cfg.attempts} attempt(s) — press Retry to try again`;
			entry.retryGivenUp = true;
			entry.retryPending = null;
			this.emitRuntime(sessionId);
			return;
		}
		// Honour a provider-specified wait when the error carries one ("retry after 30",
		// "retry-after: 30") — bounded to 30 s — and add a little jitter so N sessions that
		// hit the same rate limit do not retry in lockstep (grok review 2026-10-23).
		const nextAttempt = (entry.retryAttempts || 0) + 1;
		const ra = /retry[- ]?after[^0-9]{0,6}(\d{1,3})/i.exec(String(failedMessage?.errorMessage || ""));
		const waitMs = Math.max(cfg.delayMs, ra ? Math.min(30000, Number(ra[1]) * 1000) : 0) + Math.floor(Math.random() * 250);
		entry.retryNote = `retrying (${nextAttempt}/${cfg.attempts})…`;
		entry.retryGivenUp = false;
		this._cancelAutoRetry(entry);
		const epoch = (entry.retryEpoch = (entry.retryEpoch || 0) + 1);
		// RUNTIME EXPOSURE (auto-retry UI 2026-10-24): the pending retry ships on the
		// runtime frame — every device renders the same server-driven countdown;
		// retryAt (epoch ms) lets clients tick locally without server pushes.
		entry.retryPending = { attempt: nextAttempt, attempts: cfg.attempts, retryAt: Date.now() + waitMs, delayMs: waitMs, epoch };
		this.emitRuntime(sessionId);
		entry.retryTimer = setTimeout(() => {
			entry.retryTimer = null;
			// FIRE-TIME GUARDS (A2): enabled may have been flipped off, the session
			// discarded or compaction started AFTER scheduling — re-check live, and an
			// epoch mismatch means cancel/disable superseded this timer.
			if (!this.autoRetry?.enabled || this.discarded.has(sessionId) || entry.compacting || entry.retryPending?.epoch !== epoch) {
				entry.retryPending = null;
				entry.retryNote = null;
				this.emitRuntime(sessionId);
				return; // NO attempt burned
			}
			entry.retryPending = null;
			this.emitRuntime(sessionId);
			// The attempt counter commits HERE, synchronously at dispatch (A2): the
			// fire-time guards above already cleared refused cases (disabled/discarded/
			// compacting), so a burn here is a real dispatch. Committing in .then()
			// instead would lag behind the NEXT failure's agent_end (retry's promise
			// resolves at run end) and the cap check would under-count → over-run.
			entry.retryAttempts = nextAttempt;
			this.retry(sessionId, { reason: "auto" })
				.catch((err) => console.error(`[hub] auto-retry failed for ${sessionId}:`, err?.message || err));
		}, waitMs);
		if (typeof entry.retryTimer?.unref === "function") entry.retryTimer.unref();
	}

	/** Drop the artifacts of a FAILED step from the tail so the transcript can be
	 *  continued: the trailing assistant message(s) with stopReason error/aborted,
	 *  plus toolResults left orphaned (their assistant toolCall was dropped).
	 *  Returns how many messages were removed. */
	_dropFailedTail(entry) {
		const msgs = entry.agent.state.messages;
		let dropped = 0;
		for (;;) {
			const last = msgs[msgs.length - 1];
			if (!last) break;
			const failedAssistant = last.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted");
			const orphanResult = last.role === "toolResult" && !msgs.slice(0, -1).some((m) => m.role === "assistant" && Array.isArray(m.content) && m.content.some((p) => p.type === "toolCall" && p.id === last.toolCallId));
			// DEAD-END assistant (user report 2026-10-24): stopReason "toolUse" whose
			// toolCall was already stripped (hydration/prompt repair) — pi cannot
			// continue() from an assistant tail, so leaving it in place forces the
			// RESEND fallback (full wipe to the user turn). Pop it so retry
			// continues from the user turn instead. A HEALTHY assistant (stopReason
			// "stop"/"aborted" with text, or toolUse that still has calls) never
			// matches — retry must not regenerate healthy turns.
			const deadEndAssistant = last.role === "assistant" && last.stopReason === "toolUse" && Array.isArray(last.content) && !last.content.some((p) => p.type === "toolCall");
			if (!failedAssistant && !orphanResult && !deadEndAssistant) break;
			msgs.pop();
			dropped++;
		}
		if (dropped) {
			// REPAIR v2 (user report 2026-10-24: "toolcall and assistant turn removed
			// after clicking retry after 429"): a run that died mid-tool-round leaves
			// an assistant message whose toolCall never got a toolResult. The old
			// repair STRIPPED the dangling call — leaving the transcript ending on an
			// ASSISTANT message; retry()'s canContinue check (user/toolResult only)
			// then fell into the RESEND fallback, which truncates the whole turn back
			// to the user message. Thinking + tool round wiped. Now: keep the
			// assistant message and SYNTHESIZE an interrupted toolResult per dangling
			// call (pi's createToolResultMessage shape, isError) — the transcript
			// stays protocol-valid AND continue()-able: the model sees the
			// interrupted result and re-plans, i.e. exactly "retry from the toolcall
			// after removing the 429 message".
			const trIds = new Set(msgs.filter((x) => x.role === "toolResult").map((x) => x.toolCallId));
			for (let i = msgs.length - 1; i >= 0; i--) {
				const m = msgs[i];
				if (m.role !== "assistant") continue;
				if (Array.isArray(m.content)) {
					const dangling = m.content.filter((p) => p.type === "toolCall" && !trIds.has(p.id));
					for (const tc of dangling) {
						msgs.push({
							role: "toolResult",
							toolCallId: tc.id,
							toolName: tc.name,
							content: [{ type: "text", text: "(tool call interrupted by error — recovered by retry)" }],
							isError: true,
							timestamp: Date.now(),
						});
					}
				}
				break; // only the LAST assistant can dangle — earlier rounds are paired, else the run would have failed there
			}
			entry.mutateEpoch = (entry.mutateEpoch || 0) + 1;
		}
		return dropped;
	}

	/** RETRY (2026-10-23, user request): resume a failed run AT THE FAILURE POINT
	 *  instead of re-sending the user prompt. The old client-side retry appended a
	 *  SECOND user message (and for server-side sessions mutated a mirror the server
	 *  never saw). Here: drop the 429/error message, then agent.continue() — pi
	 *  re-issues the failed model call against the SAME transcript, so the user turn
	 *  stays exactly once and tool calls that already completed are NOT re-run.
	 *  Versions are untouched: an ✎ edit whose resubmit hit a 429 keeps its parked
	 *  delta and simply continues, as if the error had not happened. */
	async retry(sessionId, { reason = "manual" } = {}) {
		const entry = this.sessions.get(sessionId);
		if (!entry) return { ok: false, reason: "no live session" };
		if (entry.compacting) return { ok: false, reason: "compaction in progress — try again shortly" };
		if (entry.agent.state.isStreaming) return { ok: false, reason: "a run is already streaming" };
		if (reason !== "auto") { this._cancelAutoRetry(entry); entry.retryAttempts = 0; entry.retryNote = null; entry.retryGivenUp = false; }
		const dropped = this._dropFailedTail(entry);
		// refuse when nothing failed — retry must never regenerate a healthy turn
		if (dropped === 0) return { ok: false, reason: "nothing to retry (the transcript does not end in a failed turn)" };
		const msgs = entry.agent.state.messages;
		const tail = msgs[msgs.length - 1];
		const canContinue = !!tail && (tail.role === "user" || tail.role === "toolResult");
		if (!canContinue && !msgs.some((m) => m.role === "user")) return { ok: false, reason: "nothing to retry — no user turn in this session" };
		if (dropped > 0) { await this.persistSession(sessionId, true); this.broadcastState(sessionId); }
		const run = async () => {
			if (entry.agent.state.isStreaming) return { ok: false, reason: "a run is already streaming" };
			entry.runtime = { ...entry.runtime, status: "running", startedAt: Date.now(), turn: 0, currentTool: null, lastText: reason === "auto" ? "retrying…" : "retrying…", pendingPrompts: entry.pendingPrompt ? 1 : 0 };
			this.emitRuntime(sessionId);
			if (canContinue) {
				await entry.agent.continue();
				return { ok: true, mode: "continue", dropped };
			}
			// fallback (the tail is an assistant message): re-send the last user turn —
			// dropping it first so the retried run does NOT duplicate it
			let uIdx = -1;
			for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === "user") { uIdx = i; break; }
			if (uIdx < 0) return { ok: false, reason: "nothing to retry" };
			const u = msgs[uIdx];
			const text = typeof u.content === "string" ? u.content : u.content.filter((b) => b?.type === "text").map((b) => b.text || "").join("\n");
			const images = Array.isArray(u.content) ? u.content.filter((b) => b?.type === "image") : undefined;
			entry.agent.state.messages = msgs.slice(0, uIdx);
			await entry.agent.prompt(text, images?.length ? images : undefined);
			return { ok: true, mode: "resend", dropped };
		};
		const prev = entry.promptLock || Promise.resolve();
		const next = prev.then(run, run);
		entry.promptLock = next.then(() => undefined, () => undefined);
		return next;
	}

	abort(sessionId) {
		// debounce (grok Q5): Kill-spam overlapped timeouts, redundant library
		// flag writes and broadcast storms — one in-flight kill per session
		this._aborting ??= new Set();
		if (this._aborting.has(sessionId)) return;
		this._aborting.add(sessionId);
		setTimeout(() => this._aborting.delete(sessionId), 7000).unref?.();
		const entry = this.sessions.get(sessionId);
		if (!entry) return;
		this._cancelAutoRetry(entry); // an explicit Stop cancels any pending auto-retry
		entry.retryAttempts = 0;
		entry.retryNote = null;
		// STOP = stop EVERYTHING (user report 2026-10-23: with a pending steer the
		// chat "was not stopped" — the queued message survived the abort and injected
		// into the next run). Clear pi's steering queue + the hub's pending payload
		// on explicit abort; all devices resync via the steering frame below.
		try { entry.agent.clearSteeringQueue?.(); } catch { /* older core */ }
		if (entry.pendingPrompt || entry.pendingPromptMessage) {
			entry.pendingPrompt = null;
			entry.pendingPromptMessage = null;
			entry.runtime.pendingPrompts = 0;
			this.emitSteering(sessionId);
		}
		try { entry.agent.abort(); } catch { /* already dead */ }
		// KILL ARCHITECTURE (LFP zombie 2026-10-23): abort alone is NOT enough when
		// the run wedged on a tool promise — pi's flag flips but agent_end never
		// fires, so runtime.status stayed "running" forever (the session "cannot
		// be killed"). Retry chain: settle once pi's flag drops (1.5s, retry 2.5s),
		// then a HARD BACKSTOP at 6s that settles REGARDLESS of the flag (grok Q3:
		// the flag can stick TRUE with no agent_end — the self-heal skips because
		// !isStreaming is false, so the kill backstop is the only closer for the
		// original phantom case; _settleRuntime writes the flag as documented
		// last-resort for the library bug).
		const trySettle = (delay) => setTimeout(() => {
			const e = this.sessions.get(sessionId);
			if (!e || e.runtime?.status === "idle") return;
			if (!e.agent.state.isStreaming) this._settleRuntime(sessionId, e);
			else trySettle(2500); // one retry, ~4s total
		}, delay).unref?.();
		trySettle(1500);
		setTimeout(() => {
			const e = this.sessions.get(sessionId);
			if (e && e.runtime?.status !== "idle") {
				console.warn(`[hub] force-settle backstop: ${sessionId} still not settled 6s after Kill — overriding (library flag stuck / no agent_end)`);
				this._settleRuntime(sessionId, e);
			}
		}, 6000).unref?.();
	}

	setModel(sessionId, modelId) {
		const entry = this.getSession(sessionId);
		const model = this._getModel(modelId);
		if (model) {
			entry.agent.state.model = model;
			entry.model = model;
			this.persistSession(sessionId, true);
		}
		return !!model;
	}

	setThinkingLevel(sessionId, level) {
		// getSession (not sessions.get): a FRESH session has no store entry yet —
		// the old unguarded sessions.get crashed on entry.agent (2026-10-21 e2e)
		const entry = this.getSession(sessionId);
		entry.agent.state.thinkingLevel = level;
		entry.thinkingLevel = level;
	}

	/** Subscribe to a session's events (for SSE clients). Returns unsubscribe —
	 *  idempotent, removes ONLY its own callback. 2026-10-21 P2 fix: the old
	 *  implementation wrapped/restored the shared this.broadcast, so with two
	 *  overlapping subscribers the first unsubscribe stopped the second one's
	 *  delivery (and the reverse order restored a closed subscriber's wrapper). */
	onEvents(sessionId, callback) {
		this.getSession(sessionId); // ensure agent exists
		let subs = this.subscribers.get(sessionId);
		if (!subs) { subs = new Set(); this.subscribers.set(sessionId, subs); }
		subs.add(callback);
		return () => {
			const s = this.subscribers.get(sessionId);
			if (!s) return;
			s.delete(callback);
			if (s.size === 0) this.subscribers.delete(sessionId);
		};
	}

	/** Snapshot for attaching clients (cold sessions). Mid-run attachers get the
	 *  in-flight streamingMessage + pending tool calls too (grok r3 Q1). */
	getState(sessionId) {
		const entry = this.sessions.get(sessionId);
		if (!entry) {
			const model = this._defaultModel();
			return { exists: false, messages: [], model, thinkingLevel: "high", isStreaming: false, streamingMessage: null, pendingToolCalls: [] };
		}
		const state = entry.agent.state;
		const payload = {
			exists: true,
			messages: state.messages,
			model: state.model,
			thinkingLevel: state.thinkingLevel,
			isStreaming: state.isStreaming,
			streamingMessage: state.streamingMessage ?? null,
			pendingToolCalls: state.pendingToolCalls instanceof Set ? [...state.pendingToolCalls] : [],
			compacting: !!entry.compacting, // all devices show the progress banner
			pendingPrompt: entry.pendingPrompt ?? null,
		};
		return payload;
	}

	/** Full-state frame to all attached clients: fork/rewrite mutate the transcript
	 *  OUTSIDE the normal event stream, so clients must resynchronize wholesale
	 *  (the client's "state" handler replaces state.messages verbatim). Buffered
	 *  during attach snapshot builds like agent events. Bumps the shared seq —
	 *  every emission advances the one monotonic space (commit review). */
	broadcastState(sessionId) {
		const entry = this.sessions.get(sessionId);
		if (!entry) return;
		entry.seq += 1;
		const payload = { type: "state", sessionId, ...this.getState(sessionId) };
		if (entry.buffer) entry.buffer.push(payload);
		else this.broadcast(sessionId, payload);
	}

	/** Shared hydration for fork/rewrite: returns the live entry, hydrating from
	 *  the store when the hub has no entry (restart) or an EMPTY one (attach
	 *  created the Agent before the snapshot applied — getSession ignores init
	 *  messages for existing entries, so fill it in place here, normalized). */
	async _ensureEntry(sessionId) {
		let entry = this.sessions.get(sessionId);
		if (entry && entry.agent.state.messages.length > 0) return entry;
		if (this.loadMessages) {
			try {
				const stored = await this.loadMessages(sessionId);
				if (stored?.messages?.length) {
					if (!entry) {
						entry = this.getSession(sessionId, {
							modelId: stored.metadata?.modelId,
							thinkingLevel: stored.metadata?.thinkingLevel,
							title: stored.metadata?.title,
							messages: stored.messages,
						});
					} else {
						entry.agent.state.messages = normalizeRestoredMessages(stored.messages);
						if (stored.metadata?.modelId) { const m = this._getModel(stored.metadata.modelId); if (m) entry.agent.state.model = m; }
						if (stored.metadata?.thinkingLevel) entry.agent.state.thinkingLevel = stored.metadata.thinkingLevel;
						if (stored.metadata?.title) entry.title = stored.metadata.title;
					}
				}
			} catch { /* store miss → the caller's guards handle it */ }
		}
		return entry;
	}

	/** Mirror metadata builder (shared by _writeSession and empty forks). */
	_buildMetadata(sessionId) {
		const entry = this.sessions.get(sessionId);
		const state = entry.agent.state;
		const now = new Date().toISOString();
		const firstUser = state.messages.find((m) => m.role === "user" && !m.isCompactionSummary);
		let title = firstUser ? extractPreviewText(firstUser.content) || "Session" : (entry.forkedFrom ? "Fork" : "Session");
		// STICKY TITLE (user report 2026-10-23): compaction makes the summary the
		// first user message — the old re-derive-every-persist logic renamed the
		// session to "## Conversation summary (auto-compacted)". Once a real title
		// exists it never changes; only fresh entries (no title yet) derive one,
		// and they skip isCompactionSummary messages when doing so.
		// HEAL: a title that IS a summary heading is a pre-sticky artifact — treat
		// it as no title so the next persist re-derives a real one (fixes sessions
		// already renamed by the old logic, e.g. 656aacb0).
		const titleIsBad = !entry.title || entry.title === "Session" || entry.title === "Fork" || /^## Conversation summary \(auto-compacted\)/.test(entry.title);
		if (!titleIsBad) title = entry.title;
		entry.title = title; // STICKY: remember it so later persists never re-derive (entry.title was never stored before → sticky never engaged)
		const metadata = {
			id: sessionId,
			version: 1, // mirror format: linear messages (pi's tree format is v3 — see docs/session-format.md)
			title,
			modelId: state.model?.id ?? "",
			thinkingLevel: state.thinkingLevel,
			createdAt: entry.createdAt || now,
			lastModified: now,
			messageCount: state.messages.length,
		};
		if (entry.forkedFrom) metadata.forkedFrom = entry.forkedFrom; // lineage (pi header: parentSession)
		if (!entry.createdAt) entry.createdAt = now;
		return metadata;
	}

	/** FORK (llama.cpp webui parity — forkConversation): clone messages[0..keepCount)
	 *  into a NEW session and persist it (awaited — the store is authoritative
	 *  before the reply reaches the navigating client); the original is untouched.
	 *  Usage fields travel with the copied messages (FULL JSON deep copy — a
	 *  shallow {...m} would alias usage/cost between source and fork), so the
	 *  fork's UsageBar totals show the INHERITED spend — correct: those tokens
	 *  were spent. keepCount 0 is allowed (empty branch off the root prompt —
	 *  the ✎-on-first-message flow); it persists a header-only mirror because
	 *  _writeSession skips user-less sessions. */
	async forkSession(sessionId, keepCount) {
		const entry = await this._ensureEntry(sessionId);
		if (!entry) throw new Error("no live session");
		if (entry.compacting) throw new Error("compaction in progress");
		if (entry.agent.state.isStreaming) throw new Error("cannot fork while a run is streaming — stop it first");
		const msgs = entry.agent.state.messages;
		const n = Math.max(0, Math.min(Math.floor(Number(keepCount)) || 0, msgs.length));
		const messages = n > 0 ? JSON.parse(JSON.stringify(msgs.slice(0, n))) : [];
		const newId = crypto.randomUUID();
		const forked = this.getSession(newId, {
			modelId: entry.agent.state.model?.id,
			thinkingLevel: entry.agent.state.thinkingLevel,
			messages,
		});
		forked.forkedFrom = sessionId; // lineage in the JSONL header (pi's parentSession)
		// DISTINGUISHABLE TITLE (user report 2026-10-23): the fork used to inherit
		// the identical derived title — two same-named sessions in the sidebar and
		// the user "couldn't find the original". The fork gets the source title +
		// " ⑂" (stripped of a previous suffix on re-forks).
		const baseTitle = String(entry.title || "").replace(/ ⑂$/, "");
		if (baseTitle && baseTitle !== "Session" && baseTitle !== "Fork") forked.title = baseTitle + " ⑂";
		if (n === 0) await this.persist(newId, JSON.stringify(this._buildMetadata(newId)) + "\n");
		else await this.persistSession(newId, true);
		return { ok: true, newSessionId: newId, copied: n, title: forked.title || this._buildMetadata(newId).title };
	}

	/** REWRITE (linear-model message edit): truncate the transcript to
	 *  messages[0..keepCount) IN PLACE — the caller re-prompts with the edited
	 *  text. Idle only (Stop first). The client's UsageBar is message-derived, so
	 *  token totals and the context estimate shrink automatically; a forced
	 *  await-ed persist refreshes the mirror + session list. Queued steering is
	 *  dropped (a truncation invalidates it) and other devices resynchronize via
	 *  broadcastState. mutateEpoch invalidates prompts queued behind the
	 *  promptLock before the rewrite (commit review: the lock waiter captured its
	 *  text pre-truncate and would append stale turns). */
	async rewriteSession(sessionId, keepCount) {
		const entry = await this._ensureEntry(sessionId);
		if (!entry) throw new Error("no live session");
		if (entry.compacting) throw new Error("compaction in progress");
		if (entry.agent.state.isStreaming) throw new Error("cannot rewrite while a run is streaming — stop it first");
		const msgs = entry.agent.state.messages;
		const n = Math.max(0, Math.min(Math.floor(Number(keepCount)) || 0, msgs.length));
		// VERSION DELTA (user design: "save delta jsonl with some id"): park the
		// removed tail — turn number + first removed id + simple meta — in the
		// per-session versions sidecar. Restore swaps it back (lossless). This
		// replaces the gzip pre-rewrite backup (kept for compaction only).
		let version = null;
		if (n < msgs.length && this.versions) {
			try {
				version = await this.versions.append(sessionId, {
					turn: n,
					firstId: msgs[n]?.id || null,
					count: msgs.length - n,
					reason: "edit",
					messages: JSON.parse(JSON.stringify(msgs.slice(n))),
				});
			} catch { /* best-effort — the edit proceeds without a version */ }
		}
		entry.agent.state.messages = msgs.slice(0, n);
		entry.mutateEpoch = (entry.mutateEpoch || 0) + 1;
		entry.pendingPrompt = null;
		entry.pendingPromptMessage = null;
		entry.followUpCount = 0;
		entry.runtime.pendingPrompts = 0;
		this.emitRuntime(sessionId);
		this.emitSteering(sessionId);
		await this.persistSession(sessionId, true);
		this.broadcastState(sessionId);
		return { ok: true, kept: n, version };
	}

	/** VERSIONS: meta list of the session's saved deltas (no message bodies). */
	async listVersions(sessionId) {
		if (!this.versions) return [];
		return await this.versions.list(sessionId);
	}

	/** INLINE EDIT commit (llama.cpp-webui parity, user design 2026-10-23):
	 *  save a DIFFERENT text for messages[index]. The old tail (prompt +
	 *  responses) is parked as a version delta, the transcript is truncated to
		*  the prefix, and the edited text goes through the NORMAL prompt path (lock,
	 *  steer conversion, usage) — the response regenerates automatically.
		*  Identical text = no-op (a version is made only when a different message
		*  is saved). The ✎ click itself is pure UI — nothing reaches the server
		*  until this commit. */
	async editCommit(sessionId, index, text) {
		const entry = await this._ensureEntry(sessionId);
		if (!entry) throw new Error("no live session");
		if (entry.compacting) throw new Error("compaction in progress");
		if (entry.agent.state.isStreaming) throw new Error("cannot edit while a run is streaming — stop it first");
		const msgs = entry.agent.state.messages;
		const i = Math.max(0, Math.min(Math.floor(Number(index)) || 0, msgs.length - 1));
		if (!msgs[i] || msgs[i].role !== "user") throw new Error("can only edit user messages");
		const contentText = (m) => (typeof m?.content === "string" ? m.content : (m?.content || []).filter((b) => b?.type === "text").map((b) => b.text || "").join("\n"));
		if (String(text).trim() === contentText(msgs[i]).trim()) return { ok: true, noop: true };
		// an edit supersedes any pending auto-retry of the turn it replaces
		this._cancelAutoRetry(entry);
		entry.retryAttempts = 0;
		entry.retryNote = null;
		let version = null;
		if (this.versions) {
			try {
				version = await this.versions.append(sessionId, {
					turn: i,
					firstId: msgs[i]?.id || null,
					count: msgs.length - i,
					reason: "edit",
					messages: JSON.parse(JSON.stringify(msgs.slice(i))),
				});
			} catch { /* best-effort */ }
		}
		entry.agent.state.messages = msgs.slice(0, i);
		entry.mutateEpoch = (entry.mutateEpoch || 0) + 1;
		entry.pendingPrompt = null; entry.pendingPromptMessage = null; entry.followUpCount = 0; entry.runtime.pendingPrompts = 0;
		this.emitRuntime(sessionId); this.emitSteering(sessionId);
		await this.persistSession(sessionId, true);
		this.broadcastState(sessionId);
		// DO NOT await the run: hub.prompt() resolves at RUN END (promptLock holds
		// through the whole stream) — awaiting it delayed the edit-committed reply
		// by minutes, the client's await timed out, and the editor stayed open with
		// the region dimmed while the response streamed invisibly (user report:
		// "ui is not updated / had to press send again"). Reply immediately; the
		// streamed response arrives as normal agent events on every device.
		const pr = this.prompt(sessionId, String(text || ""));
		// visible failures (review P3): both the rejection AND the not-accepted
		// result (lock/race/epoch rejection) surface in the server log — the
		// truncated transcript is already visible on every device via the state
		// frame above, so a rejected re-prompt shows as a missing turn, not silence
		pr.then((r) => {
			if (!r?.accepted) console.warn(`[hub] edit-commit prompt NOT accepted for ${sessionId}:`, r?.reason || r);
		}).catch((err) => console.error(`[hub] edit-commit prompt failed for ${sessionId}:`, err?.message || err));
		return { ok: true, version, accepted: true };
	}

	/** RESTORE a version: swap the saved tail back into the active transcript.
	 *  The CURRENT tail from the same cut point is captured FIRST as its own
		*  delta (reason "switch-away") — switching versions is lossless in both
		*  directions. The restored messages REPLACE active[turn..]: prefixes are
		*  shared by construction at capture time; after intervening edits the
		*  splice is still deterministic (clamp turn to the active length). */
	async restoreVersion(sessionId, vid) {
		if (!this.versions) throw new Error("versions not configured");
		const entry = await this._ensureEntry(sessionId);
		if (!entry) throw new Error("no live session");
		if (entry.compacting) throw new Error("compaction in progress");
		if (entry.agent.state.isStreaming) throw new Error("cannot restore a version while a run is streaming — stop it first");
		const rec = await this.versions.get(sessionId, vid);
		if (!rec || !Array.isArray(rec.messages)) throw new Error(`version ${vid} not found`);
		const active = entry.agent.state.messages;
		const base = Math.max(0, Math.min(Number(rec.turn) || 0, active.length));
		// NO-OP restore (user report 2026-10-24): clicking "switch to" on the
		// version that already matches the live tail changed nothing but still
		// bumped the epoch + re-persisted. Detect and return early.
		if (JSON.stringify(active.slice(base)) === JSON.stringify(rec.messages)) return { ok: true, noop: true, restored: vid };
		if (active.length > base) {
			try {
				await this.versions.append(sessionId, {
					turn: base,
					firstId: active[base]?.id || null,
					count: active.length - base,
					reason: `switch-away (restoring v${vid})`,
					messages: JSON.parse(JSON.stringify(active.slice(base))),
				});
			} catch { /* best-effort */ }
		}
		entry.agent.state.messages = [...active.slice(0, base), ...JSON.parse(JSON.stringify(rec.messages))];
		entry.mutateEpoch = (entry.mutateEpoch || 0) + 1;
		entry.pendingPrompt = null;
		entry.pendingPromptMessage = null;
		entry.followUpCount = 0;
		entry.runtime.pendingPrompts = 0;
		this.emitRuntime(sessionId);
		this.emitSteering(sessionId);
		await this.persistSession(sessionId, true);
		this.broadcastState(sessionId);
		return { ok: true, restored: vid, count: entry.agent.state.messages.length };
	}

	/** COMPACT (pi /compact parity): summarize older history, replace the span
	 *  with a single flagged summary message, keep the recent tail. Algorithm
	 *  mirrors pi's compaction.md: cut point = walk BACKWARDS accumulating token
	 *  estimates (chars/4) until keepRecentTokens (default 20k); never split an
	 *  assistant toolCall from its toolResult (cut advances past toolResults);
	 *  the span STARTS AFTER any previous compaction summary (iterative folding —
	 *  messages that survived an earlier compaction are folded into the next
	 *  summary). The mirror is linear (pi keeps raw entries in-file; we do not),
	 *  so a pre-compact BACKUP of the mirror is written via backupMirror before
	 *  the replace. Usage note: the summary message carries NO usage — the
	 *  UsageBar totals drop to the kept tail (the summarization call itself is a
	 *  side call, deliberately not billed to the transcript). Guards: idle only,
	 *  one compaction at a time; prompt/steer/fork/rewrite reject while
	 *  entry.compacting is set. */
	async compactSession(sessionId, { keepRecentTokens = 20000, signal } = {}) {
		const entry = await this._ensureEntry(sessionId);
		if (!entry) throw new Error("no live session");
		if (entry.agent.state.isStreaming) throw new Error("cannot compact while a run is streaming — stop it first");
		if (entry.compacting) throw new Error("compaction already in progress");
		if (!this.summarize) throw new Error("no summarizer configured");
		const msgs = entry.agent.state.messages;
		const est = (m) => Math.ceil((typeof m.content === "string" ? m.content : JSON.stringify(m.content)).length / 4);
		let kept = 0, i = msgs.length - 1;
		while (i >= 0 && kept < keepRecentTokens) { kept += est(msgs[i]); i--; }
		let cut = i + 1;
		while (cut < msgs.length && msgs[cut].role === "toolResult") cut++; // never split call/result
		const prevIdx = msgs.findIndex((m) => m.isCompactionSummary);
		const from = prevIdx >= 0 ? prevIdx + 1 : 0;
		if (cut - from < 2) throw new Error("nothing substantial to compact");
		entry.compacting = true;
		this.broadcastState(sessionId); // all devices show the progress banner immediately
		let ok = false;
		try {
			const serialized = serializeConversation(msgs.slice(from, cut));
			const prevText = (m) => (typeof m.content === "string" ? m.content : (m.content || []).filter((b) => b?.type === "text").map((b) => b.text || "").join("\n"));
			const previousSummary = prevIdx >= 0 ? prevText(msgs[prevIdx]) : "";
			let backupPath = null;
			if (this.backupMirror) { try { backupPath = await this.backupMirror(sessionId); } catch { /* best-effort */ } }
			const summary = await this.summarize({ model: entry.agent.state.model, serialized, previousSummary, signal });
			if (!summary || !String(summary).trim()) throw new Error("summarizer returned empty output");
			const summaryMsg = { role: "user", isCompactionSummary: true, content: [{ type: "text", text: "## Conversation summary (auto-compacted)\n\n" + String(summary).trim() }], timestamp: Date.now() };
			const keptMsgs = msgs.slice(cut).map((m) => { const c = { ...m }; if (Array.isArray(c.content)) c.content = JSON.parse(JSON.stringify(c.content)); return c; });
			entry.agent.state.messages = [summaryMsg, ...keptMsgs];
			entry.mutateEpoch = (entry.mutateEpoch || 0) + 1;
			entry.pendingPrompt = null; entry.pendingPromptMessage = null; entry.followUpCount = 0; entry.runtime.pendingPrompts = 0;
			this.emitRuntime(sessionId); this.emitSteering(sessionId);
			await this.persistSession(sessionId, true);
			ok = true;
			return { ok: true, summarized: cut - from, kept: msgs.length - cut, summaryChars: String(summary).trim().length, backupPath };
		} finally {
			// clear BEFORE the final broadcast: the success path used to broadcast
			// while entry.compacting was still true, so every device's banner kept
			// ticking forever (no further state frame until the next turn)
			entry.compacting = false;
			this.broadcastState(sessionId); // final frame: new messages + compacting:false (success AND failure)
		}
	}

	/** Runtime for an existing entry — idle included, seq-stamped (the client's
	 *  stale-frame guard needs seq even on terminal idle deltas). null = the hub
	 *  has no entry. Other devices' discovery uses the non-idle subset.
	 *
	 *  ZOMBIE SELF-HEAL (2026-10-23 LFP incident): a run can die WITHOUT agent_end
	 *  (tool promise wedged + abort — pi's flag flips but no terminal event),
	 *  leaving runtime.status="running" forever; the alive list then showed 23
	 *  ghost sessions, some days old, and Kill (abort) could not clear them
	 *  ("cannot be killed even after server restarting"). Runtime is DERIVED
	 *  liveness: if pi says not streaming, "running" is a lie — settle it. */
	getRuntime(sessionId) {
		const entry = this.sessions.get(sessionId);
		if (!entry) return null;
		if (entry.runtime?.status === "running" && !entry.agent.state.isStreaming
			&& Date.now() - (entry.lastEventAt || entry.runtime.startedAt || 0) > 15_000) {
			// staleness floor (grok Q1 2026-10-23): pi's isStreaming legitimately dips
			// false between the LLM calls of a MULTI-TURN run while runtime correctly
			// stays "running" (agent_end only fires at run end) — without the floor a
			// list read in that gap would force-idle a LIVE run. Only a run QUIESCENT
			// for 15s+ with the flag down is a zombie.
			// settle to the TRUTHFUL terminal state (an errored run stays "error" —
			// the alive dialog refuses Kill on error rows and colors them red)
			const lastA = [...entry.agent.state.messages].reverse().find((m) => m.role === "assistant");
			entry.runtime = { status: lastA?.stopReason === "error" ? "error" : "idle", startedAt: null, turn: 0, currentTool: null, lastText: null, pendingPrompts: entry.pendingPrompt ? 1 : 0 };
			try { this.emitRuntime(sessionId); } catch { /* sink must not break reads */ }
			console.log(`[hub] runtime zombie settled: ${sessionId} (last stop=${lastA?.stopReason || "none"} — no agent_end ever fired)`);
		}
		return { ...entry.runtime, sessionId, seq: entry.seq, ...this._retryRuntimeView(entry) };
	}

	/** The retry slice of the runtime frame (auto-retry UI 2026-10-24): pending
	 *  countdown (server-driven, client ticks from retryAt) or the give-up note.
	 *  Absent otherwise — presence is the signal, no boolean soup. */
	_retryRuntimeView(entry) {
		if (entry.retryPending) {
			const p = entry.retryPending;
			return { retry: { state: "scheduled", attempt: p.attempt, attempts: p.attempts, retryAt: p.retryAt, delayMs: p.delayMs, epoch: p.epoch } };
		}
		if (entry.retryGivenUp && entry.retryNote) return { retry: { state: "given-up", note: entry.retryNote } };
		return {};
	}

	/** Authoritative force-settle: used by abort()/Kill — the terminal event may
	 *  never come (wedged tool promise). Flips the runtime to idle + emits it so
	 *  every device's alive row clears, and defensively clears pi's streaming
	 *  flag (the phantom-streaming guard from a16f0b9, moved here per review). */
	_settleRuntime(sessionId, entry, { lastText = null } = {}) {
		if (entry.agent.state.isStreaming) entry.agent.state.isStreaming = false;
		const lastA = [...entry.agent.state.messages].reverse().find((m) => m.role === "assistant");
		const failed = lastA?.stopReason === "error";
		entry.runtime = { status: failed ? "error" : "idle", startedAt: null, turn: 0, currentTool: null, lastText, pendingPrompts: entry.pendingPrompt ? 1 : 0 };
		this.emitRuntime(sessionId);
		// the caller (agent_end) still needs these for the retry policy — one scan, one place
		return { lastA, failed };
	}

	/** Steering pending-state delta: broadcast to all attached /ws/agent clients
	 *  (and buffered during attach snapshot builds, same as agent events). The
	 *  pending payload is also part of every state snapshot, so a missed frame
	 *  self-heals on the next attach. */
	emitSteering(sessionId) {
		const entry = this.sessions.get(sessionId);
		if (!entry) return;
		const payload = { type: "steering", sessionId, pending: entry.pendingPrompt ?? null };
		if (entry.buffer) entry.buffer.push(payload);
		else this.broadcast(sessionId, payload);
	}

	/** Cancel a pending steering message (✕ in the UI): clear pi's steering queue
	 *  AND the entry tracking, then tell every device. "Edit" = cancel here + the
	 *  client prefills its composer with the pending text it already has. Returns
	 *  false when nothing was pending (or the session isn't live). */
	cancelSteering(sessionId) {
		const entry = this.sessions.get(sessionId);
		if (!entry || !entry.pendingPrompt) return false;
		try { entry.agent.clearSteeringQueue(); } catch { /* already drained */ }
		entry.pendingPromptMessage = null;
		entry.pendingPrompt = null;
		entry.followUpCount = 0;
		entry.runtime.pendingPrompts = 0;
		this.emitRuntime(sessionId);
		this.emitSteering(sessionId);
		return true;
	}

	/** Sink for runtime deltas: the server wires this to a {type:"runtime"} frame
	 *  on /ws/sync. Boundaries emit immediately; lastText previews ≤1/2s. Every
	 *  emission advances the SHARED entry.seq (2026-10-21 commit review P2: runtime-
	 *  only deltas — attach/detach client counts, queued prompts, the preview timer —
	 *  previously reused the last agent-event seq, and the client's stale-frame guard
	 *  `rt.seq <= cur.seq` dropped them, leaving the runtime UI stale. Agent-event seq
	 *  is consumed nowhere else client-side, so one monotonic space is safe: gaps are
	 *  fine, strictly-forward per emission is what the guard needs. Never bump from
	 *  getRuntime — the counter moves ONLY on emit so REST snapshots and WS frames
	 *  share one ordering. */
	emitRuntime(sessionId) {
		if (!this.onRuntimeChange) return;
		const entry = this.sessions.get(sessionId);
		if (!entry) return;
		entry.seq += 1;
		try { this.onRuntimeChange(sessionId, this.getRuntime(sessionId)); } catch { /* the sink must never break a run */ }
	}

	/** Delete-side hook: a session deleted from any device must not resurrect via
	 *  a later persist — abort a live run, drop the entry + subscribers, and
	 *  tombstone persists for this id (cleared if the id is explicitly re-opened). */
	discard(sessionId) {
		const entry = this.sessions.get(sessionId);
		this.discarded.add(sessionId);
		if (!entry) return;
		this._cancelAutoRetry(entry);
		try { if (entry.agent.state.isStreaming) entry.agent.abort(); } catch { /* already dead */ }
		if (entry.previewTimer) { clearTimeout(entry.previewTimer); entry.previewTimer = null; }
		this.sessions.delete(sessionId);
		this.subscribers.delete(sessionId);
		// idle delta with a MAX seq — passes the client's stale-frame guard so the
		// runtime entry is removed everywhere immediately
		try { this.onRuntimeChange?.(sessionId, { sessionId, status: "idle", seq: Number.MAX_SAFE_INTEGER }); } catch { /* ignore */ }
	}

	/** Shutdown hook (SIGINT/SIGTERM/stdin-close): abort live runs (agent_end
	 *  fires → clean stopReason "aborted"), clear preview timers, and flush EVERY
	 *  session through the worker immediately (empty/model-only sessions are
	 *  skipped by _writeSession). server.mjs drains the pending store ops before
	 *  process exit, so no turn is lost. Returns the number of hub sessions. */
	shutdown() {
		let n = 0;
		for (const [id, entry] of this.sessions) {
			n++;
			if (entry.previewTimer) { clearTimeout(entry.previewTimer); entry.previewTimer = null; }
			this._cancelAutoRetry(entry);
			if (entry.agent.state.isStreaming) {
				try { entry.agent.abort(); } catch { /* already dead */ }
			}
			try { this.persistSession(id, true); } catch { /* best effort */ }
		}
		return n;
	}

	/** Evict idle agents: not streaming, no clients attached, idle > 30min.
	 *  Flush-before-evict (force-write any pending debounce). */
	evict() {
		const now = Date.now();
		for (const [id, entry] of this.sessions) {
			const busy = entry.agent.state.isStreaming;
			if (busy) continue;
			if (now - entry.lastActivity > IDLE_EVICT_MS) {
				this._writeSession(id); // force-flush pending debounce
				this.sessions.delete(id);
				this.subscribers.delete(id); // SSE subscribers die with the session
				console.info(`[agent-hub] evicted idle session ${id.slice(0, 8)}`);
			}
		}
		// LRU cap on hot agents
		const active = [...this.sessions.entries()].filter(([, e]) => !e.agent.state.isStreaming);
		if (this.sessions.size > HOT_AGENT_CAP + 5) {
			active.sort((a, b) => a[1].lastActivity - b[1].lastActivity);
			const excess = this.sessions.size - HOT_AGENT_CAP;
			for (let i = 0; i < excess && i < active.length; i++) {
				const [id] = active[i];
				this._writeSession(id);
				this.sessions.delete(id);
				this.subscribers.delete(id);
			}
		}
	}

	/** Flush everything (SIGINT/SIGTERM). */
	flushAll() {
		for (const id of this.sessions.keys()) this._writeSession(id);
	}

	has(sessionId) {
		return this.sessions.has(sessionId);
	}
}
