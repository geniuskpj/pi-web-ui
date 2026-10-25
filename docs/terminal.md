# Terminal — terminal-hub.mjs + src/ui/terminal.tsx

> Updated 2026-10-21 · See also: [architecture.md](architecture.md) (trust model) ·
[server.md](server.md) (upgrade gating, exec bridge) · [client.md](client.md) (chat-side command bridge)

Covers `terminal-hub.mjs` (server), `src/ui/terminal.tsx` (client dock), `src/ui/wterm-loader.ts`,
`vendor-wterm.mjs`, `public/vendor/wterm/`.

## Tiers (no node-pty, zero native builds)

- **pty (default)**: msys2 util-linux `script.exe` allocates a REAL msys pty and bridges our stdio —
  bash sees `/dev/ptyN`, so nano/vim pass isatty, and ONLCR/echo/^C/job-control are pty-native.
  Winpty is NOT used: its CLI asserts headless (`winpty.cc:924` — resize poll reads TIOCGWINSZ on a
  pipe → 0x0 → `winpty_set_size(0,0)`).
- **pipes (fallback)**: `bash --noprofile --rcfile <generated rc> -i` over plain pipes. Readline still
  echoes input, renders the PS1, redraws history, and handles `^C` — all as a raw VT stream. The hub
  emulates the two pty duties bash loses: **ONLCR** (`onlcr()` — state carries across chunk boundaries;
  lone `\r` untouched) and a **default env** replicating `git-bash.exe`'s login shell (`shellEnv()`:
  Git `usr/bin`+`mingw64/bin`+`bin` prepended, `HOME`, `SHELL=/usr/bin/bash`,
  `MSYSTEM=MINGW64` + prefix/carch/chost, `TERM=xterm-256color`, `COLUMNS/LINES`,
  `PI_TERM_COLS/LINES` for the rc's stty; node's dir is not prepended if it IS the workspace root).
- Remaining gaps (pipes): no job control, native console programs see pipes, fixed grid.
- Auto-fallback: the pty bridge dying non-zero within 4s of spawn (`PTY_FALLBACK_MS`) downgrades that
  session to pipes once (`fallbackTried`); a pipes-started session may upgrade to pty on later respawns.

## Bridge kinds: `script` (msys pty) and `conhost` (Windows ConPTY)

`pickBridge` proves candidates in order and returns the FIRST that works, with its kind:

1. **`script`** — msys2 util-linux `script.exe`, which allocates a real msys pty. Preferred when
   the msys runtime can allocate one, because it is a true msys tty (job control, WINCH resize).
2. **`conhost`** — `conhost.exe --headless <bash> --noprofile [--rcfile rc] -i`: Windows' ConPTY
   server gives the shell a real CONSOLE (so `isatty(stdin)` is true, `stty size` answers, nano/vim
   render, OSC 133/7 pass through) while the hub keeps plain pipes for stdio. No download, no native
   module, no console needed in the server process. Added 2026-10-25 after a machine whose msys
   runtime could not allocate a pty *at all* (`/dev/ptmx: Too many open files` even with a console,
   `script.exe` failing identically under one) — ConPTY was unaffected, and `nano` worked through
   the dock again. Its grid is fixed at spawn (`--width/--height`), the same limitation `script.exe`
   has (see the resize note); it re-uses the same session/protocol plumbing.

## Bridge CAPABILITY (`bridgeProbe` / `conhostProbe` / `pickBridge`)

