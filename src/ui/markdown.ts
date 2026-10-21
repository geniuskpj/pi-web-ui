// Markdown rendering for chat bubbles (plan.md P1).
// marked (GFM) + highlight.js (aliased to lib/common in build.mjs) + DOMPurify.
// Assistant text is UNTRUSTED — every renderMarkdown() pass is sanitized.
import DOMPurify from "dompurify";
import hljs from "highlight.js";
import { marked } from "marked";

const SAFE_LANG = /^[a-zA-Z0-9_+#.-]+$/; // fence info-string is UNTRUSTED — whitelist before interpolation
const HLJS_MAX_INPUT = 20000; // ReDoS guard: hljs grammars don't throw on pathological input

function highlightCode(text: string, lang: string | undefined): { body: string; language: string } {
	const language = (lang || "").trim().split(/\s+/)[0] || "";
	// ReDoS guard: hljs grammars don't throw on pathological input — size-cap instead
	if (language && SAFE_LANG.test(language) && hljs.getLanguage(language) && text.length <= HLJS_MAX_INPUT) {
		try {
			return { body: hljs.highlight(text, { language, ignoreIllegals: true }).value, language };
		} catch {
			/* fall through to escaped */
		}
	}
	return { body: escapeHtml(text), language: SAFE_LANG.test(language) ? language : "" };
}

let configured = false;

function configure() {
	if (configured) return;
	configured = true;

	marked.use({
		gfm: true,
		breaks: true,
		renderer: {
			code({ text, lang }: { text: string; lang?: string }) {
				const { body, language } = highlightCode(text, lang);
				return `<pre><code class="hljs${language ? ` language-${language}` : ""}">${body}</code></pre>`;
			},
		},
	});

	// links open in a new tab, safely (post-sanitize so the attributes survive)
	DOMPurify.addHook("afterSanitizeAttributes", (node) => {
		if (node.tagName === "A" && node.getAttribute("href")) {
			node.setAttribute("target", "_blank");
			node.setAttribute("rel", "noopener noreferrer nofollow");
		}
	});
}

// Entities built from escapes so no tooling can literalize them in source.
const ESCAPES: Record<string, string> = {
	"\u0026": "\u0026amp;",
	"\u003C": "\u0026lt;",
	"\u003E": "\u0026gt;",
	'"': "\u0026quot;",
	"'": "\u0026#39;",
};

export function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** Sanitized markdown → HTML. Never throws. */
export function renderMarkdown(src: string): string {
	configure();
	try {
		const raw = marked.parse(src, { async: false }) as string;
		// FORBID style/id/name: no inline styles, no DOM clobbering (grok P1 review)
		return DOMPurify.sanitize(raw, { FORBID_ATTR: ["style", "id", "name"] });
	} catch {
		return escapeHtml(src);
	}
}
