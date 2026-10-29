// session-search.test.mjs — the server-side chat find (user request 2026-10-28).
//
// The chat find bar searches the WHOLE session on the server (the browser only holds a
// tail-first window + a display gate, so an in-page find would silently miss most of a
// large conversation) and lists hits as "role + turn + 1–2 lines of context". The snippet
// offsets are the contract the UI marks with <mark>, so they are pinned here.
//
// Usage: node tests/session-search.test.mjs
import { searchMessages, messageText, turnNumbers, turnStartSeq, turnEndSeq, MAX_HITS_PER_SEQ, MAX_LIMIT } from "../lib/session-search.mjs";

let passed = 0, failed = 0;
const check = (name, ok, extra = "") => {
	if (ok) { passed++; console.log(`  ✓ ${name}${extra ? " — " + extra : ""}`); }
	else { failed++; console.error(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
};
const U = (t) => ({ role: "user", content: [{ type: "text", text: t }] });
const A = (t) => ({ role: "assistant", content: [{ type: "text", text: t }] });
const SYS = (t) => ({ role: "system", content: [{ type: "text", text: t }] });
const TR = (t) => ({ role: "toolResult", toolCallId: "x", content: [{ type: "text", text: t }] });

// ── T) text extraction + turn bookkeeping ────────────────────────────────────
{
	check("T1 text parts are joined, thinking/toolCall parts are ignored", messageText({ role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "a" }, { type: "toolCall", name: "bash", arguments: {} }, { type: "text", text: "b" }] }) === "a\nb");
	check("T1 a plain-string content still works", messageText({ role: "user", content: "hello" }) === "hello");
	check("T1 an image-only message has no text", messageText({ role: "user", content: [{ type: "image", data: "x" }] }) === "");
	const msgs = [SYS("sys"), U("one"), A("a1"), TR("t1"), U("two"), A("a2"), U("three")];
	check("T2 turnNumbers counts user messages, 0 before the first", JSON.stringify(turnNumbers(msgs)) === JSON.stringify([0, 1, 1, 1, 2, 2, 3]), JSON.stringify(turnNumbers(msgs)));
	check("T2 turnStartSeq walks back to the turn's user message", turnStartSeq(msgs, 3) === 1 && turnStartSeq(msgs, 6) === 6);
	check("T2 turnEndSeq is the next user message (exclusive)", turnEndSeq(msgs, 1) === 4 && turnEndSeq(msgs, 4) === 6 && turnEndSeq(msgs, 6) === 7);
	// no user message at/below the hit → the hit itself (the /range fetch re-aligns down
	// to a user turn server-side, so the peek still opens on the enclosing turn)
	check("T2 a leading assistant-only head falls back to the hit itself", turnStartSeq([A("x"), A("y")], 1) === 1 && turnEndSeq([A("x"), A("y")], 1) === 2);
}

// ── S) finding, roles, caps ─────────────────────────────────────────────────
{
	const msgs = [SYS("FINDME in the system prompt"), U("please FINDME here"), A("nothing"), TR("FINDME in tool output"), A("and findme again"), U("findsomething else")];
	const r = searchMessages(msgs, "findme");
	check("S1 case-insensitive substring", r.hits.length === 2, JSON.stringify(r.hits.map((h) => h.seq)));
	check("S1 system text is NOT searched (v1 scope)", !r.hits.some((h) => h.seq === 0));
	check("S1 tool output is NOT searched (v1 scope)", !r.hits.some((h) => h.seq === 3));
	check("S1 hits carry role + turn", r.hits[0].role === "user" && r.hits[0].turn === 1 && r.hits[1].role === "assistant" && r.hits[1].turn === 1);
	check("S1 hits carry the turn bounds the peek needs", r.hits[1].turnStartSeq === 1 && r.hits[1].turnEndSeq === 5);
	const off = r.hits[0];
	check("S2 snippet offsets really point at the match", off.snippet.slice(off.matchStart, off.matchStart + off.matchLen).toLowerCase() === "findme", JSON.stringify(off.snippet.slice(0, 40)));
	const multi = searchMessages([U("x FINDME y FINDME z FINDME w FINDME")], "findme");
	check("S3 at most MAX_HITS_PER_SEQ hits per message (a paste cannot flood the list)", multi.hits.length === MAX_HITS_PER_SEQ, String(multi.hits.length));
	const big = [U("a".repeat(400) + " needle " + "b".repeat(400))];
	const one = searchMessages(big, "needle").hits[0];
	check("S3 a long message still yields a short snippet", one.snippet.length <= 160 && one.snippet.slice(one.matchStart, one.matchStart + 6) === "needle", `${one.snippet.length} chars`);
	const many = Array.from({ length: 30 }, (_, i) => U(`hit ${i}`));
	const capped = searchMessages(many, "hit", { limit: 5 });
	check("S4 limit caps the hits and reports truncation", capped.hits.length === 5 && capped.truncated === true);
	check("S4 limit is clamped to MAX_LIMIT", searchMessages(many, "hit", { limit: 99999 }).hits.length === Math.min(30, MAX_LIMIT));
	const none = searchMessages(msgs, "zzz-not-there");
	check("S5 no match → an empty, non-truncated result with the scan stats", none.hits.length === 0 && none.truncated === false && none.messageCount === msgs.length);
	const empty = searchMessages(msgs, "   ");
	check("S5 a blank query never matches anything", empty.hits.length === 0 && empty.scanned === 0);
	check("S6 the query is capped", searchMessages([U("x")], "q".repeat(500)).q.length === 200);
}

// ── W) whitespace, compaction, degradation ──────────────────────────────────
{
	const nl = searchMessages([A("first line\nsecond line with target\nthird")], "target").hits[0];
	check("W1 a match on line 2 is found and its snippet is one collapsed line", nl.snippet.includes("target") && !nl.snippet.includes("\n"), JSON.stringify(nl.snippet));
	const compact = searchMessages([{ role: "user", isCompactionSummary: true, content: [{ type: "text", text: "## Conversation summary\nthe needle lives here" }] }], "needle").hits[0];
	check("W2 a compacted-context hit is flagged (the UI badges it)", compact.summary === true && compact.role === "user");
	const weird = searchMessages([{ role: "user", content: null }, { role: "assistant" }, null, U("ok needle")], "needle");
	check("W3 malformed messages are skipped, not thrown", weird.hits.length === 1 && weird.hits[0].seq === 3, String(weird.hits[0]?.seq));
	check("W3 no messages at all is an empty result", searchMessages(undefined, "x").hits.length === 0);
	check("W4 unicode matches by code unit (no crash on emoji/CJK)", searchMessages([U("lamp 💡 and 日本語 needle")], "needle").hits.length === 1);
}

console.log(`\n[session-search] ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
