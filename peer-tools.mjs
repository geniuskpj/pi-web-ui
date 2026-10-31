// peer-tools.mjs — the SERVER half of subagents/peers: role files on disk, the per-session tool list,
// and the `subagent` tool the parent agent calls (plan-subagents.md M1/M2).
//
// Kept out of server.mjs on purpose: server.mjs wires it with two lines (`createPeerIntegration`) and
// this file stays unit-testable without booting a server. Everything impure is injected or read here.
//
// The two rules that live here:
//   1. a PEER gets its role's narrowed tool set — read-only roles simply do not have write/edit/bash, so
//      no prompt can talk them into it (the tool list is the boundary, not the prompt);
//   2. a USER session gets the normal set plus ONE bound `subagent` tool, whose execute() does nothing
//      but `peers.wait(peerId)` — the supervisor owns lifecycle, so no hub lock is held across the run.

import fs from "node:fs";
import path from "node:path";
import { resolveRole, toolsForRole, roleCatalog } from "./lib/peer-roles.mjs";
import { buildPeerResult, resultText, truncateUtf8 } from "./lib/peer-lifecycle.mjs";

const ROLE_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i;

/**
 * @param {object} deps
 * @param {() => object} deps.hub            lazy accessor for the AgentHub (it is built after this)
 * @param {() => Array}  deps.usableTools    the tools a normal session may use (already allowlisted)
 * @param {string}       deps.piDir          the pi config dir (`.pi`) where `agents/` lives
 * @param {string}       deps.workspaceDir   the workspace (its `.pi/agents/` overrides the global dir)
 * @param {boolean}      [deps.enabled]      PI_WEB_PEERS kill switch
 * @param {(msg: string) => void} [deps.log]
 */
