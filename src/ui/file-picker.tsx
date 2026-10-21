// Workspace file explorer (user request): tab layout — left pane (30%) lists
// files with modified time, right pane previews the clicked file's contents.
// Selecting = "Attach" (button in the preview head) or checkbox multi-select
// with a batch bar. Server endpoints: /api/ws/files (listing) + /api/ws/file
// (text or base64 image). Dotfiles hidden + dotfile paths 403 server-side;
// paths are workspace-relative ("/"-separated).
import { useEffect, useRef, useState } from "preact/hooks";
import hljs from "highlight.js";
import { escapeHtml } from "./markdown.js";

export interface PickedFile {
	path: string;
	name: string;
	kind: "text" | "image";
	content?: string; // text kind
	base64?: string; // image kind
	mimeType?: string;
	size: number;
}

interface Entry {
	name: string;
	dir: boolean;
	size: number;
	mtime: number;
}

interface Preview {
	kind: "text" | "image";
	content?: string;
	base64?: string;
	mimeType?: string;
	size: number;
	truncated?: boolean;
}

const MAX_TEXT = 512 * 1024; // inline cap on the client side (server caps at 8MB)
const LAST_DIR_KEY = "pi.filePickerDir"; // remember the last-visited dir across sessions
const PREVIEW_TRUNCATE = 120000; // DOM-light preview; full content still attaches (≤512KB)
const PROSE_EXT = new Set(["md", "markdown", "txt", "log"]);

/** preview syntax highlighting: extension → highlight.js language id (user request:
 *  js/python/known code files). Everything not listed → escaped plain text. */
const CODE_LANG: Record<string, string> = {
	js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
	ts: "typescript", tsx: "typescript",
	py: "python", pyw: "python",
	json: "json", jsonc: "json",
	css: "css", scss: "scss", less: "less",
	html: "xml", htm: "xml", xml: "xml", svg: "xml",
	md: "markdown", markdown: "markdown",
	yml: "yaml", yaml: "yaml",
	sh: "bash", bash: "bash", zsh: "bash", ps1: "powershell", bat: "dos", cmd: "dos",
	c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", cs: "csharp", java: "java",
	rs: "rust", go: "go", php: "php", rb: "ruby", swift: "swift", kt: "kotlin",
	sql: "sql", toml: "ini", ini: "ini", cfg: "ini", env: "ini", diff: "diff", patch: "diff",
};
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;

function toggleCheckedIn(setter: (fn: (prev: Set<string>) => Set<string>) => void, key: string) {
	setter((prev) => {
		const next = new Set(prev);
		if (next.has(key)) next.delete(key);
		else next.add(key);
		return next;
	});
}

/** middle truncation keeps the extension visible (sonnet round) */
function truncName(name: string, max = 34): string {
	if (name.length <= max) return name;
	return name.slice(0, max - 10) + "…" + name.slice(-9);
}

