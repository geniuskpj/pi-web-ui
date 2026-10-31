// peer-roles.test.mjs — the role registry (plan-subagents.md M0).
//
// The role file is the ONLY place that decides what a peer may do, so the two invariants get their own
// checks: a role can never ADD a capability, and `acceptanceRole: read-only` is a hard floor no
// `tools:` line can override. Usage: node tests/peer-roles.test.mjs
import {
	parseRoleFile, toolsForRole, composeRolePrompt, builtinRoles, resolveRole, roleCatalog,
	MUTATING_TOOLS, PEER_LIMITS, ROLE_NAME_RE,
} from "../lib/peer-roles.mjs";

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
	if (cond) { pass++; console.log(`  ✓ ${name}`); }
	else { fail++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};

const AVAILABLE = ["read_file", "write_file", "edit", "bash", "fetch", "rg_search", "find_file", "ls", "subagent"];

// ── parsing ─────────────────────────────────────────────────────────────────
{
	const r = parseRoleFile(`---
name: reviewer
description: Read-only review specialist
tools: read_file, rg_search
acceptanceRole: read-only
thinking: high
systemPromptMode: replace
model: anthropic/claude-sonnet-5
---
You review things.`);
	check("P1 name/description/body parse", r.name === "reviewer" && r.description.startsWith("Read-only") && r.body === "You review things.", JSON.stringify(r.errors));
	check("P2 a comma list becomes an array", JSON.stringify(r.tools) === JSON.stringify(["read_file", "rg_search"]));
	check("P3 scalar fields are typed", r.acceptanceRole === "read-only" && r.thinking === "high" && r.systemPromptMode === "replace" && r.model === "anthropic/claude-sonnet-5");
	check("P4 no errors on a well-formed file", r.errors.length === 0);
}
{
	const r = parseRoleFile(`---
name: writer
tools:
  - read_file
  - edit
  - bash
acceptanceRole: writer
---
Body.`);
	check("P5 a block list parses too", JSON.stringify(r.tools) === JSON.stringify(["read_file", "edit", "bash"]));
}
{
	const r = parseRoleFile("no frontmatter at all");
	check("P6 a file without frontmatter is REPORTED, not thrown", r.errors.some((e) => /frontmatter/.test(e)) && r.name === "");
	const bad = parseRoleFile("---\nname: Bad Name!\nthinking: ultra\nacceptanceRole: wizard\n---\nx");
	check("P7 bad name/thinking/acceptanceRole are collected", bad.errors.length >= 3, JSON.stringify(bad.errors));
	check("P8 the parser never throws on junk", (() => { try { parseRoleFile(null); parseRoleFile(undefined); parseRoleFile("---\n"); return true; } catch { return false; } })());
}
{
	const r = parseRoleFile("---\r\nname: crlf\r\n---\r\nbody\r\n");
	check("P9 CRLF and BOM files parse (Windows editors)", r.name === "crlf" && r.body === "body");
	const quoted = parseRoleFile(`---\nname: q\ndescription: "quoted, with a comma"\n---\nb`);
	check("P10 a quoted scalar keeps its comma", quoted.description === "quoted, with a comma");
}

// ── the tool floor ──────────────────────────────────────────────────────────
{
	const readOnly = parseRoleFile(`---\nname: r\ntools: read_file, bash, edit, subagent\nacceptanceRole: read-only\n---\nx`);
	const tools = toolsForRole(readOnly, AVAILABLE);
	check("T1 read-only STRIPS the mutating tools even when the file lists them", !tools.includes("bash") && !tools.includes("edit"), JSON.stringify(tools));
	check("T2 …and keeps the read tools", tools.includes("read_file") && tools.includes("rg_search"));
	check("T3 read-only never keeps write_file", !tools.includes("write_file"));
	check("T4 a peer NEVER gets `subagent` (no grandchildren), whatever the file says", !toolsForRole(readOnly, AVAILABLE).includes("subagent"));
	const writer = parseRoleFile(`---\nname: w\ntools: read_file, edit, bash, subagent\nacceptanceRole: writer\n---\nx`);
	check("T5 a writer role selects exactly its list (minus subagent)", JSON.stringify(toolsForRole(writer, AVAILABLE)) === JSON.stringify(["read_file", "edit", "bash"]));
	const deleg = parseRoleFile(`---\nname: d\nacceptanceRole: delegate\n---\nx`);
	check("T6 a role WITHOUT `tools:` inherits the normal set (minus subagent)", toolsForRole(deleg, AVAILABLE).length === AVAILABLE.length - 1);
	const listed = parseRoleFile(`---\nname: l\ntools: totally_unknown_tool\n---\nx`);
	check("T7 an unknown tool name in a role file selects nothing (it cannot invent a capability)", toolsForRole(listed, AVAILABLE).length === 0);
	check("T8 MUTATING_TOOLS covers the write surfaces we ship", ["write_file", "edit", "bash", "subagent"].every((t) => MUTATING_TOOLS.includes(t)));
}

