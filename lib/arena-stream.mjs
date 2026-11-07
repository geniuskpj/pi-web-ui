// arena-stream.mjs — arena.ai as a MODEL BACKEND for the ordinary peer path.
//
// Design (user instruction, 2026-10-31: "rather than make new codes, use the same api/codes for subagent,
// both pi/arena"): a peer keeps being ONE thing — a normal session with a role and a pi-agent-core Agent.
// The only difference is the `streamFn` and the model object the Agent is built with. So there is no
// second peer implementation, no parallel transcript, no special-case status/control/journal/caps: the
// arena bridge is just another way to produce assistant text.
//
// What pi-ai's streamFn contract requires (read from dist/providers/faux.js, the reference implementation):
//   createAssistantMessageEventStream() → push `start` (with `partial`) → `text_start` →
//   n `text_delta` → `text_end` → `done` (with the final message) → stream.end(message).
// An abort or a failure pushes `{type:"error", reason:"aborted"|"error", error:<message>}` and ends.
//
// Truthful limitations of this backend, stated once here so no caller has to guess:
//   * the bridge is TEXT IN / TEXT OUT — no tool calls, no images, no usage numbers, no thinking deltas.
//     A peer on arena therefore gets an EMPTY tool list and zero usage; the result says so.
//   * ONE browser tab ⇒ ONE call at a time: every call is serialized behind a single promise chain, and
//     the token stream arrives as a single block (the bridge reads the tab after the answer settles), so
//     there are no incremental deltas to forward. Progress is reported through the peer's `lastText`
//     instead, which is what the strip shows.
//   * the bridge lives outside this repo (default `../arena/chat-api.mjs`, override with
//     PI_WEB_ARENA_BRIDGE); it is imported lazily, and its absence is a clear error — never a boot failure.

import path from "node:path";
import { pathToFileURL } from "node:url";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

/** `arena/<slug>` or `arena:<slug>` selects this backend; anything else is a pi-ai model id. */
export const ARENA_PREFIX = /^arena\s*[:/]\s*(.+)$/i;
export const DEFAULT_BRIDGE = "../arena/chat-api.mjs";
const CDP_HTTP = process.env.PI_WEB_CDP_HTTP || "http://127.0.0.1:9222";

/** What backend does this spec name? Pure: used by the hub, the tool and the tests. */
export function parseModelSpec(spec) {
	const s = String(spec ?? "").trim();
	if (!s) return null;
	const m = ARENA_PREFIX.exec(s);
	if (m) {
		const slug = m[1].trim();
		return slug ? { kind: "arena", slug, spec: `arena/${slug}` } : null;
	}
	// "arena/" with no slug must NOT fall through to the pi branch: a half-spec is a typo, and treating it
	// as a pi model id would surface later as "model not found" instead of the real problem
	if (/^arena\s*[:/]?\s*$/i.test(s)) return null;
	return { kind: "pi", id: s, spec: s };
}

/** The model object a peer gets: enough for pi-agent-core, the UsageBar and the session header. */
export function arenaModel(slug) {
	return {
		id: `arena/${slug}`,
		name: `arena · ${slug}`,
		provider: "arena",
		api: "arena-bridge",
		reasoning: false,
		input: ["text"],
		discovered: true,
	};
}

/** The limitation, stated IN the prompt (not only in the tool description the model may never read). */
export const ARENA_PEER_NOTE =
	"you are running through a browser bridge, not a coding agent: you have NO tools, you cannot read files " +
	"or run commands, and you can only answer in text. If the task needs files or commands, name the ones the " +
	"parent should run instead of pretending you already did.";

const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** Flatten a pi-ai Context into the single prompt the arena tab can be given. */
export function flattenContext(context) {
	// every arena prompt carries ARENA_PEER_NOTE: the model cannot discover that it has no tools
	const ctx = context || {};
	const out = [];
	const system = [ctx.systemPrompt, ARENA_PEER_NOTE].filter(Boolean).join("\n\n");
	if (system) out.push(`# System\n${system}`);
	const messages = Array.isArray(ctx.messages) ? ctx.messages : [];
	if (messages.length) {
		out.push("# Conversation");
		for (const m of messages) {
			const role = m?.role || "?";
			const text = typeof m.content === "string"
				? m.content
				: (m.content || []).map((b) => (b?.type === "text" ? b.text : b?.type === "toolCall" ? `[tool call ${b.name}]` : b?.type === "toolResult" || b?.type === "tool_result" ? `[tool result] ${typeof b.content === "string" ? b.content : ""}` : b?.type === "image" ? "[image]" : "")).filter(Boolean).join("\\n");
			if (text) out.push(`${role}: ${text}`);
		}
	}
	return out.join("\\n\\n");
}

