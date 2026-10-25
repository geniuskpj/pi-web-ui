import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Agent, type AgentMessage, type AgentState } from "@earendil-works/pi-agent-core";
// pi-ai 1.4.0: getModel + the generic streamSimple moved to the compat subpath
// (root only ships per-api modules now); TextContent still lives in root types
import { getModel } from "@earendil-works/pi-ai/compat";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { TextContent } from "@earendil-works/pi-ai";
import { customConvertToLlm } from "./llm.js";
import { makeId } from "./id.js";
import { SessionListDialog } from "./ui/session-list.js";
import { AliveSessionsDialog } from "./ui/alive-sessions.js";
import { SettingsDialog } from "./ui/settings.js";
import { ModelSelector } from "./ui/model-selector.js";
import { AppStorage, CustomProvidersStore, ProviderKeysStore, SessionsStore, SettingsStore, setAppStorage } from "./storage.js";
import { ChatView } from "./ui/chat.js";
import { createApiKeyResolver, createProxyStreamFn } from "./ui/proxy-stream.js";
import { defaultModelFromCache, fetchAndApplyConfig, loadCachedConfig, type PiConfig } from "./pi-import.js";
import { ProxyAgent } from "./proxy-agent.js";
import { sessionSync, type RuntimeRecord } from "./session-sync.js";
import { getToken, installServerAuth, onServerAuth, retryServerAuth, type ServerAuthState } from "./server-auth.js";
import { LocalStorageBackend } from "./local-storage-backend.js";
import { fetchPiServerTools } from "./pi-tools.js";
import { termBus } from "./ui/terminal.js";
import { DiagPanel } from "./diag-panel.js";
import { dlog } from "./diag.js";

// ============================================================================
// CONSTANTS + GLOBAL STATE
// ============================================================================
const DB_NAME = "pi-web-ui-app-v3";
let agent: any;
let serverMode = false; // default: server-side loop (?local=1 → legacy in-browser loop)
let currentSessionId: string | undefined;
let currentTitle = "";
let piConfigData: PiConfig | null = null;
let agentUnsubscribe: (() => void) | undefined;

type Listener = () => void;
const agentListeners = new Set<Listener>();
const notify = () => agentListeners.forEach((l) => l());

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T | undefined> {
	return Promise.race([
		p,
		new Promise<undefined>((resolve) => setTimeout(() => {
			dlog.warn("[init]", label + " timed out after " + ms + "ms");
			resolve(undefined);
		}, ms)),
	]);
}

function since() {
	try {
		return `+${Math.round(performance.now())}ms`;
	} catch {
		return "";
	}
}

// ============================================================================
// STORAGE — LocalStorageBackend (never hangs, unlike IndexedDB)
// ============================================================================
const settings = new SettingsStore();
const providerKeys = new ProviderKeysStore();
const sessions = new SessionsStore();
const customProviders = new CustomProvidersStore();

const backend = new LocalStorageBackend({
	dbName: DB_NAME,
	version: 1,
	stores: [
		settings.getConfig(),
		providerKeys.getConfig(),
		customProviders.getConfig(),
		sessions.getConfig(),
		SessionsStore.getMetadataConfig(),
	],
});

settings.setBackend(backend);
providerKeys.setBackend(backend);
customProviders.setBackend(backend);
sessions.setBackend(backend);

const storage = new AppStorage(settings, providerKeys, sessions, customProviders, backend);
setAppStorage(storage); // session-sync, pi-import, and the Preact UI
(window as any).__app = { storage, getAgent: () => agent, backend };
// boot scavenger (grok design B, step 4): drop frozen/poison/over-cap session
// bodies from the quota era and mark them bodyLocation:'server' — after first
// paint, so the session list never waits on storage
setTimeout(() => { void SessionsStore.scavengeBodies(sessions); }, 3000);

// ============================================================================
// SESSION HELPERS
// ============================================================================
const generateTitle = (messages: AgentMessage[]): string => {
	const firstUserMsg = messages.find((m) => m.role === "user");
	if (!firstUserMsg) return "";
	let text = "";
	const content = firstUserMsg.content;
	if (typeof content === "string") text = content;
	else text = content.filter((c): c is TextContent => c.type === "text").map((c) => c.text || "").join(" ");
	text = text.trim();
	if (!text) return "";
	const sentenceEnd = text.search(/[.!?]/);
	if (sentenceEnd > 0 && sentenceEnd <= 50) return text.substring(0, sentenceEnd + 1);
	return text.length <= 50 ? text : `${text.substring(0, 47)}...`;
};

const shouldSaveSession = (messages: AgentMessage[]): boolean =>
	messages.some((m) => m.role === "user") && messages.some((m) => m.role === "assistant");

// grok P4 review: a deleted session must never resurrect via the save debounce
// or the pagehide flush — saveSession refuses deleted ids, and delete clears
// currentSessionId BEFORE the navigation so flushSession() no-ops.
const deletedSessionIds = new Set<string>();

