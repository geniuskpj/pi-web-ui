// ab-probe.mjs — same-minute interleaved A/B: the pi CLI vs. a direct pi-ai call, both
// against the SAME endpoint (the pi CLI is pointed at ws-diag/log-proxy.mjs, which forwards
// to nvidia), same model, same "low" thinking, same prompt.
//
// Why: the numbers so far (2-9-30-50s for an identical request) look like endpoint variance,
// but they were never measured in the SAME minute on both paths. If the CLI answers in 2-3s
// while our pi-ai call takes 35-50s in the same minute, the difference is in the request or
// in our process — and the captured bodies (ws-diag/requests.log) say exactly what differs.
//
// Usage: node ws-diag/ab-probe.mjs [rounds] [modelId] [provider]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { buildProviderCatalog } from "../lib/pi-catalog.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PI_ROOT = path.resolve(ROOT, "..", "..");
const ROUNDS = Number(process.argv[2] || 3);
const MODEL = process.argv[3] || "z-ai/glm-5.3-flash";
const PROVIDER = process.argv[4] || "nvidia";
const PROMPT = "Reply with exactly: OK";
const TUI_AGENT_DIR = path.join(HERE, "pi-tui");
const now = () => Number(process.hrtime.bigint() / 1000000n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const readJson = (f, dir = path.join(PI_ROOT, ".pi")) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { return null; } };
const auth = readJson("auth.json") || {};
const KEY = typeof auth[PROVIDER] === "string" ? auth[PROVIDER] : auth[PROVIDER]?.key;
// our server's exact model object (merged catalog) AND the pristine catalog one
const merged = buildProviderCatalog({ store: readJson("models-store.json") || {}, modelsJson: readJson("models.json") || {}, auth, builtinModels: (n) => { try { return getBuiltinModels(n) || []; } catch { return []; } }, env: process.env });
const serverModel = merged.providers[PROVIDER]?.models.find((m) => m.id === MODEL);
const catalogModel = (() => { try { return (getBuiltinModels(PROVIDER) || []).find((m) => m.id === MODEL); } catch { return null; } })();

async function piAiCall(label, model, { forceProxy = false } = {}) {
	const t0 = now();
	let first = null, err = null;
	try {
		const m = { ...model, provider: PROVIDER, apiKey: KEY };
		if (forceProxy) m.baseUrl = "http://127.0.0.1:8799/v1";
		const stream = await streamSimple(m, { messages: [{ role: "user", content: [{ type: "text", text: PROMPT }] }] }, { apiKey: KEY, thinkingLevel: "low" });
		for await (const ev of stream) {
			if ((ev.type === "text_delta" || ev.type === "thinking_delta") && first == null) first = now() - t0;
			if (ev.type === "error") err = ev.error?.errorMessage || "error";
		}
	} catch (e) { err = e?.message || String(e); }
	return { label, first, total: now() - t0, err };
}

function tuiCall(label) {
	return new Promise((resolve) => {
		const t0 = now();
		let first = null;
		const env = { ...process.env, PI_CODING_AGENT_DIR: TUI_AGENT_DIR.replace(/\\/g, "/"), PI_DIR: TUI_AGENT_DIR.replace(/\\/g, "/"), PI_WS: PI_ROOT.replace(/\\/g, "/") };
		delete env.PI_WEB_TOKEN;
		const child = spawn(path.join(PI_ROOT, "pi.exe"), ["--no-session", "-p", PROMPT, "--model", `${PROVIDER}/${MODEL}:low`, "--mode", "text"], { cwd: path.join(HERE, "tui-cwd"), env, windowsHide: true });
		child.stdout.on("data", () => { if (first == null) first = now() - t0; });
		child.stderr.on("data", () => {});
		const kill = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 180000);
		child.on("close", (code) => { clearTimeout(kill); resolve({ label, first, total: now() - t0, err: code === 0 ? null : `exit ${code}` }); });
		child.on("error", (e) => { clearTimeout(kill); resolve({ label, first, total: now() - t0, err: e.message }); });
	});
}

const fmt = (r) => `${r.label.padEnd(28)} first ${String(r.first == null ? "NONE" : Math.round(r.first) + "ms").padStart(7)} · total ${String(Math.round(r.total) + "ms").padStart(7)}${r.err ? " · " + r.err : ""}`;
console.log(`[ab] ${PROVIDER}/${MODEL} · key ${KEY ? "yes" : "MISSING"} · ${ROUNDS} interleaved rounds (CLI first, then our call)`);
for (let i = 1; i <= ROUNDS; i++) {
	console.log(`--- round ${i} @ ${new Date().toISOString().slice(11, 19)}`);
	console.log("  " + fmt(await tuiCall("[pi CLI]")));
	console.log("  " + fmt(await piAiCall("[our pi-ai call]", serverModel)));
	await sleep(500);
}
console.log("\n[captured CLI bodies] (ws-diag/requests.log):");
try { console.log(fs.readFileSync(path.join(HERE, "requests.log"), "utf8").trim().split("\n").slice(-ROUNDS).join("\n")); } catch { console.log("  (none)"); }
process.exit(0);
