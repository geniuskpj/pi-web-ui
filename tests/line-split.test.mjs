// line-split.test.mjs — per-line rendering of the file preview (user report 2026-10-28:
// "there is a bug in highlighting lines ui").
//
// The jumped-to line used to be an absolutely positioned band computed from the CSS
// line-height against the scroll container's padding box: off by the <pre>'s padding,
// broken with the sticky gutter, and impossible in the PROSE preview (no <pre> at all,
// so a hit in a .md/.txt file jumped nowhere). The fix renders one element per line, so
// `[data-line="N"]` is a real scroll/highlight target for code AND prose. hljs spans can
// cross newlines — the splitter must close/re-open them instead of tearing the markup.
//
// Usage: node tests/line-split.test.mjs
// node ≥23 strips types natively, so the .ts module is imported directly (no build step)
import { splitHljsLines, codeLinesHtml } from "../src/ui/line-split.ts";

let passed = 0, failed = 0;
const check = (name, ok, extra = "") => {
	if (ok) { passed++; console.log(`  ✓ ${name}${extra ? " — " + extra : ""}`); }
	else { failed++; console.error(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
};

// ── S) splitting ─────────────────────────────────────────────────────────────
{
	check("S1 plain text splits on \\n", JSON.stringify(splitHljsLines("a\nb\nc")) === JSON.stringify(["a", "b", "c"]));
	check("S1 a trailing newline yields one final empty line", JSON.stringify(splitHljsLines("a\n")) === JSON.stringify(["a", ""]));
	check("S1 empty input is one empty line (never zero)", JSON.stringify(splitHljsLines("")) === JSON.stringify([""]));
	check("S1 blank lines are preserved", splitHljsLines("a\n\nb").length === 3 && splitHljsLines("a\n\nb")[1] === "");
	const inline = splitHljsLines('<span class="hljs-keyword">const</span> x = 1;\n<span class="hljs-string">"y"</span>');
	check("S2 a span inside one line is untouched", inline[0] === '<span class="hljs-keyword">const</span> x = 1;');
	check("S2 the second line keeps its own span", inline[1] === '<span class="hljs-string">"y"</span>');
	const cross = splitHljsLines('<span class="hljs-comment">/* one\n * two\n */</span>tail');
	check("S3 a span CROSSING newlines is closed and re-opened per line", cross.length === 3, JSON.stringify(cross));
	check("S3 line 1 closes the span", cross[0] === '<span class="hljs-comment">/* one</span>');
	check("S3 line 2 re-opens and closes it", cross[1] === '<span class="hljs-comment"> * two</span>');
	check("S3 line 3 closes then keeps the trailing text outside", cross[2] === '<span class="hljs-comment"> */</span>tail');
	check("S3 every line is span-balanced", cross.every((l) => (l.match(/<span/g) || []).length === (l.match(/<\/span>/g) || []).length));
	const nested = splitHljsLines('<span class="a"><span class="b">x\ny</span></span>');
	check("S4 nested spans re-open in ORDER", nested[1] === '<span class="a"><span class="b">y</span></span>', nested[1]);
	check("S4 nesting stays balanced on both lines", nested.every((l) => (l.match(/<span/g) || []).length === (l.match(/<\/span>/g) || []).length));
	const voidTag = splitHljsLines("a<br>b\nc");
	check("S5 a void/self-closing tag is not pushed on the stack", voidTag[1] === "c", JSON.stringify(voidTag));
	check("S6 a malformed tail never throws", splitHljsLines("a<span").length === 1);
	check("S6 entities survive (they contain no raw <)", splitHljsLines("&lt;div&gt;\n&lt;/div&gt;").length === 2);
}

// ── H) per-line html ────────────────────────────────────────────────────────
{
	const html = codeLinesHtml(["a", "", "<b>x</b>"], 2);
	check("H1 one div per line with data-line", (html.match(/data-line=/g) || []).length === 3 && html.includes('data-line="1"') && html.includes('data-line="3"'));
	check("H1 the highlighted line carries the hit class", /class="pw-code-line pw-code-line-hit" data-line="2"/.test(html), html.slice(0, 90));
	check("H1 an empty line still has a box (the gutter counts it)", html.includes('data-line="2"> </div>'));
	check("H2 no highlight → no hit class anywhere", !codeLinesHtml(["a", "b"]).includes("pw-code-line-hit"));
	check("H2 an out-of-range highlight line is simply absent", !codeLinesHtml(["a"], 99).includes("pw-code-line-hit"));
	check("H3 markup inside a line is passed through verbatim", html.includes("&lt;b&gt;") || html.includes("<b>x</b>"));
}

console.log(`\n[line-split] ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
