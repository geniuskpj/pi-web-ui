# plan-mobile-data.md — mobile data reduction (images · WS compression · atomic turns)

> ## DECISIONS 2026-10-25 (implemented — this block overrides the sections it names)
>
> * **Item 3 (atomic turns) is DROPPED.** Single-digit KB per turn for a protocol branch that touches
>   retry/steer/versions/sparse attach. What shipped instead: per-kind coalescing
>   (`lib/thinking-flush.mjs`, `lib/stream-reduce.mjs`) with the three user levels **paragraph ·
>   turnEnd · none**, applied per CONNECTION and **OFF by default** (`setDataReduction`).
> * **Item 2 (WS deflate) is DONE** — the terminal WSS now negotiates `permessage-deflate` like the
>   agent socket (`tests/ws-deflate.test.mjs`: 11 checks, 0 pending).
> * **Item 1 changed shape.** The browser now ENCODES the image (resize + webp) and only the encoded
>   bytes are ever stored; the server keeps them as **binary** (disk, content-addressed) and produces
>   base64 **only when the LLM request is built**. No raw original is saved anywhere, and no base64 is
>   stored. §2.2b's "session files keep full ImageContent" is therefore REVERSED: the transcript keeps
>   `{hash, bytes}` references and the bytes live in the media store. New routes:
>   `POST /api/agent/session/:id/media` (binary in) and `GET …/media/:hash` (binary out, br/gz when a
>   variant pays).
> * **gz/br on images: measured, and it does NOT help** (`tests/image-compression.test.mjs`): an
>   encoded webp/jpeg/PNG gains ~0% from gzip/brotli (they are already entropy/deflate coded). The
>   only thing that pays is base64 — gz/br recovers ~25% of its 33% inflation, i.e. exactly the harm
>   that storing binary removes. The store keeps a variant only when it clears 3%.
> * **User-selectable levels** replaced the net tiers in the UI: images **high · medium · low · none**
>   and streaming **paragraph · turnEnd · none** (plus `auto`), persisted in localStorage and shown with
>   their resolved parameters; the tier table below is only what `auto` resolves to.


**Status:** design only, no code touched. Written 2026-10-25 for a fresh implementation session.
**Repo:** `C:\pi-windows-x64\ws\pi-web-ui` (branch `main`), Node ≥22, `npm run typecheck` / `npm run build` /
`npm run test:<suite>` (20 suites, all green at the time of writing), pi-ai 1.4.0 pinned.
**How to use this file:** read §1 (what to read), then pick a phase from §9. Every snippet in §4 is a
starting point, not a patch: adapt names to what you find. Line numbers drift — the *names* are the anchors.
**Conventions that apply** (from `.pi/WEB_SYSTEM.md`, `README.md`, `docs/lessons.md`): ask before deleting
files; single commit per concern; update README + docs in the same commit and re-copy
`README.md` → `C:\pi-windows-x64\docs\pi-web-ui.md` (byte-identical); keep `git diff --stat` ==
`git diff -w --stat` (no whitespace-only churn); for nested/CRLF files prefer an anchored splice script
over eyeballing whitespace.

---

## 0. TL;DR — what to build, in what order

| # | Item (user request) | Verdict | Effort |
|---|---|---|---|
| 2 | "compressed websocket transmission by deflate" | **the agent socket already does it** (`server.mjs` agent WSS has `perMessageDeflate`). Only the **terminal WSS** is missing it. | ~10 lines |
| 1 | "automatic image resize (server/browser) + webp on mobile" | **the big win — but the win is EGRESS, not the resize.** Resize/WebP on the client before send, *and stop inlining base64 images in every attach/replay*; serve them as immutable HTTP resources keyed by content hash. | 1–2 days |
| 3 | "turn off streaming, send the turn as one gz/br message" | **defer.** First drop the deflate `threshold` 1024 → 256 and measure; if frame count still bothers you, coalesce `message_update` every ~50 ms. A real atomic mode touches retry/steer/versions/sparse-attach and buys single-digit KB per turn. | 1 day (optional) |

**Do not** add application-level gzip/brotli over WebSocket. `permessage-deflate` *is* the compression
layer; brotli is only usable on HTTP (`Content-Encoding: br`, browser decodes natively). The browser's
`CompressionStream` has gzip/deflate but **no brotli**, and browsers **cannot opt out** of
`permessage-deflate` — only the server can refuse the extension.

Expected outcome if you do 1 + 2: an 8-image session attach drops from ~10 MB to ~0 (text is already 0
bytes warm via `haveTo`), uploads shrink ~3–10×, terminal scrollback ~60–80% fewer bytes. Item 3 changes
almost nothing measurable unless the threshold experiment says otherwise.

