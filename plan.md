# plan.md — Recreate the ChatPanel UI without @earendil-works/pi-web-ui

## Goal

Replace the `@earendil-works/pi-web-ui` dependency with a self-contained Preact chat UI
(`src/ui/`), keeping the parts of pi-web-ui we actually use as **vendored code** in our
repo. The app keeps its engine (`@earendil-works/pi-agent-core` + `@earendil-works/pi-ai`),
server, tools, and storage. nvidia-only provider build stays.

## Non-goals

- No attachments / PDF preview (read_file covers files) → `pdfjs-dist` dropped
- No artifacts panel, no REPL tool (bash replaced them) → dropped
- No i18n (English only), no themes beyond the existing CSS variables
- No new features — parity with what we use today, then slim

## 1. Inventory: what pi-web-ui provides today → disposition

| pi-web-ui piece | Used by | Disposition |
|---|---|---|
| `ChatPanel` + `AgentInterface` (message list, streaming, editor, tool renderers) | main.tsx | **Replace** — `src/ui/chat.tsx` (own implementation, ~400 lines) |
| `SessionListDialog` | main.tsx | **Replace** — `src/ui/session-list.tsx` (we already merge server metadata + have REST) |
| `SettingsDialog` + `ProvidersModelsTab` + `ProxyTab` | main.tsx | **Replace** — `src/ui/settings.tsx` (model, thinking level, API token, proxy on/off) |
| `ModelSelector` | main.tsx | **Replace** — small dropdown from cached config (`pi-import.ts`) |
| `ApiKeyPromptDialog` | main.tsx | **Replace** — reuses the existing 401→prompt pattern (provider keys live in localStorage `pi.key.*`) |
| `AppStorage`, `SessionsStore`, `SettingsStore`, `ProviderKeysStore`, `CustomProvidersStore` | main.tsx, session-sync.ts, pi-import.ts | **Replace** — `src/storage.ts` thin stores over our `LocalStorageBackend` (same keys, see compat) |
| `createJavaScriptReplTool` | main.tsx toolsFactory | **Drop** (bash replaced it; the REPL/artifacts panel was browser-side extra) |
| `defaultConvertToLlm` | custom-messages.ts | **Vendor** — it is a 3-line filter (`role ∈ {user, assistant, toolResult}`); also exported by pi-agent-core — prefer that import |
| `registerMessageRenderer` + `MessageRenderer` type | custom-messages.ts | **Replace** — own renderer registry in `src/ui/chat.tsx` (system-notification renders as a subtle line) |
| `getAppStorage` | session-sync.ts, pi-import.ts | **Replace** — export our own `getAppStorage()` from `src/storage.ts` |
| proxy utils (`createStreamFn`, `applyProxyIfNeeded`) | AgentInterface internal | **Vendor** — `src/ui/proxy-stream.ts`, port of `dist/utils/proxy-utils.js` (~80 lines, see contract below) |
| markdown rendering (`marked`) + code highlight (`highlight.js`) + icons (`lucide`) | dist components | marked+highlight.js: **add `marked` dep** (highlight.js already present); lucide: **drop** (no icons — user confirmed) |

## 2. Contracts to replicate (verified against dist / types)

### 2.1 StreamFn (LLM connectivity — the critical piece)

```ts
// pi-ai: streamSimple(model, context, options) — the real HTTP call
// pi-web-ui proxy pattern (utils/proxy-utils.js) — ported verbatim:
streamFn = async (model, context, options) => {
    const proxyUrl = await getProxyUrl();                    // localStorage settings "proxy.url" (pi.proxyUrl)
    if (!options?.apiKey || !proxyUrl) return streamSimple(model, context, options);
    // auth stays in options.apiKey → streamSimple sends Authorization to model.baseUrl,
    // which the proxy forwards to the real provider
    return streamSimple({ ...model, baseUrl: `${proxyUrl}/?url=${encodeURIComponent(model.baseUrl)}` }, context, options);
};
```

