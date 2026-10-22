// repair-mirror-toolcalls.mjs — one-time (idempotent) repair for session JSONL
// mirrors written by the OLD _writeSession format (pre-2026-10-22), which
// persisted only {role, content, timestamp} and stripped toolResult.toolCallId.
// After a server restart such mirrors rehydrated into role:"tool" messages
// without tool_call_id → provider 400 ("missing field tool_call_id", nvidia
// NIM) on the first prompt, stuck across retries.
//
// Runs every file through agent-hub.normalizeRestoredMessages and rewrites ONLY
// when the normalizer changed something (orphans, dangling toolCalls, or
// unmatchable leftovers). Safe to re-run: clean files pass through by reference
// and are left byte-identical. (2026-10-22 commit-review P3: the old version
// skipped dangling-only files via an orphan fast path and counted dropped
// orphans as re-linked — both fixed; counts now come from the normalizer.)
//
// Usage:
//   node tests/repair-mirror-toolcalls.mjs            # repair data/sessions
//   node tests/repair-mirror-toolcalls.mjs --dry      # report only
//   node tests/repair-mirror-toolcalls.mjs <dir>      # custom mirror dir
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeRestoredMessages } from "../agent-hub.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const dry = args.includes("--dry");
const dir = path.resolve(args.find((a) => !a.startsWith("--")) || path.join(root, "data", "sessions"));

if (!fs.existsSync(dir)) {
	console.error(`[repair] mirror dir not found: ${dir}`);
	process.exit(1);
}

let scanned = 0, repaired = 0, leftovers = 0;
for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl")).sort()) {
	const p = path.join(dir, f);
	const raw = fs.readFileSync(p, "utf8");
	const nl = raw.indexOf("\n");
	const meta = nl === -1 ? raw : raw.slice(0, nl);
	const messages = (nl === -1 ? "" : raw.slice(nl + 1)).split("\n").filter(Boolean)
		.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
	scanned++;
	const stats = { relinked: 0, dropped: 0, danglingStripped: 0 };
	const fixed = normalizeRestoredMessages(messages, stats);
	if (fixed === messages) continue; // clean file — nothing changed, no rewrite
	const orphansIn = messages.filter((m) => m?.role === "toolResult" && !m.toolCallId).length;
	const danglingIn = messages.reduce((n, m) => m?.role === "assistant" && Array.isArray(m.content)
		? n + m.content.filter((b) => b?.type === "toolCall" && !messages.some((x) => x?.role === "toolResult" && x.toolCallId === b.id)).length
		: n, 0);
	console.log(`${f}: ${orphansIn} orphan toolResult(s) → ${stats.relinked} re-linked, ${stats.dropped} dropped (unmatchable); ${danglingIn} dangling toolCall(s) → ${stats.danglingStripped} stripped`);
	if (stats.dropped > 0) leftovers++;
	if (dry) continue;
	fs.writeFileSync(p, meta + "\n" + fixed.map((m) => JSON.stringify(m)).join("\n") + "\n");
	repaired++;
}
console.log(dry ? `[repair] dry-run: ${scanned} file(s) scanned` : `[repair] done: ${scanned} scanned, ${repaired} rewritten, ${leftovers} with dropped (unmatchable) data`);
