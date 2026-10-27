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
	for (let i = 0; i < 40 && !frames.some((f) => f.type === "sessions"); i++) await sleep(100);
	await sleep(300);

	// 2) the FULL session body (what attach/open reads)
	const full = await json(`/api/agent/session/${SESSION}`);
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
	const rangeRes = await fetch(srv.url(rangePath), { headers: H });
	const rangeBuf = Buffer.from(await rangeRes.arrayBuffer());
	const isGzip = rangeBuf[0] === 0x1f && rangeBuf[1] === 0x8b;
	const body = isGzip ? zlib.gunzipSync(rangeBuf).toString("utf8") : rangeBuf.toString("utf8");
	check("E2 the /range NDJSON window carries NO inline base64 (the backfill leak is closed)",
		rangeRes.status === 200 && inlineBase64Runs(body, { minLength: 512 }).length === 0,
		`${(body.length / 1024).toFixed(1)}KB window${isGzip ? " (gzip " + (rangeBuf.length / 1024).toFixed(1) + "KB)" : ""}, longest run ${inlineBase64Runs(body, { minLength: 512 })[0] || 0}`);
	const rangeMsgs = body.split(String.fromCharCode(10)).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
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
} finally {
	await srv.stop();
}

console.log(`\n[media-egress e2e] ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
