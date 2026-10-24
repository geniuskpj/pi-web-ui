# PR — auth-gate retune + retry-at-failure-point

**Branch:** `feat/auth-gate-retry` · **Base:** `main` (`2f91d52`) · **Commits:** 8 · **Diff:** 23 files, +1385 / −169
**Status:** open, **not pushed** (see *Before pushing* below) · **Owner:** agent session 2026-10-23
**Review log:** see the bottom of this file (append-only — add new entries at the end)

> This file is the PR record because the repo is developed locally without a GitHub remote workflow.
> Review comments are appended in the *Review log* section; do not rewrite past entries — add a new
> dated one (or a "response" block under the finding).

---

## 1. Summary

Two user-reported incidents, both reproduced with evidence before touching code, plus a CI repair that
fell out of the investigation:

1. **Opening the UI on a DDNS domain showed no sessions.** Requests arrived non-loopback, *passed* the
   token gate, then died at the DNS-rebinding Host/Origin allowlist (403) — the token was irrelevant,
   and the client only reacted to 401, so the failure was completely silent (empty list, no message).
   Live evidence: 38 `[ws] 403 upgrade rejected … (not in Host allowlist)` lines for the user's DDNS
   name; a TLS reverse proxy could *never* satisfy the gate (entries stored `name:PORT`, the Origin's
   host is portless).
2. **Retry after a 429 re-sent the user prompt**, producing a duplicate user turn; for server-side
   sessions the "repair" happened in the browser against a mirror the server never reads.
3. **CI was red on every matrix row** (not just node 18): npm 9/10 silently ignore `overrides` entries
   that use `file:` specifiers, so the six stubbed provider SDKs resolved to the real packages and
   esbuild followed them into a missing transitive dep (`@opentelemetry/api`).

After the first implementation round the PR was adversarially reviewed (grok-4.6-high) and **two of
the changes were found to be regressions** (port-insensitive matching; loopback token exemption still
peer-only). Both are fixed — see *Review log*, and the invariants in §3 are the post-review state.

## 2. Commits

| Commit | What |
|---|---|
| `20a7865` | Auth gate retune: hostname matching + `PI_WEB_ORIGIN_GATE=auto\|strict\|off` + WS-only query token |
| `4b0a8c2` | Client: 401/403 surfacing (banner + dialog note) and share links via URL fragment |
| `c90a4fe` | Docs: `PI_WEB_TERM_ORIGIN` scope, gate modes, custom-domain recipe |
| `81b5ccf` | CI: npm 9/10 `file:`-override fix (esbuild alias + assertion) and a workflow that actually tests |
| `3cd3552` | Retry at the failure point + auto-retry (3 × 3 s, transient-only) |
| `cd4fb80` | `bugs.md`: retry pattern, faux-provider harness, splice-edit lesson |
| `16f798b` | Docs drift: `client.md` still documented the old retry; `architecture.md` always-token list was wrong; `terminal.md` |
| `361746a` | **Review fixes:** exact `host:port` matching (scheme-default port), local-Host token rule, share links removed, GET/HEAD-only 401 replay, build-time stub proof, Retry-After + jitter |

## 3. Behaviour after this PR (the invariants a reviewer should check)

**Auth / origin gate (`server.mjs`)**
- `ALLOWED_HOSTS` holds **exact `host:port`** entries (localhost, `127.0.0.1`, `[::1]`, `os.hostname()`,
  non-internal interface IPs at the app port, plus `PI_WEB_TERM_ORIGIN` extras; portless extras get the
  app port). `LOCAL_NAMES` is the *names that mean this machine* subset and is used **only** by
  `isLocalHost()` — never for matching.
- Matching is exact. A missing **Origin** port = the **scheme default** (http→80, https→443); a portless
  **Host** (what a proxy forwards) is tried as the app port plus 80/443 (`hostCandidates()`). So a TLS
  proxy works by declaring its public form (`PI_WEB_TERM_ORIGIN=name:443`) while
  `Origin: http://localhost:3000` from another local app stays **rejected**. Malformed Origin fails
  closed; no suffix/`includes` matching (`localhost.evil.com` is rejected).
- `authorized()`: a **loopback peer is trusted only when it names a LOCAL host** — a local reverse proxy
  makes the peer loopback while serving a public name, and that path must present the token. Gate mode
  never changes this.
