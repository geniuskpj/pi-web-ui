// image-encode.ts — the BROWSER half of the image policy (Settings → Data use → Images).
//
// The decision is pure and tested (`planImageTransform`/`planResizeTarget` in
// lib/data-reduction.mjs, kept honest by tests/data-reduction.test.mjs); the pixels must live here,
// because only a canvas can produce them. Four rules keep this cheap on a phone:
//
//   1. the SIZE comes from the container header (`lib/image-dims.mjs`) — no decoder, no pixels;
//   2. NO decode at all when BOTH budgets are satisfied (a screenshot never materialises);
//   3. ONE decode, capped on the source's own width: `createImageBitmap` preserves the aspect ratio
//      when a single axis is given, so a 12MP photo is never fully materialised (the low-end-iOS OOM
//      trap) and a narrow source is never upscaled (a resize axis is a TARGET, not a maximum);
//   4. the re-encode replaces the original when it is smaller — or when the source was over the
//      resolution cap and the result at least fits the byte budget.
//
// The encoded bytes then go up as BINARY (`POST …/media`, see uploadImage) and the prompt references
// them by hash — no base64 on the wire, in the transcript, or in the session file. If the upload
// fails the caller keeps the base64 and the old inline path still works.

import { IMAGE_PRESETS, PASSTHROUGH_MIME, planImageTransform } from "../lib/data-reduction.mjs";
import { imageDims } from "../lib/image-dims.mjs";
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
	// 1) the escape hatch ("none"/original) or a format we must not touch
	if (policy?.mode === "original" || PASSTHROUGH_MIME.test(mimeType)) return original;

	// 2) the header gives the real size — so BOTH budgets are checked without a decoder. Unknown
	// formats (exotic/truncated) fall through to the decode, which sees the true size anyway.
	const cap = Math.max(64, Math.round(policy?.maxEdge || IMAGE_PRESETS.wan.maxEdge));
	const budget = policy?.maxBytes || IMAGE_PRESETS.wan.maxBytes;
	const header = await headerDims(file);
	if (header) {
		const pre = planImageTransform({ mimeType, bytes, ...header }, policy);
		if (pre.action !== "reencode") return { ...original, width: header.width, height: header.height };
	} else if (bytes <= budget && policy?.mode !== "always") {
		return original; // no header to trust: the byte budget alone decides
	}
	if (typeof createImageBitmap !== "function") return original; // no canvas support: send as-is

	// 3) ONE decode, capped on the SOURCE width (a resize axis is a target, so this never upscales). A
	// portrait source can still come out taller than the cap; the plan trims it — one extra resample,
	// never a full 12MP materialisation.
	const decodeCap = header ? Math.min(cap, Math.max(1, header.width)) : cap;
	let bmp: ImageBitmap | null = await createImageBitmap(file, { imageOrientation: "from-image", resizeWidth: decodeCap, resizeQuality: "high" }).catch(() => null);
	if (!bmp) bmp = await createImageBitmap(file, { imageOrientation: "from-image", resizeWidth: cap, resizeQuality: "high" }).catch(() => null);
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
		// the target came from the bitmap's own dims, so the aspect ratio is preserved by construction
		ctx.drawImage(bmp, 0, 0, target.width, target.height);
		// webp first (the planned format), jpeg when the browser answers with something else
		let blob = await toBlob(canvas, "image/webp", quality);
		if (!blob || !(blob.type || "").includes("webp")) blob = await toBlob(canvas, "image/jpeg", quality);
		if (!blob || !blob.size || blob.size > MAX_UPLOAD) return original;
		// 4) replace the original when the encode is smaller. It may be a little bigger when the source
		// was over the RESOLUTION cap (that cap is about what the model sees, not bytes) — accept it as
		// long as it stays inside the byte budget, which is the number the user chose.
		const overEdge = target.width < bmp.width || target.height < bmp.height;
		if (blob.size >= bytes && !(overEdge && blob.size <= budget)) return original;
		return { blob, mimeType: blob.type || "image/webp", bytes: blob.size, width: target.width, height: target.height, resized: true, note: plan.reason };
	} catch {
		return original;
	} finally {
		(bmp as unknown as { close?: () => void })?.close?.();
	}
}

/** The first 64KB of the file, parsed for its size — enough for every JPEG SOF in practice. */
async function headerDims(file: Blob): Promise<{ width: number; height: number; format: string } | null> {
	try {
		const head = await file.slice(0, 64 * 1024).arrayBuffer();
		const dims = imageDims(new Uint8Array(head));
		return dims && dims.width > 0 && dims.height > 0 ? dims : null;
	} catch {
		return null; // slice/arrayBuffer unavailable: the decode path below still gets the real size
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
