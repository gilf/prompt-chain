import { Runnable } from './runnable.js';
import { InterruptException } from './interrupt-exception.js';

export class RunnableInterrupt extends Runnable {
    constructor({ checkFn = null, onInterrupt = null } = {}) {
        super();
        this.checkFn = checkFn;
        this.onInterrupt = onInterrupt;
    }

    async invoke(input, config = {}) {
        const shouldInterrupt = !this.checkFn || await Promise.resolve(this.checkFn(input, config));
        if (shouldInterrupt) {
            const interruptPayload = typeof this.onInterrupt === "function" ? await Promise.resolve(this.onInterrupt(input, config)) : input;
            throw new InterruptException(interruptPayload);
        }
        return input;
    }
}
