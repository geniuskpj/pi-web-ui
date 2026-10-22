#!/usr/bin/env node
// cdp-open.mjs — open a URL in the user's debugged browser (CDP on 127.0.0.1:9222).
//
// WHY THIS EXISTS (2026-10-22): every naive path fails —
//   1. cdp_eval + window.open(url)      → popup-blocked (CDP-driven JS has no user gesture)
//   2. PUT /json/new?url=…              → Edge creates the tab but NEVER navigates (stays
//                                         about:blank forever — verified twice)
//   3. Page.navigate over the target's devtools WebSocket → WORKS (verified end-to-end)
//
// Pattern follows ws/cdp_project/src/cdp.js (raw CDP over `ws`: single JSON object per
// frame, id-correlated pending map, per-send timeout) and src/browser.js goto()
// (Page.navigate + Page.loadEventFired race). New tab via Target.createTarget over the
// BROWSER-level WebSocket (/json/version → webSocketDebuggerUrl), then Page.navigate on
// the new target's page WS (ws://…/devtools/page/<targetId> — constructible, no /json poll).
//
// Usage:
//   node cdp-open.mjs <url>              open <url> in a NEW tab → JSON {ok, targetId, url, title, navigated}
//   node cdp-open.mjs --list             list page targets (id · url · title)
//   node cdp-open.mjs --close <id>       close a tab (HTTP /json/close)
// Options: --timeout <ms> (load wait, default 15000), --host, --port.
import WebSocket from "ws";
import http from "node:http";

const args = process.argv.slice(2);
const flag = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const has = (name) => args.includes(name);
const HOST = flag("--host", "127.0.0.1");
const PORT = Number(flag("--port", 9222));
const LOAD_MS = Number(flag("--timeout", 15000));
// option VALUES must never leak into the positional URL (commit-review: with
// the old args.find(!startsWith("--")), `--host localhost --port 9222 https://…`
// picked "localhost" as the URL). Value-flags consume their next argument.
const VALUE_FLAGS = new Set(["--host", "--port", "--timeout", "--close"]);
const POSITIONAL = [];
for (let i = 0; i < args.length; i++) {
	if (VALUE_FLAGS.has(args[i])) { i++; continue; }
	if (args[i].startsWith("--")) continue; // value-less flags: --list
	POSITIONAL.push(args[i]);
}
const URL_ARG = POSITIONAL[0];

function httpJson(path, method = "GET") {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: HOST, port: PORT, path, method }, (res) => {
			let data = "";
			res.on("data", (c) => (data += c));
			res.on("end", () => {
				// /json/close answers plain text ("Target is closing"), the rest JSON
				try { resolve(JSON.parse(data)); } catch { resolve(data); }
			});
		});
		req.on("error", reject);
		req.end();
	});
}

// Minimal CDP connection: id-correlated pending map + per-send timeout (cdp.js pattern).
function connect(wsUrl) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
		const pending = new Map();
		let nextId = 0;
		ws.on("message", (raw) => {
			let m; try { m = JSON.parse(String(raw)); } catch { return; }
			if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
			if (m.method && events.has(m.method)) for (const cb of events.get(m.method)) cb(m.params);
		});
		const events = new Map();
		const client = {
			send(method, params = {}, timeoutMs = 10000) {
				return new Promise((res, rej) => {
					const id = ++nextId;
					const timer = setTimeout(() => { pending.delete(id); rej(new Error(`CDP timeout: ${method}`)); }, timeoutMs);
					pending.set(id, { res: (v) => { clearTimeout(timer); res(v); }, rej: (e) => { clearTimeout(timer); rej(e); } });
					ws.send(JSON.stringify({ id, method, params }));
				});
			},
			on(method, cb) { if (!events.has(method)) events.set(method, new Set()); events.get(method).add(cb); return () => events.get(method)?.delete(cb); },
			close: () => { try { ws.close(); } catch { /* noop */ } },
		};
		ws.on("open", () => resolve(client));
		ws.on("error", (e) => reject(new Error(`CDP ws error: ${e.message} — is the debugged browser running on :${PORT}?`)));
	});
}

async function openUrl(url) {
	let parsed;
	try { parsed = new URL(url); } catch { throw new Error(`invalid url: ${url}`); }
	if (!["http:", "https:"].includes(parsed.protocol)) throw new Error(`bad protocol: ${parsed.protocol} (http/https only)`);

	const version = await httpJson("/json/version");
	const browser = await connect(version.webSocketDebuggerUrl);
	let targetId;
	try {
		// createTarget with the REAL url first — on browsers where that works it is
		// one round trip; on Edge it lands about:blank (harmless) and we navigate below.
		const created = await browser.send("Target.createTarget", { url: parsed.toString() });
		targetId = created.targetId;

		const page = await connect(`ws://${HOST}:${PORT}/devtools/page/${targetId}`);
		let navigated = false;
		try {
			const loaded = new Promise((res) => page.on("Page.loadEventFired", res));
			await page.send("Page.enable");
			const cur = await page.send("Runtime.evaluate", { expression: "location.href", returnByValue: true });
			if ((cur?.result?.value || "") !== parsed.toString()) {
				await page.send("Page.navigate", { url: parsed.toString() });
				navigated = true;
			}
			await Promise.race([loaded, new Promise((_, rej) => setTimeout(() => rej(new Error("load timeout")), LOAD_MS))]);
		} catch (err) {
			if (String(err.message).includes("load timeout")) { /* still report the tab — it may be slow */ }
			else throw err;
		}
		let title = "";
		try { title = (await page.send("Runtime.evaluate", { expression: "document.title", returnByValue: true }))?.result?.value || ""; } catch { /* detached */ }
		page.close();
		return { ok: true, targetId, url: parsed.toString(), title, navigated };
	} finally {
		browser.close();
	}
}

try {
	if (has("--list")) {
		for (const t of await httpJson("/json")) {
			if (t.type === "page") console.log(`${t.id}  ${t.title || "(no title)"}  ${t.url}`);
		}
	} else if (has("--close")) {
		const id = flag("--close", "");
		await httpJson(`/json/close/${id}`);
		console.log(JSON.stringify({ ok: true, closed: id }));
	} else if (URL_ARG) {
		console.log(JSON.stringify(await openUrl(URL_ARG), null, 2));
	} else {
		console.error("usage: node cdp-open.mjs <url> | --list | --close <targetId>");
		process.exit(1);
	}
} catch (err) {
	console.error(JSON.stringify({ ok: false, error: err.message }));
	process.exit(1);
}
