import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Agent, type AgentMessage, type AgentState } from "@earendil-works/pi-agent-core";
import { getModel, type TextContent } from "@earendil-works/pi-ai";
import { customConvertToLlm } from "./llm.js";
import { makeId } from "./id.js";
import { SessionListDialog } from "./ui/session-list.js";
import { SettingsDialog } from "./ui/settings.js";
import { ModelSelector } from "./ui/model-selector.js";
import { AppStorage, CustomProvidersStore, ProviderKeysStore, SessionsStore, SettingsStore, setAppStorage } from "./storage.js";
import { ChatView } from "./ui/chat.js";
import { createApiKeyResolver, createProxyStreamFn } from "./ui/proxy-stream.js";
import { defaultModelFromCache, fetchAndApplyConfig, loadCachedConfig, type PiConfig } from "./pi-import.js";
import { sessionSync } from "./session-sync.js";
import { LocalStorageBackend } from "./local-storage-backend.js";
import { fetchPiServerTools } from "./pi-tools.js";
import { termBus } from "./ui/terminal.js";
import { DiagPanel } from "./diag-panel.js";
import { dlog } from "./diag.js";

// ============================================================================
// CONSTANTS + GLOBAL STATE
// ============================================================================
const DB_NAME = "pi-web-ui-app-v3";
let agent: Agent;
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
		sessionSync.push(currentSessionId);
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
// AGENT CREATION
// ============================================================================
// effective system prompt for the WEB agent only: .pi/WEB_SYSTEM.md (a filename
// pi's TUI never reads) replaces the chat default, APPEND_SYSTEM.md appends —
// resolved by /api/pi/system, cached at boot
let piSystemPrompt: string | undefined;
let piServerTools: any[] = [];
const resolvePiSystemPrompt = async (): Promise<string | undefined> => {
	try {
		const r = await fetch("/api/pi/system", { signal: AbortSignal.timeout(8000) });
		if (!r.ok) return undefined;
		const j: any = await r.json();
		// base precedence (server-computed wins flags): WEB_SYSTEM.md (web-UI-only,
		// TUI-invisible filename) > SYSTEM.md. APPEND_SYSTEM.md appends after.
		const base = j.files?.find((f: any) => f.wins && f.name === "WEB_SYSTEM.md") || j.files?.find((f: any) => f.wins && f.name === "SYSTEM.md");
		const append = j.files?.find((f: any) => f.wins && f.name === "APPEND_SYSTEM.md");
		const parts = [base?.content ?? "You are a helpful AI assistant.", append?.content].filter(Boolean);
		return parts.length > 0 ? parts.join("\n\n") : undefined; // neither file → chat default stays
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
	const localWin = !server || (!!local && local.messages.length >= server.messages.length);
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
	return true;
};

const loadSessionById = async (sessionId: string) => {
	if (!(await loadSession(sessionId))) newSession();
};
const deleteSessionById = (deletedSessionId: string) => {
	deletedSessionIds.add(deletedSessionId);
	if (saveTimer) {
		clearTimeout(saveTimer);
		saveTimer = undefined;
	}
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
	const [sessionsOpen, setSessionsOpen] = useState(false);
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
	<button class="pi-btn pi-theme" title={`Theme: ${themeMode} (click to cycle)`} onClick={cycleTheme}>
						<span style={{ fontSize: 11, fontWeight: 600 }}>{themeMode === "system" ? "Auto" : themeMode === "light" ? "Light" : "Dark"}</span>
					</button>
					<button class="pi-btn" title="Settings" onClick={() => setSettingsOpen(true)}>
						<Icon d={ICONS.settings} />
					</button>
				</div>
			</header>
			{agent ? <ChatView agent={agent} /> : <div class="pw-chat" />}
			{toast && <div class="pi-toast">{toast}</div>}
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

	// server auth: auto-generated token gates every /api/* + /ws/* call from
	// non-loopback peers. Attach the stored token to all same-origin API calls;
	// on 401, ask once and retry. Header (not cookie) by design — CSRF-proof.
	const origFetch = window.fetch.bind(window);
	window.fetch = async (input: any, init?: any) => {
		const url = typeof input === "string" ? input : (input?.url || "");
		const sameApi = url.includes("/api/") || url.includes("/ws/");
		const tok = localStorage.getItem("pi.webToken");
		if (sameApi && tok) {
			const headers = new Headers(init?.headers || (typeof input !== "string" && input ? input.headers : undefined));
			if (!headers.has("x-pi-web-token")) headers.set("x-pi-web-token", tok);
			return origFetch(input, { ...init, headers });
		}
		let res = await origFetch(input, init);
		if (res.status === 401 && sameApi) {
			const t = window.prompt("Server requires the pi-web API token.\nRead it from data/auth-token.txt on the server machine:");
			if (t) {
				localStorage.setItem("pi.webToken", t.trim());
				const headers = new Headers(init?.headers || (typeof input !== "string" && input ? input.headers : undefined));
				headers.set("x-pi-web-token", t.trim());
				res = await origFetch(input, { ...init, headers });
			}
		}
		return res;
	};
	// WebSocket: append ?token= for /ws/* (WS can't set custom headers)
	const RealWS = window.WebSocket;
	window.WebSocket = class extends RealWS {
		constructor(url: string | URL, protocols?: string | string[]) {
			try {
				const u = new URL(String(url));
				const tok = localStorage.getItem("pi.webToken");
				if (u.pathname.startsWith("/ws/") && tok && !u.searchParams.has("token")) u.searchParams.set("token", tok);
				super(u, protocols as any);
			} catch { super(url as any, protocols as any); }
		}
	};

	// resolve local pi's SYSTEM.md / APPEND_SYSTEM.md (bugs: the web agent must
	// SHARE the local pi's system prompt, not just display it) — resolved once
	// before any createAgent() call (boot, ?session= restore, dialog click)
	piSystemPrompt = await resolvePiSystemPrompt();
	(window as any).__piSystemPrompt = piSystemPrompt; // debuggable from the console
	piServerTools = await fetchPiServerTools(); // pi extensions + workspace tools (sync for toolsFactory)
	(window as any).__piServerTools = piServerTools.map((t) => t.name);

	// proxy defaults in SYNCHRONOUS localStorage
	if (location.protocol.startsWith("http")) {
		localStorage.setItem("pi.proxyEnabled", localStorage.getItem("pi.proxyEnabled") ?? "1");
		localStorage.setItem("pi.proxyUrl", localStorage.getItem("pi.proxyUrl") || `${location.origin}/api/proxy`);
	}

	// background enrichment — never blocks first paint
	void (async () => {
		fetch("/api/health").then((r) => setServerStatus(r.ok)).catch(() => setServerStatus(false));

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
		if (sessionId) {
			const ok = (await withTimeout(loadSession(sessionId), 15000, "session load")) === true;
			dlog.debug("[init]", since(), "background session load:", ok);
			if (!ok) setToastBg("Could not load that session (server or storage unavailable).");
		}
	})();

	await createAgent();
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
