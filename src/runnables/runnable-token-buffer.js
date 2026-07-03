import { Runnable } from './runnable.js';

export class RunnableTokenBuffer extends Runnable {
    constructor({ boundRunnable = null, measureTokensFn = null, getStatsFn = null, thresholdRatio = 0.85, fallbackMaxTokens = 3400, pruneObservationFn = null, summarizeFn = null } = {}) {
        super();
        this.boundRunnable = boundRunnable;
        this.measureTokensFn = measureTokensFn;
        this.getStatsFn = getStatsFn;
        this.thresholdRatio = thresholdRatio;
        this.fallbackMaxTokens = fallbackMaxTokens;
        this.pruneObservationFn = pruneObservationFn;
        this.summarizeFn = summarizeFn;
    }

    async invoke(input, config = {}) {
        let currentInput = input;
        let currentTokens;
        let maxTokens = this.fallbackMaxTokens;

        if (typeof this.getStatsFn === 'function') {
            try {
                const stats = await this.getStatsFn();
                if (stats && stats.window) {
                    maxTokens = Math.floor(stats.window * this.thresholdRatio);
                }
            } catch (e) {
                // Fallback to default maxTokens
            }
        }

        if (typeof this.measureTokensFn === 'function') {
            try {
                const tokenResponse = await this.measureTokensFn(currentInput);
                currentTokens = typeof tokenResponse === 'number' ? tokenResponse : (tokenResponse?.count ?? 0);
            } catch (e) {
                const str = typeof currentInput === 'string' ? currentInput : JSON.stringify(currentInput || '');
                currentTokens = Math.ceil(str.length / 4);
            }
        } else {
            const str = typeof currentInput === 'string' ? currentInput : JSON.stringify(currentInput || '');
            currentTokens = Math.ceil(str.length / 4);
        }

        if (currentTokens > maxTokens) {
            if (typeof this.pruneObservationFn === 'function') {
                currentInput = await Promise.resolve(this.pruneObservationFn(currentInput, maxTokens));
            }
            if (typeof this.summarizeFn === 'function') {
                currentInput = await Promise.resolve(this.summarizeFn(currentInput, maxTokens));
            }
        }

        if (this.boundRunnable) {
            return await this.boundRunnable.invoke(currentInput, config);
        }
        return currentInput;
    }
}