const saveSession = async () => {
	if (!storage.sessions || !currentSessionId || !agent || !currentTitle) return;
	if (deletedSessionIds.has(currentSessionId)) return;
	const state = agent.state;
	if (!shouldSaveSession(state.messages)) return;
	try {
		const now = new Date().toISOString();
		// SERVER-FIRST (grok design B): the WS push is the DURABLE copy — never gate
		// it on the local save (a 5MB+ body overflows the origin quota and used to
			// skip the push entirely). The local write below is a cache + may omit the
		// body (bodyLocation:server) — the metadata write always succeeds.
		sessionSync.push(currentSessionId);
		await storage.sessions.save(
			{
				id: currentSessionId,
				title: currentTitle,
				model: state.model!,
				thinkingLevel: state.thinkingLevel,
				messages: state.messages,
				createdAt: now,
				lastModified: now,
			},
			{
				id: currentSessionId,
				title: currentTitle,
				createdAt: now,
				lastModified: now,
				messageCount: state.messages.length,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				thinkingLevel: state.thinkingLevel,
				preview: generateTitle(state.messages),
			},
		);
	} catch (err) {
		dlog.error("[init] save session failed:", err);
	}
};

let saveTimer: ReturnType<typeof setTimeout> | undefined;
const saveSessionSoon = () => {
	if (saveTimer) return;
	saveTimer = setTimeout(() => { saveTimer = undefined; saveSession(); }, 1200);
};
const flushSession = () => {
	if (saveTimer) { clearTimeout(saveTimer); saveTimer = undefined; saveSession(); }
};

const updateUrl = (sessionId: string) => {
	const url = new URL(window.location.href);
	url.searchParams.set("session", sessionId);
	window.history.replaceState({}, "", url);
};

// ============================================================================
// SERVER-SIDE AGENT (default path, 2026-10-21)
// ============================================================================
// The agent loop runs in Node (agent-hub.mjs): runs SURVIVE browser/phone
// closes (the server keeps going as long as it is alive), and every attached
// device (PC/phone) receives the same live /ws/agent event stream — send from
// one device, watch progress from another, or send from the other one.
// ?local=1 restores the legacy in-browser loop (createAgent below).
const createServerAgent = async (sessionId: string, initialModel?: any) => {
	if (agentUnsubscribe) agentUnsubscribe();
	// close the PREVIOUS server agent's socket (a listener-only unsubscribe would
	// leave it attached to the old session, still receiving every event)
	if (agent && typeof agent.disconnect === "function") agent.disconnect();
	const serverAgent = new ProxyAgent(sessionId, initialModel);
	serverAgent.subscribe((event: any) => {
		// the SERVER persists to the JSONL mirror after every turn; the local save
		// keeps this device's session list instant and works while offline
		const messages: AgentMessage[] = serverAgent.state.messages;
		if (event.type === "state-snapshot") {
			if (!currentTitle && shouldSaveSession(messages)) currentTitle = generateTitle(messages);
			notify();
			return;
		}
		if (event.type === "message_end" || event.type === "message_update") {
			if (!currentTitle && shouldSaveSession(messages)) currentTitle = generateTitle(messages);
			if (!currentSessionId && shouldSaveSession(messages)) {
				currentSessionId = sessionId;
				updateUrl(currentSessionId);
				sessionSync.push(currentSessionId);
			}
			if (currentSessionId) saveSessionSoon();
		}
		if (event.type === "agent_end") {
			flushSession();
			if (currentSessionId) sessionSync.push(currentSessionId);
		}
		notify();
	});
	agent = serverAgent;
	currentSessionId = sessionId;
	currentTitle = ""; // re-derived from the attach snapshot
	updateUrl(sessionId);
	serverAgent.connect();
	notify();
};

// ============================================================================
// AGENT CREATION
// ============================================================================
// Effective system prompt for the WEB agent: .pi/WEB_SYSTEM.md (a filename pi's TUI
// never reads), or a built-in composed prompt when no file exists. The SERVER resolves
// it (/api/pi/system → effective.text) so the in-browser agent cannot drift from the
// server-side one; APPEND_SYSTEM.md is not part of the web prompt (2026-10-25).
let piSystemPrompt: string | undefined;
let piServerTools: any[] = [];
const resolvePiSystemPrompt = async (): Promise<string | undefined> => {
	try {
		const r = await fetch("/api/pi/system", { signal: AbortSignal.timeout(8000) });
		if (!r.ok) return undefined;
		const j: any = await r.json();
		// the SERVER's resolution, verbatim (file or built-in) — no client-side precedence
		// logic to drift from the hub's (the old code re-derived base+append here).
		const text = j.effective?.text;
		return typeof text === "string" && text.length > 0 ? text : undefined; // nothing → pi's chat default
	} catch { return undefined; } // offline → default prompt
};

