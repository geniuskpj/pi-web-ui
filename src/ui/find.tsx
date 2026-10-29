// Chat find (user request 2026-10-28): a find bar for the CONVERSATION.
//
// WHY SERVER-SIDE: the browser only holds a tail-first window of a large session (plus
// the display gate that hides most of it), so an in-page find would silently miss most of
// the conversation. The bar therefore queries `GET /api/agent/session/:id/search`
// (lib/session-search.mjs — whole session, user+assistant text) and lists every hit as
// "role + turn + 1–2 lines of context". Clicking a hit highlights the row in place when
// it is inside the live window, otherwise a read-only PEEK sheet shows that turn
// (the transcript itself is never re-gated or re-windowed — see docs/client.md).
//
// Rules pinned by review (grok, 2026-10-28):
//  - hits are keyed by SEQ, never an array index (a prefetch prepends the array)
//  - <mark> exists ONLY in this list — never inside the memoized/sanitized markdown
//  - the panel is honest about what it searched (source · message count · truncation)
import { useEffect, useRef } from "preact/hooks";

export type FindHit = {
	seq: number;
	role: "user" | "assistant";
	turn: number;
	turnStartSeq: number;
	turnEndSeq: number;
	summary?: boolean;
	snippet: string;
	matchStart: number;
	matchLen: number;
};

export type FindMeta = {
	source: "live" | "jsonl" | null;
	messageCount: number;
	scanned: number;
	truncated: boolean;
	dirty: boolean;
	searching: boolean;
	error: string | null;
};

/** The match, marked. The ONLY place the app draws <mark> (markdown stays untouched). */
export function MarkSnippet({ hit }: { hit: FindHit }) {
	const s = hit.snippet || "";
	const a = Math.max(0, Math.min(hit.matchStart, s.length));
	const b = Math.max(a, Math.min(a + (hit.matchLen || 0), s.length));
	return (
		<span class="pw-find-snip">
			{a > 0 ? s.slice(0, a) : ""}
			<mark>{s.slice(a, b)}</mark>
			{s.slice(b)}
		</span>
	);
}

const statusLine = (n: number, meta: FindMeta) => {
	const parts = [`${n}${meta.truncated ? "+" : ""} match${n === 1 && !meta.truncated ? "" : "es"}`];
	if (meta.source) parts.push(meta.source === "live" ? "live transcript" : "saved mirror");
	if (meta.messageCount) parts.push(`${meta.messageCount} messages · ${meta.scanned} searched`);
	return parts.join(" · ");
};

/** The find panel: input, prev/next, honest status line, hit list. */
export function ChatFindBar({
	query,
	onQuery,
	hits,
	index,
	meta,
	onStep,
	onJump,
	onClose,
}: {
	query: string;
	onQuery: (q: string) => void;
	hits: FindHit[];
	index: number;
	meta: FindMeta;
	onStep: (delta: number) => void;
	onJump: (i: number) => void;
	onClose: () => void;
}) {
	const inputRef = useRef<HTMLInputElement>(null);
	useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);
	const listRef = useRef<HTMLDivElement>(null);
	// keep the current hit visible in the LIST while stepping with Enter
	useEffect(() => {
		const el = listRef.current?.querySelector(".pw-find-hit.pw-find-current") as HTMLElement | null;
		if (el) el.scrollIntoView({ block: "nearest" });
	}, [index, hits.length]);
	return (
		<div class="pw-find" role="dialog" aria-label="Find in conversation" data-q={query} data-hits={hits.length} data-source={meta.source || ""}>
			<div class="pw-find-head">
				<span class="pw-find-ico" aria-hidden="true">🔍</span>
				<input
					ref={inputRef}
					class="pi-input pw-find-input"
					type="search"
					placeholder="Find in this conversation…"
					value={query}
					aria-label="Find in conversation"
					onInput={(e) => onQuery((e.target as HTMLInputElement).value)}
					onKeyDown={(e) => {
						if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
						if (e.key === "Enter") { e.preventDefault(); onStep(e.shiftKey ? -1 : 1); return; }
						// typing must never reach the composer shortcuts
						e.stopPropagation();
					}}
				/>
				<span class="pw-find-count">{hits.length ? `${index + 1} / ${hits.length}` : "0 / 0"}</span>
				<button type="button" class="pw-find-nav" title="Previous match (Shift+Enter)" disabled={!hits.length} onClick={() => onStep(-1)}>▲</button>
				<button type="button" class="pw-find-nav" title="Next match (Enter)" disabled={!hits.length} onClick={() => onStep(1)}>▼</button>
				<button type="button" class="pw-find-nav pw-find-close" title="Close (Esc)" onClick={onClose}>✕</button>
			</div>
			<div class="pw-find-status">
				{meta.searching ? "searching…" : statusLine(hits.length, meta)}
				{meta.error ? <span class="pw-find-err"> · {meta.error}</span> : null}
			</div>
			{meta.dirty ? (
				<div class="pw-find-dirty" role="status">This conversation changed (edited/retried/compacted) — the result list may be stale. Search again.</div>
			) : null}
			{query.trim() && !meta.searching && hits.length === 0 && !meta.error ? (
				<div class="pw-find-empty">No match in the {meta.source === "jsonl" ? "saved mirror" : "conversation"}.</div>
			) : null}
			<div class="pw-find-list" ref={listRef}>
				{hits.map((h, i) => (
					<button
						type="button"
						key={`${h.seq}:${h.matchStart}:${i}`}
						class={"pw-find-hit" + (i === index ? " pw-find-current" : "")}
						title="Show this message"
						onClick={() => onJump(i)}
					>
						<span class={"pw-find-badge pw-find-" + h.role}>{h.role === "user" ? "you" : "ai"}</span>
						{h.turn ? <span class="pw-find-turn">turn {h.turn}{h.summary ? " · compacted" : ""}</span> : null}
						<MarkSnippet hit={h} />
					</button>
				))}
			</div>
		</div>
	);
}

/** Read-only peek of a turn that is NOT in the live window (modal shell; the caller
 *  renders the message rows inside). */
export function PeekSheet({
	title,
	sub,
	index,
	count,
	onStep,
	onClose,
	children,
}: {
	title: string;
	sub: string;
	index: number;
	count: number;
	onStep: (delta: number) => void;
	onClose: () => void;
	children?: any;
}) {
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
			if (e.key === "Enter") { e.preventDefault(); onStep(e.shiftKey ? -1 : 1); }
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onStep, onClose]);
	return (
		<div class="pw-overlay pw-peek-overlay" onClick={onClose}>
			<div class="pw-dialog pw-peek" onClick={(e) => e.stopPropagation()}>
				<div class="pw-dialog-head">
					<span>{title}</span>
					<span class="pw-peek-count">{count ? `${index + 1} / ${count}` : ""}</span>
					<button type="button" class="pw-find-nav" title="Previous match (Shift+Enter)" onClick={() => onStep(-1)}>▲</button>
					<button type="button" class="pw-find-nav" title="Next match (Enter)" onClick={() => onStep(1)}>▼</button>
					<button class="pw-dialog-close" onClick={onClose} title="Close (Esc)">✕</button>
				</div>
				<div class="pw-peek-sub">{sub}</div>
				<div class="pw-peek-body">{children}</div>
			</div>
		</div>
	);
}
