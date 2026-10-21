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
	constructor({ modelsStore, getAuth, persist, broadcast }) {
		this.modelsStore = modelsStore;
		this.getAuth = getAuth;
		this.persist = persist; // async (id, data, metadata) — worker store (atomic)
		this.broadcast = broadcast; // (sessionId, msg) — send to attached clients
		this.sessions = new Map(); // sessionId -> entry
	}

	_getModel(modelId) {
		for (const p of Object.values(this.modelsStore)) {
			const m = (p.models || []).find((x) => x.id === modelId);
			if (m) return { ...m, provider: p.name || m.provider };
		}
		return undefined;
	}

	_defaultModel() {
		for (const p of Object.values(this.modelsStore)) {
			const m = (p.models || [])[0];
			if (m) return { ...m, provider: p.name || m.provider };
		}
		return undefined;
	}

	getSession(sessionId, { modelId, thinkingLevel, messages } = {}) {
		let entry = this.sessions.get(sessionId);
		if (!entry) {
			const model = this._getModel(modelId) || this._defaultModel();
			if (!model) throw new Error("no models available");
			const level = thinkingLevel || "high";
			const agent = new Agent({
				initialState: {
					model,
					thinkingLevel: level,
					messages: messages || [],
					tools: [], // server-side chat: browser-only tools (REPL/artifacts) not available
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
				lastActivity: Date.now(),
				persistTimer: null,
				persistMaxTimer: null,
				userPersisted: false,
				followUpCount: 0,
			};
			this.sessions.set(sessionId, entry);

			agent.subscribe((event) => {
				entry.seq += 1;
				const payload = { type: "agent-event", sessionId, seq: entry.seq, event };
				const clients = this.broadcast(sessionId, payload); // returns # delivered
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
	 *  deliver snapshot + buffered (deduped by seq). Prevents event loss. */
	attach(sessionId, deliver) {
		const entry = this.getSession(sessionId);
		const queue = [];
		const buffering = { active: true };
		const origBroadcast = { fn: this.broadcast };
		// temporarily intercept broadcast for THIS session to buffer events
		const bufferedBroadcast = (sid, msg) => {
			if (sid === sessionId && buffering.active) queue.push(msg);
			else origBroadcast.fn(sid, msg);
		};
		this.broadcast = bufferedBroadcast;
		const state = {
			exists: true,
			messages: entry.agent.state.messages,
			model: entry.agent.state.model,
			thinkingLevel: entry.agent.state.thinkingLevel,
			isStreaming: entry.agent.state.isStreaming,
			seq: entry.seq,
		};
		buffering.active = false;
		this.broadcast = origBroadcast.fn; // restore
		// deliver snapshot then buffered events (already seq-stamped, in order)
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
		const state = entry.agent.state;
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
		console.log("[agent-hub] persist:", sessionId.slice(0,15), "msgs:", state.messages.length, "roles:", state.messages.map(m=>m.role).join(","));
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

	async prompt(sessionId, content) {
		const entry = this.getSession(sessionId);
		if (entry.agent.state.isStreaming) {
			// follow-up queue depth 1 (reject a third+ concurrent ask explicitly)
			if (entry.followUpCount >= 1) {
				return { accepted: false, queued: false, reason: "A message is already queued — wait for it to finish." };
			}
			entry.followUpCount += 1;
			entry.agent.followUp(content);
			return { accepted: true, queued: true };
		}
		await entry.agent.prompt(content);
		return { accepted: true, queued: false };
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
		const entry = this.sessions.get(sessionId);
		entry.agent.state.thinkingLevel = level;
		entry.thinkingLevel = level;
	}

	/** Subscribe to a session's events (for SSE clients). Returns unsubscribe. */
	onEvents(sessionId, callback) {
		this.getSession(sessionId); // ensure agent exists
		const origBroadcast = this.broadcast;
		this.broadcast = (sid, msg) => {
			origBroadcast(sid, msg);
			if (sid === sessionId) callback({ type: 'agent-event', event: msg.event || msg });
		};
		return () => { this.broadcast = origBroadcast; };
	}

	/** Snapshot for attaching clients (cold sessions). */
	getState(sessionId) {
		const entry = this.sessions.get(sessionId);
		if (!entry) {
			const model = this._defaultModel();
			return { exists: false, messages: [], model, thinkingLevel: "high", isStreaming: false };
		}
		const state = entry.agent.state;
		return { exists: true, messages: state.messages, model: state.model, thinkingLevel: state.thinkingLevel, isStreaming: state.isStreaming };
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