const createAgent = async (initialState?: Partial<AgentState>) => {
	dlog.debug("[init]", since(), "createAgent start");
	if (agentUnsubscribe) agentUnsubscribe();

	const bootModel = lastModelFromLocal() || defaultModelFromCache() || getModel("anthropic", "claude-sonnet-4-5-20250929");
	const bootThinking = (localStorage.getItem("pi.lastThinkingLevel") as AgentState["thinkingLevel"]) || (loadCachedConfig()?.defaults.thinkingLevel as AgentState["thinkingLevel"]) || "high";
	dlog.debug("[init]", since(), "boot model:", bootModel.id, "thinking:", bootThinking);

	// in-browser Agent (proven working with undici-hardened proxy)
	// bugs.md #18: honor the initialState param (regression of #10's fix — was
	// silently dropped). undefined-values are filtered so an explicit undefined
	// can't clobber defaults (e.g. tools: undefined → agent.tools.map() crash).
	const overrides: Partial<AgentState> = initialState
		? (Object.fromEntries(Object.entries(initialState).filter(([, v]) => v !== undefined)) as Partial<AgentState>)
		: {};
	agent = new Agent({
		// pi-ai 1.4.0: streamFn is REQUIRED — start with the compat generic
		// dispatcher; the proxy-aware streamFn below replaces it immediately
		streamFn: streamSimple as any,
		initialState: {
			systemPrompt: piSystemPrompt || "You are a helpful AI assistant.",
			model: bootModel,
			thinkingLevel: bootThinking,
			messages: [],
			// NEW_UI: ChatPanel's toolsFactory never runs — register the server tools
			// directly (repl tool intentionally dropped, plan §1)
			tools: piServerTools as any,
			...overrides,
		},
		convertToLlm: customConvertToLlm,
	});

	// P2 wiring: vendored proxy streamFn + key resolver (was ChatPanel's setAgent
	// + build.mjs patches). Re-applied on EVERY createAgent — session switches
	// construct a new Agent (grok P2 review: losing this goes direct/unkeyed).
	agent.streamFn = createProxyStreamFn();
	agent.getApiKey = createApiKeyResolver(providerKeys);

	agentUnsubscribe = agent.subscribe((event: any) => {
		// read agent state AFTER the event is applied (like the real Agent)
		const messages: AgentMessage[] = agent.state.messages;
		if (event.type === "message_end" || event.type === "message_update") {
			if (!currentTitle && shouldSaveSession(messages)) currentTitle = generateTitle(messages);
			if (!currentSessionId && shouldSaveSession(messages)) {
				// makeId: crypto.randomUUID is secure-context-only — undefined on
				// http://<LAN-IP> (user report: tool calls failed off-localhost)
				currentSessionId = makeId();
				updateUrl(currentSessionId);
				sessionSync.push(currentSessionId);
			}
			if (currentSessionId) saveSessionSoon();
		}
		if (event.type === "agent_end") {
			flushSession();
			if (currentSessionId) sessionSync.push(currentSessionId);
			// pi-agent-core flips isStreaming=false in finishRun() AFTER agent_end
			agent.waitForIdle?.().then(() => {
				notify();
			});
		}
		notify();
	});

	// loading history doesn't emit any agent events — force the UI to pick it up
	notify();
};

// ============================================================================
// MODEL PERSISTENCE
// ============================================================================
function lastModelFromLocal(): any {
	try {
		const s = localStorage.getItem("pi.lastModel");
		return s ? JSON.parse(s) : undefined;
	} catch { return undefined; }
}

function saveLastModel(m: any) {
	try { if (m) localStorage.setItem("pi.lastModel", JSON.stringify(m)); } catch { /* quota */ }
}

function setServerStatus(online: boolean) {
	window.dispatchEvent(new CustomEvent("pi-server-status", { detail: online }));
}

