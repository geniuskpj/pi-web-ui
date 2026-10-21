/**
 * Stub for `xlsx` (office support removed).
 * XLSX attachments are rejected before these functions can run.
 */
function removed() {
	throw new Error("XLSX support is removed in this slim build.");
}
export const version = "0.0.0-removed";
export const utils = new Proxy({}, { get: removed });
export function read() {
	removed();
}
export function write() {
	removed();
}
export function writeFile() {
	removed();
}
export const SSF = { get_format: removed };
