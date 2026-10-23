// server-auth.ts — server authorization feedback for the UI (2026-10-23).
//
// WHY: the fetch patch used to react to 401 ONLY, and only when no token was
// stored. The 2026-10-23 session-sharing incident was therefore SILENT: a visitor
// on a custom domain got `403 forbidden — Host/Origin not allowlisted` for every
// /api/* call and saw an empty session list with no error anywhere (the prompt
// never fired because the gate that rejected him was not the token gate).
//
// This module owns the fetch patch (token header + status classification) and
// publishes a small state that the shell renders as a persistent banner:
//   ok          — last /api/* call succeeded
//   no-token    — 401 and we have no stored token (the token is required)
//   bad-token   — 401 while a token IS stored (stale/wrong — say so, don't loop)
//   host-blocked— 403 (Host/Origin not allowlisted, or gate mode "strict")
//   offline     — network error / non-HTTP failure
// The WebSocket patch stays in main.tsx (it must wrap the global before any
// socket is created) but reads the same token key.
export const TOKEN_KEY = "pi.webToken";

export type ServerAuthState = "ok" | "no-token" | "bad-token" | "host-blocked" | "offline";

let state: ServerAuthState | null = null;
let detail = "";
const listeners = new Set<(s: ServerAuthState, d: string) => void>();

export function getToken(): string {
	try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
}
export function setToken(t: string) {
	try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ }
}

/** Subscribe to auth-state changes. Fires immediately with the current state. */
export function onServerAuth(cb: (s: ServerAuthState, d: string) => void): () => void {
	listeners.add(cb);
	if (state) cb(state, detail);
	return () => listeners.delete(cb);
}

export function serverAuthState(): { state: ServerAuthState | null; detail: string } {
	return { state, detail };
}

function emit(s: ServerAuthState, d = "") {
	if (state === s && detail === d) return;
	state = s;
	detail = d;
	for (const cb of [...listeners]) {
		try { cb(s, d); } catch { /* listener error — ignore */ }
	}
}

/** Re-probe the server (used by the banner's Retry button). */
export async function retryServerAuth(): Promise<void> {
	try {
		const r = await fetch("/api/sessions", { signal: AbortSignal.timeout(8000) });
		if (r.ok) emit("ok");
	} catch {
		emit("offline", "server unreachable");
	}
}

function headerFor(init: any, input: any, tok: string) {
	const headers = new Headers(init?.headers || (typeof input !== "string" && input ? input.headers : undefined));
	if (!headers.has("x-pi-web-token")) headers.set("x-pi-web-token", tok);
	return { ...init, headers };
}

/** Install the fetch patch. MUST run before the first /api/* call. */
export function installServerAuth() {
	const origFetch = window.fetch.bind(window);
	window.fetch = async (input: any, init?: any) => {
		const url = typeof input === "string" ? input : (input?.url || "");
		const sameApi = url.includes("/api/") || url.includes("/ws/");
		const tok = getToken();
		let res: Response;
		try {
			res = await origFetch(input, sameApi && tok ? headerFor(init, input, tok) : init);
		} catch (err) {
			if (sameApi) emit("offline", "server unreachable");
			throw err;
		}
		if (!sameApi) return res;

		if (res.status === 401) {
			if (tok) {
				// stored token rejected — do NOT prompt in a loop; the banner explains
				emit("bad-token", "the stored server token was rejected");
				return res;
			}
			const entered = window.prompt("Server requires the pi-web API token.\nRead it from data/auth-token.txt on the server machine:");
			if (!entered?.trim()) {
				emit("no-token", "server token required");
				return res;
			}
			setToken(entered.trim());
			res = await origFetch(input, headerFor(init, input, entered.trim()));
			if (res.status === 401) emit("bad-token", "the server token was rejected");
			else if (res.ok) emit("ok");
			return res;
		}
		if (res.status === 403) {
			let msg = "the server refused this host";
			try {
				const b: any = await res.clone().json();
				if (b?.error) msg = String(b.error);
			} catch { /* non-JSON body */ }
			emit("host-blocked", msg);
			return res;
		}
		if (res.ok) emit("ok");
		return res;
	};
}
