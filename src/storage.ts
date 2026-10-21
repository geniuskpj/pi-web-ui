// Self-contained storage stores — replacement for the pi-web-ui storage layer
// (plan.md P0). Same store names and localStorage keys as the pi-web-ui stores
// they replace — no migration, existing data keeps working.
//
// Backed by LocalStorageBackend (synchronous, never hangs — see
// local-storage-backend.js for why IndexedDB was dropped).
//
// Ported pi-web-ui behavior:
//   - Store base class (setBackend/getBackend) — sessions-metadata writes go
//     through `(storage.sessions as any).getBackend()` in session-sync/main.
//   - ProviderKeysStore mirrors keys to localStorage `pi.key.<provider>` on
//     write and reads localStorage-first (the build.mjs patches to the
//     pi-web-ui store did exactly this; now built-in).
import { LocalStorageBackend } from "./local-storage-backend.js";

export type AnyRecord = Record<string, any>;

/** Base class for all stores. Mirrors pi-web-ui storage/store.js. */
export abstract class Store {
	backend: LocalStorageBackend | null = null;

	setBackend(backend: LocalStorageBackend): void {
		this.backend = backend;
	}

	getBackend(): LocalStorageBackend {
		if (!this.backend) throw new Error(`Backend not set on ${this.constructor.name}`);
		return this.backend;
	}

	abstract getConfig(): { name: string; keyPath?: string; indices?: any[] };
}

/** App settings (theme, proxy config, sync tombstones...). */
export class SettingsStore extends Store {
	getConfig() {
		return { name: "settings" };
	}
	async get<T = any>(key: string): Promise<T | null> {
		return (await this.getBackend().get("settings", key)) as T | null;
	}
	async set(key: string, value: any): Promise<void> {
		await this.getBackend().set("settings", key, value);
	}
	async delete(key: string): Promise<void> {
		await this.getBackend().delete("settings", key);
	}
	async list(): Promise<string[]> {
		return this.getBackend().keys("settings");
	}
	async clear(): Promise<void> {
		await this.getBackend().clear("settings");
	}
}

/** LLM provider API keys. localStorage `pi.key.<provider>` is the CANONICAL fast tier:
 *  get/has read it first; set/delete mirror it; list() unions it with the backend.
 *  Do NOT write the backend directly from elsewhere — the fast tier would go stale. */
export class ProviderKeysStore extends Store {
	private lsKey(provider: string) {
		return "pi.key." + provider;
	}
	private lsProviders(): string[] {
		try {
			const out: string[] = [];
			for (let i = 0; i < localStorage.length; i++) {
				const k = localStorage.key(i);
				if (k?.startsWith("pi.key.")) out.push(k.slice("pi.key.".length));
			}
			return out;
		} catch {
			return [];
		}
	}
	getConfig() {
		return { name: "provider-keys" };
	}
	async get(provider: string): Promise<string | null> {
		try {
			const ls = localStorage.getItem(this.lsKey(provider));
			if (ls) return ls;
		} catch {
			/* localStorage unavailable */
		}
		return (await this.getBackend().get("provider-keys", provider)) as string | null;
	}
	async set(provider: string, key: string): Promise<void> {
		await this.getBackend().set("provider-keys", provider, key);
		try {
			localStorage.setItem(this.lsKey(provider), key);
		} catch {
			/* quota */
		}
	}
	async delete(provider: string): Promise<void> {
		await this.getBackend().delete("provider-keys", provider);
		try {
			localStorage.removeItem(this.lsKey(provider));
		} catch {
			/* noop */
		}
	}
	/** Union of localStorage fast tier + backend keys (de-duplicated). */
	async list(): Promise<string[]> {
		const backendKeys = await this.getBackend().keys("provider-keys");
		return [...new Set([...this.lsProviders(), ...backendKeys])];
	}
	async has(provider: string): Promise<boolean> {
		try {
			if (localStorage.getItem(this.lsKey(provider)) !== null) return true;
		} catch {
			/* localStorage unavailable */
		}
		return this.getBackend().has("provider-keys", provider);
	}
}

