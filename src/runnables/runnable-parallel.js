import { Runnable } from './runnable.js';
import { RunnableLambda } from './runnable-lambda.js';

export class RunnableParallel extends Runnable {
    constructor(runnablesMap) {
        super();
        this.runnablesMap = runnablesMap;
    }

    async invoke(input, config = {}) {
        const entries = Object.entries(this.runnablesMap);
        const results = await Promise.all(
            entries.map(async ([key, runnable]) => {
                let r = runnable;
                if (typeof r === "function") r = new RunnableLambda(r);
                const output = await r.invoke(input, config);
                return [key, output];
            })
        );
        return Object.fromEntries(results);
    }
}
