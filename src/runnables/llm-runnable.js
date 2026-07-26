import { Runnable } from "./runnable.js";

/**
 * Adapter runnable wrapper around custom askLLM functions.
 *
 * @extends Runnable
 */
export class LLMRunnable extends Runnable {
    /**
     * @param {Function} askLLMFn - Async function executing LLM prompt requests.
     * @param {Object} [schema] - Optional JSON Schema constraining output generation.
     */
    constructor(askLLMFn, schema) {
        super();
        this.askLLMFn = askLLMFn;
        this.schema = schema;
    }

    /**
     * Invokes the underlying LLM function.
     * @param {string|Object} prompt - Prompt content or state object.
     * @param {Object} [config={}] - Execution config.
     * @returns {Promise<any>} Response from the LLM.
     */
    async invoke(prompt, config = {}) {
        return await this.askLLMFn(prompt, this.schema);
    }
}
