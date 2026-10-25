# PR — Linux terminal support and pi 1.4.0

**Branch:** `feat/linux-support` · **Base:** `main` · **Status:** merged latest `origin/main` locally; not pushed

## Compatibility update — `main` merge (2026-10-25)

- Merged `origin/main` at `2298a13` into the Linux branch in `402f474`.
- The merge was clean. `agent-hub.mjs` now uses main's centralized `_settleRuntime` path while preserving the Linux branch's retry note and retry-policy result.
- Branch is verified against updated main and is ahead of `origin/feat/linux-support`; the merge has not been pushed.

## Summary

Make the server's terminal and Bash execution usable on Linux while preserving the existing Windows terminal bridge. Upgrade the pi agent packages to 1.4.0, seed an empty model store from pi-ai's builtin catalog, and let API keys entered in Settings reach the default server-side agent.

## Changes

- Resolve Bash paths per platform and terminate POSIX child process groups, including descendants, on abort or timeout.
- On Linux, launch interactive Bash through the system util-linux `script` command when available. This gives Bash and TTY-aware programs such as `nano` a real PTY without a Node/native PTY dependency. Fall back to pipes if `script` is unavailable; full-screen TTY programs are not supported in that fallback.
- Keep the Windows msys `script.exe` PTY bridge and its existing pipes fallback.
- Add Linux terminal and process behavior to CI and smoke tests; assert TTY availability when the PTY tier is selected.
- Upgrade `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core` to 1.4.0, set the app's Node minimum to `22.19.0`, and migrate to the new compat exports and required agent `streamFn`.
- Use the pi-ai builtin model catalog when there is no usable models store, so listed catalog models can also be resolved by the server agent.
- Save keys entered in Settings to browser storage and a private `data/provider-keys.json` server-side store. Preserve `.pi/auth.json` and allow the server agent to read both sources.
- Make `write_file` create missing parent directories by default, matching its documented behavior, and allow callers to opt out with `createDirs: false`.
- Add built-in file-tool regression coverage for Linux workspace paths and preserving CRLF when editing Windows-style files on Linux.

## Validation

- `npm ci`
- `npm run typecheck`
- `npm run build`
- `npm run test:provider-keys`
- `npm run test:provider-models`
- `npm run test:term-platform`
- `npm run test:edit` — 10 checks passed, including Linux workspace paths and CRLF preservation.
- `npm run test:fetch` — 9 checks passed.
- `npm test` — 14 checks passed with Linux `script` installed; confirmed Bash sees a TTY.
- `env PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/sbin "$(node -p 'process.execPath')" tests/term-smoke.mjs` — 13 checks passed with `script` unavailable; confirmed pipes fallback.
- `npm run test:retry` — 31 checks passed.
- After merging updated `main`: `npm run typecheck` and `npm run build` passed.
- After merging updated `main`: `npm run test:security` — 64 checks passed; `npm run test:zombie` — 11 passed; `npm run test:runtime` — 6 passed.
- After merging updated `main`: `npm run test:fetch` — 9 passed; `npm test` — 14 passed, including Linux `script` PTY and TTY checks.
- `npm run test:killstop` did not pass: the test's LLM-backed run never started in this environment, so its kill/stop assertions could not run.

## Limitations

- Linux requires the system util-linux `script` command for a real PTY. If it is absent, basic interactive Bash still works over pipes, but programs that require a TTY (for example, `nano`) do not.
- macOS is not a supported target in this change.
- `test:killstop` requires a configured, usable LLM to exercise an active run; that end-to-end behavior remains unverified here.
