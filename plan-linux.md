# Plan — Linux support for the terminal + exec surfaces

**Branch:** `feat/linux-support` (from `feat/auth-gate-retry`)
**Goal:** run the pi-web-ui server — including `/ws/terminal` and the bash exec
bridge — on Linux (and macOS as a free rider), with zero behavior change on Windows.

**Why a plan:** the terminal stack is the only Windows-locked part of the server.
Everything else (HTTP, WS, mirrors, agents, edit/versions) is platform-neutral
Node. The lock-in is concentrated in two files plus one constant:

| Surface | File:line | Windows assumption |
|---|---|---|
| pty tier | `terminal-hub.mjs:17-26, 224-229` | msys2 `script.exe` bridge allocates a real pty; winpty CLI is unusable headless (winpty.cc:924) |
| bridge provisioning | `terminal-hub.mjs:91-97, 315` | Git roots `C:\Git` / `C:\PortableGit`; `bin\bash.exe` + DLL loading quirks |
| kill | `server.mjs:502` (`killProcessTree`), `terminal-hub.mjs:70, 811` | `taskkill //PID //T //F`; exit-event race after taskkill (RESET_RECOVERY_MS) |
| shell constant | `server.mjs:735` | `BASH_PATH = C:\Git\usr\bin\bash.exe` (`PI_WEB_BASH_SHELL` override) |
| CR/LF semantics | tests/term-smoke (ONLCR row) | msys pty echoes `\r\n`; Linux ptys emit `\n` (staircase risk inverted) |
| CI | `.github/workflows/ci.yml` | term-smoke excluded as "Windows-specific" |

## Phase 1 — Platform abstraction (no behavior change)
1. Extract a `PtyBackend` interface in `terminal-hub.mjs`:
   `create({ cwd, env, cols, rows, shell, shellArgs }) → { write, resize, kill, onData, onExit, pid }`.
   All current Windows code paths move behind `backends/win32-bridge.mjs` (the msys
   `script.exe` bridge, byte-for-byte). Selection: `process.platform === "win32"`.
2. `killProcessTree`: split into `win32.js` (taskkill, unchanged) and
   `posix.js` (`detached: true` + `process.kill(-pgid, SIGTERM)` → SIGKILL after
   2s; the RESET_RECOVERY_MS path stays as the exit-event-race net).
3. Shell discovery: `process.env.SHELL || /bin/bash` (login `-l` so PATH matches
   an interactive session); `PI_WEB_BASH_SHELL` override stays the first pick.

## Phase 2 — Linux PTY via system util-linux `script` (no Node dependency)
Linux runs the same interactive Bash shell through `script`, which allocates a
PTY and bridges stdin/stdout. This supports programs such as nano without a
native Node package; pipes remain the fallback if `script` is absent.
1. Keep Bash interactive with the generated rc and readline behavior.
2. Preserve the ONLCR translation and process-group cleanup for Linux children.
3. Verify the smoke test confirms `test -t 0` inside Bash when `script` exists,
   and continues to cover the Windows bridge's PTY behavior separately.
## Alternative considered (not used): node-pty backend
1. Add `node-pty` as an **optionalDependency** (native build; `--no-optional`
   installs must keep the server bootable — dynamic `import()` behind try/catch,
   fall back to the pipes tier with a loud log, mirroring today's tier fallback).
2. Map backend events: `onData` → stripWs path unchanged; `resize(cols, rows)` →
   SIGWINCH via `pty.resize`; exit codes → the same recovery logic.
3. Client contract check: the emulator is platform-neutral (vendor-wterm); verify
   the ONLCR row in term-smoke gains a Linux expectation (`\n`-only output must
   NOT staircase — the pty's ONLCR handles it, same as msys).

## Phase 3 — Exec bridge + paths
1. `builtinTools` bash: `BASH_PATH` per-OS (`/bin/bash`), `shell: true` semantics
   audited; cwd/workspace paths already POSIX-safe (relative).
2. Path separators in workspace file APIs (`path.join` is fine; audit any
   hardcoded `\\` in tool argument examples/prompts).
3. Env: `USERPROFILE` vs `HOME` references (rg shows none outside the terminal).

## Phase 4 — CI + tests
1. term-smoke runs on Linux `script` PTY and Windows bridge; assert TTY
   availability whenever a PTY tier is selected.
2. CI runs terminal smoke and platform process tests on both Ubuntu and Windows.
3. Regression suite: `tests/term-platform.test.mjs` — shell discovery and kill
   semantics (per-platform rows).

## Phase 5 — Docs + rollout
1. README documents Windows bridge and Linux system-`script` PTY support.
2. No native Node terminal dependency or backend rollout is planned.

## Non-goals
- macOS as a *supported* target (the pipes path may work but is untested).
- Replacing the msys bridge on Windows (it works; winpty's ConPTY/headless
  limitations are documented in `terminal-hub.mjs`).
## Alternative node-pty rollout proposal (not implemented)
1. term-smoke gains a Linux row (ubuntu runner has bash + can `apt-get` util-linux
   `script` — or use node-pty): add `if (process.platform === 'win32')` gates in
   reverse (skip only the Windows bridge rows).
2. CI matrix: run term-smoke on ubuntu with the node-pty backend; keep windows
   rows on the bridge.
3. Regression suite: `tests/term-platform.test.mjs` — backend selection, shell
   discovery, kill semantics (per-platform rows).

## Phase 5 — Docs + rollout
1. README: "Runs on Windows (winpty bridge) and Linux (node-pty)" + the optional
   dependency note (`apt install build-essential python3` if no prebuilt binary).
2. Rollout order: Phase 1 (pure refactor, green on Windows) → Phase 2 behind
   `PI_WEB_TERM_BACKEND=node-pty` opt-in → default-on for Linux after a week.

## Non-goals
- macOS as a *supported* target (it rides the node-pty backend but is untested).
- Replacing the msys bridge on Windows (it works; node-pty-on-Windows reintroduces
  the ConPTY/headless problems documented at terminal-hub.mjs:19-26).

## Test checklist (each phase must keep green)
`npm run typecheck` · `npm test` (term-smoke, Windows) · new
`test:term-platform` · killstop e2e (abort during a running bash tool must still
kill the tree on Linux — SIGTERM to the process group, verified by an orphaned
`sleep 300` probe).
