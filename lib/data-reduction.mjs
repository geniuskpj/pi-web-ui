// lib/data-reduction.mjs — PURE policy + planning for "reduce mobile data"
// (plan-mobile-data.md §3 "Settings design", §4.1 "lib/data-reduction.mjs").
//
// WHERE THIS SITS
//   The BYTES are produced in the browser (createImageBitmap/OffscreenCanvas) and on the server
//   (egress redaction, lib/media-egress.mjs). This file holds only the DECISIONS plus the two
//   accounting helpers the whole plan leans on:
//     * utf8Bytes/frameBytes — a frame's real wire size (JSON.stringify().length counts UTF-16
//       units, so a non-ASCII thinking buffer looks ~2-3× smaller than it is);
//     * wsCompressHint — the double-compression guard (never gzip before send()).
//   No DOM, no fs, no node builtins → Node imports it directly (tests/data-reduction.test.mjs)
//   and esbuild bundles the same file for the client.
//
// NON-GOALS (deliberate, so nobody "fixes" them back):
//   * no app-level gzip/brotli over the WS — permessage-deflate IS the compression layer, and
//     browsers cannot switch the extension off (only the server can);
//   * no server-side image transcode (no native deps; the upload direction is what costs money);
//   * transferPolicy() in src/idb-cache.ts is untouched — tail-only vs warm backfill is a
//     DIFFERENT knob from image/stream policy.
//
// The thinking half of the same problem (paragraph/line/byte thresholds for reasoning deltas)
// lives in lib/thinking-flush.mjs.

/**
 * THE USER-FACING IMAGE PRESET — four options, nothing to configure by hand:
 *   high    keep detail   (2048px, ≤1MB,  q0.85)
 *   medium  day-to-day    (1280px, ≤512KB,q0.72)
 *   low     save money    (1024px, ≤256KB,q0.65)
 *   none    send the original, untouched (the escape hatch: HEIC/exotic/tool screenshots)
 *   auto    pick one of the three from the current link tier
 * Every level carries TWO thresholds (a resolution cap and a byte cap) plus a resolution FLOOR, so
 * the byte cap can never shred a screenshot into illegibility; the aspect ratio is always preserved
 * (one scale factor for BOTH axes — see planResizeTarget).
 */
export const IMAGE_LEVELS = ["auto", "high", "medium", "low", "none"];
export const IMAGE_LEVEL_PRESETS = {
	high:   { maxEdge: 2048, minEdge: 640, quality: 0.85, maxBytes: 1024 * 1024 },
	medium: { maxEdge: 1280, minEdge: 512, quality: 0.72, maxBytes: 512 * 1024 },
	low:    { maxEdge: 1024, minEdge: 448, quality: 0.65, maxBytes: 256 * 1024 },
};

/** The LINK tier. These are the numbers `auto` resolves to, and the values the server can actually
 *  observe (`/api/health` → netClass) or the browser reports (navigator.connection). Kept as the
 *  documented default table — the user picks a LEVEL, not a tier. */
export const IMAGE_PRESETS = {
	lan:     IMAGE_LEVEL_PRESETS.high,
	wan:     IMAGE_LEVEL_PRESETS.medium,
	metered: IMAGE_LEVEL_PRESETS.low,
};

/** Which level `auto` means on this link: wired/home → high, plain wifi/unknown remote → medium,
 *  a metered/cellular link → low. `none` is NEVER automatic (sending a 3MB photo must be a choice). */
export function imageLevelForNet(net) {
	if (net === "lan" || net === "fast" || net === "ethernet") return "high";
	if (net === "metered" || net === "cellular" || net === "slow-2g" || net === "2g" || net === "3g") return "low";
	return "medium"; // wan / wifi / 4g / remote / unknown
}

/** The quality floor the ladder may not go below (below this, images stop being legible to a model). */
export const MIN_QUALITY = 0.5;