- `streamSimple` is exported by `@earendil-works/pi-ai` (same import AgentInterface used).
- Proxy on/off: localStorage `pi.proxyEnabled` / `pi.proxyUrl` (seeded at boot, existing keys).
- If `!apiKey && !proxyUrl` → direct call (current behavior preserved).
- **apiKey source (verified)**: `getApiKey = async (provider) => providerKeys.get(provider) ?? undefined`
  (providerKeys store = localStorage `pi.key.*`). Port this into the Agent options.
- **Proxy decision (verified)**: port `shouldUseProxyForProvider` verbatim — it encodes CORS
  knowledge: zai → always proxy; anthropic OAuth → proxy; openai/google/groq/openrouter/
  cerebras/xai/ollama/lmstudio/copilot → direct; **default (nvidia, deepseek) → proxy**.
- **No header map / no 401 hook / no reasoning mapping exists in pi-web-ui** (grep: its
  streamFn is proxy-utils only; there is no stream.js). Anything else (headers, 401 dialog
  hook, thinking-level mapping) is our own code's job — P2 tasks below.
- **Clone before proxy**: `applyProxyIfNeeded` returns a new object in pi's impl — keep that
  (never mutate the catalog `model` in place, or proxy on→off leaves it permanently proxied).
- **Final shape (grok-reviewed)**:

```ts
const streamFn: StreamFn = (model, context, options) => {
  const m = { ...model, baseUrl: model.baseUrl };   // clone-before-proxy
  applyProxyIfNeeded(m, settings.proxyUrl);          // no-op if proxy empty
  return streamSimple(m, context, {
    ...options,                                      // signal, temperature, reasoning — never swallow signal
    apiKey: options.apiKey ?? (await providerKeys.get(m.provider)),
  });
};
```

- **401 handling**: pi-web-ui triggered `ApiKeyPromptDialog` via `onApiKeyRequired` (setAgent
  config). Our UI must catch 401/invalid-key stopReason from the stream and open the key
  dialog — P2 task, not streamSimple's.

### 2.2 Agent events (agent.subscribe) — pi-agent-core/types.d.ts

`agent_start`, `agent_end{messages}`, `turn_start`, `turn_end{message,toolResults}`,
`message_start{message}`, `message_update{message, assistantMessageEvent}`,
`message_end{message}`, `tool_execution_start{toolCallId,toolName,args}`,
`tool_execution_update{toolCallId,toolName,args,partialResult}`,
`tool_execution_end{toolCallId,toolName,result,isError}`.

Render rules (grok-reviewed):
- **Plain text while streaming, markdown once on `message_end`** — never `marked` per delta
  (quadratic reparse + mid-fence broken HTML). `message_update` is a full-content snapshot:
  replace the bubble from `message.content` (one source of truth — the idle re-sync depends
  on this), never append deltas. Ignore updates after `message_end` for that message.
- Thinking parts → separate collapsible, plain text while streaming (never folded into the
  markdown document — scrambles fences)
- ToolCall parts → never markdown; P3 rows keyed by **`toolCallId`** (never by index)
- `stopReason: "aborted"|"error"` → freeze + error/aborted chrome (distinct — retry must not
  double-run a cancelled tool)
- **XSS**: assistant text is untrusted — sanitize `marked` output (add `dompurify`; or strip
  raw HTML + block `javascript:` links). Check whether pi-web-ui sanitized; don't copy the
  hole either way.
- buggy `message_end`-clears-mid-run issue does not apply to our own renderer (we replace,
  never clear)

### 2.3 Message shapes (pi-ai types)

- `UserMessage { role:"user", content: string | (Text|Image)[] }`
- `AssistantMessage { role:"assistant", content: (TextContent|ThinkingContent|ToolCall)[], stopReason, errorMessage?, usage }`
- `ToolResultMessage { role:"toolResult", toolCallId, toolName, content:(Text|Image)[], details?, isError }`
- Render: user text plain; assistant text → `marked` + highlight.js; thinking → collapsed
  `<details>`; toolCall + matching toolResult → one compact row (name, args preview, output
  tail, isError styling). Custom `system-notification` message → subtle line (custom-messages.ts).

