// proxy-agent.ts — client-side Agent adapter over a single WebSocket (/ws/agent).
//
// The agent loop runs SERVER-SIDE. One WS connection carries:
//   - agent events (message_start/update/end, thinking, agent_start/end)
//   - state snapshots (on attach and reconnect)
//   - commands (prompt, abort, set-model, set-thinking)
type Listener = (event: any) => void;
type AnyRecord = Record<string, any>;
import { makeId } from "./id.js";
import { getCachedChunks, putChunk, gunzip, transferPolicy, cachedRanges, intervalDiff, invalidateSession } from "./idb-cache.js";
// BACKFILL step in MESSAGES (filledFrom is a seq, not bytes): generous ask —
// the server clamps the response to 1MB serialized (~140 msgs on the 7.3MB
// session) and reports the actual window in X-Range-* headers.
const BACKFILL_MSGS = 400;

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
	/** Current session id for UI gating (compact-completion must not fire across
	 *  session switches — the state frame of the NEW session also flips
	 *  compacting:false, which used to print a bogus "compaction finished"). */
	get currentSessionId(): string {
		return this.sessionId;
	}
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
				this.sendMsg({ type: "attach", sessionId: this.sessionId, modelId: this.state.model?.id, thinkingLevel: this.state.thinkingLevel, tailFirst: true });
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
			// retry policy lives client-side (Settings → Retry): re-push on every attach
			// so a hub restart/reconnect picks it up
			this.pushAutoRetrySetting();
			// TAIL-FIRST STATE (2026-10-24): a sparse attach delivers the last ~512KB +
			// an envelope {fromSeq, messageCount}. CRITICAL (live crash 1f725ee): keep
			// state.messages DENSE — exactly the loaded window, no null holes. Nulls
			// leaked into chat.tsx iterators ([agent] listener TypeError m.role) — this
			// app assumes a dense message array in a dozen places. The window position
			// lives in state.sparse (filledFrom); editCommit indices get translated by
			// +fromSeq at the single call site (saveEdit). Backfill PREPENDS older wins.
			const sparse = (msg as any).sparse as { fromSeq: number; messageCount: number; rewriteSeq: number } | undefined;
			if (sparse && Array.isArray(msg.messages)) {
				this.state.messages = [...(msg.messages || [])]; // DENSE tail window
				(this.state as any).sparse = { ...sparse, filledFrom: sparse.fromSeq };
				void this.scheduleBackfill(sparse);
			} else {
				this.state.messages = [...(msg.messages || [])];
				(this.state as any).sparse = null;
			}
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

	/** VERSIONS: meta list of this session's saved deltas (no bodies). */
	async versions(): Promise<any> {
		const ready = await this.whenReady(8000);
		if (!ready) throw new Error("Agent WS not connected");
		return this.sendAwait({ type: "versions" }, 15000);
	}

	/** RESTORE a saved version (hub swaps the tail back; lossless both ways). */
	async restoreVersion(vid: number): Promise<any> {
		const ready = await this.whenReady(8000);
		if (!ready) throw new Error("Agent WS not connected");
		return this.sendAwait({ type: "restore-version", vid }, 30000);
	}

	/** INLINE EDIT commit (llama.cpp-webui parity): save a DIFFERENT text for
	 *  messages[index] — server parks the old tail as a version delta, truncates,
		*  and re-prompts through the normal path. No-op on identical text. */
	async editCommit(index: number, text: string): Promise<any> {
		const ready = await this.whenReady(8000);
		if (!ready) throw new Error("Agent WS not connected");
		return this.sendAwait({ type: "edit-commit", index, text }, 30000);
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
	/** RETRY a failed run (2026-10-23, user request). The HUB owns the semantics:
	 *  it drops the 429/error message and continues the same transcript at the
	 *  failure point — the user turn is NOT re-sent (the old client-side retry
	 *  called prompt() with the last user text, which appended a SECOND user
	 *  message) and completed tool calls are not re-run. Fire-and-forget: the reply
	 *  is an ack, the run streams as normal agent events. */
	async retry(): Promise<any> {
		await this.whenReady(3000);
		return this.sendAwait({ type: "retry" }, 15000);
	}

	/** Auto-retry preference (localStorage `pi.autoRetry`, default ON): pushes the
	 *  hub's retry policy — 3 attempts, 3 s apart — for rate-limit/network errors.
	 *  Re-sent on every (re)attach so a hub restart picks it up. */
	async setAutoRetry(cfg: { enabled: boolean; attempts?: number; delayMs?: number }): Promise<any> {
		await this.whenReady(3000);
		return this.sendAwait({ type: "set-auto-retry", ...cfg }, 8000);
	}

	/** Push the stored auto-retry preference to the hub (called after each attach). */
	private pushAutoRetrySetting(): void {
		let enabled = true, attempts = 3, delayMs = 3000;
		try {
			enabled = localStorage.getItem("pi.autoRetry") !== "0";
			attempts = Math.max(0, Math.min(10, Number(localStorage.getItem("pi.autoRetryAttempts")) || 3));
			delayMs = Math.max(1000, Math.min(60000, Number(localStorage.getItem("pi.autoRetryDelayMs")) || 3000));
		} catch { /* private mode */ }
		this.sendMsg({ type: "set-auto-retry", enabled, attempts, delayMs });
	}

	/** CANCEL the pending auto-retry of the attached session (auto-retry UI
	 *  2026-10-24): the hub clears the timer + runtime marker; the broadcast
	 *  runtime frame (retry gone) is the real ack for every device. */
	async cancelRetry(): Promise<any> {
		await this.whenReady(3000);
		return this.sendAwait({ type: "cancel-retry" }, 8000);
	}

	// --- TAIL-FIRST BACKFILL (transfer plan 2026-10-24) -------------------------
	private backfillRunning = false;

	private async netClass(): Promise<string> {
		try { const r = await fetch("/api/health", { signal: AbortSignal.timeout(3000) }); const j = await r.json(); return String(j.netClass || "remote"); } catch { return "remote"; }
	}

	/** Policy-gated background IDB warming (wired/wifi → cache the whole body;
	 *  metered → manual expand only). CRITICAL (user report: "loading all of chat
	 *  at once"): warming touches IDB ONLY — it must NEVER prepend into
	 *  state.messages. The render stays tail-only; the expand button grows it. */
	private async scheduleBackfill(sparse: { fromSeq: number; messageCount: number; rewriteSeq: number }): Promise<void> {
		if (this.backfillRunning) return;
		this.backfillRunning = true;
		try {
			const net = await this.netClass();
			const policy = await transferPolicy(net);
			if (policy !== "fast") return; // metered: expand stays manual (button)
			// warm [0, filledFrom) into IDB — the render array is untouched
			let guard = 40; // hard cap: 40 × 1MB
			while (guard-- > 0) {
				const sp = (this.state as any).sparse;
				if (!sp) return; // session switched / full state frame arrived
				const filled = sp.filledFrom as number;
				const covered = await cachedRanges(this.sessionId);
				const holes = intervalDiff(0, filled, covered);
				if (holes.length === 0) return; // fully warm
				const h = holes[0]; // oldest hole first; server clamps to 1MB per response
				const res = await fetch(`/api/agent/session/${encodeURIComponent(this.sessionId)}/range?fromSeq=${h.fromSeq}&toSeq=${h.toSeq}`, { signal: AbortSignal.timeout(15000) });
				if (!res.ok && res.status !== 204) return;
				const buf = await res.arrayBuffer();
				const rs = Number(res.headers.get("x-range-from-seq") || h.fromSeq);
				const re = Number(res.headers.get("x-range-to-seq") || h.toSeq);
				const count = Number(res.headers.get("x-session-message-count") || 0);
				const rsq = Number(res.headers.get("x-session-mutate-epoch") || 0);
				if (re <= rs) return; // empty — nothing more to warm
				try { await putChunk(this.sessionId, rs, re, rsq, count, new Blob([buf], { type: "application/gzip" })); } catch { return; }
			}
		} catch { /* best-effort — the tail is already rendered */ }
		finally { this.backfillRunning = false; }
	}

	/** EXPAND (banner button): grow the RENDER by one server-clamped step above
	 *  the loaded window — IDB first (instant after warming), network for misses.
	 *  SINGLE-FLIGHT (grok review 01a16a54 #7): double-clicks must not prepend
	 *  the same window twice. */
	async expandEarlier(): Promise<boolean> {
		if (this.backfillRunning) return false;
		this.backfillRunning = true;
		try { return await this.expandInner(); } finally { this.backfillRunning = false; }
	}

	private async expandInner(): Promise<boolean> {
		const sparse = (this.state as any).sparse as { fromSeq: number; messageCount: number; rewriteSeq: number } | undefined;
		if (!sparse) return false;
		const filled = (this.state as any).sparse.filledFrom as number;
		const from = Math.max(0, filled - BACKFILL_MSGS);
		return this.fillWindow(from, filled);
	}

	/** Fill [from,to): IDB cache first, then /range for the miss-set. The server
	 *  may return a SMALLER window than asked (1MB serialized cap) — X-Range-From/
	 *  To-Seq are authoritative and filledFrom advances to the returned top.
	 *  EPOCH GUARD (grok review 01a16a54 #6): a response from an older rewrite
	 *  generation invalidates the cache (server-specified rewrittenFrom — chunks
	 *  below it survive) and refuses to splice stale messages. */
	private async fillWindow(from: number, to: number): Promise<boolean> {
		const requestedTo = to;
		const sessionIdAtStart = this.sessionId;
		try {
			let msgs: any[] = [];
			const cached = await getCachedChunks(this.sessionId, from, to);
			let fullyCached = false;
			if (cached.length > 0) {
				fullyCached = true;
				for (const c of cached) msgs.push(...c.messages);
			}
			if (!fullyCached) {
				const res = await fetch(`/api/agent/session/${encodeURIComponent(this.sessionId)}/range?fromSeq=${from}&toSeq=${to}`, { signal: AbortSignal.timeout(15000) });
				if (!res.ok && res.status !== 204) { console.warn("[backfill] range fetch failed:", res.status); return false; }
				const buf = await res.arrayBuffer();
				const rs = Number(res.headers.get("x-range-from-seq") || from);
				const re = Number(res.headers.get("x-range-to-seq") || to);
				const count = Number(res.headers.get("x-session-message-count") || 0);
				const rsq = Number(res.headers.get("x-session-mutate-epoch") || 0);
				const rwr = Number(res.headers.get("x-rewritten-from") || Number.MAX_SAFE_INTEGER);
				const sparse = (this.state as any).sparse as { rewriteSeq: number } | undefined;
				if (sparse && rsq !== sparse.rewriteSeq) {
					// STALE GENERATION (grok #6): the transcript was rewritten since our
					// attach — drop cached chunks (the server's rewrittenFrom says which
					// ranges survive) and refuse to splice stale messages
					console.warn("[backfill] stale epoch (saw", sparse.rewriteSeq, "server", rsq, ") — invalidating cache");
					try { await invalidateSession(this.sessionId); } catch { /* best-effort */ }
					return false;
				}
				// cache write-through: the SAME raw gzip bytes into IDB (decompress on read)
				try { await putChunk(this.sessionId, rs, re, rsq, count, new Blob([buf], { type: "application/gzip" }), rwr); } catch { /* cache is best-effort */ }
				const text = await gunzip(new Blob([buf], { type: "application/gzip" }));
				if (text == null) { console.warn("[backfill] gunzip failed"); return false; }
				msgs = text.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
				from = rs; // SERVER-AUTHORITATIVE window (may be smaller than requested)
				to = re;
			}
			// splice: PREPEND the older window to the dense array; filledFrom advances
			// to the top of the RETURNED window. Race check against the REQUESTED top
			// AND the session (a switch must not mix windows into the wrong session).
			const sp = (this.state as any).sparse;
			if (!sp || sp.filledFrom !== requestedTo || this.sessionId !== sessionIdAtStart) { console.warn("[backfill] raced a rewrite/switch — window dropped"); return false; }
			this.state.messages = [...msgs, ...this.state.messages];
			sp.filledFrom = from;
			sp.fromSeq = from; // LOCKSTEP (grok #2): the edit translation uses fromSeq —
			// a frozen value would point edits at the wrong turn after any expand
			this.notifyListeners({ type: "state-snapshot" });
			return true;
		} catch (err: any) { console.warn("[backfill] fillWindow failed:", err?.message || err); return false; }
	}

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
