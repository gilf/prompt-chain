import { Runnable, registerRunnableClasses } from './runnable.js';

export class RunnableLambda extends Runnable {
    constructor(func) {
        super();
        this.func = func;
    }

    async invoke(input, config = {}) {
        return await Promise.resolve(this.func(input, config));
    }
}

registerRunnableClasses({ RunnableLambda });
