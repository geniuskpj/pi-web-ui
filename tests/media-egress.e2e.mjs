// media-egress.e2e.mjs — the END-TO-END proof of the image pipeline (review report.md H1 + M4,
// 2026-10-27): every egress path that carries a transcript must ship HASHES, not inline base64, and
// the bytes behind those hashes must be fetchable from the binary media route.
//
// The review's finding was that `/range` (the BACKFILL path a warm client uses to fill its prefix and
// write IndexedDB) still shipped the full inline base64 — so the "warm reopen ≈ 0 bytes" headline was
// an attach-only number. This suite seeds a real session through the sync API, then reads every egress
// path back over HTTP and asserts the invariant with the same guard the code uses
// (`inlineBase64Runs`): attach-equivalent full GET, ?meta=1, the NDJSON range window, and the media
// route itself.
//
// Usage: node tests/media-egress.e2e.mjs
import WebSocket from "ws";
import fs from "node:fs";
import path from "node:path";
import { startScratchServer } from "./_scratch-server.mjs";
import { isMediaHash } from "../lib/data-reduction.mjs";
import zlib from "node:zlib";
import { inlineBase64Runs } from "../lib/media-egress.mjs";

let passed = 0, failed = 0;
const check = (name, ok, extra = "") => {
	if (ok) { passed++; console.log(`  ✓ ${name}${extra ? " — " + extra : ""}`); }
	else { failed++; console.error(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A photo-shaped payload: 400KB of high-entropy bytes, base64 in the message (the legacy shape). */
const photo = (fill = 0x5a, kb = 400) => {
	const buf = Buffer.alloc(kb * 1024, fill);
	let s = 0x1f2e3d;
	for (let i = 0; i < buf.length; i += 977) { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0; buf[i] = s & 0xff; }
	return buf;
};
const bigBase64 = photo().toString("base64");
const SESSION = "mediaegress0000000000000000001";
const MESSAGES = [
	{ role: "user", content: [{ type: "text", text: "here is the whiteboard photo" }, { type: "image", mimeType: "image/png", data: bigBase64 }], timestamp: 1700000000000 },
	...Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `turn ${i} ` + "lorem ipsum dolor sit amet ".repeat(30), timestamp: 1700000001000 + i })),
];

/**
 * Wait for the STORE to actually answer — by CONTENT, never by status. `GET /api/agent/session/:id`
 * answers 200 with `exists:false` for a session the worker has not written yet (and `/range` answers 200
 * with a lone metadata line), so a status check passes instantly and every later assertion reads an empty
 * session. That is exactly how this suite passed locally and failed in CI (2026-11-01): the seed wait was
 * "any `sessions` frame", which /ws/sync pushes on connect, before the server processes the put.
 */
const waitFor = async (fn, { tries = 100, step = 100, what = "content" } = {}) => {
	let last = null;
	for (let i = 0; i < tries; i++) {
		last = await fn();
		if (last?.ok) return last;
		await sleep(step);
	}
	console.error(`  ! readiness timeout waiting for ${what} after ${tries * step}ms`);
	return last;
};

const srv = await startScratchServer();
const H = { "x-pi-web-token": srv.token };
const json = async (path, init = {}) => {
	const r = await fetch(srv.url(path), { headers: H, ...init });
	const text = await r.text();
	let body = null;
	try { body = JSON.parse(text); } catch { /* ndjson */ }
	return { status: r.status, body, text, headers: r.headers };
};