/** bits-per-PIXEL anchors for a photo-ish WebP/JPEG encode, by quality.
 *  A heuristic on purpose (no native encoder in this project): it is used to CHOOSE a target size,
 *  and the plan's measurement table is what corrects it. Linear interpolation between anchors.
 *  Calibrated to "a webp of a 1024×768 photo is ~40KB at q0.65, ~100KB at q0.85" — the numbers a
 *  phone camera roll actually produces. */
export const BPP_ANCHORS = [
	[0.50, 0.25], [0.55, 0.30], [0.65, 0.42], [0.72, 0.55], [0.85, 1.00], [0.90, 1.30],
];

/** Estimated bytes of a WebP/JPEG encode — pure, monotone in pixels and quality. */
export function estimateEncodedBytes({ width = 0, height = 0, quality = 0.72 } = {}) {
	const px = Math.max(0, Number(width) || 0) * Math.max(0, Number(height) || 0);
	return Math.round((px * bppFor(quality)) / 8);
}

/** Bits per pixel at `quality`, linearly interpolated between the anchors (clamped at both ends). */
export function bppFor(quality) {
	const q = Math.min(BPP_ANCHORS[BPP_ANCHORS.length - 1][0], Math.max(BPP_ANCHORS[0][0], Number(quality) || BPP_ANCHORS[0][0]));
	for (let i = 1; i < BPP_ANCHORS.length; i++) {
		const [q1, b1] = BPP_ANCHORS[i];
		if (q <= q1) {
			const [q0, b0] = BPP_ANCHORS[i - 1];
			return q0 === q1 ? b1 : b0 + ((q - q0) / (q1 - q0)) * (b1 - b0);
		}
	}
	return BPP_ANCHORS[BPP_ANCHORS.length - 1][1];
}

/** How many pixels fit in `bytes` at `quality` (the byte budget expressed in resolution). */
export function pixelsForBytes(bytes, quality = 0.72) {
	const bpp = bppFor(quality);
	return bpp > 0 ? Math.max(0, Math.floor(((Number(bytes) || 0) * 8) / bpp)) : 0;
}

/** The quality ladder to try when a size floor is hit: the requested quality, then lower ones. */
export function qualitySteps(quality = 0.72) {
	const q = Math.min(0.9, Math.max(MIN_QUALITY, Number(quality) || 0.72));
	const steps = [q];
	for (let i = BPP_ANCHORS.length - 1; i >= 0; i--) {
		const a = BPP_ANCHORS[i][0];
		if (a < q - 1e-9 && a >= MIN_QUALITY) steps.push(a);
	}
	if (steps[steps.length - 1] > MIN_QUALITY + 1e-9) steps.push(MIN_QUALITY);
	return steps;
}

/** Formats we must never touch: vector (SVG/ICO) and animated (GIF) lose their meaning, and a
 *  re-encoded tool screenshot (PNG → 0.65 webp) becomes unreadable to the model. */
export const PASSTHROUGH_MIME = /^image\/(svg\+xml|gif|x-icon|vnd\.microsoft\.icon|tiff|heic|heif)$/i;

/** Stream modes. ATOMIC ("turn off streaming, send the turn as one message") is DROPPED — user
 *  decision 2026-10-25: it buys single-digit KB per turn and touches retry/steer/versions/sparse
 *  attach. Coalescing (`coalesced` + the per-kind thresholds in lib/thinking-flush.mjs) is what
 *  actually shrinks the frames, and `turnEnd` level already gives the one-frame-per-block result. */
export const STREAM_MODES = ["live", "coalesced"];
export const IMAGE_MODES = ["auto", "always", "original"];

/** Content-addressed media ids (a hash is NOT a capability URL — the route stays behind the /api gate). */
export const MEDIA_HASH_RE = /^[a-f0-9]{64}$/;
export const isMediaHash = (h) => typeof h === "string" && MEDIA_HASH_RE.test(h);

/** UTF-8 byte length without allocating (and without Buffer/TextEncoder: this runs in both). */
export function utf8Bytes(str) {
	const s = String(str ?? "");
	let n = 0;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c < 0x80) n += 1;
		else if (c < 0x800) n += 2;
		else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) { n += 4; i++; } // surrogate pair
		else n += 3;
	}
	return n;
}

