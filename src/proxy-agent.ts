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
		if (msg.type === "accepted" && msg.id && this.pendingReplies.has(msg.id)) {
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
		const id = `${Date.now().toString(36)}-${++this.replySeq}`;
		const p = new Promise<any>((resolve) => {
			this.pendingReplies.set(id, resolve);
			// TIMING ASYMMETRY (2026-10-22 bug): a STEER reply is immediate (the
			// hub's _steer is synchronous) → 20s is a transport-loss safety net. A
			// PROMPT reply arrives at RUN END (hub.prompt awaits the whole run) — the
			// old shared 20s timeout resolved {accepted:false} mid-run and the
			// composer restore put the sent text BACK into the input ("my prompt
			// appears again in text input UI"). Prompt gets NO timer: its entry
			// settles on the explicit reply or on WS close (see onclose). Same for a
			// steer that the hub fell back to prompt() with (run ended mid-send).
			if (type === "steer") {
				const t = setTimeout(() => { if (this.pendingReplies.delete(id)) resolve({ accepted: false, timedOut: true, reason: "steer reply timeout — check the pending chip / transcript" }); }, 20000);
				(t as any).unref?.();
			}
		});
		this.sendMsg({ type, id, content, images: images?.length ? images : undefined });
		return p;
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