/** Chat sessions: full bodies in `sessions`, light metadata in `sessions-metadata`. */
export class SessionsStore extends Store {
	getConfig() {
		return { name: "sessions" };
	}
	/** Must be included when creating the backend. Index declared for schema parity —
	 *  LocalStorageBackend.getAllFromIndex is scan+sort-by-field, not a real IDB index. */
	static getMetadataConfig() {
		return { name: "sessions-metadata", indices: [{ name: "lastModified", keyPath: "lastModified" }] };
	}
	async save(data: AnyRecord, metadata: AnyRecord): Promise<void> {
		await this.getBackend().transaction(["sessions", "sessions-metadata"], "readwrite", async (tx: any) => {
			await tx.set("sessions", data.id, data);
			await tx.set("sessions-metadata", metadata.id, metadata);
		});
	}
	async get(id: string): Promise<AnyRecord | null> {
		return this.getBackend().get("sessions", id);
	}
	async getMetadata(id: string): Promise<AnyRecord | null> {
		return this.getBackend().get("sessions-metadata", id);
	}
	async getAllMetadata(): Promise<AnyRecord[]> {
		return this.getBackend().getAllFromIndex("sessions-metadata", "lastModified", "desc");
	}
	async delete(id: string): Promise<void> {
		await this.getBackend().transaction(["sessions", "sessions-metadata"], "readwrite", async (tx: any) => {
			await tx.delete("sessions", id);
			await tx.delete("sessions-metadata", id);
		});
	}
	async updateTitle(id: string, title: string): Promise<void> {
		const now = new Date().toISOString();
		const metadata = await this.getMetadata(id);
		if (metadata) {
			metadata.title = title;
			metadata.lastModified = now; // bump so the sidebar re-sorts (grok P0 review)
			await this.getBackend().set("sessions-metadata", id, metadata);
		}
		const data = await this.get(id);
		if (data) {
			data.title = title;
			data.lastModified = now;
			await this.getBackend().set("sessions", id, data);
		}
	}
}

/** Custom LLM providers (kept for storage-schema parity; pi-import is the source of truth). */
export class CustomProvidersStore extends Store {
	getConfig() {
		return { name: "custom-providers" };
	}
	async get(id: string): Promise<AnyRecord | null> {
		return this.getBackend().get("custom-providers", id);
	}
	async set(provider: AnyRecord): Promise<void> {
		await this.getBackend().set("custom-providers", provider.id, provider);
	}
	async delete(id: string): Promise<void> {
		await this.getBackend().delete("custom-providers", id);
	}
	async getAll(): Promise<AnyRecord[]> {
		const keys = await this.getBackend().keys("custom-providers");
		const providers: AnyRecord[] = [];
		for (const key of keys) {
			const provider = await this.get(key);
			if (provider) providers.push(provider);
		}
		return providers;
	}
	async has(id: string): Promise<boolean> {
		return this.getBackend().has("custom-providers", id);
	}
}

/** Transaction tx shape (LocalStorageBackend is untyped JS — this is the contract). */
export type StorageTx = {
	get: (store: string, key: string) => Promise<any>;
	set: (store: string, key: string, value: any) => Promise<void>;
	delete: (store: string, key: string) => Promise<void>;
};

/** High-level storage API. Mirrors pi-web-ui storage/app-storage.js. */
export class AppStorage {
	settings: SettingsStore;
	providerKeys: ProviderKeysStore;
	sessions: SessionsStore;
	customProviders: CustomProvidersStore;
	backend: LocalStorageBackend;

	constructor(
		settings: SettingsStore,
		providerKeys: ProviderKeysStore,
		sessions: SessionsStore,
		customProviders: CustomProvidersStore,
		backend: LocalStorageBackend,
	) {
		this.settings = settings;
		this.providerKeys = providerKeys;
		this.sessions = sessions;
		this.customProviders = customProviders;
		this.backend = backend;
		// enforce the backend invariant here — a store that missed setBackend would
		// otherwise throw only on first I/O (grok P0 review)
		for (const s of [settings, providerKeys, sessions, customProviders]) s.setBackend(backend);
	}

	async getQuotaInfo() {
		return this.backend.getQuotaInfo();
	}
	async requestPersistence() {
		return this.backend.requestPersistence();
	}
}

// Global instance management (mirrors pi-web-ui app-storage.js)
let globalAppStorage: AppStorage | null = null;

/** Get the global AppStorage instance. Throws if not initialized. */
export function getAppStorage(): AppStorage {
	if (!globalAppStorage) {
		throw new Error("AppStorage not initialized. Call setAppStorage() first.");
	}
	return globalAppStorage;
}

/** Set the global AppStorage instance. */
export function setAppStorage(storage: AppStorage): void {
	globalAppStorage = storage;
}
