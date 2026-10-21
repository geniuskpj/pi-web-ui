# doc-report.md — Documentation review: README.md + docs/

Review date: 2025-10-21 · Reviewer method: read every doc end-to-end, then **verified claims against the
code** (grep of `server.mjs`, `terminal-hub.mjs`, `src/**`, `term-smoke.mjs`, file sizes, `wc -l`,
`docs.json`). Every finding below cites file:line and the evidence that produced it.

Files reviewed (67.5 KB total):

| File | Size | Role |
|---|---|---|
| `README.md` | 19.8 KB / 237 L | entry point (also copied to `C:\pi-windows-x64\docs\pi-web-ui.md`) |
| `docs/architecture.md` | 13.0 KB / 157 L | big picture, module map, trust boundaries, quirks |
| `docs/server.md` | 14.2 KB / 198 L | server internals |
| `docs/client.md` | 11.6 KB / 161 L | browser internals |
| `docs/terminal.md` | 8.9 KB / 120 L | terminal hub + dock |
| `SYSTEM.md`, `.gitignore` | 3.5 KB | adjacent prose (context, not deliverables) |

## 1. Verdict

**Accuracy is unusually high; audience fit and structure are the real problems.**

The four `docs/*.md` files are reference-grade: function names, invariants, limits (caps, TTLs, timeouts),
and failure modes are all present, and spot-checking found almost no false statements — 3 numeric drifts
and 2 stale claims out of ~60 checked (see §4). The "known quirks" appendix in `architecture.md` is the
single most valuable document in the repo: it records *contract violations the author noticed*, each of
which is a real code fact (verified: `body2()` dead code, `TOKEN !==` duplicate gate, Host-derived Origin
check, non-reentrant `broadcast` swap).

The problems are:

1. **The README is written for a model-based code reviewer, not for a user or a new contributor.** Its own
   §Documentation says the docs are "the review substrate for model-based code review". Consequences: no
   quickstart, no prerequisites, no `npm install`, no license, no troubleshooting, and an ASCII diagram as
   the first content block after the title.
2. **README ↔ docs contradictions on user-visible behaviour.** Five cases found, all verified (see §3).
   A reader who trusts the README gets wrong answers on: bash timeout, the `?nosync`/`?noproxy` flags,
   the terminal test count, the pty-bridge download size, and the token default.
3. **No navigation layer.** `docs/` has no index. `client.md` and `terminal.md` contain **zero** outbound
   links (`rg '\]\(([^)]+)\)'` → only `architecture.md`, `server.md`, `README.md` emit links). The
   intermediate copy `C:\pi-windows-x64\docs\pi-web-ui.md` is byte-identical to the README today but is
   **not listed in `docs/docs.json`** (41 entries, none matching `web`) → orphan page, invisible in the
   docs site.
4. **Coverage holes in the "how do I run/maintain/extend this" plane**: build pipeline, test scripts
   (`term-smoke.mjs`, `cdp-*.mjs`, `patch-*.mjs`, `term-debug.mjs`, `restart.mjs.ps1` — all undocumented),
   session/mirror file formats, deployment/LAN hardening, third-party licensing, and a glossary.

## 2. What is already good (keep this)

