# plan-subagents.md — child sessions (peers) in pi web

Status: **M0–M3 IMPLEMENTED** (2026-10-31). M4 (budget UX, `read_peer`, peer GC/TTL) and M5 (council,
arena-bridge peers) are still open — and the UI has been built but NOT yet seen on a live app (that needs a
server restart, see the implementation log). See *Implementation log* at the end for the files, the test counts and
the three things the code does differently from this document.

Supersedes the stale `feat/llm-peer-chat` placeholder branch (which
contains no peer code — see *Appendix A*). Written 2026-10-31 after reading the reference implementation
[`nicobailon/pi-subagents`](https://github.com/nicobailon/pi-subagents) (MIT; ideas only, no code copied).

## Goal

The main agent can **delegate to child agents ("peers")** and the user can **watch each peer's own chat**.

1. a peer runs **the same class of tools as the main agent** (read/edit/bash/…), narrowed per role;
2. a peer has a **different system prompt per role** (`reviewer`, `oracle`, `scout`, `worker`, …);
3. **clicking a peer shows its transcript** — live, in the browser, with its tool rows;
4. the parent's conversation stays readable: one tool row per delegation, not the child's whole transcript;
5. **every peer can be watched and controlled**: live status (running/idle/error, current tool, elapsed,
   tokens) and Stop / Stop-all / Steer / Retry — from the UI, from REST, and by the main agent itself.

## Non-goals (v1)

Not copying the parts of the reference that exist because it is a TUI *extension*:

| Reference thing | Why we skip it |
|---|---|
| detached background runner process | our agent loop already runs server-side and survives disconnects — a child is just a session |
| missions / schedules / delivery receipts | separate product; nothing in the web UI needs it yet |
| worktree isolation for parallel writers | single workspace by design (`assertInsideRoots`); parallel *writers* stay forbidden |
| external CLI runners (`claude-code`, `codex-exec`, `cursor-agent`) | out of scope; the provider catalog + arena bridge already give access to many models |
| intercom / supervisor channel, watchdog adversarial reviewer | interesting, not v1 |
| per-agent memory files, skills inheritance | v2 at the earliest |
| council mode (N advisors debate, multi-round) | M4, after the single-delegation path is proven |
| recursive spawning (child spawns children) | **deliberately depth 1** (reference caps it too) |

## Prior art → our mapping

| Concept in `pi-subagents` | Their mechanism | Ours |
|---|---|---|
| subagent = child Pi session | foreground (in-process) or background (detached runner) | **a normal session** with `parentSession` + `peerRole` in its JSONL header |
| role definition | `agents/<role>.md` + YAML frontmatter (`tools:`, `acceptanceRole:`, `thinking:`, `systemPromptMode:`, `inheritProjectContext:`) | same file format, parsed by `lib/peer-roles.mjs` (pure, tested); search order `.pi/agents/` → `<workspace>/.pi/agents/` → builtin defaults |
| `subagent` tool | one tool, many `action`s; parent decides when to delegate | one server tool **`subagent`** with `action: run \| list \| status \| stop`, streaming via `onUpdate` |
| read-only roles | tool allowlist per role | tool allowlist enforced **server-side** when the child `Agent` is built |
| result delivery | child's final message becomes the tool result | the child's **final assistant text** becomes the tool result, bounded (32 KB) + `session <id>` pointer |
| FleetView / inspector (browse children, read transcripts, steer, stop) | TUI panel | **peer panel** in the web UI: click the tool row (or the header strip) → live child transcript, Steer/Stop per peer |
| concurrency + spawn caps (`maxSubagentSpawnsPerRun` 64, concurrency) | extension config | hub-side caps: concurrent children per parent (3), spawns per parent run (24), per-child wall clock (10 min) |
| model per role | `models.md` profiles, per-role overrides | frontmatter `model:`/`thinking:` → resolved through `lib/pi-catalog.mjs`; fallback = parent's model |

## Design decisions

**D1 — a peer is a session, not a new concept.** Child id = `crypto.randomUUID()`, header gains
`parentSession` and `peerRole`; everything that already exists keeps working on it for free:
persistence (`session-worker.mjs`), tail-first attach + `/range`, IDB cache, versions sidecar,
compaction, media redaction, retry/abort, runtime frames. We add **no** second transcript store.
*Consequence:* we must HIDE peers from the main session list (D7) and keep `/ws/sync` broadcasts sane.

**D2 — roles are files, decisions are pure.** `lib/peer-roles.mjs`:
`parseRoleFile(text)` → `{ name, description, tools[], acceptanceRole, thinking, model, systemPromptMode: "replace"|"append", body }`;
`listRoles(dir)`; `resolveRole(name, { dirs })`; `PASSTHROUGH` for unknown frontmatter keys.
Tested like `lib/*` always is (`tests/peer-roles.test.mjs`), with fixtures for: missing frontmatter,
`tools` as comma list vs YAML array, `systemPromptMode: append` (body appended to the main prompt),
`acceptanceRole: read-only` implying a read-only tool default, unicode/CRLF files.

**D3 — capability is enforced by tools, not by prompt text.** Builtins already carry `name` +
`execute`; the child `Agent` gets `tools: roleTools` where `roleTools = getTools().filter(t => role.tools.includes(t.name))`.
`read_only` roles get `read_file`/`rg`-search/`ls`-style tools only — no `write_file`, `edit`, `bash`,
`subagent`. A prompt that *asks* a reviewer not to edit is therefore not a security control; the
allowlist is. Also: the child NEVER gets `subagent` (depth 1) and never the exec bridge.

**D4 — one tool row, bounded report.** The parent's transcript receives exactly one `subagent` tool call
+ one tool result. The child's messages never enter the parent's context (no transcript splicing, no
"transcript-in-history"). The result is `{ content: [{type:"text", text: report}] }` with the report
capped at 32 KB (tail kept, middle elided, `full transcript: session <childId>` appended). A child that
fails returns a tool ERROR (`isError`) — the parent then decides whether to retry or re-delegate.

**D5 — streaming.** `subagent.execute(id, params, signal, onUpdate)` emits
`onUpdate({ content: [{type:"text", text: "peer reviewer · searching… 4 files"}] })` at a bounded rate
(≤1/2 s, deduped) — the hub already turns that into `tool_execution_update` frames, so the parent's tool
row shows live progress exactly like `bash` does today. Child `agent` events go to whoever is attached to
the CHILD session (the peer panel), not to the parent's sockets.

**D6 — lifecycle.** Foreground run only in v1: the tool awaits the child's `agent_end` (timeout 10 min,
`signal`-linked). Parent **abort → child abort** (`hub.abort(childId)`), parent socket close → nothing
(the run is server-side anyway). `subagent({action:"status"})` returns the parent's live children;
`action:"stop"` aborts one. Children are marked `peerRole` + `parentSession` so a hub restart can
re-attach them by id (the child's JSONL is a normal session file).

**D7 — UI.** Three pieces, all reusing existing patterns:
* **peer panel** (right side / mobile sheet): a second attach to the child session id, read-mostly:
  renders the same bubbles (markdown, tool rows, thinking) from the existing components; Steer/Stop
  buttons call the same WS verbs. Needs its own `ProxyAgent` instance — `src/main.tsx:186` creates ONE
  per route, so the panel constructs a second one and must not touch the URL/session state.
* **tool-row affordance**: the `subagent` row gets a `↗ peer transcript` button, exactly like the bash
  row's `↗ terminal` (`src/ui/chat.tsx:304` + `termBus`); it opens the panel for that child id.
* **peers strip** in the parent header: one chip per child (role · model · status · elapsed), click =
  same panel. Session list: peers are filtered out of the main list and shown nested under the parent
  (`src/ui/session-list.tsx` already merges `/api/sessions`; `/api/sessions` gains
  `parentSession`/`peerRole` in metadata).

**D8 — caps and budgets** live in the hub (not in the prompt): concurrent children per parent (3),
spawns per parent per run (24), wall clock per child (10 min), report cap (32 KB), and a `subagent`
call with an unknown role fails fast (never silently defaults to a generalist).
**Enforced BEFORE `new Agent`** (grok P1-5): `maxDepth` (1), `maxConcurrentPerParent` (3),
`maxConcurrentGlobal` (6), `maxChildTurns` (40), `maxChildTokens` (per role, default 200k). Over-budget
is a terminal ERROR tool result, never a hang; the remaining budget is part of the peer record, so a
parent cannot reset it by re-delegating in a loop.

**D9 — a `PeerSupervisor` owns lifecycle, not the hub and not the tool.** (grok P0-3) One small module
that holds: the peer records, the child promise per peer, the abort TREE (parent → children), the caps,
and the heartbeat. `subagent.execute()` does exactly one thing — `await supervisor.wait(peerId)` — and
the child's completion is queued into the parent as an ORDINARY tool result (the same path a `bash`
result takes). No session/hub lock, no `promptLock`, and no broadcast re-entry is held across that
await; `supervisor.cancel(idOrTree)` aborts with a timeout and then orphans→kills. Abort of the parent
is `cancel(tree)`, so it can never wait on a lock the child needs to finish. Tested with a fake Agent
plus a deliberately re-entrancy-throwing lock.

