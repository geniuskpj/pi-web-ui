// diag.ts — hand-rolled diagnostics core (ring buffer + levels + trace ids).
// Always shipped; the log LEVEL is a runtime knob (?debug=trace or the panel),
// never a build flag. Warn/error are always captured AND mirrored to console.
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";
export interface LogEntry {
	seq: number;
	ts: number;
	level: LogLevel;
	source: string;
	msg: string;
	data?: Record<string, unknown>;
	traceId?: string;
}
const WEIGHT: Record<LogLevel, number> = { trace: 0, debug: 1, info: 2, warn: 3, error: 4 };

class Ring {
	private buf: LogEntry[] = [];
	private writeIdx = 0;
	private count = 0;
	private seq = 0;
	level: LogLevel = (new URLSearchParams(location.search).get("log") as LogLevel) || "info";
	listeners = new Set<(e: LogEntry) => void>();
	currentTraceId?: string;

	constructor(private capacity = 2000) {}

	log(level: LogLevel, source: string, msg: string, data?: Record<string, unknown>) {
		if (WEIGHT[level] < WEIGHT[this.level]) return;
		const entry: LogEntry = { seq: this.seq++, ts: Date.now(), level, source, msg, data, traceId: this.currentTraceId };
		this.buf[this.writeIdx] = entry;
		this.writeIdx = (this.writeIdx + 1) % this.buf.length;
		this.count = Math.min(this.count + 1, this.buf.length);
		for (const l of [...this.listeners]) {
			try {
				l(entry);
			} catch {
				/* listener error — ignore */
			}
		}
		if (level === "warn" || level === "error") {
			(console[level] ?? console.log)(`[${source}] ${msg}`, data ?? "");
		}
		return entry;
	}
	trace(s: string, m: string, d?: Record<string, unknown>) {
		return this.log("trace", s, m, d);
	}
	debug(s: string, m: string, d?: Record<string, unknown>) {
		return this.log("debug", s, m, d);
	}
	info(s: string, m: string, d?: Record<string, unknown>) {
		return this.log("info", s, m, d);
	}
	warn(s: string, m: string, d?: Record<string, unknown>) {
		return this.log("warn", s, m, d);
	}
	error(s: string, m: string, d?: Record<string, unknown>) {
		return this.log("error", s, m, d);
	}
	snapshot(n = this.count): LogEntry[] {
		const take = Math.min(n, this.count);
		const out: LogEntry[] = [];
		let idx = (this.writeIdx - take + this.buf.length) % this.buf.length;
		for (let i = 0; i < take; i++) {
			out.push(this.buf[idx]);
			idx = (idx + 1) % this.buf.length;
		}
		return out;
	}
	errorsAndWarnings(limit = 50) {
		return this.snapshot().filter((e) => e.level === "warn" || e.level === "error").slice(-limit);
	}
	setLevel(level: LogLevel) {
		this.level = level;
		localStorage.setItem("pi.logLevel", level);
	}
	subscribe(fn: (e: LogEntry) => void) {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}
}

export const diag = new Ring(2000);

// console mirror (so devtools still works) — routed through the ring
export const dlog = {
	debug: (...args: unknown[]) => diag.debug("app", args.map(String).join(" ")),
	info: (...args: unknown[]) => diag.info("app", args.map(String).join(" ")),
	warn: (...args: unknown[]) => diag.warn("app", args.map(String).join(" ")),
	error: (...args: unknown[]) => diag.error("app", args.map(String).join(" ")),
};

export const newTraceId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

export const buildId = () => {
	const m = /assets\/(app-[A-Z0-9]+\.js)/.exec(document.querySelector('script[src*="app-"]')?.getAttribute("src") || "");
	return m ? m[1] : "unknown";
};

/** Assemble the "copy diagnostics" payload (client + server side). */
export async function buildDiagnosticsReport(): Promise<string> {
	let serverState: unknown = null;
	try {
		const r = await fetch("/api/debug/state");
		if (r.ok) serverState = await r.json();
	} catch {
		/* server offline */
	}
	return JSON.stringify(
		{
			ts: new Date().toISOString(),
			buildId: buildId(),
			userAgent: navigator.userAgent,
			online: navigator.onLine,
			viewport: { w: innerWidth, h: innerHeight },
			logLevel: diag.level,
			sessionId: localStorage.getItem("pi.currentSession") || undefined,
			serverState,
			errorsAndWarnings: diag.errorsAndWarnings(50),
			log: diag.snapshot(400),
		},
		null,
		2,
	);
}