| Strength | Evidence |
|---|---|
| Claims are checkable and mostly checked: function names, caps, TTLs, regexes are quoted verbatim | `docs/server.md:70-76` (`assertInsideRoots`, `withFileMutationQueue`, `truncateTail`), `docs/client.md:100-108` (`shouldUseProxyForProvider`, clone-before-proxy) — all verified in code |
| Module map with per-file responsibility — the fastest onboarding artifact here | `docs/architecture.md:26-53`; line counts match reality within ±1 for all 20 files |
| The "known quirks" list is honest, specific and points at the exact mechanism | `docs/architecture.md:134-157`, e.g. `body2()` (verified `server.mjs:1532-1535`), `TOKEN !==` (verified `server.mjs:931,1015`), `nip.io`/`localtest.me` rebinding note |
| Security model is documented with its *reasoning*, not just its rules ("custom headers cannot be attached cross-origin, so CSRF is structurally impossible") | `docs/architecture.md:91-115` |
| Env var reference in `architecture.md` is complete and correct | `docs/architecture.md:119-132` vs `rg -o 'PI_[A-Z_]+'` — covers `PI_WS`, `PI_WEB_DATA_DIR`, `PI_WEB_TOOLS`, `PI_WEB_BASH*` |
| `.gitignore` doubles as design documentation (why `public/assets/app.css` is tracked, why `data/` is never committed) | `.gitignore:1-30` — this prose style should be reused in the docs |
| Smoke test is described by what it asserts, not just that it exists | `docs/terminal.md` + `README.md:165-167` (origins, ids, ONLCR, replay, reset, kill) |

## 3. Broken claims (README ↔ docs and README ↔ code)

| # | Claim | Reality (evidence) | Fix |
|---|---|---|---|
| **C1** | `?nosync=1` disables the WS sync channel; `?noproxy=1` disables the proxy (`README.md:233-234`) | Not implemented. Only `reset-storage` is parsed: `rg 'nosync\|noproxy' src/` → 0 hits; `src/main.tsx:553` handles `reset-storage` only. `docs/client.md:10-12` explicitly says "NEITHER is implemented" | Delete the two README bullets, or implement the flags. Do not leave a debug-flag list that is half fiction |
| **C2** | bash "web cap **600s**" (`README.md:197`) | Advertised 600s (`server.mjs:729,739`) but the exec bridge wraps every call in `AbortSignal.timeout(120000)` (`server.mjs:977,996`) → **effective cap 120s**. Already flagged inside `docs/server.md:124-127` while the README kept the wrong number | Change README to "advertised 600s, effective 120s via the exec bridge" (and consider aligning the code) |
| **C3** | `term-smoke.mjs` = "(8 checks)" (`README.md:59`) | 12 `check(...)` calls (`term-smoke.mjs:132,144,151,153,154,157,160,167,174,184,191,195`). `README.md:167` in the same file says "12 checks" | One number, in one place |
| **C4** | pty bridge = "2.2MB download from repo.msys2.org" (`README.md:103`) | Actual artifact is `util-linux-2.40.2-2-x86_64.pkg.tar.zst` with `SCRIPT_PKG_MAX_BYTES = 8 * 1024 * 1024` (`terminal-hub.mjs:221-225`); the extracted `script.exe` on disk is **63,230 bytes** (`ls -l data/bin/script/`). `docs/terminal.md:25-26` documents the 8 MB cap and the sha256 pin, README says 2.2 MB with no source | State the pinned package name + sha256 + cap, or drop the size |
| **C5** | `PI_WEB_TOKEN` default "empty", purpose "auth token for /api/pi/key" (`README.md:100`) | Auto-generated 24-byte base64url persisted to `data/auth-token.txt` (`server.mjs:89-97`) and it is the **blanket `/api/*` gate**, not a `/api/pi/key` token (`server.mjs:109-113`). `architecture.md:93-94` is correct, README is not | Copy the correct wording down from `architecture.md` |
| **C6** | `docs/server.md:9` "persist (0644 file …)" | No `chmod`/`mode` anywhere in `server.mjs` (`rg chmod` → 0 hits) — default mode applies, and on Windows the claim is meaningless | Drop the mode, or say "mode left to the platform default (0644 semantics are not enforced)" |
| **C7** | Env reference: README table (`README.md:95-105`) omits `PI_WS`, `PI_WEB_DATA_DIR`, `PI_WEB_TOOLS`, `PI_WEB_BASH`, `PI_WEB_BASH_SHELL` | All five exist (`server.mjs`, verified by `rg -o 'PI_WEB_[A-Z_]+'`) and all five are documented in `architecture.md:119-132` | Single-source the table (see §5) |
| **C8** | Line counts drift: `terminal-hub.mjs` "999 L" vs 998; `src/pi-import.ts` "119 L" vs 118; `src/llm.ts` "61 L" vs 60 | `wc -l` | Drop exact counts or add a CI check; they rot on every edit |

