// deepseek-review.mjs — a ONE-SHOT code review on a real provider, through pi-agent-core/pi-ai
// (no `pi.exe`, no tool loop: the code is inlined in the prompt, so cost and latency are predictable).
//
// Why this shape: the first attempt used a peer with read/bash tools and the model burned ~50k tokens
// looping over failed shell commands (`git` is not on the msys PATH; it guessed `/repo`). For REVIEWING
// a fixed file list there is nothing to explore — inline it.
//
// Usage: node ws-diag/deepseek-review.mjs [modelId] [outFile]
//   default model: deepseek-ai/deepseek-v4.1-flash (nvidia)
import fs from "node:fs";
import path from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { buildProviderCatalog } from "../lib/pi-catalog.mjs";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const PI_DIR = process.env.PI_WEB_PI_DIR || "C:/pi-windows-x64/.pi";
const MODEL = process.argv[2] || "deepseek-ai/deepseek-v4.1-flash";
const OUT = process.argv[3] || path.join(REPO, "ws-diag", "deepseek-review.md");

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(path.join(PI_DIR, f), "utf8")); } catch { return {}; } };
const readTolerant = (f) => {
	const raw = (() => { try { return fs.readFileSync(path.join(PI_DIR, f), "utf8"); } catch { return ""; } })();
	try { return JSON.parse(raw); } catch { /* JSONC */ }
	try { return JSON.parse(raw.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/,(\s*[}\]])/g, "$1")); } catch { return {}; }
};

const { providers } = buildProviderCatalog({ store: readJson("models-store.json"), modelsJson: readTolerant("models.json"), auth: readJson("auth.json") });
const model = Object.values(providers).flatMap((p) => (p.models || []).map((m) => ({ ...m, provider: p.name }))).find((m) => m.id === MODEL);
if (!model) { console.error(`model ${MODEL} not in the catalog (${Object.keys(providers).join(", ")})`); process.exit(1); }

// ── the packet: full files + the peer-related sections of the two big ones ──
const full = (f) => `\n\n===== FILE: ${f} =====\n${fs.readFileSync(path.join(REPO, f), "utf8")}`;
const slice = (f, fromRe, toRe) => {
	const lines = fs.readFileSync(path.join(REPO, f), "utf8").split("\n");
	const from = lines.findIndex((l) => fromRe.test(l));
	const to = lines.findIndex((l, i) => i > from && toRe.test(l));
	if (from < 0) return `\n\n===== FILE: ${f} (section NOT FOUND: ${fromRe}) =====\n`;
	const body = lines.slice(from, to < 0 ? from + 220 : to).join("\n");
	return `\n\n===== FILE: ${f} lines ${from + 1}-${(to < 0 ? from + 220 : to)} (sections about peers) =====\n${body}`;
};

const packet = [
	"Review the SUBAGENT/PEER feature of this self-hosted pi agent web UI. Be a hard, evidence-based reviewer: cite file + function, and only report what the code actually does.",
	"\nARCHITECTURE IN ONE PARAGRAPH: a peer is a NORMAL session (same JSONL store, attach, /range, versions, compaction, media redaction) created with a role; the role supplies the system prompt and a NARROWED tool list; a `PeerSupervisor` owns the child promise, the abort tree and the caps, and the tool `execute()` only awaits `supervisor.wait()`; a journal in the parent's session metadata records spawn/terminal state so status survives a restart; the parent's model gets ONE tool result per delegation (a frozen schema with a 32KB-capped summary).",
	"",
	"QUESTIONS (answer each with evidence, or say 'no issues found'):",
	"1. Can a peer wedge, leak or double-count? Trace spawn -> wait -> settle -> journal for: abort, wall-clock timeout, budget-exceeded, a runner that ignores its signal, and a hub restart.",
	"2. Is the parent ALWAYS given exactly one tool result per `run`? Find any path returning none, two, or throwing.",
	"3. Are the caps real and correctly counted (depth, per-parent, global, cumulative spawn budget, turns, tokens)? Any bypass or wrong count?",
	"4. Is status truthful after restart / eviction / a discarded child session?",
	"5. Can a read-only role obtain a mutating tool? Can a non-pi model spec break a child's tool list?",
	"6. Concurrency: several `subagent` calls in one turn; a parent aborted mid-delegation; the same peer controlled from two clients.",
	"7. What could corrupt the CHILD's own session (it is a normal session: attach, /range, versions, compaction, media redaction)?",
	"8. Result contract: is the summary truncation UTF-8-safe and idempotent, are failures actionable, is usage counted once?",
	"",
	"OUTPUT: numbered findings, each with severity P0 (must fix before use) / P1 (fix soon) / P2 (note), the file+function, the concrete failure scenario, and the smallest fix. Then a one-line verdict.",
	packetFiles(),
].join("\n");

function packetFiles() {
	return [
		full("peer-supervisor.mjs"),
		full("peer-tools.mjs"),
		full("lib/peer-lifecycle.mjs"),
		full("lib/peer-roles.mjs"),
		slice("agent-hub.mjs", /peers \(plan-subagents\.md\)/, /^\tpersistSession\(/),
		slice("agent-hub.mjs", /^\t_reconcilePeers\(sessionId\) \{/, /^\t\/\/ ─+ peers/),
		slice("server.mjs", /case "peers": \{/, /case "retry": \{/),
		slice("server.mjs", /getTools: \(sessionId, meta\)/, /loadMessages: async/),
	].join("");
}

console.log(`[deepseek-review] ${model.id} via ${model.provider} · packet ${Math.round(packet.length / 1024)}KB (~${Math.round(packet.length / 4 / 1024)}k tokens)`);
const agent = new Agent({
	streamFn: streamSimple, // pi-ai 1.4.0 requires it
	initialState: { model, thinkingLevel: "high", systemPrompt: "You are a meticulous senior code reviewer. No praise, no summary of what the code does, no speculation: findings with file+function evidence, severity, and the smallest fix. Say 'no issues found' where the code holds up." },
});
agent.getApiKey = async (provider) => providers[provider]?.apiKey;

let text = "";
let lastErr = "";
agent.subscribe((ev) => {
	const inner = ev?.event || ev;
	if (inner?.type === "message_update" && inner.delta?.type === "text") process.stdout.write(inner.delta.text);
	if (inner?.type === "message_end" && inner.message?.role === "assistant") { lastErr = inner.message.errorMessage || ""; }
	if (inner?.type === "agent_end") {
		const msgs = agent.state.messages.filter((m) => m.role === "assistant");
		text = msgs.map((m) => (m.content || []).filter((b) => b?.type === "text").map((b) => b.text).join("")).join("\n\n");
	}
});
const t0 = Date.now();
await agent.prompt(packet);
const secs = Math.round((Date.now() - t0) / 1000);
const usage = agent.state.messages.filter((m) => m.role === "assistant").reduce((a, m) => ({ input: a.input + (m.usage?.input || 0), output: a.output + (m.usage?.output || 0) }), { input: 0, output: 0 });
const out = `# deepseek review — ${model.id} (${model.provider})\n\n_${secs}s · ${usage.input} in / ${usage.output} out tokens_\n\n${text || `(no text; error: ${lastErr})`}\n`;
fs.writeFileSync(OUT, out, "utf8");
console.log(`\n\n[deepseek-review] ${secs}s · ${usage.input} in / ${usage.output} out tokens -> ${OUT}`);
process.exit(text ? 0 : 1);
