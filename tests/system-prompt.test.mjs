// system-prompt.test.mjs — how the web agent's system prompt is resolved and what
// happens when no prompt file exists at all (user question 2026-10-25: "how is the
// system prompt generated if pi_dir is missing").
//
// Before lib/system-prompt.mjs the answer was "not at all": the resolver returned
// undefined, agent-hub only passes a systemPrompt when it is truthy, and pi-agent-core
// ships no built-in preamble — so a deploy without .pi ran the web agent with no prompt
// whatsoever. /api/pi/system called that case "pi default", which nothing implemented.
//
// 2026-10-25 (user): "Make APPEND_SYSTEM.md into WEB_SYSTEM.md and revise code too" —
// the operator's standing instructions were merged into .pi/WEB_SYSTEM.md, and the web
// path no longer reads APPEND_SYSTEM.md at all (it is pi's file). The checks below pin
// that: an append file that EXISTS must have no effect on the web prompt.
//
// Usage: node tests/system-prompt.test.mjs
import { resolveSystemPrompt, buildWebSystemPrompt } from "../lib/system-prompt.mjs";

let passed = 0, failed = 0;
const check = (name, ok, extra = "") => {
	if (ok) { passed++; console.log(`  ✓ ${name}${extra ? " — " + extra : ""}`); }
	else { failed++; console.error(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
};

const FILES = {
	"A/WEB_SYSTEM.md": "WEB-PROMPT",
	"W/.pi/SYSTEM.md": "PROJECT-PROMPT",
	"A/SYSTEM.md": "GLOBAL-PROMPT",
	// present on purpose: the web path must IGNORE these (they belong to pi's CLI/TUI)
	"W/.pi/APPEND_SYSTEM.md": "PROJECT-APPEND",
	"A/APPEND_SYSTEM.md": "GLOBAL-APPEND",
};
const reader = (missing = []) => (p) => (missing.includes(p) ? undefined : FILES[p]);
const res = (o = {}) => resolveSystemPrompt({ agentDir: "A", workspaceDir: "W", trusted: true, read: reader(), ...o });

// ── precedence ───────────────────────────────────────────────────────────────
{
	const all = res();
	check("P1 WEB_SYSTEM.md wins and IS the whole prompt", all.text === "WEB-PROMPT" && all.source === "file", JSON.stringify(all.text));
	check("P1b APPEND_SYSTEM.md is NOT read by the web path (pi's file)", !all.text.includes("APPEND") && all.base !== null);
	check("P1b no append field is reported any more", all.append === undefined, JSON.stringify(Object.keys(all)));

	const noWeb = res({ read: reader(["A/WEB_SYSTEM.md"]) });
	check("P2 without WEB_SYSTEM.md the trusted PROJECT prompt wins", noWeb.text.startsWith("PROJECT-PROMPT"));

	const untrusted = res({ trusted: false });
	check("P3 an untrusted project contributes nothing (and the append never does)",
		untrusted.text === "WEB-PROMPT", untrusted.text.slice(0, 40));

	const globalOnly = res({ trusted: false, read: reader(["A/WEB_SYSTEM.md"]) });
	check("P3 without a web prompt an untrusted project falls back to the GLOBAL prompt", globalOnly.text.startsWith("GLOBAL-PROMPT"));
}

// ── the fallback: no prompt file at all (missing pi_dir) ─────────────────────
{
	const none = resolveSystemPrompt({ agentDir: "A", workspaceDir: "W", trusted: true, read: () => undefined, tools: ["read_file", "bash"] });
	check("F1 a missing prompt set yields a BUILT-IN prompt, never undefined/empty", none.source === "builtin" && none.text.length > 100, `${none.source}, ${none.text.length} chars`);
	check("F1 it is composed as pi-style tagged sections",
		/^[^\n]+\n\n<tools>/.test(none.text) && none.text.includes("</tools>") && none.text.includes("<rules>") && none.text.includes("<cwd>"));
	check("F1 the working directory is injected (so the agent knows where it is)", /<cwd>\s*W\s*<\/cwd>/.test(none.text));
	check("F1 the tools it actually has are named", none.text.includes("- read_file") && none.text.includes("- bash"));
	check("F1 the base is reported as absent (for /api/pi/system)", none.base === null && !("append" in none));

	// an append-ONLY configuration is no longer a configured web prompt: APPEND_SYSTEM.md
	// is pi's file, so the web agent gets the built-in prompt instead of pi's append text.
	const appendOnly = resolveSystemPrompt({ agentDir: "A", workspaceDir: "W", trusted: true, read: (p) => (p === "A/APPEND_SYSTEM.md" ? "ONLY-APPEND" : undefined) });
	check("F2 an append-only configuration falls back to the built-in (append ignored)",
		appendOnly.source === "builtin" && !appendOnly.text.includes("ONLY-APPEND"), appendOnly.source);
}

// ── the builder itself ───────────────────────────────────────────────────────
{
	const withDocs = buildWebSystemPrompt({ cwd: "C:\\ws\\proj", tools: [], docsPath: "C:/pi/docs" });
	check("B1 a docs path adds a docs section", withDocs.includes("<docs>") && withDocs.includes("C:/pi/docs"));
	check("B1 backslashes in cwd are normalised to forward slashes", withDocs.includes("<cwd>\nC:/ws/proj\n</cwd>"));
	const withoutDocs = buildWebSystemPrompt({ cwd: "/tmp/x", tools: [] });
	check("B2 no docs path → no docs section (nothing to point at)", !withoutDocs.includes("<docs>"));
	check("B2 an empty tool list falls back to the default tool names", withoutDocs.includes("read_file, write_file, edit, bash, fetch"));
}

console.log(`\n[system-prompt] ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