**D10 — visibility is a wire field, not a UI filter.** (grok P0-1) Session metadata gains
`kind: "user" | "peer"` (+ `parentSession`, `peerRole`, `peerTitle`), and EVERY `/ws/sync` event carries
it. `listSessions` defaults to `kind=user`; a child is reachable by id (REST/WS) but is not listed,
cached, searched or exported until someone opens it on purpose. Hiding peers in the client alone would
leave the session list, the IDB cache, `lastSession`, export and GC polluted.

**D11 — peer lifecycle is PERSISTED, and status is a function of (journal, live map).** (grok P0-2)
In-memory runtime frames cannot answer "is this child still running?" after a restart. The parent's
JSONL and the child's JSONL each get lifecycle entries (`peer_started` / `peer_ended` / `peer_error`
with the peer id), so:

```
status(peer) = needs_result   if the parent journal has a spawn without its result and no live Agent
             = running        if a live Agent exists (hub may only UPGRADE, never invent)
             = aborted|error|idle  from the child journal's terminal entry
```

**Boot reconcile** finishes the interrupted transaction: a parent with an unanswered spawn and no live
child gets the tool result written as `status:"aborted"` (reason: server restart), so the parent
transcript is never left with a dangling tool call — the same class of problem the LFP incident left us.

**D12 — the tool result is a FROZEN schema.** (grok P1-6)
`{ status: "ok"|"error"|"aborted"|"timeout", sessionId, role, model, usage: {input, output, cost},
 error?: string, summary: string, truncated: boolean }` — rendered as one text block for the model, the
