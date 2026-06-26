import { BaseMessage } from "./messages.js";

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
                if (request.result) {
                    const rawHistory = request.result.history || [];
                    const typedHistory = rawHistory.map(item => BaseMessage.fromJSON(item));
                    resolve({
                        history: typedHistory,
                        summary: request.result.summary || ""
                    });
                } else {
                    resolve({ history: [], summary: "" });
                }
            };
            request.onerror = () => resolve({ history: [], summary: "" });
        });
    }

    saveHistory(sessionId, history, summary = "") {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(this.storeName, "readwrite");
            const store = tx.objectStore(this.storeName);
            const serializedHistory = history.map(item => {
                return typeof item?.toJSON === "function" ? item.toJSON() : item;
            });
            const request = store.put({ sessionId, history: serializedHistory, summary });

            request.onsuccess = () => resolve();
            request.onerror = (e) => reject(e.target.error);
        });
    }
}