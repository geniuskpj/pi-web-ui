// peer-roles.mjs — what a PEER (child agent) is allowed to be.
//
// A role is a markdown file with a small YAML frontmatter block, the same idea as
// pi-subagents' `agents/<role>.md` (name/description/tools/acceptanceRole/thinking/systemPromptMode):
//
//   ---
//   name: reviewer
//   description: Read-only review specialist
//   tools: read_file, rg_search
//   acceptanceRole: read-only
//   thinking: high
//   systemPromptMode: replace
//   ---
//   You are a disciplined review subagent …
//
// Everything here is PURE (no fs, no hub): the caller reads files and passes text in. The tool
// allowlist is the security boundary — a prompt can ask a reviewer to edit files, but the reviewer
// simply has no write/edit/bash tool (see `toolsForRole`).
//
// Two invariants that must not drift:
//   1. a role can only NARROW the tool set the process already exposes (it never adds a capability);
//   2. `acceptanceRole: read-only` is a hard floor: the mutating tools are removed whatever `tools:`
//      says, so a careless or hand-edited role file cannot hand a reviewer a shell.

/** Tools that change the machine. A read-only role never gets one, whatever the file claims. */
export const MUTATING_TOOLS = ["write_file", "edit", "bash", "subagent", "terminal", "exec", "task"];

export const SYSTEM_PROMPT_MODES = ["replace", "append"];
export const ACCEPTANCE_ROLES = ["read-only", "writer", "delegate"];
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

/** The caps that keep a delegation from becoming an unbounded agent graph (D8 of the plan). */
export const PEER_LIMITS = {
	maxDepth: 1,               // a peer never gets the `subagent` tool: no grandchildren
	maxConcurrentPerParent: 3,
	maxConcurrentGlobal: 6,
	maxSpawnsPerParent: 24,    // cumulative for one parent session (persisted, not per turn)
	maxWallClockMs: 10 * 60 * 1000,
	maxChildTurns: 40,
	maxChildTokens: 200_000,
	summaryBytes: 32 * 1024,   // the tool-result cap, measured in UTF-8 bytes (D12)
	journalKeep: 50,           // how many peer records the parent's metadata keeps
};

