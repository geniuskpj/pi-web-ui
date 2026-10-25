// TerminalPanel — pseudo-terminal dock for the coding agent, WITHOUT node-pty.
//
// Renderer: wterm (@wterm/dom) — PREBUILT dist vendored into public/vendor/wterm/
// (regenerate with `node vendor-wterm.mjs`; the ~26KB Zig/WASM core is embedded
// as base64 inside the single ESM bundle). CDN URLs stay as fallbacks only.
// The stylesheet is linked from index.html (/vendor/wterm/terminal.css).
//
// Backend: /ws/terminal (terminal-hub.mjs) — JSON frames over a plain WS:
//   in:  {t:"i",d} stdin · {t:"reset"} · {t:"r"} resize · {t:"ping"}
//   out: {t:"replay",d} history · {t:"d",d} output · {t:"state",s} shell state
// (wterm's own WebSocketTransport is raw-bytes only — this thin JSON layer adds
// replay/status, and the app's WS patch in main.tsx attaches ?token= for us.)
//
// The shell runs server-side: tier "pty" (default) bridges a REAL msys pty via
// an auto-provisioned msys2 script.exe — nano/vim work, echo/^C/history are
// pty-native. Tier "pipes" (fallback until provisioning finishes) is bash -i
// over pipes, where readline still echoes/renders and the hub emulates ONLCR.
// The client stays pure pass-through in both tiers (no local echo).
import { useEffect, useRef, useState } from "preact/hooks";
import { makeId } from "../id.js";
import { loadWterm, type WTermLike } from "./wterm-loader.js";

const TERM_H_KEY = "pi.term.h";
const TERM_SESSION_KEY = "pi.termSession";

function termSessionId(): string {
	try {
		let id = sessionStorage.getItem(TERM_SESSION_KEY);
		if (!id) {
			id = makeId();
			sessionStorage.setItem(TERM_SESSION_KEY, id);
		}
		return id;
	} catch {
		return makeId();
	}
}

// event bus so the header button and bash tool rows can drive the panel
export const termBus = {
	toggle() {
		window.dispatchEvent(new CustomEvent("pi-term-open"));
	},
	run(cmd: string) {
		window.dispatchEvent(new CustomEvent("pi-term-open", { detail: cmd }));
	},
};

interface ShellState {
	phase: string; // starting | ready | dead | error
	tier: string | null; // pty | pipes
	exit: number | null;
	error: string | null;
	pid: number | null;
	/** which bridge provides the shell's tty ("conhost --headless (ConPTY)",
	 *  "script.exe (msys pty)", …) — null in the pipe tier. */
	bridge: string | null;
	/** why the pipe tier is in use, when it is a BRIDGE problem (server-sent):
	 *  nano/vim need a real pty, and "pipes" alone is not a diagnosis. */
	bridgeNote: string | null;
}

const OSC_PATTERNS = ["\x1b]133;D;", "\x1b]7;"];