- **Order:** origin gate first, then the token gate — loopback + foreign Host still reports 403
  (rebinding), loopback + allowlisted public name falls through to 401 without a token.
- `PI_WEB_ORIGIN_GATE=auto|strict|off` (default `auto`): `auto` = the allowlist applies to **loopback
  peers only** (a remote peer that presents the token may use any hostname — this is what makes a DDNS
  name work with zero config); `strict` = every peer; `off` = disabled with loud boot warnings.
- `?token=` query form: **`/ws/*` upgrades only** (WS cannot set headers). Plain HTTP must send the
  header. Reject logs print the **path** (never the query string).
- Always-token, in every mode: `POST /api/exec/tool`, `GET /api/pi/keys`, `GET /api/ws/file`.
  `isLoopback()` uses the socket peer only (`X-Forwarded-For` never consulted).
- The terminal hub receives the **same rule as a predicate** (`originAllowed`), so the two checks cannot
  drift.

**Client**
- `src/server-auth.ts` owns the fetch patch: attaches the token and classifies replies into
  `ok | no-token | bad-token | host-blocked | offline`; the App shell shows a persistent amber banner
  (Retry + Settings) and the session dialog shows an inline reason. A 401 **replays only GET/HEAD**
  (re-issuing a POST could double-execute a tool); other methods say "token saved — press again".
- The token is a **Settings credential** (`localStorage pi.webToken`). It is **never read from the URL**;
  URL share links were removed deliberately (a `#token=` link hands whoever opens it full control).

**Retry / auto-retry (`agent-hub.mjs`, WS `retry` / `set-auto-retry`)**
- `hub.retry(id)` drops the trailing failure artifacts (assistant `stopReason` `error`/`aborted` plus
  toolResults orphaned by them, repairing a dangling `toolCall`) and calls pi-agent-core's
  `agent.continue()`: the failed model call is re-issued against the **same** transcript → the user turn
  appears exactly once and completed tool calls are **not** re-run. Fallback (tail is an assistant
  message) re-sends the user turn, dropping it first so it is never duplicated. `dropped === 0` refuses
  (`nothing to retry`) — a healthy turn can never be regenerated. Versions are untouched, so an ✎ edit
  whose resubmit 429'd keeps its parked delta and the retry continues the edited turn.
- Auto-retry: `setAutoRetry({enabled, attempts=3, delayMs=3000})` (client setting, default ON, pushed on
  every attach). Only transient failures are retried — 429/rate-limit/quota/overloaded, 5xx,
  ECONNRESET/ETIMEDOUT/"fetch failed"/socket hang up — never auth (401/403/invalid key) or context
  overflow. A provider `Retry-After` is honoured (bounded 30 s) with jitter. The counter resets on
  success or any user action; timers are cancelled in `abort`/`prompt`/`editCommit`/`discard`/`shutdown`.

**Build / CI**
- `build.mjs` aliases the six provider SDKs to `stubs/empty/index.cjs` and **proves it**: a static check
  that every name is aliased, a content check that any provider module in the bundle *is* the stub, and
  "at least one stub reached the bundle". Negative-tested (removing the alias fails the build).
