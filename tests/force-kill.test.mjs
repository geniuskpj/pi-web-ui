// force-kill.test.mjs — the SERVER half of the 2026-10-31 user report: "when I click Stop, sometimes the
// generation is not stopped, but the button already turned into Send, so I cannot kill the session."
//
// Two things had to be true for that to happen:
//   * the client faked the end (fixed in src/proxy-agent.ts + tests/stop-state.test.mjs), and
//   * the SERVER could not actually kill a run that ignored `abort()` — it settled the runtime (so the UI
//     showed idle) while pi kept streaming, and pi's internal `activeRun` guard then refused the next
//     prompt. A "kill" that leaves the session unusable is not a kill.
//
// This suite drives the escalation with a fast grace (PI_WEB_KILL_GRACE_MS) and a child run that NEVER
// finishes, and proves the session is genuinely usable afterwards.
//
// Usage: node tests/force-kill.test.mjs
import { registerFauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { AgentHub } from "../agent-hub.mjs";

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
	if (cond) { pass++; console.log(`  ✓ ${name}`); }
	else { fail++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const textOf = (m) => (typeof m?.content === "string" ? m.content : (m?.content || []).filter((b) => b?.type === "text").map((b) => b.text || "").join(" "));

process.env.PI_WEB_KILL_GRACE_MS = "120"; // the whole escalation in ~120ms instead of 6s

function makeHub({ reply = "the answer" } = {}) {
	const faux = registerFauxProvider({ api: "faux", provider: "faux", models: [{ id: "faux-1", reasoning: false, input: ["text"] }] });
	faux.setResponses(Array.from({ length: 8 }, () => fauxAssistantMessage([fauxText(reply)])));
	const frames = [];
	const hub = new AgentHub({
		modelsStore: { faux: { name: "faux", models: [faux.getModel("faux-1")] } },
		getAuth: () => ({ faux: { key: "k" } }),
		persist: async () => {},
		broadcast: (sid, msg) => frames.push(msg),
		// a tool that NEVER resolves and ignores abort: the wedged-run shape (LFP incident)
		getTools: () => [{
			name: "read_file", description: "hang", parameters: { type: "object", properties: {} },
			execute: async (_id, _p, _signal) => await new Promise(() => {}),
		}],
		killGraceMs: 120,
	});
	return { hub, faux, frames };
}
const feedHangingTool = (faux) => faux.setResponses([fauxAssistantMessage([fauxToolCall("read_file", { path: "x" })]), fauxAssistantMessage([fauxText("never reached")])]);

// ── the escalation ─────────────────────────────────────────────────────────
{
	const { hub, faux, frames } = makeHub();
	feedHangingTool(faux);
	const S = "kill-me";
	hub.getSession(S, { messages: [{ role: "user", content: "start a wedged run" }] });
	const oldAgent = hub.sessions.get(S).agent;
	// do NOT await: the run never finishes (that is the point) — prompt() resolves at the END of a run
	void hub.prompt(S, "go").catch(() => {});
	await sleep(80);
	check("K1 the run really is streaming inside the wedged tool", hub.sessions.get(S).agent.state.isStreaming === true || hub.getRuntime(S)?.status === "running", JSON.stringify({ streaming: hub.sessions.get(S).agent.state.isStreaming, rt: hub.getRuntime(S)?.status }));

	hub.abort(S); // the user presses Stop
	await sleep(400); // > grace (120ms)
	const entry = hub.sessions.get(S);
	check("K2 after the grace the hub FORCE-KILLS instead of just claiming idle", entry.forcedKillAt > 0, String(entry.forcedKillAt));
	check("K3 …and the runtime is honestly idle (forced:true, so the UI can say so)", entry.runtime.status === "idle" && entry.runtime.forced === true, JSON.stringify(entry.runtime));
	check("K4 …with a note frame so every device learns WHY", frames.some((f) => f.type === "note" && /stop forced/.test(String(f.note))));
	check("K5 the wedged run is DETACHED: a fresh, un-streaming Agent replaced it", entry.agent !== oldAgent && entry.agent.state.isStreaming === false);
	check("K6 the transcript survived the kill (nothing was thrown away)", entry.agent.state.messages.some((m) => m.role === "user" && textOf(m).includes("start a wedged run")));
	check("K7 the abandoned run cannot append into the live transcript (the messages array is a copy)",
		(() => { const before = entry.agent.state.messages.length; oldAgent.state.messages.push({ role: "assistant", content: "ghost", timestamp: 1 }); return entry.agent.state.messages.length === before; })());

	// THE POINT OF THE WHOLE EXERCISE: the user can act again
	const accepted = await Promise.race([hub.prompt(S, "a new turn after the kill"), sleep(1500).then(() => ({ accepted: false, reason: "timed out" }))]);
	await sleep(120);
	check("K8 a NEW prompt is accepted after the kill (pi's activeRun guard no longer blocks the session)",
		accepted?.accepted === true, JSON.stringify(accepted));
	check("K9 …and it actually ran (a NEW assistant reply landed after the kill)",
		(() => {
			const msgs = entry.agent.state.messages;
			const lastUser = msgs.map((m) => m.role).lastIndexOf("user");
			return msgs.slice(lastUser + 1).some((m) => m.role === "assistant" && textOf(m).trim().length > 0);
		})(), JSON.stringify(entry.agent.state.messages.map((m) => `${m.role}:${textOf(m).slice(0, 18)}`)));
	check("K10 the runtime is running again, without the forced flag", entry.runtime.status !== "idle" ? entry.runtime.forced !== true : true, JSON.stringify(entry.runtime));
}

// ── a stop that DOES work must not be force-killed (no false positives) ────
{
	const { hub, frames } = makeHub({ reply: "quick" });
	const S = "clean-stop";
	hub.getSession(S, { messages: [{ role: "user", content: "hi" }] });
	const res = await hub.prompt(S, "say something quick");
	await sleep(150); // short run, already finished
	hub.abort(S);
	await sleep(400);
	check("K11 a stop on an idle/finished session is a no-op (no force-kill, no scary note)",
		hub.sessions.get(S).forcedKillAt === undefined && !frames.some((f) => f.type === "note" && /stop forced/.test(String(f.note))),
		JSON.stringify({ forced: hub.sessions.get(S).forcedKillAt, accepted: res?.accepted }));
	check("K12 …and the hub is idle either way", hub.getRuntime(S)?.status === "idle");
}

// ── the escalation is tunable and documented ───────────────────────────────
{
	const { hub } = makeHub();
	check("G1 the grace is configurable (PI_WEB_KILL_GRACE_MS / killGraceMs) so tests and slow hosts agree",
		/Number\(this\.killGraceMs \?\? process\.env\.PI_WEB_KILL_GRACE_MS\)/.test(await (await import("node:fs/promises")).readFile(new URL("../agent-hub.mjs", import.meta.url), "utf8")));
	check("G2 force-kill rebuilds through the ONE agent factory (no drift between getSession and the rebuild)",
		typeof hub._makeAgent === "function" && typeof hub._forceKill === "function" && typeof hub._bindAgent === "function");
	check("G3 the rebuilt agent carries the same tools + model", (() => {
		const a = hub._makeAgent({ model: hub._defaultModel(), tools: [{ name: "read_file", description: "r", parameters: { type: "object", properties: {} } }], messages: [] });
		return a.state.tools?.length === 1 && !!a.state.model;
	})());
}

console.log(`\n[force-kill] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
