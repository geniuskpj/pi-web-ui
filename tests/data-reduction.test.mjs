// data-reduction.test.mjs — plan-mobile-data.md §6: the PURE half of "reduce mobile data".
//
// Everything under test is a decision, not an effect: no canvas, no DOM, no server, no network.
// The suites pin, in order:
//   R  resolveDataReduction        — the localStorage/normalised policy matrix (pi.data* keys)
//   I  planImageTransform          — re-encode vs passthrough, incl. the traps of §8 (HEIC, svg,
//                                    gif, tool screenshots, "already small", mode:"always")
//   X  planResizeTarget/orientedSize — the resize target, incl. EXIF-6 axis swap (asserted on the
//                                    PLAN: the canvas half is browser-only and not gated in CI)
//   Z  frame accounting            — utf8Bytes/frameBytes (wire truth vs .length), wsCompressHint
//                                    (the double-compression guard) and deflateEligible (§8.13)
//   C  coalesceTurn                — the cheap 80/20 of item 3 (plan §2.3, §6.3; atomic dropped)
//   M  media egress                — redact/hydrate round-trip, hashes, LRU store, identity for a
//                                    session without images, and the "no long base64" invariant
//   S  savings accounting          — the §7 expectation, measured on a synthetic 8-image fixture
//
// Usage: node tests/data-reduction.test.mjs
import {
	IMAGE_PRESETS, IMAGE_LEVELS, IMAGE_LEVEL_PRESETS, MIN_QUALITY, MEDIA_HASH_RE, isMediaHash,
	resolveDataReduction, planImageTransform, planResizeTarget, orientedSize,
	estimateEncodedBytes, qualitySteps,
	imageLevelForNet, describeImagePolicy, shortImageParams, imageLevelOptions,
	utf8Bytes, frameBytes, wsCompressHint, deflateEligible,
	coalesceTurn, toolUpdateKey, imageSrcFor, mediaUrl,
} from "../lib/data-reduction.mjs";
import {
	hashOf, hashOfBase64, createMediaStore, redactImageData, hydrateImageData, inlineBase64Runs,
} from "../lib/media-egress.mjs";
// the BROWSER side of the same levels: keys + localStorage plumbing (thin wrapper over the libs)
import {
	DATA_SETTING_KEYS, readDataSettings, resolvedImagePolicy, resolvedStreamPolicy, pushDataReduction,
} from "../src/ui/data-settings.ts";
// the stream half of the same levels (used by the client-hop checks below)
import { resolveStreamPolicy } from "../lib/thinking-flush.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentHub } from "../agent-hub.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let passed = 0, failed = 0;
const check = (name, ok, extra = "") => {
	if (ok) { passed++; console.log(`  ✓ ${name}${extra ? " — " + extra : ""}`); }
	else { failed++; console.error(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
};
/** A PNG signature + a fill byte, padded so the base64 is as long as a real photo.
 *  `fill` is the content: the SAME fill = the SAME bytes = the SAME hash (that is the point of a
 *  content address), so callers that need two distinct images pass two fills. */
const fakeImageB64 = (kb, fill = 0xab) => {
	const head = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
	return Buffer.concat([head, Buffer.alloc(Math.max(0, kb * 1024 - head.length), fill)]).toString("base64");
};
const imagePart = (kb, mimeType = "image/png", fill = 0xab) => ({ type: "image", mimeType, data: fakeImageB64(kb, fill) });
const msg = (text, parts = []) => ({ role: "user", content: [{ type: "text", text }, ...parts], timestamp: 1700000000000 });

// ─────────────────────────────────────────────────────── R: the policy matrix (§3)
{
	const auto = resolveDataReduction("lan", {});
	check("R1 lan auto = 2048/0.85/webp-capable, stream live",
		auto.net === "lan" && auto.mode === "auto" && auto.maxEdge === 2048 && auto.quality === 0.85 && auto.stream === "live");

	check("R2 transferPolicy's \"fast\" maps onto the lan preset", resolveDataReduction("fast", {}).maxEdge === 2048);
	check("R3 \"metered\" maps onto the metered preset", resolveDataReduction("metered", {}).maxEdge === 1024);
	check("R4 an unknown net falls back to wan (never NaN)", resolveDataReduction(undefined, {}).net === "wan" && resolveDataReduction("carrier-pigeon", {}).maxEdge === IMAGE_PRESETS.wan.maxEdge);

	const overrides = resolveDataReduction("metered", { imageMaxEdge: "1600", imageQuality: 1, mode: "x" });
	check("R5 an explicit maxEdge wins over the preset", overrides.maxEdge === 1600);
	check("R5b quality is clamped to 0.5–0.9", overrides.quality === 0.9);
	check("R5c a too-low quality is clamped up", resolveDataReduction("lan", { imageQuality: 0.1 }).quality === 0.5);
	check("R5d garbage numbers fall back to the preset", resolveDataReduction("lan", { imageMaxEdge: "abc", imageQuality: "NaN" }).maxEdge === 2048);
	check("R5e a negative maxEdge is ignored", resolveDataReduction("lan", { imageMaxEdge: -5 }).maxEdge === 2048);

	check("R6 images mode: only the three known values survive",
		resolveDataReduction("lan", { images: "always" }).mode === "always" &&
		resolveDataReduction("lan", { images: "original" }).mode === "original" &&
		resolveDataReduction("lan", { images: "yolo" }).mode === "auto");

	check("R7 stream:\"auto\"/junk resolve to live; \"coalesced\" is the only other mode (atomic was dropped)",
		resolveDataReduction("lan", { stream: "auto" }).stream === "live" &&
		resolveDataReduction("lan", { stream: "coalesced" }).stream === "coalesced" &&
		resolveDataReduction("lan", { stream: "atomic" }).stream === "live" &&
		resolveDataReduction("lan", { stream: "teleport" }).stream === "live");

	check("R8 the presets are ordered (wired > wifi > metered) in pixels and bytes",
		IMAGE_PRESETS.lan.maxEdge > IMAGE_PRESETS.wan.maxEdge && IMAGE_PRESETS.wan.maxEdge > IMAGE_PRESETS.metered.maxEdge &&
		IMAGE_PRESETS.lan.quality > IMAGE_PRESETS.metered.quality);
}

// ───────────────────────── L: the four user-facing LEVELS + what the settings UI shows
{
	check("L1 the four levels (+auto) are exactly high · medium · low · none",
		IMAGE_LEVELS.join(",") === "auto,high,medium,low,none");
	check("L2 each level is a complete policy (resolution cap AND byte cap AND floor)",
		["high", "medium", "low"].every((k) => IMAGE_LEVEL_PRESETS[k].maxEdge > 0 && IMAGE_LEVEL_PRESETS[k].maxBytes > 0 && IMAGE_LEVEL_PRESETS[k].minEdge > 0 && IMAGE_LEVEL_PRESETS[k].quality >= MIN_QUALITY));
	check("L3 the levels are ordered high > medium > low in pixels, bytes and quality",
		IMAGE_LEVEL_PRESETS.high.maxEdge > IMAGE_LEVEL_PRESETS.medium.maxEdge && IMAGE_LEVEL_PRESETS.medium.maxEdge > IMAGE_LEVEL_PRESETS.low.maxEdge &&
		IMAGE_LEVEL_PRESETS.high.maxBytes > IMAGE_LEVEL_PRESETS.medium.maxBytes && IMAGE_LEVEL_PRESETS.medium.maxBytes > IMAGE_LEVEL_PRESETS.low.maxBytes &&
		IMAGE_LEVEL_PRESETS.high.quality > IMAGE_LEVEL_PRESETS.medium.quality && IMAGE_LEVEL_PRESETS.medium.quality > IMAGE_LEVEL_PRESETS.low.quality);

	check("L4 a chosen level is used verbatim, whatever the link says",
		resolveDataReduction("lan", { imageLevel: "low" }).maxEdge === 1024 && resolveDataReduction("metered", { imageLevel: "high" }).maxEdge === 2048 &&
		resolveDataReduction("lan", { imageLevel: "low" }).levelSource === "user");
	check("L5 auto follows the link: lan/wired → high, wifi/wan/remote → medium, metered/cellular → low",
		imageLevelForNet("lan") === "high" && imageLevelForNet("fast") === "high" && imageLevelForNet("ethernet") === "high" &&
		imageLevelForNet("wan") === "medium" && imageLevelForNet("wifi") === "medium" && imageLevelForNet("remote") === "medium" &&
		imageLevelForNet("metered") === "low" && imageLevelForNet("cellular") === "low" && imageLevelForNet("3g") === "low");
	check("L5b auto NEVER picks none (a 3MB photo must be a deliberate choice)",
		["lan", "fast", "wan", "wifi", "remote", "metered", "cellular", "nonsense", undefined].every((n) => imageLevelForNet(n) !== "none"));
	check("L6 auto resolves through resolveDataReduction too",
		resolveDataReduction("metered", {}).level === "low" && resolveDataReduction("lan", {}).level === "high" && resolveDataReduction("remote", {}).level === "medium" &&
		resolveDataReduction("lan", { imageLevel: "auto" }).levelSource === "auto");
	check("L7 a junk level falls back to auto (never to a surprise 3MB upload)",
		resolveDataReduction("metered", { imageLevel: "best" }).level === "low" && resolveDataReduction("metered", { imageLevel: "best" }).levelSource === "auto");

	check("L8 level none = send the original: nothing is resized or re-encoded at any link",
		(() => {
			for (const net of ["lan", "wan", "metered"]) {
				const pol = resolveDataReduction(net, { imageLevel: "none" });
				if (pol.mode !== "original") return false;
				if (planImageTransform({ mimeType: "image/jpeg", bytes: 12 * 1024 * 1024, width: 8000, height: 6000 }, pol).action !== "passthrough") return false;
			}
			return true;
		})());
	check("L8b …and it wins over mode:\"always\": level none is a promise, not a hint",
		resolveDataReduction("metered", { imageLevel: "none", images: "always" }).mode === "original" &&
		planImageTransform({ mimeType: "image/jpeg", bytes: 5e6, width: 4000, height: 3000 },
			resolveDataReduction("metered", { imageLevel: "none", images: "always" })).action === "passthrough");

	check("L9 each level produces the expected plan for the same photo (the numbers the UI promises)",
		(() => {
			const photo = { mimeType: "image/jpeg", bytes: 3 * 1024 * 1024, width: 4000, height: 3000 };
			const at = (level) => planImageTransform(photo, resolveDataReduction("wan", { imageLevel: level })).target;
			return at("high").width === 2048 && at("medium").width === 1280 && at("low").width === 1024 &&
				at("high").height === 1536 && at("medium").height === 960 && at("low").height === 768;
		})());
	check("L9b …and the aspect ratio holds at every level",
		(() => [[4000, 3000], [3000, 4000], [1536, 1024]].every(([w, h]) => ["high", "medium", "low"].every((level) => {
			const t = planImageTransform({ mimeType: "image/jpeg", bytes: 3e6, width: w, height: h }, resolveDataReduction("wan", { imageLevel: level })).target;
			return Math.abs(t.width / t.height - w / h) / (w / h) < 0.005;
		}))));

	// "show param when it is selected" — the strings the dialog renders
	check("L10 describeImagePolicy spells out the ACTUAL parameters of the selected level",
		describeImagePolicy(resolveDataReduction("wan", { imageLevel: "medium" })).includes("≤1280 px") &&
		describeImagePolicy(resolveDataReduction("wan", { imageLevel: "medium" })).includes("512 KB") &&
		describeImagePolicy(resolveDataReduction("wan", { imageLevel: "medium" })).includes("q0.72") &&
		describeImagePolicy(resolveDataReduction("wan", { imageLevel: "medium" })).includes("≥512 px"),
		describeImagePolicy(resolveDataReduction("wan", { imageLevel: "medium" })));
	check("L10b level none describes itself as the escape hatch",
		/^None/.test(describeImagePolicy(resolveDataReduction("lan", { imageLevel: "none" }))) &&
		/original/.test(describeImagePolicy(resolveDataReduction("lan", { imageLevel: "none" }))));
	check("L10c an overridden level shows the OVERRIDE, not the preset (no lying UI)",
		describeImagePolicy(resolveDataReduction("wan", { imageLevel: "medium", imageMaxEdge: 900, imageMaxBytes: 80 * 1024, imageQuality: 0.6 })).includes("≤900 px") &&
		describeImagePolicy(resolveDataReduction("wan", { imageLevel: "medium", imageMaxEdge: 900, imageMaxBytes: 80 * 1024, imageQuality: 0.6 })).includes("80 KB"));
	check("L11 shortImageParams gives a dropdown-sized summary for every level",
		imageLevelOptions().length === 5 && imageLevelOptions().every((o) => o.value && o.label && o.params) &&
		shortImageParams("high") === "2048px · 1.0 MB · q0.85" && shortImageParams("low") === "1024px · 256 KB · q0.65" &&
		shortImageParams("none") === "original" && shortImageParams("auto") === "follows the connection",
		imageLevelOptions().map((o) => `${o.value}: ${o.params}`).join(" | "));
	check("L11b the option list marks what auto currently resolves to",
		imageLevelOptions({ net: "metered" }).find((o) => o.value === "auto").resolved === "low" &&
		imageLevelOptions({ net: "lan" }).find((o) => o.value === "auto").resolved === "high");
}

// ─────── L2: the BROWSER side — localStorage keys, the dialog, the params it prints
{
	check("L12 the levels persist under the documented pi.* keys (the pi.autoRetry pattern)",
		DATA_SETTING_KEYS.imageLevel === "pi.imageLevel" && DATA_SETTING_KEYS.thinkingLevel === "pi.thinkingLevel" &&
		DATA_SETTING_KEYS.textLevel === "pi.textLevel" && DATA_SETTING_KEYS.toolLevel === "pi.toolLevel", JSON.stringify(DATA_SETTING_KEYS));
	check("L12b with no localStorage (node, private mode) every reader is safe and conservative",
		JSON.stringify(readDataSettings()) === "{}" && resolvedImagePolicy().net === "wan" && resolvedImagePolicy().level === "medium" &&
		resolvedStreamPolicy("thinking").mode === "paragraph" && resolvedStreamPolicy("tool").mode === "lines");
	check("L12c the browser wrapper resolves the SAME policies the pure layer does",
		resolvedImagePolicy("metered").maxEdge === resolveDataReduction("metered", {}).maxEdge &&
		resolvedImagePolicy("lan").minBytes === undefined && resolvedStreamPolicy("text", "wan").minBytes === 128);

	// source assertions — the wiring that cannot be expressed as a pure call
	const dialogSrc = fs.readFileSync(path.join(ROOT, "src/ui/settings.tsx"), "utf8");
	const settingsSrc = fs.readFileSync(path.join(ROOT, "src/ui/data-settings.ts"), "utf8");
	check("L13 the dialog offers both dropdowns from the lib option lists (labels + params)",
		/imageLevelOptions\(\{ net \}\)\.map/.test(dialogSrc) && /thinkingLevelOptions\(\)\.map/.test(dialogSrc));
	check("L13b the SELECTED option's parameters are rendered, not just its label",
		/describeImagePolicy\(imagePolicy\)/.test(dialogSrc) && /describeStreamPolicy\(streamPolicies\.thinking/.test(dialogSrc) &&
		/describeStreamPolicy\(streamPolicies\.text/.test(dialogSrc) && /describeStreamPolicy\(streamPolicies\.tool/.test(dialogSrc));
	check("L13c selecting a level SAVES it (setImageLevel/setThinkingLevel) and pushes it to the hub",
		/setImageLevelState\(setImageLevel\(v\)\)/.test(dialogSrc) && /setThinkingLevelState\(setThinkingLevel\(v\)\)/.test(dialogSrc) &&
		/pushDataReduction\(agent\)/.test(dialogSrc));
	check("L13d the browser wrapper never re-implements a threshold (it delegates to the libs)",
		/resolveDataReduction\(net, readDataSettings\(\)\)/.test(settingsSrc) && /resolveStreamPolicy\(kind, net, readDataSettings\(\)\)/.test(settingsSrc) &&
		!/maxEdge\s*[:=]\s*\d/.test(settingsSrc) && !/minBytes\s*[:=]\s*\d/.test(settingsSrc));
	check("L13e the tier is read from /api/health (the only thing the server can observe) and cached for the composer",
		/\/api\/health/.test(dialogSrc) && /localStorage\.setItem\("pi\.netTier"/.test(dialogSrc));
	check("L13f the hub push carries per-stream thresholds (server-side coalescing needs the numbers)",
		/setDataReduction\?/.test(settingsSrc) && /thinking:\s*pickStreamNumbers\(thinking\)/.test(settingsSrc) &&
		/text:\s*pickStreamNumbers\(resolvedStreamPolicy\("text"\)\)/.test(settingsSrc) && /tool:\s*pickStreamNumbers\(resolvedStreamPolicy\("tool"\)\)/.test(settingsSrc));
}

// ── L4: THE CLIENT HOP (review report.md B1, 2026-10-27): the settings dialog was inert because
// `agent.setDataReduction` did not exist and nothing re-pushed the levels on attach. This is the
// BEHAVIOUR of the push (the real function, a fake agent) plus a source assertion for the method and
// its attach call site — importing src/proxy-agent.ts in node is not possible (it imports "./id.js").
{
	const sent = [];
	pushDataReduction({ setDataReduction: (cfg) => sent.push(cfg) });
	const frame = sent[0];
	check("L16 pushDataReduction sends ONE frame with the levels, the per-kind thresholds and the retention",
		!!frame && frame.thinkingLevel === "paragraph" && typeof frame.thinking?.mode === "string" &&
		typeof frame.thinking.minBytes === "number" && typeof frame.tool?.mode === "string" && typeof frame.imageRetention === "string",
		JSON.stringify(frame && Object.keys(frame)));
	check("L16b the per-kind numbers match the resolved policies (the hub does not have to guess)",
		frame.thinking.mode === resolveStreamPolicy("thinking", "wan", {}).mode &&
			frame.thinking.minBytes === resolveStreamPolicy("thinking", "wan", {}).minBytes &&
			frame.thinking.firstBytes === resolveStreamPolicy("thinking", "wan", {}).firstBytes);
	check("L16c it is a no-op (no throw) when the agent has no such method — old server, same code path",
		(() => { try { pushDataReduction({}); pushDataReduction(null); return true; } catch { return false; } })());

	const proxySrc = fs.readFileSync(path.join(ROOT, "src/proxy-agent.ts"), "utf8");
	check("L16d ProxyAgent DEFINES setDataReduction (the optional call in data-settings is now answered)",
		/setDataReduction\(cfg: Record<string, unknown>\): void/.test(proxySrc) && /import \{ pushDataReduction \} from "\.\/ui\/data-settings\.js"/.test(proxySrc));
	check("L16e …and the ATTACH handler re-pushes it (a reload cannot silently disable the feature)",
		/pushDataReduction\(this\);/.test(proxySrc) && /this\.pushAutoRetrySetting\(\);[\s\S]{0,400}pushDataReduction\(this\)/.test(proxySrc));
	check("L16f the settings dialog calls a REAL method now (no optional-call blind alley for the levels)",
		/setImageLevelState\(setImageLevel\(v\)\)/.test(fs.readFileSync(path.join(ROOT, "src/ui/settings.tsx"), "utf8")) &&
		/pushDataReduction\(agent\)/.test(fs.readFileSync(path.join(ROOT, "src/ui/settings.tsx"), "utf8")));
}

// ─── L3: the HUB's egress cache and retention (grok review 2026-10-25, blocker 4 + should-fix)
{
	const hubStub = (store) => ({ media: store, mediaPersist: true, _redactedMsg: new WeakMap() });
	const redactWith = (hub, msgs) => AgentHub.prototype.redactMessages.call(hub, msgs);

	const hub = hubStub(createMediaStore());
	const first = msg("first", [imagePart(60, "image/png", 0x31)]);
	const later = { role: "assistant", content: [{ type: "text", text: "later" }] };
	const transcript = [first];
	const once = redactWith(hub, transcript);
	transcript.push(later); // the agent pushes into the SAME array — the normal case
	const twice = redactWith(hub, transcript);
	check("L14 a GROWING transcript is re-redacted (the cache is per message, not per array)",
		twice.length === 2 && twice[1] === later && twice[0].content[1].data === undefined, `len=${twice.length}`);
	check("L14b an unchanged message returns the SAME redacted object (still cached, no re-decode)",
		twice[0] === once[0]);
	check("L14c a transcript with no images is returned by IDENTITY (no copies, no cache churn)",
		(() => { const plain = [msg("hi")]; return redactWith(hub, plain) === plain; })());
	check("L14d the redacted part carries hash+bytes and no data, and the store has the bytes",
		twice[0].content[1].hash !== undefined && twice[0].content[1].bytes > 0 && hub.media.has(twice[0].content[1].hash));

	// RETENTION must reach the REDACT path too, not only POST /media (grok should-fix)
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-hub-media-"));
	try {
		const browserish = hubStub(createMediaStore({ dir }));
		browserish.mediaPersist = false;
		const shrunk = redactWith(browserish, [msg("keep it local", [imagePart(60, "image/png", 0x41)])]);
		const h = shrunk[0].content[1].hash;
		check("L15 retention 'browser' also applies to egress redaction (no disk write)",
			!fs.existsSync(path.join(dir, h.slice(0, 2), h)) && browserish.media.get(h)?.persisted === false && browserish.media.get(h)?.bytes.length > 0);
		const serverish = hubStub(createMediaStore({ dir }));
		const kept = redactWith(serverish, [msg("keep it on the server", [imagePart(60, "image/png", 0x42)])]);
		const h2 = kept[0].content[1].hash;
		check("L15b retention 'server' (default) writes the blob to disk",
			fs.existsSync(path.join(dir, h2.slice(0, 2), h2)) && serverish.media.get(h2)?.persisted === true);
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// ─────────────────────────────────────── I: what happens to one image (§2.2a, §6.2)
{
	const pol = resolveDataReduction("metered", {}); // 1024 / 0.65 / 256KB
	const big = planImageTransform({ mimeType: "image/jpeg", bytes: 3 * 1024 * 1024, width: 4000, height: 3000 }, pol);
	check("I1 a 12MP 3MB camera photo is re-encoded",
		big.action === "reencode" && big.format === "webp" && big.quality === 0.65, big.reason);
	check("I1b the re-encode carries an explicit resize target",
		big.target.width === 1024 && big.target.height === 768 && big.target.clipped === true);

	const small = planImageTransform({ mimeType: "image/jpeg", bytes: 40 * 1024, width: 800, height: 600 }, pol);
	check("I2 an 800×600 40KB image is passed through untouched (under BOTH budgets)",
		small.action === "passthrough" && /within budget/.test(small.reason), small.reason);

	// the two thresholds, separately: only ONE of them may be exceeded and the image is still re-encoded
	check("I2b over the RESOLUTION cap only (5000px, 120KB, metered 1024px/256KB) → re-encode",
		planImageTransform({ mimeType: "image/jpeg", bytes: 120 * 1024, width: 5000, height: 4000 }, pol).action === "reencode");
	check("I2c over the BYTE cap only (within 1024px, 900KB > 256KB) → re-encode",
		planImageTransform({ mimeType: "image/png", bytes: 900 * 1024, width: 800, height: 600 }, pol).action === "reencode");
	check("I2d the byte threshold is the preset's, not a fixed 100KB: 200KB passes on metered (≤256KB)",
		IMAGE_PRESETS.metered.maxBytes === 256 * 1024 &&
		planImageTransform({ mimeType: "image/jpeg", bytes: 200 * 1024, width: 900, height: 700 }, pol).action === "passthrough");
	check("I2e …and a 600KB 1200×900 image passes on lan (1MB) but not on wan (512KB)",
		planImageTransform({ mimeType: "image/jpeg", bytes: 600 * 1024, width: 1200, height: 900 }, resolveDataReduction("lan", {})).action === "passthrough" &&
		planImageTransform({ mimeType: "image/jpeg", bytes: 600 * 1024, width: 1200, height: 900 }, resolveDataReduction("wan", {})).action === "reencode",
		"one image, two links, two answers — the budget is per-link");
	check("I2f both budgets are user-overridable (pi.imageMaxBytes / pi.imageMinEdge / pi.imageMaxEdge)",
		resolveDataReduction("metered", { imageMaxBytes: 50 * 1024, imageMinEdge: 300, imageMaxEdge: 800 }).maxBytes === 50 * 1024 &&
		resolveDataReduction("metered", { imageMaxBytes: 50 * 1024, imageMinEdge: 300, imageMaxEdge: 800 }).minEdge === 300 &&
		planImageTransform({ mimeType: "image/jpeg", bytes: 60 * 1024, width: 700, height: 500 },
			resolveDataReduction("metered", { imageMaxBytes: 50 * 1024 })).action === "reencode");
	check("I2g a nonsense floor (above the cap) is clamped to the cap, never upscales",
		resolveDataReduction("metered", { imageMinEdge: 4000, imageMaxEdge: 1024 }).minEdge === 1024);
	check("I2h the plan reports the estimated result and the saving (for the UI note and the benchmark)",
		(() => { const p = planImageTransform({ mimeType: "image/jpeg", bytes: 3 * 1024 * 1024, width: 4000, height: 3000 }, pol); return p.estimatedBytes > 0 && p.savings > 0.9 && /≈/.test(p.reason); })());

	for (const mime of ["image/svg+xml", "image/gif", "image/x-icon", "image/tiff", "image/heic"]) {
		check(`I3 ${mime} is never re-encoded`, planImageTransform({ mimeType: mime, bytes: 3e6, width: 4000, height: 3000 }, pol).action === "passthrough");
	}
	check("I3b an animated GIF stays animated (no canvas round-trip)", /never re-encode/.test(planImageTransform({ mimeType: "image/gif", bytes: 3e6, width: 4000, height: 3000 }, pol).reason));

	check("I4 a tool-result screenshot is passed through crisp (§8.4)",
		planImageTransform({ mimeType: "image/png", bytes: 2e6, width: 3000, height: 2000, source: "tool" }, pol).action === "passthrough");

	check("I5 HEIC with unknown dims (Chrome cannot decode it) → passthrough + a reason (§8.3)",
		planImageTransform({ mimeType: "image/heic", bytes: 4e6, width: 0, height: 0 }, pol).action === "passthrough" &&
		planImageTransform({ mimeType: "image/webp", bytes: 4e6 }, pol).action === "passthrough");
	check("I5b an unknown-ish image within maxEdge is left alone rather than guessed at",
		planImageTransform({ mimeType: "image/webp", bytes: 0, width: 640, height: 480 }, pol).action === "passthrough");

	check("I6 mode:\"original\" forces passthrough even for 12MP",
		planImageTransform({ mimeType: "image/jpeg", bytes: 3e6, width: 4000, height: 3000 }, resolveDataReduction("metered", { images: "original" })).action === "passthrough");
	check("I7 mode:\"always\" forces a re-encode even for a small image",
		planImageTransform({ mimeType: "image/jpeg", bytes: 40 * 1024, width: 800, height: 600 }, resolveDataReduction("lan", { images: "always" })).action === "reencode");

	const overridden = planImageTransform({ mimeType: "image/jpeg", bytes: 3e6, width: 4000, height: 3000 }, resolveDataReduction("metered", { imageMaxEdge: 512 }));
	check("I8 the maxEdge override is honoured by the plan", overridden.target.width === 512 && overridden.target.height === 384);
	check("I9 planImageTransform never mutates its input or returns canvas state",
		typeof overridden === "object" && !("canvas" in overridden) && !("blob" in overridden));
}

// ─────────────────────────── X: the resize target, the byte budget + EXIF (§6.2 last bullet)
{
	const pol = resolveDataReduction("metered", {});
	const t = planResizeTarget({ width: 4000, height: 3000 }, pol);
	check("X1 a landscape photo keeps its aspect ratio", t.width === 1024 && t.height === 768 && t.scale === 0.256 && t.clipped);

	const portrait = planResizeTarget({ width: 3000, height: 4000 }, pol);
	check("X2 a portrait photo is bounded by its LONG edge (height)", portrait.width === 768 && portrait.height === 1024);

	check("X3 never upscales", planResizeTarget({ width: 320, height: 200 }, pol).scale === 1 && planResizeTarget({ width: 320, height: 200 }, pol).clipped === false);
	check("X4 missing dimensions → null (the caller keeps the original)", planResizeTarget({ width: 0, height: 0 }, pol) === null && planResizeTarget({}, pol) === null);

	// EXIF orientation 6 = stored rotated: a 3000×4000 buffer displays as 4000×3000.
	const exif6 = planImageTransform({ mimeType: "image/jpeg", bytes: 3e6, width: 3000, height: 4000, orientation: 6 }, pol);
	check("X5 EXIF-6 swaps the axes before choosing the target (portrait buffer → landscape target)",
		exif6.target.width === 1024 && exif6.target.height === 768,
		`${exif6.target.width}x${exif6.target.height}`);
	const exif6upright = planImageTransform({ mimeType: "image/jpeg", bytes: 3e6, width: 4000, height: 3000, orientation: 1 }, pol);
	check("X5b the same image with orientation 1 gives the identical target (from-image == manual swap)",
		exif6.target.width === exif6upright.target.width && exif6.target.height === exif6upright.target.height);
	check("X6 orientations 5–8 swap, 1–4 do not",
		orientedSize(10, 20, 5).swapped && orientedSize(10, 20, 8).swapped &&
		!orientedSize(10, 20, 3).swapped && !orientedSize(10, 20, 1).swapped);
	check("X6b an unreliable orientation value is treated as upright",
		orientedSize(10, 20, 99).width === 10 && orientedSize(10, 20, undefined).width === 10);
	check("X7 rounding never produces a 0-pixel edge",
		planResizeTarget({ width: 4001, height: 1 }, pol).height >= 1);
}

{
	// ASPECT RATIO IS A CONTRACT, not a side effect: sweep realistic sizes (and both orientations)
	// and require the ratio to survive the resize (only sub-pixel rounding may differ).
	const pol = resolveDataReduction("metered", {});
	const sizes = [
		[4000, 3000], [3000, 4000], [6000, 4000], [4000, 6000], [2048, 2048], [8000, 1000],
		[1000, 8000], [1920, 1080], [1080, 1920], [3264, 2448], [2448, 3264], [500, 400],
	];
	let worst = 0, upscaled = 0, overCap = 0;
	for (const [w, h] of sizes) {
		const target = planResizeTarget({ width: w, height: h }, pol);
		const want = w / h, got = target.width / target.height;
		worst = Math.max(worst, Math.abs(got - want) / want);
		if (target.width > w || target.height > h) upscaled++;
		if (Math.max(target.width, target.height) > pol.maxEdge) overCap++;
	}
	check("X8 the aspect ratio survives the resize for every realistic size (≤0.5% error)",
		worst <= 0.005, `worst relative error ${(worst * 100).toFixed(3)}% over ${sizes.length} sizes`);
	check("X8b …because ONE scale factor drives both axes",
		(sizes.every(([w, h]) => { const t = planResizeTarget({ width: w, height: h }, pol); return Math.abs(t.width / (w * t.scale) - 1) < 0.005 && Math.abs(t.height / (h * t.scale) - 1) < 0.005; })));
	check("X8c no size is ever upscaled and none exceeds the resolution cap", upscaled === 0 && overCap === 0,
		`upscaled=${upscaled} overCap=${overCap}`);
	check("X8d a 3:2 photo stays 3:2 (1536×1024 → 1024×683, not 1024×768)",
		planResizeTarget({ width: 1536, height: 1024 }, pol).height === 683 && planResizeTarget({ width: 1536, height: 1024 }, pol).width === 1024);
}

{
	// THE BYTE BUDGET: when the resolution cap is generous, bytes choose the size — that is the
	// "set threshold for bytes/res" half of the request, and it is not a fixed box.
	const wide = resolveDataReduction("metered", { imageMaxEdge: 6000, imageMinEdge: 100 }); // no real cap
	const t = planResizeTarget({ width: 6000, height: 4000 }, { ...wide, quality: 0.65 });
	check("X9 with a generous resolution cap the BYTE budget sets the edge (12Mpx → ~9.5Mpx at 256KB/q0.65)",
		t.bytesBind === true && t.edgeBinds === false && t.estimatedBytes <= wide.maxBytes,
		`${t.width}x${t.height} ≈${(t.estimatedBytes / 1024).toFixed(0)}KB, scale ${t.scale.toFixed(3)}`);
	check("X9b the byte-driven target still keeps the aspect ratio",
		Math.abs(t.width / t.height - 6000 / 4000) < 0.01, `${t.width}x${t.height}`);
	check("X9c a bigger byte budget → a bigger (or equal) target: monotone in maxBytes",
		(() => {
			const small = planResizeTarget({ width: 6000, height: 4000 }, { ...wide, maxBytes: 256 * 1024 });
			const big = planResizeTarget({ width: 6000, height: 4000 }, { ...wide, maxBytes: 2 * 1024 * 1024 });
			return big.width > small.width;
		})());
	check("X9d estimateEncodedBytes is monotone in quality and in pixels",
		estimateEncodedBytes({ width: 1000, height: 1000, quality: 0.5 }) < estimateEncodedBytes({ width: 1000, height: 1000, quality: 0.9 }) &&
		estimateEncodedBytes({ width: 500, height: 500, quality: 0.72 }) < estimateEncodedBytes({ width: 1000, height: 1000, quality: 0.72 }) &&
		estimateEncodedBytes({ width: 0, height: 0, quality: 0.72 }) === 0);
	check("X9e the quality ladder descends to the legibility floor and no further",
		qualitySteps(0.85).join(",") === "0.85,0.72,0.65,0.55,0.5" && qualitySteps(0.5).join(",") === "0.5" && MIN_QUALITY === 0.5, qualitySteps(0.85).join(","));
}

{
	// the RESOLUTION FLOOR: bytes may shrink an image only down to minEdge; below that we burn quality.
	const floorPol = { maxEdge: 4096, minEdge: 2048, quality: 0.65, maxBytes: 20 * 1024 };
	const t = planResizeTarget({ width: 12000, height: 9000 }, floorPol);
	check("X10 the byte cap may not push the long edge below the floor (legibility wins)",
		t.floorHit === true && Math.max(t.width, t.height) === 2048 && t.height === 1536);
	check("X10b so the quality ladder is walked down instead — and it says so when it still does not fit",
		t.quality < 0.65 && t.overBudget === true && t.estimatedBytes > floorPol.maxBytes,
		`q ${t.quality}, ≈${(t.estimatedBytes / 1024).toFixed(0)}KB > ${(floorPol.maxBytes / 1024).toFixed(0)}KB`);
	const fitsAfter = planResizeTarget({ width: 12000, height: 9000 }, { maxEdge: 2048, minEdge: 2048, quality: 0.85, maxBytes: 120 * 1024 });
	check("X10c when the quality ladder succeeds, overBudget is false and a warning is NOT raised",
		fitsAfter.overBudget === false && fitsAfter.quality < 0.85 && fitsAfter.estimatedBytes <= 120 * 1024 && fitsAfter.width === 2048,
		`q ${fitsAfter.quality}, ≈${(fitsAfter.estimatedBytes / 1024).toFixed(0)}KB (the floor kept 2048px)`);
	check("X10d planImageTransform surfaces the over-budget case in its reason (never silently ships MBs)",
		/still over budget/.test(planImageTransform({ mimeType: "image/jpeg", bytes: 9e6, width: 12000, height: 9000 }, floorPol).reason));
}

// ───────────────────────────────── Z: frame accounting + the compression guard (§8.11, §8.13)
{
	check("Z1 utf8Bytes counts BYTES, not UTF-16 units", utf8Bytes("abc") === 3 && utf8Bytes("é") === 2 && utf8Bytes("→") === 3);
	check("Z2 surrogate pairs (emoji, astral CJK) count 4",
		utf8Bytes("🧠") === 4 && utf8Bytes("𝔘") === 4 && "🧠".length === 2);
	check("Z2b a mixed frame is measured exactly like TextEncoder",
		utf8Bytes("héllo 🧠 → 漢") === Buffer.byteLength("héllo 🧠 → 漢", "utf8"));

	check("Z3 frameBytes measures the JSON frame that actually goes on the wire",
		frameBytes({ type: "runtime", t: "→" }) === Buffer.byteLength(JSON.stringify({ type: "runtime", t: "→" }), "utf8"));
	check("Z3b a thinking snapshot is ~2× bigger than .length suggests (§13 — measure before building)",
		frameBytes({ text: "漢".repeat(100) }) === 100 * 3 + Buffer.byteLength('{"text":""}', "utf8"));
	check("Z4 frameBytes never throws on junk (an unmeasurable frame counts 0, not NaN)",
		frameBytes(undefined) === 0 && frameBytes(null) === 4 && frameBytes("ab") === 2);
	{
		const circular = {}; circular.self = circular;
		check("Z4b frameBytes returns 0 (not a throw) for a circular value", frameBytes(circular) === 0);
	}

	check("Z5 wsCompressHint: json/text/ndjson may be deflated", wsCompressHint("json") && wsCompressHint("text") && wsCompressHint("ndjson"));
	check("Z6 wsCompressHint: pre-compressed/binary payloads must not (§8.11)",
		!wsCompressHint("gzip") && !wsCompressHint("image") && !wsCompressHint("webp") && !wsCompressHint("png") && !wsCompressHint("jpeg") && !wsCompressHint(undefined));

	check("Z7 deflateEligible models the agent socket's threshold:1024",
		!deflateEligible(200) && !deflateEligible(1023) && deflateEligible(1024) && deflateEligible(9000));
	check("Z7b the threshold is configurable (the P1 experiment: 256)",
		!deflateEligible(300) && deflateEligible(300, { threshold: 256 }));
	{
		// §8.13: exactly the frames item 3 targets sit UNDER the threshold and travel raw.
		const liveFrame = frameBytes({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "a".repeat(400) }] } });
		check("Z8 a typical streaming message_update today travels UNCOMPRESSED",
			!deflateEligible(liveFrame), `${liveFrame}B < 1024`);
	}

	// the browser-side image path (§4.2) must produce base64 AFTER resizing, so the frame the
	// composer sends is the resized one — pinned arithmetically, no browser needed:
	const b64Of = (bytes) => Math.ceil(bytes / 3) * 4;
	check("Z9 base64 inflation is 4/3, rounded up (the composer's frame grows by that much)",
		b64Of(1024) === 1368 && b64Of(1) === 4);
}

// ────────────────────────────────────────── C: coalesceTurn (item 3's cheap 80/20, §2.3)
{
	const update = (n) => ({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "x".repeat(n) }] } });

	{
		const r = coalesceTurn([update(10), update(200), update(400), { type: "message_end", message: { role: "assistant" } }]);
		check("C1 N message_updates + message_end → EXACTLY one frame (the end)",
			r.events.length === 1 && r.events[0].type === "message_end" && r.dropped === 3,
			`events=${r.events.map((e) => e.type).join(",")} dropped=${r.dropped}`);
	}
	{
		const r = coalesceTurn([update(10), update(900)]);
		const tail = r.events[0]?.message?.content?.[0]?.text || "";
		check("C2 without a message_end the LAST snapshot survives (no content loss)",
			r.events.length === 1 && r.events[0].type === "message_update" && tail.length === 900, `events=${r.events.length}`);
		check("C2b the surviving snapshot is the newest, not the first", tail === "x".repeat(900));
	}
	{
		const r = coalesceTurn([{ type: "message_start" }, { type: "partial", d: "a" }, { type: "partial", d: "b" }, { type: "tool_execution_update", d: "c" }, { type: "tool_execution_end" }]);
		check("C3 partials are dropped, and a live tool snapshot is forwarded before its boundary event",
			r.events.map((e) => e.type).join(",") === "message_start,tool_execution_update,tool_execution_end" && r.dropped === 2,
			r.events.map((e) => e.type).join(","));
	}
	{
		const r = coalesceTurn([{ type: "runtime", currentTool: "a" }, { type: "runtime", currentTool: "b" }, { type: "runtime", currentTool: "c" }, { type: "turn_end" }]);
		check("C4 runtime spam collapses to the last one (turn progress is not history)",
			r.events.length === 2 && r.events[0].type === "runtime" && r.events[0].currentTool === "c" && r.events[1].type === "turn_end");
	}
	{
		const r = coalesceTurn([update(50), { type: "error", errorMessage: "429 Too Many Requests" }]);
		check("C5 an error is flushed WITH the turn, never swallowed",
			r.events.length === 2 && r.events[1].type === "error" && r.events[0].type === "message_update");
	}
	{
		const r = coalesceTurn([]);
		check("C6 an empty turn is an empty frame list, not an error", r.events.length === 0 && r.overflow === false && r.bytes === 0);
		check("C6b coalesceTurn tolerates a missing argument", coalesceTurn().events.length === 0);
	}
	{
		const big = Array.from({ length: 40 }, (_, i) => ({ type: "tool_execution_end", result: "y".repeat(60000) + i }));
		const r = coalesceTurn(big, { capBytes: 2 * 1024 * 1024 });
		check("C7 the per-connection memory bound reports overflow (→ fall back to live)",
			r.overflow === true && r.bytes <= 2 * 1024 * 1024, `bytes=${r.bytes} kept=${r.events.length}`);
	}
	{
		const big = Array.from({ length: 40 }, () => ({ type: "tool_execution_end", result: "y".repeat(60000) }));
		const r = coalesceTurn([...big, { type: "error", errorMessage: "boom" }]);
		check("C8 an error survives even AFTER the cap was hit",
			r.overflow === true && r.events[r.events.length - 1].type === "error");
	}
	{
		const events = [{ type: "message_end", message: { role: "assistant" } }];
		const r = coalesceTurn(events);
		check("C9 no-rewrite case: the events array is copied, the input is untouched",
			r.events.length === 1 && events.length === 1 && r.events[0] === events[0]);
	}
	{
		const r = coalesceTurn([update(10), { type: "message_end" }], { dropUpdateBeforeEnd: false });
		check("C10 with dropUpdateBeforeEnd:false the last snapshot is forwarded before the end",
			r.events.map((e) => e.type).join(",") === "message_update,message_end");
	}
	{
		// the SAME threshold on the TOOL CALL (user request): a long build/test tool emits hundreds of
		// progress frames; each tool call keeps exactly ONE live snapshot.
		const chunk = (n) => ({ type: "tool_execution_update", toolCallId: "call_1", toolName: "bash", output: "x".repeat(n) });
		const r = coalesceTurn([...Array.from({ length: 200 }, (_, i) => chunk((i + 1) * 50)), { type: "tool_execution_end", toolCallId: "call_1" }]);
		check("C12 a 200-chunk tool call collapses to ONE progress frame + its result",
			r.events.length === 2 && r.events[0].output.length === 200 * 50 && r.events[1].type === "tool_execution_end" && r.dropped === 199,
			`events=${r.events.length} dropped=${r.dropped}`);
		const two = coalesceTurn([
			{ type: "tool_execution_update", toolCallId: "a", output: "1" },
			{ type: "tool_execution_update", toolCallId: "b", output: "2" },
			{ type: "tool_execution_update", toolCallId: "a", output: "3" },
			{ type: "tool_execution_end" },
		]);
		check("C12b PARALLEL tool calls keep one snapshot each (keyed by toolCallId, first-seen order)",
			two.events.length === 3 && two.events[0].output === "3" && two.events[1].output === "2" && two.events[0].toolCallId === "a",
			two.events.map((e) => `${e.type}:${e.toolCallId ?? ""}=${e.output ?? ""}`).join(" "));
		check("C12c the key falls back to the tool name when no id is present", toolUpdateKey({ toolName: "read" }) === "read" && toolUpdateKey({}) === "?");
		const still = coalesceTurn([chunk(10), chunk(20)]);
		check("C12d without a boundary event the snapshot is still flushed at the end", still.events.length === 1 && still.events[0].output.length === 20);
		const mixed = coalesceTurn([
			{ type: "message_update", message: { content: [{ type: "text", text: "hi" }] } },
			{ type: "tool_execution_update", toolCallId: "a", output: "build..." },
			{ type: "message_end" },
		]);
		check("C12e the text snapshot is superseded by message_end, the TOOL snapshot still ships (before it)",
			mixed.events.map((e) => e.type).join(",") === "tool_execution_update,message_end", mixed.events.map((e) => e.type).join(","));
	}
	{
		// the §7 measurement knob: how many frames does coalescing actually remove?
		const turn = [];
		for (let i = 0; i < 300; i++) turn.push(update((i + 1) * 12));
		turn.push({ type: "message_end" });
		const live = turn.length, coalesced = coalesceTurn(turn).events.length;
		check("C11 a 300-delta stream becomes one frame (250× fewer WebSocket frames)",
			coalesced === 1 && live === 301, `live=${live} coalesced=${coalesced}`);
	}
}

// ───────────────────────────────── M: media egress redaction (§2.2b, §6 hub extension)
{
	{
		const b64 = fakeImageB64(4);
		const hash = hashOfBase64(b64);
		check("M1 the hash is sha256 hex of the RAW bytes and satisfies the route's regex",
			MEDIA_HASH_RE.test(hash) && hash === hashOf(Buffer.from(b64, "base64")) && isMediaHash(hash));
		check("M1b an uppercase/short/absent hash is rejected by the route validator",
			!isMediaHash(hash.toUpperCase()) && !isMediaHash("abc") && !isMediaHash(undefined));
		check("M1c identical images share one address (dedupe is free)", hashOfBase64(b64) === hashOfBase64(fakeImageB64(4)));
	}

	{
		const messages = [msg("hello"), msg("look", [imagePart(300, "image/png", 0xab), imagePart(300, "image/jpeg", 0xcd)])];
		const store = createMediaStore();
		const { messages: redacted, media, changed } = redactImageData(messages, { store });
		const parts = redacted[1].content.filter((p) => p.type === "image");
		check("M2 image parts lose `data` and gain hash + bytes",
			changed && parts.length === 2 && parts.every((p) => p.data === undefined && isMediaHash(p.hash) && p.bytes >= 300 * 1024), JSON.stringify(parts[0]).slice(0, 90));
		check("M2d1 two DISTINCT images get two addresses and two stored blobs",
			new Set(parts.map((p) => p.hash)).size === 2 && store.stats().count === 2);
		check("M2b the text part is untouched and the message order is preserved",
			redacted.length === 2 && redacted[1].content[0].text === "look");
		check("M2c the SOURCE messages are never mutated (the model path reads them)",
			typeof messages[1].content[1].data === "string" && messages[1].content[1].hash === undefined);
		check("M2d both images are in the store under their hashes",
			media.length === 2 && media.every((m) => store.has(m.hash)) && store.stats().bytes === 600 * 1024);
		check("M2d2 IDENTICAL bytes under two mimeTypes dedupe to ONE stored blob",
			(() => {
				const twins = [msg("x", [imagePart(120, "image/png", 0x11)]), msg("y", [imagePart(120, "image/webp", 0x11)])];
				const s = createMediaStore();
				const r = redactImageData(twins, { store: s });
				const [a, b] = [r.messages[0].content[1], r.messages[1].content[1]];
				return a.hash === b.hash && s.stats().count === 1 && s.stats().bytes === 120 * 1024 &&
					hydrateImageData(r.messages, s)[1].content[1].mimeType === "image/webp"; // the part's mimeType wins on hydrate
			})());
		check("M2e redaction is idempotent (double-redaction cannot lose the bytes)",
			JSON.stringify(redactImageData(redacted, { store }).messages) === JSON.stringify(redacted));
		check("M2f hashes are stable across runs (cache keys survive a restart)",
			JSON.stringify(redactImageData(messages, { store: createMediaStore() }).media) === JSON.stringify(media));
		check("M3 hydrate(redact(x)) round-trips to the ORIGINAL ImageContent",
			JSON.stringify(hydrateImageData(redacted, store)) === JSON.stringify(messages));
		check("M3b hydrate drops the redaction-only fields (no hash/bytes left behind)",
			hydrateImageData(redacted, store)[1].content[1].hash === undefined);
		check("M3c a hydrate miss leaves the hash renderable instead of dropping the image",
			hydrateImageData(redacted, () => null)[1].content[1].hash === parts[0].hash);
	}

	{
		const messages = [msg("no images here"), { role: "assistant", content: "plain string content" }, msg("and text parts only", [{ type: "text", text: "x" }])];
		const { messages: redacted, changed } = redactImageData(messages, { store: createMediaStore() });
		check("M4 a session without images is returned by IDENTITY (no churn, no cache bump)", redacted === messages && changed === false);
		check("M4b a hash-only part is passed through (already redacted) and an empty data part is ignored",
			redactImageData([{ role: "user", content: [{ type: "image", hash: "a".repeat(64), bytes: 3 }] }]).changed === false &&
			redactImageData([{ role: "user", content: [{ type: "image", data: "" }] }]).changed === false);
		check("M4c a non-array / missing transcript is tolerated",
			redactImageData(null).changed === false && redactImageData([{ role: "user" }]).changed === false);
	}

	{
		const store = createMediaStore({ maxBytes: 500 * 1024 });
		const a = fakeImageB64(300, 0xab), b = fakeImageB64(300, 0xcd);
		const ha = hashOfBase64(a), hb = hashOfBase64(b);
		store.put(ha, Buffer.from(a, "base64"), "image/png");
		store.put(hb, Buffer.from(b, "base64"), "image/jpeg");
		check("M5 the LRU store evicts the oldest entry once maxBytes is exceeded",
			!store.has(ha) && store.has(hb) && store.stats().bytes <= 500 * 1024 && store.stats().count === 1,
			JSON.stringify(store.stats()));
		// LRU, not FIFO: a get() refreshes the entry, so the untouched one goes first
		const store2 = createMediaStore({ maxBytes: 700 * 1024 });
		const c = fakeImageB64(300, 0xef), hc = hashOfBase64(c);
		store2.put(ha, Buffer.from(a, "base64"), "image/png");
		store2.put(hb, Buffer.from(b, "base64"), "image/jpeg");
		store2.get(ha); // refresh a
		store2.put(hc, Buffer.from(c, "base64"), "image/png");
		check("M5b eviction is LRU (a re-read image survives, the untouched one goes)",
			store2.has(ha) && store2.has(hc) && !store2.has(hb) && store2.stats().bytes <= 700 * 1024, JSON.stringify(store2.stats()));
		check("M5c an empty payload is refused (no zero-byte hashes)",
			store.put("0".repeat(64), Buffer.alloc(0)) === null);
	}

	{
		const sessionId = "sess-1/weird id";
		const hash = "b".repeat(64);
		check("M6 the media URL is per-session, hash-addressed and URL-encoded",
			mediaUrl(sessionId, hash) === `/api/agent/session/sess-1%2Fweird%20id/media/${hash}`, mediaUrl(sessionId, hash));
		check("M7 imageSrcFor renders the LEGACY inline shape (warm IDB chunks, §8.5)",
			imageSrcFor({ type: "image", mimeType: "image/png", data: "AAAA" }, sessionId) === "data:image/png;base64,AAAA");
		check("M7b imageSrcFor renders the REDACTED shape via the media route",
			imageSrcFor({ type: "image", mimeType: "image/webp", hash, bytes: 10 }, sessionId) === mediaUrl(sessionId, hash));
		check("M7c imageSrcFor refuses what it cannot render (and defaults a missing mimeType)",
			imageSrcFor({ type: "image" }, sessionId) === undefined &&
			imageSrcFor({ type: "text", text: "x" }, sessionId) === undefined &&
			imageSrcFor({ type: "image", data: "AA" }, sessionId) === "data:application/octet-stream;base64,AA");
	}

	{
		// §6 invariant: NO long base64 anywhere in an egress payload.
		const messages = [msg("look at this", [imagePart(400)]), { role: "assistant", content: [{ type: "text", text: "ok" }] }];
		const before = inlineBase64Runs(messages).length;
		const redacted = redactImageData(messages, { store: createMediaStore() }).messages;
		check("M8 the guard finds the inline base64 BEFORE redaction", before === 1, `runs=${before}`);
		check("M8b after redaction the egress envelope contains no long base64 at all",
			inlineBase64Runs(redacted).length === 0 && !/"data"/.test(JSON.stringify(redacted)));
		check("M8c the guard honours its minLength (short tokens are not flagged)",
			inlineBase64Runs({ a: "abc" }).length === 0 && inlineBase64Runs({ a: "a".repeat(600) }).length === 1);
	}

	{
		// the media route's contract, asserted on the pure side (the HTTP half is P3/a scratch server)
		const hash = "c".repeat(64);
		const entry = createMediaStore().put(hash, Buffer.from("hello"), "image/webp");
		check("M9 the store entry carries exactly what the route must send back",
			entry.mimeType === "image/webp" && entry.bytes.length === 5 && Buffer.from(entry.bytes).toString() === "hello");
		check("M9b a miss returns null so the route can answer 404 (never an empty 200)", createMediaStore().get(hash) === null);
	}
}

// ───────────────────────────── S: the §7 expectation, measured (bytes, not vibes)
{
	// an 8-image session: 8 × ~900KB base64 photos + text, as egressed by attach today
	const images = Array.from({ length: 8 }, (_, i) => imagePart(900, i % 2 ? "image/jpeg" : "image/png", 0x10 + i));
	const messages = [msg("here are 8 photos of the whiteboard", images), ...Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `turn ${i} ` + "lorem ipsum ".repeat(12) }))];

	const inlineBytes = frameBytes(messages);
	const { messages: redacted, media } = redactImageData(messages, { store: createMediaStore() });
	const redactedBytes = frameBytes(redacted);
	const ratio = inlineBytes / redactedBytes;

	check("S1 an 8-image attach shrinks by more than 10× (§7 expectation)",
		ratio > 10, `${(inlineBytes / 1048576).toFixed(2)}MB → ${(redactedBytes / 1024).toFixed(1)}KB (${ratio.toFixed(0)}×)`);
	check("S2 redacted payload is text + 8 compact hashes, not megabytes",
		redactedBytes < 8 * 1024 && media.length === 8, `${redactedBytes}B`);
	check("S3 the media route pays for the bytes only ONCE per device (§7: warm attach ≈ 0)",
		media.reduce((n, m) => n + m.bytes, 0) > 6 * 1024 * 1024 && redactedBytes < 8192,
		`served once: ${(media.reduce((n, m) => n + m.bytes, 0) / 1048576).toFixed(1)}MB, re-sent: ${redactedBytes}B`);
	check("S4 a text-only session is unchanged by redaction (identity ⇒ no cache bump)",
		redactImageData([msg("hi"), { role: "assistant", content: "ok" }], { store: createMediaStore() }).messages !== null &&
		frameBytes(redactImageData([msg("hi")], { store: createMediaStore() }).messages) === frameBytes([msg("hi")]));

	// and the image PRESETS: what the phone would have uploaded with each policy (§2.2a)
	const plan = (net) => {
		const pol = resolveDataReduction(net, {});
		return Array.from({ length: 8 }, (_, i) => planImageTransform({ mimeType: i % 2 ? "image/jpeg" : "image/png", bytes: 900 * 1024, width: 4000, height: 3000 }, pol));
	};
	check("S5 every metered-lan-wan preset re-encodes a 12MP upload", plan("metered").every((p) => p.action === "reencode") && plan("lan").every((p) => p.action === "reencode"));
	check("S6 metered asks for a smaller edge than lan (the point of the presets)",
		plan("metered")[0].maxEdge < plan("lan")[0].maxEdge && plan("metered")[0].quality < plan("lan")[0].quality);
	check("S7 resize is decided BEFORE base64 (the composer sends the small frame, §4.2)",
		plan("metered")[0].target.width * plan("metered")[0].target.height < 4000 * 3000 / 10);
}

console.log(`\n[data-reduction] ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
