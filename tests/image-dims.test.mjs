// image-dims.test.mjs — the header-only size probe (grok review 2026-10-28, I1).
//
// Why it matters: the composer must apply the RESOLUTION cap before deciding whether to decode, and a
// phone must not decode a 12MP photo just to learn its size. The pure layer decides on
// {mimeType, bytes, width, height} — so these numbers have to be right, or the cap silently drifts.
//
// Every fixture is a REAL header built byte by byte (no images checked into the repo).
// Usage: node tests/image-dims.test.mjs
import { imageDims } from "../lib/image-dims.mjs";
import { planImageTransform, resolveDataReduction } from "../lib/data-reduction.mjs";

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
	if (cond) { pass++; console.log(`  ✓ ${name}`); }
	else { fail++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};

// ── PNG: signature + IHDR ────────────────────────────────────────────────────
const png = (w, h) => {
	const b = Buffer.alloc(33);
	b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(0x0d0a1a0a, 4);
	b.writeUInt32BE(13, 8); b.write("IHDR", 12);
	b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
	b[24] = 8; b[25] = 6; // bit depth, colour type
	return b;
};
const p = imageDims(png(4032, 3024));
check("P1 PNG IHDR gives the exact size", p?.width === 4032 && p?.height === 3024 && p?.format === "png", JSON.stringify(p));

// ── GIF: logical screen descriptor (little-endian) ───────────────────────────
const gif = (w, h) => {
	const b = Buffer.alloc(13);
	b.write("GIF89a", 0); b.writeUInt16LE(w, 6); b.writeUInt16LE(h, 8);
	return b;
};
const g = imageDims(gif(320, 240));
check("G2 GIF screen descriptor", g?.width === 320 && g?.height === 240 && g?.format === "gif", JSON.stringify(g));

// ── JPEG: SOI, an APP1/EXIF block, then SOF0 ─────────────────────────────────
const jpeg = (w, h, { exifBytes = 200, progressive = false } = {}) => {
	const head = Buffer.alloc(4 + (2 + 2 + exifBytes) + 2 + 2 + 6);
	head[0] = 0xff; head[1] = 0xd8;                                    // SOI
	let p = 2;
	head[p] = 0xff; head[p + 1] = 0xe1;                                // APP1 (EXIF lives here)
	head.writeUInt16BE(exifBytes + 2, p + 2);
	p += 4 + exifBytes;
	head[p] = 0xff; head[p + 1] = progressive ? 0xc2 : 0xc0;           // SOF0 / SOF2
	head.writeUInt16BE(17, p + 2);                                     // segment length
	head[p + 4] = 8;                                                   // precision
	head.writeUInt16BE(h, p + 5); head.writeUInt16BE(w, p + 7);        // height, width
	return head;
};
const j = imageDims(jpeg(1200, 1600));
check("J3 JPEG SOF0 after a big EXIF block", j?.width === 1200 && j?.height === 1600 && j?.format === "jpeg", JSON.stringify(j));
const jp = imageDims(jpeg(800, 600, { progressive: true }));
check("J3b progressive JPEG (SOF2) too", jp?.width === 800 && jp?.height === 600, JSON.stringify(jp));
const jBig = imageDims(jpeg(4000, 3000, { exifBytes: 40000 }));
check("J3c …even when the marker chain is long (the composer sends 64KB, not the whole file)", jBig?.width === 4000);
// a DHT segment (0xc4) sits where a frame header could be — it must be SKIPPED, not read as one
const jpegWithDht = () => {
	const dht = Buffer.alloc(2 + 2 + 18);            // marker + length + a plausible table payload
	dht[0] = 0xff; dht[1] = 0xc4; dht.writeUInt16BE(20, 2); dht.fill(0x11, 4);
	const sof = jpeg(100, 50).subarray(2);           // SOI stripped: we already have it
	return Buffer.concat([Buffer.from([0xff, 0xd8]), dht, sof]);
};
const jd = imageDims(jpegWithDht());
check("J3d DHT (0xc4) is skipped, the real SOF0 after it is the one that answers",
	jd?.width === 100 && jd?.height === 50 && jd?.format === "jpeg", JSON.stringify(jd));

