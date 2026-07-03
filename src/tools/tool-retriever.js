import { SemanticRetriever } from '../retrievers/index.js';

export class ToolRetriever extends SemanticRetriever {
    constructor(toolsArray = [], options = {}) {
        super(toolsArray, options);
    }

    get tools() {
        return this.items;
    }

    set tools(val) {
        this.items = val;
    }

    getItemText(tool) {
        return `${tool.name}: ${tool.description || ""}`;
    }

    async getRelevantTools(userPrompt, topK = 3) {
        return await this.retrieve(userPrompt, topK, false);
    }
}
