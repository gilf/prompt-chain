import { Runnable } from './runnable.js';
import { InterruptException } from './interrupt-exception.js';

export class RunnableFallback extends Runnable {
    constructor(runnables = [], options = {}) {
        super();
        this.runnables = runnables;
        this.onFallback = options.onFallback || null;
    }

    async invoke(input, config = {}) {
        if (!this.runnables || this.runnables.length === 0) {
            throw new Error("RunnableFallback requires at least one runnable.");
        }
        let lastError = null;
        for (let i = 0; i < this.runnables.length; i++) {
            const currentRunnable = this.runnables[i];
            try {
                return await currentRunnable.invoke(input, config);
            } catch (err) {
                if (err instanceof InterruptException || err.name === "InterruptException") {
                    throw err;
                }
                lastError = err;
                if (i < this.runnables.length - 1) {
                    const nextRunnable = this.runnables[i + 1];
                    if (typeof this.onFallback === "function") {
                        await Promise.resolve(this.onFallback(err, currentRunnable, nextRunnable, i));
                    }
                }
            }
        }
        throw lastError || new Error("All runnables in RunnableFallback failed.");
    }
}