export function createPeerIntegration({ hub, usableTools, piDir, workspaceDir, enabled = true, log = () => {} }) {
	const roleTextCache = new Map(); // full path → { mtime, text }: a role file is re-read only when it changes
	const dirs = () => [...new Set([path.join(piDir, "agents"), path.join(workspaceDir, ".pi", "agents")])];

	/** Every readable role file, keyed by role name; later dirs (the workspace) win. */
	function readRoleFiles() {
		const files = {};
		for (const dir of dirs()) {
			let names = [];
			try { names = fs.readdirSync(dir); } catch { continue; }
			for (const f of names) {
				if (!f.endsWith(".md") || f.startsWith(".")) continue;
				const name = f.slice(0, -3);
				if (!ROLE_NAME_RE.test(name)) continue; // a file name can never escape the role namespace
				const full = path.join(dir, f);
				try {
					const st = fs.statSync(full);
					const hit = roleTextCache.get(full);
					let text = hit && hit.mtime === st.mtimeMs ? hit.text : null;
					if (text === null) {
						text = fs.readFileSync(full, "utf8");
						roleTextCache.set(full, { mtime: st.mtimeMs, text });
					}
					files[name] = text;
				} catch { /* unreadable file: the builtin of that name still works */ }
			}
		}
		return files;
	}

	const resolvePeerRole = (name) => resolveRole(name, { files: readRoleFiles(), dirs: dirs() });
	const catalog = () => roleCatalog(usableTools().map((t) => t.name), { files: readRoleFiles(), dirs: dirs() });

	/** The tool list for ONE session: the only place a peer and a user session differ. */
	function toolsForSession(sessionId, meta = {}) {
		const base = usableTools();
		if (meta.role || meta.kind === "peer") {
			const names = new Set(toolsForRole(meta.role, base.map((t) => t.name)));
			return base.filter((t) => names.has(t.name));
		}
		if (!enabled) return base;
		return [...base, makeSubagentTool(sessionId)];
	}

	const peerLine = (p) =>
		`${p.id} — ${p.role || "peer"} · ${p.status} · ${Math.round((p.elapsedMs || 0) / 1000)}s` +
		`${p.currentTool ? ` · ${p.currentTool}` : ""}${p.lastText ? ` — ${String(p.lastText).slice(0, 90)}` : ""}` +
		`${p.sessionId ? ` (session ${p.sessionId})` : ""}`;

	function makeSubagentTool(parentSessionId) {
		return {
			name: "subagent",
			label: "Subagent",
			source: "builtin",
			description: [
				"Delegate a task to a PEER agent: a child session with its own role prompt and its own narrowed tool set.",
				"The peer's whole conversation is a normal session the user can open, and you get only its final report back.",
				"",
				"actions:",
				"- run: spawn a peer (`role` + `task`). Blocks until it finishes; progress streams into this tool row.",
				"- list: the available roles (what each one is for, whether it can write, its model).",
				"- status: this session's peers with live status, elapsed time and token use.",
				"- stop: cancel a running peer (`peerId`), or all of them (`all:true`).",
				"- steer: send guidance to a RUNNING peer (`peerId` + `text`); applied at its next step.",
				"- retry: resume a FINISHED peer that failed (`peerId`). A live peer must be stopped first.",
				"",
				"Use read-only roles (reviewer, oracle, scout) for opinions and reviews; `worker` can edit files.",
				"Peers cannot delegate further. One precise task beats several vague ones — every peer costs tokens.",
			].join("\n"),
			parameters: {
				type: "object",
				properties: {
					action: { type: "string", enum: ["run", "list", "status", "stop", "steer", "retry"], description: "what to do" },
					role: { type: "string", description: "role name for run (reviewer, oracle, scout, worker, delegate)" },
					task: { type: "string", description: "self-contained task for the peer, with the paths it needs" },
					peerId: { type: "string", description: "peer id for stop/steer/retry (see status)" },
					text: { type: "string", description: "guidance for steer" },
					all: { type: "boolean", description: "stop every peer of this session" },
					model: { type: "string", description: "optional model id override for the peer" },
				},
				required: ["action"],
			},
			async execute(_id, params, signal, onUpdate) {
				const hubRef = () => hub();
				const action = String(params?.action || "").trim();
				const asText = (text, details = null) => ({ content: [{ type: "text", text }], ...(details ? { details } : {}) });

				if (action === "list") {
					return asText(catalog().map((r) => `- ${r.name} (${r.acceptanceRole}${r.model ? `, ${r.model}` : ""}) — ${r.description || "(no description)"} [${r.tools} tools]`).join("\n"));
				}
				if (action === "status") {
					const peers = hubRef().peersOf(parentSessionId);
					const budget = hubRef().remainingPeerBudget(parentSessionId);
					const tail = `budget: ${budget.spawns} spawns left, ${budget.concurrent} concurrent (${budget.concurrentGlobal} globally)`;
					return asText(peers.length ? `${peers.map(peerLine).join("\n")}\n${tail}` : `no peers yet\n${tail}`, { peers, budget });
				}
				if (action === "stop" || action === "steer" || action === "retry") {
					const r = await hubRef().controlPeer(parentSessionId, String(params?.peerId || ""), params?.all ? "stop-all" : action, { text: String(params?.text || ""), reason: "the parent agent stopped it" });
					const okText = params?.all ? `stopped ${r.stopped ?? 0} peer(s)` : `${action === "steer" ? "steered" : action === "retry" ? "retrying" : "stopping"} ${params?.peerId}`;
					return asText(r.ok ? okText : `could not ${action}: ${r.reason}`);
				}
				if (action !== "run") return asText(`unknown action "${action}" — use run, list, status, stop, steer or retry`);

				const role = resolvePeerRole(params?.role);
				if (!role) {
					const names = catalog().map((r) => r.name);
					return asText(`unknown role "${params?.role}". Available: ${names.join(", ")}`);
				}
				const task = String(params?.task || "").trim();
				if (!task) return asText("`task` is required for action:run — give the peer a self-contained job");
				const spawned = hubRef().spawnPeer(parentSessionId, { role, task, model: params?.model || null });
				if (!spawned.ok) {
					const res = buildPeerResult({ status: "error", role: role.name, error: spawned.reason });
					return asText(resultText(res), res);
				}
				log(`[peer] ${parentSessionId.slice(0, 8)} → ${role.name} (${spawned.peerId})`);
				// progress into the parent's tool row (the peer view is already rate-limited by the hub)
				const poll = onUpdate ? setInterval(() => {
					const v = hubRef().peers.statusOf(parentSessionId, spawned.peerId);
					if (!v) return;
					try { onUpdate({ content: [{ type: "text", text: `peer ${peerLine(v)}` }] }); } catch { /* socket gone */ }
				}, 1000) : null;
				poll?.unref?.();
				const onAbort = () => { try { hubRef().peers.cancel(spawned.peerId, { reason: "the parent's turn was aborted", status: "aborted" }); } catch { /* already gone */ } };
				signal?.addEventListener?.("abort", onAbort, { once: true });
				try {
					const out = await hubRef().peers.wait(spawned.peerId, parentSessionId);
					hubRef().closePeerJournal(parentSessionId, spawned.peerId, { status: out.status, error: out.error, usage: out.usage, turns: out.turns });
					const res = buildPeerResult({ status: out.status, sessionId: out.sessionId, role: role.name, model: out.model, usage: out.usage, error: out.error, summary: out.summary || "" });
					const cut = truncateUtf8(res.summary, hubRef().peerLimits.summaryBytes);
					res.summary = cut.text;
					res.truncated = cut.truncated;
					log(`[peer] ${role.name} ${res.status} (${res.usage.input + res.usage.output} tokens, ${out.turns ?? 0} turns)`);
					return asText(resultText(res), res);
				} finally {
					if (poll) clearInterval(poll);
					signal?.removeEventListener?.("abort", onAbort);
				}
			},
		};
	}

	return { toolsForSession, resolvePeerRole, catalog, readRoleFiles, dirs, enabled };
}