/** The real size of one JSON frame on the wire. */
export function frameBytes(value) {
	try { return utf8Bytes(typeof value === "string" ? value : JSON.stringify(value)); }
	catch { return 0; } // circular / throwing getter: treat as "can't measure" (never throw from a counter)
}

/** Double-compression guard: may this payload go through permessage-deflate? */
export function wsCompressHint(kind) {
	return kind === "json" || kind === "text" || kind === "ndjson";
}

/** Is this frame big enough for the WS server to actually compress it?
 *  `perMessageDeflate.threshold` (1024 on the agent socket today) means every frame BELOW it
 *  travels uncompressed — which is why coalescing (thinking, message_update) is a compression
 *  feature, not only a frame-count feature. */
export function deflateEligible(bytes, { threshold = 1024 } = {}) {
	return bytes >= threshold;
}

// ─────────────────────────────────────────────────────────────── image policy (pure)

/**
 * net: "lan" | "wan" | "metered" (or transferPolicy()'s "fast"/"metered").
 * settings: the localStorage keys of plan §3 (pi.dataImages, pi.imageMaxEdge, pi.imageQuality,
 * pi.dataStream). Unknown/missing values fall back to the preset — never to NaN.
 */
export function resolveDataReduction(net, settings = {}) {
	const key = net === "fast" ? "lan" : net === "metered" ? "metered" : (IMAGE_PRESETS[net] ? net : "wan");
	const wanted = IMAGE_LEVELS.includes(settings.imageLevel) ? settings.imageLevel : "auto";
	const level = wanted === "auto" ? imageLevelForNet(key) : wanted;
	// "auto" (and anything unrecognised) resolves to live: coalesced needs server support
	// (plan §2.3) and must never be entered by accident.
	const stream = settings.stream && settings.stream !== "auto" && STREAM_MODES.includes(settings.stream)
		? settings.stream : "live";
	const levelSource = wanted === "auto" ? "auto" : "user";

	// level "none" = the user's escape hatch: nothing is touched, whatever the link says.
	if (level === "none") {
		return { net: key, level, levelSource, mode: "original", maxEdge: 0, minEdge: 0, quality: 1, maxBytes: 0, stream };
	}

	const base = IMAGE_LEVEL_PRESETS[level];
	const mode = IMAGE_MODES.includes(settings.images) ? settings.images : "auto";
	const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
	const maxEdge = Math.round(num(settings.imageMaxEdge) ?? base.maxEdge);
	const minEdge = Math.round(num(settings.imageMinEdge) ?? base.minEdge);
	const maxBytes = Math.round(num(settings.imageMaxBytes) ?? base.maxBytes);
	const q = num(settings.imageQuality);
	const quality = q ? Math.min(0.9, Math.max(MIN_QUALITY, q)) : base.quality;
	// a floor above the cap is nonsense (it would upscale) — the cap wins
	const floor = Math.min(minEdge, maxEdge);
	return { net: key, level, levelSource, mode, maxEdge, minEdge: floor, quality, maxBytes, stream };
}

// ─────────────────────────────────────────── what the settings UI shows (pure strings)

const mb = (bytes) => `${(bytes / 1048576).toFixed(bytes % 1048576 === 0 ? 1 : 2)} MB`;
const kb = (bytes) => `${Math.round(bytes / 1024)} KB`;

/** One line of the ACTUAL parameters behind a policy — shown next to the selected option. */
export function describeImagePolicy(policy = {}) {
	if ((policy.level || "") === "none" || policy.mode === "original") {
		return "None — original bytes, no resize, no re-encode";
	}
	const cap = policy.maxEdge > 0 ? `≤${policy.maxEdge} px` : "no size cap";
	const floor = policy.minEdge > 0 ? `≥${policy.minEdge} px` : "no floor";
	return `${cap} · ${policy.maxBytes >= 1048576 ? mb(policy.maxBytes) : kb(policy.maxBytes)} · webp q${policy.quality} · ${floor}`;
}