/**
 * The bridge: one CDP tab, one call at a time. `chat({slug, message, signal, onUpdate})` never throws —
 * it returns `{status, text, routedModel, error}` — because the streamFn must always be able to end its
 * stream with something a peer can report.
 */
export function createArenaBridge({ bridgePath = null, repoRoot = null, timeoutMs = Number(process.env.PI_WEB_ARENA_TIMEOUT_MS) || 5 * 60 * 1000, log = () => {} } = {}) {
	const resolved = bridgePath || process.env.PI_WEB_ARENA_BRIDGE || (repoRoot ? path.resolve(repoRoot, DEFAULT_BRIDGE) : null);
	let mod;
	let queue = Promise.resolve();
	let inFlight = 0;
	let modelsCache = { at: 0, models: null }; // the arena catalog is a whole tab fetch: cache it

	async function load() {
		if (mod !== undefined) return mod;
		if (!resolved) { mod = null; return null; }
		try { mod = await import(pathToFileURL(resolved).href); log(`[arena] bridge: ${resolved}`); }
		catch (err) { mod = null; log(`[arena] no bridge at ${resolved} (${err?.message || err})`); }
		return mod;
	}

	async function available() {
		if (!(await load())?.chat) return { ok: false, reason: resolved ? `no usable arena bridge at ${resolved}` : "no arena bridge configured (PI_WEB_ARENA_BRIDGE)" };
		try {
			const targets = await (await fetch(`${CDP_HTTP}/json`, { signal: AbortSignal.timeout(2500) })).json();
			const tab = (Array.isArray(targets) ? targets : []).find((t) => t.type === "page" && String(t.url || "").startsWith("https://arena.ai/"));
			return tab ? { ok: true, reason: null } : { ok: false, reason: "no arena.ai tab in the debugged browser — open arena.ai (logged in) to run arena peers" };
		} catch (err) {
			return { ok: false, reason: `no CDP browser at ${CDP_HTTP}: ${String(err?.message || err).slice(0, 120)}` };
		}
	}

	/**
	 * Resolve a human slug ("grok-4.6-high") to the arena model UUID. Needed because the bridge's own
	 * `chat(message, slug)` matches `x.slug`, a field the live catalog NO LONGER HAS (checked against
	 * ws/arena/models.json: entries carry publicName/displayName/name + id) — so its slug path can never
	 * hit and every arena peer would fail with "not found in catalog". We match on the names and hand the
	 * bridge the id it can actually use.
	 */
	async function resolveModelId(slug) {
		const bridge = await load();
		if (!bridge?.listModels || !slug) return null;
		if (!modelsCache.models || Date.now() - modelsCache.at > 60_000) {
			try { modelsCache = { at: Date.now(), models: await serialize(() => bridge.listModels()) }; }
			catch { return null; }
		}
		const want = String(slug).toLowerCase().replace(/\s*\(max\)$/, "");
		const names = (m) => [m.publicName, m.displayName, m.name, m.slug].filter(Boolean).map((v) => String(v).toLowerCase());
		const all = Array.isArray(modelsCache.models) ? modelsCache.models : [];
		const exact = all.find((m) => names(m).includes(want));
		const prefixed = exact || all.find((m) => names(m).some((n) => n.startsWith(want)));
		return prefixed?.id || null;
	}

	/** Suggestions for an unknown slug — the error should teach, not just refuse. */
	async function suggest(slug, limit = 8) {
		const bridge = await load();
		if (!bridge?.listModels) return [];
		if (!modelsCache.models) { try { modelsCache = { at: Date.now(), models: await serialize(() => bridge.listModels()) }; } catch { return []; } }
		const head = String(slug || "").toLowerCase().split(/[-.]/)[0];
		return (modelsCache.models || []).filter((m) => m.userSelectable !== false).map((m) => m.publicName || m.displayName || m.name).filter(Boolean)
			.filter((n) => String(n).toLowerCase().startsWith(head))
			.slice(0, limit);
	}

	async function listNames(limit = 40) {
		const bridge = await load();
		if (!bridge?.listModels) return null;
		try {
			if (!modelsCache.models) modelsCache = { at: Date.now(), models: await serialize(() => bridge.listModels()) };
			return (modelsCache.models || []).filter((m) => m.userSelectable !== false).map((m) => m.publicName || m.displayName || m.name).filter(Boolean).slice(0, limit);
		} catch { return null; }
	}

	const serialize = (fn) => {
		const run = queue.then(fn, fn);
		queue = run.then(() => undefined, () => undefined);
		return run;
	};

	async function chat({ slug, message, signal = null, onUpdate = () => {} } = {}) {
		// the counter goes up BEFORE the lazy import (found by tests/arena-peer.test.mjs Q5): otherwise a
		// caller cannot tell that a call is already queued for the tab while the module is still loading
		const queued = inFlight > 0;
		inFlight += 1;
		try {
			const bridge = await load();
			if (!bridge?.chat) return { status: "error", error: resolved ? `no usable arena bridge at ${resolved}` : "no arena bridge configured", text: "" };
			if (queued) onUpdate({ lastText: "waiting for the arena tab (one call at a time)…" });
			const started = Date.now();
			const modelId = await resolveModelId(slug); // the bridge's slug path is broken; give it the uuid
			if (!modelId) {
				const hints = await suggest(slug);
				return { status: "error", error: `arena has no model "${slug}"${hints.length ? ` — did you mean: ${hints.join(", ")}` : " (list the catalog with subagent({action:\"list\"}))"}`, text: "" };
			}
			const call = serialize(async () => {
				let timer = null;
				try {
					return await Promise.race([
						bridge.chat(message, slug, modelId),
						new Promise((_r, rej) => { timer = setTimeout(() => rej(new Error(`arena call exceeded ${Math.round(timeoutMs / 1000)}s`)), timeoutMs); }),
					]);
				} finally { clearTimeout(timer); }
			});
			onUpdate({ lastText: queued ? "arena: started" : "arena: typing…" });
			const out = await call;
			const text = String(out?.text || "").trim();
			if (signal?.aborted) return { status: "aborted", error: "stopped while the arena tab was answering", text: "" };
			return { status: text ? "ok" : "error", text, routedModel: out?.routedModel || null, convId: out?.convId || null, error: text ? null : "the arena tab returned no text", elapsedMs: Date.now() - started };
		} catch (err) {
			const aborted = !!signal?.aborted;
			return { status: aborted ? "aborted" : "error", error: aborted ? "stopped by the user" : String(err?.message || err), text: "" };
		} finally { inFlight -= 1; }
	}

	return { available, chat, listNames, resolveModelId, busy: () => inFlight > 0, bridgePath: resolved, _reset: () => { mod = undefined; queue = Promise.resolve(); inFlight = 0; modelsCache = { at: 0, models: null }; } };
}