try {
	// 1) seed a session with an INLINE base64 image through the real sync API
	const sync = new WebSocket(`ws://127.0.0.1:${srv.port}/ws/sync?token=${encodeURIComponent(srv.token)}`);
	const frames = [];
	sync.on("message", (raw) => { try { frames.push(JSON.parse(raw.toString())); } catch { /* ignore */ } });
	await new Promise((res, rej) => { sync.on("open", res); sync.on("error", rej); });
	sync.send(JSON.stringify({
		type: "put", id: SESSION,
		jsonl: [JSON.stringify({ id: SESSION, modelId: "faux-1", thinkingLevel: "high", title: "photo session", messageCount: MESSAGES.length }), ...MESSAGES.map((m) => JSON.stringify(m))].join("\n"),
	}));
	// READINESS BY CONTENT, NOT BY FRAME TYPE (CI failure 2026-11-01). This used to wait for ANY `sessions`
	// frame — but /ws/sync pushes the list ON CONNECT, before the server has processed our `put`, so a slow
	// runner (CI: Node 22/24, two matrix jobs) satisfied the condition immediately and every later read hit
	// a session that did not exist yet: the body came back empty (0.0KB) and the egress checks failed while
	// passing on a fast local machine. Poll the READ the checks actually use.
	const seeded = await waitFor(async () => {
		const r = await json(`/api/agent/session/${SESSION}`);
		return { ok: r.body?.exists === true && (r.body?.messages?.length || 0) >= MESSAGES.length, r };
	}, { what: `session ${SESSION} with ${MESSAGES.length} messages` });
	const full = seeded?.r;
	check("E0 the seeded session is READABLE with its content before the egress checks",
		seeded?.ok === true, `exists=${full?.body?.exists} messages=${full?.body?.messages?.length} status=${full?.status}`);
	void frames;

	// 2) the FULL session body (what attach/open reads)
	check("E1 the full-session body has no inline image base64 at all",
		full.status === 200 && inlineBase64Runs(full.text, { minLength: 512 }).length === 0,
		`${(full.text.length / 1024).toFixed(1)}KB body, longest base64 run ${inlineBase64Runs(full.text, { minLength: 512 })[0] || 0}`);
	const findImage = (messages) => (Array.isArray(messages) ? messages : [])
		.map((m) => (Array.isArray(m?.content) ? m.content : [])).flat().find((p) => p?.type === "image");
	const imgPart = findImage(full.body?.messages);
	check("E1b the image part is a hash reference with a byte count",
		!!imgPart && isMediaHash(imgPart.hash) && imgPart.bytes > 100 * 1024 && imgPart.data === undefined,
		JSON.stringify({ hash: imgPart?.hash?.slice(0, 10), bytes: imgPart?.bytes }));

	// 3) THE BACKFILL PATH (the review's H1): the NDJSON range window. NOTE: this route deliberately
	// ships RAW gzip bytes (the client stores them in IDB and gunzips in JS), so we gunzip here.
	const rangePath = `/api/agent/session/${SESSION}/range?fromSeq=0&toSeq=${MESSAGES.length + 1}`;
	// the window is read by CONTENT too: for a session the worker has not written yet, /range answers 200
	// with a single metadata line (the CI log's "lines=1"), which is not an empty-page failure but a race
	const readRange = () => waitFor(async () => {
		const res = await fetch(srv.url(rangePath), { headers: H });
		const buf = Buffer.from(await res.arrayBuffer());
		const gz = buf[0] === 0x1f && buf[1] === 0x8b;
		const text = gz ? zlib.gunzipSync(buf).toString("utf8") : buf.toString("utf8");
		const msgs = text.split(String.fromCharCode(10)).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
		return { ok: msgs.length > 1 && msgs.some((m) => Array.isArray(m?.content) && m.content.some((p) => p?.type === "image")), res, buf, text, msgs, gz };
	}, { what: "the /range window with its image part" });
	const ranged = await readRange();
	const rangeRes = ranged?.res, rangeBuf = ranged?.buf;
	const isGzip = ranged?.gz;
	const body = ranged?.text;
	check("E2 the /range NDJSON window carries NO inline base64 (the backfill leak is closed)",
		rangeRes?.status === 200 && inlineBase64Runs(body || "", { minLength: 512 }).length === 0,
		`${((body || "").length / 1024).toFixed(1)}KB window${isGzip ? " (gzip " + (rangeBuf.length / 1024).toFixed(1) + "KB)" : ""}, longest run ${inlineBase64Runs(body || "", { minLength: 512 })[0] || 0}`);
	const rangeMsgs = ranged?.msgs || [];
	const rangeImg = findImage(rangeMsgs);
	check("E2b …and its image part resolves by hash, so the client can write it to IDB and render later",
		isMediaHash(rangeImg?.hash) && rangeImg.bytes > 100 * 1024,
		`lines=${rangeMsgs.length} roles=${rangeMsgs.map((m) => m.role).join(",")} hash=${rangeImg?.hash?.slice(0, 10)} bytes=${rangeImg?.bytes}`);

	// 4) the bytes are actually THERE — fetched by the hash the egress just handed out
	const media = await fetch(srv.url(`/api/agent/session/${SESSION}/media/${rangeImg.hash}`), { headers: H });
	const bytes = Buffer.from(await media.arrayBuffer());
	check("E3 the media route serves the exact bytes behind that hash (one fetch per device, then cached)",
		media.status === 200 && bytes.equals(photo()) && media.headers.get("cache-control")?.includes("immutable"),
		`${bytes.length} bytes, content-type ${media.headers.get("content-type")}`);
	check("E3b no Content-Encoding on image bytes (gz/br measured at ~0%)", media.headers.get("content-encoding") === null);

	// 5) metadata-only and bad-hash routes stay honest
	const meta = await json(`/api/agent/session/${SESSION}?meta=1`);
	check("E4 ?meta=1 ships counts only (no messages, no bytes)",
		meta.status === 200 && typeof meta.body?.messageCount === "number" && meta.body.messageCount >= MESSAGES.length && meta.body.messages === undefined,
		JSON.stringify(meta.body));
	check("E5 a malformed hash is refused (400) and an unknown one 404s",
		(await json(`/api/agent/session/${SESSION}/media/not-a-hash`)).status === 400 &&
		(await json(`/api/agent/session/${SESSION}/media/${"a".repeat(64)}`)).status === 404);

	// 6) binary upload round-trip (what the composer will use)
	const up = await fetch(srv.url(`/api/agent/session/${SESSION}/media`), { method: "POST", headers: { ...H, "Content-Type": "image/webp" }, body: photo(0x11, 40) });
	const uploaded = await up.json();
	check("E6 a binary upload is stored, addressed and reported (no base64 anywhere in the exchange)",
		up.status === 200 && isMediaHash(uploaded.hash) && uploaded.bytes === 40 * 1024 && uploaded.persisted === true);
	const back = await fetch(srv.url(`/api/agent/session/${SESSION}/media/${uploaded.hash}`), { headers: H });
	check("E6b …and reads back byte-identical", Buffer.from(await back.arrayBuffer()).equals(photo(0x11, 40)));
	const browserMode = await fetch(srv.url(`/api/agent/session/${SESSION}/media`), { method: "POST", headers: { ...H, "Content-Type": "image/webp", "x-pi-media-retention": "browser" }, body: photo(0x22, 40) });
	const memOnly = await browserMode.json();
	check("E6c retention 'browser' keeps the blob in memory only (persisted:false)",
		memOnly.persisted === false && (await json(`/api/agent/session/${SESSION}/media/${memOnly.hash}`)).status === 200);

	sync.close();

	// 7) RETENTION MUST BE IN FORCE BEFORE THE FIRST SNAPSHOT (grok pre-restart review 2026-10-31).
	// The client's settings frame arrives only AFTER `state`, so an attach without the retention would
	// redact (and therefore WRITE) an inline image to disk before a "browser" device could be heard.
	// The client now sends it in the attach frame; this drives that exact sequence over a real socket.
	const SESSION2 = "mediaegress0000000000000000002";
	const sync2 = new WebSocket(`ws://127.0.0.1:${srv.port}/ws/sync?token=${encodeURIComponent(srv.token)}`);
	await new Promise((res, rej) => { sync2.on("open", res); sync2.on("error", rej); });
	sync2.send(JSON.stringify({
		type: "put", id: SESSION2,
		jsonl: [JSON.stringify({ id: SESSION2, modelId: "faux-1", thinkingLevel: "high", title: "browser retention", messageCount: 2 }),
			JSON.stringify({ role: "user", content: [{ type: "text", text: "photo" }, { type: "image", mimeType: "image/png", data: bigBase64 }], timestamp: 1700000000000 }),
			JSON.stringify({ role: "assistant", content: "ok", timestamp: 1700000001000 })].join("\n"),
	}));
	// the same content-based readiness as the main seed (fixed sleeps are what made this suite CI-flaky)
	const seeded2 = await waitFor(async () => {
		const r = await json(`/api/agent/session/${SESSION2}`);
		return { ok: r.body?.exists === true, r };
	}, { what: `session ${SESSION2}` });
	check("E7-pre the second seeded session is readable (with content) before the attach",
		seeded2?.ok === true, `exists=${seeded2?.r?.body?.exists} status=${seeded2?.r?.status}`);
	const mediaDir = path.join(srv.dataDir, "media");
	const mediaFiles = () => { try { return fs.readdirSync(mediaDir).flatMap((d) => { try { return fs.readdirSync(path.join(mediaDir, d)).map((f) => `${d}/${f}`); } catch { return []; } }); } catch { return []; } };
	const before = mediaFiles().length;
	const ws2 = new WebSocket(`ws://127.0.0.1:${srv.port}/ws/agent?token=${encodeURIComponent(srv.token)}`);
	const frames2 = [];
	ws2.on("message", (raw) => { try { frames2.push(JSON.parse(raw.toString())); } catch { /* ignore */ } });
	await new Promise((res, rej) => { ws2.on("open", res); ws2.on("error", rej); });
	// the browser-retention device attaches: its choice rides the attach frame itself
	ws2.send(JSON.stringify({ type: "attach", sessionId: SESSION2, tailFirst: false, imageRetention: "browser" }));
	for (let i = 0; i < 40 && !frames2.some((f) => f.type === "state"); i++) await sleep(100);
	await sleep(300);
	// the WS ATTACH snapshot is an egress path too — it used to bypass redaction entirely (found by this
	// check, 2026-10-31): image base64 travelled back to every device on attach and into its IDB cache
	check("E7 the WS attach snapshot is REDACTED (hashes, no inline base64 — the leak this check found)",
		frames2.some((f) => f.type === "state") &&
		frames2.every((f) => inlineBase64Runs(JSON.stringify(f), { minLength: 512 }).length === 0),
		`frames=${JSON.stringify(frames2.map((f) => f.type))}`);
	check("E7b …and NO media blob was written for that session (the vote was applied BEFORE redaction)",
		mediaFiles().length === before, `${before} → ${mediaFiles().length} files in data/media`);
	const served = frames2.find((f) => f.type === "state")?.messages?.flatMap?.((m) => (Array.isArray(m?.content) ? m.content : []))?.find?.((p) => p?.type === "image");
	check("E7c …while the bytes are still reachable for this process (memory-only, served by /media)",
		!!served?.hash && (await json(`/api/agent/session/${SESSION2}/media/${served.hash}`)).status === 200,
		`hash=${String(served?.hash).slice(0, 8)}`);
	ws2.close();
	sync2.close();
} finally {
	await srv.stop();
}

console.log(`\n[media-egress e2e] ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
