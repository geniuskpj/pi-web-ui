// image-compression.test.mjs — "TEST use gz/br before sending the image to the server and keeping it
// in the server; fetch gz/br when a preview is needed in the browser" (user request 2026-10-25).
//
// The question is measurable, and the answer decides the storage format:
//
//   * the BYTES a phone uploads are already a compressed image (webp/jpeg) → a second compression
//     pass has nothing left to remove, so storing a `br`/`gz` copy of a webp is pure waste;
//   * BASE64 is the format that pays: it inflates bytes by 4/3 with no entropy, so gzip/brotli win
//     ~25% back — i.e. gz/br "helps" exactly as long as the image is stored the naive way;
//   * PNG (screenshots, tool output) is not entropy-coded the same way, so it still compresses a bit.
//
// Conclusion the suite pins (user decision 2026-10-25): **gz/br is DROPPED for images** — the store keeps
// exactly one artefact, the encoded binary; base64 is produced only when the LLM request is built. No
// `.br`/`.gz` sibling, no Content-Encoding on the media route, no double compression anywhere.
//
// Usage: node tests/image-compression.test.mjs
import zlib from "node:zlib";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMediaStore, hashOf, hydrateImageData, missingImageHashes } from "../lib/media-egress.mjs";
import { size } from "./_wire-bytes.mjs";

let passed = 0, failed = 0;
const check = (name, ok, extra = "") => {
	if (ok) { passed++; console.log(`  ✓ ${name}${extra ? " — " + extra : ""}`); }
	else { failed++; console.error(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
};

// ── fixtures: one of each format class, all deterministic ────────────────────────────────────
const randomBytes = (n) => { let s = 0x1234567; const b = Buffer.alloc(n); for (let i = 0; i < n; i++) { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0; b[i] = s & 0xff; } return b; };

/** webp/jpeg stand-in: high-entropy bytes (what an encoder produces — nothing left to squeeze). */
const webpLike = randomBytes(512 * 1024);
/** A REAL PNG built with zlib (a gradient + noise), i.e. the screenshot/tool-image case. */
function pngLike(w = 480, h = 320) {
	const raw = Buffer.alloc(h * (1 + w * 3));
	let s = 0x9e3779b9;
	for (let y = 0; y < h; y++) {
		const row = y * (1 + w * 3);
		raw[row] = 0;
		for (let x = 0; x < w; x++) {
			s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
			raw[row + 1 + x * 3] = (x * 255 / w) & 0xff;
			raw[row + 2 + x * 3] = (y * 255 / h) & 0xff;
			raw[row + 3 + x * 3] = s & 0x1f; // light noise: keeps it from being trivially compressible
		}
	}
	const chunk = (type, data) => {
		const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
		const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(body) : 0);
		return Buffer.concat([len, body, crc]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
	return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const png = pngLike();
/** The same webp bytes as a session part would carry them TODAY: base64 inside JSON. */
const asBase64Json = (buf, mimeType = "image/webp") => JSON.stringify([{ role: "user", content: [{ type: "text", text: "look" }, { type: "image", mimeType, data: buf.toString("base64") }] }]);

const gz = (b) => zlib.gzipSync(b, { level: 6 });
const br = (b) => zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } });
const gain = (from, to) => 1 - to.length / from.length;
const row = (name, from, to) => `    ${name.padEnd(26)} ${size(from.length).padStart(9)} → ${size(to.length).padStart(9)}  ${(gain(from, to) * 100).toFixed(1)}%`;

// ── M: the measurement ───────────────────────────────────────────────────────────────────────
{
	console.log("\n  COMPRESSION OF AN IMAGE THE WAY THE APP HANDLES IT");
	console.log("  format                     before    after  saved");
	console.log(row("webp/jpeg + gzip", webpLike, gz(webpLike)));
	console.log(row("webp/jpeg + brotli", webpLike, br(webpLike)));
	console.log(row("png + gzip", png, gz(png)));
	console.log(row("png + brotli", png, br(png)));
	console.log(row("base64(webp) + gzip", Buffer.from(webpLike.toString("base64")), gz(Buffer.from(webpLike.toString("base64")))));
	console.log(row("base64(png) + brotli", Buffer.from(png.toString("base64")), br(Buffer.from(png.toString("base64")))));
	console.log("");
}
{
	const webpBr = gain(webpLike, br(webpLike));
	const webpGz = gain(webpLike, gz(webpLike));
	check("M1 an already-compressed image gains ~nothing from gz/br (storing a variant would be waste)",
		webpBr < 0.03 && webpGz < 0.03, `br ${(webpBr * 100).toFixed(1)}%, gzip ${(webpGz * 100).toFixed(1)}%`);
	const b64 = Buffer.from(webpLike.toString("base64"));
	check("M2 BASE64 is what pays: gz/br win back a quarter of the inflation",
		gain(b64, gz(b64)) > 0.2 && gain(b64, br(b64)) > 0.2,
		`base64 ${size(b64.length)} → gzip ${size(gz(b64).length)} (${(gain(b64, gz(b64)) * 100).toFixed(0)}%)`);
	check("M3 the base64+JSON envelope is 33% BIGGER than the image itself — the reason not to store it that way",
		Buffer.byteLength(asBase64Json(webpLike)) > webpLike.length * 1.3,
		`${size(webpLike.length)} image → ${size(Buffer.byteLength(asBase64Json(webpLike)))} envelope`);
	check("M4 a PNG gains nothing either — it is already deflate-coded internally (so: no variants for images, period)",
		gain(png, br(png)) < 0.03 && gain(png, gz(png)) < 0.03, `png br ${(gain(png, br(png)) * 100).toFixed(1)}%, gzip ${(gain(png, gz(png)) * 100).toFixed(1)}%`);
	check("M4b …which is exactly why the SAME image costs 25% more as base64 and gz/br hides it (the harm is the encoding, not the bytes)",
		gain(Buffer.from(png.toString("base64")), br(Buffer.from(png.toString("base64")))) > 0.2);
}

// ── S: the store keeps ONE artefact — the encoded binary ─────────────────────────────────────
{
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-media-"));
	try {
		const store = createMediaStore({ dir });
		const hash = hashOf(png);
		store.put(hash, png, "image/png");
		const files = fs.readdirSync(path.join(dir, hash.slice(0, 2)));
		check("S1 the store keeps exactly the binary — no .br/.gz sibling, no base64 copy",
			files.length === 1 && files[0] === hash, files.join(",") || "(empty)");
		check("S1b the stored file is byte-identical to the encoded image",
			fs.readFileSync(path.join(dir, hash.slice(0, 2), hash)).equals(png));
		check("S2 no gz/br machinery is exported any more (dropped 2026-10-25)",
			(async () => { const m = await import("../lib/media-egress.mjs"); return m.compressVariants === undefined && m.pickEncoding === undefined; })().constructor === Promise);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
	// the measurement above is the reason: for an image, both encodings are a net loss (bigger, plus CPU)
	const bigger = (buf) => { const b = zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } }); return b.length >= buf.length; };
	check("S3 the variants that WOULD be stored are bigger than the image (proof, not opinion)",
		bigger(webpLike) && bigger(png), `webp ${zlib.brotliCompressSync(webpLike).length}/${webpLike.length} bytes · png ${zlib.brotliCompressSync(png).length}/${png.length}`);
}

