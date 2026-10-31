// peers.tsx — the subagent surface in the browser (plan-subagents.md M3).
//
// Two pieces, both driven by the ONE view the server sends (`peers` snapshot + `peer` deltas, folded by
// peer-store.ts):
//   * PeerStrip   — a chip per peer under the composer: role · status · elapsed · current tool, with
//                   Stop on the chip and Stop-all at the end. Clicking a chip opens the transcript.
//   * PeerPanel   — the peer's OWN session, rendered live (plus Steer/Retry/Stop + open-in-full).
//
// The panel attaches with a SECOND ProxyAgent: the page's main agent owns the route's session, and a
// peer must never steal that state (the design review's "two clients" hazard — here they are two
// sockets with the same server-side rules, and the peer socket is observe-only by construction: it
// never sends prompt/steer for the peer, only `peer` control verbs the server scopes to the parent).
import { useEffect, useRef, useState } from "preact/hooks";
import { ProxyAgent } from "../proxy-agent.js";
import { escapeHtml, renderMarkdown } from "./markdown.js";
import { peerLabel, peerTone, runningCount, type Peer, type PeerBudget } from "./peer-store.js";

/** The compact header under the composer: one chip per peer. */
export function PeerStrip({ agent, onOpen }: { agent: any; onOpen: (peer: Peer) => void }) {
	const [peers, setPeers] = useState<Peer[]>(agent?.peers || []);
	const [budget, setBudget] = useState<PeerBudget | null>(agent?.peerBudget || null);
	const [, force] = useState(0);
	useEffect(() => {
		if (!agent?.onPeers) return;
		const off = agent.onPeers((list: Peer[], b: PeerBudget) => { setPeers(list); setBudget(b); });
		const tick = setInterval(() => force((n) => n + 1), 1000); // the elapsed time ticks client-side
		return () => { off?.(); clearInterval(tick); };
	}, [agent]);
	if (!peers.length) return null;
	const running = runningCount(peers);
	return (
		<div class="pw-peer-strip" role="status" aria-label="subagents">
			<span class="pw-peer-strip-label">{running ? `${running} running` : "peers"}</span>
			{peers.map((p) => (
				<span key={p.id} class={`pw-peer-chip pw-peer-${peerTone(p.status)}`} title={`${p.taskPreview || p.id}${p.error ? `\n${p.error}` : ""}`}>
					<button type="button" class="pw-peer-open" onClick={() => onOpen(p)}>
						<span class="pw-peer-dot" aria-hidden="true" />
						<span class="pw-peer-name">{peerLabel(p)}</span>
					</button>
					{p.status === "running" && (
						<button type="button" class="pw-peer-x" title="Stop this peer" onClick={() => agent?.controlPeer?.("stop", p.id)}>■</button>
					)}
				</span>
			))}
			{running > 1 && (
				<button type="button" class="pw-peer-stopall" title="Stop every running peer" onClick={() => agent?.stopAllPeers?.()}>Stop all</button>
			)}
			{budget && budget.concurrent === 0 && <span class="pw-peer-budget" title="the concurrency cap is reached">at capacity</span>}
		</div>
	);
}

type Entry = { role: string; text: string; tool?: string; kind?: "tool" | "error" };

/** Fold a peer session's messages into the few rows worth showing (the full detail is one click away). */
export function peerEntries(messages: any[]): Entry[] {
	const out: Entry[] = [];
	for (const m of Array.isArray(messages) ? messages : []) {
		if (!m || typeof m !== "object") continue;
		if (m.role === "system") continue;
		if (m.role === "toolResult") {
			const text = textOf(m.content);
			out.push({ role: "tool", tool: m.toolName || "tool", text, kind: "tool" });
			continue;
		}
		const blocks = Array.isArray(m.content) ? m.content : [{ type: "text", text: String(m.content ?? "") }];
		const text = blocks.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n\n");
		if (text) out.push({ role: m.role, text, ...(m.errorMessage ? { kind: "error" as const } : {}) });
		for (const b of blocks) {
			if (b?.type === "toolCall") out.push({ role: "call", tool: b.name, text: JSON.stringify(b.arguments ?? {}).slice(0, 400), kind: "tool" });
		}
	}
	return out;
}
const textOf = (content: any) => (typeof content === "string" ? content : (content || []).filter((b: any) => b?.type === "text").map((b: any) => b.text || "").join("\n\n"));

