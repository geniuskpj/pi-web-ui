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
import { getProxyUrlSync } from "./proxy-stream.js";
import { retryServerAuth } from "../server-auth.js"; // re-probe after a token change (clears the banner)
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
	const [autoRetry, setAutoRetry] = useState(() => {
		try { return localStorage.getItem("pi.autoRetry") !== "0"; } catch { return true; }
	});
	const [keys, setKeys] = useState<string[]>([]);
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
		const entered = window.prompt(`API key for "${provider}" (saved on the server for server-side chat and in this browser for local mode):`);
		if (!entered?.trim()) return;
		const key = entered.trim();
		try {
			await getAppStorage().providerKeys.set(provider, key);
		} catch (err) {
			flash(`Browser key save failed: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}
		setKeys(await getAppStorage().providerKeys.list());
		try {
			const response = await fetch("/api/pi/key", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ provider, key }),
			});
			if (!response.ok) {
				const body = await response.json().catch((): { error?: string } => ({}));
				flash(`Saved in this browser, but server save failed: ${body.error || response.statusText}`);
				return;
			}
			flash(`Key for "${provider}" saved for server and local chat`);
		} catch (err) {
			flash(`Saved in this browser, but server save failed: ${err instanceof Error ? err.message : String(err)}`);
		}
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
									void (agent as any)?.setAutoRetry?.({ enabled: on });
									flash(on ? "Auto-retry on (3× · 3s)" : "Auto-retry off");
								}}
							/>
							<span>Auto-retry on rate limit / network errors — 3 attempts, 3 s apart</span>
						</label>
						<div class="pw-hint">
							A retry drops the 429/error message and continues the same transcript at the failure point: the user
							turn stays exactly once and tool calls that already finished are not re-run. Parked ✎-edit versions
							survive a retry.
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