function isProse(name: string): boolean {
	return PROSE_EXT.has((name.match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase());
}

function fmtSize(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtTime(ms: number): string {
	try {
		return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
	} catch {
		return "";
	}
}

export function FilePickerDialog({
	open,
	initialFile,
	onPick,
	onClose,
}: {
	open: boolean;
	/** workspace-relative path — opens the explorer with this file previewed (user request) */
	initialFile?: string | null;
	onPick: (file: PickedFile) => void;
	onClose: () => void;
}) {
	const [path, setPath] = useState<string | null>(null); // current dir, workspace-relative
	const [entries, setEntries] = useState<Entry[]>([]);
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(false);
	const [filter, setFilter] = useState("");
	const [busy, setBusy] = useState("");
	const [sel, setSel] = useState<Entry | null>(null); // previewed file (right pane)
	const [preview, setPreview] = useState<Preview | null>(null);
	const [attached, setAttached] = useState<Set<string>>(new Set()); // full paths attached this open
	const [checked, setChecked] = useState<Set<string>>(new Set()); // multi-select (full paths)
	const previewCache = useRef(new Map<string, Preview>());
	const loadGen = useRef(0);
	const selectGen = useRef(0);
	const inputRef = useRef<HTMLInputElement>(null);

	// Escape closes (dialog parity)
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [open, onClose]);

	const load = async (target?: string | null, opts?: { fallbackRoot?: boolean }): Promise<Entry[]> => {
		const gen = ++loadGen.current;
		setLoading(true);
		setError("");
		setFilter(""); // a stale filter makes folders look empty after nav (grok p8)
		setEntries([]);
		setSel(null);
		setPreview(null);
		setChecked(new Set()); // selections are per-directory
		try {
			const q = target ? "?path=" + encodeURIComponent(target) : "";
			const r = await fetch("/api/ws/files" + q, { signal: AbortSignal.timeout(10000) });
			const d = await r.json();
			if (gen !== loadGen.current) return []; // superseded by a newer nav
			if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
			setPath(d.path);
			setEntries(d.entries || []);
			try {
				localStorage.setItem(LAST_DIR_KEY, d.path || ""); // remember for next open
			} catch {
				/* quota */
			}
			return d.entries || [];
		} catch (err) {
			if (gen !== loadGen.current) return [];
			if (opts?.fallbackRoot && target) {
				return await load(null); // saved dir vanished → root
			}
			setError(String((err as Error).message || err));
			return [];
		} finally {
			if (gen === loadGen.current) setLoading(false);
		}
	};

	// default into ws/ on first open (user request: "show files in ws/") — one
	// round-trip, no root flash; afterwards remember last dir
	const openPicker = async () => {
		let saved: string | null = null;
		try {
			saved = localStorage.getItem(LAST_DIR_KEY);
		} catch {
			/* quota */
		}
		await load(saved !== null ? saved : "ws", { fallbackRoot: true });
	};

	useEffect(() => {
		if (!open) {
			setAttached(new Set());
			previewCache.current.clear();
			return;
		}
		if (initialFile) {
			// view mode (user request): open the explorer AT this file — load its
			// parent dir, then select + preview it (fresh dir passed explicitly —
			// first-click bug fix)
			const parent = initialFile.split("/").slice(0, -1).join("/") || null;
			const name = initialFile.split("/").pop() || "";
			void (async () => {
				const list = await load(parent, { fallbackRoot: false });
				const entry = list.find((e) => e.name === name && !e.dir);
				if (entry) await select(entry, parent);
				else setError(`file not found: ${initialFile}`);
			})();
		} else {
			void openPicker();
		}
		setTimeout(() => inputRef.current?.focus(), 50);
	}, [open, initialFile]);

	// pure fetch+cache — no pane state (used by select AND batch attach)
	const fetchPreview = async (key: string): Promise<Preview | null> => {
		const cached = previewCache.current.get(key);
		if (cached) return cached;
		try {
			const r = await fetch("/api/ws/file?path=" + encodeURIComponent(key), { signal: AbortSignal.timeout(20000) });
			const d = await r.json();
			if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
			const p: Preview =
				d.kind === "image"
					? { kind: "image", base64: d.base64, mimeType: d.mimeType, size: d.size }
					: {
							kind: "text",
							content: String(d.content || ""),
							size: d.size,
							truncated: String(d.content || "").length > PREVIEW_TRUNCATE,
						};
			previewCache.current.set(key, p);
			return p;
		} catch (err) {
			setError(String((err as Error).message || err));
			return null;
		}
	};

	const select = async (entry: Entry, dirOverride?: string | null) => {
		// dirOverride: callers that hold a FRESH dir (initialFile effect) pass it —
		// the closure `path` is stale until the next render (first-click bug)
		const base = dirOverride !== undefined ? dirOverride : path;
		const key = (base ? base + "/" : "") + entry.name;
		// text files >512KB: cannot be previewed usefully nor inlined (grok p8);
		// images preview fine up to the 8MB server cap
		if (entry.size > MAX_TEXT && !IMAGE_EXT.test(entry.name)) {
			setError(`text file too large to preview or inline (>512KB): ${entry.name}`);
			return;
		}
		setError("");
		const gen = ++selectGen.current;
		setSel(entry);
		setPreview(null);
		const p = await fetchPreview(key);
		if (gen !== selectGen.current) return; // superseded
		if (p) setPreview(p);
	};

	const attach = async (entry: Entry) => {
		if (entry.dir) return;
		const key = path ? path + "/" + entry.name : entry.name;
		const p = await fetchPreview(key);
		if (!p) return;
		// 512KB gate applies to TEXT only, after kind is known (grok p8: images
		// were wrongly blocked at 512KB); images are already ≤8MB (list pre-gate)
		if (p.kind === "text" && (p.size || 0) > MAX_TEXT) {
			setError(`text file too large to inline (>512KB): ${entry.name}`);
			return;
		}
		onPick({ path: key, name: entry.name, kind: p.kind, content: p.content, base64: p.base64, mimeType: p.mimeType, size: p.size });
		setAttached((prev) => new Set(prev).add(key)); // keyed by full path (grok p8)
	};

	/** Multi-select batch attach (user request): sequential fetch+attach per file. */
	const attachChecked = async () => {
		if (!checked.size) return;
		setBusy(`attaching ${checked.size}…`);
		const list = entries.filter((e) => checked.has(path ? path + "/" + e.name : e.name));
		let ok = 0;
		for (const e of list) {
			const key = path ? path + "/" + e.name : e.name;
			const p = await fetchPreview(key);
			if (!p) continue;
			if (p.kind === "text" && (p.size || 0) > MAX_TEXT) continue;
			onPick({ path: key, name: e.name, kind: p.kind, content: p.content, base64: p.base64, mimeType: p.mimeType, size: p.size });
			setAttached((prev) => new Set(prev).add(key));
			ok++;
		}
		setChecked(new Set());
		setBusy("");
		if (ok) setError("");
	};

	if (!open) return null;

	// breadcrumbs from the workspace-relative path
	const crumbs: Array<{ label: string; target: string | null }> = [{ label: "workspace", target: null }];
	if (path) {
		const parts = path.split("/").filter(Boolean);
		let acc = "";
		for (const part of parts) {
			acc = acc ? acc + "/" + part : part;
			crumbs.push({ label: part, target: acc });
		}
	}
	const shown = entries
		.filter((e) => !filter || e.name.toLowerCase().includes(filter.toLowerCase()))
		.sort((a, b) =>
			a.dir === b.dir
				? a.dir
					? a.name.localeCompare(b.name) // dirs: name asc
					: b.mtime - a.mtime // files: recently modified first
				: a.dir
					? -1
					: 1,
		);
	const selName = sel ? (path ? path + "/" + sel.name : sel.name) : "";

	// text preview → syntax-highlighted code view (or prose flow, no gutter)
	const previewText = preview && preview.kind === "text" ? (preview.content || "").slice(0, PREVIEW_TRUNCATE) : "";
	const previewIsCode = !!preview && preview.kind === "text" && !isProse(sel?.name || "");
	const codeExt = sel ? (sel.name.match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase() : "";
	const codeLang = CODE_LANG[codeExt];
	const codeHtml = (() => {
		if (!previewIsCode) return "";
		if (codeLang && hljs.getLanguage(codeLang)) {
			try {
				return hljs.highlight(previewText, { language: codeLang, ignoreIllegals: true }).value;
			} catch {
				return escapeHtml(previewText);
			}
		}
		return escapeHtml(previewText);
	})();
	const gutterLines = previewIsCode ? previewText.split("\n").length : 0;

	return (
		<div class="pw-overlay" onClick={onClose}>
			<div class="pw-dialog pw-file-dialog" onClick={(e) => e.stopPropagation()}>
				<div class="pw-dialog-head">
					<span>Workspace files</span>
					<span class="pw-file-quick">
						<button type="button" class="pw-mini-btn" onClick={() => void load(null)} title="Workspace root">
							root
						</button>
						<button type="button" class="pw-mini-btn" onClick={() => void load("ws")} title="ws/ — your projects">
							ws
						</button>
						<button type="button" class="pw-dialog-close" onClick={onClose} title="Close">
							✕
						</button>
					</span>
				</div>
				<div class="pw-file-crumbs">
					{crumbs.map((c) => (
						<span key={c.target || "root"}>
							{c.target !== null && <span class="pw-crumb-sep">{"\u203a"}</span>}
							<button class="pw-crumb" onClick={() => void load(c.target)} title={c.target || "workspace root"}>
								{c.label}
							</button>
						</span>
					))}
				</div>
				<input
					ref={inputRef}
					class="pi-input pw-dialog-search"
					type="text"
					placeholder="Filter by name…"
					value={filter}
					onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
				/>
				{error && (
					<div class="pw-note pw-note-destructive" style={{ padding: "0 16px" }}>
						{error}
					</div>
				)}
				<div class="pw-file-panes">
					<div class="pw-file-list">
						{loading && <div class="pw-empty">Loading…</div>}
						{!loading && shown.length === 0 && !error && filter && (
							<div class="pw-empty">
								No matches for “{filter}”.{" "}
								<button type="button" class="pw-empty-action" onClick={() => setFilter("")}>
									Clear filter
								</button>
							</div>
						)}
						{!loading && shown.length === 0 && !error && !filter && <div class="pw-empty">No files here.</div>}
						{shown.map((e) => {
							const key = path ? path + "/" + e.name : e.name;
							const isChecked = checked.has(key);
							return (
								<div
									key={e.name}
									role="button"
									tabIndex={0}
									class={"pw-file-row" + (sel?.name === e.name ? " pw-file-sel" : "") + (isChecked ? " pw-file-checked" : "")}
									onClick={() => (e.dir ? void load(key) : void select(e))}
									onKeyDown={(ev) => {
										if (ev.key === "Enter" || ev.key === " ") {
											ev.preventDefault();
											(ev.currentTarget as HTMLElement).click();
										}
									}}
									title={e.dir ? "Open folder" : "Click to preview · checkbox adds to batch attach"}
								>
									{!e.dir && (
										<span class="pw-file-checkbox-col">
											<input
												type="checkbox"
												checked={isChecked}
												aria-label={`Select ${e.name}`}
												onClick={(ev) => ev.stopPropagation()}
												onChange={() => toggleCheckedIn(setChecked, key)}
											/>
										</span>
									)}
									<span class="pw-file-icon" aria-hidden="true">
										{e.dir ? "\u{1F4C1}" : "\u{1F4C4}"}
									</span>
									<span class="pw-file-main">
										<span class="pw-file-name" title={e.name}>
											{truncName(e.name)}
											{attached.has(key) && <span class="pw-file-attached"> ✓</span>}
										</span>
										{!e.dir && (
											<span class="pw-file-meta">
												{fmtSize(e.size)} · {fmtTime(e.mtime)}
											</span>
										)}
									</span>
								</div>
							);
						})}
					</div>
					<div class="pw-file-preview">
						{busy ? (
							<div class="pw-empty">Loading {busy}…</div>
						) : !preview || !sel ? (
							<div class="pw-preview-empty">
								<div class="pw-preview-empty-title">No file selected</div>
								<div class="pw-preview-empty-sub">Click a file on the left to preview it</div>
							</div>
						) : (
							<>
								<div class="pw-preview-head">
									<span class="pw-preview-name" title={selName}>
										{sel.name}
									</span>
									<span class="pw-preview-size">{fmtSize(preview.size)}</span>
									<button
										type="button"
										class="pw-send"
										disabled={preview.kind === "text" && (preview.size || 0) > MAX_TEXT}
										title={preview.kind === "text" && (preview.size || 0) > MAX_TEXT ? "text files >512KB cannot be inlined" : "Attach to message"}
										onClick={() => void attach(sel)}
									>
										{attached.has(selName) ? "Attach again" : "Attach"}
									</button>
								</div>
								{preview.kind === "image" ? (
									<div class="pw-preview-imgwrap">
										<img class="pw-preview-img" src={`data:${preview.mimeType};base64,${preview.base64}`} alt={sel.name} />
									</div>
								) : isProse(sel.name) ? (
									// prose (md/txt/log): humanist flow, no gutter, no mono —
									// line numbers imply addressable code (sonnet round)
									<div class="pw-preview-prose">{previewText}</div>
								) : (
									// syntax-highlighted code view (user request) with a sticky
									// line-number gutter; no wrap so gutter/code stay aligned
									<div class="pw-preview-codewrap">
										<pre class="pw-code-gutter" aria-hidden="true">
											{Array.from({ length: gutterLines }, (_, i) => i + 1).join("\n")}
										</pre>
										<pre
											class="pw-code-html"
											dangerouslySetInnerHTML={{
												__html:
													codeHtml +
													(preview.truncated ? "\n\n… preview truncated — full content is attached" : ""),
											}}
										/>
									</div>
								)}
							</>
						)}
					</div>
				</div>
				{checked.size > 0 && (
					<div class="pw-attach-bar">
						<span class="pw-attach-count">{checked.size} selected</span>
						<button type="button" class="pw-mini-btn" onClick={() => setChecked(new Set())}>
							clear
						</button>
						<button type="button" class="pw-send" disabled={busy !== ""} onClick={() => void attachChecked()}>
							Attach {checked.size}
						</button>
					</div>
				)}
			</div>
		</div>
	);
}
