// line-split.ts — split highlight.js HTML into PER-LINE html.
//
// WHY (user report 2026-10-28: "there is a bug in highlighting lines ui"): the code
// preview was ONE <pre> and the jumped-to line was drawn with an absolutely positioned
// band whose `top` was computed from the CSS line-height against the scroll container's
// padding box — so it was off by the <pre>'s own padding, drifted with the sticky gutter,
// and could not exist at all in the PROSE preview (which has no <pre>: a search hit in a
// .md/.txt/.log file jumped nowhere). Per-line elements give a real box per line:
// `[data-line]` is scrollable and highlightable, for code AND prose, with no arithmetic.
//
// hljs emits `<span class="hljs-x">…</span>` that can CROSS newlines (block comments,
// template literals, markdown). Naive `html.split("\n")` would tear those spans, so every
// open tag is closed at the break and re-opened on the next line — the highlight then
// survives inside each line and the DOM stays well-formed.
//
// Pure → tests/line-split.test.mjs.

/** Void elements never get a closing tag — pushing one would inject a stray `</span>`. */
const VOID_TAGS = new Set(["br", "hr", "img", "input", "wbr", "area", "base", "col", "embed", "link", "meta", "param", "source", "track"]);

/** Split hljs HTML into one string per source line (spans balanced per line). */
export function splitHljsLines(html: string): string[] {
	const lines: string[] = [];
	const src = String(html ?? "");
	const open: string[] = []; // stack of open tag strings ("<span class=…>")
	let cur = "";
	let i = 0;
	while (i < src.length) {
		const ch = src[i];
		if (ch === "<") {
			const end = src.indexOf(">", i);
			if (end === -1) { cur += src.slice(i); break; } // malformed tail — keep verbatim
			const tag = src.slice(i, end + 1);
			if (tag.startsWith("</")) open.pop();
			else {
				const name = (tag.match(/^<\s*([a-zA-Z][a-zA-Z0-9-]*)/) || [])[1]?.toLowerCase();
				if (name && !VOID_TAGS.has(name) && !tag.endsWith("/>")) open.push(tag);
			}
			cur += tag;
			i = end + 1;
			continue;
		}
		if (ch === "\n") {
			lines.push(cur + "</span>".repeat(open.length));
			cur = open.join("");
			i += 1;
			continue;
		}
		cur += ch;
		i += 1;
	}
	lines.push(cur); // the text after the last \n (a trailing \n yields one empty line)
	return lines;
}

/** Build the single innerHTML string for a per-line code view: one `<div data-line>`
 *  per source line. ONE innerHTML write (not one per line) — a 3000-line file stays a
 *  single layout pass, which is what makes this cheap enough to rebuild on a jump. */
export function codeLinesHtml(lines: string[], highlightLine?: number | null): string {
	return (lines || [])
		.map((h, i) => {
			const n = i + 1;
			const cls = n === highlightLine ? "pw-code-line pw-code-line-hit" : "pw-code-line";
			// an empty line still needs a box (the gutter counts it)
			return `<div class="${cls}" data-line="${n}">${h || " "}</div>`;
		})
		.join("");
}
