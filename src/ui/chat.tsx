// Chat UI (plan.md P1) — Preact replacement for pi-web-ui ChatPanel/AgentInterface.
//
// Render rules (plan §2.2, grok-reviewed):
//  - Final messages (agent.state.messages) render text as MARKDOWN; the in-flight
//    state.streamingMessage renders PLAIN TEXT (never marked per delta).
//    message_update is a full-content snapshot — we always render from state
//    (one source of truth), never append deltas, so late updates can't dupe.
//  - Thinking parts → separate collapsible <details>, plain text (never folded
//    into the markdown document — scrambles fences).
//  - ToolCall parts → never markdown; rows keyed by toolCallId (never index).
//    Matching toolResult renders inline via the toolCallId map.
//  - stopReason "aborted"|"error" → frozen + distinct chrome (Retry in P2 must
//    not double-run a cancelled tool).
//  - tool_execution_update partials stay in a UI-ONLY map (loop invariant §2.8
//    #2: partials never enter messages/convertToLlm).
//  - XSS: assistant text is untrusted → renderMarkdown() sanitizes (DOMPurify).
// Loop invariants honored: replace-not-clear rendering (no message_end clears),
// idle re-sync handled in main.tsx (agent_end → notify after waitForIdle).
import type { Agent } from "@earendil-works/pi-agent-core";
import type {
	AssistantMessage,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "@earendil-works/pi-ai";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { SystemNotificationMessage } from "../llm.js";
import { getAppStorage } from "../storage.js";
import { looksLikeAuthError, createApiKeyResolver } from "./proxy-stream.js";
import { copyText } from "../id.js";
import { FilePickerDialog, type PickedFile } from "./file-picker.js";
import { TerminalPanel, termBus } from "./terminal.js";
import { renderMarkdown } from "./markdown.js";
const ARG_PREVIEW_MAX = 160;
const OUTPUT_TAIL_MAX = 2000;
const PARTIAL_STORE_MAX = 4096; // cap UI-only partial strings (bash can stream MBs)
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
const HLJS_MAX_INPUT = 20000; // ReDoS guard: hljs grammars don't throw on pathological input

// stable message keys: retry/edit/injected messages (P2) shift indices, which
// would remount every later bubble and collapse all <details>. WeakMap ids are
// assigned on first sight and live as long as the message object.
const msgIds = new WeakMap<object, string>();
let msgSeq = 0;
function keyOf(m: object): string {
	let id = msgIds.get(m);
	if (!id) {
		id = `m${++msgSeq}`;
		msgIds.set(m, id);
	}
	return id;
}

// ----------------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------------
function textOf(content: string | Array<TextContent | any> | undefined | null): string {
	if (!content) return "";
	if (typeof content === "string") return content;
	return content
		.filter((c) => c?.type === "text")
		.map((c) => (c as TextContent).text || "")
		.join("\n");
}

function safeStringify(value: unknown, max: number): string {
	let s: string;
	try {
		s = JSON.stringify(value);
	} catch {
		s = String(value);
	}
	if (s === undefined) return "";
	if (max !== Infinity && s.length > max) s = s.slice(0, max) + "…";
	return s;
}

/** Parity with pi-web-ui formatUsage (dist/utils/format.js) + M tier. */
function formatTokenCount(count: number): string {
	if (count >= 1000000) {
		const m = count / 1000000;
		return `${m >= 10 ? Math.round(m) : Math.round(m * 10) / 10}M`;
	}
	if (count < 1000) return String(count);
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	return `${Math.round(count / 1000)}k`;
}

function formatUsage(u: AssistantMessage["usage"]): string {
	if (!u) return "";
	const parts: string[] = [];
	if (u.input) parts.push(`↑${formatTokenCount(u.input)}`);
	if (u.output) parts.push(`↓${formatTokenCount(u.output)}`);
	if (u.cacheRead) parts.push(`R${formatTokenCount(u.cacheRead)}`);
	if (u.cacheWrite) parts.push(`W${formatTokenCount(u.cacheWrite)}`);
	if (u.cost?.total) parts.push(`$${u.cost.total.toFixed(4)}`);
	return parts.join(" ");
}

// ----------------------------------------------------------------------------
// message components
// ----------------------------------------------------------------------------
function UserBubble({ message, onOpenFile }: { message: UserMessage; onOpenFile?: (path: string) => void }) {
	// attached workspace files render as clickable chips → open the explorer
	// at that file (user request). Images have no path in ImageContent — text
	// file chips only.
	const text = textOf(message.content);
	const files = [...text.matchAll(/^--- file: (.+?) ---$/gm)].map((m) => m[1]);
	return (
		<div class="pw-msg-row pw-user-row">
			<div class="pw-msg pw-user">
				<div class="pw-text-plain">{text}</div>
				{files.length > 0 && onOpenFile && (
					<div class="pw-user-files">
						{files.map((f) => (
							<button key={f} type="button" class="pw-user-file" title={`View ${f}`} onClick={() => onOpenFile(f)}>
								{f.split(/[\\/]/).pop()}
							</button>
						))}
					</div>
				)}
			</div>
		</div>
	);
}

function ThinkingBlock({ part, streaming }: { part: ThinkingContent; streaming: boolean }) {
	return (
		<details class="pw-think" open={streaming ? true : undefined}>
			<summary>{part.redacted ? "Thinking (redacted)" : "Thinking"}</summary>
			<div class="pw-text-plain pw-think-body">{part.thinking || "…"}</div>
		</details>
	);
}

function ToolRow({
	call,
	result,
	pending,
	partialText,
	parentStop,
}: {
	call: ToolCall;
	result?: ToolResultMessage;
	pending?: boolean;
	partialText?: string;
	parentStop?: string;
}) {
	const running = pending && !result;
	const isError = result?.isError === true;
	// grok P1 review: after abort/error with no toolResult the row must NOT say
	// "queued" — it inherits the parent message's stopReason chrome.
	const orphaned = !running && !result && (parentStop === "aborted" || parentStop === "error");
	const output = result ? textOf(result.content) : "";
	const shown = running ? partialText || "" : output;
	const tail = shown.length > OUTPUT_TAIL_MAX ? "…" + shown.slice(-OUTPUT_TAIL_MAX) : shown;
	const state = running ? "running" : result ? (isError ? "error" : "ok") : orphaned ? parentStop : "queued";
	return (
		<details class={"pw-tool" + (isError ? " pw-tool-error" : "") + (running ? " pw-tool-running" : "")}>
			<summary>
				<span class="pw-tool-name">{call.name}</span>
				<span class="pw-tool-args">{safeStringify(call.arguments, ARG_PREVIEW_MAX)}</span>
				<span class={"pw-tool-state pw-state-" + state}>
					{state === "running"
						? "running…"
						: state === "error"
							? "✗ error"
							: state === "ok"
							? "✓"
							: state === "aborted"
							? "⏹ aborted"
							: "queued"}
				</span>
			</summary>
			<div class="pw-tool-body">
				{call.name === "bash" && typeof (call.arguments as any)?.command === "string" && (
					<div class="pw-tool-termrow">
						<button
							type="button"
							class="pw-mini-btn"
							title="Run this command in the terminal dock (shares the shell's cwd/env)"
							onClick={() => termBus.run(String((call.arguments as any).command))}
						>
							↗ terminal
						</button>
					</div>
				)}
				{call.arguments && Object.keys(call.arguments).length > 0 && (
					<pre class="pw-tool-args-full">{safeStringify(call.arguments, Infinity)}</pre>
				)}
				{tail && <pre class="pw-tool-out">{tail}</pre>}
			</div>
		</details>
	);
}

function AssistantBubble({
	message,
	streaming,
	toolResults,
	pending,
	partials,
	isLast,
	onRetry,
}: {
	message: AssistantMessage;
	streaming: boolean;
	toolResults: Map<string, ToolResultMessage>;
	pending?: ReadonlySet<string>;
	partials?: Map<string, string>;
	isLast?: boolean;
	onRetry?: () => void;
}) {
	const failed = message.stopReason === "error" || message.stopReason === "aborted";
	return (
		<div class={"pw-msg pw-assistant" + (failed ? " pw-failed" : "")}>
			{message.content.map((part, i) => {
				if (part.type === "thinking") {
					return <ThinkingBlock key={i} part={part} streaming={streaming} />;
				}
				if (part.type === "toolCall") {
					return (
						<ToolRow
							key={part.id}
							call={part}
							result={toolResults.get(part.id)}
							pending={pending?.has(part.id)}
							partialText={partials?.get(part.id)}
							parentStop={streaming ? undefined : message.stopReason}
						/>
					);
				}
				// text
				return streaming ? (
					<div key={i} class="pw-text-plain">
						{part.text || "…"}
					</div>
				) : (
					<div key={i} class="pw-md" dangerouslySetInnerHTML={{ __html: renderMarkdownCached(part.text) }} />
				);
			})}
			{failed && (
				<div class="pw-error-chrome">
					<span>
						{message.stopReason === "aborted" ? "⏹ Aborted" : "⚠ Error"}
						{message.errorMessage ? ` — ${message.errorMessage}` : ""}
					</span>
					{/* plan §2.7: Retry = resend last user message as a NEW turn — never
					    replay tool calls; aborted ≠ error so Retry can't double-run a
					    cancelled tool (§2.8 #8) */}
					{!streaming && message.stopReason === "error" && isLast && onRetry && (
						<button
							class="pw-retry"
							onClick={onRetry}
						>
							Retry
						</button>
					)}
				</div>
			)}
			{!streaming && (message.usage || textOf(message.content)) && (
				<div class="pw-meta">
					<span class="pw-usage">{formatUsage(message.usage)}</span>
					<button
						class="pw-copy"
						title="Copy message text"
						onClick={() => void copyText(textOf(message.content))}
					>
						Copy
					</button>
				</div>
			)}
		</div>
	);
}

function NotificationLine({ message }: { message: SystemNotificationMessage }) {
	let time = "";
	try {
		time = new Date(message.timestamp).toLocaleTimeString();
	} catch {
		/* noop */
	}
	return (
		<div class={"pw-note" + (message.variant === "destructive" ? " pw-note-destructive" : "")}>
			{message.message}
			{time && <span class="pw-note-time">{time}</span>}
		</div>
	);
}

function MessageView(props: {
	message: any;
	streaming?: boolean;
	toolResults: Map<string, ToolResultMessage>;
	pending?: ReadonlySet<string>;
	partials?: Map<string, string>;
	isLast?: boolean;
	onRetry?: () => void;
	onOpenFile?: (path: string) => void;
}) {
	const { message } = props;
	if (message.role === "user") return <UserBubble message={message as UserMessage} onOpenFile={props.onOpenFile} />;
	if (message.role === "assistant")
		return (
			<AssistantBubble
				message={message as AssistantMessage}
				streaming={!!props.streaming}
				toolResults={props.toolResults}
				pending={props.pending}
				partials={props.partials}
				isLast={props.isLast}
				onRetry={props.onRetry}
			/>
		);
	if (message.role === "system-notification") return <NotificationLine message={message as SystemNotificationMessage} />;
	// toolResult messages render inline inside their assistant toolCall row
	return null;
}

// Markdown memo (grok P1 review): every setTick re-rendered ALL history through
// marked+hljs+DOMPurify. Texts are immutable once final → cache by exact string.
const mdCache = new Map<string, string>();
const MD_CACHE_MAX = 500;
function renderMarkdownCached(text: string): string {
	const hit = mdCache.get(text);
	if (hit !== undefined) return hit;
	const html = renderMarkdown(text);
	if (mdCache.size >= MD_CACHE_MAX) mdCache.clear(); // simple reset, avoids LRU bookkeeping
	mdCache.set(text, html);
	return html;
}

// ----------------------------------------------------------------------------
// Composer pills (arena pattern, sonnet-5-high design round): pills live INSIDE
// the composer row, next to Send. The effort control is a native <select>
// styled to BE the pill — real color, never transparent (transparent color
// makes the opened dropdown options invisible on Windows Chrome).
// ----------------------------------------------------------------------------
function ModelPill({ model, onPickModel }: { model?: any; onPickModel: () => void }) {
	return (
		<button
			type="button"
			class="pw-pill"
			title={model ? `${model.id} — change model` : "Change model"}
			aria-haspopup="dialog"
			onClick={onPickModel}
		>
			<span class="pw-pill-text">{model ? model.id : "model"}</span>
			<span class="pw-pill-caret" aria-hidden="true" />
		</button>
	);
}

function EffortPill({ agent }: { agent: Agent }) {
	const [, setTick] = useState(0);
	const level = String(agent.state.thinkingLevel || "high");
	const setLevel = (v: string) => {
		agent.state.thinkingLevel = v as any;
		try {
			localStorage.setItem("pi.lastThinkingLevel", v);
		} catch {
			/* quota */
		}
		// broadcast so the Settings dialog stays in sync (no agent event fires)
		window.dispatchEvent(new CustomEvent("pi-agent-state-changed"));
		setTick((t) => t + 1);
	};
	return (
		<label class="pw-pill pw-pill-select">
			<span class="pw-pill-label" aria-hidden="true">effort</span>
			<select
				class="pw-pill-select-el"
				value={level}
				aria-label="Reasoning effort"
				onChange={(e) => setLevel((e.target as HTMLSelectElement).value)}
			>
				{THINKING_LEVELS.map((l) => (
					<option key={l} value={l}>{l}</option>
				))}
			</select>
		</label>
	);
}

// ----------------------------------------------------------------------------
// Usage bar (under the chat area — user request): context-window % + totals
// ----------------------------------------------------------------------------
/** Context estimate for the stats bar. Provider usage shapes differ (openai-style
 *  `input` already includes cached tokens; anthropic-style splits them), so prefer
 *  `usage.totalTokens` when present, else the 4-way sum. Labeled "last-call"
 *  context — a next-call estimate isn't portable across providers (grok p5). */
function contextUsage(messages: any[], model: any): { pct: number; used: number; total: number; split: string } | null {
	const total = model?.contextWindow;
	if (!total) return null;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m?.role === "assistant" && m.usage) {
			const u = m.usage;
			const used = u.totalTokens > 0 ? u.totalTokens : (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0) + (u.output || 0);
			if (used <= 0) continue;
			const split = `in ${formatTokenCount(u.input || 0)} · cacheR ${formatTokenCount(u.cacheRead || 0)} · cacheW ${formatTokenCount(u.cacheWrite || 0)} · out ${formatTokenCount(u.output || 0)}`;
			return { pct: Math.min(100, (used / total) * 100), used, total, split };
		}
	}
	return null;
}

