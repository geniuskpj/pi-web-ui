// agent-hub.mjs — SERVER-SIDE agent sessions (v2, hardened per Sonnet review).
//
// The agent loop (pi-agent-core) runs HERE in Node — never in the browser:
//   - LLM calls go directly to the provider (identical to the pi TUI path)
//   - API keys stay in .pi/auth.json on the server (never sent to clients)
//   - sessions persist to the worker store after every turn (atomic writes)
//   - every connected device (laptop/phone) is a viewer/controller via /ws/agent
// Clients can disconnect at any time — long jobs keep running server-side.
import { Agent } from "@earendil-works/pi-agent-core";

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

export class AgentHub {
	constructor({ modelsStore, getAuth, persist, broadcast, getTools, getSystemPrompt, defaultModelId, onRuntimeChange }) {
		this.modelsStore = modelsStore;
		this.getAuth = getAuth;
		this.persist = persist; // async (id, data, metadata) — worker store (atomic)
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

	getSession(sessionId, { modelId, thinkingLevel, messages } = {}) {
		this.discarded.delete(sessionId); // explicit re-open undeletes
		let entry = this.sessions.get(sessionId);
		if (!entry) {
			const model = this._getModel(modelId) || this._defaultModel();
			if (!model) throw new Error("no models available");
			const level = thinkingLevel || "high";
			const systemPrompt = this.getSystemPrompt(); // undefined → pi's built-in chat default
			const agent = new Agent({
				initialState: {
					model,
					thinkingLevel: level,
					messages: messages || [],
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
			};
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
				} else if (event.type === "agent_end") {
					if (entry.previewTimer) { clearTimeout(entry.previewTimer); entry.previewTimer = null; }
					const lastA = [...entry.agent.state.messages].reverse().find((m) => m.role === "assistant");
					entry.runtime = { status: lastA?.stopReason === "error" ? "error" : "idle", startedAt: null, turn: 0, currentTool: null, lastText: null, pendingPrompts: 0 };
					this.emitRuntime(sessionId); // explicit idle/error delta — the terminal state is never lost
				}
				const payload = { type: "agent-event", sessionId, seq: entry.seq, event };
				// attach() buffering hook (2026-10-21: replaces the old global
				// this.broadcast swap, which was not reentrant when two attaches overlapped)
				if (entry.buffer) entry.buffer.push(payload);
				else this.broadcast(sessionId, payload);
				// SSE subscribers fan out from a per-session set (2026-10-21 P2 fix:
				// onEvents no longer wraps/restores the shared broadcast)
				const subs = this.subscribers.get(sessionId);
				if (subs) for (const cb of [...subs]) { try { cb({ type: "agent-event", event }); } catch { /* listener error — drop */ } }
				entry.lastActivity = Date.now();
				// persistence triggers: user message immediately; everything else debounced
				if (event.type === "message_end" && event.message?.role === "user") {
					this.persistSession(sessionId, true);
				} else if (event.type === "message_end" || event.type === "agent_end") {
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
			this._writeSession(sessionId);
			return;
		}
		entry.persistTimer = setTimeout(() => this._writeSession(sessionId), 400);
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
		const metadata = {
			id: sessionId,
			title,
			modelId: state.model?.id ?? "",
			thinkingLevel: state.thinkingLevel,
			createdAt: entry.createdAt || now,
			lastModified: now,
			messageCount: state.messages.length,
		};
		if (!entry.createdAt) entry.createdAt = now;
		const lines = [JSON.stringify(metadata)];
		for (const m of state.messages) {
			const out = { role: m.role, content: m.content };
			if (m.timestamp) out.timestamp = m.timestamp;
			lines.push(JSON.stringify(out));
		}
		this.persist(sessionId, lines.join("\n") + "\n").catch((err) => {
			console.error(`Failed to persist session ${sessionId}:`, err);
		});
	}

	async prompt(sessionId, content, images) {
		const entry = this.getSession(sessionId);
		// per-session mutex: two devices prompting an IDLE session concurrently
		// would both pass the isStreaming check and race agent.prompt (which
		// throws on concurrent prompts). Serialized; queued path handles streaming.
		const prev = entry.promptLock || Promise.resolve();
		const run = async () => {
			if (entry.agent.state.isStreaming) {
				// follow-up queue depth 1 (reject a third+ concurrent ask explicitly)
				if (entry.followUpCount >= 1) {
					return { accepted: false, queued: false, reason: "A message is already queued — wait for it to finish." };
				}
				entry.followUpCount += 1;
				// followUp() takes an AgentMessage — inline images as content parts
				entry.agent.followUp({
					role: "user",
					content: images?.length ? [{ type: "text", text: content }, ...images] : content,
					timestamp: Date.now(),
				});
				entry.runtime.pendingPrompts = (entry.runtime.pendingPrompts || 0) + 1;
				this.emitRuntime(sessionId); // other devices see "running · +1 queued"
				return { accepted: true, queued: true };
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

	abort(sessionId) {
		const entry = this.sessions.get(sessionId);
		if (entry) entry.agent.abort();
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
		return {
			exists: true,
			messages: state.messages,
			model: state.model,
			thinkingLevel: state.thinkingLevel,
			isStreaming: state.isStreaming,
			streamingMessage: state.streamingMessage ?? null,
			pendingToolCalls: state.pendingToolCalls instanceof Set ? [...state.pendingToolCalls] : [],
		};
	}

	/** Runtime for an existing entry — idle included, seq-stamped (the client's
	 *  stale-frame guard needs seq even on terminal idle deltas). null = the hub
	 *  has no entry. Other devices' discovery uses the non-idle subset. */
	getRuntime(sessionId) {
		const entry = this.sessions.get(sessionId);
		if (!entry) return null;
		return { ...entry.runtime, sessionId, seq: entry.seq };
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
