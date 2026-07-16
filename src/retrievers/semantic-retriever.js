export class SemanticRetriever {
    constructor(items = [], options = {}) {
        this.items = items;
        this.vectorStore = options.vectorStore || null;
    }

    getItemText(item) {
        return `${item.name}: ${item.description || ""} ${item.instructions || ""}`.trim();
    }

    async initVectorStore(vectorStore) {
        this.vectorStore = vectorStore || this.vectorStore;
        if (!this.vectorStore) return;
        const docs = this.items.map(item => ({
            id: item.name,
            content: this.getItemText(item),
            metadata: { name: item.name }
        }));
        await this.vectorStore.addDocuments(docs);
    }

    async retrieve(userPrompt, topK = 3, filterZeroScore = false) {
        if (this.items.length <= topK) return this.items;

        if (this.vectorStore) {
            try {
                const results = await this.vectorStore.similaritySearchWithScore(userPrompt, topK);
                const matched = [];
                for (const res of results) {
                    const name = res.document.metadata?.name || res.document.id;
                    const found = this.items.find(i => i.name.toLowerCase() === name.toLowerCase() || i.name === name);
                    if (found && !matched.includes(found)) {
                        matched.push(found);
                    }
                }
                if (matched.length > 0) return matched;
            } catch (e) {
                console.warn("Vector store similarity search failed, falling back to token-overlap scoring:", e);
            }
        }

        const query = userPrompt.toLowerCase();
        const queryTokens = query.split(/\W+/).filter(token => token.length > 3);

        const scored = this.items.map(item => {
            let score = 0;
            const targetText = this.getItemText(item).toLowerCase();
            for (const token of queryTokens) {
                if (targetText.includes(token)) {
                    score += 1;
                }
            }
            return { item, score };
        });

        const filtered = filterZeroScore ? scored.filter(s => s.score > 0) : scored;
        return filtered
            .sort((a, b) => b.score - a.score)
            .slice(0, topK)
            .map(s => s.item);
    }
}
