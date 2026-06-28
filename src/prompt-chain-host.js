import { MessageContext, CallbackEvents } from "./consts.js";

export class PromptChainHost {
    constructor(workerUrl) {
        this.worker = new Worker(workerUrl, { type: 'module' });
        this.session = null;
        this.callbacks = new Map();
        this.msgId = 0;

        this.worker.onmessage = this.handleWorkerMessage.bind(this);
    }

    async init(systemPrompt) {
        this.session = await LanguageModel.create({
            systemPrompt: systemPrompt
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

    async handleWorkerMessage(e) {
        const { id, type, payload } = e.data;

        if (type === MessageContext.llmRequest) {
            try {
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
                            this.worker.postMessage({ id, type: MessageContext.llmStreamToken, payload: delta });
                        }
                    }
                    this.worker.postMessage({ id, type: MessageContext.llmResponse, payload: fullResponse });
                } else {
                    const responseText = await this.session.prompt(payload.prompt, options);
                    this.worker.postMessage({ id, type: MessageContext.llmResponse, payload: responseText });
                }
            } catch (err) {
                this.worker.postMessage({ id, type: MessageContext.llmError, payload: err.message });
            }
        }
        else if (type === MessageContext.llmMeasureContext) {
            try {
                let count;
                if (typeof this.session?.measureContextUsage === 'function') {
                    count = await this.session.measureContextUsage(payload.input);
                } else if (typeof this.session?.measureInputUsage === 'function') {
                    count = await this.session.measureInputUsage(payload.input);
                } else {
                    const str = typeof payload.input === 'string' ? payload.input : JSON.stringify(payload.input || '');
                    count = Math.ceil(str.length / 4);
                }
                this.worker.postMessage({ id, type: MessageContext.llmMeasureResponse, payload: { count } });
            } catch (err) {
                this.worker.postMessage({ id, type: MessageContext.llmError, payload: err.message });
            }
        }
        else if (type === MessageContext.llmContextStats) {
            try {
                const usage = this.session?.contextUsage ?? this.session?.inputUsage ?? 0;
                const windowQuota = this.session?.contextWindow ?? this.session?.inputQuota ?? 4096;
                this.worker.postMessage({ id, type: MessageContext.llmStatsResponse, payload: { usage, window: windowQuota } });
            } catch (err) {
                this.worker.postMessage({ id, type: MessageContext.llmError, payload: err.message });
            }
        }
        else if (type === MessageContext.agentLog) {
            window.dispatchEvent(new CustomEvent(MessageContext.agentLog, { detail: payload }));
        }
        else if (type === MessageContext.agentCallbackEvent) {
            window.dispatchEvent(new CustomEvent(CallbackEvents.eventDispatch, { detail: payload }));
        }
        else if (type === MessageContext.agentComplete) {
            const cb = this.callbacks.get(id);
            if (cb) {
                cb.resolve(payload);
            }
            this.callbacks.delete(id);
        }
        else if (type === MessageContext.agentError) {
            const cb = this.callbacks.get(id);
            if (cb) {
                cb.reject(new Error(payload));
            }
            this.callbacks.delete(id);
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
}
