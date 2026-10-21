// SystemPromptDialog — shows the effective pi system prompt resolved by the server
// (/api/pi/system) exactly like pi's resource-loader does it: trusted project
// .pi/SYSTEM.md wins over agentDir SYSTEM.md (per-name, not combined);
// SYSTEM.md replaces pi's default prompt, APPEND_SYSTEM.md appends to it.
// Render <SystemPromptDialog /> once; open via showSystemPrompt() (window event,
// same pattern as pi-toast).
import { useState, useEffect } from "preact/hooks";

export function showSystemPrompt() {
	window.dispatchEvent(new CustomEvent("pi-system-open"));
}

export function SystemPromptDialog() {
	const [info, setInfo] = useState<any>(null);

	useEffect(() => {
		const open = () => {
			fetch("/api/pi/system", { signal: AbortSignal.timeout(8000) })
				.then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
				.then((j) => setInfo(j))
				.catch(() => window.dispatchEvent(new CustomEvent("pi-toast", { detail: "Could not load system prompt (server offline)." })));
		};
		const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setInfo(null); };
		window.addEventListener("pi-system-open", open);
		window.addEventListener("keydown", onKey);
		return () => { window.removeEventListener("pi-system-open", open); window.removeEventListener("keydown", onKey); };
	}, []);

	if (!info) return null;
	const badge = (text: string, bg: string, fg: string) => (
		<span style={{ background: bg, color: fg, borderRadius: 4, padding: "1px 6px", marginRight: 6, fontSize: 12 }}>{text}</span>
	);
	return (
		<div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }} onClick={() => setInfo(null)}>
			<div style={{ background: "var(--background, #1a1a1a)", color: "var(--foreground, #eee)", borderRadius: 10, maxWidth: 860, width: "100%", maxHeight: "85vh", overflow: "auto", padding: 16, boxShadow: "0 10px 40px rgba(0,0,0,.5)" }} onClick={(e: Event) => e.stopPropagation()}>
				<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
					<strong style={{ fontSize: 15 }}>pi system prompt</strong>
					<button class="pi-btn" title="Close" onClick={() => setInfo(null)}>&#10005;</button>
				</div>
				<div style={{ fontSize: 12, color: "#999", marginBottom: 10, lineHeight: 1.6, wordBreak: "break-all" }}>
					Workspace: <code>{info.projectDir}</code>{" — "}
					{info.needsTrust ? (info.trusted ? "trusted ✓" : "UNTRUSTED — project .pi files ignored") : "no trust-gated .pi resources"}
					<br />
					Effective: <code>{info.effective.base}</code>
					{info.effective.append ? <> + <code>{info.effective.append}</code></> : null}
					{info.effective.base === "pi default" && !info.effective.append ? " (pi built-in prompt, no overrides)" : null}
				</div>
				{info.files.filter((f: any) => f.exists).map((f: any) => (
					<div key={f.path} style={{ marginBottom: 14 }}>
						<div style={{ fontSize: 12, marginBottom: 4, wordBreak: "break-all" }}>
							{badge(f.name, "#2a4a2a", "#8f8")}
							{badge(f.scope, "#333", "#ccc")}
							{(f.wins || info.effective.base === f.path || info.effective.append === f.path) && badge("active", "#2a4a6a", "#8cf")}
							<span style={{ color: "#888" }}>{new Date(f.mtimeMs).toLocaleString()} · {f.size} B · {f.path}</span>
						</div>
						<pre style={{ background: "rgba(127,127,127,.08)", border: "1px solid rgba(127,127,127,.25)", borderRadius: 8, padding: 10, fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 320, overflow: "auto", margin: 0 }}>{f.content}</pre>
					</div>
				))}
				{info.files.every((f: any) => !f.exists) && (
					<div style={{ color: "#888", fontSize: 13 }}>No SYSTEM.md / APPEND_SYSTEM.md found — pi is using its built-in default prompt.</div>
				)}
				<div style={{ fontSize: 11, color: "#777", marginTop: 8 }}>
					Trusted project files override global ones (same name only). SYSTEM.md replaces pi's default prompt; APPEND_SYSTEM.md appends to it.
				</div>
				<div style={{ fontSize: 11, color: "#888", marginTop: 6, borderTop: "1px solid rgba(127,127,127,.2)", paddingTop: 6 }}>
					This web chat's agent runs with {info.effective.base === "pi default" ? "its built-in chat default" : "SYSTEM.md as its base prompt"}{info.effective.append ? " + APPEND_SYSTEM.md" : ""} — the same files as the pi TUI. Its tools are browser-only (JS REPL); coding tools (bash/read/edit) exist only in the pi TUI or a server-side agent.
				</div>
			</div>
		</div>
	);
}
