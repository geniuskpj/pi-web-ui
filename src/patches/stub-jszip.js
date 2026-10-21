/**
 * Stub for `jszip` (only used for PPTX/XLSX parsing in the original — removed).
 */
export default class JSZipStub {
	constructor() {
		throw new Error("ZIP archive support (PPTX/XLSX) is removed in this slim build.");
	}
	static loadAsync() {
		return Promise.reject(new Error("ZIP archive support (PPTX/XLSX) is removed in this slim build."));
	}
}
