// Session list dialog (plan.md P4) — replaces pi-web-ui SessionListDialog.
// Merges server metadata (/api/sessions, JSONL mirror) with local
// sessions-metadata (localStorage) — same merge the old header button did.
// Runtime status (fable5 design): sessions with live hub status (running/error)
// PIN to the top with a badge + one-line lastText preview.
import { useEffect, useState } from "preact/hooks";
import { sessionSync, type RuntimeRecord } from "../session-sync.js";

export interface SessionMeta {
	id: string;
	title: string;
	createdAt?: string;
	lastModified: string;
	messageCount?: number;
	preview?: string;
}

export function SessionListDialog({
	open,
	onLoad,
	onDelete,
	onClose,
}: {
	open: boolean;
	onLoad: (id: string) => void;
	onDelete: (id: string) => void;
	onClose: () => void;
}) {
	const [sessions, setSessions] = useState<SessionMeta[]>([]);
	const [loading, setLoading] = useState(false);
	const [runtime, setRuntime] = useState<ReadonlyMap<string, RuntimeRecord>>(sessionSync.runtimeSnapshot());
	// applied OUTSIDE the 5s metadata throttle — status feels live
	useEffect(() => sessionSync.onRuntime(() => setRuntime(new Map(sessionSync.runtimeSnapshot()))), []);

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
		let alive = true;
		setLoading(true);
		(async () => {
			const merged = new Map<string, SessionMeta>();
			// server mirror first
			try {
				const r = await fetch("/api/sessions", { signal: AbortSignal.timeout(8000) });
				if (r.ok) {
					const d: any = await r.json();
					for (const m of d.sessions || []) {
						if (!m?.id) continue;
						merged.set(m.id, {
							id: m.id,
							title: m.title || "",
							createdAt: m.createdAt,
							lastModified: m.lastModified,
							messageCount: m.messageCount,
							preview: m.preview || m.title || "",
						});
					}
				}
			} catch {
				/* offline: local list is still usable */
			}
			// local metadata fills/overrides by lastModified
			try {
				const { getAppStorage } = await import("../storage.js");
				const all = await getAppStorage().sessions.getAllMetadata();
				for (const m of all as SessionMeta[]) {
					if (!m?.id) continue;
					const server = merged.get(m.id);
					if (!server || new Date(m.lastModified) > new Date(server.lastModified)) {
						merged.set(m.id, { ...m, preview: m.preview || m.title || "" });
					}
				}
			} catch {
				/* storage unavailable */
			}
			if (!alive) return;
			const list = [...merged.values()].sort((a, b) =>
				String(b.lastModified).localeCompare(String(a.lastModified)),
			);
			setSessions(list);
			setLoading(false);
		})();
		return () => {
			alive = false;
		};
	}, [open]);

	if (!open) return null;

	// live sessions (running/error) pin to the top — discovery (fable5)
	const ordered = [...sessions].sort((a, b) => {
		const rank = (m: SessionMeta) => { const rt = runtime.get(m.id); return rt?.status === "running" ? 2 : rt?.status === "error" ? 1 : 0; };
		return (rank(b) - rank(a)) || String(b.lastModified).localeCompare(String(a.lastModified));
	});
	return (
		<div class="pw-overlay" onClick={onClose}>
			<div class="pw-dialog pw-sessions-dialog" onClick={(e) => e.stopPropagation()}>
				<div class="pw-dialog-head">
					<span>Sessions</span>
					<button class="pw-dialog-close" onClick={onClose} title="Close">
						✕
					</button>
				</div>
				<div class="pw-dialog-body">
					{loading && <div class="pw-empty">Loading…</div>}
					{!loading && sessions.length === 0 && <div class="pw-empty">No sessions yet.</div>}
					{ordered.map((s) => {
						const rt = runtime.get(s.id);
						const bits: string[] = [];
						if (rt?.status === "running") bits.push("running");
						if (rt?.status === "error") bits.push("error");
						if (rt?.turn) bits.push(`turn ${rt.turn}`);
						if (rt?.currentTool) bits.push(rt.currentTool);
						if (rt?.pendingPrompts) bits.push(`+${rt.pendingPrompts} queued`);
						return (
						<div
							key={s.id}
							class="pw-session-row"
							onClick={() => {
								onLoad(s.id);
								onClose();
							}}
						>
							<div class="pw-session-main">
								<div class="pw-session-title">{s.title || s.preview || "(untitled)"}</div>
								{bits.length > 0 && (
									<div class={"pw-sess-runtime" + (rt?.status === "error" ? " pw-sess-runtime-error" : "")}>● {bits.join(" · ")}</div>
								)}
								{rt?.lastText && <div class="pw-sess-lasttext">{rt.lastText}</div>}
								<div class="pw-session-sub">
									{s.messageCount ? `${s.messageCount} messages · ` : ""}
									{fmtDate(s.lastModified)}
								</div>
							</div>
							<button
								class="pw-session-delete"
								title="Delete session"
								onClick={(e) => {
									e.stopPropagation();
									if (confirm(`Delete "${s.title || s.id}"? This also removes the server mirror.`)) {
										onDelete(s.id);
										setSessions((prev) => prev.filter((x) => x.id !== s.id));
									}
								}}
							>
								✕
								</button>
								</div>
								);
								})}
								</div>
			</div>
		</div>
	);
}

function fmtDate(iso: string): string {
	try {
		const d = new Date(iso);
		return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
	} catch {
		return "";
	}
}