function UsageBar({ agent }: { agent: Agent }) {
	const state = agent.state;
	const info = contextUsage(state.messages, state.model);
	// session totals (parity with the old renderStats footer)
	let tIn = 0, tOut = 0, tCost = 0;
	for (const m of state.messages as AssistantMessage[]) {
		if (m?.role === "assistant" && m.usage) {
			tIn += m.usage.input || 0;
			tOut += m.usage.output || 0;
			tCost += m.usage.cost?.total || 0;
		}
	}
	const hasTotals = tIn || tOut;
	const level = info ? (info.pct >= 90 ? "danger" : info.pct >= 70 ? "warn" : "ok") : "ok";
	return (
		<div class="pw-stats" data-level={level}>
			<div class="pw-stats-inner">
				<span class="pw-ctx">
					{info && (
						<span
							class="pw-ctx-pct"
							title={`Last-call tokens: ${info.split}`}
							aria-live={info.pct >= 70 ? "polite" : undefined}
						>
							{info.pct < 10 ? info.pct.toFixed(1) : info.pct.toFixed(0)}%
						</span>
					)}
					{info && " · "}
					{info && `${formatTokenCount(info.used)} / ${formatTokenCount(info.total)} tok`}
				</span>
				<span class="pw-totals">
					{hasTotals ? `↑${formatTokenCount(tIn)} ↓${formatTokenCount(tOut)}${tCost >= 0.00005 ? ` · $${tCost.toFixed(4)}` : ""}` : ""}
				</span>
			</div>
		</div>
	);
}

