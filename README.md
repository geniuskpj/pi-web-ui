# pi web

Browser chat UI for pi agents (`@earendil-works/pi-agent-core` + `pi-ai`).
Preact frontend, Hono server, esbuild bundle. The agent loop runs **on the server**.

```bash
npm i
npm run dev            # build + start → http://localhost:8787
npm run build          # bundle only
npm start              # start without rebuilding
```

## Setup

| What | Where | Default |
|---|---|---|
| keys, providers, models | `$PI_DIR/auth.json`, `$PI_DIR/models.json` | `~/.pi` |
| workspace (bash cwd + fs root) | `$PI_WS` | parent of `PI_DIR` |
| sessions, token, logs, images | `$PI_WEB_DATA_DIR` | `<repo>/data` |

A provider you write yourself — `models.json`:

```json
{ "providers": {
    "local": { "baseUrl": "http://127.0.0.1:8080/v1",
               "api": "openai-completions",
               "models": [{ "id": "qwen3-coder" }] } } }
```

An OpenAI-compatible endpoint needs no key (it sends `Bearer none`). Real keys go in
`auth.json`, one per provider.

From another device (phone, LAN, DDNS): non-loopback peers need the API token, written to
`data/auth-token.txt` on first boot. The UI asks for it once and stores it locally.

## Architecture

```
    Browser (any device)                  Node server (:8787)
 ┌────────────────────────┐        ┌──────────────────────────────────┐
 │ Preact UI (src/ui/)    │  HTTP  │ server.mjs       Hono app        │
 │  chat · composer       │◄──────►│  REST · static · bash bridge     │
 │  find · files · dock   │   WS   │ agent-hub.mjs    agent loop      │
 │  settings · sessions   │◄──────►│  one Agent per session + tools   │
 │ localStorage           │        │ session-worker.mjs  JSONL mirror │
 │ IndexedDB chunk cache  │        │ terminal-hub.mjs    shell        │
 └────────────────────────┘        │ lib/*               pure logic   │
                                   └───────────────┬──────────────────┘
   .pi/auth.json · models.json                     │
   data/sessions/*.jsonl · data/media/             ▼ direct LLM calls
                                              provider API
```

| Channel | Endpoint | Carries |
|---|---|---|
| REST | `/api/*` | sessions, files, config, bash bridge |
| WS | `/ws/agent` | one socket per session: prompts in, agent events out |
| WS | `/ws/sync` | session metadata between devices |
| WS | `/ws/terminal` | the dock's shell |
| token | `PI_WEB_TOKEN` | required by every non-loopback peer |

## Features

**Chat**
- Server-side agent loop: a run keeps going when the tab or phone closes, and every attached device sees the same live stream.
- Streaming render: plain text while streaming, markdown once the message ends; tool rows keyed by `toolCall.id`.
- Steering: sending mid-run holds the message as a chip (✎ pull back, ✕ cancel) and injects it at the next step boundary.
- Retry resumes at the failed call; auto-retry covers rate-limit, network and transient 5xx errors (3×3s, configurable).
- Thinking blocks collapse; thinking level is switchable from the composer or Settings.
- Attachments: workspace text files inlined as fenced blocks; images are sized from their header,
  re-encoded to the *Images* level (resize + webp) and uploaded as binary, so the prompt carries a
  content hash and the model gets the bytes back server-side.
- Compact summarizes older history in place and keeps the recent tail; every ✎ edit parks a restorable version.

**Sessions**
- Tail-first loading: a large session attaches only the last ~1MB, older turns load on demand.
- IndexedDB chunk cache: reopening a warm session costs zero network; rewritten generations are collected by date.
- Display by user turn: the last N turns are visible (Settings → Composer → *Turns visible*, default 3), ⤒ loads one more per click.
- Multi-device: attach from another browser or phone, watch or continue the same run.
- Find in conversation (`Ctrl/Cmd+F`): server-side search over the whole session, hit list with turn context, in-place jump or read-only peek.

**Files & tooling**
- File explorer: browse and preview (syntax highlighting, line numbers, images), multi-select to attach.
- Contents search: `rg` on the server, results grouped per file, click to open at the hit line.
- Terminal dock: a real shell in the bottom dock (pty tier, or pipes with a generated rc), OSC 133 exit codes, replay buffer, drag-resize.
- Every `bash` tool row links straight to that dock.

**Models & providers**
- The picker lists only providers you can run: entries in `.pi/models.json` or keys in `.pi/auth.json`.
- Models come from the pi-ai catalog, pi's `models-store.json`, your `models.json` and the provider's own `/models` (fetched at boot).
- Keyless OpenAI-compatible endpoints work as-is, so local llama.cpp/vLLM/Ollama servers need no credentials.

**Subagents**
- The main agent can delegate to a **peer**: a child agent with its own role prompt (`reviewer`, `oracle`,
  `scout`, `worker`, `delegate`, or your own `.pi/agents/*.md`), its own narrowed tool set (read-only roles
  literally cannot write), and its own **session**. Click the peer's chip under the composer (or `↗ peer
  transcript` on the tool row) to read its chat while it works.
- Peers are watched and controlled from the same place: live status, elapsed time, current tool, Stop /
  Stop-all, Steer and Retry — from the UI, from `POST /api/agent/session/:id/peers/…`, or by the agent
  itself via the `subagent` tool. `PI_WEB_PEERS=off` disables the whole feature.

**Settings**
- Model and thinking level, turns visible, API keys (import from pi or add), Data use (image level,
  stream level, image retention per device — sticky per session), theme, server token, auto-retry.

## Source

| Path | Job |
|---|---|
| `server.mjs` | Hono app: auth, REST, static, exec bridge, WS upgrade |
| `agent-hub.mjs` | one Agent per session; events fan out to attached devices |
| `session-worker.mjs` | JSONL session writes in a worker thread |
| `terminal-hub.mjs` | shell sessions for the dock (pty tier or pipes) |
| `lib/` | pure logic: system prompt, model catalog, search, stream reduction |
| `src/ui/` | Preact views: chat, composer, find, files, settings, terminal |
| `src/*.ts` | client plumbing: boot, agent adapter, storage, sync, tools |

## Configuration

| Env | Default | Purpose |
|---|---|---|
| `PI_DIR` / `PI_WS` | `~/.pi` / its parent | pi config dir · workspace root |
| `PORT` / `HOST` | `8787` / `0.0.0.0` | listener |
| `PI_WEB_TOKEN` | auto-generated | gate for `/api/*` + `/ws/*` from non-loopback peers |
| `PI_WEB_ORIGIN_GATE` | `auto` | host allowlist strictness: `auto` · `strict` · `off` |
| `PI_WEB_DEBUG` | off | verbose server logging |

Full table: [`docs/architecture.md`](docs/architecture.md) §Environment.

## Docs

| Doc | Start here when you touch |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | anything — module map, data flows, trust model |
| [`docs/server.md`](docs/server.md) | endpoints, tools, exec bridge, provider catalog, WS hubs |
| [`docs/client.md`](docs/client.md) | boot, rendering, find, storage, sync, data use |
| [`docs/terminal.md`](docs/terminal.md) | the shell dock end to end |

Also: `docs/features.md` (versions, retry, compact, bundling), `docs/lessons.md`
(contracts and incident lessons), `bugs.md` (open items).

Tests: `node tests/<file>` runs one suite; `npm run test:<name>` for the scripted ones.
