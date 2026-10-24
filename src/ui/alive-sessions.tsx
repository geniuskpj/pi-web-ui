// AliveSessionsDialog — live view of sessions with a RUNNING or ERROR agent run
// on the server (2026-10-21 user request). Complements the full session list:
// this one shows ONLY non-idle hub runtime, updates LIVE via the /ws/sync
// runtime map (applied outside the 5s metadata throttle), and offers per-row
// Kill (POST /api/agent/abort) + click-to-navigate.
//
// Design (claude-sonnet-5-high review):
// - badge/dialog split: the header badge counts alive sessions EXCLUDING the
//   current one ("other stuff needs me"); the dialog lists ALL alive incl. the
//   current session.
// - kill: two-stage inline confirm (Kill → "Confirm?" for 3s) → abort →
//   "stopping…" until the runtime frame flips; error rows have NO kill (nothing
//   in-flight) but stay clickable; abort failures are silent (the run may have
//   finished naturally in the same instant — idempotent by design).
// - a row whose run finishes while open lingers 2s as "✓ done", then drops.
// - title fallback: metadata.title → runtime.lastText tail → "Session <id8>".
// - sort: error → running → done, then startedAt desc; stable per render (rows
//   only reorder on status transitions, so Kill targets don't jitter).
import { useEffect, useRef, useState } from "preact/hooks";
import { sessionSync, type RuntimeRecord } from "../session-sync.js";
import { clearSession as clearIdbCache } from "../idb-cache.js";

type RowState = "running" | "error" | "done";

interface Row extends RuntimeRecord {
	state: RowState;
}

interface Meta {
	id: string;
	title: string;
}

const DONE_GRACE_MS = 2000;
const META_REFETCH_MS = 3000;