fields also sent as tool `details` so the UI can render a chip instead of parsing prose. The 32 KB cap
applies to `summary` ONLY, measured in UTF-8 bytes; `status`/`error`/`sessionId` are never truncated
(otherwise the parent retries blindly on a truncated failure). Child messages are never inlined — the
parent gets `sessionId` and opens it if it needs more (a `read_peer` tool action in M4).

## Status & control (first-class requirement, not a later polish pass)

A delegation the user cannot see or stop is not shippable. Peers therefore get the SAME
status/control surface the main session already has — because a peer IS a session (D1):

**Status.** Two layers, per grok P0-2: the PERSISTED journal is the source of truth across restarts
(D11), and the live Agent map may only upgrade a peer to `running`. The hub's existing per-session
runtime view (`getRuntime` + the LFP self-heal) is reused for the live half, the parent aggregates:

```jsonc
// parent attach snapshot (one entry per child, newest first)
s→c { type: "peers", sessionId, peers: [ { id, role, model, title, status: "running"|"idle"|"error"|"aborted",
        startedAt, elapsedMs, currentTool, lastText, turn, tokens: {input, output, cost} } ] }
// deltas while a child works (rate-limited ≤1/2s per child, same reducer budget as tool updates)
s→c { type: "peer", sessionId, peer: { id, status, currentTool, elapsedMs, lastText } }
```

