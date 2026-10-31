// peer-lifecycle.test.mjs — the peer journal, the status function, budgets and the frozen result
// schema (plan-subagents.md D11/D12, C18/C20/C21).
//
// The point of these checks: STATUS must be answerable after a restart, and a delegation must be
// BOUNDED before an Agent is ever constructed. Both are pure here, so they are cheap to pin.
// Usage: node tests/peer-lifecycle.test.mjs
import {
	PEER_STATUSES, TERMINAL_STATUSES, RESULT_STATUSES, PEER_RESULT_FIELDS, PEER_LIMITS,
	peerStarted, peerEnded, appendJournal, findPeer, peerStatusOf, danglingSpawns, peerView,
	checkPeerBudget, checkPeerRunBudget, remainingBudget,
	truncateUtf8, buildPeerResult, resultText,
} from "../lib/peer-lifecycle.mjs";

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
	if (cond) { pass++; console.log(`  ✓ ${name}`); }
	else { fail++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};
const T0 = 1_700_000_000_000;

// ── journal entries ────────────────────────────────────────────────────────
{
	const started = peerStarted({ id: "p1", role: "reviewer", model: "faux/faux-1", task: "  review\n this   file ", parentSession: "S", at: T0 });
	check("J1 a started entry carries id/role/model/parent and a collapsed task preview",
		started.peerId === "p1" && started.role === "reviewer" && started.parentSession === "S" && started.taskPreview === "review this file", JSON.stringify(started));
	check("J2 …and starts as running with no end", started.status === "running" && started.endedAt === null);
	const ended = peerEnded(started, { status: "idle", at: T0 + 5000, usage: { input: 10, output: 20, cost: 0.01 }, turns: 3 });
	check("J3 an ended entry keeps the start fields and adds the terminal ones",
		ended.peerId === "p1" && ended.startedAt === T0 && ended.endedAt === T0 + 5000 && ended.turns === 3 && ended.usage.output === 20);
	check("J4 peerEnded refuses a non-terminal status (no half-states in the journal)",
		(() => { try { peerEnded(started, { status: "running" }); return false; } catch { return true; } })());
	check("J5 appendJournal is IMMUTABLE (the caller persists the new array)", (() => {
		const a = [started];
		const b = appendJournal(a, ended);
		return a.length === 1 && b.length === 2;
	})());
	check("J6 …and stays bounded (oldest dropped)",
		(() => {
			let j = [];
			for (let i = 0; i < PEER_LIMITS.journalKeep + 10; i++) j = appendJournal(j, peerStarted({ id: `p${i}`, role: "scout", at: T0 + i }));
			return j.length === PEER_LIMITS.journalKeep && j[0].peerId === "p10";
		})());
	check("J7 findPeer works on a journal and on junk", findPeer([started, ended], "p1")?.peerId === "p1" && findPeer(null, "x") === null);
}

// ── the status function (D11) ──────────────────────────────────────────────
{
	const started = peerStarted({ id: "p1", role: "reviewer", at: T0 });
	const done = peerEnded(started, { status: "idle", at: T0 + 1000 });
	check("S1 a live agent makes it running", peerStatusOf(started, { liveIds: ["p1"] }) === "running");
	check("S2 a finished entry reports its terminal status", peerStatusOf(done, { liveIds: [] }) === "idle");
	check("S3 an error/timeout/aborted entry is preserved", peerStatusOf(peerEnded(started, { status: "error", error: "boom" }), {}) === "error" &&
		peerStatusOf(peerEnded(started, { status: "timeout" }), {}) === "timeout" && peerStatusOf(peerEnded(started, { status: "aborted" }), {}) === "aborted");
	check("S4 started-but-not-live = needs_result (the process died mid-run — NOT a phantom 'running')",
		peerStatusOf(started, { liveIds: [] }) === "needs_result");
	check("S5 a live agent WINS over a stale journal status (the hub may upgrade, never invent)",
		peerStatusOf(done, { liveIds: new Set(["p1"]) }) === "running");
	check("S6 danglingSpawns finds exactly the unanswered ones", (() => {
		const j = [started, done, peerStarted({ id: "p2", role: "scout", at: T0 + 2 })];
		const d = danglingSpawns(j, { liveIds: ["p1"] });
		return d.length === 1 && d[0].peerId === "p2";
	})());
	check("S7 danglingSpawns is empty when everything is live or ended",
		danglingSpawns([started, done], { liveIds: ["p1"] }).length === 0);
	check("S8 peerView resolves status + elapsed for the UI", (() => {
		const v = peerView(started, { liveIds: [], now: T0 + 2500 });
		return v.id === "p1" && v.status === "needs_result" && v.elapsedMs === 2500 && v.role === "reviewer";
	})());
	check("S9 a finished peer keeps its final elapsed time (not 'now')", (() => {
		const v = peerView(done, { now: T0 + 999_999 });
		return v.elapsedMs === 1000;
	})());
	check("S10 the status vocabulary is closed", PEER_STATUSES.includes("needs_result") && TERMINAL_STATUSES.every((s) => PEER_STATUSES.includes(s)));
	check("S11 the RESULT vocabulary is separate from the lifecycle one (a finished peer is \"ok\", never a lifecycle state)",
		RESULT_STATUSES.includes("ok") && !PEER_STATUSES.includes("ok") && buildPeerResult({ status: "ok" }).status === "ok");
}

