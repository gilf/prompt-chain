export class AgentMemory {
    constructor(dbName = "AgentMemoryDB", storeName = "conversations") {
        this.dbName = dbName;
        this.storeName = storeName;
        this.db = null;
    }

    init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, 1);

            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    // Keyed by sessionId (e.g., "session_123")
                    db.createObjectStore(this.storeName, { keyPath: "sessionId" });
                }
            };

            request.onsuccess = (e) => {
                this.db = e.target.result;
                resolve();
            };

            request.onerror = (e) => reject(e.target.error);
        });
    }

    getHistory(sessionId) {
        return new Promise((resolve) => {
            const tx = this.db.transaction(this.storeName, "readonly");
            const store = tx.objectStore(this.storeName);
            const request = store.get(sessionId);

            request.onsuccess = () => {
                resolve(request.result ? request.result.history : []);
            };
            request.onerror = () => resolve([]);
        });
    }

    saveHistory(sessionId, history) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(this.storeName, "readwrite");
            const store = tx.objectStore(this.storeName);
            const request = store.put({ sessionId, history });

            request.onsuccess = () => resolve();
            request.onerror = (e) => reject(e.target.error);
        });
    }
}