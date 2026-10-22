// proxy-agent.ts — client-side Agent adapter over a single WebSocket (/ws/agent).
//
// The agent loop runs SERVER-SIDE. One WS connection carries:
//   - agent events (message_start/update/end, thinking, agent_start/end)
//   - state snapshots (on attach and reconnect)
//   - commands (prompt, abort, set-model, set-thinking)
type Listener = (event: any) => void;
type AnyRecord = Record<string, any>;
import { makeId } from "./id.js";

export class ProxyAgent {
	/** true = the loop runs server-side (agent-hub.mjs): runs survive browser
	 *  closes; the browser stores no API keys (getApiKey is absent by design). */
	readonly serverSide = true;
	state: AnyRecord = {
		messages: [] as any[],
		isStreaming: false,
		model: undefined as any,
		thinkingLevel: "high" as string,
		pendingToolCalls: new Set<string>(),
		tools: [] as any[],
		streamingMessage: undefined as any,
		errorMessage: undefined as string | undefined,
	};

	private listeners = new Set<Listener>();
	private ws: WebSocket | null = null;
	private sessionId: string;
	private enabled = false;
	private attached = false;
	private retryCount = 0;
	private retryTimer: ReturnType<typeof setTimeout> | null = null;
	private generation = 0;
	private readyCallbacks: Array<(ok: boolean) => void> = [];

	constructor(sessionId: string, initialModel?: any) {
		this.sessionId = sessionId || makeId(); // randomUUID is secure-context-only
		if (initialModel) this.state.model = initialModel;
	}

	connect() {
		if (this.enabled) return;
		this.enabled = true;
		this.dial();
	}

	disconnect() {
		this.enabled = false;
		if (this.ws) { this.ws.close(); this.ws = null; }
		this.attached = false;
	}