/** mini-lit ThemeToggle replacement: same "theme" key + .dark class contract. */
function applyThemeClass() {
	let t: string;
	try {
		t = localStorage.getItem("theme") || "system";
	} catch {
		t = "system";
	}
	const dark = t === "dark" || (t === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
	document.documentElement.classList.toggle("dark", dark);
}

function setToastBg(msg: string) {
	window.dispatchEvent(new CustomEvent("pi-toast", { detail: msg }));
}

// ============================================================================
// SESSION MANAGEMENT
// ============================================================================
const loadSession = async (sessionId: string): Promise<boolean> => {
	if (!sessionId) return false;
	flushSession(); // grok P4: don't lose the last debounce when switching sessions
	if (serverMode) {
		// SERVER path: the hub hydrates from the JSONL mirror itself; the attach
		// snapshot delivers messages + model — works from any device (the session
		// list on the phone opens the same transcript the PC is streaming)
		try {
			// ?meta=1: existence + counts ONLY — the old call downloaded the full
			// 2-7.3MB body just to read j.exists (tail-first plan)
			const r = await fetch(`/api/agent/session/${encodeURIComponent(sessionId)}?meta=1`, { signal: AbortSignal.timeout(8000) });
			if (r.ok) {
				const j = await r.json();
				if (j.exists === false && !(Array.isArray(j.messages) && j.messages.length > 0)) {
				// not on the server — if this device has a LOCAL copy (e.g. from the
				// old browser-loop era), migrate it to the hub, else prune (grok r3 Q2)
				const localData = await storage.sessions.get(sessionId).catch(() => null);
				if (localData && Array.isArray(localData.messages) && localData.messages.length > 0) {
					await fetch(`/api/agent/session/${encodeURIComponent(sessionId)}`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ sessionId, messages: localData.messages, modelId: localData.model?.id || localData.modelId, thinkingLevel: localData.thinkingLevel }),
					}).catch(() => {});
					await createServerAgent(sessionId, localData.model || lastModelFromLocal());
					return true;
				}
				try { await ((storage.sessions as any).getBackend()).delete("sessions-metadata", sessionId); } catch { /* noop */ }
				dlog.warn("[init]", "session not found on server:", String(sessionId).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24) || "(unparseable)");
				return false;				}
			}
		} catch { /* offline — try the attach anyway */ }
		await createServerAgent(sessionId, lastModelFromLocal() || defaultModelFromCache());
		return true;
	}
	// bugs.md #17: resolve from BOTH stores and take the more complete copy.
	// Local is authoritative on this device (saved every turn); the server mirror
	// matters for cross-device ?session= links and may be empty/stale.
	let local: any = null;
	try {
		const data = await storage.sessions.get(sessionId);
		if (data && Array.isArray(data.messages) && data.messages.length > 0) local = data;
	} catch { /* corrupt entry — fall through to server */ }
	let server: any = null;
	try {
		const r = await fetch(`/api/agent/session/${sessionId}`, { signal: AbortSignal.timeout(8000) });
		if (r.ok) {
			const j = await r.json();
			if (j.exists && Array.isArray(j.messages) && j.messages.length > 0) server = j;
		}
	} catch { /* offline — local is enough */ }
	// SERVER WINS TIES (grok design B): the old length>= rule let a frozen/poison
	// local copy win restores. Local only when strictly more complete AND newer.
	const localWin = !server || (!!local && (local.messages.length > server.messages.length || (local.messages.length === server.messages.length && String(local.lastModified || "") >= String((server as any).metadata?.lastModified || server.lastModified || ""))));
	const snap: any = localWin ? local : server;
	if (!snap) {
		// dead entry (no local body, no server copy) — prune the metadata so the
		// list self-heals instead of landing on newSession() on every click
		try { await ((storage.sessions as any).getBackend()).delete("sessions-metadata", sessionId); } catch { /* noop */ }
		// sanitize before logging: sessionId comes from the ?session= query param
		// (URL-controlled) and lands in the diagnostics log ring — the diag fallback
		// view must never become an HTML injection vector
		dlog.warn("[init]", "session not found anywhere:", String(sessionId).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24) || "(unparseable)");
		return false;
	}
	// self-heal: the server mirror is missing/stale → push the local copy back
	if (local && (!server || server.messages.length < local.messages.length)) sessionSync.push(sessionId);
	currentSessionId = sessionId;
	currentTitle = (localWin ? local?.title : server.title) || "";
	updateUrl(sessionId); // keep ?session= so a reload re-loads the same chat
	// resolve the full model object from the config cache
	const cfg = loadCachedConfig();
	const modelId = snap.modelId || snap.model?.id;
	let resolvedModel: any = undefined;
	if (cfg) {
		for (const p of cfg.providers) {
			const m = p.models.find((x: any) => x.id === modelId);
			if (m) { resolvedModel = { ...m, provider: p.name }; break; }
		}
	}
	// local bodies carry the exact model object that was in use — best fallback
	if (!resolvedModel && localWin && local?.model && typeof local.model === "object") resolvedModel = local.model;
	if (!resolvedModel) resolvedModel = lastModelFromLocal();
	// create the agent WITH the loaded messages — not empty
	await createAgent({
		model: resolvedModel,
		thinkingLevel: snap.thinkingLevel || "high",
		messages: snap.messages || [],
	});
	// land at the BOTTOM (latest message) — long transcripts sometimes stayed at
	// the top when a session was clicked (user report); ChatView re-sticks a few
	// times over the first second as markdown blocks finish laying out
	setTimeout(() => window.dispatchEvent(new CustomEvent("pi-chat-scroll-bottom")), 60);
	return true;
};

