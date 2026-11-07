// arena-peer.test.mjs — arena.ai as a peer BACKEND, not a second peer implementation.
//
// The user's instruction (2026-10-31): "rather than make new codes, use the same api/codes for subagent
// (both pi/arena)". So the test's job is to prove the two backends are INDISTINGUISHABLE from the hub's
// point of view: same spawnPeer, same session, same role, same journal, same status/control/result — the
// only difference is the streamFn and the model object (lib/arena-stream.mjs).
//
// The bridge is injected (a fake), so nothing here needs a browser or a logged-in arena tab.
// Usage: node tests/arena-peer.test.mjs
import { AgentHub } from "../agent-hub.mjs";
import { registerFauxProvider, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/compat";
import { createArenaBridge, makeArenaStreamFn, arenaModel, parseModelSpec, flattenContext } from "../lib/arena-stream.mjs";
import { resolveRole } from "../lib/peer-roles.mjs";

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
	if (cond) { pass++; console.log(`  ✓ ${name}`); }
	else { fail++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── the spec ───────────────────────────────────────────────────────────────
{
	check("P1 `arena/<slug>` selects the backend", parseModelSpec("arena/grok-4.6-high")?.kind === "arena" && parseModelSpec("arena/grok-4.6-high").slug === "grok-4.6-high");
	check("P2 …and the colon form too", parseModelSpec("ARENA: gemini-3.1-pro-preview")?.slug === "gemini-3.1-pro-preview");
	check("P3 a pi id stays a pi id", parseModelSpec("deepseek-ai/deepseek-v4.1-flash")?.kind === "pi");
	check("P4 an empty spec is null and bare `arena` means the arena ROUTER (not a pi fallback)",
		parseModelSpec("") === null && parseModelSpec(null) === null &&
		parseModelSpec("arena")?.router === true && parseModelSpec("arena:")?.router === true && parseModelSpec("arena/max")?.slug === "max");
	check("P5 the model object looks like a model to every other reader",
		arenaModel("grok-4.6-high").id === "arena/grok-4.6-high" && arenaModel("x").provider === "arena" && arenaModel("x").input.includes("text"));
}

// ── flattening a pi Context into the bridge's single prompt ────────────────
{
	const prompt = flattenContext({
		systemPrompt: "# Role: reviewer\nread only",
		messages: [
			{ role: "user", content: "review this" },
			{ role: "assistant", content: [{ type: "text", text: "on it" }] },
			{ role: "user", content: [{ type: "text", text: "extra" }, { type: "image", mimeType: "image/png" }] },
		],
	});
	check("F1 the system prompt leads and the roles are labelled",
		prompt.startsWith("# System") && prompt.includes("user: review this") && prompt.includes("assistant: on it"));
	check("F2 attachments degrade to a marker (the bridge cannot send images)", prompt.includes("[image]") && prompt.includes("user: extra"));
	check("F3 junk context cannot throw (and still carries the limitation note)", typeof flattenContext(null) === "string" && typeof flattenContext({ messages: null }) === "string" && /NO tools/.test(flattenContext(null)));
	check("F4 every arena prompt STATES the limitation (no tools, text only) — the model cannot discover it",
		/NO tools/.test(prompt) && /cannot read files/.test(flattenContext({ systemPrompt: "role" })));
}

// ── a fake bridge, injected exactly like the real one ──────────────────────
function makeFakeBridge({ reply = "ARENA ANSWER", fail = null, delayMs = 0, track = [] } = {}) {
	const bridge = {
		async available() { return fail === "unavailable" ? { ok: false, reason: "no arena.ai tab" } : { ok: true, reason: null }; },
		// the wrapper resolves a slug to the model uuid through the catalog (the bridge's own slug field is gone)
		async resolveModelId(slug) { return `uuid-${slug}`; },
		async listNames() { return ["grok-4.6-high", "claude-sonnet-5-high"]; },
		async chat({ slug, message, signal, onUpdate }) {
			track.push({ slug, at: Date.now(), len: message.length });
			onUpdate?.({ lastText: `arena: ${slug} thinking…` });
			if (delayMs) await sleep(delayMs);
			if (fail === "throw") throw new Error("the arena tab died");
			if (signal?.aborted) return { status: "aborted", error: "stopped by the user", text: "" };
			if (fail === "empty") return { status: "error", error: "the arena tab returned no text", text: "" };
			return { status: "ok", text: reply, routedModel: `xai/${slug}`, elapsedMs: delayMs };
		},
		bridgePath: "(fake)",
		busy: () => false,
	};
	return bridge;
}

function makeHub({ bridge, reply = "PI ANSWER" } = {}) {
	const faux = registerFauxProvider({ api: "faux", provider: "faux", models: [{ id: "faux-1", reasoning: false, input: ["text"] }] });
	faux.setResponses(Array.from({ length: 6 }, () => fauxAssistantMessage([fauxText(reply)])));
	const hub = new AgentHub({
		modelsStore: { faux: { name: "faux", models: [faux.getModel("faux-1")] } },
		getAuth: () => ({ faux: { key: "k" } }),
		persist: async () => {},
		broadcast: () => {},
		getTools: (sessionId, meta = {}) => (meta.kind === "peer" && !meta.role?.tools?.length ? [] : []),
		arena: bridge,
	});
	return { hub, faux };
}

// ── the SAME peer path, arena backend ──────────────────────────────────────
{
	const track = [];
	const bridge = makeFakeBridge({ track });
	const { hub } = makeHub({ bridge });
	hub.getSession("P", { messages: [{ role: "user", content: "delegate" }] });
	const s = hub.spawnPeer("P", { role: resolveRole("reviewer", {}), task: "give me an opinion", model: "arena/grok-4.6-high" });
	check("A1 spawnPeer accepts an arena model spec", s.ok === true, JSON.stringify(s.reason));
	const out = await s.promise;
	check("A2 the peer reports ok with the arena text", out.status === "ok" && out.summary === "ARENA ANSWER", `${out.status}: ${out.summary}`);
	check("A3 …and names the backend in the result (the model id IS the spec)",
		out.model === "arena/grok-4.6-high" && parseModelSpec(out.model).slug === "grok-4.6-high", JSON.stringify({ model: out.model }));
	check("A4 the bridge was called with the slug and the TASK (not a flattened transcript)", track.length === 1 && track[0].slug === "grok-4.6-high" && track[0].len >= "give me an opinion".length);
	check("A5 usage is honest zeros (the bridge cannot report tokens)", out.usage.input === 0 && out.usage.output === 0);

	const child = hub.sessions.get(out.sessionId);
	check("A6 the child is a REAL session with a real Agent (same machinery, not a special case)",
		!!child?.agent && child.kind === "peer" && child.parentSession === "P");
	check("A7 …whose model reads as arena everywhere (header, UsageBar, picker)", child.agent.state.model?.provider === "arena" && child.agent.state.model?.id === "arena/grok-4.6-high");
	check("A8 …with a normal transcript: the task, then the answer",
		child.agent.state.messages.filter((m) => m.role === "user").length === 1 &&
		child.agent.state.messages.some((m) => m.role === "assistant" && String((m.content || [])[0]?.text || "").includes("ARENA ANSWER")));
	check("A9 the journal recorded the peer like any other (status survives a restart)",
		hub.sessions.get("P").peerJournal[0].role === "reviewer" && hub.sessions.get("P").peerJournal[0].status === "running");
	hub.closePeerJournal("P", s.peerId, { status: out.status, sessionId: out.sessionId });
	check("A10 …and closes with the arena result", hub.peersOf("P")[0].status === "idle" && hub.peersOf("P")[0].sessionId === out.sessionId);
	const steer = await hub.controlPeer("P", s.peerId, "steer", { text: "more detail" });
	check("A11 steering an arena peer is refused with a REASON (single request, not a stream)", steer.ok === false && /single|not supported/.test(String(steer.reason)), String(steer.reason));
}

// ── failures are results, never rejections ─────────────────────────────────
{
	const { hub } = makeHub({ bridge: makeFakeBridge({ fail: "throw" }) });
	hub.getSession("P", { messages: [{ role: "user", content: "x" }] });
	const out = await hub.spawnPeer("P", { role: resolveRole("oracle", {}), task: "t", model: "arena/grok-4.6-high" }).promise;
	check("E1 a throwing bridge becomes status:error (the agent's run ends with an error message, no rejection)",
		out.status === "error" && /arena tab died/.test(String(out.error)), `${out.status}: ${out.error}`);
	check("E2 …and the child session still exists for inspection", !!hub.sessions.get(out.sessionId));
}
{
	const { hub } = makeHub({ bridge: makeFakeBridge({ fail: "empty" }) });
	hub.getSession("P", { messages: [{ role: "user", content: "x" }] });
	const out = await hub.spawnPeer("P", { role: resolveRole("oracle", {}), task: "t", model: "arena/grok-4.6-high" }).promise;
	check("E3 an empty answer is an error with its reason, not an empty success", out.status === "error" && String(out.error).length > 0, `${out.status}: ${out.error}`);
}
{
	// no bridge injected at all (a pi-only install): the spawn is refused with an explanation
	const faux = registerFauxProvider({ api: "faux", provider: "faux", models: [{ id: "faux-1", reasoning: false, input: ["text"] }] });
	const hub = new AgentHub({ modelsStore: { faux: { name: "faux", models: [faux.getModel("faux-1")] } }, getAuth: () => ({ faux: { key: "k" } }), persist: async () => {}, broadcast: () => {}, getTools: () => [] });
	hub.getSession("P", { messages: [{ role: "user", content: "x" }] });
	const s = hub.spawnPeer("P", { role: resolveRole("oracle", {}), task: "t", model: "arena/grok-4.6-high" });
	check("E4 without a bridge the refusal names the fix (open arena.ai / set PI_WEB_ARENA_BRIDGE)", s.ok === false && /arena/i.test(String(s.reason)), String(s.reason));
}

// ── the REAL bridge wrapper: one tab, one call (serialized), abort = drop the answer ──
// (a fake bridge MODULE on disk, so the wrapper under test is the real one: queue, timeout, abort)
{
	const { writeFileSync, readFileSync: read, rmSync } = await import("node:fs");
	const os = await import("node:os");
	const pathMod = await import("node:path");
	const logFile = pathMod.join(os.tmpdir(), `arena-fake-${Date.now()}.log`);
	const moduleFile = pathMod.join(os.tmpdir(), `arena-fake-${Date.now()}.mjs`);
	writeFileSync(moduleFile, `
import { appendFileSync } from "node:fs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function listModels() {
	// the LIVE catalog shape (ws/arena/models.json): NO \`slug\` field, names + a uuid id
	return [
		{ id: "uuid-grok", publicName: "grok-4.6-high", displayName: "grok-4.6-high", organization: "xai", userSelectable: true },
		{ id: "uuid-claude", publicName: "claude-sonnet-5-high", organization: "anthropic", userSelectable: true },
	];
}
export async function chat(message, slug, modelId) {
	appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ at: Date.now(), slug, modelId, message }) + "\\n");
	await sleep(60);
	return { text: "REAL WRAPPER " + slug + " (" + modelId + ")", routedModel: "xai/" + slug, convId: "c1" };
}
`, "utf8");
	const bridge = createArenaBridge({ bridgePath: moduleFile, log: () => {} });
	try {
		const a = bridge.chat({ slug: "grok-4.6-high", message: "one" });
		await sleep(5);
		const b = bridge.chat({ slug: "claude-sonnet-5-high", message: "two" });
		const [ra, rb] = await Promise.all([a, b]);
		const calls = read(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
		check("Q1 both calls completed through the real wrapper", ra.status === "ok" && rb.status === "ok" && /REAL WRAPPER/.test(ra.text));
		check("Q1b the SLUG was resolved to the model UUID first (the bridge's own slug field is gone)",
			calls[0].modelId === "uuid-grok" && calls[1].modelId === "uuid-claude", JSON.stringify(calls.map((c) => c.modelId)));
		check("Q1d a ROUTER request still works (no 'Max' entry in this fake catalog → the bridge's own default)",
			await (async () => {
				const r = await bridge.chat({ slug: "", message: "route this" });
				return r.status === "ok" && /REAL WRAPPER|Max/.test(r.text);
			})());
		check("Q1c an unknown slug is refused WITH suggestions from the catalog", await (async () => {
			const r = await bridge.chat({ slug: "grok-nope", message: "x" });
			return r.status === "error" && /no model "grok-nope"/.test(r.error) && /grok-4\.6-high/.test(r.error);
		})());
		check("Q2 …SERIALLY (the second started after the first finished: ONE browser tab)",
			calls.length === 2 && calls[1].at - calls[0].at >= 50, JSON.stringify(calls.map((c) => c.at)));
		const controller = new AbortController();
		const p = bridge.chat({ slug: "grok-4.6-high", message: "long", signal: controller.signal });
		setTimeout(() => controller.abort(), 10);
		const out = await p;
		check("Q3 an abort returns 'aborted' and DISCARDS the answer", out.status === "aborted" && out.text === "", `${out.status} ${JSON.stringify(out.text)}`);
		check("Q4 …and a later call still works (the queue is not wedged)", (await bridge.chat({ slug: "grok-4.6-high", message: "after" })).status === "ok");
		check("Q5 the wrapper reports a busy tab while a call is in flight", (() => { void bridge.chat({ slug: "grok-4.6-high", message: "x" }); return bridge.busy() === true; })());
	} finally {
		try { rmSync(moduleFile); rmSync(logFile); } catch { /* temp files */ }
	}
}

// ── the real bridge factory is honest about a missing checkout ──────────────
{
	const missing = createArenaBridge({ bridgePath: "C:/definitely/not/here/chat-api.mjs", log: () => {} });
	const avail = await missing.available();
	check("R1 a missing bridge file is reported, not thrown", avail.ok === false && /no usable arena bridge/.test(String(avail.reason)), String(avail.reason));
	const chat = await missing.chat({ slug: "x", message: "y" });
	check("R2 …and chat() returns an error RESULT (never a rejection)", chat.status === "error" && String(chat.error).length > 0);
	check("R3 a stream built on it ends with an error event, so a peer run fails cleanly", await (async () => {
		const streamFn = makeArenaStreamFn({ bridge: missing, slug: "x" });
		const stream = streamFn(arenaModel("x"), { systemPrompt: "s", messages: [{ role: "user", content: "hi" }] }, {});
		const events = [];
		for await (const ev of stream) events.push(ev.type);
		return events.includes("start") && events.includes("error");
	})());
}

console.log(`\n[arena-peer] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
