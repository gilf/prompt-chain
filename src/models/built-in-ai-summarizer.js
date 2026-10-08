/**
 * Built-in AI Summarizer Model Component for Chrome Native Summarizer API.
 * Provides on-device conversational history summarization and compaction.
 */
export class BuiltInAISummarizer {
    /**
     * @param {Object} [options={}] - Summarizer configuration options.
     * @param {'key-points'|'tl;dr'|'teaser'|'headline'} [options.type='key-points'] - Summarizer output structure.
     * @param {'markdown'|'plain-text'} [options.format='markdown'] - Output formatting style.
     * @param {'short'|'medium'|'long'} [options.length='medium'] - Summarization length quota.
     */
    constructor(options = {}) {
        this.options = options;
        this.summarizer = null;
    }

    /**
     * Checks availability of the Chrome Built-in Summarizer API without throwing.
     * @param {Object} [options={}] - Optional capabilities options.
     * @returns {Promise<'readily'|'after-download'|'unavailable'>}
     */
    static async checkAvailability(options = {}) {
        const globalSum = typeof window !== 'undefined'
            ? (window.Summarizer)
            : (typeof globalThis !== 'undefined' ? (globalThis.Summarizer) : null);

        if (!globalSum) {
            return 'unavailable';
        }
        try {
            if (typeof globalSum.availability === 'function') {
                return await globalSum.availability(options);
            } else if (typeof globalSum.capabilities === 'function') {
                const caps = await globalSum.capabilities();
                return caps?.available ?? 'unavailable';
            }
            return 'readily';
        } catch (e) {
            return 'unavailable';
        }
    }

    /**
     * Initializes the underlying Chrome Summarizer session.
     * @param {Object} [options={}] - Override configuration.
     * @returns {Promise<void>}
     */
    async init(options = {}) {
        const globalSum = typeof window !== 'undefined'
            ? (window.Summarizer)
            : (typeof globalThis !== 'undefined' ? (globalThis.Summarizer) : null);

        if (!globalSum) {
            throw new Error("Chrome Built-in Summarizer (window.ai.summarizer) is not supported in this environment.");
        }

        const config = {
            type: options.type || this.options.type || 'key-points',
            format: options.format || this.options.format || 'markdown',
            length: options.length || this.options.length || 'medium',
            ...options
        };

        this.summarizer = await globalSum.create(config);
    }

    /**
     * Generates a summary for the provided input text.
     * @param {string} text - Input text to summarize.
     * @param {Object} [context={}] - Optional context parameters.
     * @returns {Promise<string>}
     */
    async summarize(text, context = {}) {
        if (!this.summarizer) {
            await this.init();
        }
        return await this.summarizer.summarize(text, context);
    }

    /**
     * Destroys and cleans up the active summarizer session.
     */
    destroy() {
        if (this.summarizer && typeof this.summarizer.destroy === 'function') {
            try { this.summarizer.destroy(); } catch (e) {}
        }
        this.summarizer = null;
    }
}
