import { Runnable } from "./runnable.js";
import { IndexedDBVectorStore } from "../retrievers/index.js";
import { Tool } from "../core/index.js";

export class RunnableEpisodicMemory extends Runnable {
    constructor(options = {}) {
        super();
        this.dbName = options.dbName || "AgentMemoryDB";
        this.storeName = options.storeName || "episodes";
        this.topK = options.topK || 3;
        this.namespace = options.namespace || "user-facts";
        this.embeddings = options.embeddings || null;

        if (options.vectorStore) {
            this.vectorStore = options.vectorStore;
        } else {
            this.vectorStore = new IndexedDBVectorStore({
                dbName: this.dbName,
                storeName: this.storeName,
                embeddings: this.embeddings
            });
        }
    }

    async init() {
        if (this.vectorStore && typeof this.vectorStore.init === "function") {
            await this.vectorStore.init();
        }
        return this;
    }

    async remember(input, options = {}) {
        if (!this.vectorStore) await this.init();

        const factText = typeof input === "string" ? input.trim() : (input?.fact || "").trim();
        if (!factText) {
            throw new Error("RunnableEpisodicMemory.remember requires a non-empty string or an object with a 'fact' property.");
        }

        const id = options.id || (typeof input === "object" && input?.id ? input.id : `ep_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`);
        const category = typeof input === "object" && input?.category ? input.category : (options.category || "general");
        const namespace = typeof input === "object" && input?.namespace ? input.namespace : (options.namespace || this.namespace);
        const metadata = {
            category,
            namespace,
            timestamp: Date.now(),
            ...(typeof input === "object" && input?.metadata ? input.metadata : {}),
            ...(options.metadata || {})
        };

        const doc = {
            id,
            content: factText,
            metadata,
            vector: (typeof input === "object" && Array.isArray(input?.vector)) ? input.vector : (options.vector || null)
        };

        await this.vectorStore.addDocuments([doc]);

        return {
            id,
            fact: factText,
            category,
            namespace,
            timestamp: metadata.timestamp,
            status: "saved"
        };
    }

    async recall(query, options = {}) {
        if (!this.vectorStore) await this.init();

        const queryString = typeof query === "string" ? query.trim() : (query?.query || "").trim();
        if (!queryString) {
            return [];
        }

        const topK = typeof query === "object" && query?.topK ? query.topK : (options.topK || this.topK);
        const categoryFilter = typeof query === "object" && query?.category ? query.category : options.category;
        const namespaceFilter = typeof query === "object" && query?.namespace ? query.namespace : (options.namespace || this.namespace);

        const rawResults = await this.vectorStore.similaritySearchWithScore(queryString, topK * 3);

        const filtered = rawResults.filter(item => {
            if (!item?.document) return false;
            const meta = item.document.metadata || {};
            if (namespaceFilter && meta.namespace !== namespaceFilter) {
                return false;
            }
            return !(categoryFilter && meta.category !== categoryFilter);

        }).slice(0, topK);

        return filtered.map(item => ({
            id: item.document.id,
            fact: item.document.content,
            score: item.score,
            category: item.document.metadata?.category || "general",
            namespace: item.document.metadata?.namespace || this.namespace,
            timestamp: item.document.metadata?.timestamp || null,
            metadata: item.document.metadata || {}
        }));
    }

    async forget(ids) {
        if (!this.vectorStore) await this.init();
        const idList = Array.isArray(ids) ? ids : [ids];
        await this.vectorStore.delete(idList);
        return {
            forgotten: idList,
            status: "deleted"
        };
    }

    async getAllEpisodes(options = {}) {
        if (!this.vectorStore) await this.init();
        const allDocs = await this.vectorStore.getAllDocuments();
        const namespaceFilter = options.namespace || this.namespace;
        const categoryFilter = options.category || null;

        const filtered = allDocs.filter(doc => {
            const meta = doc.metadata || {};
            if (namespaceFilter && meta.namespace !== namespaceFilter) return false;
            return !(categoryFilter && meta.category !== categoryFilter);

        });

        return filtered
            .map(doc => ({
                id: doc.id,
                fact: doc.content,
                category: doc.metadata?.category || "general",
                namespace: doc.metadata?.namespace || this.namespace,
                timestamp: doc.metadata?.timestamp || null,
                metadata: doc.metadata || {}
            }))
            .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    }

    async clear() {
        if (!this.vectorStore) await this.init();
        await this.vectorStore.clear();
        return { status: "cleared" };
    }

    async invoke(input, config = {}) {
        if (typeof input === "object" && input !== null && typeof input.action === "string") {
            const action = input.action.toLowerCase();
            if (action === "remember") return await this.remember(input, config);
            if (action === "recall") return await this.recall(input.query || input.fact, config);
            if (action === "forget") return await this.forget(input.id || input.ids);
            if (action === "getall") return await this.getAllEpisodes(input);
            if (action === "clear") return await this.clear();
        }

        const queryString = typeof input === "string" ? input : (input?.query || JSON.stringify(input));
        const episodes = await this.recall(queryString, config);
        const summaryString = episodes.length > 0
            ? episodes.map(e => `- [${e.category}] ${e.fact} (relevance: ${e.score.toFixed(2)})`).join("\n")
            : "No relevant episodic memories found.";

        if (typeof input === "string" && config.returnString === true) {
            return summaryString;
        }

        return {
            query: queryString,
            episodicMemory: summaryString,
            episodes,
            ...(typeof input === "object" && input !== null ? input : {})
        };
    }

    getTools() {
        const rememberTool = new Tool(
            "remember",
            "Save a long-term user preference, profile detail, or important fact across sessions into episodic memory.",
            async ({ fact, category = "general" }) => {
                const res = await this.remember({ fact, category });
                return `Saved to episodic memory [ID: ${res.id}]: "${res.fact}" (Category: ${res.category})`;
            },
            {
                type: "object",
                properties: {
                    fact: { type: "string" },
                    category: { type: "string" }
                },
                required: ["fact"]
            }
        );

        const recallTool = new Tool(
            "recall",
            "Search long-term episodic memory for previously saved facts or preferences about the user matching a query.",
            async ({ query, category = null }) => {
                const results = await this.recall({ query, category });
                if (results.length === 0) {
                    return `No episodic memories found matching query "${query}".`;
                }
                return results.map((r, i) => `${i + 1}. [${r.category}] "${r.fact}" (Score: ${r.score.toFixed(2)}) [ID: ${r.id}]`).join("\n");
            },
            {
                type: "object",
                properties: {
                    query: { type: "string" },
                    category: { type: "string" }
                },
                required: ["query"]
            }
        );

        const forgetTool = new Tool(
            "forget",
            "Delete an outdated, obsolete, or incorrect fact from long-term episodic memory using its episode ID.",
            async ({ id }) => {
                if (!id) return "Error: 'id' parameter is required.";
                const res = await this.forget(id);
                return `Successfully deleted episode ${res.forgotten.join(", ")} from long-term memory.`;
            },
            {
                type: "object",
                properties: {
                    id: { type: "string" }
                },
                required: ["id"]
            }
        );

        return [rememberTool, recallTool, forgetTool];
    }
}
