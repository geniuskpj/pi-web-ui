// log-proxy.mjs — a transparent logging reverse-proxy in front of the provider, so the
// REQUEST BODY any client sends (the pi CLI, our hub, anything) can be compared instead of
// guessed. Logs one JSON line per request to ws-diag/requests.log and streams the response
// back untouched (SSE must not be buffered).
//
// Usage: node ws-diag/log-proxy.mjs [port] [upstream]
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2] || 8799);
const UPSTREAM = process.argv[3] || "https://integrate.api.nvidia.com";
const LOG = path.join(HERE, "requests.log");

http.createServer(async (req, res) => {
	const chunks = [];
	for await (const c of req) chunks.push(c);
	const body = Buffer.concat(chunks);
	let parsed = null;
	try { parsed = JSON.parse(body.toString("utf8")); } catch { /* not JSON */ }
	if (parsed) {
		const keep = { model: parsed.model, max_tokens: parsed.max_tokens, max_completion_tokens: parsed.max_completion_tokens, stream: parsed.stream, reasoning_effort: parsed.reasoning_effort, reasoning: parsed.reasoning, thinking: parsed.thinking, chat_template_kwargs: parsed.chat_template_kwargs, chat_template_args: parsed.chat_template_args, temperature: parsed.temperature, top_p: parsed.top_p, tools: (parsed.tools || []).length, messages: (parsed.messages || []).length, _all_keys: Object.keys(parsed) };
		fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), path: req.url, auth: (req.headers.authorization || "").slice(0, 12) + "…", req: keep }) + "\n");
	}
	const url = new URL(req.url, UPSTREAM);
	const headers = { ...req.headers };
	delete headers.host;
	delete headers["content-length"];
	try {
		const up = await fetch(url, { method: req.method, headers, body: req.method === "GET" ? undefined : body });
		res.writeHead(up.status, { "content-type": up.headers.get("content-type") || "application/json" });
		if (up.body) {
			const reader = up.body.getReader();
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				res.write(Buffer.from(value));
			}
		}
		res.end();
	} catch (err) {
		res.writeHead(502, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: String(err?.message || err) }));
	}
}).listen(PORT, "127.0.0.1", () => console.log(`[log-proxy] http://127.0.0.1:${PORT} → ${UPSTREAM} · log ${LOG}`));