/** Short form for a <select> option label. */
export function shortImageParams(level) {
	if (level === "auto") return "follows the connection";
	if (level === "none") return "original";
	const p = IMAGE_LEVEL_PRESETS[level];
	return `${p.maxEdge}px · ${p.maxBytes >= 1048576 ? mb(p.maxBytes) : kb(p.maxBytes)} · q${p.quality}`;
}

/** The option list a settings dropdown renders (value · label · the params shown when selected). */
export function imageLevelOptions(settings = {}) {
	const label = { auto: "Auto", high: "High (keep detail)", medium: "Medium (balanced)", low: "Low (save data)", none: "None (original)" };
	return IMAGE_LEVELS.map((value) => ({
		value,
		label: label[value],
		params: shortImageParams(value),
		resolved: value === "auto" ? imageLevelForNet(settings.net || "wan") : value,
	}));
}

/** EXIF orientation 5-8 = the image is stored rotated 90°: width/height swap.
 *  Needed when the dimensions come from METADATA (pre-decode). createImageBitmap with
 *  { imageOrientation: "from-image" } already returns swapped dims, so a caller with a bitmap
 *  must pass the bitmap's dims and orientation 1. */
export function orientedSize(width, height, orientation = 1) {
	const w = Number(width) || 0, h = Number(height) || 0;
	const swap = Number(orientation) >= 5 && Number(orientation) <= 8;
	return swap ? { width: h, height: w, swapped: true } : { width: w, height: h, swapped: false };
}

/**
 * The resize target for one image (pure: no canvas). ASPECT RATIO IS PRESERVED: one scale factor
 * is applied to BOTH axes — this function never returns a "fit into a box" result, so a 3:2 photo
 * stays 3:2 (up to sub-pixel rounding) no matter which threshold binds.
 *
 * The scale is the MINIMUM of three rules:
 *   1. resolution cap : maxEdge / longEdge
 *   2. byte cap       : sqrt(pixelsForBytes(maxBytes, quality) / (w*h))   ← the byte threshold
 *   3. never upscale  : 1
 * …but never below the resolution floor (minEdge / longEdge). When the floor blocks the byte cap the
 * quality ladder is walked down (to MIN_QUALITY); if it still does not fit, `overBudget` is true and
 * the caller must say so instead of silently shipping megabytes.
 * scale <= 1: this never upscales.
 */
export function planResizeTarget(meta = {}, policy = {}) {
	const maxEdge = policy.maxEdge || IMAGE_PRESETS.wan.maxEdge;
	const minEdge = policy.minEdge || IMAGE_PRESETS.wan.minEdge;
	let quality = Number(policy.quality) || IMAGE_PRESETS.wan.quality;
	const maxBytes = policy.maxBytes || IMAGE_PRESETS.wan.maxBytes;
	const { width, height } = orientedSize(meta.width, meta.height, meta.orientation ?? 1);
	if (!width || !height) return null;

	const longEdge = Math.max(width, height);
	const scaleEdge = Math.min(1, maxEdge / longEdge);
	const scaleBytes = Math.min(1, Math.sqrt(pixelsForBytes(maxBytes, quality) / (width * height)));
	const scaleFloor = Math.min(1, minEdge / longEdge);

	const wanted = Math.min(scaleEdge, scaleBytes);
	const floorHit = wanted < scaleFloor - 1e-9;
	const scale = floorHit ? scaleFloor : wanted;

	const dim = (v) => Math.max(1, Math.round(v * scale));
	const tw = dim(width), th = dim(height);

	// the byte cap blocked by the resolution floor → spend quality, not legibility
	let estimatedBytes = estimateEncodedBytes({ width: tw, height: th, quality });
	let overBudget = estimatedBytes > maxBytes;
	if (overBudget) {
		for (const step of qualitySteps(quality)) {
			quality = step;
			estimatedBytes = estimateEncodedBytes({ width: tw, height: th, quality });
			overBudget = estimatedBytes > maxBytes;
			if (!overBudget) break;
		}
	}

	return {
		width: tw,
		height: th,
		scale,
		clipped: scale < 1,
		quality,
		estimatedBytes,
		budget: maxBytes,
		resolutionCap: maxEdge,
		resolutionFloor: minEdge,
		edgeBinds: scaleEdge <= scaleBytes,
		bytesBind: scaleBytes < scaleEdge,
		floorHit,
		overBudget,
	};
}