// ── budgets (D8/C20) ───────────────────────────────────────────────────────
{
	const okState = { depth: 0, livePerParent: 0, liveGlobal: 0, spawnsPerParent: 0 };
	check("B1 a normal spawn is allowed", checkPeerBudget(okState).ok === true);
	check("B2 depth 1 is refused (peers cannot spawn peers)", (() => {
		const r = checkPeerBudget({ ...okState, depth: 1 });
		return !r.ok && /depth/.test(r.reason);
	})());
	check("B3 the per-parent concurrency cap holds", (() => {
		const r = checkPeerBudget({ ...okState, livePerParent: PEER_LIMITS.maxConcurrentPerParent });
		return !r.ok && /running peers/.test(r.reason);
	})());
	check("B4 the global cap holds (one session cannot eat the machine)", (() => {
		const r = checkPeerBudget({ ...okState, liveGlobal: PEER_LIMITS.maxConcurrentGlobal });
		return !r.ok && /server already runs/.test(r.reason);
	})());
	check("B5 the cumulative spawn budget is a hard stop with an actionable reason", (() => {
		const r = checkPeerBudget({ ...okState, spawnsPerParent: PEER_LIMITS.maxSpawnsPerParent });
		return !r.ok && /spawn budget/.test(r.reason) && /ask the user/.test(r.reason);
	})());
	check("B6 a RUNNING peer is stopped by turn/token ceilings", (() => {
		return !checkPeerRunBudget({ turns: PEER_LIMITS.maxChildTurns + 1 }).ok && !checkPeerRunBudget({ tokens: PEER_LIMITS.maxChildTokens + 1 }).ok &&
			checkPeerRunBudget({ turns: 3, tokens: 100 }).ok;
	})());
	check("B7 remainingBudget is what the UI shows", (() => {
		const r = remainingBudget({ spawnsPerParent: 20, livePerParent: 1, liveGlobal: 2 });
		return r.spawns === 4 && r.concurrent === 2 && r.concurrentGlobal === 4;
	})());
	check("B8 junk state is treated as zero, never as unlimited", checkPeerBudget({}).ok === true && checkPeerBudget({ depth: "1" }).ok === false);
}

// ── the frozen result schema (D12/C21) ─────────────────────────────────────
{
	const r = buildPeerResult({ status: "ok", sessionId: "abc", role: "reviewer", model: "m", usage: { input: 5, output: 7, cost: 0.02 }, summary: "done" });
	check("R1 every schema field is present, exactly", JSON.stringify(Object.keys(r)) === JSON.stringify(PEER_RESULT_FIELDS), Object.keys(r).join(","));
	check("R2 usage is normalized to three numbers", r.usage.input === 5 && r.usage.output === 7 && r.usage.cost === 0.02);
	check("R3 a missing usage is zeros, not undefined", buildPeerResult({}).usage.input === 0 && buildPeerResult({}).error === null);
	check("R4 an unknown status collapses to error (the schema is closed)", buildPeerResult({ status: "banana" }).status === "error");
	check("R5 extra fields are dropped (the schema is the contract)", buildPeerResult({ status: "ok", secret: "leak" }).secret === undefined);
	check("R6 ok renders the summary + session id + token total", (() => {
		const t = resultText(buildPeerResult({ status: "ok", sessionId: "abc", role: "reviewer", usage: { input: 5, output: 7 }, summary: "THE REPORT" }));
		return t.includes("THE REPORT") && t.includes("session: abc") && t.includes("12 tokens") && t.includes("reviewer");
	})());
	check("R7 a FAILURE keeps its reason and is never truncated away", (() => {
		const t = resultText(buildPeerResult({ status: "error", error: "provider 429 after 3 retries", sessionId: "abc", role: "worker" }));
		return t.includes("error: provider 429 after 3 retries") && t.includes("session: abc");
	})());
	check("R8 an aborted peer says how to inspect it", resultText(buildPeerResult({ status: "aborted", error: "stopped by the user", sessionId: "s1" })).includes("open it to see what the peer did"));
}

// ── truncation: the 32KB cap on `summary` only, UTF-8 safe, keeping the TAIL ──
{
	const small = truncateUtf8("hello", 1024);
	check("C1 a short summary is untouched (no marker, no truncated flag)", small.text === "hello" && small.truncated === false);
	const big = "x".repeat(PEER_LIMITS.summaryBytes) + "THE END";
	const cut = truncateUtf8(big, PEER_LIMITS.summaryBytes);
	check("C2 an oversized summary IS cut and says so", cut.truncated === true && Buffer.byteLength(cut.text, "utf8") <= PEER_LIMITS.summaryBytes + 8);
	check("C3 …keeping the TAIL (the conclusion), not the opening", cut.text.trimEnd().endsWith("THE END"));
	check("C4 …with an explicit elision marker naming the byte count", /truncated: \d+ of \d+ bytes elided/.test(cut.text));
	check("C5 multibyte characters are never split mid-codepoint (no U+FFFD in the output)", (() => {
		const s = "日本語テキスト".repeat(4000); // 3 bytes per char
		const t = truncateUtf8(s, 1000);
		return !t.text.includes("\uFFFD") && Buffer.byteLength(t.text, "utf8") <= 1010;
	})());
	check("C6 the cap is measured in BYTES, not characters", (() => {
		const s = "あ".repeat(100); // 300 bytes, 100 chars
		return truncateUtf8(s, 300).truncated === false && truncateUtf8(s, 299).truncated === true;
	})());
	check("C7 resultText applies the cap to a huge ok-summary", (() => {
		const r = buildPeerResult({ status: "ok", sessionId: "s", role: "scout", summary: "y".repeat(PEER_LIMITS.summaryBytes * 2) });
		const t = resultText(r);
		return Buffer.byteLength(t, "utf8") < PEER_LIMITS.summaryBytes + 512 && /elided/.test(t);
	})());
	check("C8 truncateUtf8 handles junk input", truncateUtf8(null, 10).text === "" && truncateUtf8(undefined).truncated === false);
}

console.log(`\n[peer-lifecycle] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