- `.github/workflows/ci.yml` (replaces GitHub's `NodeJS with Webpack` template): node **22 + 24** ×
  ubuntu + windows, `npm ci` (lockfile-pinned) → `typecheck` → `build` → hermetic suites
  (`test:store`, `test:runtime`, `test:ssrf`, `test:retry`, `test:security`). `engines: {node: ">=22"}`.
  Real-LLM suites and the pty/bash-dependent ones stay local.

## 4. Tests & evidence

| Suite | Result | Notes |
|---|---|---|
| `npm run test:security` | **64 checks** | loopback rebinding rows; the new rows run from a **real non-loopback peer** (connect via the LAN IP): 401 without token, 200 with it on any domain Host, `?token=` refused on HTTP, `X-Forwarded-For` ignored, WS 101/401; other-port Origin/Host → 403; portless `:443` proxy form; `strict`/`off` incl. token independence |
| `npm run test:retry` | **31 checks** | hermetic via pi-ai's **faux provider** (scripted `stopReason:"error"`): resume-at-failure-point, error gone, user turn once, tool not re-run, partial-content error, auto-retry success + give-up + Retry-After, non-retryable classification, edit-version survival, refuse-when-healthy |
| others | green | store 7 · runtime 6 · ssrf 5 · versions 24 · compact 19 · fork 23 · shutdown 9 · term-smoke 12 · `typecheck` · `build` |
| live (after a restart) | verified | `Host: <ddns-name>:8787` + token → 200 (was 403); WS sync/agent → 101; the real DDNS path over the internet → 200 with the session list; loopback + evil Host → 403 |
| CI simulation | green | clean clone, exact workflow steps, node 22 + npm 10 → 8/8; node 24 + npm 11 → ok |

Reproduction scripts live in the gitignored `data/tmp/` — `domain-access-repro.mjs` (header matrix),
`proxy-shape-probe.mjs`, `remote-peer-probe.mjs` (real non-loopback peer), `origin-additive-probe.mjs`,
`verify-gate.mjs`, `verify-always-token.mjs`. They boot scratch servers on random ports with a temp
`data/` dir, so they never touch a running server or real sessions.

## 5. Ops notes

- **A server restart is required** for the server-side changes (auth matching, token rule, retry ops).
  The client bundle is served from the manifest per request, so a browser reload picks up the new UI.
- New env var `PI_WEB_ORIGIN_GATE` (default `auto`); `PI_WEB_TERM_ORIGIN` now documents its real scope
  (global) and wants the **public port** for a TLS proxy (`name:443`).
- For users on a DDNS name: nothing to configure with `auto` — enter the token once in Settings.
- `PI_WEB_ORIGIN_GATE=off` is a documented foot-gun (boot warnings; foreign-Host loopback callers still
  need the token).

## 6. Known gaps / open items (deliberately NOT in this PR)

- **Before pushing:** the two ~4.5 MB session transcripts accidentally committed on `main`'s unpushed
  range (`ed84e40`, `ffb3c63`) must be stripped (history rewrite) — this branch inherits them.
- Scoped **read-only token** for sharing (today the token grants bash/exec + every session). URL share
  links were removed until this exists.
- Auto-opening the newest session when the URL has no `?session=`.
- A reverse proxy that rewrites `Host` to a local name still looks loopback (documented, not detected).
- The pre-existing items in `docs/architecture.md` → "Known quirks" (dead `body2()`, duplicated
  compressed-serve logic, …) — untouched by this PR.

---

# Review log

Append-only. Newest entries at the bottom. Format: `### <date> — <reviewer> — <verdict>`, findings as a
table with **Disposition** (`fixed <commit>` / `rejected: <why>` / `open`), then any follow-up replies.

### 2026-10-23 — grok-4.6-high (arena_chat, PR summary) — **needs-work**

| # | Finding | Disposition |
|---|---|---|
| 1 | "Ignore-port is not the TLS fix: `Origin: http://localhost:3000` must 403" | **fixed** `361746a` — exact `host:port`, missing Origin port → scheme default; test row added |
| 2 | "Token skip is peer-only: loopback + `Host: <ddns>` without a token must 401; modes do not touch it" | **fixed** `361746a` — `authorized()` = loopback **and** `isLocalHost()`; origin gate moved first so foreign Host keeps 403 |
| 3 | "Do not ship `share-link.ts` as a god-token URL — drop or warn" | **fixed** `361746a` — URL token path removed entirely (user decision (b)); docs updated |
| 4 | "Redact `?token=` on `/ws/*` — the successful URL lands in logs" | **partially rejected** — the reject lines (and all upgrade logs) print `pathname`, never the query string (verified); a comment was added so it stays that way |
| 5 | "Prove the esbuild aliases are client-only; 'builds with packages absent' also fits shipping empty providers" | **fixed** `361746a` — build-time assertions (static alias check + stub-content check + at-least-one-stub), negative-tested |
| 6 | Doubt: FAUX `stopReason:"error"` ≠ a real mid-stream 429 (partials, parallel tools) | **partially fixed** — added a partial-content + error case; parallel-tool/compact-in-flight still uncovered (noted in §6) |
| 7 | Doubt: client "never loops" under parallel 401s | **open** — dedup is by state, not by request; banner is already de-duplicated, prompts can still stack in theory |
| 8 | Doubt: `#token=` "never Referer" — not true for copy/paste/crash reports | **moot** after finding 3 (path removed) |
| 9 | Auto-retry: no `Retry-After`, flat 3 s, default ON, stampede, string-match false positives | **partially fixed** — `Retry-After` honoured (bounded) + jitter; flat delay/default ON are the user's spec; classifier stays string-based (documented) |
| 10 | "Reset-on-abort must cancel the timer, not just the counter" | **rejected** — `_cancelAutoRetry()` is called from `abort`, `prompt`, `editCommit`, manual `retry`, `discard`, `shutdown` |
| 11 | "`dropped === 0` refuse can no-op forever" | **rejected** — pi-agent-core's `StreamFn` contract requires failures to end with `stopReason "error"|"aborted"` (+`errorMessage`), and the Retry button only renders for such messages |
| 12 | Unnamed: `isLoopback` variants (`::ffff:127.0.0.1`, Windows, unix sockets) | **checked** — `::ffff:127.0.0.1` handled; the server binds TCP only (no unix socket); `127.0.0.2` is intentionally not loopback (documented) |
| 13 | Unnamed: 401 replay of `POST /api/exec/tool` double-executes | **fixed** `361746a` — replay limited to GET/HEAD |
| 14 | Unnamed: boot/403 body reflecting allowlist members | **rejected** — the 403 body names the env var only; the boot banner lists LAN IPs (pre-existing, local console only) |
| 15 | Unnamed: `engines >=22` + stub aliases in the same auth PR | **rejected** — CI runs node 22/24 and the build assertion now proves the stubs; the alias is unrelated to the auth change but was needed to make CI green at all |

**Follow-up after the fixes:** none yet — request a verification pass before merging.

<!--
### YYYY-MM-DD — <reviewer> — <verdict>
| # | Finding | Disposition |
|---|---|---|
| 1 | … | fixed <commit> / rejected: <why> / open |
-->

### 2026-10-23 — reviewer1 — **needs-work**

The auth-gate and retry changes have focused tests and the documented invariants are clear. I would
not approve this PR while the session transcript artifacts remain tracked in its history.

| # | Finding | Disposition |
|---|---|---|
| 1 | `tmp-s2.json` and `tmp-sess.json` are committed session transcripts (~9.9 MB combined). These may contain private conversation or session data, and deleting them only in a later commit would leave them in the PR history. | **open** — strip them from the branch history before publishing/merging; keep them ignored and check whether any credentials or other sensitive data require rotation. |

### 2026-10-23 — reviewer1 — **needs-work** (commit review: `20a7865..361746a`)

I traced the behavior-bearing commits listed in §2, including the final review-fix commit. The focused
retry and security-gate suites pass, but the following gaps remain:

| # | Finding | Disposition |
|---|---|---|
| 1 | **P1 — Auth token can be attached to cross-origin requests.** `4b0a8c2`'s fetch wrapper treats any URL containing `/api/` or `/ws/` as an API URL, and its WebSocket wrapper adds the token to every URL whose path starts `/ws/`, without checking the destination origin. An absolute third-party URL matching either path can therefore receive the server's full-access token. | **open** — only attach credentials when the parsed destination origin matches `window.location.origin` (and retain the intended API/WS path checks). **Confidence: 9/10.** |
| 2 | **P2 — Default `auto` mode still blocks terminal access on unlisted custom domains.** `20a7865` makes the origin gate conditional for remote peers on HTTP and `/ws/sync` + `/ws/agent`, but `361746a` wires `/ws/terminal` to `TERM_ORIGIN_ALLOWED`, which always requires an exact `ALLOWED_HOSTS` entry. A remote client with a valid token can use the app through a DDNS/custom name but gets 403 when opening the terminal unless that name is separately configured. | **open** — pass a mode/peer-aware origin predicate to the terminal hub, preserving strict loopback rebinding checks. A targeted remote-WebSocket probe with an unlisted custom Origin returned HTTP 403. **Confidence: 9/10.** |
| 3 | **P2 — Turning auto-retry off does not cancel an already scheduled retry.** `3cd3552`'s `setAutoRetry()` only changes the config; it does not cancel pending per-session timers, and the timer callback invokes `retry(..., { reason: "auto" })` without rechecking `enabled`. Disabling the setting during a `Retry-After` wait therefore still permits the queued retry. | **open** — cancel pending retry timers when disabling auto-retry and recheck the current setting in the callback. A targeted probe disabled the setting after scheduling and observed the retry still fire. **Confidence: 9/10.** |

**Verification:** `npm run test:retry` — 31 passed; `npm run test:security` — 64 passed. The two
targeted probes above reproduced findings 2 and 3; finding 1 is confirmed by tracing both credential
injection paths in the source.

### 2026-10-23 — reviewer2 — **needs-work**

Verification pass on `d8ffb05` (independent of reviewer1; his findings are not re-checked here per the
review workflow). Suites on this branch: `test:retry` 31/31, `test:security` 64/64, `test:store` 7/7,
`typecheck` clean.

| # | Finding | Disposition |
|---|---|---|
| 1 | **P1 — The branch is ALREADY pushed and carries the transcript blobs to GitHub.** §Status says "not pushed", but `origin/feat/auth-gate-retry` = `d8ffb05` and `git rev-list --objects origin/feat/auth-gate-retry` reaches the `tmp-sess.json` blob (`8e9f4d5`, 4.6 MB) — the pre-strip history this branch inherited from its base (`ffb3c63`/`3b33d01` on the old main) is public. This turns reviewer1's "strip before publishing" into "the remote must be cleaned too". | **open** — after stripping, force-push this branch (or delete + repush the rebased one); rotate the auth token if any transcript content is considered sensitive. Until then treat the GitHub remote as containing private session data. |
| 2 | **P1 (process) — Merging this branch into main would RE-INTRODUCE the stripped blobs.** main was history-rewritten (`filter-branch`, 2026-10-23) precisely to drop the transcripts; this branch still sits on the OLD lineage (`4cf48ee → ffb3c63 → 3b33d01 → a16f0b9 → …`). A merge keeps both lineages forever; only a REBASE of the 8 auth commits onto stripped main drops them. §Base also references `2f91d52`, a pre-rewrite hash that no longer exists on main. | **open** — `git rebase --onto <new-main> a16f0b9 feat/auth-gate-retry` (the 8 auth commits do not touch the blobs, so the replay is clean), then re-push. Do NOT merge. |
| 3 | **P3 — Stale PR metadata.** §Status "not pushed" (it is), §Base `2f91d52` (dangling post-rewrite), §6 "Before pushing … must be stripped" (the push already happened). The PR record no longer describes reality and misleads the next reviewer. | **open** — refresh the header fields after the rebase; keep the append-only log intact. |
| 4 | **Note (positive) — the client token header only gates *same-origin-shaped* URLs today**, so the cross-origin exposure in reviewer1's finding 1 has a narrow practical surface (no absolute third-party URL is fetched by the app's own code paths I traced); the fix is still correct and cheap. | **note** — no action beyond reviewer1's own disposition. |

