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
import { buildPeerResult, resultText } from "./lib/peer-lifecycle.mjs";

const ROLE_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i;
/** A delegation task is a briefing, not a file dump (grok pre-restart review, P2). */
const MAX_TASK_CHARS = 32 * 1024;
/** Steering a peer is a nudge, not a new prompt. */
const MAX_STEER_CHARS = 8 * 1024;

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
		try {
			if (meta.kind === "peer" && meta.role?.model && /^arena\s*[:/]/i.test(String(meta.role.model))) {
				// an ARENA peer has no tools at all: the bridge is text in / text out (lib/arena-stream.mjs).
				// Same peer path, same session, same journal — only the backend differs.
				return [];
			}
			if (meta.kind === "peer" && !meta.role) {
				// an unresolvable role is the SAFEST case, not the widest (grok pre-restart review, P1)
				return base.filter((t) => t.name === "read_file");
			}
			if (meta.role || meta.kind === "peer") {
				const names = new Set(toolsForRole(meta.role, base.map((t) => t.name)));
				return base.filter((t) => names.has(t.name));
			}
			if (!enabled) return base;
			return [...base, makeSubagentTool(sessionId)];
		} catch (err) {
			// ONE broken role file must not cost a session its tools (grok pre-restart review): a peer falls
			// back to nothing but its read-only read tools, a user session to the plain builtin set.
			log(`[peer] toolsForSession fell back for ${String(sessionId).slice(0, 8)}: ${err?.message || err}`);
			return meta.role || meta.kind === "peer" ? base.filter((t) => t.name === "read_file") : base;
		}
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
					model: { type: "string", description: "optional model override: a pi model id (e.g. deepseek-ai/deepseek-v4.1-flash) or arena/<slug> (e.g. arena/grok-4.6-high) for a keyless peer — arena peers have NO tools" },
				},
				required: ["action"],
			},
			async execute(_id, params, signal, onUpdate) {
				const hubRef = () => hub();
				const action = String(params?.action || "").trim();
				const asText = (text, details = null) => ({ content: [{ type: "text", text }], ...(details ? { details } : {}) });

				if (action === "list") {
					// an unreadable role file is REPORTED as such, never printed as a half-built row; and the
					// model should not pick a backend that cannot run on this machine
					const arena = await (hubRef().arena?.available?.() ?? Promise.resolve({ ok: false, reason: "no arena bridge configured" }));
					const lines = catalog().map((r) => (r.error
						? `- ${r.name}: ${r.error}`
						: `- ${r.name} (${r.acceptanceRole}${r.model ? `, ${r.model}` : ""}) — ${r.description || "(no description)"} [${r.tools} tools]`));
					if (arena.ok) {
						// show REAL slugs from the live catalog: the model should not guess a name that does not exist
						const names = await (hubRef().arena?.listNames?.(6) ?? Promise.resolve(null)).catch?.(() => null) ?? null;
						lines.push(`- arena: AVAILABLE — pass model:\`arena/<slug>\` for a keyless peer with NO tools${names?.length ? ` (e.g. ${names.join(", ")})` : " (e.g. arena/grok-4.6-high)"}`);
					} else {
						lines.push(`- arena: unavailable (${arena.reason})`);
					}
					return asText(lines.join("\n"));
				}
				if (action === "status") {
					const peers = hubRef().peersOf(parentSessionId);
					const budget = hubRef().remainingPeerBudget(parentSessionId);
					const tail = `budget: ${budget.spawns} spawns left, ${budget.concurrent} concurrent (${budget.concurrentGlobal} globally)`;
					return asText(peers.length ? `${peers.map(peerLine).join("\n")}\n${tail}` : `no peers yet\n${tail}`, { peers, budget });
				}
				if (action === "stop" || action === "steer" || action === "retry") {
					const text = String(params?.text || "").slice(0, MAX_STEER_CHARS);
					// the control path needs the SAME guarantee as `run` (deepseek review P1): an exception
					// here used to escape execute() and leave the parent's tool call with no result at all
					try {
						const r = await hubRef().controlPeer(parentSessionId, String(params?.peerId || ""), params?.all ? "stop-all" : action, { text, reason: "the parent agent stopped it" });
						const okText = params?.all ? `stopped ${r.stopped ?? 0} peer(s)` : `${action === "steer" ? "steered" : action === "retry" ? "retrying" : "stopping"} ${params?.peerId}`;
						return asText(r.ok ? okText : `could not ${action}: ${r.reason}`);
					} catch (err) {
						const res = buildPeerResult({ status: "error", peerId: params?.peerId || null, role: null, error: `the ${action} request failed: ${String(err?.message || err)}` });
						return asText(resultText(res), res);
					}
				}
				if (action !== "run") return asText(`unknown action "${action}" — use run, list, status, stop, steer or retry`);

				const role = resolvePeerRole(params?.role);
				if (!role) {
					const names = catalog().map((r) => r.name);
					return asText(`unknown role "${params?.role}". Available: ${names.join(", ")}`);
				}
				const task = String(params?.task || "").trim();
				if (!task) return asText("`task` is required for action:run — give the peer a self-contained job");
				if (task.length > MAX_TASK_CHARS) return asText(`task is too long (${task.length} > ${MAX_TASK_CHARS} chars) — split it into two delegations`);
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
				// an ALREADY-aborted signal never fires the listener (grok pre-restart review, P1): a spawn that
				// races a parent stop would otherwise run to completion
				if (signal?.aborted) onAbort(); else signal?.addEventListener?.("abort", onAbort, { once: true });
				try {
					const out = await hubRef().peers.wait(spawned.peerId, parentSessionId);
					hubRef().closePeerJournal(parentSessionId, spawned.peerId, { status: out.status, error: out.error, usage: out.usage, turns: out.turns, sessionId: out.sessionId });
					// `peerId` travels with the result (copilot review 2026-10-31): every follow-up — the UI's
					// transcript link, stop/steer/retry — addresses a peer BY id, not by its child session
					// ONE truncation, inside resultText (grok pre-restart review, P1): truncating here as well
					// re-cut the marker on the second pass, and truncated `details.summary` for failures too.
					const summary = out.status === "ok" ? String(out.summary || "") : "";
					const res = buildPeerResult({ status: out.status, peerId: spawned.peerId, sessionId: out.sessionId, role: role.name, model: out.model, usage: out.usage, error: out.error, summary });
					res.truncated = Buffer.byteLength(summary, "utf8") > hubRef().peerLimits.summaryBytes;
					log(`[peer] ${role.name} ${res.status} (${res.usage.input + res.usage.output} tokens, ${out.turns ?? 0} turns)`);
					return asText(resultText(res), res);
				} catch (err) {
					// THE LAST LINE OF DEFENCE (grok pre-restart review, P0): whatever throws — a wedged wait, a
					// journal write, a malformed result — the parent MUST get exactly one tool result, or the next
					// provider call fails on a dangling tool call and the session is stuck.
					const res = buildPeerResult({ status: "error", peerId: spawned.peerId, sessionId: null, role: role.name, error: `the peer could not be awaited: ${String(err?.message || err)}` });
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
