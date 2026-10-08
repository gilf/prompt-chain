import { BaseModelPlugin } from "./base-model-plugin.js";
import { CallbackEvents } from "../consts.js";
import { BuiltInAISummarizer } from "./built-in-ai-summarizer.js";

/**
 * Model Plugin for Chrome Native Built-in AI (window.LanguageModel / Gemini Nano).
 * Features user activation management, automated download progress tracking,
 * session compaction via Summarizer API, and native structured tool calling.
 *
 * @extends BaseModelPlugin
 */
export class ChromeBuiltInAIPlugin extends BaseModelPlugin {
    constructor(options = {}) {
        super();
        this.options = options;
        this.session = null;
        this.systemPrompt = null;
    }

    /**
     * Checks availability of the Chrome Built-in AI without throwing.
     * @param {Object} [options={}] - Options for LanguageModel.availability
     * @returns {Promise<'readily'|'after-download'|'unavailable'>}
     */
    static async checkAvailability(options = {}) {
        const globalLM = typeof window !== 'undefined'
            ? window.LanguageModel
            : (typeof globalThis !== 'undefined' ? globalThis.LanguageModel : null);

        if (!globalLM) {
            return 'unavailable';
        }

        try {
            if (typeof globalLM.availability === 'function') {
                return await globalLM.availability(options);
            } else if (typeof globalLM.capabilities === 'function') {
                const caps = await globalLM.capabilities();
                return caps?.available ?? 'unavailable';
            }
            return 'readily';
        } catch (e) {
            return 'unavailable';
        }
    }

    /**
     * Fulfills Chrome user activation gesture requirements when model download is pending.
     * Reveals the activationButton and optional activationHint, awaits click, and cleans up.
     * @param {Object} options
     * @param {HTMLElement} [options.activationButton]
     * @param {HTMLElement} [options.activationHint]
     * @returns {Promise<void>}
     */
    static async ensureUserActivation({ activationButton, activationHint } = {}) {
        if (!activationButton) return;

        const originalDisplay = activationButton.style?.display;
        const originalHidden = activationButton.hidden;
        const originalHintDisplay = activationHint?.style?.display;
        const originalHintHidden = activationHint?.hidden;

        activationButton.hidden = false;
        if (activationButton.style) activationButton.style.display = '';
        if (activationHint) {
            activationHint.hidden = false;
            if (activationHint.style) activationHint.style.display = '';
        }

        try {
            await new Promise((resolve) => {
                activationButton.addEventListener('click', resolve, { once: true });
            });
        } finally {
            activationButton.hidden = originalHidden ?? true;
            if (activationButton.style && originalDisplay !== undefined) {
                activationButton.style.display = originalDisplay;
            }
            if (activationHint) {
                activationHint.hidden = originalHintHidden ?? true;
                if (activationHint.style && originalHintDisplay !== undefined) {
                    activationHint.style.display = originalHintDisplay;
                }
            }
        }
    }