Also stale/ambiguous, lower severity:

- `README.md:66-68` cites "plan.md §9", "§12–14" — `plan.md` sections are **out of order on disk**
  (…11, 12, 15, 13, 14) so the reference is hard to follow; a §-number reference to a mutating design doc
  is brittle.
- `docs/client.md:12: "system-prompt-dialog.tsx exists in src/ but is not rendered anywhere"` — verified
  true (`src/system-prompt-dialog.tsx` defines `SystemPromptDialog`, no importer). Correct, but it belongs
  in a "dead code" section of the module map, not buried in a boot-sequence parenthetical.
- `README.md:107-114` "Notes" mixes user facts (bundle size, session storage), internal design (fast tier),
  and history — the section has no single reader.

## 4. Claim verification sample (~60 claims)

| Result | Count | Examples |
|---|---|---|
| Verified true | ~53 | `assertInsideRoots` realpath walk + `mustExist` (`server.mjs`), edit 4-form match pipeline + line-fuzzy pass, `truncateTail` spill to `os.tmpdir()/pi-web-bash-*.log`, replay ring 128 KB (`terminal-hub.mjs:64`), grid clamp 40–240 / 10–120 (`terminal-hub.mjs:71-72`), `MAX_INPUT` 64 KB stdin cap, `/ws/terminal` Origin allowlist, `zstdDecompressSync` + "need node >= 22.15" (`terminal-hub.mjs:269-270`), DOMPurify `FORBID_ATTR: style,id,name`, `makeId()`/`copyText()` fallbacks, `LocalStorageBackend` `__keys` index, tombstone TTL |
| Wrong (user-visible) | 5 | C1–C5 |
| Wrong (cosmetic) | 3 | C6, C8, plan.md § references |
| Unverifiable from source | 2 | "2.2MB download"; "node_modules ~75MB" (`du -sh` = **75M**, so this one is fine) — bundle "~0.99MB (0.19MB brotli)" vs actual 1,063,412 B / 206,821 B = 1.01 MB / 0.20 MB (drift) |

## 5. Structural recommendations

### 5.1 Give the README a reader, and give the reader a path

Current README order: title → build commands → architecture diagram → docs index → feature table →
**19-row bug-history table** → config → notes → bash manual → diagnostics. A first-time reader meets a
bug-history table before learning what the app does or how to start it.

Proposed skeleton (keep the density, change the order):

```
1  pi web                              (1-paragraph: what it is, who it's for, screenshot)
2  Quickstart                          npm install; npm run dev; open :8787; first key
3  Requirements                        Windows + Git Bash (C:\Git\usr\bin\bash.exe), node ≥ 22.15
                                       (zstd bridge), optional msys2 auto-download
4  Features                            (today's table, minus history)
5  Configuration                       single env table (§5.2)
6  Security & LAN use                  token, loopback trust, Origin allowlist, what to set before 0.0.0.0
7  Using the bash tool                 (today's section — already good, user-facing)
8  Terminal dock                       (compress; link docs/terminal.md for the rest)
9  Troubleshooting / FAQ               ?reset-storage, token prompts, bridge fallback, FAB diagnostics
10 Development                         build.mjs pipeline, typecheck, term-smoke, cdp-* helpers
11 Docs                                short index (half the current length) + docs/README.md
12 License & third-party               wterm bundle, vendored app.css, msys2 util-linux script.exe
13 Changelog                           link
```

### 5.2 Single-source the env table

It exists twice (`README.md:95-105` incomplete, `architecture.md:119-132` complete) and the two already
disagree (C5, C7). Move the table into `docs/configuration.md` (or keep it in `architecture.md`) and have
the README carry a 5-row "most used" subset + link. Same for the two feature tables (README rows 49-64 vs
the module map): pick one owner per fact.

### 5.3 Add a docs index and a frontmatter convention

