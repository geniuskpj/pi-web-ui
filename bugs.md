# bugs.md — open items only

**Scope (2026-10-25):** this file lists what is *still open*. The historical fix log (19 solved
incidents) was dropped: the fixes are in git, and the reusable material — vendored-code contracts,
debugging patterns, standing architecture decisions, incident lessons — moved to
[`docs/lessons.md`](docs/lessons.md). Re-check the contracts there on every upstream bump.

## Open bugs

_None known._ No open, reproducible defect is tracked at the moment. (Everything below is a known
limitation or a deferred item, recorded so it is not rediscovered as a "bug".)

### Verified open gaps from the 2026-10-28 external review (image policy)

Confirmed in code, not fixed yet — each needs a product decision, so they are listed instead of
patched silently. Neither is a crash; all three make the Settings → Data use *image* controls read
as stronger than they are.

| # | Verified behaviour | Evidence |
|---|---|---|
| I1 | **The image level never touches an attachment.** All four add paths paste the file's own base64: clipboard (`chat.tsx` `readAsDataURL`), picker (`GET /api/ws/file` → base64), import frames, steer recall. `planImageTransform()` (the pure planner the level feeds) has **no production caller** — only `plan-mobile-data.md` and the suite reference it, and `encodeForModel()` in `docs/client.md` is documented as *the function still to add* (`src/image-encode.ts`). So "Low"/"Auto" today only change the Settings description and the `imageLevel` field sent to the hub, which no server code reads (`lib/stream-reduce.mjs` keeps it in the cfg; nothing consumes it). | `src/ui/chat.tsx:1757-1759`, `src/ui/file-picker.tsx`, `src/ui/data-settings.ts:99-121`, no caller of `planImageTransform` outside docs/tests |
| I2 | **"Browser" retention does not keep images off the disk.** `_writeSession()` serializes `state.messages` **unredacted**, so any inline image lands in `<id>.jsonl`; `setMediaPersist(false)` only reaches the media store via egress redaction. Measured: session `337735bf…` has an image part with `keys=[data,mimeType,type]`, **718,740 chars ≈ 526 KB** of base64 inside the 735 KB session file, and that image is in no hash-addressed form. Desired: persist the redacted twin (+ `put` the bytes when retention is "server"), so the session file never holds base64 and a browser-retention session is recoverable only by the device that still has the bytes (the existing "N image(s) are no longer on the server — re-attach" note). | `agent-hub.mjs:422-444` (`_writeSession`), `agent-hub.mjs:868` + `:877` (`redactMessages`/`setMediaPersist` are egress-only), measurement above |
| I3 | **Retention is a process-wide flag set by one socket.** `case "setDataReduction"` calls `agentHub.setMediaPersist(m?.imageRetention !== "browser")` — a hub-level field, while the comment above says "for THIS connection only". Two devices with different retention end up with last-writer-wins for **every session**, and the value sticks after that socket closes. The other fields in the same message (`streamMode`, per-kind thresholds) are correctly per-connection. | `server.mjs:2565-2578`, `agent-hub.mjs:147-148`, `:876-880` |

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
