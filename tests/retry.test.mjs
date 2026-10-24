// retry.test.mjs — hub retry + auto-retry on provider/network failures
// (user request 2026-10-23: "current retry after 429/network error resends the
// user prompt — it should be retried right before the error: remove the 429/err
// message and retry from the user turn"; "version should be sustained for
// retry/edit by 429/network error"; "add option for auto retry (3 times, 3s)").
//
// Hermetic: pi-ai's FAUX provider scripts assistant messages (including
// stopReason "error" + errorMessage, exactly how pi encodes a 429), so no
// network, no keys, no timing flakiness beyond the retry delay.
//
// Coverage:
//   1. manual retry resumes AT THE FAILURE POINT: the error message is dropped,
//      agent.continue() re-issues the model call — the user turn appears exactly
//      once (the old client-side retry appended a SECOND user prompt)
//   2. completed tool calls are NOT re-run (tail = toolResult → continue)
//   3. auto-retry recovers within the attempt budget with no user action
//   4. auto-retry gives up after the cap and says so (runtime note)
//   5. auth/context errors are NOT retried (no quota burn)
//   6. an ✎ edit whose resubmit hit a 429 KEEPS its parked version and continues
//   7. retry refuses when nothing failed (never regenerates a healthy turn)
import { registerFauxProvider, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { AgentHub } from "../agent-hub.mjs";

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
	if (cond) { pass++; console.log(`  ✓ ${name}`); }
	else { fail++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const textOf = (m) => (typeof m?.content === "string" ? m.content : (m?.content || []).filter((b) => b?.type === "text").map((b) => b.text || "").join("\n"));
const RATE_LIMIT = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 Too Many Requests — rate limit exceeded" });
const AUTH_ERROR = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 Unauthorized — invalid API key" });
const ok = (text) => fauxAssistantMessage([fauxText(text)]);

function makeHub({ versions, tools } = {}) {
	const faux = registerFauxProvider({ api: "faux", provider: "faux", models: [{ id: "faux-1", reasoning: false, input: ["text", "image"] }] });
	const hub = new AgentHub({
		modelsStore: { faux: { name: "faux", models: [faux.getModel("faux-1")] } },
		getAuth: () => ({ faux: { key: "test-key" } }),
		persist: async () => {},
		broadcast: () => {},
		getTools: () => tools || [],
		versions,
	});
	return { hub, faux };
}
const msgsOf = (hub, id) => hub.sessions.get(id).agent.state.messages;
async function waitFor(fn, ms = 5000) {
	const t0 = Date.now();
	for (;;) {
		let v = false;
		try { v = fn(); } catch { /* not ready */ }
		if (v) return true;
		if (Date.now() - t0 > ms) return false;
		await sleep(20);
	}
}

// --- 1) manual retry resumes at the failure point ---------------------------
{
	const { hub, faux } = makeHub();
	faux.setResponses([RATE_LIMIT(), ok("recovered after retry")]);
	const id = "retrytest0000000000000000000001";
	hub.getSession(id, { messages: [] });
	await hub.prompt(id, "hello");
	let msgs = msgsOf(hub, id);
	check("failed run ends in an error assistant message",
		msgs.length === 2 && msgs[1].role === "assistant" && msgs[1].stopReason === "error",
		JSON.stringify(msgs.map((m) => [m.role, m.stopReason])));
	check("runtime reported the error", hub.sessions.get(id).runtime.status === "error");

	const r = await hub.retry(id);
	msgs = msgsOf(hub, id);
	check("retry resumed with continue() (not a re-send)", r?.ok === true && r.mode === "continue" && r.dropped === 1, JSON.stringify(r));
	check("error message is GONE and the retried answer is in its place",
		msgs.length === 2 && msgs[1].stopReason !== "error" && textOf(msgs[1]).includes("recovered after retry"),
		JSON.stringify(msgs.map((m) => [m.role, m.stopReason, textOf(m).slice(0, 24)])));
	check("user turn appears EXACTLY once (no duplicated prompt)",
		msgs.filter((m) => m.role === "user").length === 1 && textOf(msgs[0]) === "hello");
	check("exactly two model calls (original + retry)", faux.state.callCount === 2, String(faux.state.callCount));
}

// --- 2) a completed tool call is not re-run ---------------------------------
{
	let toolRuns = 0;
	const tool = { name: "countme", description: "test tool", parameters: { type: "object", properties: {} }, execute: async () => { toolRuns++; return "tool output"; } };
	const { hub, faux } = makeHub({ tools: [tool] });
	faux.setResponses([ok("finished after the tool")]);
	const id = "retrytest0000000000000000000002";
	hub.getSession(id, {
		messages: [
			{ role: "user", content: [{ type: "text", text: "run the tool" }], timestamp: 0 },
			{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "countme", arguments: {} }], stopReason: "toolUse", timestamp: 1 },
			{ role: "toolResult", toolCallId: "c1", toolName: "countme", content: [{ type: "text", text: "tool output" }], timestamp: 2 },
			{ role: "assistant", content: [{ type: "text", text: "" }], stopReason: "error", errorMessage: "429 Too Many Requests — rate limit exceeded", timestamp: 3 },
		],
	});
	const r = await hub.retry(id);
	const msgs = msgsOf(hub, id);
	check("retry after a failed step that FOLLOWED a tool call", r?.ok === true && r.mode === "continue", JSON.stringify(r));
	check("the completed toolResult is preserved (resume before the error)", msgs.some((m) => m.role === "toolResult" && m.toolCallId === "c1"));
	check("the tool was NOT re-executed", toolRuns === 0, `runs=${toolRuns}`);
	check("still one user turn", msgs.filter((m) => m.role === "user").length === 1);
	check("the retried answer landed", textOf(msgs[msgs.length - 1]).includes("finished after the tool"));
}

