// CDP verify: session restore — drives the live page on :9222 through all real sessions
const targets = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const page = targets.find(t => t.type === "page" && t.url.includes("localhost:8787"));
if (!page) { console.error("pi web page not found"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let mid = 0; const pending = new Map();
const send = (m, p) => new Promise((res, rej) => { const id = ++mid; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method: m, params: p })); });
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error("cdp ws")); });

const evalPage = async (expression) => {
	const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	if (r.exceptionDetails) throw new Error("page exception: " + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
	return r.result.value;
};
const nav = async (url) => { await send("Page.navigate", { url }); await new Promise(r => setTimeout(r, 4500)); };

// expected: [id, title, localMsgCount, mirroredOnServer]
const cases = [
	["6442a831-8f3d-4e08-89c7-5fe3db4eae44", "can you see any files on ws/local", 9, true],
	["1beb2a8d-4566-4d7b-aa84-be350bd12529", "Hello", 2, false],
	["44d74c91-b472-4020-865e-f89d1daf2a10", "Say PONG and nothing else.", 2, false],
	["ab99859f-56d4-4985-bcb4-9a412b78d9a3", "Are you online?", 4, false],
];
const results = [];
for (const [id, title, n] of cases) {
	await nav(`http://localhost:8787/?session=${id}`);
	const probe = await evalPage(`(() => {
		const stack = document.querySelector(".flex.flex-col.gap-3");
		return {
			url: location.search,
			title: document.querySelector(".pi-title-btn")?.textContent || "(no title btn)",
			stackChildren: stack ? stack.children.length : -1,
			textLen: (document.body.innerText || "").length,
		};
	})()`);
	const pass = probe.url.includes(id) && probe.title === title;
	results.push({ id: id.slice(0, 8), expectTitle: title, expectMsgs: n, ...probe, PASS: pass });
}

// offline-dialog test: stub /api/sessions to fail, click Sessions, dialog must still open
await evalPage(`(() => {
	window.__origFetch = window.fetch;
	window.fetch = (u, ...a) => String(u).includes("/api/sessions") ? Promise.reject(new Error("offline-sim")) : window.__origFetch(u, ...a);
})()`);
await evalPage(`document.querySelector('button[title="Sessions"]')?.click()`);
await new Promise(r => setTimeout(r, 1200));
const dialog = await evalPage(`(() => {
	const dlg = document.querySelector("[role=dialog], dialog, .pi-dialog, [class*=dialog]");
	const items = document.body.innerText.match(/can you see any files|Are you online|Say PONG|Hello/g) || [];
	return { dialogFound: !!dlg, listItemsSeen: [...new Set(items)] };
})()`);
await evalPage(`(() => { window.fetch = window.__origFetch; document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); })()`);

// debris cleanup: remove my test metadata entries from the user's localStorage
const cleaned = await evalPage(`(() => {
	const dead = ["cdptest", "e2es1792309", "e2etest"];
	let removed = [];
	for (const k of Object.keys(localStorage)) {
		if (dead.some(d => k.includes("sessions-metadata") && k.includes(d))) { localStorage.removeItem(k); removed.push(k); }
	}
	return removed.length;
})()`);

console.log(JSON.stringify({ results, offlineDialog: dialog, debrisRemoved: cleaned }, null, 2));
ws.close();
