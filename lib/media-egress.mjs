// lib/media-egress.mjs — SERVER-SIDE media: the image store, egress redaction, and the model-side
// hydration that produces base64 exactly once, at the provider call.
//
// THE MODEL (user design, 2026-10-25):
//   * the browser ENCODES the image (resize + webp/jpeg) — that is the only compression that happens;
//   * the server stores those bytes as **binary**, content-addressed by sha256. Never the raw
//     original, never base64 (base64 is 33% bigger and buys nothing);
//   * base64 is produced only when the LLM request is built (`hydrateImageData`), and it is transient;
//   * NO secondary compression: gz/br on an encoded image was MEASURED at ~0% — webp/jpeg/PNG are
//     already entropy-/deflate-coded (tests/image-compression.test.mjs keeps the numbers). The only
//     thing gz/br ever paid for was base64, i.e. exactly the inflation that storing binary removes.
//
// RETENTION (user decision: server by default, selectable per device):
//   `dir` set  → disk-backed (`<dir>/<hash[0..1]>/<hash>`): survives a restart, serves any device, and
//                is what lets a retry/fork/re-run still reach the bytes.
//   `persist: false` per image (or no `dir`) → memory only: the server can still feed the model while
//                it runs, and afterwards the client — which holds its own copy in IDB — re-uploads.
//
// The transcript keeps `{type:"image", mimeType, hash, bytes}` and the bytes stay in the store, so an
// attach/`/range`/history frame costs hashes instead of megabytes. Everything here is pure with
// respect to the SESSION FILE: inputs are never mutated, and a no-change case returns the ORIGINAL
// reference (so "no images" costs nothing and never invalidates a client cache).

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isMediaHash } from "./data-reduction.mjs";

