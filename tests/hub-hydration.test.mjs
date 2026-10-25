// hub-hydration.test.mjs — an entry created BEFORE its transcript is loaded must
// still hydrate (bug found while measuring the IDB cache, 2026-10-24).
//
// THE BUG, as observed: a WS attach on a fresh browser origin rendered an EMPTY
// chat for a 1056-message session, and a direct attach probe reported
// `messages: 1, sparse: null`. A fresh hub entry legitimately holds ONE message
// (the materialized system prompt), so agent-hub's hydration guard
//   `if (entry && entry.agent.state.messages.length > 0) return entry;`
// treated a pre-hydration entry as hydrated FOREVER — the stored transcript was
// never loaded for that process (a hub restart "fixed" it, which is how I found it).
//
// The fix under test:
//   1. entry.hydrated — set when the caller SUPPLIES messages to getSession();
//   2. _ensureEntry() gates on that flag, fills an entry only when it has no real
//      (non-system) messages, and never retries forever;
//   3. attach() awaits hydration before building its snapshot.
//
// Hermetic: pi-ai's faux provider supplies the model; loadMessages is a stub.
// Usage: node tests/hub-hydration.test.mjs
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { AgentHub } from "../agent-hub.mjs";

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
	if (cond) { pass++; console.log(`  ✓ ${name}`); }
	else { fail++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};
const roleMsgs = (n, prefix) => Array.from({ length: n }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `${prefix}${i}`, timestamp: 1700000000000 + i }));
const nonSystem = (hub, id) => (hub.sessions.get(id)?.agent.state.messages || []).filter((m) => m.role !== "system");

function makeHub({ stored = null, heavy = 0, msgBytes = 60000 } = {}) {
	const faux = registerFauxProvider({ api: "faux", provider: "faux", models: [{ id: "faux-1", reasoning: false, input: ["text"] }] });
	const messages = heavy ? Array.from({ length: heavy }, (_, i) => ({ role: "user", content: "x".repeat(msgBytes) + i })) : null;
	const calls = { load: 0 };
	const hub = new AgentHub({
		modelsStore: { faux: { name: "faux", models: [faux.getModel("faux-1")] } },
		getAuth: () => ({ faux: { key: "k" } }),
		persist: async () => {},
		broadcast: () => {},
		getTools: () => [],
		loadMessages: async (id) => {
			calls.load++;
			if (stored === null && !heavy) return null; // genuinely new session (the heavy fixture supplies its own body)
			return { messages: messages || stored, metadata: { modelId: "faux-1", thinkingLevel: "high", title: "stored session" } };
		},
	});
	return { hub, calls };
}
const frames = () => { const out = []; return { out, deliver: (m) => out.push(m) }; };

// ── 1) the exact regression: attach FIRST (no prior hydration) ───────────────
{
	const { hub } = makeHub({ stored: roleMsgs(20, "stored-") });
	const id = "sess-attach-first";
	const { out, deliver } = frames();
	await hub.attach(id, deliver, { tailFirst: true }); // must hydrate before snapshotting
	const state = out.find((m) => m.type === "state");
	check("H1 attach before hydration still delivers the stored transcript",
		!!state && state.exists === true && (state.messages || []).length === 20 && nonSystem(hub, id).length === 20,
		`frames=${out.length} messages=${(state?.messages || []).length}`);
	check("H1b the entry is marked hydrated afterwards", hub.sessions.get(id)?.hydrated === true);
	check("H1c the stored title/model came along", hub.sessions.get(id)?.title === "stored session" && hub.sessions.get(id)?.agent.state.model?.id === "faux-1");
}

// ── 2) the poisoned shape: an entry created empty (prompt/racing store) ──────
{
	const { hub } = makeHub({ stored: roleMsgs(12, "s-") });
	const id = "sess-poisoned";
	hub.getSession(id); // creates an empty entry (one system message) — the old "poisoned" state
	check("H2a a fresh entry is NOT considered hydrated", hub.sessions.get(id)?.hydrated === false && nonSystem(hub, id).length === 0);
	const { out, deliver } = frames();
	await hub.attach(id, deliver, { tailFirst: false });
	const state = out.find((m) => m.type === "state");
	check("H2b attaching that entry fills it from the store",
		(state?.messages || []).length === 12 && nonSystem(hub, id).length === 12,
		`messages=${(state?.messages || []).length}`);
}

// ── 3) a LIVE transcript is never clobbered ─────────────────────────────────
{
	const { hub, calls } = makeHub({ stored: roleMsgs(8, "old-") });
	const id = "sess-live";
	hub.getSession(id, { messages: roleMsgs(3, "live-") }); // explicit hydration
	check("H3a getSession with messages marks hydrated", hub.sessions.get(id)?.hydrated === true);
	const before = calls.load;
	await hub._ensureEntry(id);
	check("H3b no store reload once hydrated", calls.load === before && nonSystem(hub, id).length === 3);
	// and a promoted-later write is not undone by a hydration attempt
	hub.sessions.get(id).agent.state.messages.push({ role: "user", content: "typed after" });
	await hub._ensureEntry(id);
	check("H3c in-flight messages survive an _ensureEntry call",
		nonSystem(hub, id).length === 4 && nonSystem(hub, id).some((m) => m.content === "typed after"));
}