// --- 3) auto-retry recovers within the budget -------------------------------
{
	const { hub, faux } = makeHub();
	hub.setAutoRetry({ enabled: true, attempts: 3, delayMs: 20 });
	faux.setResponses([RATE_LIMIT(), RATE_LIMIT(), ok("third time lucky")]);
	const id = "retrytest0000000000000000000003";
	hub.getSession(id, { messages: [] });
	await hub.prompt(id, "hi");
	const recovered = await waitFor(() => textOf(msgsOf(hub, id).at(-1)).includes("third time lucky"));
	const msgs = msgsOf(hub, id);
	check("auto-retry recovered with no user action", recovered, JSON.stringify(msgs.map((m) => [m.role, m.stopReason])));
	check("one user turn only", msgs.filter((m) => m.role === "user").length === 1);
	check("three attempts total", faux.state.callCount === 3, String(faux.state.callCount));
	check("runtime is idle after success", hub.sessions.get(id).runtime.status === "idle");
}

// --- 4) auto-retry gives up after the cap -----------------------------------
{
	const { hub, faux } = makeHub();
	hub.setAutoRetry({ enabled: true, attempts: 2, delayMs: 10 });
	faux.setResponses([RATE_LIMIT(), RATE_LIMIT(), RATE_LIMIT(), RATE_LIMIT()]);
	const id = "retrytest0000000000000000000004";
	hub.getSession(id, { messages: [] });
	await hub.prompt(id, "hi");
	await waitFor(() => faux.state.callCount >= 3);
	await sleep(200); // give a (wrong) extra retry time to fire
	check("stopped at the attempt cap (1 + 2)", faux.state.callCount === 3, String(faux.state.callCount));
	check("the hub says it gave up", /gave up/.test(String(hub.sessions.get(id).retryNote || "")), String(hub.sessions.get(id).retryNote));
}

// --- 5) auth / context errors are not auto-retried --------------------------
{
	const { hub, faux } = makeHub();
	hub.setAutoRetry({ enabled: true, attempts: 3, delayMs: 10 });
	faux.setResponses([AUTH_ERROR(), ok("should never run")]);
	const id = "retrytest0000000000000000000005";
	hub.getSession(id, { messages: [] });
	await hub.prompt(id, "hi");
	await sleep(250);
	check("401 is not retried (no quota burn)", faux.state.callCount === 1, String(faux.state.callCount));
	check("classification: 429/network yes, 401/context no",
		hub._isRetryableError({ errorMessage: "429 Too Many Requests" }) === true &&
		hub._isRetryableError({ errorMessage: "fetch failed" }) === true &&
		hub._isRetryableError({ errorMessage: "ECONNRESET" }) === true &&
		hub._isRetryableError({ errorMessage: "503 Service Unavailable" }) === true &&
		hub._isRetryableError({ errorMessage: "401 Unauthorized" }) === false &&
		hub._isRetryableError({ errorMessage: "maximum context length exceeded" }) === false);
}

