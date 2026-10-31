# bugs.md — open items only

**Scope (2026-10-25):** this file lists what is *still open*. The historical fix log (19 solved
incidents) was dropped: the fixes are in git, and the reusable material — vendored-code contracts,
debugging patterns, standing architecture decisions, incident lessons — moved to
[`docs/lessons.md`](docs/lessons.md). Re-check the contracts there on every upstream bump.

## Open bugs

_None known._ No open, reproducible defect is tracked at the moment. (Everything below is a known
limitation or a deferred item, recorded so it is not rediscovered as a "bug".)

## Known limitations / deferred

| Item | Why it is acceptable for now |
|---|---|
| A rewrite starts an EMPTY IDB generation | Prefix survival would need the surviving chunks copied into the new generation; rewrites are rare and the old generation is simply re-fetched. (`pr-idb.md` §Review-log #15) |
| No list virtualization for a fully expanded 7.3MB session | Separate UI project; the one-turn display gate keeps the DOM small in practice. (#16) |
| brotli for ranges / CBOR / gzip-at-rest / zstd | Deferred **by measurement**: gzip already puts the warm path at 0 requests, and the cold path is dominated by the attach tail. (§2/§6) |
| `coverageFor()`/`idbStats()` do a full-store `getAll()` | The meta store holds ONE record per generation, so it is tiny; a real index needs a schema v3 bump. (#9) |
| Mobile decode numbers are desktop-derived | Needs a real device (PL-12). Not closable from a desktop. (#18) |
| A single message larger than the 1MB range cap | The attach tail never snaps to 0 (that would turn a tail into a full attach), so such a session opens on the pipe... a partial window instead of a full one. |
| REST model discovery for the provider catalog | The builtin catalog is offline + key-free; discovery needs a key and network. (§PR-2 #4) |

## Operational notes (environment, not code)

- **The terminal's msys pty bridge can be unavailable on a machine whose Git install cannot
  allocate a pty** (`/dev/ptmx: Too many open files`, `script.exe: failed to create
  pseudo-terminal`). The hub now `bridgeProbe`s every candidate and falls back to Windows ConPTY
  (`conhost --headless`), which is unaffected — nano/vim work through it. Diagnosis + the
  environment evidence (16.8M kernel event objects, 144 leaked `conhost`, 130 leaked `bash` from
  hard-killed servers, 293-day uptime) are in `pr-idb.md` §9 #12.
- **A hard-killed server orphans its terminal shells and consoles** (`taskkill /F` skips the hub's
  reap). Proposed, not implemented: record spawned pids and reap orphans at boot (image-verified:
  `bash`/`conhost`/`script.exe` only). Until then, shut the server down gracefully.

## Pending repo work

- `feat/atomic-writes-sha` (the `expectedSha`/atomic-write tool contract, 4 commits) is **not** in
  `main`; it is verified and rebased, waiting for a landing decision.

## Recently closed (kept one release, then pruned)

### 2026-10-31 — pre-restart grok review of the peers + image work (2 packets, 2 P0s + 9 P1/P2s)

Reviewed the whole delta (2cc7813 → HEAD) before the server restart. Everything actionable is fixed; the
restart is cleared (with one migration caveat, below).

| Sev | Area | Was | Now |
|---|---|---|---|
| **P0** | `peer-supervisor.mjs` | a wall-clock timeout or a cancel only called `abort()`; a runner that ignored it (a wedged tool — the LFP shape) left `wait()` pending forever, so the parent's tool call dangled and the record stayed in the maps. `CANCEL_GRACE_MS` was exported and never used | a force-settle races the runner: after the grace the promise resolves with `aborted`/`timeout` + reason, the record leaves the maps, and a later `wait()` replays it. `sweep()` now reads `controller.signal` (it read a field that never existed) and settles. `tests/peer-supervisor.test.mjs` §F |
| **P0** | `peer-tools.mjs` | the `run` path had no `catch`: a `wait()`/journal throw rejected the tool → the parent transcript kept a tool call with no result (the exact invariant the module claims) | the last line of defence returns one `error` result for ANY throw; the abort listener also fires when the signal is already aborted |
| P1 | hub, `attach` | **found by the new e2e check**: the WS attach snapshot (and frames buffered during it) bypassed redaction, so inline image base64 went back to every device and into its IDB cache | `attach` funnels every delivered frame through `redactFrame`; `media-egress.e2e` §E7 asserts no base64 in any attach frame |
| P1 | retention vs snapshot order | the client's settings frame arrives only after `state`, so the first attach of an imaged session wrote blobs to disk before a "browser" device was heard | the client sends `imageRetention` **with** the attach and the server applies it before the snapshot; `media-egress.e2e` §E7b (no blob written) |
| P1 | `lib/peer-roles.mjs` `toolsForRole` | the read-only floor returned EVERY non-mutating tool, so a role asking for `read_file` alone also got `fetch` and the whole extension surface | intersect the declared list FIRST, then apply the read-only floor; a peer whose role cannot be resolved gets `read_file` only; `peer-roles` §T2b/T2c/B3b |
| P1 | `agent-hub.mjs` `hydrateImages` | lost the `isMediaHash` check the old prompt path had (the store also guards, so no traversal, but a user string reached a lookup) | hash shape validated before the store; `hub-hydration` still green |
| P1 | `agent-hub.mjs` `_buildMetadata` / `_peerEmitAt` / `lib/versions-sidecar.mjs` | `kind: "user"` was written into EVERY session header; the peer-emit rate map and the version append chains grew per session id forever | `kind` only for peers; both maps pruned on discard/evict/completion |
| P1 | `agent-hub.mjs` `getSession` | `if (role) entry.retention = entry.retention;` was a no-op — a child of a "browser" session persisted under the process default | a peer inherits its parent's retention |
| P1 | `lib/peer-lifecycle.mjs` | summary truncated twice (the marker could be re-cut on the second pass; `details.summary` truncated for failures too); the leading ellipsis sat outside the byte cap; `error` was uncapped | one truncation in `resultText`, budget covers marker+ellipsis, error capped at 4 KB; `peer-lifecycle` §C |
| P1 | client | the peer panel's second `ProxyAgent` could prompt/steer/abort the child; `send()` could still drop an in-flight upload after its 15 s wait; concurrent pastes all saw `prev.length === 0` and could all fail past the cap | `observeOnly` mode (mutating frames refused), a still-uploading send is refused with a note, the image slot is reserved synchronously; `data-reduction` §I1d3/I1d4, `peer-store` §D4b |
| P2 | misc | role catalog printed half-built rows for unreadable files; unbounded `task`/steer text; strip ticked at 1 Hz with no peers | reported as errors, capped at 32 KB/8 KB, tick only while something runs |

**Restart caveat (unchanged, now explicit):** the first persist of a session that holds INLINE images
rewrites it to hash-only — a one-way migration. The bytes remain in `data/media/<hash>`, but the previous
commit cannot read hash-only parts, so a rollback of such a session would need the JSONL restored from
backup or the images re-attached. Sessions without images, and attach-only traffic, are rollback-safe.


### 2026-10-31 — copilot review (5 findings, all confirmed and fixed)

| # | Where | Was | Now |
|---|---|---|---|
| 1 | `lib/media-egress.mjs` | `persisted` was computed from `dir && persist` BEFORE the write, so a failed write (read-only dir, ENOSPC) left an entry claiming a disk copy — and `evict()` drops persisted entries first *because they can be re-read*, so the image could vanish while `/media` 404s | `persisted` is set only after `writeFileSync` returns; `tests/data-reduction.test.mjs` §L15c–e blocks the shard path with a file and asserts memory-only honesty |
| 2 | `lib/provider-models.mjs` | a discovered id inherited `api`/`baseUrl` but not the template's `headers`/`compat` (the doc comment claimed otherwise), so on nvidia (`NVCF-POLL-SECONDS`) or a provider needing `compat` it was selectable and failed on its first request | both are copied; per-model numbers (`maxTokens`) deliberately are not — `tests/provider-models.test.mjs` §D1–D7 |
| 3 | `src/ui/chat.tsx` (find) | clearing the query cleared the hits but did NOT abort the in-flight search, whose late response repopulated a hit list for an empty box | clearing aborts the request and resets the generation/source markers; `tests/session-search.test.mjs` §UI-1/2 |
| 4 | `agent-hub.mjs` (`_runPeer`) | usage was accumulated from every event that carried `usage` — `message_end` and `turn_end` carry the SAME assistant message, so a child's tokens were double counted and its token budget tripped early | usage is derived from the child's MESSAGES (the app's own UsageBar convention), once per assistant message; `tests/subagent.test.mjs` §T5 |
| 5 | `lib/peer-lifecycle.mjs` + `agent-hub.mjs` + `peer-tools.mjs` | a completed peer's view had no child session id (the journal entry never stored it and `peerView` never mapped it), so its transcript could not be opened and `retry` had no session to address; and the tool result carried only `sessionId`, while the UI's transcript link and every control verb address a peer BY `peerId` | the journal records the child id as soon as it exists, `peerView` maps it, and `peerId` joins the frozen result schema; `tests/subagent.test.mjs` §J2b/J3b/J3c/T4 |


### 2026-10-28 — image policy (external review I1 · I2 · I3)

All three verified gaps are fixed in one pass (details: `docs/client.md` §image pipeline,
`docs/server.md` §Image retention):

| # | was | now |
|---|---|---|
| I1 | the image level only changed the Settings label; every add path pasted the file's own base64 and `planImageTransform()` had no production caller | `src/image-encode.ts` (`encodeForModel` + `uploadImage`) and ONE funnel in the composer: decide → capped decode → plan → webp/jpeg → upload → send `{hash, bytes}`. `tests/data-reduction.test.mjs` §I1 |
| I2 | the session file got `state.messages` verbatim, so images sat on disk as base64 (526 KB measured) no matter what retention said | `_writeSession()` persists the redacted twin (bytes → media store under the session's retention); `_ensureEntry()` hydrates at load; `hub.hydrateImages()` serves retry/fork. `tests/hub-hydration.test.mjs` §I2 |
| I3 | retention was one process-wide flag assigned by the last socket to attach | per session, per attached requester (`setMediaRetention`/`clearMediaRetention`), strictest wins, sticky per session. `tests/data-reduction.test.mjs` §I3 |