export function AliveSessionsDialog({
	open,
	currentSessionId,
	onLoad,
	onViewAll,
	onClose,
}: {
	open: boolean;
	currentSessionId?: string;
	onLoad: (id: string) => void;
	onViewAll: () => void;
	onClose: () => void;
}) {
	const [now, setNow] = useState(() => Date.now()); // ticking re-render (elapsed + grace expiry)
	const [metas, setMetas] = useState<ReadonlyMap<string, Meta>>(new Map());
	const [confirming, setConfirming] = useState<string | null>(null); // two-stage kill
	const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set());
	const doneRows = useRef<Map<string, { until: number; record: RuntimeRecord }>>(new Map());
	const prevIds = useRef<Map<string, RuntimeRecord>>(new Map());
	const lastMetaFetch = useRef(0);
	const confirmingTimer = useRef<any>(undefined);

	const fetchMetas = async () => {
		lastMetaFetch.current = Date.now();
		try {
			const r = await fetch("/api/sessions", { signal: AbortSignal.timeout(8000) });
			if (!r.ok) return;
			const j = await r.json();
			const m = new Map<string, Meta>();
			for (const s of j.sessions || []) if (s?.id) m.set(s.id, { id: s.id, title: s.title || s.preview || "" });
			setMetas(m);
		} catch { /* offline — fallback titles render */ }
	};

	// dialog lifecycle: subscribe to runtime (vanish detection + re-render), tick
	// the clock, fetch titles; refresh titles when an unknown sessionId appears.
	useEffect(() => {
		if (!open) return;
		doneRows.current.clear();
		prevIds.current = new Map(sessionSync.runtimeSnapshot());
		void fetchMetas();
		const sync = () => {
			const cur = sessionSync.runtimeSnapshot();
			// a run that finished while open → 2s "✓ done" grace instead of vanishing
			for (const [id, rt] of prevIds.current) {
				if (!cur.has(id) && !doneRows.current.has(id)) {
					doneRows.current.set(id, { until: Date.now() + DONE_GRACE_MS, record: rt });
				}
			}
			for (const [id, d] of doneRows.current) {
				if (cur.has(id)) doneRows.current.delete(id); // re-started — drop the grace entry
				else if (Date.now() > d.until) doneRows.current.delete(id);
			}
			prevIds.current = new Map(cur);
			// lazy metadata for sessions that appeared after open (throttled)
			let unknown = false;
			for (const id of cur.keys()) if (!metas.has(id)) { unknown = true; break; }
			if (unknown && Date.now() - lastMetaFetch.current > META_REFETCH_MS) void fetchMetas();
			setStopping((s) => {
				const next = new Set([...s].filter((id) => cur.get(id)?.status === "running"));
				return next.size === s.size ? s : next;
			});
			setNow(Date.now());
		};
		const off = sessionSync.onRuntime(sync);
		const tick = setInterval(sync, 1000);
		return () => { off(); clearInterval(tick); clearTimeout(confirmingTimer.current); };
	}, [open]);

	// ---- derive rows (every render; pure) ----
	const rows: Row[] = [];
	if (open) {
		for (const [id, rt] of sessionSync.runtimeSnapshot()) {
			if (rt.status !== "running" && rt.status !== "error") continue;
			rows.push({ ...rt, sessionId: id, state: rt.status });
		}
		for (const [id, d] of doneRows.current) {
			if (Date.now() <= d.until) rows.push({ ...d.record, sessionId: id, state: "done" });
		}
		rows.sort((a, b) => {
			const rank = (s: RowState) => (s === "error" ? 0 : s === "running" ? 1 : 2);
			return rank(a.state) - rank(b.state) || (b.startedAt || 0) - (a.startedAt || 0) || a.sessionId.localeCompare(b.sessionId);
		});
	}

	if (!open) return null;

	const title = (r: Row) => {
		const t = metas.get(r.sessionId)?.title?.trim();
		if (t) return t;
		if (r.lastText) return (r.lastText.startsWith("…") ? "" : "… ") + r.lastText;
		return `Session ${r.sessionId.slice(0, 8)}`;
	};
	const elapsed = (r: Row) => {
		if (!r.startedAt) return "";
		const s = Math.max(0, Math.floor((now - r.startedAt) / 1000));
		return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
	};

	const kill = (id: string) => {
		if (confirming !== id) {
			setConfirming(id);
			clearTimeout(confirmingTimer.current);
			confirmingTimer.current = setTimeout(() => setConfirming(null), 3000);
			return;
		}
		clearTimeout(confirmingTimer.current);
		setConfirming(null);
		setStopping(new Set([...stopping, id]));
		// silent by design: a no-op abort (the run just finished) must not toast
		void fetch("/api/agent/abort", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ sessionId: id }),
		}).catch(() => {});
	};

	// IDB CLEAR beside Kill (user request 2026-10-24): wipes the session's IDB
	// body cache + memory tier. SAFE DURING A LIVE RUN — the run streams via WS
	// and persists server-side; the cache is read-only data and an in-flight
	// backfill write is dropped (generation guard). One click, no confirm — a
	// cleared cache self-heals on the next open (worst case: one range refetch).
	const [clearedId, setClearedId] = useState<string | null>(null);
	const clearCache = (id: string) => {
		void clearIdbCache(id).then(() => {
			setClearedId(id);
			setTimeout(() => setClearedId((c) => (c === id ? null : c)), 1500);
		});
	};

	const openSession = (id: string) => {
		if (id === currentSessionId) { onClose(); return; } // already there — don't reload
		onLoad(id);
		onClose();
	};

	return (
		<div class="pw-overlay" onClick={onClose}>
			<div class="pw-dialog pw-sessions-dialog" onClick={(e) => e.stopPropagation()}>
				<div class="pw-dialog-head">
					<span>Active sessions</span>
					<button class="pi-btn" onClick={onClose}>✕</button>
				</div>
				<div class="pw-dialog-body">
					{rows.length === 0 && (
						<div class="pw-empty">
							No active sessions.{" "}
							<button class="pw-alive-link" onClick={() => { onViewAll(); onClose(); }}>View all sessions</button>
						</div>
					)}
					{rows.map((r) => {
						const isStopping = stopping.has(r.sessionId) && r.state === "running";
						const detail: string[] = [];
						if (r.state === "done") detail.push("✓ done");
						if (r.turn) detail.push(`turn ${r.turn}`);
						if (r.currentTool) detail.push(r.currentTool);
						if (r.pendingPrompts) detail.push(`+${r.pendingPrompts} queued`);
						if (r.clients) detail.push(`${r.clients} device${r.clients === 1 ? "" : "s"}`);
						if (r.state === "running" && elapsed(r)) detail.push(elapsed(r));
						return (
							<div
								key={r.sessionId}
								class={"pw-session-row" + (r.sessionId === currentSessionId ? " pw-alive-current" : "")}
								onClick={() => openSession(r.sessionId)}
								title="Open this session"
							>
								<div class="pw-session-main">
									<div class="pw-session-title">
										<span class={"pw-alive-dot " + r.state} />
										{title(r)}
									</div>
									{detail.length > 0 && (
										<div class={"pw-sess-runtime" + (r.state === "error" ? " pw-sess-runtime-error" : "") + (r.state === "done" ? " pw-alive-done" : "")}>
											{detail.join(" · ")}
										</div>
									)}
									{r.state !== "done" && r.lastText && <div class="pw-sess-lasttext">{r.lastText}</div>}
								</div>
								{r.state === "running" && !isStopping && (
									<button
										class={"pw-mini-btn" + (confirming === r.sessionId ? " pw-alive-confirm" : "")}
										title={confirming === r.sessionId ? "Click again to stop the run" : "Stop this run"}
										onClick={(e) => { e.stopPropagation(); kill(r.sessionId); }}
									>
										{confirming === r.sessionId ? "Confirm?" : "Kill"}
									</button>
								)}
								{clearedId === r.sessionId ? <span class="pw-alive-stopping">cache cleared ✓</span> : (
									<button
										class="pw-mini-btn"
										title="Clear this session's IndexedDB body cache — safe during a live run (the cache self-heals on the next open)"
										onClick={(e) => { e.stopPropagation(); clearCache(r.sessionId); }}
									>
										🧹 clear
									</button>
								)}
								{isStopping && <span class="pw-alive-stopping">stopping…</span>}
							</div>
						);
					})}
				</div>
				<div class="pw-alive-foot">
					{sessionSync.syncHealthy() ? "live" : "live updates paused — reconnecting…"}
				</div>
			</div>
		</div>
	);
}
