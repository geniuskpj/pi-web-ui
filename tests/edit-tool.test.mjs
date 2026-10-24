// edit-tool.test.mjs — the edit tool must RECOVER from malformed call shapes.
// Each case here mirrors a real malformed call the maintainer's agent produced
// (and the tool previously rejected). Boots a scratch server with an isolated
// workspace; drives /api/exec/tool directly.
// Usage: node tests/edit-tool.test.mjs
import fs from "node:fs";
import path from "node:path";
import { startScratchServer, execTool } from "./_scratch-server.mjs";

let passed = 0, failed = 0;
const check = (name, ok, extra = "") => {
	if (ok) { passed++; console.log(`  ✓ ${name}${extra ? " — " + extra : ""}`); }
	else { failed++; console.error(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
};

const srv = await startScratchServer();
try {
	const file = () => fs.readFileSync(path.join(srv.wsDir, "et.txt"), "utf8");
	fs.writeFileSync(path.join(srv.wsDir, "et.txt"), "foo bar\nsecond line\n");

	// T1 — the "edits.0: must be object" class: DOUBLE-encoded edits string that
	// also carries the path inside the wrapper, with no top-level path
	{
		const inner = JSON.stringify({ path: "et.txt", edits: [{ oldText: "foo bar", newText: "FOO BAR" }] });
		const r = await execTool(srv, { edits: JSON.stringify(inner) }); // double-encoded!
		const text = r.content?.[0]?.text || "";
		check("T1 double-encoded edits string + path-in-wrapper recovered",
			/Successfully replaced/.test(text) && /double-encoded/.test(text) && /path was missing/.test(text) && file().startsWith("FOO BAR"));
	}

	// T2 — edits[i] as a bare old-text string → deletion
	{
		const r = await execTool(srv, { path: "et.txt", edits: ["second line"] });
		const text = r.content?.[0]?.text || "";
		check("T2 bare-string entry treated as deletion",
			/Successfully replaced/.test(text) && /bare string/.test(text) && !file().includes("second line"));
	}

	// T3 — edits[i] as a JSON string object
	fs.writeFileSync(path.join(srv.wsDir, "et.txt"), "alpha beta\ngamma\n");
	{
		const r = await execTool(srv, { path: "et.txt", edits: [JSON.stringify({ oldText: "alpha beta", newText: "ALPHA BETA" })] });
		const text = r.content?.[0]?.text || "";
		check("T3 JSON-string entry parsed to object",
			/Successfully replaced/.test(text) && /parsed to an object/.test(text) && file().startsWith("ALPHA BETA"));
	}

	// T4 — path sent as an object {path: "..."}
	{
		const r = await execTool(srv, { path: { path: "et.txt" }, edits: [{ oldText: "ALPHA BETA", newText: "alpha beta" }] });
		const text = r.content?.[0]?.text || "";
		check("T4 object path unwrapped",
			/Successfully replaced/.test(text) && /path was an object/.test(text) && file().startsWith("alpha beta"));
	}

	// T5 — path missing everywhere → exact call-shape error
	{
		const r = await execTool(srv, { edits: [{ oldText: "alpha", newText: "x" }] });
		const text = r.content?.[0]?.text || "";
		check("T5 missing path → exact-shape error",
			/missing `path`/.test(text) && /TOP-LEVEL string/.test(text));
	}

	// T6 — empty oldText → actionable guidance (not a bare length error)
	{
		const r = await execTool(srv, { path: "et.txt", edits: [{ oldText: "", newText: "prepend!" }] });
		const text = r.content?.[0]?.text || "";
		check("T6 empty oldText → guidance",
			/non-empty verbatim excerpt/.test(text) && /write_file/.test(text));
	}

	// T7 — a WELL-FORMED call is untouched (no repair notes, still works)
	{
		const r = await execTool(srv, { path: "et.txt", edits: [{ oldText: "gamma", newText: "GAMMA" }] });
		const text = r.content?.[0]?.text || "";
		check("T7 well-formed call unchanged (no repair notes)",
			/Successfully replaced/.test(text) && !/Repaired malformed call/.test(text) && file().includes("GAMMA"));
	}

	// T8 — built-in write/read tools use workspace paths and preserve exact input bytes
	{
		const target = path.join(srv.wsDir, "nested", "platform.txt");
		const content = "first line\r\nsecond line\r\n";
		const write = await execTool(srv, { path: path.relative(srv.wsDir, target), content }, "write_file");
		const read = await execTool(srv, { path: target }, "read_file");
		const text = read.content?.[0]?.text || "";
		check("T8 write_file creates parent dirs and preserves CRLF",
			/wrote \d+ bytes/.test(write.content?.[0]?.text || "") && fs.readFileSync(target, "utf8") === content);
		check("T8 read_file accepts an absolute Linux workspace path",
			text.includes("1| first line\r\n2| second line\r"));
	}

	// T9 — editing a CRLF file must not convert it to the server OS line endings
	{
		const target = path.join(srv.wsDir, "nested", "platform.txt");
		const r = await execTool(srv, { path: target, edits: [{ oldText: "second line\n", newText: "updated line\n" }] });
		check("T9 edit preserves Windows CRLF on Linux",
			/Successfully replaced/.test(r.content?.[0]?.text || "") &&
			fs.readFileSync(target, "utf8") === "first line\r\nupdated line\r\n");
	}
} finally {
	await srv.stop();
}
console.log(`\n[edit-tool] ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
