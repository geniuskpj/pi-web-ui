// Model selector dialog (plan.md P4) — replaces pi-web-ui ModelSelector.
// Sources models ONLY from the cached pi config (window.__PI_PROVIDERS,
// seeded by pi-import.ts) — no built-in catalog (nvidia/custom-only build).
import type { Agent } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";

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
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (!open) return;
		setQuery("");
		setTimeout(() => inputRef.current?.focus(), 50);
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
		const providers = (window as any).__PI_PROVIDERS as Array<{ name: string; models: Model<any>[] }> | undefined;
		const q = query.trim().toLowerCase();
		const out: Array<{ name: string; models: Model<any>[] }> = [];
		for (const p of providers || []) {
			const models = (p.models || []).filter(
				(m) =>
					!q ||
					m.id.toLowerCase().includes(q) ||
					(m.name || "").toLowerCase().includes(q) ||
					p.name.toLowerCase().includes(q),
			);
			if (models.length > 0) out.push({ name: p.name, models });
		}
		return out;
	}, [open, query]);

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
							<div class="pw-model-provider">{g.name}</div>
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