	private dial() {
		if (!this.enabled) return;
		const gen = ++this.generation;
		const proto = location.protocol === "https:" ? "wss:" : "ws:";
		try {
			this.ws = new WebSocket(`${proto}//${location.host}/ws/agent`);
		} catch {
			this.scheduleRetry();
			return;
		}
		const sock = this.ws;
		sock.onopen = () => {
			if (gen !== this.generation) return;
			this.retryCount = 0;
			this.attached = false;
			// small delay: WS handshake timing on Windows
			setTimeout(() => {
				if (gen !== this.generation || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
				// attach carries the client's chosen model/effort so a FRESH server
				// session runs what the UI shows (grok r3: model desync)
				this.sendMsg({ type: "attach", sessionId: this.sessionId, modelId: this.state.model?.id, thinkingLevel: this.state.thinkingLevel });
				const cbs = this.readyCallbacks.splice(0);
				cbs.forEach((cb) => cb(this.attached));
			}, 50);
		};
		sock.onmessage = (e) => {
			if (gen !== this.generation) return;
			try { this.handleWsMessage(JSON.parse(e.data)); } catch (err) { console.error("[proxy-agent] parse:", err); }
		};
		sock.onclose = () => {
			if (gen !== this.generation) return;
			this.ws = null;
			this.attached = false;
			// settle in-flight prompt/steer replies WITHOUT a reject: a dropped
			// socket mid-run does NOT mean the run/steer died (runs survive
			// disconnects server-side) — the composer must not restore text we
			// can't know the fate of. `lost:true` makes the Editor skip the restore.
			for (const [id, resolve] of [...this.pendingReplies]) {
				this.pendingReplies.delete(id);
				resolve({ accepted: false, lost: true, reason: "connection lost" });
			}
			this.scheduleRetry();
		};
		sock.onerror = () => { try { sock.close(); } catch { /* noop */ } };
	}

	private scheduleRetry() {
		if (!this.enabled) return;
		const delay = Math.min(30000, 1000 * 2 ** this.retryCount++) * (0.5 + Math.random() * 0.5);
		clearTimeout(this.retryTimer as any);
		this.retryTimer = setTimeout(() => this.dial(), delay);
	}

	private sendMsg(msg: AnyRecord) {
		if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
	}

	private handleWsMessage(msg: AnyRecord) {
		if (msg.type === "state") {
			this.sessionId = msg.sessionId || this.sessionId;
			this.attached = true;
			this.state.messages = [...(msg.messages || [])];
			this.state.model = msg.model;
			this.state.thinkingLevel = msg.thinkingLevel || "high";
			this.state.isStreaming = !!msg.isStreaming;
			// compaction in progress (server truth) — all devices show the banner;
			// survives a client-side await timeout (the server keeps running)
			this.state.compacting = !!(msg as any).compacting;
			// mid-run attach: the hub includes the in-flight partial + pending tools
			this.state.streamingMessage = msg.streamingMessage || undefined;
			this.state.pendingToolCalls = new Set(msg.pendingToolCalls || []);
			if (!msg.isStreaming) this.state.streamingMessage = undefined;
			// steering: a message held mid-run (sent after the current step completes)
			this.pendingPrompt = (msg as any).pendingPrompt ?? null;
			this.notifyListeners({ type: "state-snapshot" });
			const cbs = this.readyCallbacks.splice(0);
			cbs.forEach((cb) => cb(this.attached));
			return;
		}
		if (msg.type === "agent-event" && msg.event) { this.applyEvent(msg.event); return; }
		if (msg.type === "steering") {
			// pending chip delta — queued / consumed at a turn boundary / cancelled
			this.pendingPrompt = msg.pending ?? null;
			this.notifyListeners({ type: "steering", pending: this.pendingPrompt });
			return;
		}
		// generic correlated reply: accepted / forked / rewritten (any frame with an
		// id we're waiting on settles its request)
		if (msg.id && this.pendingReplies.has(msg.id)) {
			const resolve = this.pendingReplies.get(msg.id)!;
			this.pendingReplies.delete(msg.id);
			resolve(msg);
			return;
		}
		if (msg.type === "error") {
			// CORRELATED error: the hub echoes the request id on prompt/steer failures
			// (hub rejection, run error before reply) — settle the pending reply so
				// the composer restores the cleared draft (commit-review: the old path
			// recorded the error but left the promise pending forever)
			if (msg.id && this.pendingReplies.has(msg.id)) {
				const resolve = this.pendingReplies.get(msg.id)!;
				this.pendingReplies.delete(msg.id);
				resolve({ accepted: false, reason: msg.error });
				return;
			}
			this.state.errorMessage = msg.error;
			console.warn("[proxy-agent] server error:", msg.error);
		}
	}

	/** Mirrors pi-agent-core Agent.processEvents exactly. */
	private applyEvent(ev: AnyRecord) {
		switch (ev.type) {
			case "message_start": this.state.streamingMessage = ev.message; break;
			case "message_update": this.state.streamingMessage = ev.message; break;
			case "message_end":
				this.state.streamingMessage = undefined;
				this.state.messages.push(ev.message);
				break;
			case "tool_execution_start": {
				const p = new Set(this.state.pendingToolCalls); p.add(ev.toolCallId); this.state.pendingToolCalls = p; break;
			}
			case "tool_execution_end": {
				const p = new Set(this.state.pendingToolCalls); p.delete(ev.toolCallId); this.state.pendingToolCalls = p; break;
			}
			case "turn_end":
				if (ev.message?.role === "assistant" && ev.message?.errorMessage) this.state.errorMessage = ev.message.errorMessage;
				break;
			case "agent_start": this.state.isStreaming = true; this.state.errorMessage = undefined; break;
			case "agent_end": this.state.isStreaming = false; this.state.streamingMessage = undefined; break;
		}
		this.notifyListeners(ev);
	}

	private notifyListeners(event: AnyRecord) {
		for (const l of [...this.listeners]) {
			try { l(event); } catch (err) { console.error("[proxy-agent] listener:", err); }
		}
	}

	subscribe(cb: Listener): () => void {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}

	whenReady(timeoutMs = 8000): Promise<boolean> {
		if (this.attached && this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve(true);
		return new Promise((resolve) => {
			let timer: any = setTimeout(() => resolve(false), timeoutMs);
			const check = setInterval(() => {
				if (this.attached && this.ws && this.ws.readyState === WebSocket.OPEN) { if (timer) clearTimeout(timer); clearInterval(check); resolve(true); }
			}, 200);
		});
	}

	/** Correlate {type:"accepted"} replies to steer/prompt requests so the
	 *  composer can restore text when the hub REJECTS (depth-1 steer, grok P2 —
	 *  a fire-and-forget send would silently destroy the typed text). */
	private pendingReplies = new Map<string, (r: any) => void>();
	private replySeq = 0;

	private request(type: "prompt" | "steer", content: string, images?: any[]): Promise<any> {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			// DEFINITE reject — nothing was transmitted, so the caller can safely
			// restore the draft (commit-review: a steer started after the close
			// handler ran used to wait out its timeout and then count as "unknown",
				// silently dropping the text)
			return Promise.resolve({ accepted: false, reason: `${type} not sent — agent socket not connected` });
		}
		return this.sendAwait({ type, content, images: images?.length ? images : undefined }, type === "steer" ? 20000 : 0);
	}

	/** Generic correlated send: registers a reply slot keyed by id and waits for
	 *  the hub's reply frame ({type:"accepted"|"forked"|"rewritten"|"error"}).
		*  timeoutMs 0 = no timer (prompt replies arrive at run end). */
	private sendAwait(msg: AnyRecord, timeoutMs = 0): Promise<any> {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			return Promise.resolve({ ok: false, reason: "agent socket not connected" });
		}
		const id = `${Date.now().toString(36)}-${++this.replySeq}`;
		const p = new Promise<any>((resolve) => {
			this.pendingReplies.set(id, resolve);
			if (timeoutMs > 0) {
				const t = setTimeout(() => { if (this.pendingReplies.delete(id)) resolve({ ok: false, timedOut: true, reason: "reply timeout" }); }, timeoutMs);
				(t as any).unref?.();
			}
		});
		this.ws.send(JSON.stringify({ ...msg, id }));
		return p;
	}

