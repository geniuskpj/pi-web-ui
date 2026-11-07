// peer-perf.mjs — the SAME peer task on the two backends, measured (user request 2026-10-31: "compare
// performance with one using default wiring").
//
// The point of the unified design is that only the streamFn differs, so any difference here is the
// BACKEND, not the peer machinery:
//   * pi     — a pi-ai provider model (default wiring, `streamSimple`): tokens/turns are reported,
//              tools work, the run can stream and be steered.
//   * arena  — the CDP bridge (lib/arena-stream.mjs): one browser tab, text in/out, no tools, no usage.
//
// Both runs go through `hub.spawnPeer()` with the same role and task, so the numbers include everything a
// user would experience. Arena is opt-in (`--arena`) because it drives the logged-in browser tab.
//
// Usage: node ws-diag/peer-perf.mjs [piModelId] [--arena] [--arena-slug=grok-4.6-high] [--task="…"]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentHub } from "../agent-hub.mjs";
import { buildProviderCatalog } from "../lib/pi-catalog.mjs";
import { resolveRole } from "../lib/peer-roles.mjs";
import { createArenaBridge } from "../lib/arena-stream.mjs";

const PI_DIR = process.env.PI_WEB_PI_DIR || "C:/pi-windows-x64/.pi";
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), ".."); // ws-diag/.. = the repo root
const args = process.argv.slice(2);
const flag = (n, d = null) => { const hit = args.find((a) => a.startsWith(`--${n}=`)); return hit ? hit.split("=").slice(1).join("=") : d; };
const PI_MODEL = args.find((a) => !a.startsWith("--")) || "deepseek-ai/deepseek-v4.1-flash";
const WITH_ARENA = args.includes("--arena");
const ARENA_SLUG = flag("arena-slug", "grok-4.6-high");
const TASK = flag("task", "In one short paragraph: what is the single biggest risk in keeping a done-list as a JSON array in memory and writing it to disk on every change? Answer only, no tools.");

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(path.join(PI_DIR, f), "utf8")); } catch { return {}; } };
const readTolerant = (f) => { const raw = (() => { try { return fs.readFileSync(path.join(PI_DIR, f), "utf8"); } catch { return ""; } })(); try { return JSON.parse(raw); } catch { /* JSONC */ } try { return JSON.parse(raw.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/,(\s*[}\]])/g, "$1")); } catch { return {}; } };
const { providers } = buildProviderCatalog({ store: readJson("models-store.json"), modelsJson: readTolerant("models.json"), auth: readJson("auth.json") });

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "peer-perf-"));
const hub = new AgentHub({
	modelsStore: providers,
	getAuth: () => Object.fromEntries(Object.entries(providers).map(([n, p]) => [n, p.apiKey])),
	persist: async () => {},
	broadcast: () => {},
	getTools: () => [],                     // a pure latency comparison: no tool round-trips
	mediaDir: path.join(dataDir, "media"),
	defaultModelId: PI_MODEL,
	arena: createArenaBridge({ repoRoot: REPO, log: (m) => console.log(m) }),
	peerLimits: { maxWallClockMs: 5 * 60 * 1000 },
});
hub.getSession("perf-parent", { modelId: PI_MODEL });
const role = resolveRole("oracle", {});

async function run(label, model) {
	const t0 = Date.now();
	let firstText = 0;
	const spawned = hub.spawnPeer("perf-parent", { role, task: TASK, model });
	if (!spawned.ok) return { label, model, error: spawned.reason };
	// the peer's own progress frames carry lastText — that is the visible "time to first token" here
	const poll = setInterval(() => {
		const v = hub.peers.statusOf("perf-parent", spawned.peerId);
		if (!firstText && v?.lastText) firstText = Date.now();
	}, 100);
	const out = await spawned.promise;
	clearInterval(poll);
	const elapsedMs = Date.now() - t0;
	return {
		label,
		model,
		status: out.status,
		elapsedMs,
		firstVisibleMs: firstText ? firstText - t0 : null,
		turns: out.turns,
		tokens: (out.usage?.input || 0) + (out.usage?.output || 0),
		chars: String(out.summary || "").length,
		sessionId: out.sessionId,
		error: out.error || null,
	};
}

const rows = [];
rows.push(await run("pi (default wiring)", PI_MODEL));
if (WITH_ARENA) rows.push(await run("arena (CDP bridge)", `arena/${ARENA_SLUG}`));
else {
	const avail = await hub.arena.available();
	console.log(`[perf] arena skipped (--arena to include it): ${avail.ok ? "available" : avail.reason}`);
}

const pad = (s, n) => String(s ?? "-").padEnd(n);
console.log("\n=== peer backends — same role, same task, same code path ===");
console.log(`${pad("backend", 22)}${pad("status", 8)}${pad("elapsed", 10)}${pad("1st visible", 13)}${pad("turns", 7)}${pad("tokens", 9)}chars`);
for (const r of rows) {
	console.log(`${pad(r.label, 22)}${pad(r.status, 8)}${pad(r.elapsedMs ? `${(r.elapsedMs / 1000).toFixed(1)}s` : "-", 10)}${pad(r.firstVisibleMs ? `${(r.firstVisibleMs / 1000).toFixed(1)}s` : "-", 13)}${pad(r.turns, 7)}${pad(r.tokens || "-", 9)}${r.chars ?? "-"}`);
}
for (const r of rows) if (r.error) console.log(`  ! ${r.label}: ${r.error}`);
console.log("\nnotes: 'tokens' is empty for arena by design (the bridge reports no usage). A peer on arena has NO");
console.log("tools and cannot be steered mid-run; the pi path streams deltas, arena returns the finished text.");