A bridge is only adopted if it can allocate a pty FOR THE SHELL IT WILL DRIVE:
`bridgeProbe(exe, bashPath)` runs `exe -q -f -e -c "<bash> -c 'test -t 0'" /dev/null` and requires
exit 0 (`-e`/--return makes `script` propagate the child's status, so this asserts
`isatty(stdin)` — exactly what nano/vim need). `conhostProbe` does the same through ConPTY with a
MARKER in the output, because conhost does NOT propagate the child's exit status (verified: `bash -c
"exit 7"` comes back 0). The verdict and the bridge's own stderr are cached
per process; `pickBridge` walks the candidates and keeps the last failure reason, which becomes
`state.bridgeNote` (the dock renders it) and blocks adoption.

Why: a bridge that passes the old PE-header/size check but cannot create a pty (it binds a
different msys runtime than the one that ships with Git) was adopted, died instantly, and silently
downgraded the tier to `pipes` — where nano/vim fail with "standard input is not a terminal" and
nothing explained it. Regression suite: `node tests/term-pty.test.mjs` (with `PI_REQUIRE_PTY=1` a
real pty becomes a hard requirement).

## Bridge provisioning (`provisionScriptBridge`)

Downloads a PINNED package (`util-linux-2.40.2-2` from repo.msys2.org, sha256-pinned constant,
8MB cap), requires node zlib `zstdDecompressSync` (node ≥ 22.15), decompresses, extracts ONLY
`usr/bin/script.exe` with **System32 tar** (never PATH-searched) into a unique tmp dir
(`.tmp-<pid>-<ts>`), validates it (`bridgeUsable`: regular file, 8KB–2MB, `MZ` header), then
`renameSync` (atomic publish) into `data/bin/script/script.exe`. The extracted exe must also pass
`bridgeProbe` first (`pinned bridge cannot create a pty: …`), so a broken bridge is never published. Failures back off
`PROVISION_RETRY_MS` (60s). `PI_WEB_TERM_BRIDGE=0|pipes` forces pipes; a configured PATH must exist
(a typo fails loudly instead of triggering the auto-download).

## Generated rc (`ensureRcFile` → `data/term-shell.rc`)

- `HISTFILE=/dev/null` (web commands never land in the user's real history).
- `stty cols $PI_TERM_COLS rows $PI_TERM_LINES` (fixes script.exe's 80x25 pty default; no-op without a
  tty) + `kill -s WINCH $$` so readline re-reads the size it already snapshotted.
- Adaptive PS1: grid ≥ 60 cols → `user:cwd` colored prompt; narrower → `\W$ ` only (readline redraw
  math breaks when PS1 exceeds the line width). Both wrapped in OSC `133;A`/`133;B`; raw ESC/BEL bytes
  embedded via single quotes (no `$''`).
- `PROMPT_COMMAND` emits `OSC 133;D;<exit>` + `OSC 7;file://<cwd %20-encoded>` before each prompt —
  wterm strips them from the screen; the CLIENT scanner reads exit codes + cwd from the stream.

## Protocol (JSON frames over `/ws/terminal`, one object per text message)

| Direction | Frame | Meaning |
|---|---|---|
| c→s | `{t:"i", d:string}` | stdin bytes (≤ MAX_INPUT 64KB per frame) |
| c→s | `{t:"reset"}` | kill + respawn (recovery timer 1.5s if the exit event is lost) |
| c→s | `{t:"kill"}` | kill, no respawn (Exit button — safe from any foreground TUI) |
| c→s | `{t:"r", cols, rows}` | client grid (remembered; applied at next spawn) |
| c→s | `{t:"ping"}` | keepalive echo |
| s→c | `{t:"replay", d}` | ring history on (re)attach |
| s→c | `{t:"d", d}` | live output (stdout+stderr merged) |
| s→c | `{t:"clear"}` | other sockets drop the dead screen on reset |
| s→c | `{t:"state", s}` | `{phase: starting|ready|dead|error, tier, exit, error, pid, bridge, bridgeNote}` — `bridge` names the working bridge ("conhost --headless (ConPTY)", "script.exe (msys pty)"), `bridgeNote` explains why the pipe tier is in use when that is a BRIDGE problem |

## Session lifecycle (all proc handlers generation-guarded via `sess.gen`)

- `newSession(id)`: phase `starting`, empty ring, `StringDecoder`s for out/err, `onlcrCR` carry,
  `wantCols/wantRows` from the connect query.
