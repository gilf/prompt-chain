import { openIndexedDB } from "../utils.js";

export function cosineSimilarity(vecA, vecB) {
    if (!vecA || !vecB || vecA.length !== vecB.length || vecA.length === 0) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dot += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export class EmbeddingsPlugin {
    async embedQuery(text) {
        throw new Error("embedQuery must be implemented by the developer or embeddings plugin.");
    }

    async embedDocuments(texts) {
        return Promise.all(texts.map(t => this.embedQuery(t)));
    }
}

export class IndexedDBVectorStore {
    constructor(options = {}) {
        this.dbName = options.dbName || "PromptChainVectorDB";
        this.storeName = options.storeName || "vectors";
        this.embeddings = options.embeddings || null;
        this.db = null;
        this.inMemoryFallback = new Map();
    }

    async init() {
        if (!this.db) {
            this.db = await openIndexedDB(this.dbName, [{ name: this.storeName, keyPath: "id" }]);
        }
        return this.db;
    }


    async addDocuments(documents) {
        if (!this.db && typeof indexedDB !== 'undefined') {
            await this.init();
        }

        const toStore = [];
        for (const doc of documents) {
            let vector = doc.vector;
            if (!vector && this.embeddings && typeof this.embeddings.embedQuery === 'function') {
                vector = await this.embeddings.embedQuery(doc.content || "");
            }
            const item = {
                id: doc.id || `doc_${Math.random().toString(36).substring(2, 11)}`,
                content: doc.content || "",
                metadata: doc.metadata || {},
                vector: vector || []
            };
            toStore.push(item);
        }

        if (this.db) {
            return new Promise((resolve, reject) => {
                const tx = this.db.transaction(this.storeName, "readwrite");
                const store = tx.objectStore(this.storeName);
                for (const item of toStore) {
                    store.put(item);
                }
                tx.oncomplete = () => resolve(toStore.map(i => i.id));
                tx.onerror = () => reject(tx.error);
            });
        } else {
            for (const item of toStore) {
                this.inMemoryFallback.set(item.id, item);
            }
            return toStore.map(i => i.id);
        }
    }

    async getAllDocuments() {
        if (!this.db && typeof indexedDB !== 'undefined') {
            await this.init();
        }
        if (this.db) {
            return new Promise((resolve, reject) => {
                const tx = this.db.transaction(this.storeName, "readonly");
                const store = tx.objectStore(this.storeName);
                const request = store.getAll();
                request.onsuccess = () => resolve(request.result || []);
                request.onerror = () => reject(request.error);
            });
        } else {
            return Array.from(this.inMemoryFallback.values());
        }
    }

    async similaritySearchWithScore(query, topK = 3) {
        let queryVector;
        if (Array.isArray(query)) {
            queryVector = query;
        } else if (typeof query === 'string' && this.embeddings && typeof this.embeddings.embedQuery === 'function') {
            queryVector = await this.embeddings.embedQuery(query);
        } else {
            throw new Error("similaritySearchWithScore requires either a query vector array or an embeddings plugin configured.");
        }

        const allDocs = await this.getAllDocuments();
        const scored = allDocs
            .filter(doc => Array.isArray(doc.vector) && doc.vector.length > 0)
            .map(doc => ({
                document: { id: doc.id, content: doc.content, metadata: doc.metadata },
                score: cosineSimilarity(queryVector, doc.vector)
            }));

        return scored
            .sort((a, b) => b.score - a.score)
            .slice(0, topK);
    }

    async similaritySearch(query, topK = 3) {
        const results = await this.similaritySearchWithScore(query, topK);
        return results.map(r => r.document);
    }

    async delete(ids) {
        if (!Array.isArray(ids)) ids = [ids];
        if (this.db) {
            return new Promise((resolve, reject) => {
                const tx = this.db.transaction(this.storeName, "readwrite");
                const store = tx.objectStore(this.storeName);
                for (const id of ids) {
                    store.delete(id);
                }
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
        } else {
            for (const id of ids) {
                this.inMemoryFallback.delete(id);
            }
        }
    }

    async clear() {
        if (this.db) {
            return new Promise((resolve, reject) => {
                const tx = this.db.transaction(this.storeName, "readwrite");
                const store = tx.objectStore(this.storeName);
                store.clear();
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
        } else {
            this.inMemoryFallback.clear();
        }
    }
}