/**
 * The peer's transcript, live. It attaches its OWN socket to the peer's session id (read-mostly) and
 * offers the control verbs the server accepts from the parent.
 */
export function PeerPanel({ agent, peer, onClose }: { agent: any; peer: Peer; onClose: () => void }) {
	const [entries, setEntries] = useState<Entry[]>([]);
	const [status, setStatus] = useState<Peer["status"]>(peer.status);
	const [err, setErr] = useState<string>("");
	const [steer, setSteer] = useState("");
	const peerAgent = useRef<any>(null);
	const bodyRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const id = peer.sessionId;
		if (!id) { setErr("the peer has no session yet — it was refused or never started"); return; }
		const pa = new ProxyAgent(id);
		peerAgent.current = pa;
		pa.connect(); // a READ-mostly socket of its own: it never prompts the peer, it renders it
		const unsub = pa.subscribe((ev: any) => {
			if (ev?.type === "state") setEntries(peerEntries(pa.state.messages));
			else if (ev?.type === "agent" && (ev.event?.type === "message_end" || ev.event?.type === "turn_end" || ev.event?.type === "agent_end")) {
				setEntries(peerEntries(pa.state.messages));
			}
		});
		const iv = setInterval(() => setEntries(peerEntries(pa.state.messages)), 1500); // the child streams; poll cheaply
		return () => { clearInterval(iv); unsub?.(); try { pa.disconnect(); } catch { /* socket already gone */ } };
	}, [peer.sessionId]);

	// the peer's status keeps moving while the panel is open (the strip polls the parent socket)
	useEffect(() => {
		const off = agent?.onPeers?.((list: Peer[]) => {
			const hit = list.find((p) => p.id === peer.id);
			if (hit) { setStatus(hit.status); }
		});
		return () => off?.();
	}, [agent, peer.id]);

	useEffect(() => {
		const el = bodyRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [entries.length]);

	return (
		<aside class="pw-peer-panel" aria-label={`subagent ${peer.role || peer.id}`}>
			<header class="pw-peer-head">
				<span class={`pw-peer-dot pw-peer-${peerTone(status)}`} aria-hidden="true" />
				<b>{peer.role || "peer"}</b>
				<span class="pw-peer-head-meta">{peerLabel({ ...peer, status })}</span>
				{peer.model && <span class="pw-peer-head-meta">{peer.model}</span>}
				<span class="pw-peer-head-gap" />
				{status === "running" && <button type="button" onClick={() => agent?.controlPeer?.("stop", peer.id)}>Stop</button>}
				{status !== "running" && <button type="button" title="Resume this peer at its failure point" onClick={() => agent?.controlPeer?.("retry", peer.id)}>Retry</button>}
				{peer.sessionId && <a class="pw-peer-open-full" href={`/s/${encodeURIComponent(peer.sessionId)}`} target="_blank" rel="noreferrer">open</a>}
				<button type="button" class="pw-peer-close" onClick={onClose} title="Close">✕</button>
			</header>
			{peer.taskPreview && <div class="pw-peer-task">{peer.taskPreview}</div>}
			<div class="pw-peer-body" ref={bodyRef}>
				{err && <div class="pw-peer-err">{err}</div>}
				{entries.map((e, i) => (
					<div key={i} class={`pw-peer-row pw-peer-${e.kind || e.role}`}>
						<span class="pw-peer-role">{e.kind === "tool" ? (e.role === "call" ? `→ ${e.tool}` : `← ${e.tool}`) : e.role}</span>
						<div class="pw-peer-text" dangerouslySetInnerHTML={{ __html: e.kind === "tool" ? `<pre>${escapeHtml(e.text.slice(0, 2000))}</pre>` : renderMarkdown(e.text) }} />
					</div>
				))}
				{!entries.length && !err && <div class="pw-peer-empty">waiting for the peer's first message…</div>}
			</div>
			{status === "running" && (
				<div class="pw-peer-steer">
					<input
						value={steer}
						placeholder="steer this peer…"
						onInput={(e: any) => setSteer(e.currentTarget.value)}
						onKeyDown={(e: any) => { if (e.key === "Enter" && steer.trim()) { agent?.controlPeer?.("steer", peer.id, steer.trim()); setSteer(""); } }}
					/>
					<button type="button" disabled={!steer.trim()} onClick={() => { agent?.controlPeer?.("steer", peer.id, steer.trim()); setSteer(""); }}>Steer</button>
				</div>
			)}
		</aside>
	);
}

