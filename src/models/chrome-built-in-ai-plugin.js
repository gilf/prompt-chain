import { BaseModelPlugin } from "./base-model-plugin.js";
import { CallbackEvents } from "../consts.js";

/**
 * Model Plugin for Chrome Native Built-in AI (window.LanguageModel / Gemini Nano).
 * @extends BaseModelPlugin
 */
export class ChromeBuiltInAIPlugin extends BaseModelPlugin {
    constructor(options = {}) {
        super();
        this.options = options;
        this.session = null;
    }

    /**
     * Initializes Chrome LanguageModel session.
     * @param {string} [systemPrompt]
     * @returns {Promise<void>}
     */
    async init(systemPrompt) {
        const globalLM = typeof window !== 'undefined' ? window.LanguageModel : (typeof globalThis !== 'undefined' ? globalThis.LanguageModel : null);
        if (!globalLM) {
            throw new Error("Chrome Built-in AI (window.LanguageModel) is not supported in this environment.");
        }

        this.session = await globalLM.create({
            systemPrompt: systemPrompt,
            monitor(m) {
                if (m && typeof m.addEventListener === 'function' && typeof window !== 'undefined') {
                    m.addEventListener('downloadprogress', (e) => {
                        window.dispatchEvent(new CustomEvent(CallbackEvents.eventDispatch, {
                            detail: {
                                event: CallbackEvents.modelDownloadProgress,
                                loaded: e.loaded,
                                total: e.total
                            }
                        }));
                    });
                }
            }
        });

        if (this.session && typeof window !== 'undefined') {
            const overflowHandler = () => {
                window.dispatchEvent(new CustomEvent(CallbackEvents.eventDispatch, {
                    detail: { event: CallbackEvents.contextOverflow, data: { warning: "Context window overflow warning triggered." } }
                }));
            };
            if ('oncontextoverflow' in this.session) {
                this.session.oncontextoverflow = overflowHandler;
            } else if (typeof this.session.addEventListener === 'function') {
                this.session.addEventListener('contextoverflow', overflowHandler);
            }
        }
    }

    /**
     * Generates output using promptStreaming or prompt.
     */
    async generate(payload, onToken) {
        if (!this.session) {
            throw new Error("ChromeBuiltInAIPlugin session is not initialized. Call init() first.");
        }

        const options = {};
        if (payload?.schema) {
            options.responseConstraint = payload.schema;
            options.responseSchema = payload.schema;
        }

        const promptText = typeof payload === 'string' ? payload : (payload.prompt || '');

        if (typeof this.session.promptStreaming === 'function') {
            const stream = this.session.promptStreaming(promptText, options);
            let fullResponse = "";
            for await (const chunk of stream) {
                let delta = "";
                if (fullResponse && chunk.startsWith(fullResponse)) {
                    delta = chunk.slice(fullResponse.length);
                    fullResponse = chunk;
                } else {
                    delta = chunk;
                    fullResponse += chunk;
                }
                if (delta && typeof onToken === 'function') {
                    onToken(delta);
                }
            }
            return fullResponse;
        } else {
            return await this.session.prompt(promptText, options);
        }
    }

    async measureContextUsage(input) {
        if (typeof this.session?.measureContextUsage === 'function') {
            return await this.session.measureContextUsage(input);
        } else if (typeof this.session?.measureInputUsage === 'function') {
            return await this.session.measureInputUsage(input);
        } else {
            return await super.measureContextUsage(input);
        }
    }

    getContextStats() {
        const usage = this.session?.contextUsage ?? this.session?.inputUsage ?? 0;
        const windowQuota = this.session?.contextWindow ?? this.session?.inputQuota ?? 4096;
        return { usage, window: windowQuota };
    }

    async destroy() {
        if (this.session && typeof this.session.destroy === 'function') {
            try { this.session.destroy(); } catch (e) {}
        }
        this.session = null;
    }
}