export function TerminalPanel({
	open,
	command,
	onCommandDone,
	onClose,
}: {
	open: boolean;
	command: string | null;
	onCommandDone: () => void;
	onClose: () => void;
}) {
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [nonce, setNonce] = useState(0); // Retry re-runs the whole open effect
	const [shell, setShell] = useState<ShellState | null>(null);
	const [cwd, setCwd] = useState("");
	const [wsStatus, setWsStatus] = useState<"connecting" | "open" | "reconnecting" | "closed">("connecting");
	// key strip visibility FIRST (the height clamp below is strip-aware):
	// default ON for touch devices (any-pointer: coarse), OFF on desktop — the
	// user toggle persists (user request: hide on desktop / toggle-able)
	const KEYS_H = 50; // keep in sync with .pw-term-keys CSS (44px + padding)
	const ENTRY_H = 46; // keep in sync with .pw-term-entry CSS (input row)
	const [keysOn, setKeysOn] = useState(() => {
		try {
			const saved = localStorage.getItem("pi.term.keys");
			if (saved === "1") return true;
			if (saved === "0") return false;
		} catch {
			/* ignore */
		}
		return window.matchMedia?.("(any-pointer: coarse)").matches ?? false;
	});
	// the DOCK (height + optional strip + entry) must stay within the 70vh budget —
	// strip-aware everywhere the clamp is computed (sonnet r3)
	const maxDockH = () => Math.round(window.innerHeight * 0.7);
	const maxHeight = () => Math.max(140, maxDockH() - (keysOn ? KEYS_H + ENTRY_H : 0));
	const [height, setHeight] = useState(() => {
		const cap = Math.max(140, maxDockH() - ((window.matchMedia?.("(any-pointer: coarse)").matches ?? false) ? KEYS_H + ENTRY_H : 0));
		try {
			const h = Number(localStorage.getItem(TERM_H_KEY));
			if (Number.isFinite(h) && h >= 140 && h <= cap) return h;
		} catch {
			/* ignore */
		}
		return Math.min(340, Math.round(window.innerHeight * 0.4));
	});
	// persist the toggle OUTSIDE the state updater (updaters must stay pure) and
	// re-clamp height when the strip appears so the 70vh contract holds
	useEffect(() => {
		try {
			localStorage.setItem("pi.term.keys", keysOn ? "1" : "0");
		} catch {
			/* ignore */
		}
		if (keysOn) setHeight((h) => Math.min(h, maxHeight()));
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [keysOn]);
	const toggleKeys = () => setKeysOn((v) => !v);

	// --- mobile command entry (fixes wterm's compose-per-word input) ---
	// wterm's touch path (hardcoded pointer:coarse) makes the IME compose a
	// whole WORD inside an overlay at the cursor — text only reaches the shell
	// on compositionend (Gboard: on space) → Tab completion needs the
	// space+backspace dance, and the composing text shows an underline in the
	// terminal (user reports). This bar diffs the field's authoritative VALUE
	// per input event and streams the delta to the shell immediately — the
	// shell buffer is always current, so Tab completes right away. Gboard's
	// autocorrect revisions arrive as value changes → backspace+insert diffs.
	const entryRef = useRef<HTMLInputElement>(null);
	const entryMirrorRef = useRef(""); // what the shell has received from the bar
	const barHadFocusRef = useRef(false); // captured on pointerdown (before wterm re-focuses)
	// the bar's mirror is only valid within one focus session — every other
	// input path (history, ^C, wterm typing, restart) invalidates it (sonnet r5:
	// stale-mirror corruption class)
	const invalidateEntry = () => {
		if (entryRef.current) entryRef.current.value = "";
		entryMirrorRef.current = "";
	};
	const syncEntry = () => {
		const el = entryRef.current;
		if (!el) return;
		let v = el.value;
		// Android IMEs deliver the submitted line as a literal \n in the value
		// without a keydown — treat it as Enter (sonnet r5)
		const submit = v.includes("\n");
		if (submit) v = v.replace(/\n/g, "");
		const prev = entryMirrorRef.current;
		let p = 0;
		const min = Math.min(prev.length, v.length);
		while (p < min && prev[p] === v[p]) p++;
		let data = "";
		for (let i = 0; i < prev.length - p; i++) data += "\x7f"; // removals
		data += v.slice(p); // insertions (mid-string edits diff correctly)
		if (submit) data += "\r";
		// advance the mirror ONLY on a confirmed send — a dropped socket must not
		// make the bar believe the shell has text it never received (sonnet r5)
		if (!data) {
			entryMirrorRef.current = v;
			return;
		}
		if (sendInput(data)) {
			entryMirrorRef.current = v;
			if (submit) {
				el.value = "";
				entryMirrorRef.current = "";
			}
		}
	};
	const entryKeyDown = (e: KeyboardEvent) => {
		// IMEs confirm composition on Enter — never submit a half-composed line
		if ((e as any).isComposing || e.keyCode === 229) return;
		if (e.key === "Enter") {
			e.preventDefault();
			sendInput("\r");
			if (entryRef.current) entryRef.current.value = "";
			entryMirrorRef.current = "";
		} else if (e.key === "Backspace" && entryRef.current?.value === "") {
			// empty field: backspace deletes in the SHELL (readline)
			e.preventDefault();
			sendInput("\x7f");
		}
	};
	// Android keyboards often skip keydown entirely and deliver backspace as
	// deleteContentBackward — fallback path when the field is empty (sonnet r5)
	const entryBeforeInput = (e: Event) => {
		if ((e as InputEvent).inputType !== "deleteContentBackward") return;
		if (entryRef.current?.value === "") {
			e.preventDefault();
			sendInput("\x7f");
		}
	};

	// --- click/tap-to-move the shell cursor (user request) ---
	// The pty cursor IS readline's insert position, and wterm renders it as a
	// .term-cursor span inside the row's DOM. A click on the SAME row maps to a
	// char index; the delta to the cursor becomes N arrow-left/right keys —
	// exact for readline, and still sane for full-screen apps (same-row only).
	// DOM-based because wterm exposes no cursor/cell API (cols/rows only).
	const charIndexInRow = (row: Element, textNode: Node, offset: number): number => {
		let idx = 0;
		const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
		for (let n = walker.nextNode(); n; n = walker.nextNode()) {
			if (n === textNode) return idx + offset;
			idx += n.textContent?.length ?? 0;
		}
		return -1;
	};
	// the cursor element holds the char AT the cursor — its index is the total
	// text length of all PRECEDING spans in the row (works for empty EOL cursor
	// spans too). BUGFIX: the first version passed the ELEMENT into the text-node
	// walker → always -1 → click-to-move silently no-op'd on every click.
	const cursorIndexInRow = (cursorEl: Element): number => {
		let idx = 0;
		let prev = cursorEl.previousElementSibling;
		while (prev) {
			idx += prev.textContent?.length ?? 0;
			prev = prev.previousElementSibling;
		}
		return idx;
	};
	const onHostClick = (e: MouseEvent) => {
		if (disposedRef.current || loading) return;
		if (e.button !== 0) return; // primary button only (context menu / paste clicks)
		if (shellRef.current?.tier !== "pty") return; // pipe tier: cursor ≠ readline position
		const sel = window.getSelection?.();
		if (sel && !sel.isCollapsed) return; // a drag-select, not a cursor move
		const host = hostRef.current;
		if (!host) return;
		const cursorEl = host.querySelector<HTMLElement>(".term-cursor");
		const cursorRow = cursorEl?.closest(".term-row");
		if (!cursorEl || !cursorRow) {
			// one-time diagnostic: a wterm bump renaming the cursor DOM would look
			// like "click-to-move silently stopped" without this trail (sonnet r5)
			if (!(onHostClick as any)._warned) {
				(onHostClick as any)._warned = true;
				console.warn("[terminal] click-to-move: .term-cursor not found — wterm DOM changed?");
			}
			return;
		}
		// clicked character position (caret APIs work because rows are real text)
		let node: Node | null = null;
		let offset = 0;
		const docAny = document as any;
		if (document.caretRangeFromPoint) {
			const r = document.caretRangeFromPoint(e.clientX, e.clientY);
			node = r?.startContainer ?? null;
			offset = r?.startOffset ?? 0;
		} else if (typeof docAny.caretPositionFromPoint === "function") {
			const p = docAny.caretPositionFromPoint(e.clientX, e.clientY);
			node = p?.offsetNode ?? null;
			offset = p?.offset ?? 0;
		}
		if (!node) return;
		const nodeEl = node.nodeType === 1 ? (node as Element) : node.parentElement;
		const clickRow = nodeEl?.closest(".term-row") ?? null;
		if (!clickRow || clickRow !== cursorRow) return; // other rows: can't map reliably
		let clickIdx = -1;
		if (node.nodeType === 3) {
			clickIdx = charIndexInRow(clickRow, node, offset);
		} else if (node === clickRow) {
			// caret APIs hand back the ROW element for blank-area clicks — treat as
			// "end of the visible line"
			clickIdx = clickRow.textContent?.length ?? 0;
		}
		const cursorIdx = cursorIndexInRow(cursorEl);
		if (clickIdx < 0 || cursorIdx < 0) return;
		const delta = Math.max(-500, Math.min(500, clickIdx - cursorIdx));
		if (delta === 0) return;
		sendInput(delta > 0 ? "\x1b[C".repeat(delta) : "\x1b[D".repeat(-delta));
		// arrows don't change line CONTENT (mirror stays valid), but the tap just
		// handed focus to wterm's overlay — if the entry bar had it, take it back
		// or the IME compose-whole-word path wins (sonnet r5 P0)
		if (barHadFocusRef.current) entryRef.current?.focus();
	};
	// click-to-move handler — attached DIRECTLY to the host element in the open
	// effect (NOT via Preact's delegated onClick): iOS Safari does not synthesize
	// click events on plain <div>s for root-delegated handlers, which is why
	// click-to-move worked on desktop but not on mobile (user report)
	const hostClickRef = useRef<(e: MouseEvent) => void>(() => {});
	hostClickRef.current = onHostClick;
	const hostRef = useRef<HTMLDivElement>(null);
	const termRef = useRef<WTermLike | null>(null);
	const wsRef = useRef<WebSocket | null>(null);
	const disposedRef = useRef(false);
	const termDestroyedRef = useRef(false); // wterm.destroy() must run exactly once
	const carryRef = useRef(""); // OSC split across chunks
	const expectReplayRef = useRef(true);
	const lastSentRef = useRef<string | null>(null);
	const shellRef = useRef<ShellState | null>(null);
	shellRef.current = shell;

	// idempotent destroy — the async init continuation can race the effect
	// cleanup (open flips while init() is in flight) and must not destroy twice
	const safeDestroy = (t: WTermLike) => {
		if (termDestroyedRef.current) return;
		termDestroyedRef.current = true;
		try {
			t.destroy();
		} catch {
			/* already dead */
		}
	};

	// grid size for the server (pty tier resizes the console; pipes tier ignores
	// it) — term.cols/rows are the APPLIED dimensions per wterm's docs
	const sendResize = (): boolean => {
		const term = termRef.current;
		const ws = wsRef.current;
		if (!term || !ws || ws.readyState !== 1) return false;
		try {
			ws.send(JSON.stringify({ t: "r", cols: term.cols ?? 0, rows: term.rows ?? 0 }));
			return true;
		} catch {
			return false;
		}
	};

	// stdin writer — hoisted so both the socket handlers and the command bridge
	// share one implementation (reads wsRef.current, so it is always current)
	const sendInput = (data: string): boolean => {
		const ws = wsRef.current;
		if (!ws || ws.readyState !== 1) return false;
		for (let i = 0; i < data.length; i += 4096) {
			try {
				ws.send(JSON.stringify({ t: "i", d: data.slice(i, i + 4096) }));
			} catch {
				return false;
			}
		}
		return true;
	};

	useEffect(() => {
		if (!open) return;
		disposedRef.current = false;
		termDestroyedRef.current = false; // fresh instance per open cycle
		entryMirrorRef.current = ""; // fresh shell per open cycle
		// click-to-move: DIRECT element listener (iOS Safari + delegated clicks —
		// see hostClickRef note). Attached for the whole panel lifetime; the
		// handler self-gates on loading/tier/selection.
		const host = hostRef.current;
		const hostClick = (e: MouseEvent) => hostClickRef.current(e);
		host?.addEventListener("click", hostClick);
		setLoading(true);
		setLoadError(null);
		setShell(null);
		setCwd("");
		setWsStatus("connecting");
		expectReplayRef.current = true;
		lastSentRef.current = null;
		carryRef.current = "";

		let reconnectTimer: any = null;
		let attempts = 0;
		let cancelled = false;
		let firstResizeSeen = false; // wterm's own signal that the grid is measured
		let notifyResize: (() => void) | null = null;

		// best-effort shell metadata from OSC 133;D (exit code) + OSC 7 (cwd).
		// Conhost swallows OSC in the winpty tier; the pipe tier delivers them.
		const handleOscBody = (body: string) => {
			if (body.startsWith("133;D;")) {
				const code = parseInt(body.slice(6), 10);
				if (Number.isFinite(code)) {
					setShell((s) => (s ? { ...s, exit: code } : s));
				}
			} else if (body.startsWith("7;")) {
				const uri = body.slice(2);
				if (uri.startsWith("file://")) {
					try {
						setCwd(decodeURIComponent(uri.slice(7)) || "");
					} catch {
						setCwd(uri.slice(7));
					}
				}
			}
		};
		const scanMarkers = (chunk: string) => {
			if (!chunk.includes("\x1b]") && !carryRef.current) return;
			let s = carryRef.current + chunk;
			carryRef.current = "";
			let consumed = 0;
			for (;;) {
				let hit = -1;
				for (const pat of OSC_PATTERNS) {
					const i = s.indexOf(pat, consumed);
					if (i !== -1 && (hit === -1 || i < hit)) hit = i;
				}
				if (hit === -1) break;
				// terminator: BEL (7-bit) or ST (ESC \)
				const bel = s.indexOf("\x07", hit);
				const st = s.indexOf("\x1b\\", hit);
				let end = -1;
				let endLen = 0;
				if (bel !== -1 && (st === -1 || bel < st)) {
					end = bel;
					endLen = 1;
				} else if (st !== -1) {
					end = st;
					endLen = 2;
				}
				if (end === -1) {
					// incomplete OSC — keep the remainder for the next chunk
					carryRef.current = s.length - consumed > 4096 ? "" : s.slice(consumed);
					return;
				}
				handleOscBody(s.slice(hit + 2, end));
				consumed = end + endLen;
			}
			if (s.length - consumed <= 4096) carryRef.current = s.slice(consumed);
		};

		const connect = () => {
			if (cancelled || disposedRef.current) return;
			setWsStatus(attempts === 0 ? "connecting" : "reconnecting");
			const proto = location.protocol === "https:" ? "wss:" : "ws:";
			// cols/rows → the pty: full-screen TUIs (nano/vim) paint exactly the
			// emulator grid — a size mismatch crops their bottom UI (user report).
			// Guards: undefined/stale → 80x24 (server clamps anyway).
			const t = termRef.current;
			const cols = t?.cols && t.cols > 0 ? t.cols : 80;
			const rows = t?.rows && t.rows > 0 ? t.rows : 24;
			const ws = new WebSocket(`${proto}//${location.host}/ws/terminal?session=${encodeURIComponent(termSessionId())}&cols=${cols}&rows=${rows}`);
			wsRef.current = ws;
			ws.onopen = () => {
				attempts = 0;
				setWsStatus("open");
				expectReplayRef.current = true;
				sendResize(); // announce the real grid size before the first replay
			};
			ws.onmessage = (ev) => {
				let m: any;
				try {
					m = JSON.parse(String(ev.data));
				} catch {
					return;
				}
				if (m.t === "replay" || m.t === "d") {
					const d = String(m.d ?? "");
					if (m.t === "replay" && expectReplayRef.current) {
						// fresh connection: the local view may hold stale rows from a
						// previous socket — clear before the server's ring replays
						expectReplayRef.current = false;
						termRef.current?.write("\x1b[2J\x1b[3J\x1b[H");
					}
					termRef.current?.write(d);
					scanMarkers(d);
				} else if (m.t === "clear") {
					// reset: the server killed the shell — drop the dead screen. Other
					// attached sockets get this too (they didn't replay anything).
					termRef.current?.write("\x1b[2J\x1b[3J\x1b[H");
				} else if (m.t === "state") {
					const s: ShellState = {
						phase: String(m.s?.phase ?? "starting"),
						tier: m.s?.tier ?? null,
						exit: Number.isFinite(m.s?.exit) ? Number(m.s.exit) : null,
						error: m.s?.error ?? null,
						pid: Number.isFinite(m.s?.pid) ? Number(m.s.pid) : null,
						bridge: m.s?.bridge ? String(m.s.bridge) : null,
						bridgeNote: m.s?.bridgeNote ? String(m.s.bridgeNote) : null,
					};
					setShell(s);
				}
			};
			ws.onclose = () => {
				if (cancelled || disposedRef.current || wsRef.current !== ws) return;
				wsRef.current = null;
				if (attempts >= 6) {
					setWsStatus("closed");
					return;
				}
				attempts += 1;
				setWsStatus("reconnecting");
				reconnectTimer = setTimeout(connect, Math.min(5000, 400 * 2 ** attempts));
			};
			ws.onerror = () => {
				/* close handler drives reconnection */
			};
		};

		(async () => {
			try {
				const WTermCtor = await loadWterm();
				if (cancelled || disposedRef.current || !hostRef.current) return;
				const term = new WTermCtor(hostRef.current, {
					cursorBlink: true,
					autoResize: true,
					onData: (data: string) => {
						sendInput(data);
					},
					onResize: () => {
						firstResizeSeen = true;
						sendResize(); // server remembers the grid; Restart respawns at it
						// the init continuation may be waiting for the first measurement
						try {
							notifyResize?.();
						} catch {
							/* ignore */
						}
					},
				});
				termRef.current = term;
				await term.init();
				if (cancelled || disposedRef.current) {
					safeDestroy(term);
					return;
				}
				setLoading(false);
				// the dock is an interactive surface — focus it on open so keyboard
				// users land where the next keystroke goes
				setTimeout(() => term.focus(), 60);
				// P0 (sonnet r3): cols/rows on the connect URL must be the MEASURED
				// grid, not wterm's 80x24 fallback — wait for the first onResize
				// (ResizeObserver timing) with a 300ms cap, then connect
				if (!firstResizeSeen) {
					await new Promise<void>((resolve) => {
						notifyResize = resolve;
						setTimeout(resolve, 300);
					});
					notifyResize = null;
				}
				if (cancelled || disposedRef.current) {
					safeDestroy(term);
					return;
				}
				connect();
			} catch (err) {
				if (cancelled || disposedRef.current) return;
				setLoading(false);
				setLoadError(err instanceof Error ? err.message : String(err));
			}
		})();

		return () => {
			cancelled = true;
			disposedRef.current = true;
			host?.removeEventListener("click", hostClick);
			if (reconnectTimer) clearTimeout(reconnectTimer);
			const ws = wsRef.current;
			wsRef.current = null;
			if (ws) {
				ws.onclose = null;
				ws.onmessage = null;
				ws.onerror = null;
				try {
					ws.close();
				} catch {
					/* ignore */
				}
			}
			const term = termRef.current;
			termRef.current = null;
			if (term) safeDestroy(term);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, nonce]);

	// "↗ terminal" on a bash tool row → run the command once the shell is live.
	// lastSentRef clears when command returns to null, so re-running the SAME
	// command works (the guard only dedupes effects while one command is active).
	useEffect(() => {
		if (!open || command === null) {
			lastSentRef.current = null;
			return;
		}
		if (lastSentRef.current === command) return;
		if (wsRef.current?.readyState !== 1) return;
		const phase = shellRef.current?.phase;
		if (phase !== "ready" && phase !== "starting") return;
		// if sendInput fails the socket raced closed — wsStatus changes next and
		// re-runs this effect, so dropping the attempt here is self-healing
		if (!sendInput(command + "\r")) return;
		lastSentRef.current = command;
		invalidateEntry(); // the shell line now holds the command — bar mirror stale
		termRef.current?.focus(); // every run surfaces the dock, not just open-time
		onCommandDone();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [command, open, shell?.phase, wsStatus]);

	const restart = () => {
		const ws = wsRef.current;
		if (ws && ws.readyState === 1) {
			try {
				ws.send(JSON.stringify({ t: "reset" }));
			} catch {
				/* ignore */
			}
		}
		invalidateEntry(); // fresh shell — the bar's mirror is meaningless now
	};
	const clearView = () => {
		termRef.current?.write("\x1b[2J\x1b[3J\x1b[H");
		termRef.current?.focus();
	};
	// Exit (sonnet r2 P0): never send literal "exit\r" — inside vim/nano those
	// keystrokes would hit the EDITOR, not the shell. The server's {t:"kill"}
	// frame ends the shell unambiguously from any foreground state.
	const exitShell = () => {
		const ws = wsRef.current;
		if (ws && ws.readyState === 1) {
			try {
				ws.send(JSON.stringify({ t: "kill" }));
			} catch {
				/* ignore */
			}
		}
	};
	// touch key strip: touch keyboards have no arrows/Tab/Esc/Paste — send the
	// raw bytes/read clipboard directly (readline consumes them). Desktop HIDES
	// it (physical keyboard); toggle via the head's "Keys" button, persisted.
	const TERM_KEYS: Array<[string, string]> = [
		["↑", "\x1b[A"],
		["↓", "\x1b[B"],
		["←", "\x1b[D"],
		["→", "\x1b[C"],
		["Tab", "\t"],
		["Esc", "\x1b"],
	];
	const keyLabel = (l: string) =>
		l === "↑" ? "up arrow" : l === "↓" ? "down arrow" : l === "←" ? "left arrow" : l === "→" ? "right arrow" : l === "Esc" ? "Escape key" : l;
	// keep wterm's textarea focused when a key button is tapped, or the OS
	// keyboard dismisses and the user must re-tap the terminal (sonnet r2 P1)
	const keyPointerDown = (e: PointerEvent) => e.preventDefault();
	const sendKeyBytes = (bytes: string) => {
		sendInput(bytes);
		// history/^C change the shell line — the bar's mirror is stale now
		invalidateEntry();
		if (barHadFocusRef.current) entryRef.current?.focus(); // keep the keyboard (sonnet r5)
	};
	// hold-to-repeat for ↑/↓ (history scroll) — timers cleared on release,
	// cancel, AND unmount (an orphaned interval must never outlive the panel)
	const repeatRef = useRef<{ to?: any; iv?: any }>({});
	const stopRepeat = () => {
		clearTimeout(repeatRef.current.to);
		clearInterval(repeatRef.current.iv);
		repeatRef.current = {};
	};
	const startRepeat = (bytes: string) => {
		sendKeyBytes(bytes);
		stopRepeat();
		repeatRef.current.to = setTimeout(() => {
			repeatRef.current.iv = setInterval(() => sendInput(bytes), 70);
		}, 350);
	};
	useEffect(() => stopRepeat, []); // unmount mid-hold
	const pasteIntoShell = async () => {
		try {
			const text = await navigator.clipboard.readText();
			if (text) sendKeyBytes(text);
		} catch {
			/* clipboard denied — no-op (user gesture was present) */
		}
	};
	// drag-to-resize: pointer capture + pointercancel (a canceled touch drag
	// must not leak a permanent global pointermove listener), pointerId filtered,
	// text selection suppressed for the drag, keyboard-operable (see onGripKey)
	const onGripDown = (e: PointerEvent) => {
		e.preventDefault();
		const grip = e.currentTarget as HTMLElement;
		const pid = e.pointerId;
		try {
			grip.setPointerCapture(pid);
		} catch {
			/* capture is best-effort; window listeners still work */
		}
		const startY = e.clientY;
		const startH = height;
		let cur = startH;
		const prevSelect = document.body.style.userSelect;
		document.body.style.userSelect = "none"; // dragging must not select chat text
		const move = (ev: PointerEvent) => {
			if (ev.pointerId !== pid) return;
			const dy = startY - ev.clientY;
			cur = Math.min(maxHeight(), Math.max(140, startH + dy));
			setHeight(cur);
		};
		const end = (ev: PointerEvent) => {
			if (ev.pointerId !== pid) return;
			try {
				grip.releasePointerCapture(pid);
			} catch {
				/* ignore */
			}
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", end);
			window.removeEventListener("pointercancel", end);
			document.body.style.userSelect = prevSelect;
			try {
				localStorage.setItem(TERM_H_KEY, String(cur));
			} catch {
				/* ignore */
			}
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", end);
		window.addEventListener("pointercancel", end);
	};
	// keyboard resize (WCAG 2.1.1 — the grip is a separator control)
	const onGripKey = (e: KeyboardEvent) => {
		let next: number | null = null;
		if (e.key === "ArrowUp") next = height + 28;
		else if (e.key === "ArrowDown") next = height - 28;
		else if (e.key === "Home") next = Number.MAX_SAFE_INTEGER;
		else if (e.key === "End") next = 140;
		else return;
		e.preventDefault();
		const nextH = Math.min(maxHeight(), Math.max(140, next));
		setHeight(nextH);
		try {
			localStorage.setItem(TERM_H_KEY, String(nextH));
		} catch {
			/* ignore */
		}
	};

	// keep a persisted tall height reachable when the viewport shrinks later
	useEffect(() => {
		const onWinResize = () => setHeight((h) => Math.min(h, maxHeight()));
		window.addEventListener("resize", onWinResize);
		return () => window.removeEventListener("resize", onWinResize);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [keysOn]);

	if (!open) return null;

	// OSC payloads are untrusted shell output — strip control chars (bidi
	// overrides etc.) before they reach the status header
	const cleanCwd = cwd.replace(/[\u0000-\u001f\u007f]/g, "");

	const dotClass =
		loadError || shell?.phase === "error" || shell?.phase === "dead"
			? "pw-term-dot pw-dot-error"
			: wsStatus === "open" && shell?.phase === "ready"
				? "pw-term-dot pw-dot-ok"
				: "pw-term-dot pw-dot-wait";
	// pipes + a BRIDGE problem (no pty): say so in the status line — the note row
	// below carries the reason. Computed here so the ternary below stays flat.
	const pipesLabel = shell?.bridgeNote ? "bash — pipes (no pty: nano/vim unavailable)" : "bash — pipes (readline)";
	// WHICH bridge gave the shell its tty matters for support: a msys pty and ConPTY
	// behave differently (resize, ^C, job control), so name it.
	const ptyLabel = /conhost/i.test(shell?.bridge || "") ? "bash — pty (conhost)" : shell?.bridge ? "bash — pty (msys)" : "bash — pty";
	const statusText = loadError
		? "terminal failed to load"
		: wsStatus !== "open"
			? wsStatus === "closed"
				? "disconnected — reopen to retry"
				: "connecting…"
			: !shell
				? "waiting for shell…"
				: shell.phase === "ready"
					? shell.tier === "pty"
						? ptyLabel
						: pipesLabel
					: shell.phase === "dead"
						? `shell exited (${shell.exit ?? "?"})`
						: shell.phase === "error"
							? shell.error || "shell error"
							: "starting shell…";

	return (
		<div class="pw-term-dock" style={{ height: `${height + (keysOn ? KEYS_H + ENTRY_H : 0)}px` }}>
			<div
				class="pw-term-grip"
				title="Drag to resize (arrow keys / Home / End)"
				role="separator"
				aria-orientation="horizontal"
				aria-label="Resize terminal"
				tabIndex={0}
				onPointerDown={onGripDown}
				onKeyDown={onGripKey}
			>
				<span />
			</div>
			{shell?.bridgeNote && shell.tier === "pipes" && (
				<div class="pw-term-note" role="status" title={shell.bridgeNote}>
					⚠ no pty — nano/vim need one. {shell.bridgeNote}
				</div>
			)}
			<div class="pw-term-head">
				<span class={dotClass} aria-hidden="true" />
				<span class="pw-term-status" aria-live="polite" aria-atomic="true">
					{statusText}
				</span>
				{cleanCwd && (
					<span class="pw-term-cwd" title={cleanCwd}>
						{cleanCwd.split(/[\\/]/).pop() || cleanCwd}
					</span>
				)}
				{shell && shell.phase === "ready" && shell.exit !== null && (
					<span class={"pw-term-exit" + (shell.exit === 0 ? "" : " pw-term-exit-bad")}>exit {shell.exit}</span>
				)}
				<span class="pw-term-spacer" />
				{wsStatus === "closed" && !loading && !loadError && (
					<button type="button" class="pw-mini-btn" title="Retry the connection" onClick={() => setNonce((n) => n + 1)}>
						Reconnect
					</button>
				)}
				<button
					type="button"
					class="pw-mini-btn"
					title="Toggle key strip (arrows / Tab / Esc / Paste; grid applies after Restart)"
					aria-label="Toggle key strip"
					aria-pressed={keysOn}
					onClick={toggleKeys}
				>
					Keys
				</button>
				<button
					type="button"
					class="pw-mini-btn"
					title="Send Ctrl+C to the shell"
					aria-label="Send interrupt (Ctrl+C)"
					disabled={wsStatus !== "open" || loading}
					onClick={() => {
						sendInput("\x03");
						invalidateEntry(); // ^C clears the shell line
					}}
				>
					^C
				</button>
				<button type="button" class="pw-mini-btn" title="Clear the view" aria-label="Clear the terminal view" disabled={loading} onClick={clearView}>
					Clear
				</button>
				<button
					type="button"
					class="pw-mini-btn"
					title="Kill and restart the shell"
					aria-label="Restart shell"
					disabled={loading || wsStatus !== "open"}
					onClick={restart}
				>
					Restart
				</button>
				<button
					type="button"
					class="pw-mini-btn"
					title="End the shell session (kills the shell; Restart respawns)"
					aria-label="Exit shell"
					disabled={wsStatus !== "open" || loading || shell?.phase === "dead" || shell?.phase === "error"}
					onClick={exitShell}
				>
					Exit
				</button>
				<button type="button" class="pw-mini-btn" title="Close terminal" aria-label="Close terminal" onClick={onClose}>
					✕
				</button>
			</div>
			{keysOn && (
				<div class="pw-term-entry">
					<input
						ref={entryRef}
						type="text"
						class="pw-term-entry-input"
						placeholder="type here — Enter runs · chars stream to the shell live (Tab completes)"
						enterKeyHint="send"
						autocapitalize={"off" as any}
						autoCorrect="off"
						autoComplete="off"
						spellcheck={false}
						aria-label="Terminal command entry"
						disabled={wsStatus !== "open" || loading}
						onInput={syncEntry}
						onKeyDown={entryKeyDown}
						onBeforeInput={entryBeforeInput}
						onFocus={invalidateEntry}
					/>
				</div>
			)}
			{keysOn && (
				<div class="pw-term-keys" role="group" aria-label="Terminal keys (touch)">
					{TERM_KEYS.map(([label, bytes]) => {
						const repeatable = label === "↑" || label === "↓";
						return (
							<button
								key={label}
								type="button"
								class="pw-term-key"
								aria-label={`Send ${keyLabel(label)}`}
								title={`Send ${keyLabel(label)}`}
								disabled={wsStatus !== "open" || loading}
								onPointerDown={(e) => {
									e.preventDefault(); // keep wterm's textarea focus / OS keyboard
									if (repeatable) startRepeat(bytes);
								}}
								onPointerUp={() => repeatable && stopRepeat()}
								onPointerLeave={() => repeatable && stopRepeat()}
								onPointerCancel={() => repeatable && stopRepeat()}
								onClick={() => {
									if (!repeatable) sendKeyBytes(bytes); // repeatables already fired on pointerdown
									else termRef.current?.focus();
								}}
							>
								{label}
							</button>
						);
					})}
					<button
						type="button"
						class="pw-term-key"
						aria-label="Paste from clipboard"
						title="Paste from clipboard"
						disabled={wsStatus !== "open" || loading}
						onPointerDown={keyPointerDown}
						onClick={() => void pasteIntoShell()}
					>
						Paste
					</button>
				</div>
			)}
			<div
			class="pw-term-host"
			ref={hostRef}
			role="group"
			aria-label="Terminal"
			onPointerDownCapture={() => {
				// snapshot BEFORE wterm's click-to-focus moves focus (sonnet r5)
				barHadFocusRef.current = document.activeElement === entryRef.current;
			}}
		/>
			{(loading || loadError) && (
				<div class="pw-term-veil">
					{loadError ? (
						<>
							<div class="pw-term-veil-title">terminal failed to load</div>
							<div class="pw-term-veil-sub">{loadError}</div>
							<div class="pw-term-veil-sub">the vendored /vendor/wterm/wterm.js is missing — CDN fallback failed too</div>
							<button type="button" class="pw-mini-btn" onClick={() => setNonce((n) => n + 1)}>
								Retry
							</button>
						</>
					) : (
						<div class="pw-term-veil-sub">loading wterm…</div>
					)}
				</div>
			)}
		</div>
	);
}