/** sha256 of raw bytes, hex — the content address. */
export function hashOf(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

/** sha256 of a base64 payload without keeping the decoded copy around longer than needed. */
export function hashOfBase64(base64) {
	return hashOf(Buffer.from(String(base64 || ""), "base64"));
}

/**
 * The mime type of an encoded image, from its magic bytes. Needed because the store is
 * content-addressed by BYTES only: after a restart (or for a lookup with no transcript part at hand)
 * the Content-Type would otherwise be `application/octet-stream`, and a browser will not render that
 * as an <img>. Covers exactly the formats the composer can produce.
 */
export function sniffImageMime(bytes) {
	const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
	if (b.length < 12) return "application/octet-stream";
	if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
	if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
	if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
	if (b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "image/webp";
	if (b[0] === 0x42 && b[1] === 0x4d) return "image/bmp";
	if (b.toString("ascii", 4, 12).startsWith("ftyp")) return "image/avif";
	return "application/octet-stream";
}

/**
 * The media store (see the file header for the two retention modes). Content-addressed, so putting
 * the same image twice is a no-op and two different mimeTypes over identical bytes dedupe to one blob.
 */
export function createMediaStore({ maxBytes = 64 * 1024 * 1024, dir = null } = {}) {
	const map = new Map(); // hash → { hash, bytes, mimeType, size, persisted }  (Map order = LRU order)
	let total = 0;

	const touch = (hash, entry) => { map.delete(hash); map.set(hash, entry); return entry; };
	const evict = () => {
		while (total > maxBytes && map.size > 1) {
			const oldest = map.keys().next().value;
			total -= map.get(oldest).size;
			map.delete(oldest);
		}
	};
	const fileFor = (hash) => (dir ? path.join(dir, hash.slice(0, 2), hash) : null);

	return {
		dir,
		/**
		 * Store (or re-find) the bytes under their hash. `persist: false` = memory only (the
		 * "browser keeps its images" retention mode, per image).
		 */
		put(hash, bytes, mimeType = null, { persist = true } = {}) {
			const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
			if (!buf.length) return null;
			const existing = map.get(hash);
			if (existing) return touch(hash, existing);
			const entry = { hash, bytes: buf, mimeType: mimeType || sniffImageMime(buf), size: buf.length, persisted: !!(dir && persist) };
			if (dir && persist) {
				try {
					fs.mkdirSync(path.dirname(fileFor(hash)), { recursive: true });
					fs.writeFileSync(fileFor(hash), buf);
				} catch { /* a read-only data dir must not break a run: memory still serves it */ }
			}
			map.set(hash, entry);
			total += entry.size;
			evict();
			return entry;
		},
		/** The raw bytes: memory first, then disk. */
		get(hash) {
			const hit = map.get(hash);
			if (hit) return touch(hash, hit);
			if (!dir || !isMediaHash(hash)) return null;
			try { return this.put(hash, fs.readFileSync(fileFor(hash))); } catch { return null; }
		},
		has(hash) { return map.has(hash) || !!(dir && isMediaHash(hash) && fs.existsSync(fileFor(hash))); },
		stats() { return { count: map.size, bytes: total, maxBytes, dir, onDisk: dir ? fs.existsSync(dir) : false }; },
		clear() { map.clear(); total = 0; },
	};
}

/**
 * Replace inline base64 with hash + size on an EGRESS copy of `messages`.
 *   messages: the transcript (never mutated)
 *   store:    a createMediaStore() instance (the caller owns it; the bytes end up there)
 * → { messages, media: [{hash, bytes, mimeType}], changed }
 * Identical images dedupe to one entry because the address IS the content, and a part that already
 * carries a valid hash is passed through untouched (double redaction cannot lose the bytes).
 */
export function redactImageData(messages, { store } = {}) {
	if (!Array.isArray(messages)) return { messages, media: [], changed: false };
	const media = new Map(); // hash → { hash, bytes, mimeType }
	let changed = false;

	const out = messages.map((m) => {
		if (!Array.isArray(m?.content)) return m;
		let msgChanged = false;
		const content = m.content.map((part) => {
			if (part?.type !== "image") return part;
			if (isMediaHash(part.hash) && part.data === undefined) return part; // already redacted
			if (typeof part.data !== "string" || !part.data) return part;        // hash-only or empty
			const bytes = Buffer.from(part.data, "base64");
			if (!bytes.length) return part;
			const hash = hashOf(bytes);
			const mimeType = part.mimeType || "application/octet-stream";
			store?.put(hash, bytes, mimeType);
			if (!media.has(hash)) media.set(hash, { hash, bytes: bytes.length, mimeType });
			msgChanged = true;
			return { type: "image", mimeType, hash, bytes: bytes.length };
		});
		if (!msgChanged) return m;
		changed = true;
		return { ...m, content };
	});

	return { messages: changed ? out : messages, media: [...media.values()], changed };
}

/**
 * The MODEL path: restore `{ type:"image", data, mimeType }` from hashes. base64 exists only here.
 * lookup: a createMediaStore() instance, a Map, or a (hash) => { bytes, mimeType } | null function.
 * Redaction-only fields are dropped so hydrate(redact(x)) round-trips to the original ImageContent.
 * A MISS leaves the hash in place (never a half-image): callers that must not send a data-less image
 * part should check for it — see `missingImageHashes()`.
 */
export function hydrateImageData(messages, lookup) {
	if (!Array.isArray(messages)) return messages;
	const resolve = typeof lookup === "function" ? lookup
		: typeof lookup?.get === "function" ? (h) => lookup.get(h)
		: () => null;
	return messages.map((m) => {
		if (!Array.isArray(m?.content)) return m;
		let changed = false;
		const content = m.content.map((part) => {
			if (part?.type !== "image") return part;
			if (typeof part.data === "string" && part.data) {
				if (part.hash === undefined && part.bytes === undefined) return part;
				changed = true;
				const { hash, bytes, ...rest } = part; // drop redaction-only fields
				return rest;
			}
			if (!isMediaHash(part.hash)) return part;
			const hit = resolve(part.hash);
			if (!hit?.bytes) return part; // miss: leave the hash (the UI can still fetch it)
			changed = true;
			// the PART's mimeType wins: identical payloads dedupe to one entry, so the store's
			// mimeType is only the first writer's guess.
			return { type: "image", mimeType: part.mimeType || hit.mimeType || "application/octet-stream", data: Buffer.from(hit.bytes).toString("base64") };
		});
		return changed ? { ...m, content } : m;
	});
}

/** Image hashes still lacking bytes — the caller must warn instead of sending a broken part. */
export function missingImageHashes(messages) {
	const missing = [];
	for (const m of Array.isArray(messages) ? messages : []) {
		if (!Array.isArray(m?.content)) continue;
		for (const part of m.content) {
			if (part?.type === "image" && isMediaHash(part.hash) && typeof part.data !== "string") missing.push(part.hash);
		}
	}
	return missing;
}

/**
 * EGRESS INVARIANT GUARD (plan §6): every long base64 run still present in a payload.
 * Run it over an attach envelope / range body in tests (and optionally in dev on every egress
 * serialization): anything returned here is transfer that redaction missed.
 */
export function inlineBase64Runs(value, { minLength = 512 } = {}) {
	const found = [];
	const text = typeof value === "string" ? value : JSON.stringify(value ?? null) || "";
	const re = new RegExp(`[A-Za-z0-9+/]{${minLength},}={0,2}`, "g");
	let m;
	while ((m = re.exec(text))) found.push(m[0].length);
	return found;
}
