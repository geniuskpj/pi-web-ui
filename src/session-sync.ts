// WebSocket session sync — shares sessions across devices via the local server.
//
// Protocol (JSON over /ws/sync):
//   client -> server: {type:"list"}                          -> {type:"sessions", sessions:[metadata]}
//                     {type:"get", id}                       -> {type:"session", id, data, metadata}
//                     {type:"put", id, data, metadata}       -> (broadcast) sessions list to others
//                     {type:"delete", id}
//
// Hardened (v3):
//   - broadcasts merge METADATA only, throttled AND coalesced (no overlapping
//     merge passes; one batched IndexedDB transaction instead of N)
//   - full session data pulled ONLY on explicit open (loadSession)
//   - push coalescing: rapid saves collapse into one in-flight put
//   - reconnect backoff WITH jitter; stale-socket generation guard
//   - waiter map cleaned up on both resolve and timeout
import { getAppStorage } from "./storage.js"; // P0: own storage layer (was pi-web-ui)

const TOMBSTONE_KEY = "sync-tombstones";
const TOMBSTONE_TTL = 30 * 24 * 3600 * 1000;
const META_MERGE_MIN_INTERVAL = 5000;

type AnyRecord = Record<string, any>;

class SessionSync {
	private ws: WebSocket | null = null;
	private enabled = false;
	private retry = 0;
	private retryTimer: any;
	private generation = 0; // invalidates callbacks from superseded sockets
	private pullInflight = new Map<string, Promise<AnyRecord | undefined>>();
	private pushInflight = new Map<string, Promise<void>>();
	private pushDirty = new Set<string>();
	private waiters = new Map<string, (msg: AnyRecord) => void>();
	private pendingPushes = new Set<string>(); // pushes queued while the socket is down (bugs.md #19)
	private merging = false;
	private lastMetaMerge = 0;

	connect() {
		this.enabled = true;
		this.dial();
	}

	private dial() {
		if (!this.enabled) return;
		const gen = ++this.generation;
		try {
			const proto = location.protocol === "https:" ? "wss:" : "ws:";
			this.ws = new WebSocket(`${proto}//${location.host}/ws/sync`);
		} catch {
			this.scheduleRetry();
			return;
		}
		const sock = this.ws;
		this.ws.onopen = () => {
			if (gen !== this.generation) return;
			this.retry = 0;
			// de-sync mass reconnects after a server restart (jitter)
			setTimeout(() => {
				if (this.ws === sock && gen === this.generation) {
					this.send({ type: "list" });
					// flush puts queued while the socket was down (saves made during
					// reconnect windows used to be silently dropped — bugs.md #19)
					for (const id of this.pendingPushes) this.push(id);
					this.pendingPushes.clear();
				}
			}, Math.random() * 400);
		};
		this.ws.onmessage = (e) => {
			if (gen !== this.generation) return;
			if (typeof e.data === "string" && e.data.length > 50 * 1024 * 1024) return; // absurd size guard
			try {
				this.handle(JSON.parse(e.data));
			} catch (err) {
				console.warn("[sync] bad message:", err);
			}
		};
		this.ws.onclose = () => {
			if (gen !== this.generation) return;
			this.ws = null;
			this.scheduleRetry();
		};
		this.ws.onerror = () => {
			try {
				sock.close();
			} catch {
				/* noop */
			}
		};
	}

	private scheduleRetry() {
		if (!this.enabled) return;
		const base = Math.min(30000, 1000 * 2 ** this.retry++);
		const delay = base * (0.5 + Math.random() * 0.5); // jitter
		clearTimeout(this.retryTimer);
		this.retryTimer = setTimeout(() => this.dial(), delay);
	}

	private send(msg: AnyRecord) {
		if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
	}

	/** Mirror a locally-saved session to the server. Coalesces rapid saves. */
	push(id: string) {
		if (this.pushInflight.has(id)) {
			this.pushDirty.add(id);
			return;
		}
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			// socket not up yet (boot-time load, reconnect window): queue instead of
			// silently dropping — previously send() no-op'd on a closed socket
			this.pendingPushes.add(id);
			return;
		}
		const p = this.pushNow(id)
			.catch((err) => console.warn("[sync] push failed:", err))
			.finally(() => {
				this.pushInflight.delete(id);
				if (this.pushDirty.delete(id)) this.push(id);
			});
		this.pushInflight.set(id, p);
	}

	private async pushNow(id: string) {
		const storage = getAppStorage();
		if (!storage.sessions) return;
		const data = await storage.sessions.get(id);
		const metadata = await storage.sessions.getMetadata(id);
		if (!data || !metadata) return;
		this.send({ type: "put", id, data, metadata });
	}

	/** Fetch a full session from the server mirror (explicit, on open). */
	getSession(id: string): Promise<AnyRecord | undefined> {
		const existing = this.pullInflight.get(id);
		if (existing) return existing as Promise<AnyRecord | undefined>;
		const p = new Promise<AnyRecord | undefined>((resolve) => {
			const timer = setTimeout(() => {
				this.waiters.delete(id);
				this.pullInflight.delete(id);
				resolve(undefined);
			}, 6000);
			this.waiters.set(id, (msg: AnyRecord) => {
				clearTimeout(timer);
				this.waiters.delete(id);
				this.pullInflight.delete(id);
				resolve(msg.data ? { data: msg.data, metadata: msg.metadata } : undefined);
			});
			this.send({ type: "get", id });
		});
		this.pullInflight.set(id, p);
		return p;
	}

	/** Mirror a deletion to the server + tombstone locally (survives pulls). */
	async delete(id: string) {
		await this.tombstone(id);
		this.send({ type: "delete", id });
	}

	private async tombstone(id: string) {
		const storage = getAppStorage();
		const t = (await storage.settings.get<AnyRecord>(TOMBSTONE_KEY)) || {};
		t[id] = Date.now();
		await storage.settings.set(TOMBSTONE_KEY, t);
	}

	private async isTombstoned(id: string, lastModified?: string) {
		const storage = getAppStorage();
		const t = (await storage.settings.get<AnyRecord>(TOMBSTONE_KEY)) || {};
		const ts = t[id];
		if (!ts) return false;
		return !lastModified || new Date(lastModified).getTime() < ts;
	}

	private async handle(msg: AnyRecord) {
		if (msg.type === "session") {
			// only fulfill explicit getSession() requests — never auto-write
			const w = this.waiters.get(msg.id);
			if (w) {
				this.pullInflight.delete(msg.id);
				w(msg);
			}
			return;
		}
		if (msg.type !== "sessions") return;

		// throttle AND coalesce (no overlapping merge passes)
		const now = Date.now();
		if (now - this.lastMetaMerge < META_MERGE_MIN_INTERVAL || this.merging) return;
		this.lastMetaMerge = now;
		this.merging = true;
		try {
			const storage = getAppStorage();
			if (!storage.sessions) return;
			const toWrite: AnyRecord[] = [];
			for (const m of msg.sessions || []) {
				if (!m?.id) continue;
				if (await this.isTombstoned(m.id, m.lastModified)) continue;
				const local = (await storage.sessions.getMetadata(m.id)) as AnyRecord | null;
				if (!local || new Date(m.lastModified) > new Date(local.lastModified)) toWrite.push(m);
			}
			if (toWrite.length > 0) {
				// LocalStorageBackend writes are synchronous-fast — no batched IDB tx needed
				const backend = (storage.sessions as any).getBackend();
				for (const m of toWrite) await backend.set("sessions-metadata", m.id, m);
			}
		} finally {
			this.merging = false;
		}
	}
}

export const sessionSync = new SessionSync();
