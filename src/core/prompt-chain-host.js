import { MessageContext, CallbackEvents } from "../consts.js";
import { ChromeBuiltInAIPlugin } from "../models/index.js";

export class LLMSessionManager {
    /**
     * @param {BaseModelPlugin} [modelPlugin] - Model plugin instance (defaults to ChromeBuiltInAIPlugin).
     */
    constructor(modelPlugin = null) {
        this.modelPlugin = modelPlugin || new ChromeBuiltInAIPlugin();
    }

    get session() {
        return this.modelPlugin.session || this.modelPlugin;
    }

    async init(systemPrompt) {
        await this.modelPlugin.init(systemPrompt);
    }

    async handlePromptRequest(payload, onToken) {
        return await this.modelPlugin.generate(payload, onToken);
    }

    async measureContextUsage(input) {
        return await this.modelPlugin.measureContextUsage(input);
    }

    getContextStats() {
        return this.modelPlugin.getContextStats();
    }

    async destroy() {
        if (this.modelPlugin && typeof this.modelPlugin.destroy === 'function') {
            await this.modelPlugin.destroy();
        }
    }
}

export class PromptChainHost {
    /**
     * @param {string|Worker} workerUrlOrWorker - Worker script URL or instantiated Worker object.
     * @param {Object} [options={}] - Host options.
     * @param {BaseModelPlugin} [options.model] - Model plugin instance (OllamaPlugin, TransformersJSPlugin, ChromeBuiltInAIPlugin, CustomModelPlugin).
     * @param {LLMSessionManager} [options.llmManager] - Custom LLMSessionManager instance.
     */
    constructor(workerUrlOrWorker, options = {}) {
        if (typeof workerUrlOrWorker === 'string') {
            this.worker = new Worker(workerUrlOrWorker, { type: 'module' });
        } else {
            this.worker = workerUrlOrWorker;
        }

        const plugin = options.model || options.modelPlugin;
        this.llmManager = options.llmManager || new LLMSessionManager(plugin);
        this.callbacks = new Map();
        this.msgId = 0;

        this.messageHandlers = {
            [MessageContext.llmRequest]: async (id, payload) => {
                try {
                    const response = await this.llmManager.handlePromptRequest(payload, (delta) => {
                        this.worker.postMessage({ id, type: MessageContext.llmStreamToken, payload: delta });
                    });
                    this.worker.postMessage({ id, type: MessageContext.llmResponse, payload: response });
                } catch (err) {
                    this.worker.postMessage({ id, type: MessageContext.llmError, payload: err.message });
                }
            },
            [MessageContext.llmMeasureContext]: async (id, payload) => {
                try {
                    const count = await this.llmManager.measureContextUsage(payload.input);
                    this.worker.postMessage({ id, type: MessageContext.llmMeasureResponse, payload: { count } });
                } catch (err) {
                    this.worker.postMessage({ id, type: MessageContext.llmError, payload: err.message });
                }
            },
            [MessageContext.llmContextStats]: async (id) => {
                try {
                    const stats = this.llmManager.getContextStats();
                    this.worker.postMessage({ id, type: MessageContext.llmStatsResponse, payload: stats });
                } catch (err) {
                    this.worker.postMessage({ id, type: MessageContext.llmError, payload: err.message });
                }
            },
            [MessageContext.agentLog]: (id, payload) => {
                if (typeof window !== 'undefined') {
                    window.dispatchEvent(new CustomEvent(MessageContext.agentLog, { detail: payload }));
                }
            },
            [MessageContext.agentCallbackEvent]: (id, payload) => {
                if (typeof window !== 'undefined') {
                    window.dispatchEvent(new CustomEvent(CallbackEvents.eventDispatch, { detail: payload }));
                }
            },
            [MessageContext.agentTraceComplete]: (id, payload) => {
                if (typeof window !== 'undefined') {
                    window.dispatchEvent(new CustomEvent(CallbackEvents.traceComplete || "on_trace_complete", { detail: payload }));
                }
            },
            [MessageContext.agentComplete]: (id, payload) => {
                const cb = this.callbacks.get(id);
                if (cb) {
                    cb.resolve(payload);
                }
                this.callbacks.delete(id);
            },
            [MessageContext.agentInterrupt]: (id, payload) => {
                const cb = this.callbacks.get(id);
                if (cb) {
                    cb.resolve(payload);
                }
                this.callbacks.delete(id);
            },
            [MessageContext.agentError]: (id, payload) => {
                const cb = this.callbacks.get(id);
                if (cb) {
                    cb.reject(new Error(payload));
                }
                this.callbacks.delete(id);
            }
        };

        if (this.worker && typeof this.worker.onmessage !== 'undefined') {
            this.worker.onmessage = this.handleWorkerMessage.bind(this);
        }
    }

    get session() {
        return this.llmManager.session;
    }

    async init(systemPrompt) {
        await this.llmManager.init(systemPrompt);
    }

    async handleWorkerMessage(e) {
        const { id, type, payload } = e.data;
        const handler = this.messageHandlers[type];
        if (handler) {
            await handler(id, payload);
        }
    }

    static async checkAvailability(options = {}) {
        return await ChromeBuiltInAIPlugin.checkAvailability(options);
    }

    runAgent(userPrompt, sessionId = "default_session", options = {}) {
        return new Promise((resolve, reject) => {
            if (options.signal?.aborted) {
                reject(options.signal.reason || new Error("Agent execution aborted."));
                return;
            }
            const id = ++this.msgId;
            this.callbacks.set(id, { resolve, reject });

            if (options.signal) {
                options.signal.addEventListener('abort', () => {
                    if (this.worker) {
                        this.worker.postMessage({
                            id,
                            type: MessageContext.abortLoop,
                            payload: { sessionId }
                        });
                    }
                    const cb = this.callbacks.get(id);
                    if (cb) {
                        cb.reject(options.signal.reason || new Error("Agent execution aborted."));
                        this.callbacks.delete(id);
                    }
                }, { once: true });
            }

            this.worker.postMessage({
                id,
                type: MessageContext.startLoop,
                payload: { userPrompt, sessionId }
            });
        });
    }

    abortAgent(sessionId = "default_session") {
        if (this.worker) {
            this.worker.postMessage({
                id: 0,
                type: MessageContext.abortLoop,
                payload: { sessionId }
            });
        }
    }

    resume(checkpointId, approvedParams) {
        return new Promise((resolve, reject) => {
            const id = ++this.msgId;
            this.callbacks.set(id, { resolve, reject });

            this.worker.postMessage({
                id,
                type: MessageContext.resumeLoop,
                payload: { checkpointId, approvedParams }
            });
        });
    }

    terminate() {
        if (this.worker && typeof this.worker.terminate === 'function') {
            this.worker.terminate();
            this.worker = null;
        }
        if (this.llmManager) {
            this.llmManager.destroy();
        }
    }
}


