import { MessageContext, CallbackEvents } from "./consts.js";

export class LLMSessionManager {
    constructor() {
        this.session = null;
    }

    async init(systemPrompt) {
        this.session = await LanguageModel.create({
            systemPrompt: systemPrompt,
            monitor(m) {
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
        });
        if (this.session) {
            const overflowHandler = () => {
                window.dispatchEvent(new CustomEvent(CallbackEvents.eventDispatch, { detail: { event: CallbackEvents.contextOverflow, data: { warning: "Context window overflow warning triggered." } } }));
            };
            if ('oncontextoverflow' in this.session) {
                this.session.oncontextoverflow = overflowHandler;
            } else if ('onquotaoverflow' in this.session) {
                this.session.onquotaoverflow = overflowHandler;
            } else if (typeof this.session.addEventListener === 'function') {
                this.session.addEventListener('contextoverflow', overflowHandler);
            }
        }
    }

    async handlePromptRequest(payload, onToken) {
        const options = {};
        if (payload.schema) {
            options.responseConstraint = payload.schema;
        }
        if (typeof this.session.promptStreaming === 'function') {
            const stream = this.session.promptStreaming(payload.prompt, options);
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
                if (delta) {
                    onToken(delta);
                }
            }
            return fullResponse;
        } else {
            return await this.session.prompt(payload.prompt, options);
        }
    }

    async measureContextUsage(input) {
        if (typeof this.session?.measureContextUsage === 'function') {
            return await this.session.measureContextUsage(input);
        } else if (typeof this.session?.measureInputUsage === 'function') {
            return await this.session.measureInputUsage(input);
        } else {
            const str = typeof input === 'string' ? input : JSON.stringify(input || '');
            return Math.ceil(str.length / 4);
        }
    }

    getContextStats() {
        const usage = this.session?.contextUsage ?? this.session?.inputUsage ?? 0;
        const windowQuota = this.session?.contextWindow ?? this.session?.inputQuota ?? 4096;
        return { usage, window: windowQuota };
    }
}

export class PromptChainHost {
    constructor(workerUrl) {
        this.worker = new Worker(workerUrl, { type: 'module' });
        this.llmManager = new LLMSessionManager();
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
                window.dispatchEvent(new CustomEvent(MessageContext.agentLog, { detail: payload }));
            },
            [MessageContext.agentCallbackEvent]: (id, payload) => {
                window.dispatchEvent(new CustomEvent(CallbackEvents.eventDispatch, { detail: payload }));
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

        this.worker.onmessage = this.handleWorkerMessage.bind(this);
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

    runAgent(userPrompt, sessionId = "default_session") {
        return new Promise((resolve, reject) => {
            const id = ++this.msgId;
            this.callbacks.set(id, { resolve, reject });

            this.worker.postMessage({
                id,
                type: MessageContext.startLoop,
                payload: { userPrompt, sessionId }
            });
        });
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
}
