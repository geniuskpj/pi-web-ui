/**
 * session-search.mjs — whole-session text search, server-side, over the SAME message
 * array `/range` serves from (so a hit's `seq` is directly usable by the client).
 *
 * WHY (user request 2026-10-28): the browser only holds a tail-first WINDOW of a large
 * session (plus a display gate that hides most of it), so an in-page find would silently
 * miss most of the conversation. The chat find bar therefore searches HERE and lists hits
 * with 1–2 lines of context; clicking one highlights the row in place (when it is in the
 * live window) or opens a read-only peek of that turn.
 *
 * SCOPE (v1, deliberate): `user` + `assistant` TEXT parts only. Tool results and thinking
 * blocks are excluded — they are the bulk of a session's bytes, they drown the hit list,
 * and a jump into a 1MB tool dump is not a useful target. No regex, no case toggle,
 * case-insensitive substring only. Pure (no fs/HTTP) → tests/session-search.test.mjs.
 */

export const MAX_Q = 200;
export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 200;
export const MAX_HITS_PER_SEQ = 3;
export const SNIPPET_MAX = 160;

/** Flattened searchable text of a message: its text parts joined by \n. Images,
 *  tool calls, thinking blocks and tool results contribute nothing. */
export function messageText(m) {
	const c = m?.content;
	if (typeof c === "string") return c;
	if (!Array.isArray(c)) return "";
	const parts = [];
	for (const p of c) {
		if (p?.type === "text" && typeof p.text === "string" && p.text) parts.push(p.text);
	}
	return parts.join("\n");
}

/** Which role is searchable — everything else (system, toolResult, notifications,
 *  compaction markers with no text) is skipped. */
export function searchableRole(m) {
	return m?.role === "user" || m?.role === "assistant" ? m.role : null;
}

/** 1-based user-turn numbers per message index; 0 for messages before the first
 *  user message (a leading system message / an assistant-only head). */
export function turnNumbers(messages) {
	const out = new Array(messages?.length || 0).fill(0);
	let turn = 0;
	for (let i = 0; i < out.length; i++) {
		if (messages[i]?.role === "user") turn += 1;
		out[i] = turn;
	}
	return out;
}

/** Absolute seq of the message that STARTS the turn containing `seq` (the user
 *  message itself), or `seq` when the window has no user message at/below it. */
export function turnStartSeq(messages, seq) {
	for (let i = Math.min(seq, (messages?.length || 0) - 1); i >= 0; i--) {
		if (messages[i]?.role === "user") return i;
	}
	return Math.max(0, seq);
}

/** Absolute seq just past the END of the turn containing `seq` (the next user
 *  message, or the array end) — the peek window's exclusive high bound. */
export function turnEndSeq(messages, seq) {
	for (let i = seq + 1; i < (messages?.length || 0); i++) {
		if (messages[i]?.role === "user") return i;
	}
	return messages?.length || 0;
}

/** A 1–2 line context snippet around a match, whitespace-collapsed, with the match
 *  offsets IN the snippet (the only place the UI is allowed to draw <mark>). */
export function buildSnippet(flat, idx, len) {
	const text = String(flat || "");
	if (!text) return { snippet: "", matchStart: 0, matchLen: 0 };
	let start = Math.max(0, idx - 60);
	let end = Math.min(text.length, idx + len + 90);
	// prefer whole words at the edges so the snippet reads like a line of chat
	if (start > 0) {
		const sp = text.indexOf(" ", start);
		if (sp >= 0 && sp < idx) start = sp + 1;
	}
	if (end < text.length) {
		const sp = text.lastIndexOf(" ", end);
		if (sp > idx + len) end = sp;
	}
	let snippet = text.slice(start, end).trim();
	let matchStart = idx - start - (text.slice(start, end).length - text.slice(start, end).trimStart().length);
	if (matchStart < 0) matchStart = 0;
	if (snippet.length > SNIPPET_MAX) {
		snippet = snippet.slice(0, SNIPPET_MAX);
		if (matchStart > SNIPPET_MAX - len) snippet = snippet.slice(0, Math.max(0, matchStart - 8));
	}
	return { snippet, matchStart: Math.max(0, Math.min(matchStart, snippet.length)), matchLen: Math.min(len, snippet.length) };
}

/**
 * Search a message array.
 * @returns {{q, hits: Array, truncated: boolean, messageCount: number, scanned: number, hitsPerSeq: number}}
 *  hit = {seq, role, turn, turnStartSeq, turnEndSeq, summary, snippet, matchStart, matchLen}
 */
export function searchMessages(messages, query, { limit = DEFAULT_LIMIT, maxPerSeq = MAX_HITS_PER_SEQ } = {}) {
	const q = String(query ?? "").slice(0, MAX_Q);
	const needle = q.trim().toLowerCase();
	const msgs = messages || [];
	const cap = Math.max(1, Math.min(MAX_LIMIT, Number(limit) || DEFAULT_LIMIT));
	const perSeqCap = Math.max(1, Math.floor(Number(maxPerSeq) || MAX_HITS_PER_SEQ));
	const hits = [];
	let truncated = false;
	let scanned = 0;
	if (!needle) return { q, hits, truncated, messageCount: msgs.length, scanned, hitsPerSeq: perSeqCap };
	const turns = turnNumbers(msgs);
	for (let seq = 0; seq < msgs.length && !truncated; seq++) {
		const role = searchableRole(msgs[seq]);
		if (!role) continue;
		const raw = messageText(msgs[seq]);
		if (!raw) continue;
		scanned += 1;
		// collapse whitespace ONCE, then match: offsets into `flat` stay valid for the
		// snippet, and a second collapse would be a no-op anyway
		const flat = raw.replace(/\s+/g, " ");
		const low = flat.toLowerCase();
		let from = 0;
		for (let n = 0; n < perSeqCap; n++) {
			const idx = low.indexOf(needle, from);
			if (idx < 0) break;
			const { snippet, matchStart, matchLen } = buildSnippet(flat, idx, needle.length);
			hits.push({
				seq,
				role,
				turn: turns[seq],
				turnStartSeq: turnStartSeq(msgs, seq),
				turnEndSeq: turnEndSeq(msgs, seq),
				summary: !!msgs[seq]?.isCompactionSummary || undefined,
				snippet,
				matchStart,
				matchLen,
			});
			from = idx + needle.length;
			if (hits.length >= cap) { truncated = true; break; }
		}
	}
	return { q, hits, truncated, messageCount: msgs.length, scanned, hitsPerSeq: perSeqCap };
}
