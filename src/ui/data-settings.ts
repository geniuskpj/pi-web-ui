// data-settings.ts — the browser side of the data-reduction LEVELS (user request 2026-10-25:
// "Add two data reducing option/preset for each image, text … Show param when it is selected.
//  Let browser could select it and save it in localStorage").
//
// This file is deliberately THIN: every decision (which level, what the thresholds are, what the
// settings dialog should print) lives in the tested pure layer —
//   lib/data-reduction.mjs  → images (high · medium · low · none, + auto)
//   lib/thinking-flush.mjs  → reasoning/answer/tool output (paragraph · turnEnd · none, + auto)
// — so the UI cannot drift from the numbers the tests pin. Here we only map localStorage keys
// (the pi.autoRetry pattern) onto those functions and push the result to the hub when it supports it.
import {
	IMAGE_LEVELS, IMAGE_PRESETS, resolveDataReduction, describeImagePolicy, imageLevelOptions, imageLevelForNet,
} from "../../lib/data-reduction.mjs";
import {
	THINKING_LEVELS, resolveThinkingPolicy, resolveStreamPolicy, describeStreamPolicy,
	thinkingLevelOptions, shortStreamParams,
} from "../../lib/thinking-flush.mjs";

/** localStorage keys (same shape as pi.autoRetry / pi.autoRetryAttempts). */
/** WHERE a session image is kept (user decision 2026-10-25): server disk store = default, so every
 *  device can render it and the model can be re-run on it; "browser" keeps the bytes on the device
 *  (the server holds them in memory only, and the client re-uploads if it ever needs them back). */
export const IMAGE_RETENTION = ["server", "browser"] as const;
export type ImageRetention = (typeof IMAGE_RETENTION)[number];
export const DEFAULT_IMAGE_RETENTION: ImageRetention = "server";

/** The header the composer sends with POST …/media so the server knows what to persist. */
export const MEDIA_RETENTION_HEADER = "x-pi-media-retention";

export const DATA_SETTING_KEYS = {
	imageRetention: "pi.imageRetention",
	imageLevel: "pi.imageLevel",
	thinkingLevel: "pi.thinkingLevel",
	textLevel: "pi.textLevel",
	toolLevel: "pi.toolLevel",
	imageMaxEdge: "pi.imageMaxEdge",
	imageMinEdge: "pi.imageMinEdge",
	imageMaxBytes: "pi.imageMaxBytes",
	imageQuality: "pi.imageQuality",
} as const;

/** The link tier this browser last saw (written by proxy-agent's health probe; "wan" = conservative). */
export const NET_TIER_KEY = "pi.netTier";

const read = (key: string): string | null => {
	try { return localStorage.getItem(key); } catch { return null; }
};
const write = (key: string, value: string): void => {
	try { localStorage.setItem(key, value); } catch { /* private mode / quota */ }
};

/** Everything the resolver needs, read once (the values the dialog edits). */
export function readDataSettings(): Record<string, string | undefined> {
	const out: Record<string, string | undefined> = {};
	for (const [name, key] of Object.entries(DATA_SETTING_KEYS)) {
		const v = read(key);
		if (v) out[name] = v;
	}
	return out;
}

export function readNetTier(): string {
	return read(NET_TIER_KEY) || "wan";
}

export function setImageLevel(level: string): string {
	write(DATA_SETTING_KEYS.imageLevel, level);
	return level;
}

/** "server" (default) or "browser" — anything unrecognised falls back to the safe default. */
export function readImageRetention(): ImageRetention {
	const v = read(DATA_SETTING_KEYS.imageRetention);
	return (IMAGE_RETENTION as readonly string[]).includes(String(v)) ? (v as ImageRetention) : DEFAULT_IMAGE_RETENTION;
}

export function setImageRetention(value: string): ImageRetention {
	const v = (IMAGE_RETENTION as readonly string[]).includes(value) ? (value as ImageRetention) : DEFAULT_IMAGE_RETENTION;
	write(DATA_SETTING_KEYS.imageRetention, v);
	return v;
}

/** The headers a media upload must carry (retention + auth are added by the caller's helper). */
/** The per-kind numbers the hub needs (never the resolved `kind`/`net` bookkeeping). */
function pickStreamNumbers(p: Record<string, any>): Record<string, number | string> {
	return { mode: p.mode, minBytes: p.minBytes, maxBytes: p.maxBytes, maxLines: p.maxLines, idleMs: p.idleMs, maxHoldMs: p.maxHoldMs, firstBytes: p.firstBytes };
}

export function mediaUploadHeaders(mimeType: string): Record<string, string> {
	return { "Content-Type": mimeType, [MEDIA_RETENTION_HEADER]: readImageRetention() };
}

export function setThinkingLevel(level: string): string {
	write(DATA_SETTING_KEYS.thinkingLevel, level);
	return level;
}

/** The resolved IMAGE policy (what the composer will apply before uploading a file). */
export function resolvedImagePolicy(net = readNetTier()) {
	return resolveDataReduction(net, readDataSettings());
}

/** The resolved policy for one stream kind ("thinking" | "text" | "tool"). */
export function resolvedStreamPolicy(kind: "thinking" | "text" | "tool" = "thinking", net = readNetTier()) {
	return resolveStreamPolicy(kind, net, readDataSettings());
}

/**
 * Tell the hub what this connection wants. The thinking text/tool thresholds are applied
 * SERVER-side (the hub pumps the deltas), so — exactly like set-auto-retry — the level travels
 * per connection. Optional-call shape: an older server simply ignores it.
 */
export function pushDataReduction(agent: unknown): void {
	const a = agent as { setDataReduction?: (cfg: unknown) => void } | undefined;
	const thinking = resolvedStreamPolicy("thinking");
	const net = readNetTier();
	void a?.setDataReduction?.({
		net, // the hub resolves the per-tier thresholds itself when a kind payload is missing
		imageLevel: resolvedImagePolicy().level,
		imageRetention: readImageRetention(),
		thinkingLevel: thinking.level,
		stream: resolveDataReduction(readNetTier(), readDataSettings()).stream,
		// firstBytes travels too: the immediate first frame is what keeps a coalescing policy from reading
		// as a latency regression (2026-10-27), and it is per kind (text paints sooner than tool output).
		thinking: pickStreamNumbers(thinking),
		text: pickStreamNumbers(resolvedStreamPolicy("text")),
		tool: pickStreamNumbers(resolvedStreamPolicy("tool")),
	});
}

export {
	IMAGE_LEVELS, THINKING_LEVELS, IMAGE_PRESETS, imageLevelOptions, imageLevelForNet,
	thinkingLevelOptions, describeImagePolicy, describeStreamPolicy, shortStreamParams,
};
