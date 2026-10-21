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
				this.sendMsg({ type: "attach", sessionId: this.sessionId });
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
			if (!msg.isStreaming) this.state.streamingMessage = undefined;
			this.notifyListeners({ type: "state-snapshot" });
			const cbs = this.readyCallbacks.splice(0);
			cbs.forEach((cb) => cb(this.attached));
			return;
		}
		if (msg.type === "agent-event" && msg.event) { this.applyEvent(msg.event); return; }
		if (msg.type === "error") {
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

	async prompt(input: any): Promise<void> {
		const ready = await this.whenReady(8000);
		if (!ready) throw new Error("Agent WS not connected");
		const content = typeof input === "string" ? input : String(input?.content || "");
		this.sendMsg({ type: "prompt", content });
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
