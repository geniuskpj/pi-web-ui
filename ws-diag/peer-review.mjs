// peer-review.mjs — run a REAL peer (the subagents feature) on the deepseek model to review the subagent
// code itself. No `pi.exe`: the review goes through pi-agent-core/pi-ai exactly like the server does, and
// it exercises `hub.spawnPeer()` + the reviewer role end to end on a live provider.
//
// Usage: node ws-diag/peer-review.mjs [modelId]
//   default model: deepseek-ai/deepseek-v4.1-flash (nvidia)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { AgentHub } from "../agent-hub.mjs";
import { buildProviderCatalog } from "../lib/pi-catalog.mjs";
import { resolveRole } from "../lib/peer-roles.mjs";

const PI_DIR = process.env.PI_WEB_PI_DIR || "C:/pi-windows-x64/.pi";
const WS = process.env.PI_WEB_WS || "C:/pi-windows-x64/ws/pi-web-ui";
const MODEL = process.argv[2] || "deepseek-ai/deepseek-v4.1-flash";

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(path.join(PI_DIR, f), "utf8")); } catch { return {}; } };
const readTolerant = (f) => {
	const raw = (() => { try { return fs.readFileSync(path.join(PI_DIR, f), "utf8"); } catch { return ""; } })();
	try { return JSON.parse(raw); } catch { /* JSONC */ }
	const stripped = raw.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/,(\s*[}\]])/g, "$1");
	try { return JSON.parse(stripped); } catch { return {}; }
};

// the same catalog the server builds (pi's store cache + models.json + auth.json)
const { providers: catalog } = buildProviderCatalog({ store: readJson("models-store.json"), modelsJson: readTolerant("models.json"), auth: readJson("auth.json") });
const model = Object.values(catalog).flatMap((p) => (p.models || []).map((m) => ({ ...m, provider: p.name }))).find((m) => m.id === MODEL);
if (!model) { console.error(`model ${MODEL} not found in the catalog (providers: ${Object.keys(catalog).join(", ")})`); process.exit(1); }
console.log(`[peer-review] model ${model.id} via ${model.provider} (${model.api})${model.baseUrl ? ` @ ${model.baseUrl}` : ""}`);

// a MINIMAL read-only toolset: the reviewer needs to read files and run git/rg, nothing else
const sh = (cmd) => { try { return execFileSync("bash", ["-lc", cmd], { cwd: WS, encoding: "utf8", timeout: 120000, maxBuffer: 8 * 1024 * 1024 }); } catch (e) { return `${e.stdout || ""}${e.stderr || ""}${e.message}`; } };
const tools = [
	{
		name: "read_file", description: "Read a text file (path, optional offset/limit).",
		parameters: { type: "object", properties: { path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } }, required: ["path"] },
		async execute(_id, p) {
			const lines = fs.readFileSync(path.isAbsolute(p.path) ? p.path : path.join(WS, p.path), "utf8").split("\n");
			const off = Math.max(0, Number(p.offset || 1) - 1);
			const lim = Math.max(1, Math.min(4000, Number(p.limit || 400)));
			return { content: [{ type: "text", text: `${p.path} (${lines.length} lines)\n${lines.slice(off, off + lim).map((l, i) => `${off + i + 1}| ${l}`).join("\n")}` }] };
		},
	},
	{
		name: "bash", description: "Run a shell command in the repo (read-only commands: rg, git log/show/diff, ls, sed -n).",
		parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
		async execute(_id, p) { return { content: [{ type: "text", text: sh(String(p.command || "")) || "(no output)" }] }; },
	},
];

