/**
 * rg-json.mjs — the argv + the parser for the workspace search (user request 2026-10-28:
 * "find for chat/file viewer"). Pure, so tests/rg-json.test.mjs can pin it.
 *
 * WHY --json (grok review 2026-10-28): `--vimgrep` output is `path:line:col:text`, which is
 * unparseable on Windows (`C:\dir\file.ts:12:3:…` has two colons of its own) and would need
 * shell quoting to survive the query. `--json` is a stable event stream, and the argv is
 * passed as an ARRAY to spawn — the query is never word-split or shell-expanded.
 */

/** rg argv for one query. `-F` = the query is a fixed string (no regex injection), `-i`
 *  = case-insensitive (what a find box means), `.gitignore` stays honored (no --no-ignore),
 *  binary files are skipped, and the caps keep a pathological query bounded. */
export function rgArgs(query, { maxPerFile = 20 } = {}) {
	return [
		"--json",
		"-F",
		"-i",
		"--max-count", String(Math.max(1, Math.floor(maxPerFile))),
		"--max-columns", "200",
		"--max-filesize", "1M",
		"--glob", "!.git",
		"--",
		String(query ?? ""),
		".",
	];
}

/** Decode rg's `{text}` / `{bytes}` field pair (bytes = base64 of invalid UTF-8). */
function textOf(field) {
	if (!field) return "";
	if (typeof field.text === "string") return field.text;
	if (typeof field.bytes === "string") {
		try { return Buffer.from(field.bytes, "base64").toString("utf8"); } catch { return ""; }
	}
	return "";
}

/**
 * Parse `rg --json` NDJSON into grouped results.
 * @returns {{files: Array<{path: string, matches: Array<{line: number, text: string, col: number}>}>, total: number, truncated: boolean, errors: string[]}}
 */
export function parseRgJson(text, { maxPerFile = 20, cap = 400 } = {}) {
	const perFileCap = Math.max(1, Math.floor(maxPerFile) || 20);
	const totalCap = Math.max(1, Math.floor(cap) || 400);
	const files = [];
	const index = new Map(); // path -> position in `files`
	const errors = [];
	let total = 0;
	let truncated = false;
	for (const line of String(text || "").split("\n")) {
		if (!line) continue;
		let ev;
		try { ev = JSON.parse(line); } catch { continue; } // a partial line at the kill boundary
		if (ev?.type === "begin") {
			const p = textOf(ev.data?.path);
			if (p && !index.has(p)) { index.set(p, files.length); files.push({ path: p.replace(/\\/g, "/"), matches: [] }); }
			continue;
		}
		if (ev?.type === "match") {
			const p = textOf(ev.data?.path).replace(/\\/g, "/");
			let at = index.get(p);
			if (at === undefined) { index.set(p, files.length); at = files.length; files.push({ path: p, matches: [] }); }
			const file = files[at];
			if (file.matches.length >= perFileCap) continue; // per-file cap: one busy file cannot flood the pane
			const sub = Array.isArray(ev.data?.submatches) ? ev.data.submatches[0] : null;
			file.matches.push({
				line: Number(ev.data?.line_number) || 0,
				text: textOf(ev.data?.lines).replace(/\r?\n$/, ""),
				col: sub ? Number(sub.start) + 1 : 1,
				matchLen: sub ? String(textOf(sub.match)).length : 0,
			});
			total += 1;
			if (total >= totalCap) { truncated = true; break; }
			continue;
		}
		if (ev?.type === "end" && ev.data?.stats?.matched_lines === undefined && ev.data?.message) {
			errors.push(String(ev.data.message));
		}
	}
	// drop files whose every match was capped away (can't happen, but keeps the shape honest)
	return { files: files.filter((f) => f.matches.length > 0), total, truncated, errors };
}
