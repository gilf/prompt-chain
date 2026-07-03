import { Runnable, registerRunnableClasses } from './runnable.js';

export class RunnableBinding extends Runnable {
    constructor(boundRunnable, kwargs) {
        super();
        this.boundRunnable = boundRunnable;
        this.kwargs = kwargs;
    }

    async invoke(input, config = {}) {
        return await this.boundRunnable.invoke(input, { ...config, ...this.kwargs });
    }
}

registerRunnableClasses({ RunnableBinding });
