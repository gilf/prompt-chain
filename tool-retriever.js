export class ToolRetriever {
    constructor(toolsArray) {
        this.tools = toolsArray;
    }

    // A lightweight retrieval mechanism to find the top K relevant tools
    async getRelevantTools(userPrompt, topK = 3) {
        if (this.tools.length <= topK) return this.tools;

        const query = userPrompt.toLowerCase();

        // Score tools based on relevance to the prompt
        const scoredTools = this.tools.map(tool => {
            let score = 0;
            const targetText = (tool.name + " " + tool.description).toLowerCase();

            // Basic token overlap scoring (Simulating a BM25 or Embedding search)
            const queryTokens = query.split(/\W+/);
            for (const token of queryTokens) {
                if (token.length > 3 && targetText.includes(token)) {
                    score += 1;
                }
            }
            return { tool, score };
        });

        return scoredTools
            .sort((a, b) => b.score - a.score)
            .slice(0, topK)
            .map(st => st.tool);
    }
}