	/** FORK: clone the transcript prefix (messages[0..keepCount)) into a NEW
	 *  session — resolves {ok, newSessionId, copied}. Original stays untouched. */
	async fork(keepCount: number): Promise<any> {
		const ready = await this.whenReady(8000);
		if (!ready) throw new Error("Agent WS not connected");
		return this.sendAwait({ type: "fork", keepCount }, 10000);
	}

	/** REWRITE: truncate the CURRENT session to messages[0..keepCount) — idle
	 *  only. Resolves {ok, kept}. Other devices resync via the hub's state frame. */
	async rewrite(keepCount: number): Promise<any> {
		const ready = await this.whenReady(8000);
		if (!ready) throw new Error("Agent WS not connected");
		return this.sendAwait({ type: "rewrite", keepCount }, 10000);
	}

	/** COMPACT (pi /compact parity): summarize older history, keep the recent
	 *  tail. LONG (an LLM call) — the reply lands when compaction finishes; the
	 *  hub rejects prompts/steers with "compaction in progress" meanwhile.
	 *  Timeout 10 min (user-observed 3-5 min on a ~500k-token session; a client
	 *  timeout does NOT stop the server — the state frame clears the banner). */
	async compact(keepRecentTokens = 20000): Promise<any> {
		const ready = await this.whenReady(8000);
		if (!ready) throw new Error("Agent WS not connected");
		return this.sendAwait({ type: "compact", keepRecentTokens }, 600000);
	}

	async prompt(input: any, images?: any[]): Promise<any> {
		const ready = await this.whenReady(8000);
		if (!ready) throw new Error("Agent WS not connected");
		const content = typeof input === "string" ? input : String(input?.content || "");
		return this.request("prompt", content, images);
	}

	/** Steering: the hub holds the message while a run is in progress (pending
	 *  chip) and injects it after the current thinking/toolcall completes. */
	pendingPrompt: any = null;

	/** Send a steering message (mid-run): resolves with the hub's accept/reject. */
	async steer(content: string, images?: any[]): Promise<any> {
		// brief-disconnect patience (prompt has the same gate) — but never send blind:
		// request() re-checks and definitely rejects if the socket is still down
		await this.whenReady(3000);
		return this.request("steer", content, images);
	}

	/** Pull a pending steering message back (edit) or drop it (cancel). */
	cancelSteering(): void {
		this.sendMsg({ type: "steering-cancel" });
	}

	abort(): void {
		this.sendMsg({ type: "abort" });
		this.state.isStreaming = false;
		this.state.streamingMessage = undefined;
		this.notifyListeners({ type: "agent_end", synthetic: true });
	}

	setModel(modelId: string): void { this.sendMsg({ type: "set-model", modelId }); }
	setThinkingLevel(level: string): void { this.sendMsg({ type: "set-thinking", level }); }

	waitForIdle(): Promise<void> {
		return this.state.isStreaming
			? new Promise((resolve) => {
					const unsub = this.subscribe((ev: any) => { if (ev.type === "agent_end") { unsub(); resolve(); } });
					setTimeout(() => { unsub(); resolve(); }, 300000);
				})
			: Promise.resolve();
	}
}
