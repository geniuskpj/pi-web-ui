# Plan — retry hardening, mobile multi-line edit, transfer reduction

**Branch:** `feat/retry-mobile-transfer` (from `feat/auth-gate-retry`)
**Three workstreams, independent milestones — retry bugs first (user: "retry still has bugs").**

## A. Retry bugs (fix-first)

**A1 (confirmed open, reviewer1 #3). `setAutoRetry({enabled:false})` doesn't cancel
already-scheduled retries.** `setAutoRetry()` only replaces `this.autoRetry`;
`entry.retryTimer`s keep running and the callback calls `this.retry(…, {reason:"auto"})`
without rechecking `enabled`. Disabling during a 30s `Retry-After` wait still fires.
- Fix: `setAutoRetry` iterates `this.sessions` and calls `_cancelAutoRetry(entry)`
  when disabled (also resets `retryNote`); the timer callback re-checks
  `this.autoRetry.enabled` before firing, and `_maybeScheduleAutoRetry` already
  gates on it at schedule time.
- Test (tests/retry.test.mjs): schedule via faux-provider error → `setAutoRetry({enabled:false})`
  before the timer fires → no retry, no attempt burn, `retryNote` cleared.

**A2. Attempt-burn races.** The timer fires into `retry()` which can refuse
(`compaction in progress`, `a run is already streaming`) — the attempt was already
incremented at SCHEDULE time, so a refusal burns one of 3 attempts for nothing.
- Fix: increment `retryAttempts` only when the retry is actually dispatched
  (move the increment from schedule to the timer callback after the guards), and
  re-check `discarded`/`compacting` in the callback.

**A3. Stale `retryAttempts` across attach.** `retryAttempts`/`retryNote` are
entry-memory only; a hub restart mid-give-up silently re-arms 3 fresh attempts.
Acceptable (documented) — but the RETRY-NOTE should survive: persist
`retryNote` in the mirror metadata (`retryNote` field) so the UI note survives
a restart, and reset `retryAttempts` only on success/user action (already true).

**A4. Retry × editCommit interaction (audit).** `retry()` drops the failed tail;
an ✎ edit that 429'd keeps its parked version (documented ✓). Verify the reverse:
an edit COMMITTED while an auto-retry timer is pending → `editCommit` bumps
`mutateEpoch` — `retry()` must refuse on epoch mismatch like prompts do
(currently it does NOT check mutateEpoch → a stale auto-retry could re-run
against a transcript that was just edited/truncated). Add the epoch check +
a test.

**A5 (user report 2026-10-24, FIXED — `retry` wiped the toolcall + thinking).**
After a 429 that killed the run mid-tool-round, clicking Retry deleted the whole
turn back to the user message. Chain: the dangling toolCall was stripped by the
protocol repair → the transcript ended on an ASSISTANT tail → `canContinue`
(user/toolResult only) refused → the RESEND fallback truncated to the user turn.
Fix (two parts in `_dropFailedTail`): (1) REPAIR v2 — synthesize an interrupted
`isError` toolResult per dangling call instead of stripping, so the turn stays
protocol-valid AND `continue()`-able (thinking + tool round survive; the model
re-plans); (2) pop the DEAD-END assistant (toolUse, no calls — already stripped)
so retry continues from the user turn instead of resending. Tests: retry 31 → 40
(mid-round death + dead-end variant, both mode=continue).

## B. Mobile multi-line edit

Current inline editor is already Enter=newline / Ctrl+Enter=submit / Resubmit
button — but on a phone: no Ctrl, cramped card, keyboard covers the buttons.

1. **Mobile editor sheet** (`<48rem`): the edit card becomes a bottom sheet —
   full-width, sticky action bar (Resubmit / Cancel) rendered ABOVE the soft
   keyboard using `visualViewport` resize events (scroll the card into view on
   keyboard open; iOS safe-area padding).
2. **Tap targets ≥44px** for Resubmit/Cancel on coarse pointers; the ✎ trigger
   gets a larger hit area on touch (`@media (pointer: coarse)`).
3. **Enter=newline stays** (already correct for an editing context); the
   Resubmit button is the only submit path on touch — label + tooltip
   already say so.
4. **Focus/scroll**: on open, `scrollIntoView` the card after the keyboard
   animation (250/800ms re-stick reuse from the session-open logic).
5. **PL-12 carry-over**: verify on a real Android Chrome + iOS Safari
   (`?session=…#token=` flow included) — the only test this repo cannot run
   from the dev machine.

## C. Reduce file/data transfer (compress first, IDB second)

**C1. WS permessage-deflate (biggest win, one option).** `/ws/sync` + `/ws/agent`
transports are JSON (multi-MB attach snapshots, full-transcript session frames).
`new WebSocketServer({ perMessageDeflate: { threshold: 1024, zlibDeflateOptions:
{ level: 6, memLevel: 8 } } })` — measured JSON transcript compression is
typically 70–90%. Cost: server CPU per frame; threshold keeps tiny runtime
deltas uncompressed. Gate behind `PI_WEB_WS_DEFLATE=off` escape hatch + a
size benchmark in the killstop/steer e2e (assert the attach snapshot shrinks).

**C2. HTTP gzip for the big GETs.** `/api/agent/session/:id` (4.5MB observed)
and `/api/sessions`: hono/compress or manual gzip with `Accept-Encoding`
handling. Same benchmark assertion.

**C3. Local cache (IDB — optional, scoped).** localStorage caps the client
cache (~10MiB origin; the server-first overflow already routes big bodies to
`bodyLocation:'server'`). IDB would lift the local-cache quota — but IDB
wedged on this machine historically (the reason LocalStorageBackend exists).
Decision: compression (C1/C2) reduces the WIRE; the LOCAL quota problem is
already solved by server-held bodies. IDB is therefore **parked** unless a
real offline-browsing need appears; if pursued: behind
`PI_WEB_CACHE_BACKEND=idb`, opt-in, LocalStorageBackend stays the fallback.

**C4. Incremental sync (later).** Attach snapshots are full transcripts; a
seq-cursor + tail-delta protocol would cut reconnection payloads — only if
C1/C2 leave reconnections still slow on mobile.

## Milestones
1. A1+A2 (+A4 epoch check) + tests — retry hardening commit.
2. C1+C2 + benchmark — transfer commit.
3. B mobile editor sheet + PL-12 device checklist.
4. A3/C3/C4 as follow-ups with the decisions recorded.
