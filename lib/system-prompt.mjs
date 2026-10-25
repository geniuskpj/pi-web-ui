/**
 * system-prompt.mjs — how the WEB agent's system prompt is RESOLVED, and how it is
 * GENERATED when no prompt file exists at all.
 *
 * User question (2026-10-25): "how is the system prompt generated if pi_dir is
 * missing?" Answer, before this module: badly. The resolver returned `undefined`,
 * agent-hub only passes `systemPrompt` when it is truthy, and pi-agent-core has NO
 * built-in preamble — so a deployment without `.pi` (fresh machine, or PI_DIR pointing
 * at a path that does not exist) ran the web agent with NO system prompt: no tool
 * docs, no cwd, no rules. `/api/pi/system` labelled that case "pi default", but
 * nothing injected anything (pi's own builder, `buildSystemPrompt` in
 * packages/coding-agent/src/core/system-prompt.ts, lives in a package this server does
 * not depend on).
 *
 * So the fallback is composed in code, mirroring pi's section model: independently
 * replaceable, XML-tagged sections (`preamble`, `tools`, `rules`, `docs`, `cwd`) —
 * the same rendering pi's `getSystemMessageText` produces — which keeps the door open
 * to structured sections later without touching call sites.
 *
 * Precedence (unchanged, and now defined ONCE for both the hub and /api/pi/system):
 *   base:   agentDir/WEB_SYSTEM.md                       (web-only filename, never read by pi's TUI)
 *        > workspaceDir/.pi/SYSTEM.md   (only when the project is trusted)
 *        > agentDir/SYSTEM.md
 *   append: workspaceDir/.pi/APPEND_SYSTEM.md (trusted) > agentDir/APPEND_SYSTEM.md
 *   nothing found → the built-in prompt below.
 *
 * APPEND_SYSTEM.md is pi's filename, not a web-UI concept, but it is honored here on
 * purpose: it is where the operator's standing instructions live (tool notes, permission
 * rules, path conventions), and the web agent needs them too.
 */

const P1 = "You are an expert coding assistant running in the pi web UI. You help users by reading files, executing commands, editing code, and writing new files.";
const RULES = [
	"Be concise in your responses",
	"Show file paths clearly when working with files",
	"Use the bash tool for file operations like listing, searching (rg/fd) and finding files",
	"Ask before destructive operations (deleting files, overwriting large files, killing processes)",
];

/**
 * Compose the built-in web system prompt. Pure (no fs): callers pass what exists.
 * @param {{cwd?:string, workspaceDir?:string, tools?:string[], docsPath?:string|null}} o
 */
export function buildWebSystemPrompt({ cwd, workspaceDir, tools = [], docsPath = null } = {}) {
	const sections = {};
	sections.preamble = P1;
	const list = (tools || []).filter((t) => typeof t === "string" && t.trim());
	sections.tools =
		(list.length ? list.map((t) => `- ${t}`).join("\n") : "- read_file, write_file, edit, bash, fetch") +
		"\n\nIn addition to the tools above, you may have access to other custom tools depending on the project.";
	sections.rules = RULES.map((r) => `- ${r}`).join("\n");
	if (docsPath) {
		sections.docs = `Pi documentation (read only when the user asks about pi itself):\n- ${docsPath}`;
	}
	const dir = String(cwd || workspaceDir || process.cwd()).replace(/\\/g, "/");
	sections.cwd = dir;
	const out = [sections.preamble];
	for (const [name, content] of Object.entries(sections)) {
		if (name === "preamble" || !content) continue;
		out.push(`<${name}>\n${content}\n</${name}>`);
	}
	return out.join("\n\n");
}

/**
 * Resolve the effective prompt from the prompt files, falling back to the built-in.
 * @param {{agentDir:string, workspaceDir:string, trusted?:boolean,
 *          read:(p:string)=>string|undefined, tools?:string[], docsPath?:string|null}} o
 * @returns {{text:string, source:"file"|"builtin", base:string|null, append:string|null}}
 */
export function resolveSystemPrompt({ agentDir, workspaceDir, trusted = true, read, tools = [], docsPath = null }) {
	const rd = typeof read === "function" ? read : () => undefined;
	const p = (...parts) => [agentDir, ...parts].join("/");
	const base =
		rd(p("WEB_SYSTEM.md")) ||
		(trusted ? rd([workspaceDir, ".pi", "SYSTEM.md"].join("/")) : undefined) ||
		rd(p("SYSTEM.md")) ||
		null;
	const append =
		(trusted ? rd([workspaceDir, ".pi", "APPEND_SYSTEM.md"].join("/")) : undefined) ||
		rd(p("APPEND_SYSTEM.md")) ||
		null;
	if (!base && !append) {
		return { text: buildWebSystemPrompt({ cwd: workspaceDir, workspaceDir, tools, docsPath }), source: "builtin", base: null, append: null };
	}
	return { text: [base, append].filter(Boolean).join("\n\n"), source: "file", base, append };
}
