# Commit Review

**Scope:** `baff665..df1b4f4` (including the report, hardening, and server-side agent commits)  
**Review date:** 2026-10-21

## Findings

### P2 — Proxy target checks do not validate resolved IP addresses

**File:** [server.mjs](./server.mjs#L1297)  
**Confidence:** High

`proxyTargetBlocked()` rejects private and loopback IP literals and selected local hostnames, but ordinary DNS hostnames are allowed without checking their resolved addresses. `handleProxy()` passes those hostnames to `undiciFetch()` directly; the same hostname-only check is repeated for redirects. A hostname that resolves to a private, loopback, or link-local address can therefore reach an internal destination despite the new SSRF checks.

**Recommendation:** Resolve each destination before connecting, reject disallowed addresses, and pin the validated address for that request. Repeat this for every redirect hop and ensure the connection cannot perform a second, unvalidated DNS lookup.

### P2 — Runtime updates can be discarded as stale

**Files:** [agent-hub.mjs](./agent-hub.mjs#L104), [session-sync.ts](./src/session-sync.ts#L76)  
**Confidence:** High

`entry.seq` advances for agent events, while runtime-only changes (for example, queued-prompt state and attach/detach client counts) emit using the existing sequence. The client rejects any runtime frame whose sequence is less than or equal to the current one, so these updates are dropped once it has received a frame for that sequence. This can leave runtime UI details stale.

**Recommendation:** Give runtime deltas their own monotonically increasing sequence, or otherwise permit same-agent-sequence updates while still preventing older runtime frames from overwriting newer state.

## Verification

- `npm run typecheck` — passed.
- `npm run test:security` — passed (31 checks).
- `npm run test:edit` — passed (7 checks).
- `npm run test:store` — passed (7 checks).
- `git diff --check` — passed.

No files were changed as part of the reviewed commits. This report is a separate review artifact.
