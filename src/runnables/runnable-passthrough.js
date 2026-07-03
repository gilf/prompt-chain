import { Runnable } from './runnable.js';
import { RunnableLambda } from './runnable-lambda.js';
import { RunnableParallel } from './runnable-parallel.js';

export class RunnablePassthrough extends Runnable {
    async invoke(input, config = {}) {
        return input;
    }

    static assign(mapping) {
        return new RunnableLambda(async (input, config) => {
            if (typeof input !== "object" || input === null) {
                throw new Error("RunnablePassthrough.assign expects an object input.");
            }
            const parallel = new RunnableParallel(mapping);
            const computedValues = await parallel.invoke(input, config);
            return { ...input, ...computedValues };
        });
    }
}
