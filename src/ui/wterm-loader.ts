// wterm-loader.ts — lazy loader for the vendored PREBUILT wterm bundle.
//
// The renderer lives in public/vendor/wterm/wterm.js (single self-contained
// ESM file: @wterm/dom + @wterm/core + the ~26KB Zig WASM core inlined as
// base64). Regenerate with `node vendor-wterm.mjs`. Loaded at runtime via a
// variable-specifier dynamic import so esbuild never tries to bundle it.
//
// CDN URLs are FALLBACKS ONLY: they execute third-party code with full page
// privileges, so every fallback use logs a loud console.warn (visible in bug
// reports). Each source is raced against a timeout so a black-holed CDN can't
// hang the panel before the next source is tried.
export interface WTermLike {
	init(): Promise<void>;
	write(data: string | Uint8Array): void;
	resize(cols: number, rows: number): void;
	focus(): void;
	destroy(): void;
	setRenderingPaused?(paused: boolean): void;
	cols?: number;
	rows?: number;
}
export type WTermCtor = new (el: HTMLElement, opts?: Record<string, unknown>) => WTermLike;

const WTERM_VERSION = "0.5.4";
const LOAD_TIMEOUT_MS = 8000;

// vendored prebuilt bundle first; variable specifiers keep esbuild from
// trying to resolve these URLs at build time
const WTERM_SOURCES: Array<() => string> = [
	() => "/vendor/wterm/wterm.js",
	() => `https://esm.sh/@wterm/dom@${WTERM_VERSION}`,
	() => `https://cdn.jsdelivr.net/npm/@wterm/dom@${WTERM_VERSION}/+esm`,
];

let wtermCtorPromise: Promise<WTermCtor> | null = null;

export function loadWterm(): Promise<WTermCtor> {
	if (wtermCtorPromise) return wtermCtorPromise;
	wtermCtorPromise = (async () => {
		let lastErr: unknown = null;
		for (let i = 0; i < WTERM_SOURCES.length; i++) {
			const url = WTERM_SOURCES[i](); // computed at call time → runtime import
			try {
				const mod = (await Promise.race([
					import(url),
					new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timeout after ${LOAD_TIMEOUT_MS}ms`)), LOAD_TIMEOUT_MS)),
				])) as any;
				// esm.sh-style CDNs may wrap named exports in `default`
				const ctor = mod?.WTerm ?? mod?.default?.WTerm;
				if (typeof ctor === "function") {
					if (i > 0) {
						// supply-chain tripwire: third-party code just ran with full
						// page privileges — make it visible in support/diag reports
						console.warn(`[terminal] VENDORED wterm MISSING — fell back to CDN: ${url}`);
					}
					return ctor as WTermCtor;
				}
				lastErr = new Error("wterm: WTerm export missing");
			} catch (err) {
				lastErr = err;
			}
		}
		wtermCtorPromise = null; // allow a retry on the next panel open
		throw lastErr instanceof Error ? lastErr : new Error(String(lastErr ?? "wterm unavailable"));
	})();
	return wtermCtorPromise;
}
