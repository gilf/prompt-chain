/**
 * Core LangChain Expression Language (LCEL) Primitives
 */

export class Runnable {
    async invoke(input, config = {}) {
        throw new Error("Abstract method invoke() must be implemented.");
    }

    pipe(nextRunnable) {
        if (typeof nextRunnable === "function") {
            nextRunnable = new RunnableLambda(nextRunnable);
        }
        return new RunnableSequence(this, nextRunnable);
    }

    bind(kwargs) {
        return new RunnableBinding(this, kwargs);
    }
}

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

export class RunnableLambda extends Runnable {
    constructor(func) {
        super();
        this.func = func;
    }

    async invoke(input, config = {}) {
        return await Promise.resolve(this.func(input, config));
    }
}

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