// ----------------------------------------------------------------------------
// ChatView
// ----------------------------------------------------------------------------
export function ChatView({ agent }: { agent: Agent }) {
	const [, setTick] = useState(0);
	const scrollRef = useRef<HTMLDivElement>(null);
	const stick = useRef(true);
	const lastTop = useRef(0);
	// UI-ONLY streaming partials for running tools (never enters messages)
	const partials = useRef(new Map<string, string>());
	// attachment state lives here so composer chips AND sent-message file chips
	// can open the explorer at that file (user request)
	const [textFiles, setTextFiles] = useState<Array<{ path: string; content: string }>>([]);
	const [images, setImages] = useState<Array<{ name: string; data: string; mimeType: string; preview: string }>>([]);
	const [attachNote, setAttachNote] = useState("");
	const [picker, setPicker] = useState<{ open: boolean; initialFile: string | null }>({ open: false, initialFile: null });
	// terminal dock state (panel itself is src/ui/terminal.tsx; opened from the
	// header button or a bash tool row's "↗ terminal")
	const [termOpen, setTermOpen] = useState(false);
	const [termCmd, setTermCmd] = useState<string | null>(null);
	const attachNoteTimer = useRef<any>(null);
	const note = (msg: string) => {
		setAttachNote(msg);
		clearTimeout(attachNoteTimer.current);
		attachNoteTimer.current = setTimeout(() => setAttachNote(""), 3000);
	};
	const addPicked = (f: PickedFile) => {
		if (f.kind === "image") {
			setImages((prev) => {
				if (prev.length >= MAX_IMAGE_ATTACH) {
					note(`max ${MAX_IMAGE_ATTACH} images`);
					return prev;
				}
				return [...prev, { name: f.name, data: f.base64 || "", mimeType: f.mimeType || "image/png", preview: `data:${f.mimeType};base64,${f.base64}` }];
			});
		} else {
			setTextFiles((prev) => {
				if (prev.some((x) => x.path === f.path)) {
					note("already attached");
					return prev;
				}
				if (prev.length >= MAX_TEXT_ATTACH) {
					note(`max ${MAX_TEXT_ATTACH} text files`);
					return prev;
				}
				return [...prev, { path: f.path, content: f.content || "" }];
			});
		}
	};
	const openFileViewer = (path: string) => setPicker({ open: true, initialFile: path });

	useEffect(() => {
		// agent identity changed (session switch/load): reset all UI-only state
		partials.current.clear();
		stick.current = true;
		lastTop.current = 0;
		return agent.subscribe((ev: any) => {
			if (ev.type === "tool_execution_update") {
				// replace-not-concat: partialResult is a cumulative snapshot
				partials.current.set(ev.toolCallId, textOf(ev.partialResult?.content).slice(0, PARTIAL_STORE_MAX));
			} else if (ev.type === "tool_execution_end") {
				partials.current.delete(ev.toolCallId);
			} else if (ev.type === "agent_end") {
				partials.current.clear(); // kill/error paths can skip tool_execution_end
			}
			setTick((t) => t + 1);
		});
	}, [agent]);

	useEffect(() => {
		// header button / tool-row "↗ terminal" → toggle or open+run (decoupled
		// via a window event so main.tsx's header needs no ChatView handle)
		const onTerm = (e: Event) => {
			const cmd = (e as CustomEvent).detail;
			if (typeof cmd === "string" && cmd.trim()) {
				setTermCmd(cmd);
				setTermOpen(true);
			} else {
				setTermOpen((o) => !o);
			}
		};
		window.addEventListener("pi-term-open", onTerm);
		return () => window.removeEventListener("pi-term-open", onTerm);
	}, []);

	// auto-scroll: stick unless the user scrolled up (direction + distance)
	useLayoutEffect(() => {
		const el = scrollRef.current;
		if (el && stick.current) el.scrollTop = el.scrollHeight;
	});

	const onScroll = () => {
		const el = scrollRef.current;
		if (!el) return;
		const top = el.scrollTop;
		const distance = el.scrollHeight - top - el.clientHeight;
		if (distance < 10) stick.current = true;
		lastTop.current = top;
	};
	// grok P1 review: unstick on USER intent immediately — programmatic
	// scrollTop (layout effect) fires onScroll and would re-stick, rubber-banding
	// the user against the bottom during fast streams.
	const unstick = () => {
		stick.current = false;
	};
	const forceStick = () => {
		stick.current = true;
		const el = scrollRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	};

	// 401 flow (plan §2.1): bad/missing key → surface an inline prompt once the
	// run settles; the next turn picks the new key up via getApiKey.
	useEffect(() => {
		return agent.subscribe((ev: any) => {
			if (ev.type !== "agent_end") return;
			// isStreaming is still true DURING agent_end listeners (finishRun flips it
			// after they settle) — inspect state only after idle
			agent.waitForIdle().then(async () => {
				if (agent.state.isStreaming) return;
				const msgs = agent.state.messages as AssistantMessage[];
				for (let i = msgs.length - 1; i >= 0; i--) {
					const m = msgs[i] as AssistantMessage;
					if (m.role !== "assistant") continue;
					if (m.stopReason === "error" && looksLikeAuthError(m.errorMessage)) {
						const provider = agent.state.model?.provider;
						if (!provider) break;
						const entered = window.prompt(
							`LLM rejected the API key for "${provider}"\n\n${m.errorMessage || "Unauthorized"}\n\nEnter a new API key (stored locally in your browser):`,
						);
						if (entered?.trim()) {
							try {
								await getAppStorage().providerKeys.set(provider, entered.trim());
								console.info("[chat] replacement key stored for", provider);
							} catch (err) {
								console.warn("[chat] key store failed:", err);
							}
						}
					}
					break; // only inspect the LAST assistant message
				}
			});
		});
	}, [agent]);

	const retry = () => {
		if (agent.state.isStreaming) return;
		const msgs = agent.state.messages as any[];
		let userIdx = -1;
		for (let i = msgs.length - 1; i >= 0; i--) {
			if (msgs[i].role === "user") {
				userIdx = i;
				break;
			}
		}
		if (userIdx < 0) return;
		const text = textOf((msgs[userIdx] as UserMessage).content);
		if (!text) return;
		// grok P2 review: a dangling toolCall (stream/loop died before its
		// toolResult was written) would produce tool_use without tool_result —
		// invalid for Anthropic/OpenAI-style APIs. Strip unmatched toolCall parts
		// from the failed assistant message before appending the retry turn.
		for (let i = msgs.length - 1; i > userIdx; i--) {
			const m = msgs[i] as AssistantMessage;
			if (m.role !== "assistant") continue;
			const trIds = new Set(msgs.filter((x) => x.role === "toolResult").map((x) => (x as any).toolCallId));
			const filtered = m.content.filter((p) => p.type !== "toolCall" || trIds.has((p as ToolCall).id));
			if (filtered.length !== m.content.length) {
				const repaired = msgs.slice();
				repaired[i] = {
					...m,
					content: filtered.length > 0 ? filtered : [{ type: "text", text: "(tool call interrupted by error)" }],
				};
				agent.state.messages = repaired;
			}
			break; // only the last assistant message
		}
		void agent.prompt(text).catch((err) => console.error("[chat] retry failed:", err));
		forceStick();
	};

	const state = agent.state;
	const toolResults = new Map<string, ToolResultMessage>();
	for (const m of state.messages) {
		if (m.role === "toolResult") toolResults.set((m as ToolResultMessage).toolCallId, m as ToolResultMessage);
	}

	return (
		<div class="pw-chat">
			<div class="pw-scroll" ref={scrollRef} onScroll={onScroll} onWheel={unstick} onTouchStart={unstick}>
				<div class="pw-thread">
					{state.messages.map((m: any, i: number) => (
						<MessageView
							key={keyOf(m)}
							message={m}
							toolResults={toolResults}
							pending={state.pendingToolCalls}
							partials={partials.current}
							isLast={i === state.messages.length - 1 && !state.streamingMessage}
							onRetry={retry}
							onOpenFile={openFileViewer}
						/>
					))}
					{state.streamingMessage ? (
						<MessageView
							key="streaming"
							message={state.streamingMessage}
							streaming
							toolResults={toolResults}
							pending={state.pendingToolCalls}
							partials={partials.current}
						/>
					) : null}
					{state.isStreaming && !state.streamingMessage && <div class="pw-thinking-hint">thinking…</div>}
				</div>
			</div>
			<TerminalPanel
				open={termOpen}
				command={termCmd}
				onCommandDone={() => setTermCmd(null)}
				onClose={() => setTermOpen(false)}
			/>
			<Editor
				agent={agent}
				onSent={forceStick}
				onPickModel={() => window.dispatchEvent(new CustomEvent("pi-open-model-selector"))}
				textFiles={textFiles}
				images={images}
				attachNote={attachNote}
				onRemoveTextFile={(p) => setTextFiles((prev) => prev.filter((x) => x.path !== p))}
				onRemoveImage={(idx) => setImages((prev) => prev.filter((_, j) => j !== idx))}
				onAddImage={(name, data, mimeType) => {
					setImages((prev) => {
						if (prev.length >= MAX_IMAGE_ATTACH) {
							note(`max ${MAX_IMAGE_ATTACH} images`);
							return prev;
						}
						return [...prev, { name, data, mimeType, preview: `data:${mimeType};base64,${data}` }];
					});
				}}
				onNote={note}
				onOpenPicker={() => setPicker({ open: true, initialFile: null })}
				onOpenFile={openFileViewer}
				onClearAttachments={() => {
					setTextFiles([]);
					setImages([]);
				}}
				onRestoreAttachments={(files, imgs) => {
					setTextFiles(files);
					setImages(imgs);
				}}
			/>
			<UsageBar agent={agent} />
			<FilePickerDialog
				open={picker.open}
				initialFile={picker.initialFile}
				onPick={addPicked}
				onClose={() => setPicker((p) => ({ ...p, open: false }))}
			/>
		</div>
	);
}

