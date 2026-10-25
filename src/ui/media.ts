// media.ts — the browser side of EGRESS MEDIA (plan §2.2b): transcripts now arrive with image parts
// reduced to `{type:"image", mimeType, hash, bytes}`, and the bytes live behind
// GET /api/agent/session/:id/media/:hash (auth-gated, immutable, content-addressed).
//
// Two shapes must work forever (plan §8.5): a warm IDB chunk written before the change still carries
// inline `data`, and a freshly attached transcript carries `hash`. Everything here accepts both.
//
// WHO NEEDS THE BYTES (and therefore must hydrate):
//   * retry / edit-and-resubmit — re-prompts the model with the user's images;
//   * stop/edit steering recall  — puts the pending steer's images back in the composer;
//   * rendering (a thumbnail)    — an <img src> can point straight at the media URL (no base64!),
//                                  that is what imageSrcOf() is for.
// Nobody else: the renderer reads `text`/`thinking`/`toolCall` parts, and the model path runs in
// the SERVER process against the unredacted transcript.
import { imageSrcFor, isMediaHash, mediaUrl } from "../../lib/data-reduction.mjs";
import { getToken } from "../server-auth.js";

/** hash → base64 (per session, capped: a phone should not pin 8 photos in memory forever). */
const dataCache = new Map<string, { data: string; mimeType: string }>();
const MAX_CACHE = 24;

function remember(key: string, value: { data: string; mimeType: string }) {
	if (dataCache.size >= MAX_CACHE) dataCache.delete(dataCache.keys().next().value as string);
	dataCache.set(key, value);
	return value;
}

/** The session id the media route needs. Prefers the live agent, falls back to the URL. */
export function currentSessionId(agent?: unknown): string {
	const fromAgent = (agent as { currentSessionId?: string } | undefined)?.currentSessionId;
	if (fromAgent) return fromAgent;
	try {
		const m = location.pathname.match(/\/s\/([^/?#]+)/);
		if (m) return decodeURIComponent(m[1]);
	} catch { /* no location (tests) */ }
	try { return localStorage.getItem("pi.lastSession") || ""; } catch { return ""; }
}

/** base64/mimeType for ONE image part: inline when present, else fetched (and cached) by hash. */
export async function imageDataFor(part: any, sessionId: string): Promise<{ data: string; mimeType: string } | null> {
	if (!part || (part.type && part.type !== "image")) return null;
	if (typeof part.data === "string" && part.data) return { data: part.data, mimeType: part.mimeType || "image/png" };
	if (!isMediaHash(part.hash)) return null;
	const key = `${sessionId}:${part.hash}`;
	const hit = dataCache.get(key);
	if (hit) return hit;
	try {
		const r = await fetch(mediaUrl(sessionId, part.hash), {
			headers: getToken() ? { "x-pi-web-token": getToken() } : undefined,
			signal: AbortSignal.timeout(8000),
		});
		if (!r.ok) return null;
		const buf = new Uint8Array(await r.arrayBuffer());
		let bin = "";
		for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
		return remember(key, { data: btoa(bin), mimeType: r.headers.get("content-type") || part.mimeType || "image/png" });
	} catch { return null; }
}

/** Fill `data` on every image part that needs it (both shapes accepted). Order is preserved. */
export async function hydrateImageParts(parts: any[], sessionId: string): Promise<any[]> {
	const out = await Promise.all((parts || []).map(async (p) => {
		if (p?.type !== "image") return p;
		if (typeof p.data === "string" && p.data) return p;
		const got = await imageDataFor(p, sessionId);
		return got ? { ...p, data: got.data, mimeType: p.mimeType || got.mimeType } : p;
	}));
	return out;
}

/** A renderable src for an image part — a data URL for legacy chunks, the media URL otherwise. */
export function imageSrcOf(part: any, sessionId: string): string | undefined {
	return imageSrcFor(part, sessionId);
}

/** Test/debug hook: forget the base64 cache (a session switch must not leak across sessions). */
export function clearMediaCache(): void {
	dataCache.clear();
}
