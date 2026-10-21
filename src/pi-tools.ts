// pi-server tools — proxied execution of local pi extensions + workspace tools.
// The browser agent declares these tools to the LLM; execute() forwards to the
// server's /api/exec/tool bridge (extensions run in the server's node, same as
// the pi TUI). Tool defs (name/label/description/parameters) are fetched once at
// boot and must be available SYNCHRONOUSLY to toolsFactory (ChatPanel does not
// await it) — hence prefetch + cache, refreshed on page reload.
// Streaming: streamable tools (bash) return NDJSON frames — {type:"partial"} →
// forwarded to the loop's onUpdate (live output in the tool renderer), final
// {type:"result"} → returned as the tool result.
export interface PiServerTool {
	name: string;
	label: string;
	description: string;
	parameters: any;
	source?: string;
	stream?: boolean;
	execute: (toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: (partial: any) => void) => Promise<any>;
}

let cache: PiServerTool[] | null = null;

export async function fetchPiServerTools(force = false): Promise<PiServerTool[]> {
	if (cache && !force) return cache;
	let result: PiServerTool[] = [];
	try {
		const r = await fetch("/api/exec/tools", { signal: AbortSignal.timeout(8000) });
		if (!r.ok) { cache = result; return result; }
		const j: any = await r.json();
		result = (j.tools || []).map((t: any) => ({
			name: t.name,
			label: t.label || t.name,
			description: typeof t.description === "function" ? t.description() : (t.description || ""),
			parameters: t.parameters || { type: "object", properties: {} },
			source: t.source,
			stream: !!t.stream,
			execute: async (_toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: (partial: any) => void) => {
				const rr = await fetch("/api/exec/tool", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ tool: t.name, params: params ?? {}, stream: !!t.stream && !!onUpdate }),
					signal: signal ?? AbortSignal.timeout(120000),
				});
				const ct = rr.headers.get("content-type") || "";
				if (t.stream && ct.includes("x-ndjson") && rr.body) {
					// stream: NDJSON frames; client must buffer incomplete lines across chunks
					const reader = rr.body.getReader();
					const dec = new TextDecoder();
					let buf = "";
					let final: any = null;
					for (;;) {
						const { done, value } = await reader.read();
						if (done) break;
						buf += dec.decode(value, { stream: true });
						const lines = buf.split("\n");
						buf = lines.pop() ?? "";
						for (const line of lines) {
							if (!line.trim()) continue;
							try {
								const m = JSON.parse(line);
								if (m.type === "partial" && onUpdate) onUpdate(m.partialResult);
								else if (m.type === "result") final = m.result;
							} catch { /* skip malformed frame */ }
						}
					}
					return final ?? { isError: true, content: [{ type: "text", text: "(stream ended without result)" }] };
				}
				const out: any = await rr.json().catch(() => ({ content: [{ type: "text", text: `HTTP ${rr.status}` }] }));
				// normalize: pi tool result = { content: [{type:"text", text}] }
				if (!out || !Array.isArray(out.content)) return { content: [{ type: "text", text: JSON.stringify(out ?? null) }] };
				return out;
			},
		}));
		cache = result;
		return result;
	} catch {
		cache = result;
		return result;
	}
}
