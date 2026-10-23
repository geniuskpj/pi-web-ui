// share-link.ts — one-time token extraction from the page URL (2026-10-23).
//
// Share link shape:  http://<host>:8787/?session=<id>#token=<tok>
//
// The FRAGMENT is deliberate: browsers never send it to the server and never put
// it in a Referer header, so the token cannot leak through access logs the way a
// query parameter does (the server also refuses `?token=` on plain HTTP now —
// only WS upgrades accept it, because WS cannot set headers).
//
// consumeUrlToken() is pure so it can be unit-tested in node; main.tsx calls it
// once at boot, stores the token and rewrites the URL without it.
export interface TakenToken {
	token: string;
	/** Search string with `token` removed ("" when nothing is left), including "?". */
	search: string;
	/** Hash string with `token` removed ("" when nothing is left), including "#". */
	hash: string;
}

export function consumeUrlToken(search: string, hash: string): TakenToken | null {
	const hp = new URLSearchParams(String(hash || "").replace(/^#/, ""));
	const sp = new URLSearchParams(String(search || "").replace(/^\?/, ""));
	const token = (hp.get("token") || sp.get("token") || "").trim();
	if (!token) return null;
	hp.delete("token");
	sp.delete("token");
	const h = hp.toString();
	const s = sp.toString();
	return { token, search: s ? `?${s}` : "", hash: h ? `#${h}` : "" };
}
