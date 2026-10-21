/**
 * Replacement for @earendil-works/pi-web-ui/dist/utils/attachment-utils.js
 *
 * Slim build: DOCX / PPTX / XLSX support removed (per user request).
 * Kept: PDF (with text extraction + preview), images, text files.
 * NOTE: pdfjs worker must be configured globally by the app (workerSrc) —
 * the original new URL("pdfjs-dist/...", import.meta.url) trick does not
 * survive bundling without a bundler-specific transform.
 */
import * as pdfjsLib from "pdfjs-dist";
import { i18n } from "./i18n.js";

const OFFICE_REMOVED =
	"Office formats (DOCX/PPTX/XLSX) are removed in this slim build. " +
	"Supported: PDF, images, and text files.";

/**
 * Load an attachment from various sources
 * @param {string|File|Blob|ArrayBuffer} source
 * @param {string} [fileName]
 * @returns {Promise<import("../components/Messages.js").Attachment>}
 */
export async function loadAttachment(source, fileName) {
	let arrayBuffer;
	let detectedFileName = fileName || "unnamed";
	let mimeType = "application/octet-stream";
	let size = 0;

	if (typeof source === "string") {
		const response = await fetch(source);
		if (!response.ok) {
			throw new Error(i18n("Failed to fetch file"));
		}
		arrayBuffer = await response.arrayBuffer();
		size = arrayBuffer.byteLength;
		mimeType = response.headers.get("content-type") || mimeType;
		if (!fileName) {
			const urlParts = source.split("/");
			detectedFileName = urlParts[urlParts.length - 1] || "document";
		}
	} else if (source instanceof File) {
		arrayBuffer = await source.arrayBuffer();
		size = source.size;
		mimeType = source.type || mimeType;
		detectedFileName = fileName || source.name;
	} else if (source instanceof Blob) {
		arrayBuffer = await source.arrayBuffer();
		size = source.size;
		mimeType = source.type || mimeType;
	} else if (source instanceof ArrayBuffer) {
		arrayBuffer = source;
		size = source.byteLength;
	} else {
		throw new Error(i18n("Invalid source type"));
	}

	// Reject office formats up-front with a clear message
	const lower = detectedFileName.toLowerCase();
	if (
		mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
		mimeType === "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
		mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
		mimeType === "application/vnd.ms-excel" ||
		lower.endsWith(".docx") ||
		lower.endsWith(".pptx") ||
		lower.endsWith(".xlsx") ||
		lower.endsWith(".xls")
	) {
		throw new Error(OFFICE_REMOVED);
	}

	// Convert ArrayBuffer to base64
	const uint8Array = new Uint8Array(arrayBuffer);
	let binary = "";
	const chunkSize = 0x8000;
	for (let i = 0; i < uint8Array.length; i += chunkSize) {
		binary += String.fromCharCode(...uint8Array.slice(i, i + chunkSize));
	}
	const base64Content = btoa(binary);

	const id = `${detectedFileName}_${Date.now()}_${Math.random()}`;

	// PDF
	if (mimeType === "application/pdf" || lower.endsWith(".pdf")) {
		const { extractedText, preview } = await processPdf(arrayBuffer, detectedFileName);
		return {
			id,
			type: "document",
			fileName: detectedFileName,
			mimeType: "application/pdf",
			size,
			content: base64Content,
			extractedText,
			preview,
		};
	}

	// Image
	if (mimeType.startsWith("image/")) {
		return {
			id,
			type: "image",
			fileName: detectedFileName,
			mimeType,
			size,
			content: base64Content,
			preview: base64Content,
		};
	}

	// Text
	const textExtensions = [".txt", ".md", ".json", ".xml", ".html", ".css", ".js", ".ts", ".jsx", ".tsx", ".yml", ".yaml"];
	const isTextFile = mimeType.startsWith("text/") || textExtensions.some((ext) => lower.endsWith(ext));
	if (isTextFile) {
		const decoder = new TextDecoder();
		const text = decoder.decode(arrayBuffer);
		return {
			id,
			type: "document",
			fileName: detectedFileName,
			mimeType: mimeType.startsWith("text/") ? mimeType : "text/plain",
			size,
			content: base64Content,
			extractedText: text,
		};
	}

	throw new Error(`Unsupported file type: ${mimeType}`);
}

async function processPdf(arrayBuffer, fileName) {
	let pdf = null;
	try {
		pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
		const pages = [];
		for (let i = 1; i <= pdf.numPages; i++) {
			const page = await pdf.getPage(i);
			const textContent = await page.getTextContent();
			const text = textContent.items
				.map((item) => item.str || "")
				.join(" ")
				.replace(/\s+/g, " ")
				.trim();
			if (text) pages.push(`--- Page ${i} ---\n${text}`);
		}
		const preview = await renderPdfPreview(pdf);
		return { extractedText: pages.join("\n\n"), preview };
	} catch (err) {
		console.error(`Failed to process PDF ${fileName}:`, err);
		throw new Error(i18n("Failed to process PDF: ") + (err instanceof Error ? err.message : String(err)));
	} finally {
		if (pdf) pdf.destroy();
	}
}

async function renderPdfPreview(pdf) {
	try {
		const page = await pdf.getPage(1);
		const viewport = page.getViewport({ scale: 1 });
		const targetWidth = 400;
		const scale = targetWidth / viewport.width;
		const scaledViewport = page.getViewport({ scale });
		const canvas = document.createElement("canvas");
		canvas.width = scaledViewport.width;
		canvas.height = scaledViewport.height;
		const context = canvas.getContext("2d");
		if (!context) return undefined;
		context.fillStyle = "white";
		context.fillRect(0, 0, canvas.width, canvas.height);
		await page.render({ canvasContext: context, viewport: scaledViewport, canvas }).promise;
		return canvas.toDataURL("image/jpeg", 0.7);
	} catch (err) {
		console.warn("Failed to render PDF preview:", err);
		return undefined;
	}
}