- `spawnShell(sess, tier)`: kill any live proc first (`killLive` derives the pid from the LIVE
  `sess.proc` so a nulled `sess.pid` can't leak the old bash), `gen += 1`, decide the bridge at spawn
  time (provisioning may have finished), spawn with `windowsHide`, wire stdout/stderr (ONLCR + stderr
  startup-noise filter for the two known bash warnings — literal prefixes only, held only while the
  partial tail could still grow into one, force-flushed on the starting→ready flip so the first prompt
  is never swallowed), `error`/`exit` handlers no-op on stale gen.
- Output: `feed()` flips phase to `ready` on first bytes (emitting any held stderr tail) → `append()`
  grows the ring (trim to half past 128KB; the cut may split an escape pair — emulators resync) and
  coalesces into `pending` (flush every 30ms or force at 32KB). `flush()` happens BEFORE a new socket
  is added on attach, so replay never double-paints.
- `resetSession()`: killLive + `{t:"clear"}` + one tracked unref'd recovery timer (1.5s) in case the
  exit event is lost; `beginSpawn()` re-bumps gen so a LATE exit of the old proc no-ops.
- `killShell()` (Exit): kill, no respawn; `phase = "dead"`.
- Limits: MAX_SESSIONS 6 (evicts only DETACHED, oldest by activity), TTL 15min idle for detached, and
  dead/error sessions with still-attached clients are reaped after TTL too; 60s sweeper (unref'd).

## Security

- Upgrade: server.mjs token-gates non-loopback; the hub then enforces a strict **Origin allowlist**
  (localhost, 127.0.0.1, [::1], hostname, non-internal IPv4s, `PI_WEB_TERM_ORIGIN` extras) because WS
  has no CORS and DNS rebinding presents a mismatched Origin/Host pair; missing Origin is allowed only for
  loopback. Since 2026-10-23 the hub receives the SAME PREDICATE as the `/api/*` gate
  (`originAllowed`, built in server.mjs) instead of a set, so the two cannot drift: an exact
  `host:port` allowlist entry, with a missing Origin port resolved to the scheme default
  (http→80, https→443) — `PI_WEB_TERM_ORIGIN=name:443` for a TLS proxy.
- Own `WebSocketServer` with `maxPayload = MAX_INPUT + 64KB` (the shared 25MB WSS would let one frame
  allocate 25MB/socket).
- Session ids must be unguessable (`validSessionId`: ≥16 chars, not all digits/`-`/`_`) — the id is the
  reattach credential for loopback peers. Ids are sanitized to `[A-Za-z0-9_-]{1,64}` before validation.
- Input backpressure: `writeInput` drops stdin when `stdin.writableLength > 1MB`.
- Outbound backpressure (2026-10-21): `safeSend` TERMINATES a socket whose `bufferedAmount > 4MB`
  (`TERM_MAX_BUFFERED`) — the client reconnects and gets a fresh replay. Deliberately NOT a silent
  frame drop: a dropped `d` frame desyncs the emulator screen with no recovery path.
- Known gap (fixed 2026-10-21, kept for context): `safeSend` used to send unconditionally — a slow
  client could grow an unbounded outbound queue while the shell kept producing output. It now
  terminates the lagging socket (reconnect = replay resync); the SYNC hub's `safeSend` still drops
  frames silently (metadata-only loss).

## Client (`src/ui/terminal.tsx`)

- **Loader** (`wterm-loader.ts`): raced dynamic imports — vendored `/vendor/wterm/wterm.js` (prebuilt
  `@wterm/dom@0.5.4` + core, WASM inlined; regenerate with `node vendor-wterm.mjs`; `--check` mode is
  enforced by build.mjs) → esm.sh → jsdelivr. CDN fallbacks log a loud supply-chain tripwire warning;
  8s timeout per source; a black-holed source can't hang the panel.
- **Connect**: waits (≤300ms) for wterm's first measured `onResize` so the URL carries the REAL grid
  (not 80x24) — the pty paints exactly cols×rows or TUI bottoms crop. Reconnect: ≤6 attempts,
  exponential backoff capped 5s; on `replay` the view is cleared first (`ESC[2J ESC[3J ESC[H`).
- **OSC scanner** (`scanMarkers`): incremental scan for `\x1b]133;D;` / `\x1b]7;` with BEL or ST
  terminators; an incomplete OSC is carried to the next chunk (carry discarded past 4KB). OSC bodies
  are untrusted: the cwd shown in the header is control-char-stripped.
- **Mobile entry bar**: diffs the input's authoritative VALUE per event against a mirror; removals
  become `\x7f`s, insertions stream immediately (bypasses wterm's compose-per-word touch overlay so
  Tab completes without the space+backspace dance); a literal `\n` in the value (Android IMEs) is
  Enter. The mirror is invalidated by every other input path (keys, ^C, command bridge, restart,
  focus) — stale-mirror corruption is the guarded class; the mirror advances only on confirmed sends.
- **Click-to-move** (pty tier, same row only): caret APIs resolve the clicked char index in the row's
  text; the cursor element's index = total text length of preceding siblings; the delta becomes N
  left/right arrow keys (clamped ±500). Attached as a DIRECT host listener (iOS Safari doesn't
  synthesize clicks for root-delegated handlers). A missing `.term-cursor` logs a one-time diagnostic.
- **Key strip** (touch-default, toggle persisted `pi.term.keys`): ↑↓←→ Tab Esc Paste with hold-to-repeat
  on ↑/↓ (350ms delay, 70ms interval, timers cleared on release/cancel/unmount). Buttons
  `preventDefault` on pointerdown to keep wterm's textarea (and the OS keyboard) focused.
- **Resize**: pointer-capture drag with pointercancel handling + userSelect suppression; keyboard
  operable (arrows = ±28, Home/End); persisted `pi.term.h`; dock + strip + entry clamped to 70vh.
- **Command bridge**: a bash tool row's "↗ terminal" sends `command + "\r"` once the shell is
  ready/starting, deduped by `lastSentRef` per active command, and invalidates the entry mirror.