const TASK = [
	"Review the SUBAGENT/PEER implementation in this repository (a self-hosted pi agent web UI). Be a hard, evidence-based reviewer: read the code, do not trust comments.",
	"",
	"Files to read (relative to the repo root):",
	"- peer-supervisor.mjs (lifecycle: promises, abort tree, caps, force-settle)",
	"- peer-tools.mjs (the `subagent` tool: run/list/status/stop/steer/retry, the result contract)",
	"- lib/peer-lifecycle.mjs (the journal, peerStatusOf, budgets, the frozen result schema)",
	"- lib/peer-roles.mjs (role files, the tool allowlist / read-only floor)",
	"- agent-hub.mjs — only the peer sections: spawnPeer, _runPeer, _awaitPeerEnd, _emitPeer, closePeerJournal, peersOf, remainingPeerBudget, controlPeer, _parentOfPeer, _reconcilePeers",
	"- server.mjs — only: the `peers`/`peer` WS cases, the /api/agent/session/:id/peers routes, getTools wiring",
	"",
	"Also useful: `git log --oneline -5` and `git show <sha> --stat` for the peer commits (1813ebf, 1a0ce05, 3c162a8).",
	"",
	"Questions to answer with evidence (file + function + line):",
	"1. Can a peer run wedge, leak or double-count? Trace spawn → wait → settle → journal, including abort, timeout, budget-exceeded and a runner that ignores its signal.",
	"2. Is the parent's transcript always guaranteed exactly one tool result per `run` call? Find any path that could return none, two, or throw.",
	"3. Are the caps real (depth, per-parent, global, spawn budget, turns, tokens)? Can any of them be bypassed or counted wrongly?",
	"4. Does status stay truthful after a restart, an eviction, or a peer whose child session was discarded?",
	"5. Any way a read-only role gets a mutating tool, or an arena/non-pi model spec breaks the child's tool list?",
	"6. Concurrency: what happens when the model issues several `subagent` calls in one turn, and when a parent is aborted mid-delegation?",
	"7. Anything that would corrupt the child's own transcript (the child is a normal session: attach, /range, versions, compaction, media redaction all apply).",
	"",
	"Report ONLY concrete findings with file+function+evidence, each with severity (P0 blocks use, P1 fix soon, P2 note) and the smallest fix. Say `no issues found` for a question where the code holds up. End with a one-line verdict.",
].join("\n");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "peer-review-"));
const hub = new AgentHub({
	modelsStore: catalog,
	getAuth: () => Object.fromEntries(Object.entries(catalog).map(([n, p]) => [n, p.apiKey])),
	persist: async () => {},
	broadcast: () => {},
	getTools: () => tools,
	mediaDir: path.join(dataDir, "media"),
	defaultModelId: MODEL,
});
hub.getSession("review-parent", { modelId: MODEL });

const role = resolveRole("reviewer", {});
const t0 = Date.now();
const spawned = hub.spawnPeer("review-parent", { role, task: TASK, model: MODEL });
if (!spawned.ok) { console.error(`spawn refused: ${spawned.reason}`); process.exit(1); }
console.log(`[peer-review] peer ${spawned.peerId} running as "${role.name}"…`);
const tick = setInterval(() => {
	const v = hub.peers.statusOf("review-parent", spawned.peerId);
	if (v) console.log(`  … ${v.status} ${Math.round((Date.now() - t0) / 1000)}s turns=${v.turns} tokens=${(v.usage?.input || 0) + (v.usage?.output || 0)}${v.currentTool ? ` tool=${v.currentTool}` : ""}`);
}, 20000);

const out = await spawned.promise;
clearInterval(tick);
console.log(`\n[peer-review] ${out.status} in ${Math.round((Date.now() - t0) / 1000)}s · turns=${out.turns} · tokens=${(out.usage?.input || 0) + (out.usage?.output || 0)} · session=${out.sessionId}\n`);
console.log(out.summary || `(no text: ${out.error})`);
const child = out.sessionId ? hub.sessions.get(out.sessionId) : null;
if (child) console.log(`\n[peer-review] child transcript: ${child.agent.state.messages.length} messages`);
process.exit(out.status === "ok" ? 0 : 1);