const loadSessionById = async (sessionId: string) => {
	if (!(await loadSession(sessionId))) newSession();
};
// fork/rewrite navigation: ChatView's ⑂/✎ actions dispatch pi-open-session with
// the target session id (forked clone; original stays put)
window.addEventListener("pi-open-session", (e: Event) => {
	const id = (e as CustomEvent).detail;
	if (typeof id === "string" && id) void loadSessionById(id);
});
const deleteSessionById = (deletedSessionId: string) => {
	deletedSessionIds.add(deletedSessionId);
	if (saveTimer) {
		clearTimeout(saveTimer);
		saveTimer = undefined;
	}
	// hub-side tombstone: abort a live run + block later persists (no resurrection)
	void fetch("/api/agent/discard", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ sessionId: deletedSessionId }),
	}).catch(() => {});
	const wasCurrent = deletedSessionId === currentSessionId;
	if (wasCurrent) currentSessionId = undefined; // saveSession/flush no-op from here
	sessionSync.delete(deletedSessionId);
	storage.sessions.delete(deletedSessionId).catch(() => {});
	if (wasCurrent) newSession();
};

const newSession = () => {
	const url = new URL(window.location.href);
	url.search = "";
	window.location.href = url.toString();
};

const runPiImport = async (withKey: boolean): Promise<string> => {
	const fresh = await fetchAndApplyConfig();
	if (!fresh) return "pi config unavailable (server not running?)";
	let msg = `Loaded from pi: ${fresh.providers.map((p) => `${p.name}(${p.models.length})`).join(", ")}`;
	if (withKey && fresh.defaults.provider) {
		const provider = fresh.defaults.provider;
		const existing = await providerKeys.get(provider);
		if (existing) {
			msg += ` — key already set`;
		} else {
			try {
				const r = await fetch("/api/pi/key", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider }) });
				if (r.ok) {
					const d = await r.json();
					await providerKeys.set(provider, d.key);
					msg += ` — key for "${provider}" imported`;
				} else {
					msg += ` — no key for "${provider}"`;
				}
			} catch { msg += ` — key import failed`; }
		}
	}
	notify(); // refresh model-dependent UI
	return msg;
};

// ============================================================================
// UI (Preact shell)
// ============================================================================
const ICONS = {
	history: ["M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8", "M3 3v5h5", "M12 7v5l4 2"],
	plus: ["M5 12h14", "M12 5v14"],
	settings: [
		"M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z",
		"M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
	],
	terminal: ["m4 17 6-6-6-6", "M12 19h8"],
	activity: ["M22 12h-4l-3 9L9 3l-3 9H2"], // heartbeat — active server-side runs
};

const Icon = ({ d, ...rest }: { d: string | string[] } & Record<string, any>) => (
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
		{(Array.isArray(d) ? d : [d]).map((p, i) => <path key={i} d={p} />)}
	</svg>
);

