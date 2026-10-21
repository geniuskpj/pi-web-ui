// nvidia-only build stub — this provider SDK is intentionally not installed.
// pi-ai's registry imports it eagerly, but the provider is never constructed in
// this web UI (only OpenAI-compatible providers are used). If you need it, remove
// the override in package.json and reinstall.
const msg = "[pi-web-ui] provider removed in nvidia-only build — add the override back in package.json to restore";
const stub = new Proxy(function stub() {}, {
	construct() { throw new Error(msg); },
	apply() { throw new Error(msg); },
	get(t, k) { if (k === Symbol.toPrimitive || k === "toString") return () => "stub"; return stub; },
});
module.exports = stub;