/**
 * Decide what happens to ONE image BEFORE it is sent. Pure on purpose: the canvas part happens in
 * the browser, the DECISION is what we test (plan §6.2).
 * meta: { mimeType, bytes, width, height, orientation?, source?: "user" | "tool" }
 * → { action: "passthrough" | "reencode", format?, quality?, maxEdge?, target?, estimatedBytes?,
 *     savings?, reason }
 * An image is left alone only when it satisfies BOTH budgets (resolution and bytes).
 */
export function planImageTransform(meta = {}, policy = {}) {
	const mode = IMAGE_MODES.includes(policy.mode) ? policy.mode : "auto";
	const maxEdge = policy.maxEdge || IMAGE_PRESETS.wan.maxEdge;
	const minEdge = policy.minEdge || IMAGE_PRESETS.wan.minEdge;
	const quality = Number(policy.quality) || IMAGE_PRESETS.wan.quality;
	const maxBytes = policy.maxBytes || IMAGE_PRESETS.wan.maxBytes;
	const mimeType = String(meta.mimeType || "");
	const bytes = Number(meta.bytes) || 0;

	if (mode === "original") return { action: "passthrough", reason: "user chose original" };
	if (meta.source === "tool") return { action: "passthrough", reason: "tool screenshot: keep crisp for the model" };
	if (PASSTHROUGH_MIME.test(mimeType)) return { action: "passthrough", reason: "vector/animated: never re-encode" };

	const size = orientedSize(meta.width, meta.height, meta.orientation ?? 1);
	if (!size.width || !size.height) return { action: "passthrough", reason: "undecodable here (e.g. HEIC on Chrome)" };

	const edge = Math.max(size.width, size.height);
	const fitsEdge = edge <= maxEdge;
	const fitsBytes = bytes <= 0 || bytes <= maxBytes; // bytes 0 = size unknown
	if (fitsEdge && fitsBytes && mode !== "always") {
		return { action: "passthrough", reason: `within budget (${edge}px ≤ ${maxEdge}px, ${bytes}B ≤ ${maxBytes}B)` };
	}

	const target = planResizeTarget(meta, { maxEdge, minEdge, quality, maxBytes });
	return {
		action: "reencode",
		format: "webp", // jpeg is the runtime fallback when toBlob("image/webp") lies (Safari/old Chrome)
		quality: target.quality,
		maxEdge,
		target,
		estimatedBytes: target.estimatedBytes,
		savings: bytes > 0 ? 1 - target.estimatedBytes / bytes : null,
		reason: `${size.width}x${size.height} ${bytes}B → ${target.width}x${target.height} webp q${target.quality}` +
			` (≈${target.estimatedBytes}B, ${Math.round((1 - target.width / size.width) * 100)}% smaller edge` +
			`)${target.overBudget ? " — still over budget" : ""}`,
	};
}

// ─────────────────────────────────────────────────────────────── egress rendering (pure)

/** The media URL for a redacted image part. Hash = content address, still behind the /api gate. */
export function mediaUrl(sessionId, hash) {
	return `/api/agent/session/${encodeURIComponent(String(sessionId || ""))}/media/${hash}`;
}

/** Renderer helper: one shape for BOTH image shapes a warm IDB cache can hold.
 *  Legacy chunks/stored transcripts carry `data` (inline base64); redacted egress carries `hash`.
 *  Returns undefined for anything we cannot render. */