function App() {
	const [, setTick] = useState(0);
	const [title, setTitle] = useState(currentTitle);
	const [editing, setEditing] = useState(false);
	const [toast, setToast] = useState<string | undefined>();
	const [serverOnline, setOnline] = useState<boolean | null>(null);
	const [genStatus, setGenStatus] = useState<"" | "thinking" | "generating">("");
	const [runtime, setRuntime] = useState<ReadonlyMap<string, RuntimeRecord>>(() => sessionSync.runtimeSnapshot());
	const [bannerDismissed, setBannerDismissed] = useState(false);
	// server auth/authorization state → persistent banner (2026-10-23): a 403 or a
	// rejected token used to be invisible (empty session list, no message)
	const [authIssue, setAuthIssue] = useState<{ state: ServerAuthState; detail: string } | null>(null);
	const [sessionsOpen, setSessionsOpen] = useState(false);
	const [aliveOpen, setAliveOpen] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [modelOpen, setModelOpen] = useState(false);
	const [themeMode, setThemeMode] = useState<string>(localStorage.getItem("theme") || "system");
	const [titleDraft, setTitleDraft] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		const listener = () => { setTitle(currentTitle); setTick((t) => t + 1); };
		agentListeners.add(listener);
		return () => agentListeners.delete(listener);
	}, []);

	// runtime status (fable5 design): header badge + resume banner + tab title.
	// Applied immediately — session-sync bypasses its 5s metadata throttle for these.
	useEffect(() => sessionSync.onRuntime(() => setRuntime(new Map(sessionSync.runtimeSnapshot()))), []);
	useEffect(() => {
		const running = [...runtime.values()].filter((r) => r.status === "running").length;
		document.title = (running > 0 ? "▶ " : "") + "pi web";
	}, [runtime]);

	// Editor's model button → open the picker (decoupled via event)
	useEffect(() => {
		const onOpenModel = () => setModelOpen(true);
		window.addEventListener("pi-open-model-selector", onOpenModel);
		// toolbar/settings mutate agent.state without agent events — re-render shell
		const onStateChanged = () => setTick((t) => t + 1);
		window.addEventListener("pi-agent-state-changed", onStateChanged);
		return () => {
			window.removeEventListener("pi-open-model-selector", onOpenModel);
			window.removeEventListener("pi-agent-state-changed", onStateChanged);
		};
	}, []);

	useEffect(() => onServerAuth((state, detail) => {
		setAuthIssue(state === "ok" ? null : { state, detail });
	}), []);

	useEffect(() => {
		const onStatus = (e: Event) => setOnline(Boolean((e as CustomEvent).detail));
		const onToast = (e: Event) => setToast(String((e as CustomEvent).detail || ""));
		window.addEventListener("pi-server-status", onStatus);
		window.addEventListener("pi-toast", onToast);
		return () => { window.removeEventListener("pi-server-status", onStatus); window.removeEventListener("pi-toast", onToast); };
	}, []);

	useEffect(() => {
		if (!toast) return;
		const t = setTimeout(() => setToast(undefined), 6000);
		return () => clearTimeout(t);
	}, [toast]);

	useEffect(() => { if (editing) { setTitleDraft(title); inputRef.current?.focus(); } }, [editing]);

	const commitTitle = (value: string) => {
		const v = value.trim();
		if (v && v !== currentTitle && storage.sessions && currentSessionId) {
			storage.sessions.updateTitle(currentSessionId, v).then(() => {
				currentTitle = v;
				setTitle(v);
				sessionSync.push(currentSessionId!); // mirror the rename to the server
			});
		}
		setEditing(false);
	};

	const applyModel = (model: any) => {
		if (!agent) return;
		agent.state.model = model;
		agent.setModel?.(model.id); // server-side agent: propagate to the hub
		saveLastModel(model);
		localStorage.setItem("pi.lastThinkingLevel", String(agent.state.thinkingLevel ?? "high"));
		notify();
	};

	const cycleTheme = () => {
		const order = ["system", "light", "dark"] as const;
		const cur = (localStorage.getItem("theme") as any) || "system";
		const next = order[(order.indexOf(cur) + 1) % order.length];
		localStorage.setItem("theme", next);
		applyThemeClass();
		setThemeMode(next);
	};

	// alive sessions (running/error) EXCLUDING the current one — the badge counts
	// "other stuff needs me"; the dialog lists ALL alive incl. current (claude review)
	const aliveElsewhere = [...runtime.values()].filter(
		(r) => (r.status === "running" || r.status === "error") && r.sessionId !== currentSessionId,
	);
	return (
		<div class="w-full h-full flex flex-col overflow-hidden">
			<header class="pi-header">
				<div class="pi-header-left">
					<button class="pi-btn" title="Sessions" onClick={() => setSessionsOpen(true)}>
						<Icon d={ICONS.history} />
					</button>
					<button class="pi-btn" title="New session" onClick={newSession}>
						<Icon d={ICONS.plus} />
					</button>
					{editing ? (
						<input
							ref={inputRef}
							class="pi-input"
							type="text"
							value={titleDraft}
							style={{ width: "220px" }}
							onInput={(e: Event) => setTitleDraft((e.target as HTMLInputElement).value)}
							onKeyDown={(e: KeyboardEvent) => { if (e.key === "Enter") commitTitle(titleDraft); else if (e.key === "Escape") setEditing(false); }}
							onBlur={() => commitTitle(titleDraft)}
						/>
					) : title ? (
						<button class="pi-title-btn" title="Click to edit title" onClick={() => setEditing(true)}>{title}</button>
					) : (
						<span style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "0 6px" }}>
							<span style={{ fontWeight: 600, fontSize: "15px" }}>pi web</span>
							{serverOnline === false && (
								<span title="Server offline" style={{ width: 8, height: 8, borderRadius: 8, background: "#e5484d", display: "inline-block" }} />
							)}
						</span>
					)}
				</div>
				<div class="pi-header-right">
					<button class="pi-btn" title="Terminal (bash dock — no node-pty)" onClick={() => termBus.toggle()}>
						<Icon d={ICONS.terminal} />
					</button>
					<button
						class="pi-btn pw-alive-btn"
						title="Active sessions — runs live on the server (running/error), with Kill"
						onClick={() => setAliveOpen(true)}
					>
						<Icon d={ICONS.activity} />
						{aliveElsewhere.length > 0 && (
							<span class={"pw-alive-count" + (aliveElsewhere.some((r) => r.status === "error") ? " pw-alive-count-error" : "")}>
								{aliveElsewhere.length}
							</span>
						)}
					</button>
	<button class="pi-btn pi-theme" title={`Theme: ${themeMode} (click to cycle)`} onClick={cycleTheme}>
						<span style={{ fontSize: 11, fontWeight: 600 }}>{themeMode === "system" ? "Auto" : themeMode === "light" ? "Light" : "Dark"}</span>
					</button>
					<button class="pi-btn" title="Settings" onClick={() => setSettingsOpen(true)}>
						<Icon d={ICONS.settings} />
					</button>
				</div>
			</header>
			{!currentSessionId && !bannerDismissed && runtime.size > 0 && (() => {
				// resume banner (fable5: NO auto-navigation — one deliberate tap)
				const latest = [...runtime.values()].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))[0];
				if (!latest) return null;
				return (
					<div class="pw-resume-banner">
						<span class="pw-resume-text">
							▶ Task running in background{latest.lastText ? ` — ${latest.lastText.slice(0, 80)}` : ""}
						</span>
						<button class="pw-resume-btn" onClick={() => { setBannerDismissed(true); loadSessionById(latest.sessionId); }}>Resume</button>
						<button class="pw-resume-close" title="Dismiss" onClick={() => setBannerDismissed(true)}>✕</button>
					</div>
				);
			})()}
			{authIssue && (
				<div class="pi-auth-banner" role="alert">
					<span class="pi-auth-ico" aria-hidden="true">{authIssue.state === "offline" ? "⚡" : "⛔"}</span>
					<span class="pi-auth-body">
						{authIssue.state === "no-token" && <><b>Server token required.</b> Read <code>data/auth-token.txt</code> on the server machine, then paste it in Settings → Server token.</>}
						{authIssue.state === "bad-token" && <><b>Server token rejected.</b> The stored token no longer matches <code>data/auth-token.txt</code> — paste the current one in Settings → Server token.</>}
						{authIssue.state === "host-blocked" && <><b>Server refused this host.</b> {authIssue.detail} — add this name on the server (<code>PI_WEB_TERM_ORIGIN</code>) or relax the gate (<code>PI_WEB_ORIGIN_GATE</code>, default <code>auto</code> already allows a valid token).</>}
						{authIssue.state === "offline" && <><b>Server unreachable.</b> {authIssue.detail || "check the server process and the network"}.</>}
					</span>
					<button class="pi-auth-btn" onClick={() => { void retryServerAuth(); }}>Retry</button>
					{authIssue.state !== "offline" && (
						<button class="pi-auth-btn" onClick={() => setSettingsOpen(true)}>Settings</button>
					)}
				</div>
			)}
			{agent ? <ChatView agent={agent} retryState={currentSessionId ? runtime.get(currentSessionId)?.retry : undefined} onCancelRetry={() => { const a: any = agent; void a?.cancelRetry?.()?.catch?.(() => {}); }} /> : <div class="pw-chat" />}
			{toast && <div class="pi-toast">{toast}</div>}
			<AliveSessionsDialog
				open={aliveOpen}
				currentSessionId={currentSessionId}
				onLoad={loadSessionById}
				onViewAll={() => setSessionsOpen(true)}
				onClose={() => setAliveOpen(false)}
			/>
			<SessionListDialog
				open={sessionsOpen}
				onLoad={loadSessionById}
				onDelete={deleteSessionById}
				onClose={() => setSessionsOpen(false)}
			/>
			<SettingsDialog
				open={settingsOpen}
				agent={agent}
				onModelPick={() => setModelOpen(true)}
				onImportPi={() => runPiImport(true).then(setToast)}
				onClose={() => setSettingsOpen(false)}
			/>
			<ModelSelector
				open={modelOpen}
				current={agent?.state.model}
				onPick={applyModel}
				onClose={() => setModelOpen(false)}
			/>
		</div>
	);
}