// ── 4) a session the store does not know: hydrated once, not retried ────────
{
	const { hub, calls } = makeHub({ stored: null });
	const id = "sess-new";
	await hub.attach(id, frames().deliver, { tailFirst: true });
	const after1 = calls.load;
	await hub.attach(id, frames().deliver, { tailFirst: true });
	check("H4 a store miss marks the entry hydrated (no reload storm)",
		(after1 === 1 || after1 === 2) && calls.load === after1,
		`loads=${calls.load} afterFirst=${after1}`);
	const st = hub.getState(id);
	check("H4b a new session still reports exists:true with no messages", st.exists === true && (st.messages || []).length === 0);
}

// ── 5) the sparse (tail-first) path also hydrates first ─────────────────────
{
	const { hub } = makeHub({ heavy: 30 }); // ~1.8MB of serialized messages ⇒ sparse
	const id = "sess-sparse";
	// the entry is created empty first, exactly like the racing-attach case
	hub.getSession(id);
	const { out, deliver } = frames();
	await hub.attach(id, deliver, { tailFirst: true });
	const state = out.find((m) => m.type === "state");
	const msgs = state?.messages || [];
	check("H5 a sparse attach on a pre-created entry carries the tail + envelope",
		!!state?.sparse && state.sparse.messageCount === 30 && msgs.length > 0 && msgs.length < 30 && msgs.length === state.sparse.messageCount - state.sparse.fromSeq,
		`window=${state?.sparse ? state.sparse.fromSeq + "…" + state.sparse.messageCount : "none"} msgs=${msgs.length}`);
	check("H5b the tail really is the LAST messages", msgs.length > 0 && String(msgs[msgs.length - 1].content).endsWith("29"));
}

// ── 6) C4: align the window + skip what the client already has (haveTo) ──────
{
	// 400 × ~6KB ≈ 2.4MB ⇒ a 1MB tail starts well past the first chunk, so the window
	// start really is aligned (a tiny session would snap to 0 and stay unaligned).
	const { hub } = makeHub({ heavy: 400, msgBytes: 6000 }); // ~2.4MB ⇒ a 1MB tail starts ~170 msgs in
	const id = "sess-c4";
	const frame = async (haveTo) => {
		const { out, deliver } = frames();
		await hub.attach(id, deliver, { tailFirst: true, haveTo });
		return out.find((m) => m.type === "state");
	};
	const full = await frame(0);
	const sp = full.sparse;
	check("H6a the attach window starts on a chunk boundary",
		!!sp && sp.fromSeq % 64 === 0 && sp.fromSeq > 0 && sp.sentFrom === sp.fromSeq,
		`fromSeq=${sp?.fromSeq} sentFrom=${sp?.sentFrom} msgs=${full.messages.length}`);
	check("H6b without a claim the whole window is sent",
		full.messages.length === sp.messageCount - sp.fromSeq);

	const claimed = sp.fromSeq + 128; // a claim below the window start + 64 snaps back to it
	const trimmed = await frame(claimed);
	check("H6c a claim 128 above the window start trims exactly that much (no wasted bytes)",
		trimmed.sparse.sentFrom === claimed && trimmed.messages.length === sp.messageCount - claimed && trimmed.sparse.fromSeq === sp.fromSeq,
		`sentFrom=${trimmed.sparse.sentFrom} msgs=${trimmed.messages.length}`);

	const tiny = await frame(sp.fromSeq + 5);
	check("H6d a sub-chunk claim snaps DOWN — the server sends it rather than forcing a fetch",
		tiny.sparse.sentFrom === sp.fromSeq && tiny.messages.length === full.messages.length);

	const all = await frame(999999);
	check("H6e a claim that reaches the session end sends NOTHING (the zero-byte return visit)",
		all.messages.length === 0 && all.sparse.sentFrom === sp.messageCount,
		`sentFrom=${all.sparse.sentFrom} msgs=${all.messages.length}`);

	const partial = await frame(Math.floor(sp.messageCount / 64) * 64);
	check("H6g a claim mid-way snaps DOWN and still ships the trailing partial chunk",
		partial.sparse.sentFrom === Math.floor(sp.messageCount / 64) * 64 && partial.messages.length === sp.messageCount - Math.floor(sp.messageCount / 64) * 64,
		`sentFrom=${partial.sparse.sentFrom} msgs=${partial.messages.length}`);

	const none = await frame(1);
	check("H6f a claim below the window start changes nothing", none.messages.length === full.messages.length);
}

console.log(`\n[hub-hydration] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
