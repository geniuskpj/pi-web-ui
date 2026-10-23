# PR — Linux terminal support and pi 1.4.0

**Branch:** `feat/linux-support` · **Base:** `feat/auth-gate-retry` · **Status:** local, not pushed

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

## Validation

- `npm ci`
- `npm run typecheck`
- `npm run build`
- `npm run test:provider-keys`
- `npm run test:provider-models`
- `npm run test:term-platform`
- `npm test` — 14 checks passed with Linux `script` installed; confirmed Bash sees a TTY.
- `env PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/sbin "$(node -p 'process.execPath')" tests/term-smoke.mjs` — 13 checks passed with `script` unavailable; confirmed pipes fallback.
- `npm run test:retry` — 31 checks passed.

## Limitations

- Linux requires the system util-linux `script` command for a real PTY. If it is absent, basic interactive Bash still works over pipes, but programs that require a TTY (for example, `nano`) do not.
- macOS is not a supported target in this change.
