// image-encode.ts — the BROWSER half of the image policy (Settings → Data use → Images).
//
// The decision is pure and tested (`planImageTransform`/`planResizeTarget` in
// lib/data-reduction.mjs, kept honest by tests/data-reduction.test.mjs); the pixels must live here,
// because only a canvas can produce them. Three rules keep this cheap on a phone:
//
//   1. NO decode when the file already fits the byte budget — a screenshot never materialises;
//   2. ONE decode, capped on the X axis: `createImageBitmap` preserves the aspect ratio when a single
//      axis is given, so a 12MP photo is never fully materialised (the low-end-iOS OOM trap);
//   3. the re-encode is kept only when it actually beats the original.
//
// The encoded bytes then go up as BINARY (`POST …/media`, see uploadImage) and the prompt references
// them by hash — no base64 on the wire, in the transcript, or in the session file. If the upload
// fails the caller keeps the base64 and the old inline path still works.

import { IMAGE_PRESETS, PASSTHROUGH_MIME, planImageTransform } from "../lib/data-reduction.mjs";
import { mediaUploadHeaders, resolvedImagePolicy } from "./ui/data-settings.js";
import { getToken } from "./server-auth.js";

export type ImagePolicy = ReturnType<typeof resolvedImagePolicy>;

export type EncodedImage = {
	blob: Blob;
	mimeType: string;
	bytes: number;
	width: number;
	height: number;
	resized: boolean;
	note: string | null;
};

export type UploadedImage = { hash: string; mimeType: string; bytes: number };

/** The server's cap for one uploaded image (POST …/media refuses more). */
const MAX_UPLOAD = 8 * 1024 * 1024;

/** `canvas.toBlob`/`convertToBlob` in one place: OffscreenCanvas is promise-based, a <canvas> callback. */
function toBlob(canvas: OffscreenCanvas | HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
	const any = canvas as unknown as { convertToBlob?: (o: { type: string; quality: number }) => Promise<Blob> };
	if (typeof any.convertToBlob === "function") return any.convertToBlob({ type, quality }).catch(() => null);
	return new Promise((resolve) => {
		try { (canvas as HTMLCanvasElement).toBlob((b) => resolve(b), type, quality); } catch { resolve(null); }
	});
}

/**
 * Apply the image policy to ONE fresh attachment. Never throws and never inflates: on any failure the
 * ORIGINAL blob is returned with `resized: false` and (when it had to give up) a note for the user.
 */
export async function encodeForModel(file: Blob & { name?: string }, policy: ImagePolicy = resolvedImagePolicy()): Promise<EncodedImage> {
	const mimeType = file.type || "image/png";
	const bytes = file.size || 0;
	const original: EncodedImage = { blob: file, mimeType, bytes, width: 0, height: 0, resized: false, note: null };
	if (!bytes) return original;
	// 1) the escape hatch ("none"/original), a format we must not touch, or a file that already fits
	if (policy?.mode === "original" || PASSTHROUGH_MIME.test(mimeType)) return original;
	const budget = policy?.maxBytes || IMAGE_PRESETS.wan.maxBytes;
	if (bytes <= budget && policy?.mode !== "always") return original;
	if (typeof createImageBitmap !== "function") return original; // no canvas support: send as-is

	const cap = Math.max(64, Math.round(policy?.maxEdge || IMAGE_PRESETS.wan.maxEdge));
	// 2) one capped decode. A portrait source can still come out taller than the cap (only the X axis
	// bound was applied), which the plan below then trims — one extra resample, never a full decode.
	let bmp: ImageBitmap | null = await createImageBitmap(file, { imageOrientation: "from-image", resizeWidth: cap, resizeQuality: "high" }).catch(() => null);
	if (!bmp) bmp = await createImageBitmap(file, { imageOrientation: "from-image" }).catch(() => null);
	if (!bmp) return { ...original, note: "couldn't decode this image — sending it unchanged" };
	try {
		const plan = planImageTransform({ mimeType, bytes, width: bmp.width, height: bmp.height }, policy);
		if (plan.action !== "reencode" || !plan.target) return original;
		const { target, quality } = plan;
		const canvas = typeof OffscreenCanvas === "function"
			? new OffscreenCanvas(target.width, target.height)
			: Object.assign(document.createElement("canvas"), { width: target.width, height: target.height });
		const ctx = (canvas as HTMLCanvasElement).getContext("2d");
		if (!ctx) return original;
		ctx.drawImage(bmp, 0, 0, target.width, target.height);
		// webp first (the planned format), jpeg when the browser answers with something else
		let blob = await toBlob(canvas, "image/webp", quality);
		if (!blob || !(blob.type || "").includes("webp")) blob = await toBlob(canvas, "image/jpeg", quality);
		// 3) keep it only if it is genuinely smaller and still uploadable
		if (!blob || !blob.size || blob.size >= bytes || blob.size > MAX_UPLOAD) return original;
		return { blob, mimeType: blob.type || "image/webp", bytes: blob.size, width: target.width, height: target.height, resized: true, note: plan.reason };
	} catch {
		return original;
	} finally {
		(bmp as unknown as { close?: () => void })?.close?.();
	}
}

/** POST the encoded bytes — the content address comes back, and no base64 ever travels up. */
export async function uploadImage(blob: Blob, mimeType: string, sessionId: string): Promise<UploadedImage | null> {
	if (!blob?.size || !sessionId) return null;
	try {
		const token = getToken();
		const r = await fetch(`/api/agent/session/${encodeURIComponent(sessionId)}/media`, {
			method: "POST",
			headers: { ...mediaUploadHeaders(mimeType || blob.type || "image/png"), ...(token ? { "x-pi-web-token": token } : {}) },
			body: blob,
			signal: AbortSignal.timeout(20000),
		});
		if (!r.ok) return null;
		const j = await r.json();
		return j?.hash ? { hash: String(j.hash), mimeType: String(j.mimeType || mimeType), bytes: Number(j.bytes) || blob.size } : null;
	} catch {
		return null; // offline / older server: the caller keeps the base64 fallback
	}
}

/** base64 of a blob — for the composer's inline fallback and the chip preview. */
export function blobToBase64(blob: Blob): Promise<string> {
	return new Promise((resolve) => {
		try {
			const fr = new FileReader();
			fr.onload = () => { const s = String(fr.result || ""); resolve(s.slice(s.indexOf(",") + 1)); };
			fr.onerror = () => resolve("");
			fr.readAsDataURL(blob);
		} catch { resolve(""); }
	});
}

/** The inverse, for sources that arrive as base64 (the file picker, a forwarded import frame). */
export function base64ToBlob(base64: string, mimeType = "image/png"): Blob {
	try {
		const bin = atob(base64 || "");
		const buf = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
		return new Blob([buf], { type: mimeType || "image/png" });
	} catch {
		return new Blob([], { type: mimeType || "image/png" });
	}
}
