import { BaseMessage } from "./messages.js";

export class AgentMemory {
    constructor(dbName = "AgentMemoryDB", storeName = "conversations") {
        this.dbName = dbName;
        this.storeName = storeName;
        this.db = null;
    }

    init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, 2);

            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    db.createObjectStore(this.storeName, { keyPath: "sessionId" });
                }
                if (!db.objectStoreNames.contains("checkpoints")) {
                    db.createObjectStore("checkpoints", { keyPath: "checkpointId" });
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

    saveCheckpoint(checkpointId, checkpointData) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction("checkpoints", "readwrite");
            const store = tx.objectStore("checkpoints");
            const serializedTurns = (checkpointData.historyTurns || []).map(item => {
                return typeof item?.toJSON === "function" ? item.toJSON() : item;
            });
            let safeChainInput = checkpointData.chainInput;
            if (typeof safeChainInput === "object" && safeChainInput !== null) {
                safeChainInput = { isInitialObject: true };
            }
            const request = store.put({
                checkpointId,
                ...checkpointData,
                chainInput: safeChainInput,
                historyTurns: serializedTurns,
                timestamp: Date.now()
            });

            request.onsuccess = () => resolve();
            request.onerror = (e) => reject(e.target.error);
        });
    }

    getCheckpoint(checkpointId) {
        return new Promise((resolve) => {
            const tx = this.db.transaction("checkpoints", "readonly");
            const store = tx.objectStore("checkpoints");
            const request = store.get(checkpointId);

            request.onsuccess = () => {
                if (request.result) {
                    const data = request.result;
                    if (Array.isArray(data.historyTurns)) {
                        data.historyTurns = data.historyTurns.map(item => BaseMessage.fromJSON(item));
                    }
                    resolve(data);
                } else {
                    resolve(null);
                }
            };
            request.onerror = () => resolve(null);
        });
    }

    deleteCheckpoint(checkpointId) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction("checkpoints", "readwrite");
            const store = tx.objectStore("checkpoints");
            const request = store.delete(checkpointId);

            request.onsuccess = () => resolve();
            request.onerror = (e) => reject(e.target.error);
        });
    }
}
