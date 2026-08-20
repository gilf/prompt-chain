/**
 * Abstract Base Model Plugin for @gilfink/prompt-chain.
 * Defines the standard contract required for LLM inference providers.
 */
export class BaseModelPlugin {
    /**
     * Initializes the underlying LLM model session or pipeline.
     * @param {string} [systemPrompt] - Initial system instruction for the session.
     * @param {Object} [options] - Additional initialization options.
     * @returns {Promise<void>}
     */
    async init(systemPrompt, options = {}) {
        // Subclasses should implement model initialization if required
    }

    /**
     * Generates a text response from the model based on prompt payload.
     * @param {Object} payload - Inference request configuration.
     * @param {string|Object} payload.prompt - User or system prompt input.
     * @param {Object} [payload.schema] - Optional JSON Schema constraining output.
     * @param {number} [payload.temperature] - Generation temperature.
     * @param {number} [payload.maxTokens] - Max tokens to generate.
     * @param {Function} [onToken] - Streaming token callback (token) => void.
     * @returns {Promise<string>} Full generated response string.
     */
    async generate(payload, onToken) {
        throw new Error("BaseModelPlugin.generate() must be implemented by subclass.");
    }

    /**
     * Measures context window token usage for input content.
     * @param {string|Object} input - Text or state object to measure.
     * @returns {Promise<number>} Number of tokens estimated or measured.
     */
    async measureContextUsage(input) {
        const str = typeof input === 'string' ? input : JSON.stringify(input || '');
        return Math.ceil(str.length / 4);
    }

    /**
     * Retrieves current context window usage and total quota.
     * @returns {{ usage: number, window: number }}
     */
    getContextStats() {
        return { usage: 0, window: 4096 };
    }

    /**
     * Cleans up resources, model weights, or API sessions.
     * @returns {Promise<void>}
     */
    async destroy() {
        // Subclasses should implement resource cleanup if needed
    }
}