// ============================================================================
// INIT — boot from SYNCHRONOUS localStorage; background enrichment
// ============================================================================
async function init() {
	const params = new URLSearchParams(window.location.search);
	if (params.has("reset-storage")) {
		try {
			indexedDB.deleteDatabase(DB_NAME);
			indexedDB.deleteDatabase("pi-web-ui-app");
			localStorage.clear();
			console.info("[init] storage reset requested");
		} catch (err) { console.warn("[init] reset failed:", err); }
		const url = new URL(window.location.href);
		url.searchParams.delete("reset-storage");
		window.location.replace(url.toString());
		return;
	}

	// theme class BEFORE first paint (mini-lit ThemeToggle replacement, same
	// localStorage key "theme": system|light|dark + .dark class on <html>)
	applyThemeClass();
	try {
		matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
			if ((localStorage.getItem("theme") || "system") === "system") applyThemeClass();
		});
	} catch {
		/* old browsers */
	}

	// NOTE (2026-10-23, grok review): the API token is a SETTINGS credential — stored in
	// localStorage as `pi.webToken` and never read from the URL. A share link carrying
	// `#token=` would hand whoever opens it full control (bash/exec + every session), so
	// that path was deliberately removed; hand out the token only to people who should
	// have the whole server (and see the read-only-scope open item).

	// server auth: auto-generated token gates every /api/* + /ws/* call from
	// non-loopback peers. installServerAuth() attaches the stored token to same-origin
	// API calls, prompts once on a bare 401, and — new (2026-10-23) — reports 401/403
	// to the shell so a rejected token or a blocked Host is never silent again.
	installServerAuth();
	// WebSocket: append ?token= for /ws/* (WS can't set custom headers; the server
	// accepts the query form for /ws/* only — plain HTTP must use the header)
	const RealWS = window.WebSocket;
	window.WebSocket = class extends RealWS {
		constructor(url: string | URL, protocols?: string | string[]) {
			try {
				const u = new URL(String(url));
				const tok = getToken();
				if (u.pathname.startsWith("/ws/") && tok && !u.searchParams.has("token")) u.searchParams.set("token", tok);
				super(u, protocols as any);
			} catch { super(url as any, protocols as any); }
		}
	};

	// server-side agent (DEFAULT, 2026-10-21): tools + system prompt live server-side —
	// the browser fetches neither. ?local=1 restores the legacy in-browser loop.
	serverMode = !params.has("local");
	if (serverMode) {
		piServerTools = []; // tools are declared AND executed by agent-hub in-process
		const bootModel = lastModelFromLocal() || defaultModelFromCache();
		await createServerAgent(params.get("session") || makeId(), bootModel);
	} else {
		// resolve the web system prompt from the server (WEB_SYSTEM.md, or the built-in
		// the server composes when no file exists — bugs: the web agent must SHARE the
		// resolved prompt, not just display it) — resolved once before any createAgent()
		// call (boot, ?session= restore, dialog click)
		piSystemPrompt = await resolvePiSystemPrompt();
		(window as any).__piSystemPrompt = piSystemPrompt; // debuggable from the console
		piServerTools = await fetchPiServerTools(); // pi extensions + workspace tools (sync for toolsFactory)
		(window as any).__piServerTools = piServerTools.map((t) => t.name);
	}

	// proxy defaults in SYNCHRONOUS localStorage
	if (location.protocol.startsWith("http")) {
		localStorage.setItem("pi.proxyEnabled", localStorage.getItem("pi.proxyEnabled") ?? "1");
		localStorage.setItem("pi.proxyUrl", localStorage.getItem("pi.proxyUrl") || `${location.origin}/api/proxy`);
	}

	// background enrichment — never blocks first paint
	void (async () => {
	 fetch("/api/health").then((r) => setServerStatus(r.ok)).catch(() => setServerStatus(false));

	 // seed session runtime status (banner/badge) before the first sync frame
	 try {
	  const sr = await fetch("/api/sessions", { signal: AbortSignal.timeout(8000) });
	  if (sr.ok) { const sd = await sr.json(); sessionSync.seedRuntime(sd.sessions || []); }
	 } catch { /* offline */ }

		try {
			const fresh = await withTimeout(fetchAndApplyConfig(), 8000, "pi config refresh");
			if (fresh) {
				dlog.info("[pi] config refreshed:", fresh.providers.map((p) => `${p.name}(${p.models.length})`).join(", "));
				if (agent && !lastModelFromLocal() && !shouldSaveSession(agent.state.messages)) {
					const def = defaultModelFromCache(fresh);
					if (def && (agent.state.model as any)?.id !== def.id) {
						agent.state.model = def;
						agent.state.thinkingLevel = (fresh.defaults.thinkingLevel as AgentState["thinkingLevel"]) || "high";
						saveLastModel(def);
						localStorage.setItem("pi.lastThinkingLevel", fresh.defaults.thinkingLevel || "high");
						notify();
						dlog.debug("[init]", since(), "model set from config:", def.id);
					}
				}
			}
		} catch (err) { dlog.warn("[init] pi config refresh failed:", err); }

		// NOTE: proxy settings live ONLY in localStorage (pi.proxyEnabled/pi.proxyUrl,
		// seeded synchronously at boot) — the old IDB settings-store seeding was
		// removed (grok P4: don't keep a second source of truth).

		const sessionId = new URLSearchParams(window.location.search).get("session");
		// server mode: the session was passed to the server agent at boot and the
		// attach snapshot hydrates it — no background restore needed
		if (sessionId && !serverMode) {
			const ok = (await withTimeout(loadSession(sessionId), 15000, "session load")) === true;
			dlog.debug("[init]", since(), "background session load:", ok);
			if (!ok) setToastBg("Could not load that session (server or storage unavailable).");
		}
	})();

	if (!serverMode) await createAgent(); // server mode already created the ProxyAgent
	render(<><App /><DiagPanel /></>, document.getElementById("app")!);
	dlog.debug("[init]", since(), "rendered");

	sessionSync.connect();
	addEventListener("pagehide", flushSession);
	document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushSession(); });
}

init().catch((err) => {
	dlog.error("[init] fatal:", err);
	render(<div class="pi-splash">Failed to start: {String(err)}</div>, document.getElementById("app")!);
});