    /**
     * Initializes Chrome LanguageModel session with download monitoring and activation safety.
     * @param {string} [systemPrompt]
     * @param {Object} [initOptions={}]
     * @returns {Promise<void>}
     */
    async init(systemPrompt, initOptions = {}) {
        const globalLM = typeof window !== 'undefined'
            ? window.LanguageModel
            : (typeof globalThis !== 'undefined' ? globalThis.LanguageModel : null);

        if (!globalLM) {
            throw new Error("Chrome Built-in AI (window.LanguageModel) is not supported in this environment.");
        }

        this.systemPrompt = systemPrompt || this.systemPrompt;
        const mergedOptions = { ...this.options, ...initOptions };

        // Handle user activation gesture if download is required
        const availability = await ChromeBuiltInAIPlugin.checkAvailability(mergedOptions);
        if (availability === 'after-download' && mergedOptions.activationButton) {
            await ChromeBuiltInAIPlugin.ensureUserActivation({
                activationButton: mergedOptions.activationButton,
                activationHint: mergedOptions.activationHint
            });
        }

        const downloadProgressEl = mergedOptions.downloadProgress;
        const onDownloadProgressCb = mergedOptions.onDownloadProgress;

        const createConfig = {
            systemPrompt: this.systemPrompt,
            monitor(m) {
                if (m && typeof m.addEventListener === 'function') {
                    m.addEventListener('downloadprogress', (e) => {
                        const loaded = e.loaded ?? 0;
                        const total = e.total ?? 0;
                        const percent = total > 0 ? Math.round((loaded / total) * 100) : 0;
                        const progressPayload = {
                            resource: 'language-model',
                            loaded,
                            total,
                            percent
                        };

                        if (downloadProgressEl) {
                            downloadProgressEl.hidden = false;
                            if (total > 0) {
                                downloadProgressEl.max = total;
                                downloadProgressEl.value = loaded;
                            } else {
                                downloadProgressEl.removeAttribute('value');
                            }
                            if (loaded >= total && total > 0) {
                                downloadProgressEl.removeAttribute('value'); // unpacking indeterminate
                            }
                        }

                        if (typeof onDownloadProgressCb === 'function') {
                            onDownloadProgressCb(progressPayload);
                        }

                        if (typeof window !== 'undefined') {
                            window.dispatchEvent(new CustomEvent(CallbackEvents.eventDispatch, {
                                detail: {
                                    event: CallbackEvents.modelDownloadProgress,
                                    ...progressPayload
                                }
                            }));
                        }
                    });
                }
            }
        };

        // Support native Prompt API tool calling declarations
        const rawTools = mergedOptions.tools || [];
        if (rawTools.length > 0) {
            createConfig.tools = rawTools.map(t => ({
                name: t.name,
                description: t.description,
                parameters: t.schema || t.parameters || { type: "object", properties: {} }
            }));
            createConfig.expectedInputs ??= [{ type: 'text' }];
            createConfig.expectedOutputs = [
                { type: 'text' },
                { type: 'tool-call' },
                { type: 'tool-response' }
            ];
        }

        if (mergedOptions.initialPrompts) {
            createConfig.initialPrompts = mergedOptions.initialPrompts;
        }

        this.session = await globalLM.create(createConfig);

        if (downloadProgressEl) {
            downloadProgressEl.hidden = true;
        }

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
     * Supports native Prompt API tool calling parts.
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
            let collectedParts = null;

            for await (const chunk of stream) {
                // If chunk is structured part array
                if (Array.isArray(chunk)) {
                    collectedParts = chunk;
                    continue;
                }
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

            if (collectedParts) {
                return this._formatTurnOutput(collectedParts);
            }
            return fullResponse;
        } else {
            const result = await this.session.prompt(promptText, options);
            return this._formatTurnOutput(result);
        }
    }

    /**
     * Normalizes turn result containing possible native tool-calls.
     * @private
     */
    _formatTurnOutput(result) {
        if (typeof result === 'string') {
            return result;
        }
        if (Array.isArray(result)) {
            const textParts = result.filter(p => p.type === 'text').map(p => p.value).join('');
            const toolCallParts = result.filter(p => p.type === 'tool-call').map(p => p.value);
            if (toolCallParts.length > 0) {
                return {
                    text: textParts,
                    toolCalls: toolCallParts.map(c => ({
                        callId: c.callId || c.callID || c.id || "call_default",
                        name: c.name,
                        arguments: c.arguments || c.args || {}
                    }))
                };
            }
            return textParts;
        }
        return result;
    }

    /**
     * Compacts conversation history using the native Chrome Summarizer API.
     * Re-creates the session with the summary anchored in initialPrompts to protect
     * against runtime context eviction.
     * @param {Array} historyTurns - Conversation messages to summarize.
     * @param {Object} [options={}] - Compaction configuration.
     * @returns {Promise<{summary: string, session: Object}>}
     */
    async compact(historyTurns, options = {}) {
        let summary = "";
        const summarizerAvailability = await BuiltInAISummarizer.checkAvailability();
        
        const historyText = historyTurns.map(item => {
            if (typeof item === 'string') return item;
            const role = item?.role || (typeof item?.getType === 'function' ? item.getType() : 'Turn');
            return `${role}: ${item?.content || ''}`;
        }).join('\n');

        if (summarizerAvailability !== 'unavailable') {
            const summarizer = new BuiltInAISummarizer(options.summarizerOptions || {});
            try {
                await summarizer.init();
                summary = await summarizer.summarize(historyText);
            } catch (e) {
                summary = options.fallbackSummary || historyText.slice(-1000);
            } finally {
                summarizer.destroy();
            }
        } else if (typeof options.summarizerFn === 'function') {
            summary = await options.summarizerFn(historyText);
        } else {
            summary = options.fallbackSummary || historyText.slice(-1000);
        }

        // Recreate the session with permanent initialPrompts
        if (this.session && typeof this.session.destroy === 'function') {
            try { this.session.destroy(); } catch (e) {}
        }

        const initialPrompts = [
            { role: 'system', content: this.systemPrompt || "You are a helpful assistant." },
            { role: 'user', content: `Previous Conversation Summary:\n${summary}` },
            { role: 'assistant', content: "Understood. I will continue the conversation keeping this summary in context." }
        ];

        await this.init(this.systemPrompt, {
            ...this.options,
            ...options,
            initialPrompts
        });

        return { summary, session: this.session };
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