---

## 1. Current state — what already exists (read these before writing anything)

### 1.1 Read list (in order)

1. **`README.md`** §"Session loading (tail-first) & IndexedDB cache" and §"Configuration" — the transfer
   model you must not break: sparse attach, `fromSeq`/`messageCount`/`rewriteSeq`/`sentFrom`, the
   `haveTo` handshake, warm reopen = 0 bytes, 64-message chunk keys.
2. **`docs/server.md`** — HTTP endpoints, the `/ws/agent` + `/ws/sync` hubs, the exec bridge, the media
   and range paths, the auth gate (what a new route inherits automatically).
3. **`docs/client.md`** — the browser side: boot, agent adapter, storage, session sync.
4. **`docs/terminal.md`** — the terminal hub + client (item 2 lives here).
5. **`docs/lessons.md`** — contracts (vendor behavior), patterns, decisions; §"vendored-code contracts"
   is where new vendor assumptions belong.
6. **`agent-hub.mjs`** — `getSession`/`attach`/`attach` tail, the event pump (~`event.type === …` chain),
   `entry.runtime` + `emitRuntime`, `_settleRuntime`, retry/steer/versions.
7. **`src/proxy-agent.ts`** — the client agent: `applyEvent` switch (`message_start|update|end`,
   `tool_execution_*`, `turn_end`, `agent_start|end`), `streamingMessage`, sparse handling + `filledFrom`,
   `fillWindow`/`scheduleBackfill`, live write-through.
8. **`src/idb-cache.ts`** — chunk keys, `mergeRanges`, `verifyChunkText`, `netClass`/`transferPolicy`,
   `breakerOpenAt`, the memory tier.
9. **`src/ui/settings.tsx`** — the settings pattern to copy (`pi.autoRetry` + push to the hub).
10. **`tests/retry.test.mjs`** (hub + pi-ai faux provider harness), **`tests/idb-cache.test.mjs`** (pure
    functions), **`tests/hub-hydration.test.mjs`** (attach envelope), **`tests/term-smoke.mjs`** (terminal).

### 1.2 Facts you can rely on (verified 2026-10-25)

| Fact | Where |
|---|---|
| Agent WS **already** negotiates deflate: `perMessageDeflate: process.env.PI_WEB_WS_DEFLATE === "off" ? false : { threshold: 1024, zlibDeflateOptions: { level: 6 } }` | `server.mjs` (the `new WebSocketServer({ noServer: true, maxPayload: 25MB, … })`, ≈L2024) |
| **Terminal WSS has no deflate**: `new WebSocketServer({ noServer: true, maxPayload: MAX_INPUT + 64*1024 })` | `terminal-hub.mjs` ≈L461 |
| Upgrade routing: `/ws/sync` → `agentConn` (L2679), `/ws/agent` → `agentConn` (L2680), `/ws/terminal` → `terminalHub.handleUpgrade` (L2681-2684); the terminal socket itself is created in `server.mjs` L2129 (`terminalHub.conn`) | `server.mjs` L2679-2684, L2129 |
| Agent events reach the client as **flat JSON frames** (`type` = pi event type) + server frames: `state`, `runtime` (tiny delta to all devices), `partial`, `retry`, versions, ping | `agent-hub.mjs` event pump ≈L236-268; `server.mjs` `agentConn` ≈L2221 |
| Assistant deltas: `message_update` sets `state.streamingMessage` (full snapshot, never appended) | `src/proxy-agent.ts` ≈L233-236 |
| Terminal protocol: JSON frames `{t:"d", d}` output, `{t:"i", d}` input, `{t:"state", s}`, replay ring on attach | `docs/terminal.md`; `terminal-hub.mjs` |
| `transferPolicy(net)` → `"fast" │ "metered"`, browser Network Information API outranks the server's `netClass` (`saveData`, `effectiveType`, `type`) | `src/idb-cache.ts` ≈L594-606 |
| `netClass` is reported by `/api/health` (`lan`/`wan`/`metered`) | `server.mjs` ≈L376 |
| Images: composer holds `{name, data(base64), mimeType, preview}`; sent as `{type:"image", data, mimeType}` parts; server caps 4 images/message; file source is `/api/fs/read` (base64, 8 MB cap) | `src/ui/chat.tsx` ≈L725/819-825/L1263 `MAX_IMAGE_ATTACH = 4`/L1416; `server.mjs` ≈L1394-1403, ≈L2262-2265 |
| The prompt/steer frames carry images: `{type, content, images}` | `src/proxy-agent.ts` ≈L371-379, L451-467 |
| Transcripts on disk hold **inline base64** images, and every egress path (WS attach, live `message_end` history, HTTP `/range`, full session GET) re-sends them | `agent-hub.mjs` attach; `server.mjs` `/range` ≈L2455, full GET ≈L2495-2499 |
| The full-session gzip gate: `Buffer.byteLength(payload) > 2048 && /gzip/.test(accept-encoding)` → `c.body(zlib.gzipSync(payload), 200, { "Content-Encoding": "gzip" })` | `server.mjs` ≈L2495-2499 |
| `ws.send(data, { compress: false })` is the double-compression escape hatch | ws API (use it for pre-compressed payloads) |

