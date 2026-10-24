// lib/net-class.mjs — "is this request coming from my own network?" for the tail-first
// transfer policy hint (`/api/health` → netClass).
//
// WHY THIS EXISTS (review 01a16a54 #9 residual, fixed 2026-10-24): the classification was
// inline in the /api/health route as `isPrivate(host.split(":")[0])`, which broke EVERY IPv6
// host — "[::1]:8787" splits to "[" — and knew no IPv6 ranges at all, so an IPv6 LAN device
// was reported "remote" and silently lost the fast-path backfill (a UX downgrade only:
// netClass picks tail-only vs warm; the token/Host gates are unaffected). It is also only
// reachable end-to-end with a non-private PEER, which a local test cannot produce — so it
// lives here, pure and unit-tested (tests/security-gates.test.mjs).

/** Strip the port from a Host header, including the bracketed IPv6 form. */
export function hostOnly(host) {
	const s = String(host || "").trim();
	if (s.startsWith("[")) {
		const i = s.indexOf("]");
		return i > 0 ? s.slice(1, i) : s;
	}
	const m = s.match(/^([^:]+):\d+$/);
	return m ? m[1] : s;
}

const V4_PRIVATE = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/;

/** private/loopback for IPv4 AND IPv6: loopback, IPv4-mapped (both spellings), ULA
 *  fc00::/7, link-local fe80::/10, and the RFC1918/metadata IPv4 space. */
export function isPrivate(raw) {
	const v = String(raw || "").trim().toLowerCase();
	if (!v) return false;
	if (v === "localhost" || v === "::1" || v === "0:0:0:0:0:0:0:1") return true;
	const mapped4 = v.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
	if (mapped4) return isPrivate(mapped4[1]);
	if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(v)) return true; // mapped hex form
	if (/^f[cd][0-9a-f]{2}:/.test(v)) return true; // IPv6 ULA fc00::/7
	if (/^fe[89ab][0-9a-f]:/.test(v)) return true; // IPv6 link-local fe80::/10
	return V4_PRIVATE.test(v);
}

/** The hint the client uses to choose tail-only (metered) vs full backfill (fast).
 *  Either side being local counts as LAN. */
export function netClassOf(peer, host) {
	return isPrivate(peer) || isPrivate(hostOnly(host)) ? "lan" : "remote";
}