- `docs/README.md`: 10-line map, "start here" order (architecture → client/server/terminal → reference),
  a one-line *reader* per file ("read this if you are changing X").
- Fix cross-linking: `client.md` and `terminal.md` must link back to `architecture.md` (and to each other's
  seams: exec bridge ↔ terminal dock, `pi-tools.ts` ↔ `/api/exec/tool`). The docs are currently a star with
  a broken rim.
- Add a header line per file — `Applies to: pi-web-ui @ <git sha> · <date>` — and a "format" note
  (reference vs how-to). None of the five files carries a version or date, so a reader cannot tell whether
  a page is stale; every drift in §3 is invisible on the page itself.
- Register `docs/pi-web-ui.md` in `C:\pi-windows-x64\docs\docs.json`, or drop the copy. Right now it is an
  orphan that silently duplicates the README (currently byte-identical — verified with `diff`).

### 5.4 Close the coverage holes

| Missing doc | Why it matters (evidence) |
|---|---|
| **Development / tooling** (`docs/development.md`) | `term-smoke.mjs`, `cdp-e2e.mjs`, `cdp-test.mjs`, `cdp-restore.mjs`, `patch-edit.mjs`, `patch-stream.mjs`, `term-debug.mjs`, `restart.mjs.ps1` are **referenced by nothing** (`rg <file> README.md docs/*.md` → 0 hits for all but `term-smoke`/`build`/`vendor-wterm`). These encode non-obvious verification workflows (CDP-driven checks) |
| **Build & packaging** (`docs/build.md`) | `build.mjs` (138 L) does hashing, `manifest.json`, `.br`/`.gz` precompression, stale-bundle pruning, hljs alias, and a `--check` dependency on `vendor-wterm.mjs` — only 1–2 sentences exist (`architecture.md:35`, `terminal.md:96-97`). The "stale bundle" class of bugs (`README.md:79`) is exactly what this pipeline prevents |
| **Session & mirror format** | JSONL layout (line 1 metadata, rest messages; tmp+rename; corrupt-file skip; `SESSION_ID_RE`) is 1 paragraph in `server.md:165-171`; the *legacy* `{data:{messages}}` conversion and `legacySyncPuts` shim-removal counter are mentioned but never specified. Anyone debugging a sync bug needs this |
| **Deployment / LAN hardening** | README documents nothing about running on `0.0.0.0` (the default!) with provider keys on the box. The only guidance is scattered across `architecture.md:91-115` + quirks + `terminal.md:78-90`. A 10-line "expose safely" checklist (set `PI_WEB_TOKEN`, don't reverse-proxy without re-checking `isLoopback()`, `PI_WEB_TERM_ORIGIN`, no Origin check on `/ws/sync`) is worth more than any other new page |
| **Glossary** | `wterm`, pty tier vs pipes tier, exec bridge, worker store, partials map, fast tier, tombstone, ONLCR, OSC 133/7, ring replay — each is used as if known |
| **Troubleshooting/FAQ** | Diagnostics are user-facing but undocumented as a workflow: FAB → Copy Diagnostics, `?log=`, `pi.logLevel`, `data/auth-token.txt`, `?reset-storage` |
| **Licensing / provenance** | The repo vendors `@wterm/dom@0.5.4`, keeps a vendored Tailwind `app.css` from `pi-web-ui`, and **downloads and redistributes msys2 `util-linux` `script.exe` (GPL-2.0)**. `docs/terminal.md:23-31` documents the sha256 pin (good engineering) but no doc states licenses or upstream attribution. Ship a `docs/third-party.md` + README section |
| **Extension authoring contract** | `docs/server.md:52-61` describes the shim and the "any other `pi.*` access → loud no-op" rule — that is an authoring contract for users writing extensions in `.pi/extensions/*.ts`; it deserves a how-to, not a paragraph inside server internals |

### 5.5 History and internal artifacts should leave the README

`README.md:70-91` (19-row "Bug fixes vs the naive implementation") duplicates `bugs.md` (20 numbered
entries, same content at 10× depth). Both are valuable *history*; neither is onboarding material.
Recommendation:

- `CHANGELOG.md` (Keep-a-Changelog style) for user-visible behaviour changes.
- `docs/history/` for `bugs.md` + `plan.md`, each with a status banner ("historical design record —
  partially superseded; see docs/*"). `plan.md` is a 26 KB live-looking plan doc whose header still reads
  "Recreate the ChatPanel UI…" while Phase 5 says ALL COMPLETE — it reads as pending work.
- Keep at most 3 "notable fixes" rows in the README if any.

### 5.6 Style consistency

- **Long lines**: `README.md:43,44,59` are 428–483 chars, and lines 126-176 / 220-230 pack multi-topic
  bullets into single paragraphs. Split into sub-bullets; the content is good, the shape is not.
- **Emoji as an API surface**: 🖥 / 🗄️ / ↗ / 💾 are the only names given for UI affordances in several
  places (`README.md:32,59,126,156-164,227`). Give the control a name ("the Terminal button (🖥) in the
  header") so it survives a re-theme, and never rely on the glyph alone.
- **Two levels of depth in one file**: the terminal bullet block (`README.md:126-176`) is a full design
  doc inside a README section. Move it to `docs/terminal.md` (already covers it better) and leave 6 lines.
- **Consistent tense/voice** in `docs/`: reference docs use present-tense factual statements (good); make
  the reader-facing "how do I" instructions second-person and imperative — currently mixed.

## 6. Prioritized action list

**P0 — correctness (do now, ~1 hour total)**
1. Fix C1 (`?nosync`/`?noproxy`), C2 (timeout), C3 (12 checks), C4 (bridge size), C5 (token), C7 (env rows).
2. Fix C6 (`0644`) in `docs/server.md`; drop or CI-check line counts (C8).
3. Refresh `C:\pi-windows-x64\docs\pi-web-ui.md` from README **and** add it to `docs/docs.json` (or delete the copy).

**P1 — navigability (half day)**
4. Add `docs/README.md` (index + reading order + per-file "read this if").
5. Add back-links/see-also to `client.md` and `terminal.md`; add `Applies to: <sha> · <date>` headers to all five files.
6. Single-source the configuration table (§5.2); trim the README docs index to ~10 lines.

**P2 — coverage (1–2 days)**
7. Write `docs/development.md` (all helper scripts + verification workflow), `docs/deployment.md`
   (LAN/security checklist), `docs/build.md`, `docs/third-party.md`.
8. Add README Quickstart + Requirements + Troubleshooting; move bug history to `CHANGELOG.md`; archive
   `bugs.md`/`plan.md` under `docs/history/`.
9. Add `docs/session-format.md` + a glossary (`docs/glossary.md`).

**P3 — guardrails**
10. Doc-lint in CI: link check (all `](*.md)` resolve), env-var check (`rg -o 'PI_[A-Z_]+'` ⊆ documented
    set), line-count/fact check script, and a "README ↔ docs" contradiction check for numeric claims
    (checks like C3/C4 are mechanically detectable). Every drift in §3 was found by a grep — a 30-line
    script would have found them at author time.

## 7. One-paragraph summary for the commit message

`README.md` and `docs/*` are factually strong and reviewer-grade, but the README serves a code-reviewer
audience rather than a user or new contributor, duplicates facts it does not own, and has drifted from the
implementation in five user-visible places (debug flags that do not exist, a 600s bash timeout that is
really 120s, an 8-vs-12 test count, a 2.2 MB vs 8 MB bridge artifact, and a token default that is
auto-generated rather than empty). Recommended path: fix the contradictions, single-source configuration
and feature facts, add a docs index plus version headers and cross-links, register the `docs/pi-web-ui.md`
copy in `docs.json`, then fill the four real coverage holes (development/tooling, deployment hardening,
build pipeline, third-party licensing) and move bug/plan history into `CHANGELOG.md` + `docs/history/`.
