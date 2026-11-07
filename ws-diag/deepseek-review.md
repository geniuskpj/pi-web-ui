# deepseek review — deepseek-ai/deepseek-v4.1-flash (nvidia)

_1802s · 13 in / 26359 out tokens_

Reviewing only what the code does. Findings are ordered by severity; each names the function and the concrete failure.

---

**[P1] `stop-all` can never succeed — `peer-tools.mjs` `makeSubagentTool.execute` + `agent-hub.mjs` `controlPeer`**

Scenario: the model calls `subagent({action:"stop", all:true})`. The tool does `controlPeer(parentSessionId, String(params?.peerId || ""), "stop-all", …)` — `peerId` is `""`. In `controlPeer`, `this.peers.parentOf("")` → `null` and `this._parentOfPeer("")` → `null`, so the early guard `if (!parentId || !parent || !journalEntry) return { ok:false, reason:"unknown peer" }` fires before the `action === "stop-all"` branch is reached. The tool then returns `could not stop: unknown peer` while every peer keeps running. The `stop-all` branch in `controlPeer` is dead code reachable only if a caller passes a real `peerId` with `all:true`.
Smallest fix: branch on `action === "stop-all"` before resolving a single peer, using the actor id directly: `if (action === "stop-all") { const touched = this.peers.cancel(actorSessionId, { treeWide:true, reason:"stopped by the user" }); return { ok:true, stopped: touched.length }; }`.

---

**[P1] Reconcile treats LIVE peers as dead — `agent-hub.mjs` `_reconcilePeersInner`**

The function requires the session to be in memory (`const entry = this.sessions.get(sessionId); if (!entry) return 0;`) and then calls `danglingSpawns(entry.peerJournal || [], { liveIds: [] })`. `danglingSpawns` (`lib/peer-lifecycle.mjs`) filters `!p.endedAt && !live.has(p.peerId)`; with `liveIds` empty, every non-ended spawn is "dangling".
Scenario: a session with a running peer is reconciled (attach/reconnect while the peer runs). The open `subagent` toolCall is still unanswered, so `openCalls` contains it and the code pushes a `toolResult` with `error:"the server restarted while this peer was running"` into `entry.agent.state.messages`, and rewrites the journal entry to `aborted` — while the peer is still running and will deliver its own result via `wait()`. That is **two tool results for one `toolCallId`**, the exact dangling/duplicate-result failure the whole design guards against. It also makes the journal lie (aborted, then `closePeerJournal` overwrites it with the real status).
The supervisor already exposes a live-aware helper the hub does not use: `dangling: (parentId) => danglingSpawns(journalOf(parentId), { liveIds: [...records.keys()] })`.
Smallest fix: `const dangling = this.peers.dangling(sessionId);` in `_reconcilePeersInner` (or pass `liveIds: [...records.keys()]`).

---

**[P1] `stop`/`steer`/`retry` can reject and produce NO tool result — `peer-tools.mjs` `makeSubagentTool.execute`**

The `run` path is meticulously wrapped (`try { await wait(...) } catch { return buildPeerResult({status:"error"}) }`). The control branch is not:
```js
if (action === "stop" || action === "steer" || action === "retry") {
  const r = await hubRef().controlPeer(...);   // no try/catch
```
Scenario: `controlPeer` → `await this.steer(childId,…)` or `await this.retry(childId,…)` rejects (e.g. the child session id in the journal is stale/gone). The exception propagates out of `execute`, so the parent's tool call never gets a result — the same "next provider call fails on a dangling tool call" outcome the `run` catch exists to prevent.
Smallest fix: wrap the control branch in `try/catch` and return `buildPeerResult({ status:"error", error: String(err?.message||err) })` on throw.

---

**[P2] Force-settle downgrades a budget stop to `aborted` — `peer-supervisor.mjs` `spawn` (race handler)**

`noteUpdate` cancels an over-budget peer with `cancelOne(peerId, { reason: runBudget.reason, status: "error" })`, and `forceAfter` forwards that status. But the forced branch hard-codes:
```js
record.status = out.status === "timeout" ? "timeout" : "aborted";
```
Scenario: a runner that ignores its signal trips `maxChildTurns`/`maxChildTokens`; the grace timer fires with `status:"error"`, and the parent is told `aborted:` with the budget reason instead of `error:`. (With a signal-respecting runner the normal path yields `"error"` correctly, so this is only the wedged case.)
Smallest fix: `record.status = ["timeout","error","aborted"].includes(out.status) ? out.status : "aborted";`.

---

**[P2] `retry` is not atomic across two clients — `agent-hub.mjs` `controlPeer` (`action === "retry"`)**

The only guard is `if (this.peers.has(peerId)) return { ok:false, … }` — i.e. "a *live* peer". After a peer finishes, `records` no longer holds it, so `has` is false.
Scenario: two clients attached to the same parent session both issue `retry` for a finished peer; both pass the `has` check and both call `this.retry(childId)`, prompting the same child session twice — the comment "retry must never double the spend" is not enforced by the code.
Smallest fix: add a per-peer in-flight latch (e.g. an `retrying` set around `await this.retry`) that the second caller sees.