/**
 * The streamFn a peer's Agent is built with when its model is `arena/<slug>`. Same signature as
 * `streamSimple`, so NOTHING else in the hub knows the difference.
 */
export function makeArenaStreamFn({ bridge, slug, model = null, log = () => {} }) {
	return (m, context, options = {}) => {
		const stream = createAssistantMessageEventStream();
		const modelObj = model || m || arenaModel(slug);
		const base = {
			role: "assistant",
			content: [],
			api: modelObj.api || "arena-bridge",
			provider: modelObj.provider || "arena",
			model: modelObj.id || `arena/${slug}`,
			usage: ZERO_USAGE,
			stopReason: "pending",
			timestamp: Date.now(),
		};
		const partial = { ...base, content: [] };
		(async () => {
			try {
				stream.push({ type: "start", partial: { ...partial } });
				const prompt = flattenContext(context);
				const out = await bridge.chat({
					slug,
					message: prompt,
					signal: options.signal,
					onUpdate: (patch) => { try { options.onUpdate?.(patch); } catch { /* listener */ } },
				});
				if (out.status !== "ok") {
					const final = { ...base, stopReason: out.status === "aborted" ? "aborted" : "error", errorMessage: out.error || "arena failed" };
					stream.push({ type: "error", reason: final.stopReason, error: final });
					stream.end(final);
					return;
				}
				partial.content = [{ type: "text", text: "" }];
				stream.push({ type: "text_start", contentIndex: 0, partial: { ...partial } });
				// ONE delta: the bridge reads the finished answer (the tab streams to the browser, not to us)
				partial.content[0].text = out.text;
				stream.push({ type: "text_delta", contentIndex: 0, delta: out.text, partial: { ...partial } });
				stream.push({ type: "text_end", contentIndex: 0, content: out.text, partial: { ...partial } });
				const final = { ...base, content: [{ type: "text", text: out.text }], stopReason: "stop" };
				stream.push({ type: "done", reason: "stop", message: final });
				stream.end(final);
			} catch (err) {
				const final = { ...base, stopReason: "error", errorMessage: String(err?.message || err) };
				log(`[arena] stream failed: ${final.errorMessage}`);
				stream.push({ type: "error", reason: "error", error: final });
				stream.end(final);
			}
		})();
		return stream;
	};
}
