// image-dims.mjs — the pixel size of an image from its HEADER alone (no decoder, no pixels).
//
// Why this exists (grok review 2026-10-28, I1): the composer has to know the dimensions to apply the
// resolution cap — but a 12MP photo must never be fully decoded on a phone just to learn that. The
// browser hands over the first ~64KB of the file and this reads the size out of the container.
//
// Pure and testable in Node. Returns `{ width, height, format }` or null when the header is not
// recognisable (an exotic/broken/truncated file): the caller then falls back to a capped decode.
//
// Orientation is deliberately ignored: EXIF rotation swaps the axes, and `max(width, height)` — the
// only thing the resolution cap looks at — is invariant under a swap.

/** PNG: 8-byte signature then IHDR (big-endian w/h at offset 16/20). */
function png(b, at) {
	if (b.length < at + 24 || b.readUInt32BE(at) !== 0x89504e47) return null;
	if (b.toString("ascii", at + 12, at + 16) !== "IHDR") return null;
	return { width: b.readUInt32BE(at + 16), height: b.readUInt32BE(at + 20), format: "png" };
}

/** GIF: logical screen descriptor, little-endian w/h at offset 6. */
function gif(b, at) {
	if (b.length < at + 10) return null;
	const sig = b.toString("ascii", at, at + 6);
	if (sig !== "GIF87a" && sig !== "GIF89a") return null;
	return { width: b.readUInt16LE(at + 6), height: b.readUInt16LE(at + 8), format: "gif" };
}

/** BMP: BITMAPINFOHEADER, signed 32-bit w/h at offset 18 (a negative height means top-down). */
function bmp(b, at) {
	if (b.length < at + 26 || b.toString("ascii", at, at + 2) !== "BM") return null;
	return { width: Math.abs(b.readInt32LE(at + 18)), height: Math.abs(b.readInt32LE(at + 22)), format: "bmp" };
}

/** WebP: VP8X (extended), VP8L (lossless) and VP8 (lossy) each store the size differently. */
function webp(b, at) {
	if (b.length < at + 30) return null;
	if (b.toString("ascii", at, at + 4) !== "RIFF" || b.toString("ascii", at + 8, at + 12) !== "WEBP") return null;
	const chunk = b.toString("ascii", at + 12, at + 16);
	if (chunk === "VP8X") {
		// 24-bit little-endian canvas size, MINUS ONE, at +24/+27
		return { width: 1 + b.readUIntLE(at + 24, 3), height: 1 + b.readUIntLE(at + 27, 3), format: "webp" };
	}
	if (chunk === "VP8L") {
		if (b[at + 20] !== 0x2f) return null;
		const bits = b.readUInt32LE(at + 21);
		return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff), format: "webp" };
	}
	if (chunk === "VP8 ") {
		// the key-frame header: 3 bytes of frame tag, the 3-byte start code, then 16-bit w/h (14 bits used)
		if (b.length < at + 30) return null;
		return { width: b.readUInt16LE(at + 26) & 0x3fff, height: b.readUInt16LE(at + 28) & 0x3fff, format: "webp" };
	}
	return null;
}

/** JPEG: walk the segment chain to the first SOFn (the frame header that carries the size). */
function jpeg(b, at) {
	if (b.length < at + 4 || b[at] !== 0xff || b[at + 1] !== 0xd8) return null;
	let p = at + 2;
	while (p + 3 < b.length) {
		if (b[p] !== 0xff) { p++; continue; } // resync on padding
		const marker = b[p + 1];
		if (marker === 0xff) { p++; continue; } // fill byte
		// standalone markers (no length): SOI, EOI, RSTn, TEM
		if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { p += 2; continue; }
		const len = b.readUInt16BE(p + 2);
		if (len < 2) return null;
		// SOF0..SOF15 minus the non-frame markers (DHT 0xc4, JPG 0xc8, DAC 0xcc)
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
			if (p + 9 > b.length) return null;
			return { width: b.readUInt16BE(p + 7), height: b.readUInt16BE(p + 5), format: "jpeg", progressive: marker === 0xc2 };
		}
		p += 2 + len;
	}
	return null;
}

/**
 * Read `{ width, height, format }` out of an image header, or null.
 * Accepts a Buffer/Uint8Array (the caller usually passes `file.slice(0, 64 * 1024)`).
 */
export function imageDims(bytes) {
	const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
	if (b.length < 12) return null;
	return png(b, 0) || jpeg(b, 0) || gif(b, 0) || webp(b, 0) || bmp(b, 0) || null;
}