---

**[P2] The depth cap is inert and `kind: "peer"` is never set — `peer-supervisor.mjs` `spawn` / `lib/peer-lifecycle.mjs` `checkPeerBudget` / `agent-hub.mjs` `_runPeer`**

`spawnPeer` defaults `depth = 0` and the tool never passes `depth`, so `checkPeerBudget`'s `s.depth >= limits.maxDepth` (maxDepth 1) never fires. The real block is `spawnPeer`'s `if (parent.kind === "peer") return { ok:false }`, but `_runPeer` creates the child with `{ role: peer.role, parentSession: peer.parentId }` and **no `kind`**. If the hub does not derive `kind` from `role`, that guard is also dead, leaving only the tool-list narrowing.
Smallest fix: set `kind: "peer"` where the child is created (and/or pass the parent's depth), or delete the unused `depth` plumbing so the guard is not misread as active.

---

**[P2] The read-only floor is a name allowlist — `lib/peer-roles.mjs` `toolsForRole` / `MUTATING_TOOLS`**

`if (role?.acceptanceRole === "read-only") return declared.filter(n => !MUTATING_TOOLS.includes(n))`. The floor is exact-name matching against a hard-coded list (`write_file, edit, bash, subagent, terminal, exec, task`).
Scenario: a hand-edited read-only role declares a mutating tool whose registered name is not in that list (e.g. `write`, `apply_patch`, `run`); it survives the floor.
Smallest fix: drive the read-only set from the tool registry's mutating metadata, or fail closed for `read-only` (keep only a known read allowlist such as `read_file`, `rg_search`, `find_file`, `ls`).

---

**[P2] `sweep()` has no visible caller — `peer-supervisor.mjs` `sweep`**

The docstring says it settles a cancelled peer "FOR REAL", but within the reviewed files it is only returned, never invoked; server.mjs is not shown to schedule it. Because `cancelOne` already schedules `forceAfter(status, reason, CANCEL_GRACE_MS)`, a cancelled peer is still bounded at ~5 s without `sweep`, so this is a note, not a wedge: confirm the caller exists or delete the function so the "immediate settle" claim is not assumed.

---

**[P2] Truncation marker over/understates the elision — `lib/peer-lifecycle.mjs` `truncateUtf8`**

The marker reports `${total - maxBytes} … elided`, but the emitted tail is `budget = maxBytes - markerBytes - 3` bytes and the result is `"…" + marker + tail`. Since `markerBytes + 3` bytes are consumed by framing, the amount actually dropped is `total - budget`, i.e. slightly more than reported. Byte-cap safety is fine (3 + marker + tail ≤ maxBytes) and it is idempotent (output ≤ maxBytes returns as-is); only the annotation is approximate.

---

Coverage of the remaining questions, no findings:
- **Q1 (other legs):** abort/timeout routes both go through `cancelOne` → `abort()` + `forceAfter`; `usageOf()` in `_runPeer` walks the child's messages (not event sums), and `noteUpdate` *replaces* `rec.usage` rather than accumulating, so tokens are not double-counted; `records`/`tree` are deleted in the settle `finally`, `settled` is capped at 50. No leak/double-count beyond finding D/G.
- **Q2 (run path):** `execute` returns exactly once on every `run` branch (bad role, empty/oversized task, refused spawn, `wait` result, `wait` throw). The only two-result / no-result risks are findings B and C.
- **Q4:** `peerStatusOf` correctly reports `needs_result` for a non-ended, non-live entry, and `wait()` falls back to `settled` then the journal; `closePeerJournal` keeps the child `sessionId`. Truthful, given finding B is fixed.
- **Q5 (model spec):** `toolsForSession` keys off `meta.role`/`meta.kind` only — there is no code path in the reviewed files where `model` affects a child's tool list.
- **Q6 (concurrent spawns):** `checkPeerBudget` + `countLive` are synchronous inside `spawn`, and the hub appends the journal synchronously after, so N calls in one turn are counted sequentially — correct. Parent-abort is wired (`onAbort` → `cancel`, plus the pre-aborted-signal check).
- **Q7 (child corruption):** the child is only touched by normal session machinery plus `retry`; the corruption vectors reduce to the non-atomic `retry` (finding E).
- **Q8 (contract):** `truncateUtf8` is UTF-8-boundary-safe and idempotent; failures are returned untruncated with the reason; usage is built once in `buildPeerResult`. Only the marker annotation (finding I) is off.

---

**Verdict:** solid, mostly-bounded lifecycle, but not shippable as-is: fix `stop-all`, the reconcile `liveIds: []` (it can double-write a tool result), and the unguarded `stop/steer/retry` branch first.
