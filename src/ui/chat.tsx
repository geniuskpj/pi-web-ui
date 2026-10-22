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
import { Fragment } from "preact";
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
function UserBubble({ message, onOpenFile, index, canMutate, onEditMessage, editing, onSaveEdit, onCancelEdit, dimmed }: { message: UserMessage; onOpenFile?: (path: string) => void; index?: number; canMutate?: boolean; onEditMessage?: (i: number) => void; editing?: boolean; onSaveEdit?: (i: number, text: string) => void; onCancelEdit?: () => void; dimmed?: boolean }) {
	// attached workspace files render as clickable chips → open the explorer
	// at that file (user request). Images have no path in ImageContent — text
	// file chips only.
	const text = textOf(message.content);
	const files = [...text.matchAll(/^--- file: (.+?) ---$/gm)].map((m) => m[1]);
	// INLINE EDIT (llama.cpp-webui parity, user design 2026-10-23): ✎ turns THIS
	// bubble into a textarea — nothing is sent, no version is made, until the
	// user saves a DIFFERENT text ("Resubmit"). Esc/cancel reverts. Enter =
	// newline (an EDITING context — ChatGPT parity); Ctrl/Cmd+Enter submits.
	const [draft, setDraft] = useState(text);
	const taRef = useRef<HTMLTextAreaElement | null>(null);
	const editBtnRef = useRef<HTMLButtonElement | null>(null);
	useEffect(() => {
		if (!editing) return;
		setDraft(text);
		// focus + cursor at END (arena review: cursor at end, not select-all)
		const ta = taRef.current;
		if (ta) {
			ta.focus();
			const n = ta.value.length;
			try { ta.setSelectionRange(n, n); } catch { /* noop */ }
			autoGrow(ta);
		}
	}, [editing]);
	const autoGrow = (el: HTMLTextAreaElement) => {
		el.style.height = "0";
		el.style.height = Math.min(el.scrollHeight, 320) + "px";
	};
	const cancel = () => {
		onCancelEdit?.();
		// arena review: focus must return to the ✎ trigger (focus-within reveals it)
		setTimeout(() => editBtnRef.current?.focus(), 0);
	};
	const actions = canMutate && typeof index === "number" && onEditMessage && !editing;
	return (
		<div class={"pw-msg-row pw-user-row" + (dimmed ? " pw-will-replace" : "")}>
			{editing ? (
				<div class="pw-msg pw-user pw-msg-editing">
					<textarea
						ref={taRef}
						class="pw-edit-ta"
						value={draft}
						aria-label="Edit message"
						onInput={(e: any) => { setDraft(e.currentTarget.value); autoGrow(e.currentTarget); }}
						onKeyDown={(e: any) => {
							if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); onSaveEdit?.(index!, draft); }
							else if (e.key === "Escape") { e.preventDefault(); cancel(); }
						}}
					/>
					<div class="pw-edit-actions">
						<button type="button" class="pw-edit-save" title="Resubmit (Ctrl+Enter) — the old turn (prompt + responses) is saved as a restorable version (🕘), then the edited message re-prompts" onClick={() => onSaveEdit?.(index!, draft)}>Resubmit</button>
						<button type="button" class="pw-edit-cancel" onClick={cancel}>cancel</button>
					</div>
				</div>
			) : (
				<>
				{actions && (
					<div class="pw-msg-actions">
						{onEditMessage && <button ref={editBtnRef} type="button" class="pw-msg-act" aria-label="Edit message" title="Edit message — the old turn becomes a restorable version when you save a different text" onClick={() => onEditMessage(index)}>✎</button>}
					</div>
				)}
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
				</>
			)}
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
    dimmed,
}: {
	message: AssistantMessage;
	streaming: boolean;
	toolResults: Map<string, ToolResultMessage>;
	pending?: ReadonlySet<string>;
	partials?: Map<string, string>;
	isLast?: boolean;
	onRetry?: () => void;
	dimmed?: boolean;
	}) {
	const failed = message.stopReason === "error" || message.stopReason === "aborted";
	return (
	 <div class={"pw-msg pw-assistant" + (failed ? " pw-failed" : "") + (dimmed ? " pw-will-replace" : "")}>
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
	index?: number;
	justUpdated?: boolean; // compaction completed this render — flash the summary block
	canMutate?: boolean;
	onEditMessage?: (i: number) => void;
	editing?: boolean;
	onSaveEdit?: (i: number, text: string) => void;
	onCancelEdit?: () => void;
	dimmed?: boolean;
	onRetry?: () => void;
	onOpenFile?: (path: string) => void;
}) {
	const { message } = props;
	if (message.role === "user") {
		if ((message as any).isCompactionSummary) {
			// compaction summary (pi CompactionEntry parity): rendered as a subdued
			// COLLAPSIBLE context block, NOT as a user bubble — it is synthetic
			// history covering the folded-away older turns (the recent turns below it
			// are the verbatim tail). Collapsed by default — the giant summary text
			// at the top of every reload was overwhelming (user report 2026-10-23).
			const text = textOf((message as UserMessage).content).replace(/^## Conversation summary \(auto-compacted\)\n\n?/, "");
			return (
				<div class="pw-msg-row">
					<details class={"pw-compact-note" + (props.justUpdated ? " pw-compact-fresh" : "")} open={props.justUpdated || undefined}>
						<summary class="pw-compact-head">⤓ compacted context — older messages summarized here · recent turns kept below (click to view)</summary>
						<div class="pw-compact-body">{text}</div>
					</details>
				</div>
			);
		}
		return <UserBubble message={message as UserMessage} onOpenFile={props.onOpenFile} index={props.index} canMutate={props.canMutate} onEditMessage={props.onEditMessage} editing={props.editing} onSaveEdit={props.onSaveEdit} onCancelEdit={props.onCancelEdit} dimmed={props.dimmed} />;
	}
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
	   dimmed={props.dimmed}
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
		(agent as any).setThinkingLevel?.(v as any); // server-side agent: propagate to the hub
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

function UsageBar({ agent, canCompact, compacting, onCompact }: { agent: Agent; canCompact?: boolean; compacting?: boolean; onCompact?: () => void }) {
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
					{hasTotals ? `↑${formatTokenCount(tIn)} ↓${formatTokenCount(tOut)}${tCost >= 0.00005 ? ` · ${tCost.toFixed(4)}` : ""}` : ""}
				</span>
				{canCompact && onCompact && (
					<button type="button" class="pw-compact-btn" disabled={compacting} title="Compact — summarize older history, keep the recent tail (pi /compact parity)" onClick={onCompact}>
						{compacting ? "compacting…" : "⤓ compact"}
					</button>
				)}
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
	// steering: a message sent mid-run, held server-side until the current
	// thinking/toolcall completes. Rendered as a pending chip above the composer
	// with ✎ edit (pull back into the composer) and ✕ cancel.
	const [steerDraft, setSteerDraft] = useState<{ text: string; seq: number } | null>(null);
	const steerSeq = useRef(0);
	const pendingSteer = (agent as any).pendingPrompt as { text: string; images?: any[]; queuedAt?: number } | null;
	const editSteer = () => {
		if (!pendingSteer) return;
		// revert the pending message into the composer: text pre-fills, inline
		// images re-attach; the hub drops its copy (cancelSteering)
		steerSeq.current += 1;
		setSteerDraft({ text: pendingSteer.text || "", seq: steerSeq.current });
		const steerImages = pendingSteer.images;
		if (steerImages && steerImages.length) {
			setImages((prev) => [
				...prev,
				...steerImages
					.filter((im: any) => im?.type === "image" && im.data && im.mimeType)
					.map((im: any, k: number) => ({ name: `steered-${k + 1}`, data: im.data, mimeType: im.mimeType, preview: `data:${im.mimeType};base64,${im.data}` })),
			]);
		}
		(agent as any).cancelSteering?.();
	};
	const cancelSteer = () => {
		(agent as any).cancelSteering?.();
	};
	// compact (pi /compact parity): summarize older history, keep the recent tail
	const [compacting, setCompacting] = useState(false);
	const compact = async () => {
		if (compacting || (agent as any).serverSide !== true) return;
		setCompacting(true);
		setCompactDone(false);
		try {
			const r = await (agent as any).compact(20000);
			if (!r?.ok) throw new Error(r?.reason || r?.error || "compact failed");
			compactSettled.current = true;
			setCompactDone(true);
			note(`⤓ compacted — ${r.summarized} messages summarized, ${r.kept} kept · summary ~${Math.round((r.summaryChars || 0) / 4).toLocaleString()} tokens — the compacted-context block at the top was UPDATED${r.backupPath ? " · pre-compact backup saved" : ""}`);
			setTimeout(() => setCompactDone(false), 12000); // success banner auto-hides
		} catch (err: any) {
			note(err?.message || String(err));
		} finally {
			setCompacting(false);
		}
	};
	// edit-with-versions (user design 2026-10-23, llama.cpp-webui parity):
	// ✎ = INLINE edit of the bubble — PURELY LOCAL (no server call, no version,
	// no refresh). The version delta is captured only when a DIFFERENT text is
	// saved ("save & resend"), server-side via edit-commit.
	const [editingIdx, setEditingIdx] = useState<number | null>(null);
	const editSidRef = useRef<string | null>((agent as any).currentSessionId ?? null);
	useEffect(() => {
		const sid = (agent as any).currentSessionId ?? null;
		if (editSidRef.current !== sid) { editSidRef.current = sid; setEditingIdx(null); } // session switch cancels a pending inline edit
	});
	const saveEdit = async (i: number, text: string) => {
		const msgs = agent.state.messages as any[];
		const m = msgs[i];
		const orig = typeof m?.content === "string" ? m.content : (m?.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
		if (!m || m.role !== "user") { setEditingIdx(null); return; }
		if (text.trim() === String(orig).trim()) { setEditingIdx(null); return; } // unchanged → no version (user design)
		try {
			const r = await (agent as any).editCommit(i, text);
			if (!r?.ok) throw new Error(r?.reason || r?.error || "edit failed");
			note(r?.noop ? "edit cancelled — text unchanged" : `✎ saved — the old turn was parked as version #${r.version?.vid ?? "?"} (🕘 picker); the edited message is on its way`);
			setEditingIdx(null);
			window.dispatchEvent(new CustomEvent("pi-composer-focus")); // arena review: focus returns to the composer after save
		} catch (err: any) {
			note(err?.message || String(err));
		}
	};
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

	// session open → land at the BOTTOM (latest message), even for very long
	// transcripts. Heights keep changing as markdown/code blocks lay out, so
	// stick several times over the first second (user report: long sessions
	// "sometimes go to top" when clicked).
	useEffect(() => {
		const onOpen = () => {
			forceStick();
			requestAnimationFrame(() => forceStick());
			setTimeout(forceStick, 250);
			setTimeout(forceStick, 800);
		};
		window.addEventListener("pi-chat-scroll-bottom", onOpen);
		return () => window.removeEventListener("pi-chat-scroll-bottom", onOpen);
	}, []);

	// 401 flow (plan §2.1): bad/missing key → surface an inline prompt once the
	// run settles; the next turn picks the new key up via getApiKey.
	useEffect(() => {
		return agent.subscribe((ev: any) => {
			if (ev.type !== "agent_end") return;
			if ((agent as any).serverSide) return; // server path: keys live in .pi/auth.json — the error chrome already shows the failure
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
	// compact progress: server truth (state.compacting) drives the banner so ALL
	// devices see it and it survives a client-side await timeout (the server
	// keeps compacting and the next state frame clears the banner)
	const showCompact = compacting || !!(state as any).compacting;
	const [compactStarted, setCompactStarted] = useState(0);
	const [, setCompactTick] = useState(0);
	const [compactDone, setCompactDone] = useState(false);
	const [versionsOpen, setVersionsOpen] = useState(false);
	const [versionsList, setVersionsList] = useState<any[] | null>(null);
	const compactSid = useRef<string | null>(null);
	const compactSettled = useRef(false); // compact() reply path already handled it
	useEffect(() => {
		if (!showCompact) return;
		compactSettled.current = false;
		compactSid.current = (agent as any).currentSessionId ?? null; // session-gate the transition
		setCompactStarted((s) => s || Date.now());
		const t = setInterval(() => setCompactTick((x) => x + 1), 1000); // elapsed ticker
		return () => clearInterval(t);
	}, [showCompact]);
	// transition true→false: completion or session switch. The state frame of a
	// DIFFERENT session also flips compacting:false — gate on session id so
	// clicking another session no longer prints a bogus "compaction finished"
	// (user report 2026-10-23).
	const wasCompacting = useRef(false);
	useEffect(() => {
		if (showCompact) { wasCompacting.current = true; return; }
		if (!wasCompacting.current) return;
		wasCompacting.current = false;
		setCompactStarted(0); // next run starts the ticker from 0
		const same = (agent as any).currentSessionId === compactSid.current;
		compactSid.current = null;
		setCompactDone(false);
		if (!same || compactSettled.current) return;
		// reply path didn't settle (client await timed out / other device pressed)
		note("⤓ compaction ended — the compacted-context block at the top was refreshed");
	}, [showCompact]);
	const scrollToSummary = () => {
		const el = scrollRef.current?.querySelector(".pw-compact-note") as HTMLDetailsElement | null;
		if (el) {
			try { el.open = true; } catch { /* noop */ }
			el.scrollIntoView({ block: "start", behavior: "smooth" });
		}
	};
	const toolResults = new Map<string, ToolResultMessage>();
	for (const m of state.messages) {
		if (m.role === "toolResult") toolResults.set((m as ToolResultMessage).toolCallId, m as ToolResultMessage);
	}
	const summaryIdx = state.messages.findIndex((m: any) => m?.isCompactionSummary);

	return (
		<div class="pw-chat">
			<div class="pw-scroll" ref={scrollRef} onScroll={onScroll} onWheel={unstick} onTouchStart={unstick}>
				<div class="pw-thread">
					{state.messages.map((m: any, i: number) => (
					<Fragment key={keyOf(m)}>
					{editingIdx !== null && i === editingIdx + 1 && (
						<div class="pw-edit-divider">messages below will be replaced — the old turn is saved as a restorable version on Resubmit</div>
					)}
					<MessageView
						message={m}
						toolResults={toolResults}
						pending={state.pendingToolCalls}
						partials={partials.current}
						isLast={i === state.messages.length - 1 && !state.streamingMessage}
						index={i}
						justUpdated={compactDone && i === summaryIdx}
						dimmed={editingIdx !== null && i > editingIdx}
						canMutate={!state.isStreaming && (agent as any).serverSide === true}
						onEditMessage={(idx: number) => setEditingIdx(idx)}
						editing={editingIdx === i}
						onSaveEdit={saveEdit}
						onCancelEdit={() => setEditingIdx(null)}
						onRetry={retry}
						onOpenFile={openFileViewer}
					/>
					</Fragment>
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
					{pendingSteer && (
					<div class="pw-steer-chip" role="status">
					<span class="pw-steer-ico">⏩</span>
					<span class="pw-steer-body">
					 <span class="pw-steer-label">steering — sends after the current step</span>
					 <span class="pw-steer-text">{pendingSteer.text}</span>
					</span>
					<button type="button" class="pw-steer-btn" title="Edit — pull back into the composer" onClick={editSteer}>✎</button>
					<button type="button" class="pw-steer-btn pw-steer-cancel" title="Cancel steering message" onClick={cancelSteer}>✕</button>
					</div>
					)}
					<TerminalPanel
					open={termOpen}
					command={termCmd}
					onCommandDone={() => setTermCmd(null)}
					onClose={() => setTermOpen(false)}
					/>
					<Editor
					agent={agent}
					onSent={forceStick}
					steerDraft={steerDraft}
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
			<UsageBar agent={agent} canCompact={(agent as any).serverSide === true && !state.isStreaming && state.messages.length > 6} compacting={compacting} onCompact={compact} />
			{(agent as any).serverSide === true && (
				<div class="pw-versions-bar">
					<button type="button" class="pw-compact-btn" aria-label="Message versions" title="Versions — every inline edit saves the removed turn here; switching is lossless (the current tail is saved first)" onClick={async () => {
						const next = !versionsOpen;
						setVersionsOpen(next);
						if (next) {
							setVersionsList(null); // refetch every open — never stale across sessions
							try { const r = await (agent as any).versions(); setVersionsList(r?.versions || []); } catch (err: any) { note(err?.message || String(err)); }
						}
					}}>🕘 versions{versionsList && versionsList.length > 0 ? ` (${versionsList.length})` : ""}</button>
					{versionsOpen && (
						<div class="pw-versions-panel">
							{versionsList === null ? <div class="pw-versions-empty">loading…</div>
							: versionsList.length === 0 ? <div class="pw-versions-empty">no saved versions yet — ✎ edit a message to create one</div>
							: [...versionsList].reverse().map((v: any) => (
								<div class="pw-versions-row" key={v.vid}>
								 <span class="pw-versions-meta">#{v.vid} · turn {v.turn} · {v.count} msg{v.count === 1 ? "" : "s"} · {new Date(v.at).toLocaleTimeString()} · {v.reason}{v.preview ? <span class="pw-versions-preview"> — “{v.preview}”</span> : null}</span>
								 <button type="button" class="pw-versions-restore" title="Current conversation will be saved as a version before switching (lossless)" onClick={async () => {
								  try {
								   const r = await (agent as any).restoreVersion(v.vid);
								   if (!r?.ok) throw new Error(r?.reason || r?.error || "switch failed");
								   note(`🕘 switched to version #${v.vid} — the replaced tail was saved as a new version (nothing lost)`);
								   setVersionsOpen(false);
								  } catch (err: any) { note(err?.message || String(err)); }
								 }}>switch to</button>
								</div>
							))}
						</div>
					)}
				</div>
			)}
				{compactDone ? (
				<div class="pw-compact-progress pw-compact-done" role="status">
					<span aria-hidden="true">✓</span>
					<span>Context compacted — the compacted-context summary at the top was just updated.</span>
					<button type="button" class="pw-compact-view" onClick={scrollToSummary}>⤒ view summary</button>
				</div>
				) : showCompact ? (
				<div class="pw-compact-progress" role="status">
					<span class="pw-compact-spinner" aria-hidden="true">⤓</span>
					<span>Compacting context… summarizing older history into a checkpoint. The recent tail stays verbatim; this can take minutes on long sessions (the page may be left open).</span>
					<span class="pw-compact-elapsed">{compactStarted ? `${Math.floor((Date.now() - compactStarted) / 60000)}:${String(Math.floor(((Date.now() - compactStarted) / 1000) % 60)).padStart(2, "0")} elapsed` : "starting…"}</span>
				</div>
				) : null}
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
	steerDraft,
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
	steerDraft?: { text: string; seq: number } | null;
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
	// hub-side pending steering message (chip up ⇒ Steer hidden/Enter blocked —
	// depth 1; grok review P2: a second mid-run send would be REJECTED and a
	// fire-and-forget send would silently destroy the typed text)
	const [pendingSteer, setPendingSteer] = useState<any>((agent as any).pendingPrompt ?? null);
	const serverSide = !!(agent as any).serverSide; // local (?local=1) loop has no steering
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
			if (ev.type === "steering" || ev.type === "state-snapshot") {
				setPendingSteer((agent as any).pendingPrompt ?? null);
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

	// steering ✎: pull the pending message back into the composer (text pre-fills,
	// focus moves here so the user can modify or send immediately)
	useEffect(() => {
		if (!steerDraft || typeof steerDraft.text !== "string") return;
		setValue(steerDraft.text);
		const ta = taRef.current;
		if (ta) {
			ta.focus();
			try { ta.setSelectionRange(steerDraft.text.length, steerDraft.text.length); } catch { /* older engines */ }
		}
	}, [steerDraft?.seq]);

	// focus returns to the composer after an inline-edit save (arena review #9)
	useEffect(() => {
		const onFocus = () => taRef.current?.focus();
		window.addEventListener("pi-composer-focus", onFocus);
		return () => window.removeEventListener("pi-composer-focus", onFocus);
	}, []);

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
		// server-side agent: a send DURING a run becomes a steering message (held
		// until the current thinking/toolcall completes) — allowed. The local
		// in-browser loop throws on concurrent prompts, so it still blocks.
		if ((!text && !hasAttachments) || sending.current) return;
		if (agent.state.isStreaming && !serverSide) return;
		const steering = serverSide && (agent.state.isStreaming || !!pendingSteer);
		if (steering && pendingSteer) {
			onNote("steering message already pending — cancel or edit it first");
			return;
		}
		// WS payload cap: /ws/agent frames over 25MB kill the socket — cap total
		// image bytes (raw ≈ base64×0.75) at 12MB (grok r3: 4×8MB ≈ 42MB base64)
		const imageBytes = images.reduce((n, im) => n + Math.floor((im.data?.length || 0) * 0.75), 0);
		if (imageBytes > 12 * 1024 * 1024) {
			onNote("attachments too large (>12MB total) — remove an image");
			return;
		}
		sending.current = true;
		try {
			// pre-send key check (parity with the patched old UI: full resolver incl.
			// server race, not just the fast tier). Server-side agent: keys live in
			// .pi/auth.json on the server — skip (no browser key prompt).
			const provider = agent.state.model?.provider;
			if (provider && !(agent as any).serverSide) {
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
			// steering path awaits the hub's accept/reject: a rejected steer (depth 1
			// lost a race with another device, hub timeout) must NOT destroy the text
			const dispatch = steering && typeof (agent as any).steer === "function"
				? (agent as any).steer(outText, imgs.length ? imgs : undefined)
				: (imgs.length ? agent.prompt(outText, imgs) : agent.prompt(outText));
			void Promise.resolve(dispatch)
				.then((res: any) => {
					// restore ONLY on an explicit hub rejection. A timeout/lost socket is
					// an UNKNOWN state — the run/steer may be live server-side (runs
					// survive disconnects; prompt replies arrive at run end), and
					// restoring would re-send text that's already queued/running
					// (2026-10-22 bug: prompts reappeared in the composer after 20s).
					if (res && res.accepted === false && !res.timedOut && !res.lost) {
						console.warn("[chat] send rejected:", res.reason);
						onNote(res.reason || "not accepted");
						setValue((cur) => (cur.trim() ? cur : restoreRaw)); // don't clobber live typing
						onRestoreAttachments(restoreFiles, restoreImages);
					} else if (res && (res.timedOut || res.lost)) {
						console.warn("[chat] send reply unresolved:", res.reason);
					}
				})
				.catch((err: any) => {
					console.error("[chat] send failed:", err);
					setValue((cur) => (cur.trim() ? cur : restoreRaw)); // don't clobber live typing
					onRestoreAttachments(restoreFiles, restoreImages); // attachments too (grok p7)
				});
			// grok P2 review: hold the double-send guard until the run has ACTUALLY
			// started (isStreaming flips asynchronously) — a fast Enter/Enter would
			// otherwise slip a second prompt() through the pre-stream gap. A send that
			// went out WHILE streaming (steering) skips the wait — it's already running.
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
		// pi-TUI parity (interactive-mode restoreQueuedMessagesToEditor({abort:true}):
		// aborting with a pending steering message RECALLS its text (+ images) into
		// the composer instead of silently dropping it — the user can modify or
			// re-send. Depth 1 ⇒ there is at most one pending message to recall.
		if (pendingSteer) {
			const text = String(pendingSteer.text || "");
			(agent as any).cancelSteering?.();
			const steerImages = pendingSteer.images;
			if (steerImages && steerImages.length) {
				for (const im of steerImages) {
					if (im?.type === "image" && im.data && im.mimeType) onAddImage(`stopped-${Date.now().toString(36)}`, im.data, im.mimeType);
				}
			}
			if (text) {
				setValue((cur) => (cur.trim() ? cur.replace(/\s*$/, "") + "\n\n" + text : text)); // never clobber a live draft
				const ta = taRef.current;
				if (ta) { ta.focus(); try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch { /* older engines */ } }
			}
		}
		agent.abort();
	};

	const onKeyDown = (e: KeyboardEvent) => {
		if (e.key !== "Enter") return;
		// IME-safe: never send while composing
		if (composing.current || (e as any).isComposing || e.keyCode === 229) return;
		if (!e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
			e.preventDefault();
			// streaming + server-side ⇒ Enter STEERS (held until the step completes)
			if (!streaming || (agent as any).serverSide) send();
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
					{streaming && serverSide && !pendingSteer && (value.trim() || textFiles.length || images.length) ? (
						<button type="button" class="pw-send pw-steer-send" title="Steer — hold until the current step completes, then send" onClick={() => void send()}>
							⏩ Steer
						</button>
					) : null}
					<button type="button" class="pw-send" onClick={() => void (streaming ? stop() : send())} disabled={!streaming && !value.trim() && !textFiles.length && !images.length}>
						{streaming ? "Stop" : "Send"}
					</button>
				</div>
			</div>
		</div>
	);
}
