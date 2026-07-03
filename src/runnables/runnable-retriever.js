import { Runnable } from './runnable.js';

export class RunnableRetriever extends Runnable {
    constructor(retriever, options = {}) {
        super();
        this.retriever = retriever;
        this.topK = options.topK || 3;
    }

    async invoke(input, config = {}) {
        const query = typeof input === 'string' ? input : (input?.query || JSON.stringify(input));
        const topK = typeof input === 'object' && input?.topK ? input.topK : this.topK;

        if (typeof this.retriever === 'function') {
            return await Promise.resolve(this.retriever(query, topK, config));
        }

        const method = ['similaritySearch', 'getRelevantDocuments', 'getRelevantTools', 'getRelevantSkills']
            .find(m => this.retriever && typeof this.retriever[m] === 'function');

        if (method) {
            return await this.retriever[method](query, topK);
        }

        throw new Error("RunnableRetriever wrapped an invalid retriever object.");
    }
}