The strip, the panel header, the REST route and `subagent({action:"status"})` all read THIS one view —
no second source of truth. `window.__piPeers` mirrors it for CDP checks.

**Who may mutate what** (grok P1-4): every mutating verb must name the PARENT as the actor
(`actorSessionId`), a child's own socket is OBSERVE-ONLY (it can read the transcript, never steer
itself), and a verb from a foreign session is refused. That removes the two-client race where an open
child tab and the parent strip both drive one run. `retry` on a finished spawn means *cancel the live
child (if any) and start a NEW peer id* — never resume a dead child's transcript.

**Control.** One verb set, three callers (the panel's buttons, the parent's strip, the main agent's own
`subagent` tool):

| Verb | Transport | Hub operation | Notes |
|---|---|---|---|
| stop | WS `{type:"peer", action:"stop", peerId}` · REST `POST …/peers/:peerId/stop` · tool `subagent({action:"stop"})` | `hub.abort(childId)` | the child's `agent_end` settles it; its partial transcript and any tool results stay on disk |
| steer | WS `{type:"peer", action:"steer", peerId, text}` · REST `…/peers/:peerId/steer` | `hub.steer(childId, text)` | the child already holds steers until its current step ends |
| retry | WS `{type:"peer", action:"retry", peerId}` | `hub.retry(childId, {reason:"manual"})` | resumes AT the failure point (existing retry contract) |
| stop all | WS `{type:"peer", action:"stop-all"}` · tool `subagent({action:"stop", all:true})` | abort every child of the parent | one button in the strip |
| spawn (user) | panel `+` / strip | `hub.spawnPeer(parent, {role, task})` | the user can delegate too, without waiting for the model |

Replies echo the request id and the new status (`{type:"peer", id, peerId, ok, peer}`) so the UI never
optimistically lies. Control is refused with a clear reason when it cannot apply (already idle, unknown
peer, child of another parent, spawn budget exhausted).

**The parent's own tool actions** (`subagent({action})`) keep the main agent self-sufficient: it can list
its children, read one child's status, stop a runaway peer, or steer a peer that is off track — without
the user touching the UI.

## Contracts (each one gets a test)

