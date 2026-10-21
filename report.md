# Code Review Report

Review date: 2026-10-21

## Summary

The review found two high-impact browser-to-localhost trust-boundary issues, plus four correctness or resilience defects. The most serious paths expose provider credentials and session history to pages that should not be trusted. No application code was changed as part of this review.

## Findings

### P1: DNS rebinding bypasses loopback authentication and exposes privileged APIs

**Locations:** [server.mjs](server.mjs#L99-L113), [server.mjs](server.mjs#L1008-L1012), [server.mjs](server.mjs#L1123-L1131), [server.mjs](server.mjs#L1560-L1563)

**Review comment:** `authorized()` trusts the peer address, not the browser origin, and therefore exempts every request arriving over loopback. The server listens on all interfaces by default. In a DNS-rebinding scenario, a browser page can retain an attacker-controlled hostname as its origin while that hostname resolves to this server; the request still arrives from loopback. The proxy's Origin check compares against the request URL's Host-derived origin, which does not establish that the origin is trusted. The adjacent `/api/pi/keys` handler returns configured provider keys without a route-specific token check.

**Impact:** If the browser/network configuration permits this request path, a hostile page can access secrets held by the local app. The proxy also accepts arbitrary HTTP(S) destinations and follows redirects, so a caller with access to the route may cause the server to contact services reachable from the host, including private or loopback endpoints. This is a separate SSRF boundary from browser-origin validation.

**Recommendation:** Require a token on secret-bearing and proxy routes even for loopback callers. Validate browser Origins against an explicit allowlist of actual app origins rather than deriving trust from `Host`. For the proxy, reject private, loopback, link-local, and otherwise disallowed resolved addresses, and revalidate redirect destinations so a public URL cannot redirect into a restricted network.

**Regression coverage:** Verify unauthenticated loopback requests cannot read provider keys or invoke the proxy; verify the allowlisted app origin succeeds and an unrelated origin fails; verify proxy targets resolving to restricted addresses and redirects to restricted addresses are rejected. Include IPv4 and IPv6 cases.

### P1: Cross-origin pages can read or control `/ws/sync` and `/ws/agent`

**Locations:** [server.mjs](server.mjs#L1560-L1564), [server.mjs](server.mjs#L1309-L1318), [server.mjs](server.mjs#L1350-L1357)

**Review comment:** The upgrade handler applies token validation only to non-loopback peers. It dispatches `/ws/sync` and `/ws/agent` without validating the handshake's browser-supplied `Origin`. WebSocket handshakes are not protected by the browser's ordinary cross-origin fetch/CORS checks, so a page from another site can attempt to connect to the local endpoint. The terminal path has its own Origin allowlist, but that check does not cover these two paths.

**Impact:** A successful `/ws/sync` connection receives the session list immediately and can request a session body by ID. A successful `/ws/agent` connection can send the protocol's attach, prompt, and control messages. This can expose conversation history or cause local agent actions, depending on the browser's localhost/network restrictions and the running app configuration.

**Recommendation:** Enforce an explicit Origin allowlist for both paths before upgrading, including loopback connections. Keep token authentication for non-browser clients; do not treat Origin as a replacement for the token. If non-browser clients legitimately omit Origin, define that policy explicitly rather than accepting arbitrary present Origins.

**Regression coverage:** Add handshake tests for allowed, disallowed, absent, and malformed Origin values on both paths. Confirm the same disallowed Origin remains rejected from loopback, and retain a positive test for the terminal path so the three upgrade routes have consistent coverage.

### P2: Diagnostics fallback writes unescaped data as same-origin HTML

**Locations:** [diag-panel.tsx](src/diag-panel.tsx#L38-L46), [main.tsx](src/main.tsx#L298-L305), [main.tsx](src/main.tsx#L652-L656)

**Review comment:** When clipboard access fails, the diagnostics panel creates an `about:blank` window and interpolates the report into `document.write`. The attempted replacement, `report.replace(/</g, "<")`, leaves `<` unchanged. Failed session loading logs the `session` query parameter, and diagnostics includes the client log entries.

**Impact:** If a user opens a crafted session URL, then uses the diagnostics fallback, the query value can be interpreted as markup in a window opened by the app. Because the new document inherits the opener's origin, executable markup could act with the app's browser privileges. The path requires user interaction with the fallback, but the data source is URL-controlled.

**Recommendation:** Avoid `document.write` for report content. Create a `<pre>` element and assign the report through `textContent`; alternatively, use a complete HTML escaping routine before interpolation. Consider redacting URL-derived values from diagnostic logs as defense in depth.

**Regression coverage:** Stub clipboard failure, provide diagnostic text containing HTML metacharacters, and assert the fallback displays the text literally without creating executable elements. Include a failed `?session=` load in the fixture.

### P2: Concurrent SSE subscriptions overwrite the shared broadcast callback

**Location:** [agent-hub.mjs](agent-hub.mjs#L208-L216)

**Review comment:** Each `onEvents()` call wraps the singleton `this.broadcast`; its unsubscribe closure later restores the broadcaster captured when that subscription began. This models subscriptions as nested global replacements rather than independent listeners.

**Impact:** With two overlapping subscribers, unsubscribing the older one first restores the base function and stops delivering events to the still-open subscriber. Unsubscribing in the reverse order can restore a wrapper belonging to a closed subscriber. The issue is observable when multiple clients subscribe to `/api/agent/events` for the same session; event delivery can silently stop or continue invoking a closed response callback.

**Recommendation:** Keep callbacks in a per-session subscriber set and have one stable broadcaster fan out to the current set. Unsubscribe should remove only its own callback and be safe to call more than once.

**Regression coverage:** Subscribe clients A and B, emit an event, unsubscribe A, and verify B still receives subsequent events. Repeat with the opposite unsubscribe order, and verify no callback is invoked after its own unsubscribe.

### P2: Session `watch` updates send an undefined data field

**Locations:** [server.mjs](server.mjs#L1284-L1290), [server.mjs](server.mjs#L1350-L1357), [session-worker.mjs](session-worker.mjs#L48-L57)

**Review comment:** The worker's `get` result contains `{ jsonl, metadata, messages }`. The explicit sync `get` handler adapts this to `data: { messages: j.messages }`, but `pushWatched()` instead serializes `data: j.data`, which is not present on the worker result.

**Impact:** Both the initial response to `watch` and notifications after a session `put` omit the session body (`data` is undefined and therefore absent in JSON). A consumer relying on the documented sync message shape cannot update the watched session. The current browser client does not issue `watch`, so this is a protocol defect without a demonstrated impact on the current UI.

**Recommendation:** Reuse the response shape from the explicit `get` branch, including `data: { messages: j.messages }`, and keep the `metadata` and `jsonl` fields consistent if consumers rely on them.

**Regression coverage:** For a stored session, verify `watch` immediately returns its messages. Then `put` an updated body and verify a subsequent watch notification contains that updated body and metadata.

### P2: Terminal output has no outbound WebSocket backpressure limit

**Locations:** [terminal-hub.mjs](terminal-hub.mjs#L199-L204), [terminal-hub.mjs](terminal-hub.mjs#L476-L497)

**Review comment:** The terminal hub's `safeSend()` checks only `readyState` and calls `ws.send()`; unlike the session sync path, it does not inspect `bufferedAmount`. `flush()` broadcasts each process-output frame to every attached socket. A capped replay ring limits retained history but does not limit data queued by the WebSocket implementation for a slow client.

**Impact:** A connected client that stops reading can accumulate queued terminal output while the process continues to produce data. Sustained output may consume substantial memory and degrade the server for other sessions. This also conflicts with the backpressure behavior described in `docs/architecture.md` and `docs/terminal.md`.

**Recommendation:** Set a per-socket outbound threshold and define what happens when a client exceeds it, such as closing the lagging socket and allowing it to reconnect with replay. Avoid silently dropping arbitrary terminal chunks unless the protocol communicates a gap and provides a recovery path.

**Regression coverage:** Simulate a socket whose `bufferedAmount` exceeds the threshold, produce terminal output, and verify the chosen recovery behavior occurs without blocking delivery to other attached clients. Also verify a client below the threshold continues receiving output.

## Verification

- `npm run typecheck`: passed.
- `get_errors` workspace check: no errors reported.
- `term-smoke.mjs` and browser/CDP checks were not run. The available terminal smoke harness launches and kills a Windows-oriented server process, so it was not exercised in this Linux environment.

## Scope

Reviewed the core server/API/auth/proxy paths, terminal and session WebSockets, session worker and browser sync/storage, agent hub, client boot and diagnostics, Markdown rendering, and build/test entry points. Documentation was used as supporting context and cross-checked against implementation where it informed a finding.