**Merge gate:** hold for the strip + rebase (findings 1–2) and reviewer1's three open items.

**Follow-up (reviewer2, 2026-10-23 later pass — after reading `session-sharing-report.md`,
the predecessor artifact this PR implements):**

| # | Item | Disposition |
|---|---|---|
| A | The predecessor report's §7.0 checklist marks **PL-2 (fragment share links) DONE** and PL-7 lists "share-link 14/14 tests" — but this PR's own review log (grok pass, finding 3) shows share links were **removed entirely** in `361746a` (user decision (b): a `#token=` link hands out full control). The report is **historical** — its PL-2/PL-7-share-link entries describe a state that no longer exists on this branch; do not use it as an implementation reference. | **noted** — report superseded by pr.md §3 for current behavior |
| B | The report's §5/§10 security reasoning (token as the trust boundary for non-loopback peers; loopback-only origin gate; always-token privileged routes) is the basis of this PR's invariants and remains accurate. | **confirmed** |
| C | The report's open decisions (§9: plain-HTTP vs TLS proxy; §7.5: read-only visitor token) are still **unanswered** and now live in this PR's §6. | **open — user decision** |
| D | Meanwhile on `main`: the CI/build defects this PR fixes (npm 9/10 silently dropping `file:` overrides → real provider SDKs → red build) were **ported to main** in `6b9ec90` (build.mjs stub aliases + assertions, ci.yml v2, webpack.yml deleted), so the eventual rebase converges instead of conflicting. Main also fixed the edit tool's line-fuzzy indent corruption (`replace("\t")` → `replace(/\t/g)`) found via `edit-vs-splice.md` — relevant here because this PR's own edits were produced with the corrupted rebase. | **noted** — reduces the rebase surface |
| E | Rechecking my earlier finding 1 (transcripts on origin): the stale "not pushed" claim in §Status came from this predecessor report's timeline — the push happened after it was written. My disposition stands: **rebase onto stripped main + force-push** remains the merge gate. | **stands — open** |

