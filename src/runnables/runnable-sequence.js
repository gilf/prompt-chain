import { Runnable, registerRunnableClasses } from './runnable.js';
import { RunnableLambda } from './runnable-lambda.js';

export class RunnableSequence extends Runnable {
    constructor(first, second) {
        super();
        this.first = first;
        this.second = second;
    }

    static from(runnables) {
        if (!Array.isArray(runnables) || runnables.length === 0) {
            throw new Error("RunnableSequence.from expects a non-empty array of runnables.");
        }
        let seq = runnables[0];
        if (typeof seq === "function") seq = new RunnableLambda(seq);

        for (let i = 1; i < runnables.length; i++) {
            let next = runnables[i];
            if (typeof next === "function") next = new RunnableLambda(next);
            seq = seq.pipe(next);
        }
        return seq;
    }

    async invoke(input, config = {}) {
        const firstOutput = await this.first.invoke(input, config);
        return await this.second.invoke(firstOutput, config);
    }
}

registerRunnableClasses({ RunnableSequence });