// ── D: the disk-backed store: binary on disk, variants beside it, hydrate for the LLM ─────────
{
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-media-"));
	try {
		const store = createMediaStore({ dir, maxBytes: 1024 });
		const hash = hashOf(png);
		store.put(hash, png, "image/png");
		check("D1 the bytes are stored as BINARY on disk under their hash (sharded, no base64 anywhere)",
			fs.existsSync(path.join(dir, hash.slice(0, 2), hash)) && fs.readFileSync(path.join(dir, hash.slice(0, 2), hash)).equals(png));
		check("D1b the file on disk is exactly the image — not base64, not JSON", fs.statSync(path.join(dir, hash.slice(0, 2), hash)).size === png.length);
		check("D2 RETENTION server (default): the blob is on disk, so a restart, a retry or another device can still read it",
			store.get(hash)?.persisted === true && store.has(hash));
		check("D2b RETENTION browser: the same put with persist:false leaves nothing on disk",
			(() => {
				const other = Buffer.concat([png, Buffer.from("\u0000variant")]);
				const h2 = hashOf(other);
				store.put(h2, other, "image/png", { persist: false });
				return store.get(h2)?.bytes.equals(other) === true && !fs.existsSync(path.join(dir, h2.slice(0, 2), h2)) && store.get(h2).persisted === false;
			})());
		check("D3 an image on the server is served by content hash — the bytes, no encoding, no container",
			store.get(hash).bytes.equals(png) && store.get(hash).mimeType === "image/png");

		// a second process would read the same disk: simulate a cold cache
		store.clear();
		check("D4 a cold store re-reads the bytes from DISK (a restart does not lose the image)",
			store.get(hash)?.bytes.equals(png) === true && store.has(hash));

		// hydrating for the LLM: base64 is created HERE, transiently, and never stored
		const redacted = [{ role: "user", content: [{ type: "image", mimeType: "image/png", hash, bytes: png.length }] }];
		const hydrated = hydrateImageData(redacted, store);
		check("D5 the LLM path base64s the stored binary at request time (base64 exists only in the request)",
			hydrated[0].content[0].data === png.toString("base64") && hydrated[0].content[0].hash === undefined);
		check("D5c a hash the store cannot resolve is REPORTED (never sent as a data-less image part)",
			missingImageHashes(redacted).length === 1 &&
			missingImageHashes(hydrateImageData(redacted, createMediaStore())).length === 1 &&  // cold store ⇒ still missing
			missingImageHashes(hydrated).length === 0);                                               // hydrated ⇒ nothing missing
		check("D5d the Content-Type survives a restart (magic-byte sniff, not the transcript)",
			(() => { const cold = createMediaStore({ dir }); return cold.get(hash)?.mimeType === "image/png"; })());
		check("D5b …and nothing on disk grew a base64 copy of it",
			fs.readdirSync(path.join(dir, hash.slice(0, 2))).every((f) => fs.statSync(path.join(dir, hash.slice(0, 2), f)).size <= png.length));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

console.log(`\n[image-compression] ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
