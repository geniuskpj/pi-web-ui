// diag-panel.tsx — FAB + bottom drawer: the mobile-first diagnostics surface.
import { useEffect, useState } from "preact/hooks";
import { buildDiagnosticsReport, buildId as getBuildId, diag, type LogEntry } from "./diag.js";
import { copyText } from "./id.js";

export function DiagPanel() {
	const [open, setOpen] = useState(false);
	const [entries, setEntries] = useState<LogEntry[]>([]);
	const [filter, setFilter] = useState<"all" | "warn" | "error">("all");
	const [copied, setCopied] = useState(false);
	const [bid, setBid] = useState("?");
	const [serverState, setServerState] = useState<string>("?");

	const errCount = entries.filter((e) => e.level === "error").length;
	const warnCount = entries.filter((e) => e.level === "warn").length;

	useEffect(() => {
		const unsub = diag.subscribe((e) => {
			if (e.level === "warn" || e.level === "error") setEntries(diag.snapshot(200));
		});
		setEntries(diag.snapshot(200));
		setBid(getBuildId());
		const t = setInterval(() => setEntries(diag.snapshot(200)), 3000);
		return () => { unsub(); clearInterval(t); };
	}, []);

	const refreshServer = async () => {
		try {
			const r = await fetch("/api/debug/state");
			if (r.ok) setServerState(JSON.stringify(await r.json()).slice(0, 300));
		} catch { setServerState("server offline"); }
	};

	const copy = async () => {
		try {
			const report = await buildDiagnosticsReport();
			// copyText: navigator.clipboard is secure-context-only (undefined on http://LAN-IP)
			const ok = await copyText(report);
			if (!ok) throw new Error("copy failed");
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		} catch {
			const w = window.open("", "_blank");
			const report = await buildDiagnosticsReport();
			w?.document.write(`<pre>${report.replace(/</g, "<")}</pre>`);
		}
	};

	const shown = entries.filter((e) => filter === "all" || e.level === filter || (filter === "warn" && e.level === "error")).slice(-100).reverse();
	const dotColor = errCount > 0 ? "#e5484d" : warnCount > 0 ? "#f5a623" : "#46a758";

	return (
		<>
			<button class="diag-fab" style={{ background: dotColor }} title="Diagnostics"
				onClick={() => { setOpen(!open); refreshServer(); }}>
				{errCount > 0 ? errCount : "•"}
			</button>
			{open && (
				<div class="diag-drawer">
					<div class="diag-head">
						<b>Diagnostics</b>
						<span class="diag-build">{bid}</span>
						<button class="diag-close" onClick={() => setOpen(false)}>✕</button>
					</div>
					<button class="diag-copy" onClick={copy}>{copied ? "✓ Copied" : "Copy Diagnostics"}</button>
					<div class="diag-server"><b>server:</b> {serverState}</div>
					<div class="diag-filters">
						{(["all", "warn", "error"] as const).map((f) => (
							<button key={f} class={filter === f ? "on" : ""} onClick={() => setFilter(f)}>{f}</button>
						))}
					</div>
					<div class="diag-log">
						{shown.map((e) => (
							<div class={`diag-entry ${e.level}`} key={e.seq}>
								<span class="lv">{e.level[0]}</span>
								<span class="src">{e.source}</span>
								<span class="msg">{e.msg}</span>
								{e.data && <span class="data">{JSON.stringify(e.data).slice(0, 120)}</span>}
							</div>
						))}
						{shown.length === 0 && <div class="diag-entry">(no entries at this level)</div>}
					</div>
				</div>
			)}
		</>
	);
}