### 2.4 Editor

- Textarea (auto-grow), Enter=send, Shift+Enter=newline, IME-safe (isComposing check)
- Streaming → Send becomes Stop (agent.abort? check Agent API: `agent.abort?.()` — verify
  against agent.d.ts during implementation)
- Disabled while streaming (existing double-send guard)

### 2.5 Storage (localStorage keys preserved — no migration)

- `pi.key.<provider>` (provider keys), `pi.lastModel`, `pi.lastThinkingLevel`,
  `pi.proxyEnabled`, `pi.proxyUrl`, `pi.webToken`, `pi.session`/URL param
- Stores (our LocalStorageBackend, existing): `sessions` (body), `sessions-metadata`,
  `settings`, `provider-keys`, `sync-tombstones`
- `src/storage.ts` store classes must expose exactly: `sessions.{save,get,getMetadata,delete}`,
  `sessions-metadata` via backend, `settings.{get,set}`, `provider-keys.{get,set}`
  (grep-verified: these are all our code calls)

### 2.7 UI chrome checklist (grok — minimum, P1/P2 not "P4 polish")

Must keep (day 1): Stop/abort wired to the same AbortSignal tree as streamSimple AND
in-flight bash taskkill · disable send while running (double-submit = crossed toolCallIds) ·
error chrome + Retry (= resend last user message as a NEW turn, never replay tool calls ·
aborted ≠ error so Retry doesn't double-run) · copy on assistant messages · auto-scroll with
"stick unless user scrolled up" · thinking block (GLM looks idle/broken without it) · tool
row expand/collapse + isError styling + partial tail · model selector + key prompt + proxy
field · session list + new session + JSONL persist · **text labels on buttons** (icon-less
was chosen; unlabeled icon-only is not acceptable).
Should keep (cheap): usage/cost line on agent_end · compaction indicator if the loop
compacts · draft persistence in localStorage · Enter/Shift+Enter.

### 2.8 Loop invariants (grok — preserve as P2/P3 acceptance TESTS, not comments)

1. One AbortSignal tree: Stop → abort LLM stream → abort in-flight tool (taskkill) →
   waitForIdle → only then accept a new send. Idle re-sync runs on `agent_end` AND abort.
2. `tool_execution_update`/`partialResult` NEVER enters `messages`/convertToLlm (grep-verified
   in pi-agent-core: pure event). Renderer must not re-append partials into the transcript.
3. `defaultConvertToLlm` role filter must keep `toolResult` (incl. isError:true) — else GLM
   retries blind.
4. `AssistantMessage.content` is a mixed array — never flatten for the LLM path (thinking
   leaks, tool calls vanish).
5. Tool row identity = `toolCallId` (index reuse paints two tails onto one row).
6. No extra JSON encode/decode of tool params in the UI (bridge owns the escape ladder).
7. Session switch mid-turn: abort → waitForIdle → load other session (no cross-session bleed).
8. `agent_end` with stopReason error after a successful tool write: Retry = new turn with
   current messages — never blind replay of edit/write_file (file is already mutated).

### 2.6 Session save/restore (unchanged)

- `saveSession()` shape, `shouldSaveSession`, 1200ms debounce, `?session=` restore,
  session-sync WS push — all stay as-is (only `getAppStorage` import source changes).

## 3. New files

| File | Contents | ~LOC |
|---|---|---|
| `src/ui/chat.tsx` | message list, streaming render, tool rows, editor, stop, scroll behavior | 420 |
| `src/ui/markdown.ts` | marked + highlight.js wiring (code blocks w/ language class) | 60 |
| `src/ui/proxy-stream.ts` | vendored proxy-utils (createStreamFn/applyProxyIfNeeded/shouldUseProxyForProvider) | 90 |
| `src/ui/session-list.tsx` | dialog: local metadata + server merge, click→loadSession, delete | 90 |
| `src/ui/settings.tsx` | dialog: model select (cached config), thinking level, API token, proxy toggle | 120 |
| `src/ui/model-selector.tsx` | dropdown (cached config providers/models) | 60 |
| `src/storage.ts` | store classes over LocalStorageBackend (same keys), `getAppStorage()` | 120 |

Deleted: `src/custom-messages.ts` renderer-registry half (keep `customConvertToLlm` — move
to `src/llm.ts`), `src/patches/*` stubs for packages that no longer exist (docx/xlsx/jszip/
mistral/model-discovery aliases become unnecessary — remove from build.mjs), `Icon`/`ICONS`
stays (inline SVG in main.tsx already).

## 4. Dependency changes

**Rule (user):** only remove dependencies >1MB (npm disk or notable bundle share).
Small deps stay.

Remove (>1MB each, measured on disk): `@earendil-works/pi-web-ui` (the framework
itself), `@mariozechner/mini-lit` 2MB (+lit), `lit` family ~7MB (lit-html 3MB,
@lit 2MB, lit-element 1MB, lit 1MB), `lucide` 24MB, `pdfjs-dist` 36MB,
`katex` 5MB (transitive — auto-pruned).
Keep: `preact` (2MB disk / ~4KB gz), `highlight.js` (9MB disk but only
lib/common ~40KB gz is bundled — existing alias), `diff`, server-side hono/ws/undici.
Add: `marked` (~10KB gz), `dompurify` (~8KB gz).

**Sonnet-5-search survey (§8 round 2):** marked+DOMPurify+hljs/common is the de
facto LLM-chat stack (open-webui, HF chat-ui). markdown-it 4x marked; micromark
needs hand-assembly; snarkdown lacks tables; shiki async+WASM; Prism saves only
~10-20KB vs hljs/common at real integration cost — skip. CSS: keep copying
pi-web-ui's built `app.css` as a STATIC ASSET (12KB br) — supplies all theme
css-variables for the new Preact UI; no tailwind build step, no npm dep.
Keep: `preact`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, `hono`,
`@hono/node-server`, `ws`, `undici`, `diff`, `esbuild`, `typescript`.
Remove from build.mjs aliases: docx-preview, xlsx, jszip, @mistralai (stubs no longer
needed — the packages are gone; pi-ai's other provider SDKs stay overridden to
`stubs/empty` — openai-compatible only).

Expected: node_modules 151MB → ~110–120MB (lucide 24, pdfjs 36+@napi-rs stub,
mini-lit/lit/katex ~8). Bundle 1.89MB → ~1.3–1.5MB (drop ChatPanel/artifacts/attachments/
i18n; add own UI + marked).

## 5. Implementation phases — ALL COMPLETE (P0–P4 shipped + grok-4.6-high reviewed each)

- **P0** ✅ `src/storage.ts` + `src/llm.ts` + import swaps (review fixes: has/list fast-tier,
  updateTitle bump, AppStorage setBackend invariant, getMetadataConfig index parity)
- **P1** ✅ `src/ui/chat.tsx` render (review fixes: markdown memo, WeakMap stable keys,
  partials/stick reset on agent change, aborted tool-row chrome, lang whitelist + hljs cap,
  wheel/touch unstick, FORBID_ATTR)
- **P2** ✅ editor + send/stop + proxy streamFn (review fixes: bounded serverKey wait,
  send-guard until isStreaming, retry strips dangling toolCalls)
- **P3** ✅ tool rows + bash partials + error/abort render (live-verified incl. 403 key flow)
- **P4** ✅ dialogs + pi-web-ui REMOVED (review fixes: delete-resurrection guard, title draft
  input, genStatus removed, importKey wired, Escape-to-close, picker provider fallback,
  flush-before-switch, proxy seeding dedup). Bundle 1.98MB → 0.99MB (0.19 br);
  node_modules 151MB → 75MB.

## 6. Verification checklist (CDP, same as established)

1. Boot: no console errors, editor renders, tools registered (`__piServerTools`)
2. Send "hello" → streaming assistant bubble grows, final text + usage; session auto-saved
3. "Use ls to list the workspace" → tool row renders, bash partials stream, result ok
4. "edit ws/pi-web-ui/data/x.txt to say Y" → edit tool row + diff
5. Reload → session restores with all messages (line-for-line vs pre-reload)
6. Session list: open, switch sessions, delete
7. Settings: switch model (glm↔deepseek), thinking level; persist across reload
8. 401 token flow still prompts (localStorage `pi.webToken`)
9. Bundle size + node_modules size recorded before/after

## 7. Risks

- **streamFn subtleties**: `streamSimple` option plumbing (apiKey, headers, abort) —
  mitigate by porting proxy-utils verbatim and testing a real turn early (P2 gate)
- **assistantMessageEvent deltas**: exact delta semantics (text delta vs thinking delta vs
  toolCall creation) — verify with a real streaming turn in P1 before building polish
- **markdown edge cases** (tables, inline code in GLM output): marked is the same lib the
  old UI used → parity
- **localStorage schema drift**: none — keys unchanged; sessions JSONL mirror unchanged;
  server unchanged
- **REPL/artifacts loss**: intentional (bash covers it); restore path = keep the vendored
  dist files in git history
- **Rollback**: pi-web-ui removal is the LAST commit; until P4 verifies, the old UI is one
  `git checkout` away

## 8. Grok review rounds — incorporated

**Round 3 (P2/P3):** replacement keys via providerKeys.set already mirror to LS
(built-in P0) ✓ · post-timeout `await serverKey` now bounded (8s) ✓ ·
`sending.current` held until the run actually starts (isStreaming poll, 1s cap) ✓ ·
Retry strips dangling toolCalls (no toolResult → tool_use without tool_result is
invalid; last assistant only, placeholder text if empty) ✓ · P4 constraints:
re-assign streamFn/getApiKey on every createAgent (session switch), settings must
write the SAME LS keys (pi.proxyEnabled/pi.proxyUrl + pi.key.* via the store),
never mutate catalog baseUrl, agent identity change = new Agent (partials/stick
reset), draft key global.

**Round 2 (deps, sonnet-5-search):** marked+DOMPurify+hljs/common confirmed;
see §4.

**Round 1:** see §8 history in git (P1 render rules, §2.7 chrome, §2.8
invariants — all incorporated during P1/P2/P3).

- **P2 explicit tasks** (not implied by "port proxy-utils"): clone-before-proxy · 401 → key
  dialog hook · grep for extra headers (done: pi-web-ui has NO stream.js — no header map,
  no reasoning mapping exists; nothing else to port) · thinking-level→options verified with
  a real turn
- **P1 render decision**: plain text during stream, markdown on message_end (no marked hot
  path)
- **P2 acceptance tests**: tokens appear · Stop aborts LLM + bash · idle re-sync on
  agent_end AND abort · proxy on→off clone test · 401 dialog flow
- **Minimum chrome in P1/P2** (§2.7) — not P4 polish
- **Sanitizer**: add `dompurify` with marked (assistant text = untrusted)
- **Feature-flag old vs new panel** until the CDP extras pass; pi-web-ui stays installed
  until P4; grep src + dynamic imports at removal (Watch Settings/ModelSelector/ApiKeyPrompt
  second-path imports)
- **CDP checklist additions**: stop mid-LLM → aborted chrome + send re-enabled · stop
  mid-bash → NDJSON abort → taskkill · session switch mid-turn → no bleed · proxy on→off →
  next turn direct (clone test) · 401 flow · GLM thinking+tool+text in one turn → three
  regions · isError tool result styled AND present in next model context · partial bash
  tails NOT in messages JSONL · XSS: `<img onerror>`/`<script>` in assistant text does not
  execute
- **Extra C/D**: ~ expansion (already in normalizePathArg) · write_file createDirs default
  false with hint (shipped) · write_file in mutation queue (shipped) · {value:...} coercion
  + raw-shape logging via audit (shipped)
- **Deps**: + `marked`, + `dompurify`; drop list unchanged

## 9. Out of scope (this plan)

- Attachments/images in chat (drop; read_file covers files)
- i18n, themes, katex math rendering
- Server-side changes (none needed)

## 10. Post-P4 user feedback round (shipped + grok-reviewed)

- **Top toolbar** in the chat area (was editor-row button): model pill → picker
  dialog, **effort pill** (invisible native select over an arena-style pill —
  native mobile picker, no custom popover). Arena.ai DOM inspected as reference
  (composer pills; effort embedded per-model there — we keep a separate pill).
- **Usage bar under the chat area**: context-window % (last-call usage /
  model.contextWindow, prefers `usage.totalTokens`, decimals <1%, amber ≥70%,
  red ≥90%, tooltip shows the in/cacheR/cacheW/out split) + session totals.
  NOT a portable next-call estimate — provider usage shapes differ (grok p5).
- Drift fix: toolbar + Settings both write `agent.state.thinkingLevel` + LS and
  broadcast `pi-agent-state-changed` (main re-renders shell). Settings select is
  controlled by agent.state directly (no stale local snapshot).
- a11y: focus-within outline on the pill, select opacity 0.01 + font-size 16px
  (iOS zoom), aria-hidden visual spans, aria-haspopup on the model pill,
  min-height 30px touch target, M token formatting, aria-live on warn/critical.

## 11. Design round (sonnet-5-high spec + grok-4.6-high review, shipped)

- Pills moved INTO the composer (arena pattern): [model pill][effort pill] left,
  Send right, textarea above — inside one 16px-radius card. Top toolbar removed.
- **Effort = native select styled AS the pill** (fixes user-reported invisible
  dropdown: `color: transparent` on a select inherits into the opened options —
  the select now has real `var(--foreground)` color, transparent background,
  `appearance:none`, border-triangle caret, option palette foreground/card,
  `color-scheme` light/dark declared).
- Stats microcopy: no "context" word — `0.2% · 2.1k / 1M tok` + totals right;
  pct span colored via data-level (warn/danger fixed hues); prefers-last-call
  totalTokens; tooltip = in/cacheR/cacheW/out split; tabular-nums.
- Thread polish: user bubble right-aligned (14/14/4/14 radius, 75%/85%),
  assistant flat, thinking = 2px rail, tool rows 10px + hover, focus-visible
  double-ring on everything interactive, reduced-motion respected, tool state
  colors tokenized (--stat-ok/--stat-danger).
- Grok p6 fixes: shared gutter (thread/composer/stats all calc(48rem+40px)
  border-box), label hit target (pointer-events:none + <label> wrapper), select
  min-width 4.5ch (stable pill width), mask carets → border triangles (Safari
  luminance trap), assistant-row width, tool min-width for ellipsis,
  color-mix fallback line, legacy user-message-container class dropped.

## 12. Attachments round (user request: workspace files + clipboard paste)

- **Server** (+2 endpoints, restarted): `/api/ws/files` (structured listing,
  dirs-first, dotfile filter, containment via assertInsideRoots) and
  `/api/ws/file` (text w/ NUL-sniff or image → base64; 8MB cap).
- **Grok p7 security fixes (no-ship → fixed)**: dotfiles hidden + dotfile path
  segments 403 (.pi/auth.json leak); `/api/ws/file` ALWAYS-token via
  tokenMatches (secrets oracle, same as exec bridge — the `if (TOKEN)` form was
  dead code when PI_WEB_TOKEN unset); hasDotSegment realpaths BOTH sides;
  workspace-RELATIVE paths in JSON (absolute leaked layout + broke breadcrumbs);
  error strings stripped of workspace prefix.
- **Client**: `src/ui/file-picker.tsx` (breadcrumbs, filter, stale-row clearing,
  pre-fetch size gates 8MB/512KB); composer "​+ files" pill; attachment chips
  (text name+✕, image thumbnail+✕, vision warning in title); clipboard paste
  (MIME allowlist png/jpeg/gif/webp — HEIC/AVIF rejected with note; 8MB cap);
  send inlines text files as fenced blocks (fence > inner backtick run,
  "--- file: rel/path ---" header) and passes images via agent.prompt(text,
  images) → ImageContent; empty text + images → single-space placeholder
  (Anthropic rejects empty text blocks); restore draft AND attachments on
  failure; limits 6 text files / 4 images.
- Verified: containment + dotfile 403 + always-token 401/200; picker nav + both
  chip kinds + paste; empty-text image-only turn — GLM described the image
  ("solid red 1×1 pixel PNG"); zero exceptions.
- Follow-ups (accepted, not blocking): drag-drop (P2); persist-time image
  placeholder in JSONL (base64 images + localStorage eviction interplay —
  server mirror is the durable copy); iOS clipboardData.files walk.

## 15. Explorer fixes + syntax highlighting (user reports)

- **First-click bug (user report: "doesn't show file at first, shows at second
  try")**: `select()` computed the cache key from the CLOSURE `path` — stale
  until the next render — so the initialFile path fetched the wrong key. Fixed:
  `select(entry, dirOverride?)` — the initialFile effect passes the fresh parent
  dir explicitly; the stale early-return guard removed (cache makes repeat
  clicks free anyway).
- **Syntax highlighting (user request)**: preview code view now hljs-highlights
  by extension (js/mjs/cjs/jsx, ts/tsx, py, json, css/scss/less, html/xml/svg,
  md, yml, sh/ps1/bat, c/cpp/cs/java/rs/go/php/rb/swift/kt, sql/toml/ini/diff —
  CODE_LANG map). Structure: sticky line-number gutter (plain text 1..N, same
  line-height, no wrap so gutter/code stay aligned — verified 1498/1498) +
  highlighted `<pre>` block (5394 hljs spans on server.mjs). Prose (md/txt/log)
  stays gutter-less humanist flow. Truncation note appended inside the block.
  Replaced the per-line flex rows (wrap desynced gutter numbers).

## 13. Two-pane file explorer (user request: "tab layout, left 20-30% file list
with modified time, right pane contents")

- `src/ui/file-picker.tsx` rewritten as an explorer: dialog 960px/74vh; left
  pane 30% (dirs first name-asc, files mtime-DESC with `size · mtime` meta),
  right pane = preview (text → mono `<pre>` truncated at 120KB w/ note; image →
  checkerboard wrap) + Attach button in the preview head. Column stack <760px.
- Interaction (grok p8): click file → preview (no-op if already selected),
  Attach button attaches, dialog STAYS OPEN for multi-attach with "✓ attached"
  row markers keyed by FULL PATH (name-keying lit the wrong row across dirs);
  dblclick removed (dir double-click click-through footgun); preview cache per
  dialog lifetime keyed by path.
- Grok p8 fixes applied: client-side sort (server order not guaranteed),
  generation guards on load/select (superseded responses dropped), setError at
  select start, 512KB text gate in select (no 7MB preview fetch), 512KB
  attach gate only on text after kind known (images ≤8MB attach fine), first
  open = single `load("ws", {fallbackRoot:true})` (no root flash), filter
  cleared on nav, keyboard nav deferred.
- Verified: remembered dir reopens (workspace›ws›pi-web-ui), re-click no-op,
  full-path marker, image preview + vision turn, attach+send E2E, zero
  exceptions.
- Follow-ups: arrow-key list navigation (needs focus-mode design), mobile
  single-pane variant, sort toggle.

## 14. Clickable file names in chat (user request)

- Composer chips: file NAME is a button → opens the explorer WITH that file
  previewed (`initialFile` prop on FilePickerDialog: loads the parent dir,
  selects + previews). ✕ still removes.
- Sent user messages: `--- file: path ---` headers are parsed and rendered as
  clickable chips under the message text → same explorer view. Persistent
  record of what was attached, one click to re-view.
- Attach state lifted to ChatView (Editor renders chips from props) so both
  entry points share one FilePickerDialog instance + attach state.
