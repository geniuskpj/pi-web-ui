// share-link.test.mjs — the one-time token extraction used by share links
// (`?session=<id>#token=<tok>`). Pure function, imported straight from the TS
// source (node 26 strips types natively) — no browser needed.
// Usage: node tests/share-link.test.mjs
import { consumeUrlToken } from "../src/share-link.ts";

let passed = 0, failed = 0;
const check = (name, ok, extra = "") => {
	if (ok) { passed++; console.log(`  ✓ ${name}${extra ? " — " + extra : ""}`); }
	else { failed++; console.error(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
};

// fragment form (the documented share link)
{
	const r = consumeUrlToken("?session=abc123", "#token=SECRET");
	check("fragment token extracted", r?.token === "SECRET");
	check("session param preserved", r?.search === "?session=abc123");
	check("fragment emptied", r?.hash === "");
}
// query form still accepted (legacy links); it is combined with the fragment
{
	const r = consumeUrlToken("?token=Q1&session=abc", "");
	check("query token extracted", r?.token === "Q1");
	check("query token removed, other params kept", r?.search === "?session=abc" && r?.hash === "");
}
// fragment wins over query (fragment never leaves the browser)
{
	const r = consumeUrlToken("?token=Q1", "#token=F1");
	check("fragment wins over query", r?.token === "F1");
	check("both tokens removed", r?.search === "" && r?.hash === "");
}
// other fragment keys survive a strip
{
	const r = consumeUrlToken("", "#token=T&view=compact");
	check("unrelated fragment keys kept", r?.token === "T" && r?.hash === "#view=compact");
}
// no token → null (never a spurious strip)
{
	check("no token in search or hash → null", consumeUrlToken("?session=x", "#view=1") === null);
	check("empty URL → null", consumeUrlToken("", "") === null);
	check("blank token is ignored", consumeUrlToken("?token=", "") === null);
	check("whitespace token is trimmed away → null", consumeUrlToken("?token=%20%20", "") === null);
	check("full URL shape (hash + search, no token) → null", consumeUrlToken("?session=abc&local=1", "%view=1") === null);
}
// trimmed value is what gets stored
{
	const r = consumeUrlToken("?token=%20T1%20", "");
	check("token is trimmed", r?.token === "T1");
}

console.log(`\n[share-link] ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