export function imageSrcFor(part, sessionId) {
	if (!part || (part.type && part.type !== "image")) return undefined;
	if (typeof part.data === "string" && part.data) return `data:${part.mimeType || "application/octet-stream"};base64,${part.data}`;
	if (isMediaHash(part.hash)) return mediaUrl(sessionId, part.hash);
	return undefined;
}

// ─────────────────────────────────────────────────────────────── turn coalescing (pure)

/** Frames an atomic/coalesced connection never forwards verbatim (plan §4.5). */
export const COALESCE_DROPPABLE = new Set(["message_update", "tool_execution_update", "partial"]);

/** The key a tool-execution update is coalesced by (each tool call keeps ONE live snapshot). */
export const toolUpdateKey = (ev) => String(ev?.toolCallId ?? ev?.toolName ?? "?");
/** Frames that must survive ANY buffering decision: losing an error is a blind-retry UX. */
export const COALESCE_CRITICAL = new Set(["error", "aborted"]);

/**
 * Server-side coalescing of one turn's flat frames (plan §2.3's cheaper 80/20).
 * Rules:
 *   * a `message_update` carries a FULL snapshot → a burst collapses to its last frame;
 *   * with `dropUpdateBeforeEnd`, that last snapshot is dropped too when a `message_end`
 *     follows immediately (it carries the same final content) — that is the "N updates + one
 *     message_end → exactly one frame" contract from plan §6;
 *   * `tool_execution_update` collapses the SAME way, but PER TOOL CALL: a long `bash`/build tool
 *     keeps ONE live snapshot of its output instead of one frame per chunk (the "same threshold on
 *     the tool call" rule); the snapshot is forwarded before the next boundary event, so a tool
 *     result never arrives without the progress that preceded it;
 *   * `partial` frames are dropped entirely;
 *   * consecutive `runtime` frames collapse to the last (turn progress, not history);
 *   * `error`/`aborted` are never dropped, even after the byte cap is hit;
 *   * capBytes bounds per-connection memory; on overflow the caller must fall back to live.
 * Returns { events, bytes, overflow, dropped, lastUpdate }.
 */
export function coalesceTurn(events = [], { capBytes = 2 * 1024 * 1024, dropUpdateBeforeEnd = true } = {}) {
	const out = [];
	let bytes = 0, overflow = false, dropped = 0, lastUpdate = null;
	const toolUpdates = new Map(); // key → newest tool_execution_update (Map.set keeps first position)

	const push = (ev, force = false) => {
		const size = frameBytes(ev);
		if (!force && bytes + size > capBytes) { overflow = true; dropped++; return false; }
		if (bytes + size > capBytes) overflow = true; // critical frame over the cap: kept anyway
		bytes += size;
		out.push(ev);
		return true;
	};
	/** forward the buffered snapshots (assistant text, then one per live tool call) */
	const flushUpdates = (force = false) => {
		if (lastUpdate) { push(lastUpdate, force); lastUpdate = null; }
		for (const ev of toolUpdates.values()) push(ev, force);
		toolUpdates.clear();
	};

	for (const ev of events) {
		const type = ev?.type;
		if (type === "message_update") {
			if (lastUpdate) dropped++;
			lastUpdate = ev;
			continue;
		}
		if (type === "tool_execution_update") {
			const key = toolUpdateKey(ev);
			if (toolUpdates.has(key)) dropped++; // the same tool call made progress: replace its snapshot
			toolUpdates.set(key, ev);
			continue;
		}
		if (COALESCE_DROPPABLE.has(type)) { dropped++; continue; } // partial
		if (type === "message_end" && lastUpdate && dropUpdateBeforeEnd) {
			dropped++; // message_end supersedes the snapshot
			lastUpdate = null;
		}
		if (type === "runtime" && out.length && out[out.length - 1]?.type === "runtime") {
			dropped++;
			out.pop();
		}
		flushUpdates(COALESCE_CRITICAL.has(type));
		push(ev, COALESCE_CRITICAL.has(type));
	}
	flushUpdates();
	return { events: out, bytes, overflow, dropped, lastUpdate: null };
}
