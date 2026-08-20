import { BaseModelPlugin } from "./base-model-plugin.js";

/**
 * Model Plugin for Hugging Face Transformers.js in-browser / Web Worker ONNX inference.
 * Zero-dependency implementation supporting user-provided pipelines, custom loaders, or dynamic imports.
 * @extends BaseModelPlugin
 */
export class TransformersJSPlugin extends BaseModelPlugin {
    /**
     * @param {Object} [options]
     * @param {string} [options.modelId="Xenova/Qwen1.5-0.5B-Chat"] - Model identifier on Hugging Face Hub.
     * @param {string} [options.task="text-generation"] - Pipeline task ("text-generation", "text2text-generation").
     * @param {Function} [options.pipeline] - Pre-instantiated Hugging Face pipeline instance.
     * @param {Function} [options.pipelineLoader] - Custom loader function async (task, modelId, opts) => pipeline.
     * @param {Object} [options.generateOptions] - Default generation parameters (max_new_tokens, temperature, etc.).
     * @param {number} [options.contextWindow=4096] - Context window quota.
     */
    constructor(options = {}) {
        super();
        this.modelId = options.modelId || "Xenova/Qwen1.5-0.5B-Chat";
        this.task = options.task || "text-generation";
        this.pipelineInstance = options.pipeline || null;
        this.pipelineLoader = options.pipelineLoader || null;
        this.generateOptions = options.generateOptions || { max_new_tokens: 512, temperature: 0.7 };
        this.contextWindow = options.contextWindow || 4096;
        this.systemPrompt = "";
        this.lastUsage = 0;
    }

    /**
     * Initializes or retrieves the Transformers.js pipeline.
     */
    async init(systemPrompt) {
        if (systemPrompt) {
            this.systemPrompt = systemPrompt;
        }

        if (!this.pipelineInstance) {
            if (typeof this.pipelineLoader === 'function') {
                this.pipelineInstance = await this.pipelineLoader(this.task, this.modelId, {
                    quantized: true
                });
            } else {
                // Check global Transformers.js object if imported via script tag
                const globalScope = typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : globalThis);
                if (globalScope && globalScope.transformers && typeof globalScope.transformers.pipeline === 'function') {
                    this.pipelineInstance = await globalScope.transformers.pipeline(this.task, this.modelId);
                } else {
                    throw new Error("Transformers.js pipeline is not initialized and no pipelineLoader or global transformers object was found. Please pass options.pipeline or options.pipelineLoader.");
                }
            }
        }
    }

    /**
     * Executes inference using the loaded Transformers.js pipeline.
     */
    async generate(payload, onToken) {
        if (!this.pipelineInstance) {
            await this.init();
        }

        const promptText = typeof payload === 'string' ? payload : (payload.prompt || '');
        let formattedInput = promptText;
        if (this.systemPrompt && !promptText.includes(this.systemPrompt)) {
            formattedInput = `${this.systemPrompt}\n\n${promptText}`;
        }

        const genOpts = {
            ...this.generateOptions,
            ...(payload?.maxTokens ? { max_new_tokens: payload.maxTokens } : {}),
            ...(payload?.temperature ? { temperature: payload.temperature } : {})
        };

        if (typeof onToken === 'function') {
            const globalScope = typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : globalThis);
            const TextStreamer = globalScope?.transformers?.TextStreamer || this.pipelineInstance?.tokenizer?.TextStreamer;

            if (TextStreamer) {
                genOpts.streamer = new TextStreamer(this.pipelineInstance.tokenizer, {
                    skip_prompt: true,
                    skip_special_tokens: true,
                    callback_function: (token) => onToken(token)
                });
            }
        }

        const result = await this.pipelineInstance(formattedInput, genOpts);

        let outputText;
        if (Array.isArray(result) && result[0]) {
            outputText = result[0].generated_text || result[0].translation_text || JSON.stringify(result[0]);
        } else if (typeof result === 'string') {
            outputText = result;
        } else if (result?.generated_text) {
            outputText = result.generated_text;
        } else {
            outputText = JSON.stringify(result);
        }

        if (outputText.startsWith(formattedInput)) {
            outputText = outputText.slice(formattedInput.length).trim();
        }

        if (typeof onToken === 'function' && !genOpts.streamer) {
            onToken(outputText);
        }

        this.lastUsage = await this.measureContextUsage(formattedInput + outputText);
        return outputText;
    }

    async measureContextUsage(input) {
        if (this.pipelineInstance?.tokenizer?.encode) {
            try {
                const str = typeof input === 'string' ? input : JSON.stringify(input || '');
                const tokens = this.pipelineInstance.tokenizer.encode(str);
                return tokens.length;
            } catch (e) {}
        }
        return await super.measureContextUsage(input);
    }

    getContextStats() {
        return { usage: this.lastUsage, window: this.contextWindow };
    }

    async destroy() {
        if (this.pipelineInstance && typeof this.pipelineInstance.dispose === 'function') {
            try { await this.pipelineInstance.dispose(); } catch(e) {}
        }
        this.pipelineInstance = null;
    }
}
