// CDP verification for SESSION_ID_RE fix — drives the live pi-web page on :9222
const targets = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const page = targets.find(t => t.type === "page" && t.url.includes("localhost:8787"));
if (!page) { console.error("pi web page not found"); process.exit(1); }
console.log("target:", page.url);

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

// In-page test: open /ws/sync, fire all ops with delays, collect every frame.
const expr = `(async () => {
	const log = [];
	const id = "cdptest" + Date.now();
	const S = (o) => ws.send(JSON.stringify(o));
	const ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws/sync");
	ws.onmessage = (e) => { const m = JSON.parse(e.data); log.push({ t: Date.now() - t0, type: m.type, id: m.id, err: m.error, n: m.sessions ? m.sessions.length : undefined, hasReal: m.sessions ? m.sessions.some(s => String(s.id).startsWith("1beb2a8d")) : undefined }); };
	const t0 = Date.now();
	await new Promise(r => ws.onopen = r);
	log.push({ t: 0, type: "__open" });
	const jsonl = JSON.stringify({ id, title: "cdp-test", created: new Date().toISOString() }) + "\\n" + JSON.stringify({ role: "user", content: "hello from cdp" }) + "\\n";
	S({ type: "put", id, jsonl });                                    await new Promise(r => setTimeout(r, 600));   // put valid
	S({ type: "get", id });                                           await new Promise(r => setTimeout(r, 600));   // get valid
	S({ type: "watch", id });                                         await new Promise(r => setTimeout(r, 600));   // watch valid
	S({ type: "put", id: "../etc/passwd", jsonl: "{}" });             await new Promise(r => setTimeout(r, 400));   // put INVALID id
	S({ type: "get", id: "$$$bad$$$" });                              await new Promise(r => setTimeout(r, 600));   // get INVALID id
	S({ type: "list" });                                              await new Promise(r => setTimeout(r, 800));   // list (regression)
	S({ type: "delete", id });                                        await new Promise(r => setTimeout(r, 800));   // delete valid
	try { ws.close(); } catch {}
	return { id, log };
})()`;
const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
if (r.exceptionDetails) { console.error("PAGE EXCEPTION:", JSON.stringify(r.exceptionDetails, null, 2)); process.exit(1); }
console.log(JSON.stringify(r.result.value, null, 2));
ws.close();
