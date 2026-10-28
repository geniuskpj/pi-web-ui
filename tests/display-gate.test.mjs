// display-gate.test.mjs — the "display by user turn" gate in SEQ space.
//
// Review 2026-10-25, finding #4 (MEDIUM UX): the gate was a raw array INDEX taken
// when a sparse envelope arrived. fillWindow() mutates that envelope IN PLACE and
// PREPENDS messages, so the index went stale — and on the C4 headline path (a
// fully-warm reopen, where the attach legitimately sends an EMPTY window) there
// was no index to take at all: the gate resolved to 0 and the whole ~1MB window
// rendered, defeating the user-requested one-turn view. These checks pin the seq
// contract, including the exact warm-reopen sequence.
//
//
// 2026-10-27 (user report "Load earlier turns appeared at the first msg" +
// "only one user turn is visible"): a NULL gate means NO gate. The old
// resolveGateSeq() re-anchored null to "the last user turn", so EVERY chat was
// gated — a one-turn session showed a ⤒ button that hid nothing but its system
// message. The gated view is also N turns now (`pi.turnWindow`, default 3), not 1.
//
// Usage: node tests/display-gate.test.mjs
import { gateIndex, gateSeqOfLastTurns, gateSeqOfLastUser, prevUserSeq, resolveGateSeq } from "../lib/display-gate.mjs";