// --- 6) an edit whose resubmit 429'd keeps its version ----------------------
{
	const versions = {
		records: [],
		async append(id, rec) { const v = { vid: this.records.length + 1, ...rec }; this.records.push(v); return v; },
		async list() { return this.records.map((r) => ({ vid: r.vid, turn: r.turn, count: r.count, reason: r.reason })); },
		async get(id, vid) { return this.records.find((r) => r.vid === Number(vid)) || null; },
	};
	const { hub, faux } = makeHub({ versions });
	faux.setResponses([RATE_LIMIT(), ok("continued after the edit")]);
	const id = "retrytest0000000000000000000006";
	hub.getSession(id, {
		messages: [
			{ role: "user", content: [{ type: "text", text: "original question" }], timestamp: 0 },
			{ role: "assistant", content: [{ type: "text", text: "old answer" }], stopReason: "stop", timestamp: 1 },
		],
	});
	await hub.editCommit(id, 0, "edited question");
	check("edit parked the removed tail as a version",
		versions.records.length === 1 && versions.records[0].reason === "edit" && versions.records[0].messages.length === 2,
		JSON.stringify(versions.records.map((r) => [r.vid, r.reason, r.messages.length])));
	await waitFor(() => msgsOf(hub, id).at(-1)?.stopReason === "error");
	check("the resubmit failed (429) with the version STILL parked", versions.records.length === 1 && msgsOf(hub, id).at(-1)?.stopReason === "error");

	const r = await hub.retry(id);
	const msgs = msgsOf(hub, id);
	check("retry continued the EDITED turn (one user turn, edited text)", r?.ok === true &&
		msgs.filter((m) => m.role === "user").length === 1 && textOf(msgs[0]) === "edited question",
		JSON.stringify(msgs.map((m) => [m.role, textOf(m).slice(0, 18)])));
	check("the answer from the retry landed", textOf(msgs[msgs.length - 1]).includes("continued after the edit"));
	check("version survives the retry (nothing removed it)", versions.records.length === 1);
}

// --- 7) retry refuses when nothing failed -----------------------------------
{
	const { hub, faux } = makeHub();
	faux.setResponses([ok("all good")]);
	const id = "retrytest0000000000000000000007";
	hub.getSession(id, { messages: [] });
	await hub.prompt(id, "hi");
	const r = await hub.retry(id);
	check("healthy transcript → retry refuses (no regeneration)", r?.ok === false && /nothing to retry/.test(String(r.reason)), JSON.stringify(r));
	check("transcript untouched", msgsOf(hub, id).length === 2 && faux.state.callCount === 1);
}

// --- 8) an error AFTER partial assistant content (the scary tail-surgery path) ---
{
	const { hub, faux } = makeHub();
	faux.setResponses([
		// a real 429 can land mid-stream: the partial assistant message must be dropped whole
		fauxAssistantMessage([fauxText("I started answering but the provider cut me off")], { stopReason: "error", errorMessage: "429 Too Many Requests (mid-stream)" }),
		ok("complete answer after the retry"),
	]);
	const id = "retrytest0000000000000000000008";
	hub.getSession(id, { messages: [] });
	await hub.prompt(id, "long question");
	let msgs = msgsOf(hub, id);
	check("partial content + error is the terminal message", msgs.length === 2 && msgs[1].stopReason === "error" && textOf(msgs[1]).includes("cut me off"), JSON.stringify(msgs.map((m) => [m.role, m.stopReason])));
	await hub.retry(id);
	msgs = msgsOf(hub, id);
	check("the partial text is gone (whole message dropped, not appended to)", !textOf(msgs[1]).includes("cut me off") && textOf(msgs[1]).includes("complete answer"), textOf(msgs[1]).slice(0, 40));
	check("still exactly one user turn", msgs.filter((m) => m.role === "user").length === 1);
}

// --- 9) Retry-After is honoured (bounded), instead of the flat delay ------------
{
	const { hub, faux } = makeHub();
	hub.setAutoRetry({ enabled: true, attempts: 2, delayMs: 10 });
	faux.setResponses([
		fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 Too Many Requests — retry after 1" }),
		ok("after honouring retry-after"),
	]);
	const id = "retrytest0000000000000000000009";
	hub.getSession(id, { messages: [] });
	await hub.prompt(id, "hi");
	await sleep(400);
	const early = textOf(msgsOf(hub, id).at(-1)).includes("after honouring retry-after");
	check("did NOT retry before the requested wait (10 ms delay overridden by retry-after: 1)", early === false, early ? "retried too early" : "");
	const later = await waitFor(() => textOf(msgsOf(hub, id).at(-1)).includes("after honouring retry-after"), 4000);
	check("retried after the requested wait", later);
}

console.log(`\n[retry] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
