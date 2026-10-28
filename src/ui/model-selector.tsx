// Model selector dialog (plan.md P4) — replaces pi-web-ui ModelSelector.
// Sources models from the cached pi config (window.__PI_PROVIDERS, seeded by
// pi-import.ts). The catalog itself is built SERVER-side (lib/pi-catalog.mjs:
// builtin catalog ∪ models-store.json ∪ .pi/models.json ∪ auth.json), so a provider
// the user added in models.json — or merely logged into — shows up here. Every OPEN
// re-fetches /api/pi/config, so a hand-edited models.json lands without a reload.
import type { Agent } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { fetchAndApplyConfig } from "../pi-import.js";

export interface ModelPick {
	model: Model<any>;
}

export function ModelSelector({
	open,
	current,
	onPick,
	onClose,
}: {
	open: boolean;
	current?: Model<any>;
	onPick: (model: Model<any>) => void;
	onClose: () => void;
}) {
	const [query, setQuery] = useState("");
	// bumped whenever a fresh config lands, so `groups` (memo deps) recomputes
	const [cfgTick, setCfgTick] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (!open) return;
		setQuery("");
		setTimeout(() => inputRef.current?.focus(), 50);
		// the server is the source of truth for the provider list (models.json is
		// hand-edited while the app is running) — never show a stale picker
		let alive = true;
		void (async () => {
			try { if (await fetchAndApplyConfig()) { if (alive) setCfgTick((t) => t + 1); } } catch { /* offline — cache */ }
		})();
		return () => { alive = false; };
	}, [open]);

	// Escape closes (pi-web-ui dialog parity)
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [open, onClose]);

	const groups = useMemo(() => {
		if (!open) return [];
		type Group = { name: string; models: Model<any>[]; origin?: string; keyless?: boolean };
		const providers = (window as any).__PI_PROVIDERS as Group[] | undefined;
		const q = query.trim().toLowerCase();
		const out: Group[] = [];
		for (const p of providers || []) {
			const models = (p.models || []).filter(
				(m) =>
					!q ||
					m.id.toLowerCase().includes(q) ||
					(m.name || "").toLowerCase().includes(q) ||
					p.name.toLowerCase().includes(q),
			);
			if (models.length > 0) out.push({ name: p.name, models, origin: p.origin, keyless: p.keyless });
		}
		return out;
	}, [open, query, cfgTick]);

	if (!open) return null;
	return (
		<div class="pw-overlay" onClick={onClose}>
			<div class="pw-dialog pw-model-dialog" onClick={(e) => e.stopPropagation()}>
				<div class="pw-dialog-head">
					<span>Choose model</span>
					<button class="pw-dialog-close" onClick={onClose} title="Close">
						✕
					</button>
				</div>
				<input
					ref={inputRef}
					class="pi-input pw-dialog-search"
					type="text"
					placeholder="Filter models…"
					value={query}
					onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
				/>
				<div class="pw-dialog-body">
					{groups.length === 0 && <div class="pw-empty">No models. Use the 🗄️ import button, or check the server.</div>}
					{groups.map((g) => (
						<div key={g.name} class="pw-model-group">
							<div class="pw-model-provider">
								{g.name}
								{g.origin === "models.json" ? <span class="pw-model-origin" title="Declared in .pi/models.json (your own endpoint)"> · custom</span> : null}
								{g.keyless ? <span class="pw-model-origin" title="No API key is needed for this endpoint"> · no key</span> : null}
							</div>
							{g.models.map((m) => {
								const isCurrent = current && m.id === current.id && (m.provider === current.provider || g.name === current.provider);
								return (
									<button
										key={(m.provider || g.name) + ":" + m.id}
										class={"pw-model-row" + (isCurrent ? " pw-current" : "")}
										onClick={() => {
											onPick(m);
											onClose();
										}}
									>
										<span class="pw-model-id">{m.name || m.id}</span>
										{isCurrent && <span class="pw-model-check">✓</span>}
									</button>
								);
							})}
						</div>
					))}
				</div>
			</div>
		</div>
	);
}
