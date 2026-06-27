import { MessageContext } from "./consts.js";

export class CallbackManager {
    constructor(handlers = {}) {
        this.handlers = new Map();
        for (const [event, fn] of Object.entries(handlers)) {
            this.addHandler(event, fn);
        }
    }

    addHandler(event, fn) {
        if (!this.handlers.has(event)) {
            this.handlers.set(event, []);
        }
        this.handlers.get(event).push(fn);
    }

    removeHandler(event, fn) {
        if (this.handlers.has(event)) {
            const list = this.handlers.get(event).filter(h => h !== fn);
            this.handlers.set(event, list);
        }
    }

    dispatch(event, payload = {}) {
        if (this.handlers.has(event)) {
            for (const handler of this.handlers.get(event)) {
                try {
                    handler(payload);
                } catch (err) {
                    console.error(`Error in callback handler for event '${event}':`, err);
                }
            }
        }

        if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof window === 'undefined') {
            self.postMessage({
                id: 0,
                type: MessageContext.agentCallbackEvent,
                payload: { event, ...payload }
            });
        }
    }
}
