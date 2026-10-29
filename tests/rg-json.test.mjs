// rg-json.test.mjs — the workspace search (file viewer find, user request 2026-10-28).
//
// The left pane of the file explorer runs ripgrep ON THE SERVER (`GET /api/ws/search`) and
// renders grouped file:line results; clicking one opens the preview at that line. Two things
// must never regress, so they are pinned here:
//   * the argv is passed as an ARRAY to spawn — the query is data, never shell/regex input
//   * `--json` (not --vimgrep) is what makes `C:\a\b.ts:12:3:` paths parseable at all
// The parser is pure (lib/rg-json.mjs); the samples below are REAL rg output.
//
// Usage: node tests/rg-json.test.mjs
import { rgArgs, parseRgJson } from "../lib/rg-json.mjs";

let passed = 0, failed = 0;
const check = (name, ok, extra = "") => {
	if (ok) { passed++; console.log(`  ✓ ${name}${extra ? " — " + extra : ""}`); }
	else { failed++; console.error(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
};

// real `rg --json` output (2 matches in one file, CRLF + a Windows path)
const REAL = [
	'{"type":"begin","data":{"path":{"text":"src\\\\ui\\\\chat.tsx"}}}',
	'{"type":"match","data":{"path":{"text":"src\\\\ui\\\\chat.tsx"},"lines":{"text":"\\tconst [displayFromSeq, setDisplayFromSeq] = useState<number | null>(null);\\r\\n"},"line_number":702,"absolute_offset":30519,"submatches":[{"match":{"text":"displayFromSeq"},"start":8,"end":22},{"match":{"text":"DisplayFromSeq"},"start":27,"end":41}]}}',
	'{"type":"match","data":{"path":{"text":"src\\\\ui\\\\chat.tsx"},"lines":{"text":"\\t\\t\\tif (sparseSeen.current) setDisplayFromSeq(gateSeqOfLastTurns(...));\\r\\n"},"line_number":721,"absolute_offset":31656,"submatches":[{"match":{"text":"DisplayFromSeq"},"start":30,"end":44}]}}',
	'{"type":"end","data":{"path":{"text":"src\\\\ui\\\\chat.tsx"},"stats":{"matched_lines":2}}}',
	'{"data":{"stats":{"matched_lines":2,"matches":3},"elapsed_total":{"secs":0}},"type":"summary"}',
].join("\n");

// ── A) argv ──────────────────────────────────────────────────────────────────────────────
{
	const a = rgArgs("a b; rm -rf /", { maxPerFile: 7 });
	check("A1 the query is ONE argv entry after `--` (never a shell string)", a[a.length - 2] === "a b; rm -rf /" && a[a.length - 1] === "." && a.includes("--"));
	check("A1 -F/--json/-i are set (fixed string, parseable output, find-box semantics)", a.includes("--json") && a.includes("-F") && a.includes("-i"));
	check("A2 the per-file cap is passed through", a[a.indexOf("--max-count") + 1] === "7");
	check("A2 .gitignore stays honored (no --no-ignore) and .git is skipped", !a.includes("--no-ignore") && a[a.indexOf("--glob") + 1] === "!.git");
	check("A3 no shell metacharacters are ever used as flags", !a.some((x) => x.startsWith("$") || x.includes("&&") || x.includes("|")));
}

// ── P) parsing ──────────────────────────────────────────────────────────────────────────
{
	const r = parseRgJson(REAL);
	check("P1 paths are normalized to / and grouped", r.files.length === 1 && r.files[0].path === "src/ui/chat.tsx", r.files[0]?.path);
	check("P1 both matches land in the file", r.files[0].matches.length === 2 && r.total === 2);
	check("P1 line numbers + column + match length come from the event", r.files[0].matches[0].line === 702 && r.files[0].matches[0].col === 9 && r.files[0].matches[0].matchLen === 14);
	check("P1 the CRLF is stripped from the display line", !r.files[0].matches[0].text.includes("\r") && r.files[0].matches[0].text.includes("displayFromSeq"));
	check("P1 summary/end events are not hits", !r.files.some((f) => f.path.includes("summary")));
	const multi = parseRgJson([
		'{"type":"match","data":{"path":{"text":"a.ts"},"lines":{"text":"x"},"line_number":1,"submatches":[{"start":0,"end":1}]}}',
		'{"type":"match","data":{"path":{"text":"b.ts"},"lines":{"text":"y"},"line_number":9,"submatches":[{"start":0,"end":1}]}}',
		'{"type":"match","data":{"path":{"text":"a.ts"},"lines":{"text":"z"},"line_number":3,"submatches":[{"start":0,"end":1}]}}',
	].join("\n"));
	check("P2 matches without a begin event still create their file group (order kept)", multi.files.map((f) => f.path).join(",") === "a.ts,b.ts" && multi.files[0].matches.length === 2);
}

// ── C) caps + degenerate input ──────────────────────────────────────────────────────────
{
	const many = Array.from({ length: 30 }, (_, i) => `{"type":"match","data":{"path":{"text":"big.ts"},"lines":{"text":"line ${i}"},"line_number":${i + 1},"submatches":[{"start":0,"end":2}]}}`).join("\n");
	const perFile = parseRgJson(many, { maxPerFile: 5, cap: 400 });
	check("C1 the per-file cap stops one busy file flooding the pane", perFile.files[0].matches.length === 5 && perFile.total === 5);
	const capped = parseRgJson(many, { maxPerFile: 50, cap: 7 });
	check("C1 the total cap truncates and says so", capped.total === 7 && capped.truncated === true);
	check("C2 a partial line at the kill boundary is ignored", parseRgJson('{"type":"match","data":{"path":{"text":"x"}').files.length === 0);
	check("C2 binary/invalid-UTF-8 lines fall back to the base64 bytes field", parseRgJson('{"type":"match","data":{"path":{"text":"bin"},"lines":{"bytes":"aGVsbG8="},"line_number":1,"submatches":[{"start":0,"end":2}]}}').files[0].matches[0].text === "hello");
	check("C2 empty / garbage input is an empty result, never a throw", parseRgJson("").files.length === 0 && parseRgJson("not json\n{}\n").files.length === 0);
	check("C3 no matches (rg exit 1) is a clean empty result", parseRgJson('{"data":{"stats":{"matches":0}},"type":"summary"}').total === 0);
}

console.log(`\n[rg-json] ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