// ----------------------------------------------------------------------------
// Editor (plan P2): auto-grow textarea, Enter=send / Shift+Enter=newline,
// IME-safe, Send↔Stop with TEXT LABELS (§2.7), draft persistence
// ----------------------------------------------------------------------------
const DRAFT_KEY = "pi.web.draft";
const MAX_TEXT_ATTACH = 6;
const MAX_IMAGE_ATTACH = 4;

export function Editor({
	agent,
	onSent,
	onPickModel,
	textFiles,
	images,
	attachNote,
	onRemoveTextFile,
	onRemoveImage,
	onAddImage,
	onNote,
	onOpenPicker,
	onOpenFile,
	onClearAttachments,
	onRestoreAttachments,
}: {
	agent: Agent;
	onSent?: () => void;
	onPickModel?: () => void;
	textFiles: Array<{ path: string; content: string }>;
	images: Array<{ name: string; data: string; mimeType: string; preview: string }>;
	attachNote: string;
	onRemoveTextFile: (path: string) => void;
	onRemoveImage: (idx: number) => void;
	onAddImage: (name: string, data: string, mimeType: string) => void;
	onNote: (msg: string) => void;
	onOpenPicker: () => void;
	onOpenFile: (path: string) => void;
	onClearAttachments: () => void;
	onRestoreAttachments: (files: Array<{ path: string; content: string }>, imgs: Array<{ name: string; data: string; mimeType: string; preview: string }>) => void;
}) {
	const [value, setValue] = useState(() => {
		try {
			return localStorage.getItem(DRAFT_KEY) || "";
		} catch {
			return "";
		}
	});
	const [streaming, setStreaming] = useState(agent.state.isStreaming);
	const taRef = useRef<HTMLTextAreaElement>(null);
	const composing = useRef(false);
	const sending = useRef(false);
	// same resolver main.tsx gives the Agent: ls fast tier → backend → server race
	const resolver = useRef<((p: string) => Promise<string | undefined>) | null>(null);
	const getResolver = () => (resolver.current ??= createApiKeyResolver(getAppStorage().providerKeys));
	// attachment state (textFiles/images/attachNote) lives in ChatView so sent-message
	// file chips can re-open the explorer at that file (user request)

	useEffect(() => {
		return agent.subscribe((ev: any) => {
			// pi-agent-core flips isStreaming=false in finishRun() AFTER agent_end
			// listeners settle — re-sync on idle or the button sticks on "Stop"
			// (README bugs.md: "STOP button stuck")
			if (ev.type === "agent_end") {
				agent.waitForIdle().then(() => setStreaming(agent.state.isStreaming));
			}
			setStreaming(agent.state.isStreaming);
		});
	}, [agent]);

	// draft persistence
	useEffect(() => {
		try {
			if (value) localStorage.setItem(DRAFT_KEY, value);
			else localStorage.removeItem(DRAFT_KEY);
		} catch {
			/* quota */
		}
	}, [value]);

	// auto-grow
	useLayoutEffect(() => {
		const ta = taRef.current;
		if (!ta) return;
		ta.style.height = "auto";
		ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
	}, [value]);

	// --- attachments (state in ChatView; this component renders + pastes) ---
	// clipboard paste: images → attach; text pastes normally. iOS can hand us
	// HEIC/AVIF which vision APIs reject — MIME allowlist + size cap (grok p7).
	const PASTE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
	const onPaste = (e: ClipboardEvent) => {
		const items = e.clipboardData?.items;
		if (!items) return;
		for (const item of items) {
			if (item.kind === "file" && item.type.startsWith("image/")) {
				const file = item.getAsFile();
				if (!file) continue;
				if (!PASTE_MIME.has(item.type)) {
					e.preventDefault();
					onNote(`pasted image type "${item.type}" not supported — use PNG/JPEG/WebP/GIF`);
					continue;
				}
				if (file.size > 8 * 1024 * 1024) {
					e.preventDefault();
					onNote("pasted image too large (>8MB)");
					continue;
				}
				e.preventDefault(); // image wins over any text representation
				const reader = new FileReader();
				reader.onload = () => {
					const dataUrl = String(reader.result || "");
					const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
					onAddImage(file.name || "pasted-image", base64, file.type || "image/png");
				};
				reader.readAsDataURL(file);
			}
		}
	};
	const ext = (p: string) => (p.match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase();
	const fenceLang = (p: string) => ({ ts: "ts", tsx: "tsx", js: "js", jsx: "jsx", py: "python", json: "json", md: "md", css: "css", html: "html", yml: "yaml", yaml: "yaml", sh: "bash", bat: "bat", sql: "sql", rs: "rust", go: "go", java: "java", c: "c", cpp: "cpp", cs: "csharp" } as Record<string, string>)[ext(p)] || "";

	const send = async () => {
		const text = value.trim();
		const hasAttachments = textFiles.length > 0 || images.length > 0;
		if ((!text && !hasAttachments) || agent.state.isStreaming || sending.current) return;
		sending.current = true;
		try {
			// pre-send key check (parity with the patched old UI: full resolver incl.
			// server race, not just the fast tier)
			const provider = agent.state.model?.provider;
			if (provider) {
				const key = await getResolver()(provider);
				if (!key) {
					const entered = window.prompt(`No API key for "${provider}".\nEnter it (stored locally in your browser):`);
					if (!entered?.trim()) return; // abort the send, keep the draft
					await getAppStorage().providerKeys.set(provider, entered.trim());
				}
			}
			setValue(""); // clear only once we know we can send
			// inline text attachments as fenced blocks (fence length > any inner
			// backtick run) + send images via the images param
			let fullText = text;
			for (const f of textFiles) {
				const longest = Math.max(3, ...(f.content.match(/`{3,}/g) || [""]).map((s) => s.length));
				const fence = "`".repeat(longest + 1);
				fullText += `\n\n--- file: ${f.path} ---\n\n${fence}${fenceLang(f.path)}\n${f.content}\n${fence}`;
			}
			const imgs = images.map((im) => ({ type: "image" as const, data: im.data, mimeType: im.mimeType }));
			// empty text + images → a single space: Anthropic rejects empty text blocks
			const outText = fullText || (imgs.length ? " " : "");
			const restoreRaw = value; // untrimmed pre-send value
			const restoreFiles = textFiles;
			const restoreImages = images;
			onClearAttachments();
			void (imgs.length ? agent.prompt(outText, imgs) : agent.prompt(outText))
				.catch((err) => {
					console.error("[chat] send failed:", err);
					setValue((cur) => (cur.trim() ? cur : restoreRaw)); // don't clobber live typing
					onRestoreAttachments(restoreFiles, restoreImages); // attachments too (grok p7)
				});
			// grok P2 review: hold the double-send guard until the run has ACTUALLY
			// started (isStreaming flips asynchronously) — a fast Enter/Enter would
			// otherwise slip a second prompt() through the pre-stream gap
			const t0 = Date.now();
			while (!agent.state.isStreaming && Date.now() - t0 < 1000) {
				await new Promise((r) => setTimeout(r, 25));
			}
			onSent?.();
		} finally {
			sending.current = false;
		}
	};

	const stop = () => {
		agent.abort();
	};

	const onKeyDown = (e: KeyboardEvent) => {
		if (e.key !== "Enter") return;
		// IME-safe: never send while composing
		if (composing.current || (e as any).isComposing || e.keyCode === 229) return;
		if (!e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
			e.preventDefault();
			if (!streaming) send();
		}
	};

	return (
		<div class="pw-editor">
			<div class="pw-composer" data-streaming={streaming ? "1" : undefined}>
				{(textFiles.length > 0 || images.length > 0 || attachNote) && (
					<div class="pw-attach-strip">
						{textFiles.map((f) => (
							<span key={f.path} class="pw-attach-chip" title={f.path}>
								<span class="pw-attach-name pw-attach-link" title={"View " + f.path} onClick={() => onOpenFile(f.path)}>{f.path.split(/[\\/]/).pop()}</span>
								<button
									type="button"
									class="pw-attach-x"
									title="Remove"
									onClick={() => onRemoveTextFile(f.path)}
								>
									✕
								</button>
							</span>
						))}
						{images.map((im, i) => (
							<span key={i} class="pw-attach-chip pw-attach-img" title={`${im.name}${agent.state.model?.input && !agent.state.model.input.includes("image") ? " — current model may not support images" : ""}`}>
								<img src={im.preview} alt={im.name} />
								<button
									type="button"
									class="pw-attach-x"
									title="Remove"
									onClick={() => onRemoveImage(i)}
								>
									✕
								</button>
							</span>
						))}
						{attachNote && <span class="pw-attach-note">{attachNote}</span>}
					</div>
				)}
				<textarea
					ref={taRef}
					class="pw-input"
					placeholder={streaming ? "Generating… (Stop to interrupt)" : "Message pi…"}
					rows={1}
					value={value}
					onInput={(e) => setValue((e.target as HTMLTextAreaElement).value)}
					onKeyDown={onKeyDown}
					onPaste={onPaste}
					onCompositionStart={() => (composing.current = true)}
					onCompositionEnd={() => (composing.current = false)}
				/>
				<div class="pw-composer-row">
					<button
						type="button"
						class="pw-pill pw-attach-btn"
						title="Attach workspace files (or paste an image)"
						onClick={onOpenPicker}
					>
						+ files
					</button>
					<ModelPill model={agent.state.model} onPickModel={() => onPickModel?.()} />
					<EffortPill agent={agent} />
					<div class="pw-spacer" />
					<button type="button" class="pw-send" onClick={() => void (streaming ? stop() : send())} disabled={!streaming && !value.trim() && !textFiles.length && !images.length}>
						{streaming ? "Stop" : "Send"}
					</button>
				</div>
			</div>
		</div>
	);
}