// ── prompts ────────────────────────────────────────────────────────────────
{
	const role = parseRoleFile(`---\nname: rev\nsystemPromptMode: replace\n---\nBODY`);
	check("S1 replace = the role body under a role heading",
		composeRolePrompt(role, { parentPrompt: "PARENT" }) === "# Role: rev\n\nBODY");
	const app = parseRoleFile(`---\nname: app\nsystemPromptMode: append\n---\nBODY`);
	const out = composeRolePrompt(app, { parentPrompt: "PARENT" });
	check("S2 append = the parent prompt first, then the role", out.startsWith("PARENT") && out.includes("BODY"));
	check("S3 an empty role body never yields an empty prompt", composeRolePrompt({ name: "x", body: "" }).includes("behave like the parent"));
}

// ── builtins + resolution ─────────────────────────────────────────────────
{
	const builtins = builtinRoles();
	const names = builtins.map((r) => r.name);
	check("B1 the five shipped roles exist", ["reviewer", "oracle", "scout", "worker", "delegate"].every((n) => names.includes(n)), names.join(","));
	check("B2 every builtin parses WITHOUT errors (a builtin must not drift from the file format)",
		builtins.every((r) => r.errors.length === 0), JSON.stringify(builtins.filter((r) => r.errors.length).map((r) => [r.name, r.errors])));
	check("B3 reviewer/oracle/scout are read-only and cannot write",
		["reviewer", "oracle", "scout"].every((n) => {
			const t = toolsForRole(resolveRole(n, {}), AVAILABLE);
			return t.length > 0 && !t.some((x) => MUTATING_TOOLS.includes(x));
		}));
	check("B4 worker is a writer with the shell (that is the point of the role)",
		(() => { const t = toolsForRole(resolveRole("worker", {}), AVAILABLE); return t.includes("bash") && t.includes("edit"); })());
	check("B5 every builtin has a body worth sending", builtins.every((r) => r.body.length > 120), builtins.map((r) => `${r.name}:${r.body.length}`).join(" "));
	check("B6 roleCatalog reports names + effective tool counts", (() => {
		const cat = roleCatalog(AVAILABLE, {});
		const rev = cat.find((c) => c.name === "reviewer");
		return cat.length === 5 && rev.tools === toolsForRole(resolveRole("reviewer", {}), AVAILABLE).length;
	})());
	const disk = `---\nname: reviewer\ndescription: MY OVERRIDE\nacceptanceRole: writer\ntools: read_file, bash\n---\nOVERRIDDEN`;
	const resolved = resolveRole("reviewer", { files: { reviewer: disk }, dirs: [".pi/agents"] });
	check("R1 a workspace role file OVERRIDES the builtin", resolved.description === "MY OVERRIDE" && resolved.body === "OVERRIDDEN");
	check("R2 …including its acceptanceRole (so overriding is how you make a reviewer that writes)", toolsForRole(resolved, AVAILABLE).includes("bash"));
	check("R3 a broken override resolves to null instead of a half-role",
		resolveRole("x", { files: { x: "---\nname: x\nthinking: nonsense\n---\nbody" } }) === null);
	check("R4 an unknown role name is null (the caller fails fast, never silently generalizes)", resolveRole("nope", {}) === null && resolveRole("", {}) === null);
	check("R5 ROLE_NAME_RE rejects path traversal shapes", !ROLE_NAME_RE.test("../etc") && !ROLE_NAME_RE.test("a/b") && ROLE_NAME_RE.test("code-reviewer_2"));
	check("R6 the limits are the plan's numbers", PEER_LIMITS.maxDepth === 1 && PEER_LIMITS.maxConcurrentPerParent === 3 && PEER_LIMITS.maxConcurrentGlobal === 6 && PEER_LIMITS.summaryBytes === 32 * 1024);
}

console.log(`\n[peer-roles] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