| # | Contract |
|---|---|
| C1 | A child session is a normal session: `GET /api/agent/session/:id`, attach, `/range`, IDB cache, versions, compaction all work on it unchanged |
| C2 | The parent's transcript contains exactly ONE tool row per delegation; the child's messages never appear in it |
| C3 | The tool result is the child's final assistant text, capped ≥ 32 KB with an explicit `… truncated …` marker and the child id |
| C4 | Role tools are enforced server-side; a `read-only` role cannot write even if the prompt says to |
| C5 | A child cannot spawn a child (no `subagent` tool, and the hub rejects `action:"run"` from a child) |
| C6 | Parent abort aborts the child; a child timeout surfaces as a tool error, not as a parent abort |
| C7 | Caps hold: the (n+1)-th concurrent child, the 25th spawn in a run, and the 10-minute child are refused/stopped with a clear message |
| C8 | Peers are excluded from the main session list and from `/ws/sync` session-metadata broadcasts (no sidebar churn while a child streams) |
| C9 | Child persistence is redacted like any session (image hashes, no base64 in the file) and honours the session's media retention |
| C10 | A hub restart re-attaches a child by id: its transcript reloads, its `peerRole`/`parentSession` come from the header |
| C11 | Spawn budget/caps are per PARENT RUN; a fresh user turn resets the counters (a long session must not be permanently exhausted) |
| C12 | `subagent` never runs when `PI_WEB_TOOLS` excludes it (existing per-tool allowlist stays the outer gate) |
| C13 | The status view is TRUTHFUL: a child whose run died without `agent_end` settles to `idle`/`error` via the existing self-heal (no phantom "running" chip), and `elapsedMs`/`currentTool` match the child's own runtime frames |
| C14 | stop/steer/retry on a child are the SAME hub operations as on a session (no parallel code path), and every control action is reflected in the strip, the panel and the next `subagent({action:"status"})` |
| C15 | Control is parent-scoped: a socket attached to session A cannot stop/steer a child of session B (403/message), and an unknown peerId is a no-op with a reason |
| C16 | Control survives the UI: closing the panel/tab does not stop a child; reopening re-reads the `peers` snapshot (the run is server-side anyway) |
| C17 | Session metadata and EVERY `/ws/sync` event carry `kind`; a peer never appears in `listSessions`, the IDB cache, `lastSession`, search or export unless it was opened by id |
| C18 | A child killed by a SERVER RESTART reconciles at boot: the parent's dangling spawn gets an `aborted` tool result and the peer shows `aborted` — never a phantom `running` |
| C19 | `PeerSupervisor` holds no hub/session lock across `wait()`; a re-entrancy-throwing lock in a test proves it, and parent-abort → child-abort completes within the timeout with no deadlock |
| C20 | Caps are enforced BEFORE `new Agent` (depth, concurrency per parent, concurrency global, turns, tokens); over-budget returns a terminal error result and consumes budget permanently |
| C21 | The tool result matches the frozen schema exactly (fields + `usage` + `truncated`), the 32 KB cap applies to UTF-8 `summary` only, and child media is redacted on the way into the child's own JSONL |
| C22 | `compact`/`rewrite`/`fork` are REFUSED on a parent with live peers (clear reason); a child may compact itself; a fork copies `parentSession` lineage only, never live runtime |

## Phases

Ordering follows grok P1-7: the MODEL and the wiring contracts land before any UI, because a UI built on
lying frames is worse than no UI. M0–M2 are server-only + tests; M3 is the first pixel.

**M0 — model, visibility, status (no UI, no spawn yet).** `lib/peer-roles.mjs` (+`tests/peer-roles.test.mjs`,
≥25 checks, builtin roles `reviewer`/`oracle`/`scout`/`worker`/`delegate`, `.pi/agents/*.md` examples);
`kind`/`parentSession`/`peerRole` in session metadata + the `/ws/sync` filter + `listSessions(kind=user)`;
the persisted lifecycle journal and `peerStatus()` as a PURE function of (journal entries, live map)
(+ suite covering: never-started, running, ended, error, dangling-after-restart); `PeerSupervisor`
skeleton with its lock rules and caps; the frozen result schema. Acceptance: C17/C18(status function
side)/C19/C20/C21(schema side) + the role suite green. **No protocol or storage change lands after this.**

**M1 — spawn + one-row result + crash reconcile.** `hub.spawnPeer(parentId, {role, task, model?, thinking?})`,
role-aware child `Agent` (prompt + narrowed tools), `subagent` tool with streaming `onUpdate`, lifecycle
entries written to both journals, boot reconcile that answers dangling spawns, `/api/sessions` metadata.
Acceptance (`tests/subagent.test.mjs` + `tests/subagent-spawn.e2e.mjs`): C1/C2/C4/C5/C6/C7/C10/C11/C21,
including a parent killed mid-spawn whose child is reconciled as `aborted`.

**M2 — status + control tree.** Runtime aggregation over children, the `peers` snapshot + `peer` deltas,
the WS verb set and REST twins, actor=parent enforcement, child sockets observe-only, abort tree +
timeouts, `subagent({action:"status"|"stop"|"steer"|"retry"})`. Acceptance
(`tests/subagent-control.test.mjs` + `tests/subagent-control.e2e.mjs`): C13/C14/C15/C18/C19 with a stop
mid-tool-call, a steer that changes the child's next step, a foreign-session refusal, and a forced
deadlock attempt (parent abort while the child holds the tool lock).