## Merge plan — `feat/auth-gate-retry` → `main` (2026-10-24)

**Verdict: USABLE.** The branch is current (`main ⊂ feat/auth-gate-retry`, so a merge is a
fast-forward), it is blob-clean, and with its OWN dependency set (`pi-ai`/`pi-agent-core` **0.75.3**,
via `npm ci`) it passes: typecheck + build, `retry` 31, `security-gates` 64, `zombie` 11,
`runtime-seq` 6, `store` 7, `ssrf` 5, `versions` 24, `compact` 19, `fork` 23, `shutdown` 9,
`edit-tool` 7, `term-smoke` 12.
Everything the branch "removes" versus main is an intentional replacement: the superseded auth gate
(old `authorized()`, `ALLOWED_HOSTS` set, middleware order, `TERM_ALLOWED_ORIGINS`), main's old
client-side retry (now the hub op; the `?local=1` fallback keeps its toolCall repair), and
unreferenced scratch files (`patch-edit.mjs`, `patch-stream.mjs`, `report.md`, `doc-report.md`,
`commit-review.md` — main's own docs note they are referenced by nothing).

**Review found exactly one real loss, now repaired:** main had refactored the phantom-streaming
guard into `_settleRuntime()` ("moved here per review"), while this branch still inlined a copy in
`agent_end`. A fast-forward would have replaced main's single implementation with the copy, and the
copy was the only place carrying the retry note. Fixed in `74f397d`: `agent_end` calls
`_settleRuntime(sessionId, entry, { lastText: entry.retryNote || null })`, the method returns
`{ lastA, failed }` for the retry policy below it (one scan, one place), and its abort()/Kill call
sites are unchanged. `test:retry` caught the intermediate mistake (dropped `failed` binding) — the
suite is doing its job.

### Steps

0. **Done** — `74f397d` (guard unification) on the branch.
1. **Push the branch**: `git push origin feat/auth-gate-retry` (it is 2 ahead of the remote after
   this file and `74f397d`).
2. **Merge into main**: `git switch main && git merge --no-ff feat/auth-gate-retry`.
   `--no-ff` is a choice, not a need: the branch contains all of main, so a plain merge would
   fast-forward — but a merge commit preserves the PR context, and this branch *is* the PR record
   (`pr.md` carries the reviewer passes and their dispositions).
3. **Verify on main before pushing** (same deps as the branch, 0.75.3):
   `npm ci && npm run typecheck && npm run build` then the suites listed above. Optionally a live
   check on a scratch instance: remote peer 401 without the token / 200 with it on a custom Host,
   loopback + foreign Host 403, `/ws/agent` 101, and the `PI_WEB_ORIGIN_GATE` modes.
4. **Push main**: `git push origin main` (normal push — main and origin/main are in sync today, so
   no force).
5. **Then the tracks, in ONE merge**: after main has auth, `merge/tracks` (auth + retry/mobile +
   IDB + atomic + the `1.4.0` upgrade) is a fast-forward over main and is already verified green
   with 1.4.0 (16 suites + typecheck + build). Merging the three tracks individually would test
   three unverified combinations instead of one verified integration.
   Dependency order matters: main is 0.75.3, the tracks are 1.4.0 (`c461dee` upgrade). Landing the
   tracks first would put 1.4.0 under a not-yet-merged auth branch — the auth delta itself makes no
   pi-ai calls, but its lockfile/package.json would then conflict and the combination would have to
   be re-verified. Landing auth first (step 2) keeps every intermediate state tested.
6. **After a server restart** (user's call — it drops in-flight runs): the auth gate + retry behave
   live, and the browser needs one reload to pick up the client bundle (401/403 banner, hub retry).

### Environment caveat (the practical friction)

`node_modules` is per-checkout, not per-branch: this branch's code needs its lockfile's
**0.75.3**, the tracks need **1.4.0**. That is why `typecheck` failed here before `npm ci`
(installed 1.4.0, expected 0.75.3) and why every switch between the two groups needs an install.
`npm ci` on either side takes ~45s from the local cache.

### Rollback

`backup/auth-gate-pre-rebase` / `backup/auth-pre-rebase` hold the pre-rebase state (`ace26bb`); the
merge is revertible with `git revert -m 1 <merge-sha>` or by resetting main to `6b9ec90`.
