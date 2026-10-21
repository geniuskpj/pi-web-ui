// LocalStorageBackend — drop-in replacement for IndexedDBStorageBackend.
//
// WHY: IndexedDB on some profiles hangs indefinitely (wedged LevelDB after
// hard-killed processes). localStorage is synchronous and reliable, and the
// server mirror (/ws/sync -> data/sessions) is the durable copy for big data.
//
// Layout: localStorage key = `${dbName}:${store}:${key}`, plus a per-store
// index entry `${dbName}:${store}:__keys`.
// Policy: items larger than MAX_ITEM go to memory only (the server mirror
// persists them); metadata/settings/keys are always small.
export class LocalStorageBackend {
	constructor(config = {}) {
		this.config = config;
		this.prefix = `${config.dbName || "app"}:`;
		this.mem = new Map(); // `${store}:${key}` -> value
		this.hydrated = new Set(); // stores hydrated from localStorage
		for (const storeConfig of config.stores || []) this._hydrate(storeConfig.name);
	}

	_storeKey(store, key) {
		return `${this.prefix}${store}:${key}`;
	}

	_indexKey(store) {
		return `${this.prefix}${store}:__keys`;
	}

	_keysList(store) {
		try {
			return JSON.parse(localStorage.getItem(this._indexKey(store)) || "[]");
		} catch {
			return [];
		}
	}

	_saveKeysList(store, keys) {
		try {
			localStorage.setItem(this._indexKey(store), JSON.stringify(keys));
		} catch {
			/* quota */
		}
	}

	_hydrate(store) {
		if (this.hydrated.has(store)) return;
		this.hydrated.add(store);
		for (const key of this._keysList(store)) {
			try {
				const raw = localStorage.getItem(this._storeKey(store, key));
				if (raw !== null) this.mem.set(`${store}:${key}`, JSON.parse(raw));
				else this.mem.set(`${store}:${key}`, null);
			} catch {
				this.mem.set(`${store}:${key}`, null);
			}
		}
	}

	_persist(store, key, value) {
		const keys = this._keysList(store);
		if (!keys.includes(key)) {
			keys.push(key);
			this._saveKeysList(store, keys);
		}
		try {
			localStorage.setItem(this._storeKey(store, key), JSON.stringify(value));
		} catch (err) {
			// quota: evict the largest other session item once, then retry
			if (store === "sessions") {
				this._evictLargestSession(key);
				try {
					localStorage.setItem(this._storeKey(store, key), JSON.stringify(value));
					return;
				} catch {
					/* still too big — memory only */
				}
			}
			console.warn("[storage] localStorage set failed (kept in memory):", err?.name);
		}
	}

	_evictLargestSession(key) {
		let largest = null;
		let largestSize = 0;
		for (const k of this._keysList("sessions")) {
			if (k === key) continue;
			const raw = localStorage.getItem(this._storeKey("sessions", k));
			if (raw && raw.length > largestSize) {
				largestSize = raw.length;
				largest = k;
			}
		}
		if (largest) {
			localStorage.removeItem(this._storeKey("sessions", largest));
			this.mem.delete(`sessions:${largest}`);
			const keys = this._keysList("sessions").filter((k) => k !== largest);
			this._saveKeysList("sessions", keys);
			console.info("[storage] evicted large local session to fit quota:", largest);
		}
	}

	async get(store, key) {
		this._hydrate(store);
		const v = this.mem.get(`${store}:${key}`);
		return v === undefined ? null : v;
	}

	async set(store, key, value) {
		this._hydrate(store);
		this.mem.set(`${store}:${key}`, value);
		this._persist(store, key, value);
	}

	async delete(store, key) {
		this._hydrate(store);
		this.mem.delete(`${store}:${key}`);
		localStorage.removeItem(this._storeKey(store, key));
		const keys = this._keysList(store).filter((k) => k !== key);
		this._saveKeysList(store, keys);
	}

	async keys(store, prefix) {
		this._hydrate(store);
		const all = [...this.mem.keys()]
			.filter((k) => k.startsWith(`${store}:`))
			.map((k) => k.slice(store.length + 1));
		const filtered = prefix ? all.filter((k) => k.startsWith(prefix)) : all;
		return filtered.map(String);
	}

	async has(store, key) {
		this._hydrate(store);
		return this.mem.has(`${store}:${key}`);
	}

	async getAllFromIndex(store, indexName, direction = "asc") {
		this._hydrate(store);
		const items = [];
		for (const key of this._keysList(store)) {
			const v = this.mem.get(`${store}:${key}`);
			if (v) items.push(v);
		}
		items.sort((a, b) => {
			const av = a?.[indexName] ?? "";
			const bv = b?.[indexName] ?? "";
			return direction === "desc" ? String(bv).localeCompare(String(av)) : String(av).localeCompare(String(bv));
		});
		return items;
	}

	async clear(store) {
		this._hydrate(store);
		for (const key of this._keysList(store)) {
			localStorage.removeItem(this._storeKey(store, key));
			this.mem.delete(`${store}:${key}`);
		}
		localStorage.removeItem(this._indexKey(store));
	}

	async transaction(storeNames, mode, operation) {
		const tx = {
			get: (store, key) => this.get(store, key),
			set: (store, key, value) => this.set(store, key, value),
			delete: (store, key) => this.delete(store, key),
		};
		return await operation(tx);
	}

	async getQuotaInfo() {
		let usage = 0;
		try {
			for (let i = 0; i < localStorage.length; i++) {
				const k = localStorage.key(i);
				if (k && k.startsWith(this.prefix)) usage += (localStorage.getItem(k) || "").length + k.length;
			}
		} catch {
			/* noop */
		}
		return { usage, quota: 5 * 1024 * 1024, percent: (usage / (5 * 1024 * 1024)) * 100 };
	}

	async requestPersistence() {
		return false;
	}

	// Compatibility shim — nothing in the app may use raw IDB transactions.
	async getDB() {
		throw new Error("getDB() is not available on LocalStorageBackend");
	}
}