**M3 — UI.** Peer panel (second attach, read-mostly), `↗ peer transcript` on the `subagent` row, peers
strip with status + Stop/Stop-all, session-list grouping (peers nested under the parent, never in the
flat list), transcript export. Acceptance: CDP checks on the live app (`window.__piPeers`: chips match
live children; status/elapsed track a running child; Stop clears the chip; Steer round-trips; a finished
peer opens read-only), plus `tsc`/build gates.

**M4 — budget UX + `read_peer`.** Remaining-budget display and per-peer spend rolled into the parent's
UsageBar; `subagent({action:"read", peerId})` so the parent can pull a child's tail when the 32 KB
summary was truncated; peer GC with the parent + TTL.

**M5 (optional) — council.** `subagent({action:"council", roles:[…], rounds:K})`: N read-only advisors on
one question, each sees the others' answers, one merged report. Plus optional **arena-bridge peers**
(`ws/arena/chat-api.mjs`) so models without an API key (grok/claude/gemini) can be peers. Acceptance:
deterministic turn order (pure function + suite), merged report structure pinned by a test.

## Risks

| Risk | Mitigation |
|---|---|
| Context/cost blowup: each child re-reads files, N children = N× tokens | caps (D8) + role defaults read-only-first + a per-child token log in the tool result footer |
| Frame flood while a child streams to the panel | the panel attaches to the CHILD, so the parent's socket is untouched; updates are rate-limited (D5) |
| Session-list noise (a child per delegation) | C8: filtered from the main list, nested under the parent |
| `/ws/sync` broadcast storm on child writes | the worker's session broadcast is filtered for peers; the parent's UI refreshes peers from the runtime/peer frames |
| Second attach in the client (two ProxyAgents) | the panel owns its instance, never touches the route/session state; a single `peerStore` keyed by child id is the seam |
| A child writing while the parent writes (same workspace) | parallel writers stay forbidden: `worker` role is capped to ONE concurrent child per parent (serialized), read-only roles up to 3 |
| Abort/retry semantics drift | C6 + explicit tests: retry of the parent's `subagent` row = a NEW child (never a silent re-use of the old transcript) |
| Status/control drift (a strip that lies, a Stop that does nothing) | one view (the runtime aggregation) + one verb set (C14); the UI never optimistically updates — it renders the echo |
| Tool-allowlist weakening the exec bridge | `PI_WEB_TOOLS` remains the outer gate (C12); role filters only narrow further |
| Role-file frontmatter trusting (a role file claiming `bash` for a reviewer) | it only *selects from* the already-available tool set; `acceptanceRole: read-only` is a hard floor for that role kind |
| **Orphaned children + spend after a crash** (grok P2-9) | supervisor heartbeat; a parent that goes idle/WS-gone past its policy cancels the tree; child usage rolls into the parent's roll-up; peer sessions are GC'd with the parent or by TTL |
| **Two clients driving one child** (grok P1-4) | actor=parent on every mutating verb; child sockets observe-only; the UI renders the echo, never optimism |
| **Protocol change landing after the IDB cache exists** (grok P1-7) | `kind` is in the M0 commitment: metadata + every sync event, before any client stores a peer |
| Parent compact/rewrite/fork with a live child (grok P2-8) | refused with a reason (C22); a child may compact itself; forks carry lineage metadata only |

## Open questions (need a decision before M1)

1. Default roles to ship: my proposal is `reviewer`, `oracle`, `scout`, `worker`, `delegate`.
2. Model per role: inherit the parent's model (cheap, predictable) or per-role defaults (e.g. `oracle` on
   a stronger model)? Proposal: inherit, overridable in frontmatter.
