// CDP regression: sync pipeline — drives the live pi-web page on :9222
// Covers: browser-format put → JSONL mirror, REST load path, WS get shape,
//         list, two-client broadcast fan-out, newline/unicode line-safety,
//         model-as-object AND model-as-string branches, invalid-ID rejection,
//         delete, legacy-shim counter, static-asset serving after catch-all move.
// NOTE: node --check is syntax-only — THIS script is the real coverage for the
// session-id.mjs shared-module fix (it exercises the real worker_threads import).
const targets = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const page = targets.find(t => t.type === "page" && t.url.includes("localhost:8787"));
if (!page) { console.error("pi web page not found"); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let mid = 0; const pending = new Map();
const send = (method, params) => new Promise((res, rej) => {
	const id = ++mid; pending.set(id, { res, rej });
	ws.send(JSON.stringify({ id, method, params }));
});
ws.onmessage = (e) => {
	const m = JSON.parse(e.data);
	if (m.id && pending.has(m.id)) {
		const p = pending.get(m.id); pending.delete(m.id);
		m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
	}
};
await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error("cdp ws error")); });

const expr = `(async () => {
	const out = {};
	const SYNC = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws/sync";
	const dial = () => new Promise((res) => { const w = new WebSocket(SYNC); w.onopen = () => res(w); });
	const framesOf = (w, ms = 1200) => new Promise((resolve) => { const f = []; w.onmessage = (e) => f.push(JSON.parse(e.data)); setTimeout(() => resolve(f), ms); });

	// EXACT shapes from main.tsx saveSession() / session-sync pushNow()
	const mkData = (id, model, extraMsg) => ({
		id, title: "e2e " + id, model,
		thinkingLevel: "high",
		messages: [
			{ role: "user", content: [{ type: "text", text: "line1\\nline2\\ttab \\u00e9\\u4f60\\u597d \\ud83d\\ude00 <script>alert(1)</script>" }] },
			{ role: "assistant", content: [{ type: "text", text: extraMsg || "ok" }] },
		],
		createdAt: new Date().toISOString(), lastModified: new Date().toISOString(),
	});
	const mkMeta = (d) => ({
		id: d.id, title: d.title, createdAt: d.createdAt, lastModified: d.lastModified,
		messageCount: d.messages.length, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		thinkingLevel: d.thinkingLevel, preview: "e2e",
	});

	// --- A) two-client fan-out + model-as-object + newline/unicode messages
	const idA = "e2ea" + Date.now();
	const wA = await dial(), wB = await dial();
	const bFrames = framesOf(wB, 1500); // B listens from before the put
	wA.send(JSON.stringify({ type: "put", id: idA, data: mkData(idA, { id: "z-ai/glm-5.3-flash", provider: "nvidia" }), metadata: mkMeta(mkData(idA)) }));
	const bf = await bFrames;
	out.fanout = {
		bGotSessions: bf.some(f => f.type === "sessions" && (f.sessions || []).some(s => s.id === idA)),
		anyError: bf.some(f => f.type === "error"),
	};
	wA.close();

	// --- B) model-as-string branch + REST load path
	const idS = "e2es" + Date.now();
	const wS = await dial();
	wS.send(JSON.stringify({ type: "put", id: idS, data: mkData(idS, "z-ai/glm-5.3-flash"), metadata: mkMeta(mkData(idS, "z-ai/glm-5.3-flash")) }));
	await framesOf(wS, 800);
	wS.close();
	try {
		const r = await fetch("/api/agent/session/" + idS, { signal: AbortSignal.timeout(6000) });
		const j = await r.json();
		out.restStringModel = { status: r.status, exists: j.exists, msgs: (j.messages || []).length, modelId: j.model?.id ?? null, thinking: j.thinkingLevel };
	} catch (e) { out.restStringModel = "fetch failed: " + e.message; }

	// --- C) legacy-shim counter visible?
	try {
		const r = await fetch("/api/debug/state", { signal: AbortSignal.timeout(4000) });
		out.debugState = await r.json();
	} catch (e) { out.debugState = "failed: " + e.message; }

	// --- D0) static assets still served after the catch-all move (bugs.md #16 regression)
	try {
		const src = document.querySelector("script[src*='/assets/app']")?.getAttribute("src");
		const r = src ? await fetch(src, { signal: AbortSignal.timeout(8000) }) : null;
		out.staticAsset = { src, status: r ? r.status : "no script tag", bytes: r ? (await r.arrayBuffer()).byteLength : 0 };
	} catch (e) { out.staticAsset = "failed: " + e.message; }

	// --- D) WS get shape + invalid IDs
	const wG = await dial();
	const got = framesOf(wG, 1000);
	wG.send(JSON.stringify({ type: "get", id: idS }));
	wG.send(JSON.stringify({ type: "get", id: "../etc/passwd" }));
	wG.send(JSON.stringify({ type: "put", id: "$$$bad$$$", data: { messages: [] }, metadata: {} }));
	const gf = await got;
	const sess = gf.find(f => f.type === "session" && f.id === idS);
	out.wsGet = sess ? { msgs: sess.data?.messages?.length, hasJsonl: typeof sess.jsonl === "string", metaModelId: sess.metadata?.modelId, metaTitle: !!sess.metadata?.title } : "NO FRAME";
	out.invalidIds = { anyErrorFrame: gf.some(f => f.type === "error"), anyBadIdData: gf.some(f => f.id && f.id.includes("passwd")) };
	wG.close();

	// --- E) cleanup
	for (const id of [idA, idS]) {
		const w = await dial();
		w.send(JSON.stringify({ type: "delete", id }));
		await framesOf(w, 600);
		w.close();
	}
	return out;
})()`;
const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
if (r.exceptionDetails) { console.error("PAGE EXCEPTION:", JSON.stringify(r.exceptionDetails, null, 2)); process.exit(1); }
console.log(JSON.stringify(r.result.value, null, 2));
ws.close();