let passed = 0, failed = 0;
const check = (name, ok, extra = "") => {
	if (ok) { passed++; console.log(`  ✓ ${name}${extra ? " — " + extra : ""}`); }
	else { failed++; console.error(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
};
const user = (t) => ({ role: "user", content: [{ type: "text", text: t }] });
const asst = (t) => ({ role: "assistant", content: [{ type: "text", text: t }] });
// a window of `n` messages starting at seq `from`, with a user message every 4
const windowOf = (from, n) => Array.from({ length: n }, (_, i) => ((from + i) % 4 === 0 ? user("u" + (from + i)) : asst("a" + (from + i))));
const idxOf = (messages, gateSeq, filledFrom) => gateIndex(gateSeq, filledFrom, messages.length);

// ── G) the pure pieces ───────────────────────────────────────────────────────
{
	const msgs = [user("x"), asst("y"), user("z"), asst("w")];
	check("G1 gateSeqOfLastUser returns the SEQ of the last user message", gateSeqOfLastUser(msgs, 100) === 102, String(gateSeqOfLastUser(msgs, 100)));
	check("G1 gateSeqOfLastUser falls back to the window start when there is none", gateSeqOfLastUser([asst("a")], 40) === 40);
	// windowOf puts a user message every 4 → users at 0,4,8,12; the 3rd-newest is 4
	check("G1b gateSeqOfLastTurns(3) returns the 3rd-newest user message", gateSeqOfLastTurns(windowOf(0, 16), 0, 3) === 4, String(gateSeqOfLastTurns(windowOf(0, 16), 0, 3)));
	check("G1b gateSeqOfLastTurns falls back to the OLDEST user message in the window", gateSeqOfLastTurns(windowOf(0, 8), 0, 5) === 0, String(gateSeqOfLastTurns(windowOf(0, 8), 0, 5)));
	check("G1b gateSeqOfLastTurns never returns a negative / past-the-end seq", gateSeqOfLastTurns([], 77, 3) === 77);
	check("G2 gateIndex maps a seq to an index in the loaded window", gateIndex(102, 100, 4) === 2, String(gateIndex(102, 100, 4)));
	check("G2 gateIndex clamps a gate above the window (never a negative index)", gateIndex(90, 100, 4) === 0);
	check("G2 gateIndex clamps past the end (never out of range)", gateIndex(500, 100, 4) === 4);
	check("G2 a null gate means 'no gate'", gateIndex(null, 100, 4) === null);
	check("G3 prevUserSeq walks DOWN to the previous turn", prevUserSeq(windowOf(0, 16), 15, 0) === 12, String(prevUserSeq(windowOf(0, 16), 15, 0)));
	check("G3 prevUserSeq returns null when the loaded window has none left", prevUserSeq([asst("a")], 0, 0) === null);
}

// ── R) the review scenario: a fully-warm reopen ──────────────────────────────
// The server sends an EMPTY window (sentFrom = count = the client's claim) plus
// fromSeq = the aligned window start; the client then fills [fromSeq, sentFrom)
// from IDB. The gate must end up on the last user turn of the FILLED window.
{
	const COUNT = 1056, FROMS = 896;
	// 1) attach: sparse with no messages; filledFrom = sentFrom = count (nothing loaded)
	let messages = [];
	let filledFrom = COUNT;
	const attachGate = gateSeqOfLastTurns(messages, filledFrom, 1);
	check("R1 the empty-window attach yields a gate seq, not a lost index", attachGate === COUNT, String(attachGate));

	// 2) the prefix fill lands (fillWindow prepends [896,1056) and moves filledFrom)
	messages = windowOf(FROMS, COUNT - FROMS);
	filledFrom = FROMS;
	const resolved = resolveGateSeq(attachGate, filledFrom, messages, 1);
	const gateIdx = idxOf(messages, resolved, filledFrom);
	check("R2 after the fill the gate is re-anchored to the last user turn", resolved === gateSeqOfLastUser(messages, filledFrom), `gate=${resolved}`);
	check("R2 the gate hides something (the whole window is NOT rendered)", gateIdx !== null && gateIdx > 0 && gateIdx < messages.length, `idx=${gateIdx}/${messages.length}`);
	check("R2 the gate points at a user message (a turn starts there)", messages[gateIdx]?.role === "user");
	// the OLD behaviour, for contrast: the stale index 0 rendered everything
	check("R2 old-style index 0 would have rendered the whole window", gateIndex(0, filledFrom, messages.length) === 0);

	// 3) a SECOND fill (expand) must not move the gate: same message, lower index
	const before = messages[gateIdx];
	messages = [...windowOf(FROMS - 512, 512), ...messages];
	filledFrom = FROMS - 512;
	const gateIdx2 = idxOf(messages, resolved, filledFrom);
	check("R3 prepending 512 more messages keeps the gate on the SAME message", messages[gateIdx2] === before, `idx=${gateIdx2}`);
	check("R3 the seq is unchanged by the prepend", resolveGateSeq(resolved, filledFrom, messages, 1) === resolved);

	// 4) a USER-set gate (⤒ expand revealed the previous turn) is preserved verbatim
	const userSet = prevUserSeq(messages, gateIdx2 - 1, filledFrom);
	check("R4 an explicit expand moves the gate to the previous turn", userSet !== null && userSet < resolved, `${resolved} → ${userSet}`);
	check("R4 a user-set gate inside the window is never re-anchored", resolveGateSeq(userSet, filledFrom, messages, 1) === userSet);

	// 5) the DEFAULT view is the last 3 turns (pi.turnWindow), re-anchored after the fill
	const turnsGate = gateSeqOfLastTurns([], COUNT, 3);
	check("R5 an empty-window attach with turns=3 yields the attach seq", turnsGate === COUNT, String(turnsGate));
	const resolved3 = resolveGateSeq(turnsGate, FROMS, windowOf(FROMS, COUNT - FROMS), 3);
	check("R5 the fill re-anchors to the 3rd-newest turn", resolved3 === gateSeqOfLastTurns(windowOf(FROMS, COUNT - FROMS), FROMS, 3), String(resolved3));
	check("R5 the 3-turn gate hides more than the 1-turn gate", resolved3 < resolved);
}

// ── N) a null gate is NOT a gate (small sessions render in full) ──────────────
{
	const msgs = [user("only question"), asst("only answer")];
	check("N1 a null gate stays null — no gate at all", resolveGateSeq(null, 0, msgs, 3) === null);
	check("N1 gateIndex agrees: nothing is hidden", gateIndex(resolveGateSeq(null, 0, msgs, 3), 0, msgs.length) === null);
	const sysOnly = [{ role: "system" }, user("hi"), asst("hello")];
	check("N2 the old null→last-turn fallback would have hidden the system message (the reported bug)", gateSeqOfLastUser(sysOnly, 0) === 1);
	check("N2 with no gate the ⤒ button has nothing to hide", (gateIndex(null, 0, sysOnly.length) ?? 0) === 0);
}

// ── L) live appends ──────────────────────────────────────────────────────────
{
	let messages = windowOf(0, 8);
	let filledFrom = 0;
	const gate = gateSeqOfLastTurns(messages, filledFrom, 1);
	const idx1 = idxOf(messages, gate, filledFrom);
	messages = [...messages, asst("streamed"), user("next question")];
	const idx2 = idxOf(messages, gate, filledFrom);
	check("L1 a live append leaves the gate on the same message", messages[idx1] === messages[idx2] && gate === gateSeqOfLastUser(windowOf(0, 8), 0));
	check("L1 the gate does not jump to the new turn (the view is stable while streaming)", gateIndex(gate, filledFrom, messages.length) === idx1);
}

console.log(`\n[display-gate] ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
