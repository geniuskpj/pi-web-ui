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