### 1.3 What is NOT here (don't design for it)

- **No tool-approval / HITL flow.** Grok's "flush approvals immediately" advice has no counterpart today.
  The live-flush cases that *do* exist: `runtime` frames (turn progress), retry/error, version parking,
  compaction progress. Treat any *future* approval prompt as live-only.
- **No native image stack** (no sharp/canvas/libvips) and the project's rule is not to add one. The server
  never transcodes; it stores and serves.
- **No brotli on WebSocket**, no browser-side brotli encoder/decoder.

---

## 2. Item-by-item design

### 2.1 Item 2 — WebSocket deflate (nearly free)

* **Agent WS**: nothing to do. It is item 2. Verify with a live handshake (`Sec-WebSocket-Extensions:
  permessage-deflate` in the response) and keep `PI_WEB_WS_DEFLATE=off` as the escape hatch.
* **Terminal WS**: copy the same block into `terminal-hub.mjs`'s `WebSocketServer`:

```js
const wss = new WebSocketServer({
	noServer: true,
	maxPayload: MAX_INPUT + 64 * 1024,
	// terminal output is highly compressible (prompt echo, `ls`, build logs) and the
	// client is often a phone on a metered link. Same shape as the agent socket:
	// env kill-switch + a threshold so tiny frames stay uncompressed.
	perMessageDeflate: process.env.PI_WEB_WS_DEFLATE === "off" ? false : {
		threshold: 1024,
		zlibDeflateOptions: { level: 6 },
	},
});
```

* **Do not** put deflate in Settings: JS cannot switch the extension off, so a client-side toggle would
  be a lie. If a device ever misbehaves, the opt-out is the upgrade URL (`/ws/terminal?deflate=0`) or the
  env var — document that if you add it.
* **Never double-compress**: any payload you already gzipped (a batch, an image, a pre-compressed blob)
  must be sent as binary with `{ compress: false }`.