/** The frontmatter subset we accept: `key: value`, `key: a, b, c`, or a `- item` block list. */
function parseFrontmatter(text) {
	const src = String(text ?? "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
	const m = /^---\n([\s\S]*?)\n---\s*\n?/.exec(src);
	if (!m) return { data: {}, body: src.trim(), hadFrontmatter: false };
	const data = {};
	let listKey = null;
	for (const rawLine of m[1].split("\n")) {
		const line = rawLine.replace(/\s+$/, "");
		if (!line.trim() || line.trim().startsWith("#")) continue;
		const item = /^\s*-\s+(.*)$/.exec(line);
		if (item && listKey) { data[listKey].push(unquote(item[1])); continue; }
		const kv = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
		if (!kv) { listKey = null; continue; }
		const key = kv[1].trim();
		const value = kv[2].trim();
		if (!value) { data[key] = []; listKey = key; continue; } // a bare key opens a block list
		listKey = null;
		if (value.startsWith("[") && value.endsWith("]")) {
			data[key] = value.slice(1, -1).split(",").map((s) => unquote(s.trim())).filter(Boolean);
		} else if (/^["'][\s\S]*["']$/.test(value)) {
			data[key] = unquote(value); // a quoted scalar is ONE value, even with commas inside
		} else if (value.includes(",")) {
			data[key] = value.split(",").map((s) => unquote(s.trim())).filter(Boolean);
		} else {
			data[key] = unquote(value);
		}
	}
	return { data, body: src.slice(m[0].length).trim(), hadFrontmatter: true };
}

const unquote = (s) => String(s ?? "").trim().replace(/^["']|["']$/g, "");

const asList = (v) => (Array.isArray(v) ? v : typeof v === "string" && v ? [v] : []);
const asBool = (v) => v === true || v === "true" || v === "yes";

/**
 * Parse ONE role file. Never throws: problems land in `errors` and the caller decides (the plan's
 * rule is "a broken role file is reported, never fatal").
 */
export function parseRoleFile(text, { source = null } = {}) {
	const errors = [];
	const { data, body, hadFrontmatter } = parseFrontmatter(text);
	if (!hadFrontmatter) errors.push("no frontmatter block");
	const name = String(data.name ?? "").trim();
	if (!name) errors.push("missing name");
	if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name)) errors.push(`invalid role name "${name}" (letters, digits, - and _ only)`);
	const thinking = data.thinking === undefined ? "high" : String(data.thinking).trim();
	const acceptanceRole = String(data.acceptanceRole ?? (asList(data.tools).length ? "writer" : "read-only")).trim();
	if (!THINKING_LEVELS.includes(thinking)) errors.push(`unknown thinking level "${thinking}"`);
	if (!ACCEPTANCE_ROLES.includes(acceptanceRole)) errors.push(`unknown acceptanceRole "${acceptanceRole}"`);
	const systemPromptMode = String(data.systemPromptMode ?? "replace").trim();
	if (!SYSTEM_PROMPT_MODES.includes(systemPromptMode)) errors.push(`unknown systemPromptMode "${systemPromptMode}"`);
	return {
		name,
		description: String(data.description ?? "").trim(),
		tools: asList(data.tools),
		toolsDeclared: data.tools !== undefined,
		acceptanceRole,
		thinking,
		model: data.model ? String(data.model).trim() : null,
		systemPromptMode,
		inheritProjectContext: data.inheritProjectContext === undefined ? true : asBool(data.inheritProjectContext),
		body,
		source,
		errors,
	};
}

/**
 * The tool names a peer actually gets: the role's list ∩ what the process exposes, MINUS
 * `subagent` (no grandchildren) and MINUS the mutating tools for a read-only role.
 * `available` is the *names* the server would hand a normal session.
 */
export function toolsForRole(role, available = []) {
	const all = available.filter((n) => n !== "subagent");
	if (role?.acceptanceRole === "read-only") return all.filter((n) => !MUTATING_TOOLS.includes(n));
	// a role without a `tools:` key inherits the normal set (the `delegate` role)
	if (!role?.toolsDeclared) return all;
	const allowed = new Set(role.tools);
	return all.filter((n) => allowed.has(n));
}

/** The system prompt a peer starts with: `replace` = its own body, `append` = parent prompt + body. */
export function composeRolePrompt(role, { parentPrompt = "" } = {}) {
	const head = `# Role: ${role?.name || "peer"}\n\n`;
	const body = role?.body || "(no role body — behave like the parent session.)";
	if (role?.systemPromptMode === "append" && parentPrompt) {
		return `${parentPrompt}\n\n${head}${body}`;
	}
	return `${head}${body}`;
}

// ─────────────────────────────────────────────────────────── the shipped roles

/** Built-in roles. Deliberately small: a role is a job description, not an essay. */
export const BUILTIN_ROLES = [
	{
		name: "reviewer",
		description: "Read-only review specialist: diffs, plans, code health. Reports findings with evidence.",
		tools: ["read_file", "rg_search", "find_file", "ls", "git_diff", "fetch"],
		acceptanceRole: "read-only",
		thinking: "high",
		systemPromptMode: "replace",
		body: [
			"You are a read-only review peer. Inspect, evaluate, and report — never edit.",
			"",
			"Rules:",
			"- Start from the exact artifact you were given (file, diff, plan). Verify claims in the code instead of guessing.",
			"- Report findings as: severity (P0 blocks, P1 fix before release, P2 note), what is wrong, where, evidence, and the smallest fix.",
			"- Say \"no issues found\" when nothing qualifies. Filter by evidence, not by severity.",
			"- You have no write/edit/shell tool. If a check needs a command, name the exact command for the parent to run.",
			"- Finish with a one-line verdict.",
		].join("\n"),
	},
	{
		name: "oracle",
		description: "Second opinion before acting: challenges assumptions, finds what is missing. Never edits.",
		tools: ["read_file", "rg_search", "find_file", "ls", "fetch"],
		acceptanceRole: "read-only",
		thinking: "high",
		systemPromptMode: "replace",
		body: [
			"You are an advisory peer: a second opinion whose value is disagreement, not agreement.",
			"",
			"- State the decision or plan you are judging in one sentence, then attack it: hidden assumptions, unstated constraints, cheaper alternatives, failure modes, what the author would only notice after shipping.",
			"- Distinguish \"this is wrong\" from \"this is a risk\" from \"this is taste\".",
			"- Propose the smallest experiment or check that would settle each uncertainty.",
			"- End with: the one thing you would change first, and your confidence (0-10).",
			"- You cannot edit files; do not pretend to have run anything.",
		].join("\n"),
	},
	{
		name: "scout",
		description: "Fast local recon: relevant files, entry points, data flow, risks. Read-only.",
		tools: ["read_file", "rg_search", "find_file", "ls"],
		acceptanceRole: "read-only",
		thinking: "medium",
		systemPromptMode: "replace",
		body: [
			"You are a scouting peer. Map the ground quickly and report; do not propose large changes.",
			"",
			"- Find the entry points, the files that matter, how data flows between them, and where the sharp edges are (global state, locks, retries, cleanup).",
			"- Cite paths and symbols, never vague areas. Prefer 10 precise file:line pointers over prose.",
			"- List what you did NOT look at, so the parent knows the blind spots.",
			"- End with the 3 findings the parent should act on.",
		].join("\n"),
	},
	{
		name: "worker",
		description: "Implementation peer: edits files, runs checks, escalates decisions instead of guessing.",
		tools: [],                        // empty `tools:` → narrowed to the read-only set? no: see acceptanceRole
		acceptanceRole: "writer",
		thinking: "high",
		systemPromptMode: "replace",
		body: [
			"You are an implementation peer. You have the same file and shell tools the parent has.",
			"",
			"- Do exactly the task you were given; do not expand scope. If the task is ambiguous, implement the smallest reasonable version and say what you assumed.",
			"- Read before writing. Keep edits surgical and consistent with the surrounding code.",
			"- Verify your change (build/test/typecheck when the project has one) and report the exact command and result.",
			"- Never touch the git history, never commit, never remove files that were not part of the task.",
			"- Report: what changed (files), how you verified it, what you did NOT do, and any decision the parent must make.",
		].join("\n"),
	},
	{
		name: "delegate",
		description: "General delegate that behaves close to the parent session.",
		// no `tools:` key → inherits the normal tool set (minus `subagent`)
		acceptanceRole: "delegate",
		thinking: "high",
		systemPromptMode: "replace",
		body: [
			"You are a general delegation peer: the same capabilities as the parent session, pointed at one task.",
			"",
			"- Focus only on the task you were given and return a compact report (what you did, evidence, open questions).",
			"- You cannot delegate further; if the task needs splitting, say how instead.",
		].join("\n"),
	},
];

/** Builtin roles parsed through the SAME parser (so a builtin cannot drift from the file format). */
export function builtinRoles() {
	return BUILTIN_ROLES.map((r) => {
		const parsed = parseRoleFile(
			["---",
				`name: ${r.name}`,
				`description: ${r.description}`,
				// an empty `tools:` list is meaningful for a writer role (it means "the normal set")
				r.tools && r.tools.length ? `tools: ${r.tools.join(", ")}` : null,
				`acceptanceRole: ${r.acceptanceRole}`,
				`thinking: ${r.thinking}`,
				`systemPromptMode: ${r.systemPromptMode}`,
				"---",
				r.body,
			].filter((l) => l !== null).join("\n"),
			{ source: "builtin" },
		);
		if (!r.tools || !r.tools.length) parsed.toolsDeclared = false; // inherit the normal set
		return parsed;
	});
}

export const ROLE_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i;

/**
 * Resolve one role by name from a list of directories (later entries win — the workspace overrides
 * the global dir), falling back to the builtins. `files` maps a role name to its text; the caller
 * does the disk work (keeps this module pure and testable).
 */
export function resolveRole(name, { files = {}, dirs = [] } = {}) {
	const key = String(name ?? "").trim();
	if (!key) return null;
	const fromDisk = files[key];
	if (fromDisk !== undefined) {
		const parsed = parseRoleFile(fromDisk, { source: dirs.join(",") || "given" });
		if (parsed.errors.length) return null;
		return parsed;
	}
	return builtinRoles().find((r) => r.name === key) || null;
}

/** What `subagent({action:"list"})` shows: name, description, and the effective tool count. */
export function roleCatalog(availableTools = [], { files = {}, dirs = [] } = {}) {
	const names = new Set(builtinRoles().map((r) => r.name));
	for (const n of Object.keys(files)) if (ROLE_NAME_RE.test(n)) names.add(n);
	return [...names].map((n) => {
		const role = resolveRole(n, { files, dirs });
		if (!role) return { name: n, error: "unreadable or invalid role file" };
		return {
			name: role.name,
			description: role.description,
			acceptanceRole: role.acceptanceRole,
			model: role.model,
			thinking: role.thinking,
			tools: toolsForRole(role, availableTools).length,
			source: role.source,
		};
	}).sort((a, b) => a.name.localeCompare(b.name));
}
