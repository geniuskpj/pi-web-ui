// zombie.test.mjs — killing-architecture unit tests (2026-10-23 LFP incident).
// A run can die WITHOUT agent_end (tool promise wedged + abort: pi's flag flips
// but no terminal event) leaving entry.runtime stuck "running" forever — the
// alive list showed 23 ghost sessions and Kill could not clear them.
//
// Coverage (hub-only, no LLM):
//   1. getRuntime SELF-HEAL: runtime "running" + pi not streaming → settles to
//      the truthful terminal state (idle, or "error" when the last assistant
//      errored — error rows must survive, they are real terminal states)
//   2. abort() FORCE-SETTLE: after the 1.5s grace a wedged runtime flips to
//      idle + the steering frame clears pending state
//   3. agent_end settles through _settleRuntime (state flag forced false)
import { AgentHub } from "../agent-hub.mjs";

let pass = 0;
const check = (name, cond, detail = "") => {
	if (cond) { pass++; console.log(`  ✓ ${name}`); }
	else { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); process.exitCode = 1; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const broadcasts = [];
const runtimeFrames = [];
const hub = new AgentHub({
	modelsStore: { nvidia: { name: "nvidia", models: [{ id: "m1", api: "openai-completions", provider: "nvidia", reasoning: true }] } },
	persist: async () => {},
	broadcast: (sid, msg) => broadcasts.push({ sid, msg }),
	onRuntimeChange: (sid, rt) => runtimeFrames.push({ sid, rt }),
});
const S = "zombietest00000000000000000000001";
const asst = (text, stop) => ({ role: "assistant", content: [{ type: "text", text }], stopReason: stop, timestamp: 1 });
hub.getSession(S, { messages: [
	{ role: "user", content: [{ type: "text", text: "q" }], timestamp: 0 },
	asst("a", "aborted"),
] });
const entry = hub.sessions.get(S);

// --- 1) getRuntime self-heal (staleness floor, grok Q1) ----------------------
entry.agent.state.isStreaming = false; // pi says: not running
entry.lastEventAt = Date.now() - 60_000; // quiet for a minute — beyond the 15s floor
entry.runtime = { status: "running", startedAt: Date.now() - 60_000, turn: 3, currentTool: "arena_continue", lastText: "x", pendingPrompts: 0 };
const rt1 = hub.getRuntime(S);
check("self-heal flips a QUIESCENT zombie runtime to idle", rt1.status === "idle", rt1.status);
check("settled runtime keeps seq stamping", typeof rt1.seq === "number");

// the multi-turn race: flag momentarily down but events still flowing (lastEventAt
// fresh) — a list read in that gap must NOT force-idle a LIVE run (grok Q1)
entry.agent.state.isStreaming = false;
entry.lastEventAt = Date.now();
entry.runtime = { status: "running", startedAt: Date.now(), turn: 5, currentTool: null, lastText: null, pendingPrompts: 0 };
const rt1b = hub.getRuntime(S);
check("fresh-activity run survives the self-heal (staleness floor)", rt1b.status === "running", rt1b.status);

// an ERROR runtime is a truthful terminal state — NOT a zombie
entry.agent.state.isStreaming = false;
entry.runtime = { status: "error", startedAt: Date.now(), turn: 1, currentTool: null, lastText: null, pendingPrompts: 0 };
const rt2 = hub.getRuntime(S);
check("error runtime survives (truthful terminal, not a zombie)", rt2.status === "error", rt2.status);

// --- 2) abort() kill chain: debounce, retry, HARD BACKSTOP (grok Q3/Q5) --------
entry.agent.abort = () => {}; // pi abort no-op (the wedged case: flag already false)
entry.agent.clearSteeringQueue = () => {};
entry.agent.state.isStreaming = false;
entry.pendingPrompt = { text: "held", images: [], queuedAt: 1 };
entry.runtime = { status: "running", startedAt: Date.now(), turn: 0, currentTool: "arena_continue", lastText: null, pendingPrompts: 1 };
hub.abort(S);
hub.abort(S); // Kill-spam — must be debounced
check("abort clears the pending steering payload immediately", entry.pendingPrompt === null);
await sleep(1900); // past the 1.5s settle
const rt3 = hub.getRuntime(S);
check("abort FORCE-SETTLES a wedged runtime after the grace", rt3.status === "idle", rt3.status);
check("a runtime frame was emitted (alive rows clear everywhere)", runtimeFrames.some((f) => f.sid === S));
const settleCount = runtimeFrames.filter((f) => f.sid === S).length;
check("kill-spam debounced (no duplicate settle storm)", settleCount <= 4, `frames=${settleCount}`);

// the isStreaming-STUCK-TRUE case (grok Q3): flag never drops, no agent_end —
// only the 6s hard backstop closes it
entry.agent.state.isStreaming = true;
entry.runtime = { status: "running", startedAt: Date.now(), turn: 2, currentTool: "bash", lastText: null, pendingPrompts: 0 };
hub.abort(S);
await sleep(7000); // past the 6s backstop
const rt4 = hub.getRuntime(S);
check("HARD BACKSTOP settles a flag-stuck zombie after 6s", rt4.status === "idle" && entry.agent.state.isStreaming === false, `status=${rt4.status} flag=${entry.agent.state.isStreaming}`);

// --- 3) agent_end path settles + forces pi's flag ------------------------------
entry.agent.state.isStreaming = true; // phantom: the flag itself stuck
entry.runtime = { status: "running", startedAt: Date.now(), turn: 9, currentTool: "bash", lastText: null, pendingPrompts: 0 };
// simulate the subscriber handling of an agent_end event:
const ev = hub.onEvents ? null : null;
// call the internal handler through the public surface: _settleRuntime is what agent_end calls
hub._settleRuntime(S, entry);
check("agent_end settle forces pi's streaming flag false", entry.agent.state.isStreaming === false);
check("agent_end settle flips runtime to idle", hub.getRuntime(S).status === "idle");

console.log(`[zombie] ${pass} check(s) passed`);