* **Threshold experiment (feeds item 3's decision)**: 1024 means every `message_update` frame (~200-800 B)
  travels *uncompressed*. Try 256 (or 0) on the agent socket and measure a long reply; that is the cheap
  version of "turn off streaming".

### 2.2 Item 1 — images: transcode on the client, stop inlining on egress

**Two separate problems. Solve the second one first — it is 10× bigger.**

**(a) Client-side transcode (before the image ever leaves the phone)**

`createImageBitmap(blob, { imageOrientation: "from-image", resizeWidth, resizeHeight, resizeQuality: "high" })`
downscales **at decode** (never draw 12 MP and then scale — that OOMs low-end iOS), then re-encode with
`OffscreenCanvas`/`canvas.toBlob("image/webp", q)` and fall back to `image/jpeg`. Pass through untouched:

- decode failure (HEIC on Android Chrome, exotic TIFF) → send original + a one-line note,
- `image/svg+xml`, ICO, **animated GIF**,
- PNG that came from a *tool result* (screenshots must stay crisp for the model),
- anything already ≤ maxEdge **and** ≤ ~100 KB.

Keep the existing 4-images-per-message cap, applied *after* resize. Alpha: WebP keeps it, JPEG flattens on
white. EXIF orientation comes free with `imageOrientation: "from-image"` — verify with an orientation-6
fixture that the resize target is swapped.

**(b) Egress redaction (the actual mobile bill)**

Session files on disk keep full `ImageContent` (the model path needs it). Every **egress** path replaces
`data` with `hash` + `bytes`:

```jsonc
{ "type": "image", "mimeType": "image/webp", "hash": "<sha256>", "bytes": 91234 }   // no "data"
```

and the bytes are served by a **new authenticated HTTP route**, e.g.
`GET /api/agent/session/:id/media/:hash` (same `/api/*` auth gate as everything else — a hash is not a
capability URL):

```js
app.get("/api/agent/session/:id/media/:hash", async (c) => {
	const id = c.req.param("id"), hash = c.req.param("hash");
	if (!/^[a-f0-9]{64}$/.test(hash)) return c.json({ error: "bad hash" }, 400);
	const hit = agentHub.getMedia(id, hash);              // new: (id, hash) → { bytes, mimeType } | null
	if (!hit) return c.json({ error: "not found" }, 404);
	return c.body(hit.bytes, 200, {
		"Content-Type": hit.mimeType,
		"Content-Length": String(hit.bytes.length),
		"Cache-Control": "private, max-age=31536000, immutable",  // content-addressed
		// never gzip image bytes (they are already compressed; the generic JSON gate
		// must not touch this route)
	});
});
```

Client render: if `data` is absent, `fetch` the media URL once, keep an object URL in a `Map<hash, url>`
(or IDB, keyed by hash) and reuse it across sessions. Old cached chunks that still contain inline `data`
must keep rendering — **handle both shapes**; that is cheaper and safer than invalidating caches.

> **Decision to make explicitly (grok flagged it):** idb chunks are keyed `[sessionId, rewriteSeq,
> fromSeq]`, so changing the message *shape* on egress does not force a bump **as long as the renderer
> tolerates both shapes** (recommended). Bumping `rewriteSeq` throws away every warm cache on the device
> — only do it if you find a case where mixed shapes break.

Server-side transcode: **do not**. No native deps, and the upload direction (client → server) is the one
that costs mobile money. One exception worth *documenting as rejected*: lazily shrinking existing
multi-MB images in old sessions — no, because it rewrites history the model may need.

### 2.3 Item 3 — atomic (no-streaming) turns: design if you insist, defer by default

**Grok's position (and mine): don't start here.** Reasons in this codebase specifically:
`message_update` frames are the *only* thing atomic mode removes and they are tiny; the mode must sit on
top of retry-at-failure-point (`_settleRuntime`, `_dropFailedTail`), steering, version parking, compaction
progress, sparse attach/`haveTo`, IDB write-through and the multi-device case. That is a lot of surface
for a few KB per turn.

**Cheap 80/20 first**: server-side coalescing of `message_update` (one frame per ~50 ms or ~80 tokens) —
live TTFB preserved, fewer frames, no protocol branch, deflate actually engages. Put it behind the same
settings key as the atomic mode (`stream: "live" | "coalesced" | "atomic"`).

If a true atomic mode is still wanted, the contract that survives review:

```
c→s  { type: "set-stream-mode", mode: "live" | "coalesced" | "atomic" }   // per connection, like set-auto-retry
s→c  { type: "turn_pending", sessionId, runId }                            // start + lets the client show Stop
s→c  { type: "turn_complete", sessionId, runId, seqFrom, seqTo, events: [...] }
     // events = the SAME flat frames you already send (message_end, tool results, last runtime,
     // versions, compaction), coalesced. NO gzip field, NO base64 wrapper: permessage-deflate compresses it.
```

Server rules (non-negotiable):
- buffer only coalesced assistant text + final tool results + last `runtime` + versions;
- **always flush** on error/abort (`turn_complete` + the error frame — blind retry UX is unacceptable),
  and keep emitting `runtime`/pings so NAT/browser timeouts don't kill a silent socket;
- drop intermediate `message_update`/`partial`s;
- memory bound per connection (e.g. 2 MB) → on overflow fall back to live for the rest of the turn + log;
- other sockets attached to the same session are unaffected (per-connection mode);
- history/IDB paths unchanged: the client write-through/`fillWindow` treats `turn_complete` like
  `message_end` and applies one state snapshot.
- hide Steer while atomic (steering unseen output is nonsense); keep Stop.

Client rules: one Preact state update per `turn_complete`; spinner + Stop from `turn_pending`; do **not**
fake-type the text out.

---

## 3. Settings design

Add one section to `src/ui/settings.tsx`, one localStorage key set, and one hub frame — nothing else.
Reuse the existing control plane (`netClass` + `transferPolicy` + localStorage + WS push).

```ts
// localStorage keys (mirror the pi.autoRetry pattern exactly)
pi.dataImages   // "auto" | "always" | "original"   default "auto"
pi.dataStream   // "auto" | "live" | "atomic"       default "auto"  (→ always "live" until item 3)
pi.imageMaxEdge // number | "" (advanced, overrides the table)
pi.imageQuality // 0.5 – 0.9 (advanced)
```

Resolved policy (pure, client-side, also used by tests) — `lib/data-reduction.mjs`:

| netClass | `images: "auto"` maxEdge | quality | format | `stream: "auto"` |
|---|---|---|---|---|
| lan | 2048 | 0.85 | webp if `toBlob("image/webp")` yields a webp blob, else jpeg | live |
| wan | 1280 | 0.72 | same | live |
| metered | 1024 | 0.65 | same | live |

`transferPolicy()` already returns `fast`/`metered`; do **not** overload it. Add
`resolveDataReduction(net, settings)` and leave `transferPolicy` alone.

Where each knob lives:

| Knob | client-only | pushed to hub |
|---|---|---|
| `images`, `imageMaxEdge`, `imageQuality` | **yes** (resize happens before send) | no |
| `stream` | UI | **yes, per connection** — `{type:"set-stream-mode", mode}`, same shape as `set-auto-retry` |
| WS deflate | no UI at all | no (env / upgrade query only) |

---

## 4. Sample code

### 4.1 `lib/data-reduction.mjs` — pure, testable (mirror `lib/chunk-window.mjs` style)

```js
/** Pure policy + planning for mobile data reduction. No DOM, no fs → unit-testable. */

export const IMAGE_PRESETS = {
	lan:     { maxEdge: 2048, quality: 0.85, maxBytes: 1024 * 1024 },
	wan:     { maxEdge: 1280, quality: 0.72, maxBytes: 512 * 1024 },
	metered: { maxEdge: 1024, quality: 0.65, maxBytes: 256 * 1024 },
};

/** net: "lan" | "wan" | "metered" (or transferPolicy's "fast"/"metered"); settings from localStorage. */
export function resolveDataReduction(net, settings = {}) {
	const base = IMAGE_PRESETS[net === "fast" ? "lan" : net === "metered" ? "metered" : (net || "wan")] || IMAGE_PRESETS.wan;
	const mode = settings.images || "auto";            // auto | always | original
	const maxEdge = Number(settings.imageMaxEdge) > 0 ? Number(settings.imageMaxEdge) : base.maxEdge;
	const quality = Math.min(0.9, Math.max(0.5, Number(settings.imageQuality) || base.quality));
	return { mode, maxEdge, quality, maxBytes: base.maxBytes, stream: settings.stream === "auto" ? "live" : (settings.stream || "live") };
}

/**
 * Decide what to do with one image BEFORE it is sent. Pure on purpose: the bytes/canvas part
 * happens in the browser, the DECISION is what we test.
 * meta: { mimeType, bytes, width, height } (unknown width/height ⇒ decode failed/uncertain)
 * → { action: "passthrough" | "reencode", format, quality, maxEdge, reason }
 */
export function planImageTransform(meta, policy) {
	const { mimeType = "", bytes = 0, width = 0, height = 0 } = meta || {};
	if (policy.mode === "original") return { action: "passthrough", reason: "user chose original" };
	if (/svg|icon|gif/i.test(mimeType)) return { action: "passthrough", reason: "vector/animated: never re-encode" };
	if (!width || !height) return { action: "passthrough", reason: "undecodable here (e.g. HEIC on Chrome)" };
	const edge = Math.max(width, height);
	const small = edge <= policy.maxEdge && bytes <= Math.min(policy.maxBytes, 100 * 1024);
	if (small && policy.mode !== "always") return { action: "passthrough", reason: "already small" };
	return { action: "reencode", format: "webp", quality: policy.quality, maxEdge: policy.maxEdge, reason: `${width}x${height} ${bytes}B` };
}

/** One frame per `ms` for message_update bursts (item 3's cheap 80/20). Pure. */
export function coalesceTurn(events, { ms = 50, capBytes = 2 * 1024 * 1024 } = {}) {
	const out = []; let bytes = 0; let overflow = false;
	for (const ev of events) {
		if (ev?.type === "message_update") { out.__lastUpdate = ev; continue; }  // caller keeps only the last
		const size = JSON.stringify(ev).length;
		if (bytes + size > capBytes) { overflow = true; break; }
		bytes += size; out.push(ev);
	}
	return { events: out, overflow };
}

/** Double-compression guard: what may go through permessage-deflate? */
export function wsCompressHint(kind) {
	return kind === "json" || kind === "text";   // "gzip" | "image" | "webp" | "png" | "jpeg" → false
}
```

### 4.2 Browser transcode — `src/image-encode.ts`

```ts
import { planImageTransform, type Policy } from "../lib/data-reduction.mjs";

/** Downscale at DECODE, re-encode to webp (fallback jpeg), keep the original when that wins. */
export async function encodeForModel(file: Blob & { name?: string }, policy: Policy) {
	const plan = planImageTransform({ mimeType: file.type, bytes: file.size, width: 0, height: 0 }, policy);
	let bmp: ImageBitmap | null = null;
	try {
		bmp = await createImageBitmap(file, { imageOrientation: "from-image" } as any);
	} catch { return { blob: file, mimeType: file.type || "application/octet-stream", note: "couldn't recompress — sending original" }; }
	const real = planImageTransform({ mimeType: file.type, bytes: file.size, width: bmp.width, height: bmp.height }, policy);
	if (real.action === "passthrough") { bmp.close?.(); return { blob: file, mimeType: file.type, note: null }; }

	const scale = Math.min(1, real.maxEdge / Math.max(bmp.width, bmp.height));
	const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
	const useOffscreen = typeof OffscreenCanvas === "function";
	const canvas: any = useOffscreen ? new OffscreenCanvas(w, h) : Object.assign(document.createElement("canvas"), { width: w, height: h });
	canvas.getContext("2d").drawImage(bmp, 0, 0, w, h);
	bmp.close?.();

	const toBlob = (type: string, q: number) => useOffscreen
		? canvas.convertToBlob({ type, quality: q })
		: new Promise<Blob | null>((res) => canvas.toBlob(res, type, q));
	let blob = await toBlob("image/webp", real.quality);
	if (!blob || !/webp/.test(blob.type)) blob = await toBlob("image/jpeg", real.quality);   // Safari/old Chrome
	if (!blob) return { blob: file, mimeType: file.type, note: null };
	// never make it bigger than the original unless the user asked to always re-encode
	if (blob.size >= file.size && policy.mode !== "always") return { blob: file, mimeType: file.type, note: null };
	return { blob, mimeType: blob.type, note: `${bmp.width}x${bmp.height} → ${w}x${h}` };
}
```

Wire it where attachments are added (`src/ui/chat.tsx` attach/paste/drop + the `/api/fs/read` result) and
convert to the existing shape with a FileReader/`arrayBuffer()` → base64 **after** the resize.

### 4.3 Egress redaction (server)

```js
// server.mjs (next to normalizeRestoredMessages / the range handler)
import { createHash } from "node:crypto";
const mediaStore = new Map();          // hash → { bytes, mimeType }   (per-process; see §5 note)

/** Replace inline base64 with a content hash + size on every EGRESS path. Pure w.r.t. the session file. */
export function redactImageData(messages) {
	return (messages || []).map((m) => {
		if (!Array.isArray(m?.content)) return m;
		let changed = false;
		const content = m.content.map((part) => {
			if (part?.type !== "image" || typeof part.data !== "string" || part.hash) return part;
			const bytes = Buffer.from(part.data, "base64");
			const hash = createHash("sha256").update(bytes).digest("hex");
			mediaStore.set(hash, { bytes, mimeType: part.mimeType || "application/octet-stream" });
			changed = true;
			return { type: "image", mimeType: part.mimeType, hash, bytes: bytes.length };
		});
		return changed ? { ...m, content } : m;
	});
}
```

Apply it in **every** egress serialization: the attach envelope, the live `message_end`/history frames,
HTTP `/range` (the NDJSON body), and the full-session GET. Keep the *model* path unredacted (the hub works
from the session file/in-memory transcript).

### 4.4 Client side of redaction (`src/proxy-agent.ts` + a renderer helper)

```ts
const mediaUrls = new Map<string, string>();          // hash → object URL (or IDB-backed)
export async function imageSrc(part: any): Promise<string | undefined> {
	if (part?.data) return `data:${part.mimeType};base64,${part.data}`;     // legacy cached chunks
	if (!part?.hash) return undefined;
	const hit = mediaUrls.get(part.hash);
	if (hit) return hit;
	const url = `/api/agent/session/${encodeURIComponent(sessionId)}/media/${part.hash}`;
	mediaUrls.set(part.hash, url);                                          // browser HTTP cache does the rest
	return url;
}
```

### 4.5 Atomic mode server skeleton (only if you build item 3)

```js
// agent-hub.mjs — per-connection mode lives in the socket adapter, not in the session entry
// conn.mode === "atomic" → the hub buffers these and never forwards them:
const ATOMIC_DROP = new Set(["message_update", "tool_execution_update", "partial"]);
const ATOMIC_FLUSH = new Set(["error", "aborted", "retry", "compacted", "version"]);
// on flush: send { type:"turn_complete", sessionId, runId, seqFrom, seqTo, events: buffered.splice(0) }
```

```ts
// src/proxy-agent.ts — receiving side
case "turn_pending": this.state.isStreaming = true; this.notifyListeners({ type: "state-snapshot" }); break;
case "turn_complete": {
	for (const ev of msg.events || []) this.applyEvent(ev);   // reuse the existing switch
	this.state.isStreaming = false;
	this.notifyListeners({ type: "state-snapshot" });
	break;
}
```

---

## 5. Server-side notes and traps

* **Media storage**: hashes are content-addressed, so a file-backed store is natural
  (`data/media/<sha256>`), but a per-process `Map` is enough for v1 *if* you cap it (LRU, e.g. 64 MB) —
  the bytes are also still in the session file, so a cold restart can repopulate lazily from the
  transcript on demand. Decide explicitly rather than leaking memory.
* **Do not re-send**: the transcript egress is where the bytes were; after redaction a warm attach carries
  hashes only. Verify with the existing `haveTo` measurement (the C4 probe pattern in `pr-idb.md` §8).
* **Legacy chunks**: IDB chunks written before the change contain `data` — render both shapes (§2.2b).
* **Auth**: the media route must sit behind the same gate as `/api/*` (it does if you register it there);
  never accept a hash as a bearer capability.
* **No gzip on media responses** (and `{compress:false}` if you ever send bytes over the WS).
* **Session files do not shrink** — do not advertise storage savings, only transfer savings.

---

## 6. Test plan (hermetic, node-only, wiring into `package.json` + `.github/workflows/ci.yml`)

New pure suite `tests/data-reduction.test.mjs` (mirror `tests/idb-cache.test.mjs` structure):

1. `resolveDataReduction`: lan/wan/metered × `auto|always|original` × overrides; `fast`/`metered` mapping;
   quality clamped 0.5–0.9; `stream:"auto"` → `"live"`.
2. `planImageTransform`: 4000×3000 3 MB jpeg → reencode; 800×600 40 KB → passthrough; svg/gif → passthrough;
   unknown dimensions (HEIC) → passthrough; `mode:"always"` forces reencode; EXIF-6 fixture → swapped
   resize target (assert on the plan, not the canvas); maxEdge override honoured.
3. `coalesceTurn`: N× `message_update` + `message_end` → one final; partials dropped; runtime spam → last;
   error present → error kept; empty turn; 2 MB overflow → `overflow:true`.
4. `wsCompressHint`: `json`/`text` → true; `gzip`/`image`/`webp`/`png` → false.

Extend existing suites:

* `tests/retry.test.mjs` (hub + faux provider harness): `set-stream-mode` per connection — an atomic
  connection receives **zero** `message_update` and one `turn_complete`; a live connection on the same run
  still receives deltas; an error flushes the buffer *with* the error; both connections end on the same
  seq; steer from the atomic connection aborts the run; a sparse attach mid-turn does not drop the commit.
* `tests/hub-hydration.test.mjs` / `tests/range.test.mjs`: egress redaction — the attach envelope and
  `/range` NDJSON contain **no** long base64 and **no** `data` field on image parts; hashes are stable
  across two runs; `hydrateImageData(redact(x))` round-trips to the original `ImageContent` for the faux
  provider; a session with no images is unchanged (identity).
* `tests/term-smoke.mjs` (or a new `tests/ws-deflate.test.mjs`): the agent WSS answers a handshake with
  `permessage-deflate` unless `PI_WEB_WS_DEFLATE=off`; the terminal WSS does the same; a pre-compressed
  payload is sent with `compress:false` (assert via the `ws` send options or a `permessage-deflate`
  negotiation test).

Browser-only (do **not** gate CI on it): one smoke that `toBlob("image/webp")` yields webp or falls back to
jpeg, and that a 12 MP photo goes through `encodeForModel` in < ~300 ms without OOM.

---

## 7. Measurement plan (kill any knob that loses)

Fixtures: 3 camera JPEGs (~3 MB each), 1 UI PNG screenshot, one 50-turn text session, one 200-turn session
with 8 images.

Measure (hub log + a `?stats=1` counter would be fine): uncompressed payload bytes per frame, frame count,
time-to-first-token, turn-complete latency, resize CPU ms, peak RSS.

| Comparison | Expectation |
|---|---|
| attach of the 8-image session: inline base64 vs redacted + media HTTP | **~10× / near zero** |
| same attach, deflate on vs off (`PI_WEB_WS_DEFLATE=off`) | 60–80% on text, little on images |
| terminal scrollback (e.g. a 5 MB build log), deflate on vs off | 60–80% |
| 2k-token reply: live + threshold 1024 vs live + threshold 256 vs coalesced 50 ms vs atomic | a few KB — this decides item 3 |
| composer: 12 MP photo — bytes on the WS, encode time | 3–10× smaller, < 300 ms |

**Kill rule:** if a knob saves < 10% on the metered 8-image fixture *and* costs > 50 ms or a protocol
branch, drop it. (Expected: images = big win, terminal deflate = clear win, atomic turns = noise.)

---

## 8. Risks / traps checklist

1. A "turn off WS compression" setting is meaningless — the browser always offers the extension; only the
   server can refuse. Don't ship the toggle.
2. `createImageBitmap` without `resizeWidth/Height` OOMs low-end iOS on 12 MP photos.
3. HEIC from the camera roll is the *default* mobile input; Chrome can't decode it → passthrough + a note.
4. Re-encoding tool screenshots as 0.65 jpeg makes them unreadable to the model → passthrough PNG from tools.
5. Mixed image shapes (`data` vs `hash`) must render; bump `rewriteSeq` only if you find a real break.
6. A new media route outside the auth gate is a session leak.
7. Atomic silence → NAT/browser WS timeout; keep `runtime`/pings flowing.
8. `maxPayload: 25 MB` is the *decompressed* limit — leave it; don't raise it for batches.
9. Session files don't shrink — don't claim storage savings.
10. Main-thread canvas in the composer janks the UI → `OffscreenCanvas`/worker where available.
11. Nobody may "helpfully" gzip JSON before `send` (double compression) — `wsCompressHint` is the guard.
12. iOS Safari has a history of trouble with very large deflate frames — another reason to avoid 2 MB
    atomic payloads.
13. `threshold: 1024` quietly leaves exactly the frames item 3 targets uncompressed — measure before building.
14. The `partial` frame path (exec bridge) and the assistant `message_update` path are different code
    paths; an atomic mode must consider both.

---

## 9. Build order (each phase = one commit + tests + docs)

**P0 — recon (30 min).** Confirm the §1.2 anchors still hold (`rg -n "perMessageDeflate" server.mjs
terminal-hub.mjs`), read §1.1 items 1–6, and run the suites once to see the baseline.

**P1 — terminal deflate + the threshold experiment (item 2, hours).**
Add `perMessageDeflate` to the terminal WSS; add the handshake test; flip the agent threshold to 256 behind
an env var and measure a long reply. *Acceptance:* terminal bytes −60% on a scrollback fixture; no
regression in `term-smoke`; measurement table filled in for the threshold row.

**P2 — client image transcode (item 1a, ~half a day).**
`lib/data-reduction.mjs` + `tests/data-reduction.test.mjs`; `src/image-encode.ts`; wire it into the
composer attach paths; keep the 4-image cap after resize. *Acceptance:* suite green; a 12 MP photo becomes
≤ maxEdge webp in < 300 ms; HEIC/svg/gif passthrough unchanged; a visible note when the original is sent.

**P3 — egress redaction + media route (item 1b, the big one, ~1 day).**
`redactImageData` + `GET /api/agent/session/:id/media/:hash` + the client `imageSrc`; apply redaction in
attach/`/range`/live history/full GET. *Acceptance:* the 8-image attach fixture drops to hashes only
(measure before/after); warm `haveTo` attach still 0 bytes; legacy inline chunks still render; `hydrate`
round-trips in the hub suite; no long base64 in any egress fixture.

**P4 — optional: coalescing, then (only if measurements demand it) atomic mode (item 3, ~1 day).**
Coalesce `message_update` every 50 ms behind `stream:"coalesced"`; re-measure; only then implement
`turn_complete` with the §2.3 contract and the per-connection mode.

**Docs per phase:** README (§Configuration gains the new settings; a one-paragraph note in the
tail-first/transfer section), `docs/client.md` (settings + image pipeline), `docs/server.md` (media route +
redaction on egress), `docs/terminal.md` (deflate), `docs/lessons.md` (any new vendor contract, e.g.
"browsers cannot disable permessage-deflate"), and re-copy the README.

---

## 10. Open questions for the implementer

1. Media store: per-process LRU vs `data/media/<hash>` on disk — pick one and say why in the commit.
2. Do we redact *live* `message_end` frames too, or only history/attach? (Live is small; redacting it
   uniformly is simpler and keeps the renderer on one path.)
3. Should the images setting also shrink *outgoing* tool-result screenshots (server-side tool output), or
   only user attachments? (Recommendation: only user attachments; tool PNGs are model input.)
4. Is `stream: "coalesced"` enough to satisfy the original request, or is a true atomic mode required?
   Decide from the §7 measurement, not from taste.
5. If atomic mode ships: does the *server* or the *client* own the "hide Steer" rule? (Recommendation:
   server refuses `steer` in atomic mode with a clear ack, client hides the button — no silent no-ops.)
