/**
 * Stub for `docx-preview` (office support removed).
 * Attachments of type DOCX are rejected before these functions can run;
 * the stub only exists so the bundle has valid module graph edges.
 */
export async function parseAsync() {
	throw new Error("DOCX support is removed in this slim build.");
}
export async function renderAsync() {
	throw new Error("DOCX support is removed in this slim build.");
}