3. Should the main agent be *told* to auto-review its own implementation (like the reference's "when you
   finish implementing, run a reviewer subagent")? Proposal: no prompt change; the user asks, or a
   project `AGENTS.md` says it.
4. Council (M4) in scope now, or after M3 proves the path?
5. Can the user **spawn a peer by hand** in v1 (panel `+`, pick a role + task), or is delegation always the
   model's decision? Proposal: allow it in M3 — it costs one WS verb and makes the feature useful even
   when the main agent is idle.
6. Should a **finished** peer be revivable ("continue this reviewer with a follow-up")? Proposal: not v1 —
   clicking a finished peer opens its transcript read-only; a follow-up is a new child with the previous
   report quoted (keeps the `subagent` row semantics honest).

## Appendix A — the stale branch

`feat/llm-peer-chat` (local only, never pushed, base `4cf48ee` 2026-10-23, **86 commits behind main**)
contains **no peer code** (`git ls-tree -r \| rg -i peer` → 0 files). Its 13 commits are the old
auth-gate/retry lineage: 6 are patch-identical to main (`git cherry`), 7 are superseded by main's
versions, and its `pr.md` is 87 lines *shorter* than main's. Nothing to salvage → delete or tag it as an
archive; this plan is written fresh against `main`.

## Review log

### 2026-10-31 — grok-4.6-high design review (arena, first pass)

Reviewed the *design document* (not code), asking specifically about peer-as-session consequences,
status/control truthfulness, caps/recursion, the tool-result contract, same-process concurrency, and
phase ordering. Verdict: *"Peer-as-session is the right persistence reuse for this stack, but it is not
buildable as a drop-in session without M0 wire contracts for visibility, status, and a supervisor that
sits outside both Agent loops."* Every finding is folded in:

| # | Sev | Finding | Where it landed |
|---|---|---|---|
| 1 | P0 | Unfiltered `session_created/updated` for every child spams the list, every socket and IDB; a client-side hide does not fix cache/search/`lastSession`/export/GC | **D10** + **C17**: `kind: "user"\|"peer"` on metadata AND every sync event, `listSessions(kind=user)` defaults, peers reachable by id only — committed in **M0** |
| 2 | P0 | In-memory runtime cannot answer "still running?" after a process death → phantom `running` | **D11** + **C18**: persisted `peer_started/ended/error` in BOTH journals, `peerStatus()` = pure f(journal, live map), boot reconcile answers dangling spawns with `aborted` |
| 3 | P0 | Same-process deadlock: parent `execute` awaiting a child while a hub/session lock is held; abort is the classic case | **D9** + **C19**: a `PeerSupervisor` owns promises/abort-tree/caps; the tool only `await supervisor.wait(peerId)`; no lock held across it; `cancel(tree)` with timeout → orphan→kill; proven with a re-entrancy-throwing lock |
| 4 | P1 | Two clients (parent strip, opened child) racing mutating verbs; retry doubling spend | **Status & control §Who may mutate what** + **C14/C15**: actor = parent, child sockets observe-only, retry = cancel + NEW peer id |
| 5 | P1 | Recursion/caps not enforceable by prompt; unbounded Agent graphs | **D8**: `maxDepth`/`maxConcurrentPerParent`/`maxConcurrentGlobal`/`maxChildTurns`/`maxChildTokens`, enforced BEFORE `new Agent`, budget persisted, over-budget = terminal error |
| 6 | P1 | "32 KB cap" underspecified (UTF-8 vs JS string, what gets cut); truncating a failure makes the parent retry blindly | **D12** + **C21**: frozen schema `{status, sessionId, role, model, usage, error?, summary, truncated}`; cap on UTF-8 `summary` only; structured fields as tool `details` |
| 7 | P1 | M0–M4 ordering hides risk until after the UI exists | **Phases** reordered: M0 model/visibility/status/caps (no UI), M1 spawn + result + reconcile, M2 control tree, M3 UI, M4 budget/`read_peer`, M5 council |
| 8 | P2 | Parent compact/rewrite/fork with a live child drops or duplicates the tool row; child compaction changes what a late open shows | **C22** + risk row: refused on a parent with live peers, child may compact itself, fork copies lineage metadata only |
| 9 | P2 | Orphans: peer JSONL forever, a crashed wait leaves a child still streaming (spend) | Risk row + **M4**: heartbeat, tree-cancel on the parent's idle/WS-gone policy, usage roll-up, GC with the parent or TTL |

Explicitly *not* adopted: nothing — all nine were consistent with the plan's goals. The reviewer's
"no issue" list (reusing JSONL + one Agent per session + hub frames for peers, one row back to the
parent, one verb vocabulary, server-side loop as the source of truth) matches the plan's own claims and
is unchanged.

## Implementation log

### 2026-10-31 — M0, M1, M2 landed (server-side, tested; the wire contracts are frozen from here)

| Milestone | Files | Tests |
|---|---|---|
| M0 model / visibility / status / caps | `lib/peer-roles.mjs`, `lib/peer-lifecycle.mjs`, `peer-supervisor.mjs` | `peer-roles` 33, `peer-lifecycle` 42, `peer-supervisor` 32 |
| M1 spawn + one-row result + reconcile | `agent-hub.mjs` (`spawnPeer`, `_runPeer`, `closePeerJournal`, `_reconcilePeers`, metadata `kind`/`peers`), `peer-tools.mjs`, `server.mjs` (`getTools(sessionId, meta)`, role dirs, `/api/peer/roles`) | `subagent.test.mjs` §S/§J/§R/§G/§T |
| M2 status + control | `agent-hub.mjs` (`peersOf`, `remainingPeerBudget`, `controlPeer`, `_parentOfPeer`, `_emitPeer`, the attach `peers` frame), `server.mjs` (WS `peers`/`peer`, REST `GET …/peers`, `POST …/peers/:peerId/:action`) | `subagent.test.mjs` §C, `subagent-server.e2e.mjs` 17 |

Every invariant the review demanded is pinned as a test: the lock-safety proof (a strict mutex plus a
parent abort while the child holds it — `peer-supervisor.test.mjs` §L), the honest status function
(`peer-lifecycle.test.mjs` §S), the caps (§B/§G), the frozen result schema (§R/§T) and the boot reconcile
in BOTH transcript shapes (`subagent.test.mjs` §R).

**Three deviations from this document, all deliberate:**

1. **The journal rides in the session METADATA (`metadata.peers[]`), not as extra JSONL lines.** Every
   reader of a session file assumes `line 0 = metadata, rest = messages` (`_writeSession`, `loadMessages`,
   the worker, `/range`), so non-message lines would break the storage contract. Same facts, survives a
   restart, no new parser. Bounded by `journalKeep` (50).
2. **`normalizeRestoredMessages` already strips a dangling `subagent` tool call at load** (pass 3 — a
   provider 400 otherwise), so the reconcile often has no call left to answer. It therefore ALWAYS fixes
   the journal (the phantom-`running` bug the review found) and writes the tool result when the call is
   still present. Both shapes are in the suite; the log line says which one happened.
3. **The child's own lifecycle is its session, not a second journal.** A peer's terminal state is its
   transcript's last message + the parent's journal entry, so `metadata.parentSession`/`peerRole` is all the
   child needs. Adding a per-child journal would be a second source of truth for the same fact.

**M3 (UI) also landed the same day:** `src/ui/peer-store.ts` (pure reducer, `tests/peer-store.test.mjs` 19),
`src/ui/peers.tsx` (`PeerStrip` + `PeerPanel`), `src/proxy-agent.ts` (the `peers`/`peer`/`peer-result` frames,
`onPeers`/`controlPeer`/`stopAllPeers`), a `↗ peer transcript` button on the `subagent` tool row, and the
`public/style.css` block (strip + right-hand sheet, bottom sheet on a phone).

**Still open:** M4 (`read_peer`, budget UX display, peer GC/TTL, user-spawned peers — the `spawn` WS verb does
not exist yet), M5 (council, arena-bridge peers). **Not yet verified visually:** the M3 UI was built and
typechecked, but the running `:8787` server predates this work, so seeing it needs a restart + reload (the
DOM/CDP check is the first thing to do after that).
