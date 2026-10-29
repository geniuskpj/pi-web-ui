// Settings dialog (plan.md P4) — replaces SettingsDialog + ProvidersModelsTab + ProxyTab.
// Sections: model, thinking level, provider keys, proxy, server token, storage.
// MUST write the same localStorage keys the runtime reads (grok P2 review):
//   pi.proxyEnabled / pi.proxyUrl  ← getProxyUrlSync() in proxy-stream.ts
//   pi.key.<provider>              ← via providerKeys.set (mirrors fast tier)
//   pi.lastModel / pi.lastThinkingLevel
//   pi.webToken                    ← server auth header
import type { Agent } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { useEffect, useState } from "preact/hooks";
import { getAppStorage } from "../storage.js";
import { enterSendsPref, turnsVisiblePref, setTurnsVisible, TURNS_VISIBLE_DEFAULT } from "./chat.js";
import { getProxyUrlSync } from "./proxy-stream.js";
import { retryServerAuth } from "../server-auth.js"; // re-probe after a token change (clears the banner)
// theme (user request 2026-10-28: "Move theme selector in settings"): the header cycle
// button is gone — the pref lives in src/ui/theme.ts (localStorage `theme` + `.dark`)
import { readTheme, setTheme, themeLabel, THEMES, type ThemeMode } from "./theme.js";
// data-reduction LEVELS (images · reasoning/answer/tool streaming). All decisions live in the
// tested pure layer; this file only persists them and prints the resolved parameters.
import {
    readDataSettings, readNetTier, setImageLevel, setThinkingLevel, pushDataReduction,
    readImageRetention, setImageRetention, DEFAULT_IMAGE_RETENTION,
    resolvedImagePolicy, resolvedStreamPolicy, describeImagePolicy, describeStreamPolicy,
    imageLevelOptions, thinkingLevelOptions,
} from "./data-settings.js";
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export function SettingsDialog({
	open,
	agent,
	onModelPick,
	onImportPi,
	onClose,
}: {
	open: boolean;
	agent?: Agent;
	onModelPick: () => void;
	onImportPi?: () => void;
	onClose: () => void;
}) {
	const [proxyEnabled, setProxyEnabled] = useState(getProxyUrlSync() !== undefined);
	const [proxyUrl, setProxyUrl] = useState("");
	const [token, setToken] = useState("");
	// auto-retry on 429/network errors (default ON) — mirrors localStorage `pi.autoRetry`
	// (+ attempts/delayMs, auto-retry UI 2026-10-24: the old UI could only toggle on/off
	// with "3× · 3s" hardcoded in the label — now the real config is editable)
	const [autoRetry, setAutoRetry] = useState(() => {
		try { return localStorage.getItem("pi.autoRetry") !== "0"; } catch { return true; }
	});
	const [retryAttempts, setRetryAttempts] = useState(() => {
		try { return Math.max(0, Math.min(10, Number(localStorage.getItem("pi.autoRetryAttempts")) || 3)); } catch { return 3; }
	});
	const [retryDelayMs, setRetryDelayMs] = useState(() => {
		try { return Math.max(1000, Math.min(60000, Number(localStorage.getItem("pi.autoRetryDelayMs")) || 3000)); } catch { return 3000; }
	});
	// data-reduction levels (pi.imageLevel / pi.thinkingLevel). The RESOLVED policies are computed on
	// every render from localStorage, so the parameters shown always match what will be applied.
	const [imageLevel, setImageLevelState] = useState<string>(() => readDataSettings().imageLevel || "auto");
	const [thinkingLevel, setThinkingLevelState] = useState<string>(() => readDataSettings().thinkingLevel || "auto");
	const [net, setNet] = useState<string>(() => readNetTier());
	const [retention, setRetention] = useState<string>(() => readImageRetention());
	const imagePolicy = resolvedImagePolicy(net);
	const streamPolicies = { thinking: resolvedStreamPolicy("thinking", net), text: resolvedStreamPolicy("text", net), tool: resolvedStreamPolicy("tool", net) };
	const [keys, setKeys] = useState<string[]>([]);
	// Enter-key behavior (mobile multi-line, sonnet-5 design): tri-state pref read
	// from the same localStorage key the Editor consumes (pi.enterSends)
	const [enterPref, setEnterPref] = useState<string>(() => enterSendsPref());
	// turns visible in a large (tail-first) session — pi.turnWindow, default 3
	const [turnWindow, setTurnWindow] = useState<number>(() => turnsVisiblePref());
	const [theme, setThemeState] = useState<ThemeMode>(() => readTheme());
	const [quota, setQuota] = useState<{ usage: number; percent: number } | null>(null);
	const [saved, setSaved] = useState("");
	// thinking level is read from agent.state at render (no stale local snapshot —
	// grok p5: toolbar/settings drift) — changes broadcast via pi-agent-state-changed
	const thinking = String(agent?.state.thinkingLevel ?? "high");
	// config providers without a key yet — offer server import (was ProvidersModelsTab)
	const [importable, setImportable] = useState<string[]>([]);

	// Escape closes (pi-web-ui dialog parity)
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [open, onClose]);

	useEffect(() => {
		if (!open) return;
		setProxyEnabled(getProxyUrlSync() !== undefined);
		try {
			setProxyUrl(localStorage.getItem("pi.proxyUrl") || (location.origin + "/api/proxy"));
			setToken(localStorage.getItem("pi.webToken") || "");
		} catch {
			/* noop */
		}
		(async () => {
			try {
				setKeys(await getAppStorage().providerKeys.list());
				setQuota(await getAppStorage().getQuotaInfo());
			} catch {
				/* noop */
			}
		})();
	}, [open, agent]);

	// the link tier decides what "auto" means (lan/wired → high, wifi/wan → medium, metered → low).
	// Read it from the server once per open, and keep it in localStorage for the composer.
	useEffect(() => {
		if (!open) return;
		let alive = true;
		void (async () => {
			try {
				const r = await fetch("/api/health", { signal: AbortSignal.timeout(3000) });
				const j = await r.json();
				if (alive && j?.netClass) { setNet(String(j.netClass)); try { localStorage.setItem("pi.netTier", String(j.netClass)); } catch { /* quota */ } }
			} catch { /* offline: keep the conservative default */ }
		})();
		return () => { alive = false; };
	}, [open]);

	if (!open) return null;

	const flash = (msg: string) => {
		setSaved(msg);
		setTimeout(() => setSaved(""), 2500);
	};

	const setProxy = (enabled: boolean) => {
		setProxyEnabled(enabled);
		try {
			localStorage.setItem("pi.proxyEnabled", enabled ? "1" : "0");
			localStorage.setItem("pi.proxyUrl", proxyUrl);
		} catch {
			/* quota */
		}
		flash(enabled ? "Proxy on" : "Proxy off (direct calls)");
	};

	const importKey = async (provider: string) => {
		try {
			const r = await fetch("/api/pi/key", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ provider }),
			});
			if (!r.ok) return flash(`No key for "${provider}" on the server`);
			const d = await r.json();
			if (!d.key) return flash(`No key for "${provider}" on the server`);
			await getAppStorage().providerKeys.set(provider, d.key); // mirrors pi.key.* fast tier
			setKeys(await getAppStorage().providerKeys.list());
			flash(`Key for "${provider}" imported`);
		} catch {
			flash("Import failed (server offline?)");
		}
	};

	const setKeyManual = async (provider: string) => {
		const entered = window.prompt(`API key for "${provider}" (stored locally in your browser):`);
		if (!entered?.trim()) return;
		await getAppStorage().providerKeys.set(provider, entered.trim());
		setKeys(await getAppStorage().providerKeys.list());
		flash(`Key for "${provider}" saved`);
	};

	const model = agent?.state.model;

	return (
		<div class="pw-overlay" onClick={onClose}>
			<div class="pw-dialog pw-settings-dialog" onClick={(e) => e.stopPropagation()}>
				<div class="pw-dialog-head">
					<span>Settings</span>
					<button class="pw-dialog-close" onClick={onClose} title="Close">
						✕
					</button>
				</div>
				<div class="pw-dialog-body">
					{saved && <div class="pw-saved">{saved}</div>}

					<section class="pw-set-section">
						<h3>Model</h3>
						<button class="pw-set-model" onClick={onModelPick} title="Change model">
							<span class="pw-model-id">{model ? model.name || model.id : "(none)"}</span>
							<span class="pw-model-provider">{model?.provider || ""}</span>
							<span class="pw-model-edit">change</span>
						</button>
						{onImportPi && (
							<div class="pw-set-row">
								<button
									type="button"
									class="pw-mini-btn"
									title="Re-import providers/models/defaults + key from the local pi config (.pi)"
									onClick={() => {
										onImportPi();
										flash("Importing pi config…");
									}}
								>
									Import from pi config
								</button>
								<span class="pw-model-provider">providers · defaults · key</span>
							</div>
						)}
						<label class="pw-set-row">
							<span>Thinking level</span>
							<select
								class="pi-input pw-set-select"
								value={thinking}
								onChange={(e) => {
									const v = (e.target as HTMLSelectElement).value;
									if (agent) {
										agent.state.thinkingLevel = v as any;
										(agent as any).setThinkingLevel?.(v); // server-side agent: propagate to the hub
									}
									localStorage.setItem("pi.lastThinkingLevel", v);
									window.dispatchEvent(new CustomEvent("pi-agent-state-changed")); // sync toolbar
									flash(`Thinking: ${v}`);
								}}
							>
								{THINKING_LEVELS.map((l) => (
									<option key={l} value={l}>
										{l}
									</option>
								))}
							</select>
						</label>
					</section>

					<section class="pw-set-section">
						<h3>Appearance</h3>
						<label class="pw-set-row" title="System follows the operating system's light/dark preference.">
							<span>Theme</span>
							<select
								class="pi-input pw-set-input"
								value={theme}
								onChange={(e) => {
									const v = setTheme((e.target as HTMLSelectElement).value as ThemeMode);
									setThemeState(v);
									flash(`Theme: ${themeLabel(v)}`);
								}}
							>
								{THEMES.map((m) => (
									<option key={m} value={m}>{themeLabel(m)}</option>
								))}
							</select>
						</label>
						<div class="pw-hint">Saved as <code>theme</code> in this browser (same key as before — an existing choice is kept).</div>
					</section>

					<section class="pw-set-section">
						<h3>API keys</h3>
						<div class="pw-keys-list">
							{keys.map((k) => (
								<div key={k} class="pw-key-row">
									<span class="pw-key-name">{k}</span>
									<span class="pw-key-has">✓ set</span>
									<button class="pw-mini-btn" onClick={() => setKeyManual(k)}>
										replace
									</button>
								</div>
							))}
							{importable.map((p) => (
								<div key={p} class="pw-key-row">
									<span class="pw-key-name">{p}</span>
									<span class="pw-key-missing">no key</span>
									<button class="pw-mini-btn" onClick={() => void importKey(p)} title="Import from the server's .pi/auth.json">
										import
									</button>
									<button class="pw-mini-btn" onClick={() => void setKeyManual(p)}>
										add
									</button>
								</div>
							))}
							{keys.length === 0 && importable.length === 0 && <div class="pw-empty">No keys yet — import from the server or add one.</div>}
						</div>
						<div class="pw-key-row">
							<input
								class="pi-input pw-key-input"
								placeholder="provider name (e.g. nvidia)"
								id="pw-key-provider"
							/>
							<button
								class="pw-mini-btn"
								onClick={() => {
									const p = (document.getElementById("pw-key-provider") as HTMLInputElement)?.value.trim();
									if (p) void setKeyManual(p);
								}}
							>
								add key
							</button>
						</div>
					</section>

					<section class="pw-set-section">
						<h3>Data use</h3>
						<label class="pw-set-row" title="Two thresholds are applied to every image: a resolution cap AND a byte cap. The aspect ratio is always preserved.">
							<span>Images</span>
							<select
								class="pi-input pw-set-input"
								value={imageLevel}
								onChange={(e) => {
									const v = (e.target as HTMLSelectElement).value;
									setImageLevelState(setImageLevel(v));
									pushDataReduction(agent);
									flash(v === "none" ? "Images: original (nothing is resized)" : `Images: ${v}`);
								}}
							>
								{imageLevelOptions({ net }).map((o) => (
									<option value={o.value} key={o.value}>{`${o.label} — ${o.params}`}</option>
								))}
							</select>
						</label>
						<div class="pw-set-subrow" style="margin-left:0">
							<span class="pw-hint">Selected: <b>{imageLevel === "auto" ? `auto → ${imagePolicy.level}` : imageLevel}</b> · {describeImagePolicy(imagePolicy)}</span>
						</div>
						<label class="pw-set-row" title="One policy covers the reasoning, the assistant's answer and tool output — each stream keeps its own thresholds.">
							<span>Reasoning &amp; stream</span>
							<select
								class="pi-input pw-set-input"
								value={thinkingLevel}
								onChange={(e) => {
									const v = (e.target as HTMLSelectElement).value;
									setThinkingLevelState(setThinkingLevel(v));
									pushDataReduction(agent);
									flash(`Streaming: ${v}`);
								}}
							>
								{thinkingLevelOptions().map((o) => (
									<option value={o.value} key={o.value}>{`${o.label} — ${o.params}`}</option>
								))}
							</select>
						</label>
						<div class="pw-set-subrow" style="margin-left:0;flex-direction:column;gap:2px">
							<span class="pw-hint"><b>Reasoning</b> — {describeStreamPolicy(streamPolicies.thinking, "thinking")}</span>
							<span class="pw-hint"><b>Answer</b> — {describeStreamPolicy(streamPolicies.text, "text")}</span>
							<span class="pw-hint"><b>Tool output</b> — {describeStreamPolicy(streamPolicies.tool, "tool")}</span>
						</div>
						<label class="pw-set-row" title="Where a session image is kept after you send it. Server (default): the encoded bytes live in the server's media store, so any device can render them and the model can be re-run on them. Browser: the bytes stay on this device (the server keeps them only while it runs) — smaller footprint on the machine running pi, and the browser re-uploads when it must.">
							<span>Image storage</span>
							<select
								class="pi-input pw-set-input"
								value={retention}
								onChange={(e) => {
									const v = setImageRetention((e.target as HTMLSelectElement).value);
									setRetention(v);
									pushDataReduction(agent);
									flash(v === "server" ? "Images are kept on the server" : "Images are kept in this browser");
								}}
							>
								<option value="server">Server — any device can view them{retention === DEFAULT_IMAGE_RETENTION ? " (default)" : ""}</option>
								<option value="browser">Browser — keep the bytes on this device</option>
							</select>
						</label>
						<div class="pw-set-subrow" style="margin-left:0">
							<span class="pw-hint">Selected: <b>{retention}</b> · {
								retention === "server"
									? "the encoded image is stored on disk (data/media) and served back by content hash; base64 is built only for the model request"
									: "the encoded image stays in this browser; the server holds it in memory only and forgets it on restart"
							}</span>
						</div>
						<div class="pw-hint">
							Images are encoded once in this browser (resize + WebP) and kept as <b>binary</b> — never the raw
							original, never base64: base64 is produced only when the model request is built. gz/br on an
							encoded image saves ~0% (measured), so nothing is double-compressed. Frames below the socket's
							deflate threshold do travel uncompressed, so larger stream chunks are also the cheaper ones;
							sending the original and streaming every delta stay one click away (<b>None</b>).
						</div>
					</section>

					<section class="pw-set-section">
						<h3>Composer</h3>
						<label class="pw-set-row">
							<span>Enter key</span>
							<select
								class="pi-input pw-set-input"
								value={enterPref}
								onChange={(e) => {
									const v = (e.target as HTMLSelectElement).value;
									setEnterPref(v as any);
									try { localStorage.setItem("pi.enterSends", v); } catch { /* quota */ }
									flash(v === "always" ? "Enter sends — Shift+Enter for newline" : v === "never" ? "Enter makes a newline — send with the button" : "Enter: auto (newline on touch, send on desktop)");
								}}
							>
								<option value="auto">Auto — newline on touch, send on desktop</option>
								<option value="always">Always send</option>
								<option value="never">Always newline (send with the button)</option>
							</select>
						</label>
						<label class="pw-set-row" title="How many conversational turns a LARGE (tail-first) session shows at once. Older turns stay one click away on the ⤒ Load earlier turns button at the top. Small sessions always render in full — this never changes what is stored or what the model reads.">
							<span>Turns visible</span>
							<select
								class="pi-input pw-set-input"
								value={String(turnWindow)}
								onChange={(e) => {
									const v = setTurnsVisible(Number((e.target as HTMLSelectElement).value));
									setTurnWindow(v);
									flash(v === 1 ? "Showing the last turn — older ones via ⤒" : `Showing the last ${v} turns`);
								}}
							>
								{Array.from({ length: 20 }, (_, i) => i + 1).map((n) => (
									<option value={String(n)} key={n}>{`${n}${n === TURNS_VISIBLE_DEFAULT ? " (default)" : ""}`}</option>
								))}
							</select>
						</label>
						<div class="pw-hint">Long-press one of YOUR messages to edit it on touch screens. Ctrl/Cmd+Enter always sends, in every mode.</div>
						<div class="pw-hint">Large sessions open on the last <b>{turnWindow}</b> turn{turnWindow === 1 ? "" : "s"}; ⤒ Load earlier turns reveals one more turn per click (from memory when it is loaded, from the server when it is not). Small sessions are never gated.</div>
					</section>

					<section class="pw-set-section">
						<h3>CORS proxy</h3>
						<label class="pw-set-row">
							<input
								type="checkbox"
								checked={proxyEnabled}
								onChange={(e) => setProxy((e.target as HTMLInputElement).checked)}
							/>
							<span>Route LLM calls through the server proxy (default on)</span>
						</label>
						<input
							class="pi-input pw-set-input"
							type="text"
							value={proxyUrl}
							placeholder="http://localhost:8787/api/proxy"
							onInput={(e) => setProxyUrl((e.target as HTMLInputElement).value)}
							onBlur={() => setProxy(proxyEnabled)}
						/>
						<div class="pw-hint">Providers without CORS headers (nvidia, custom endpoints) need this.</div>
					</section>

					<section class="pw-set-section">
						<h3>Retry</h3>
						<label class="pw-set-row" title="Applies to rate-limit (429), network and transient 5xx errors. A retry removes the error message and continues the SAME turn — the user message is not re-sent.">
							<input
								type="checkbox"
								checked={autoRetry}
								onChange={(e) => {
									const on = (e.target as HTMLInputElement).checked;
									setAutoRetry(on);
									try { localStorage.setItem("pi.autoRetry", on ? "1" : "0"); } catch { /* quota */ }
									void (agent as any)?.setAutoRetry?.({ enabled: on, attempts: retryAttempts, delayMs: retryDelayMs });
									flash(on ? `Auto-retry on (${retryAttempts}× · ${Math.round(retryDelayMs / 1000)}s)` : "Auto-retry off");
								}}
							/>
							<span>Auto-retry on rate limit / network errors</span>
						</label>
						<div class="pw-set-subrow" aria-disabled={!autoRetry ? "true" : undefined}>
							<label class="pw-set-inline">
								<span>Attempts</span>
								<input
									type="number" min={0} max={10} step={1} disabled={!autoRetry}
									value={retryAttempts}
									onChange={(e) => {
										const v = Math.max(0, Math.min(10, Math.floor(Number(e.currentTarget.value)) || 0));
										setRetryAttempts(v);
										try { localStorage.setItem("pi.autoRetryAttempts", String(v)); } catch { /* quota */ }
										void (agent as any)?.setAutoRetry?.({ enabled: autoRetry, attempts: v, delayMs: retryDelayMs });
									}}
								/>
							</label>
							<label class="pw-set-inline">
								<span>Delay (s)</span>
								<input
									type="number" min={1} max={60} step={1} disabled={!autoRetry}
									value={Math.round(retryDelayMs / 1000)}
									onChange={(e) => {
										const v = Math.max(1, Math.min(60, Math.floor(Number(e.currentTarget.value)) || 1)) * 1000;
										setRetryDelayMs(v);
										try { localStorage.setItem("pi.autoRetryDelayMs", String(v)); } catch { /* quota */ }
										void (agent as any)?.setAutoRetry?.({ enabled: autoRetry, attempts: retryAttempts, delayMs: v });
									}}
								/>
							</label>
						</div>
						<div class="pw-hint">
							A retry drops the 429/error message and continues the same transcript at the failure point: the user
							turn stays exactly once and tool calls that already finished are not re-run. While a retry is pending
							the chat shows a countdown — <b>Cancel</b> stops this pending retry (auto-retry stays on for future
							errors), <b>Retry now</b> fires it immediately. Parked ✎-edit versions survive a retry.
						</div>
					</section>

					<section class="pw-set-section">
						<h3>Server token</h3>
						<input
							class="pi-input pw-set-input"
							type="password"
							value={token}
							placeholder="x-pi-web-token (read data/auth-token.txt on the server)"
							onInput={(e) => setToken((e.target as HTMLInputElement).value)}
							onBlur={() => {
								try {
									if (token.trim()) localStorage.setItem("pi.webToken", token.trim());
									else localStorage.removeItem("pi.webToken");
								} catch {
									/* quota */
								}
								flash(token.trim() ? "Token saved" : "Token cleared");
								// a new/cleared token changes authorization — re-probe so the auth banner
								// (main.tsx) reflects reality immediately instead of on the next call
								void retryServerAuth();
							}}
						/>
					</section>

					<section class="pw-set-section">
						<h3>Storage</h3>
						<div class="pw-hint">
							{quota
								? `localStorage: ${(quota.usage / 1024).toFixed(0)} KB (~${quota.percent.toFixed(1)}% of 5 MB) — large sessions are evicted locally, the server mirror keeps them.`
								: "localStorage-based; the server mirror (data/sessions) is the durable copy."}
						</div>
					</section>
				</div>
			</div>
		</div>
	);
}