// ── WebP: VP8X (extended), VP8L (lossless), VP8 (lossy) ──────────────────────
const webpX = (w, h) => {
	const b = Buffer.alloc(40);
	b.write("RIFF", 0); b.writeUInt32LE(32, 4); b.write("WEBP", 8); b.write("VP8X", 12);
	b.writeUInt32LE(10, 16); b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3);
	return b;
};
const wx = imageDims(webpX(2048, 1024));
check("W4 WebP VP8X canvas size", wx?.width === 2048 && wx?.height === 1024 && wx?.format === "webp", JSON.stringify(wx));
const webpL = (w, h) => {
	const b = Buffer.alloc(40);
	b.write("RIFF", 0); b.writeUInt32LE(32, 4); b.write("WEBP", 8); b.write("VP8L", 12);
	b.writeUInt32LE(10, 16); b[20] = 0x2f;
	b.writeUInt32LE((w - 1) | ((h - 1) << 14), 21);
	return b;
};
const wl = imageDims(webpL(512, 384));
check("W4b WebP VP8L (lossless) packed size", wl?.width === 512 && wl?.height === 384, JSON.stringify(wl));
const webpLossy = (w, h) => {
	const b = Buffer.alloc(40);
	b.write("RIFF", 0); b.writeUInt32LE(32, 4); b.write("WEBP", 8); b.write("VP8 ", 12);
	b.writeUInt32LE(20, 16); b[23] = 0x9d; b[24] = 0x01; b[25] = 0x2a;  // frame tag + start code
	b.writeUInt16LE(w & 0x3fff, 26); b.writeUInt16LE(h & 0x3fff, 28);
	return b;
};
const wv = imageDims(webpLossy(1920, 1080));
check("W4c WebP VP8 (lossy) 14-bit dimensions", wv?.width === 1920 && wv?.height === 1080, JSON.stringify(wv));

// ── BMP + the negative cases ────────────────────────────────────────────────
const bmp = (w, h) => {
	const b = Buffer.alloc(30);
	b.write("BM", 0); b.writeUInt32LE(54, 2); b.writeUInt32LE(54, 10);
	b.writeUInt32LE(40, 14); b.writeInt32LE(w, 18); b.writeInt32LE(h, 22);
	return b;
};
const bm = imageDims(bmp(64, 32));
check("B5 BMP info header", bm?.width === 64 && bm?.height === 32, JSON.stringify(bm));
check("B5b a negative BMP height (top-down) is returned as its absolute value", imageDims(bmp(10, -20))?.height === 20);

check("N6 junk / too-short / non-image headers return null (the caller decodes instead)",
	imageDims(Buffer.from("not an image at all")) === null && imageDims(Buffer.alloc(4)) === null &&
	imageDims(Buffer.alloc(0)) === null && imageDims(null) === null);
check("N6b an SVG (text) is not an image header", imageDims(Buffer.from("<svg width=\"100\"></svg>")) === null);
check("N6c a truncated JPEG with no SOF yet returns null", imageDims((() => { const b = Buffer.alloc(64); b[0] = 0xff; b[1] = 0xd8; return b; })()) === null);

// ── the CONTRACT this module exists for: the cap binds BEFORE any decode ────
{
	const policy = resolveDataReduction("wan", {});            // 1280 / 512KB / q0.72
	const dims = imageDims(png(5000, 4000));
	const plan = planImageTransform({ mimeType: "image/png", bytes: 300 * 1024, ...dims }, policy);
	check("C7 a SMALL file that is too WIDE is re-encoded (both budgets are checked, not just bytes)",
		plan.action === "reencode" && plan.target.width === 1280, `action=${plan.action} w=${plan?.target?.width}`);
	const small = planImageTransform({ mimeType: "image/png", bytes: 40 * 1024, ...imageDims(png(800, 600)) }, policy);
	check("C7b a small file that also fits the resolution cap is passed through (zero work)",
		small.action === "passthrough");
	const huge = imageDims(png(12000, 9000));
	check("C7c the probe is what makes the decision possible before decoding", huge.width === 12000 && huge.height === 9000);
}

console.log(`\n[image-dims] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
