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

export class InterruptException extends Error {
    constructor(payload) {
        const msg = typeof payload === 'string' ? payload : (payload?.toolName ? `Interrupted for approval: ${payload.toolName}` : "Execution interrupted");
        super(msg);
        this.name = "InterruptException";
        this.payload = payload;
    }
}

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

export function validateJSONSchema(schema, data, path = "") {
    const errors = [];
    if (!schema || typeof schema !== "object") return { valid: true, errors };

    if (schema.type) {
        const types = Array.isArray(schema.type) ? schema.type : [schema.type];
        const dataType = Array.isArray(data) ? "array" : (data === null ? "null" : typeof data);
        if (!types.includes(dataType) && !(types.includes("number") && dataType === "number")) {
            errors.push(`Error at ${path || "/"}: expected ${types.join(" or ")}, got ${dataType}`);
            return { valid: false, errors };
        }
    }

    if (Array.isArray(schema.enum) && !schema.enum.includes(data)) {
        errors.push(`Error at ${path || "/"}: value '${JSON.stringify(data)}' must be one of [${schema.enum.map(v => JSON.stringify(v)).join(", ")}]`);
    }

    if (schema.type === "object" || (!schema.type && typeof data === "object" && data !== null && !Array.isArray(data))) {
        if (typeof data !== "object" || data === null || Array.isArray(data)) {
            errors.push(`Error at ${path || "/"}: expected object, got ${Array.isArray(data) ? "array" : typeof data}`);
            return { valid: false, errors };
        }

        if (Array.isArray(schema.required)) {
            for (const reqProp of schema.required) {
                if (!(reqProp in data) || data[reqProp] === undefined) {
                    errors.push(`Error at ${path}/${reqProp}: missing required property '${reqProp}'`);
                }
            }
        }

        if (schema.properties && typeof schema.properties === "object") {
            for (const [propName, propSchema] of Object.entries(schema.properties)) {
                if (propName in data && data[propName] !== undefined) {
                    const res = validateJSONSchema(propSchema, data[propName], `${path}/${propName}`);
                    if (!res.valid) {
                        errors.push(...res.errors);
                    }
                }
            }
        }
    }

    if (schema.type === "array" || (!schema.type && Array.isArray(data))) {
        if (!Array.isArray(data)) {
            errors.push(`Error at ${path || "/"}: expected array, got ${typeof data}`);
            return { valid: false, errors };
        }
        if (schema.items && typeof schema.items === "object") {
            for (let i = 0; i < data.length; i++) {
                const res = validateJSONSchema(schema.items, data[i], `${path}/${i}`);
                if (!res.valid) {
                    errors.push(...res.errors);
                }
            }
        }
    }

    return { valid: errors.length === 0, errors };
}

export class StructuredOutputRunnable extends Runnable {
    constructor(boundRunnable, schema, options = {}) {
        super();
        this.boundRunnable = boundRunnable;
        this.schema = schema;
        this.parser = options.parser || null;
    }

    async invoke(input, config = {}) {
        const rawResult = await this.boundRunnable.invoke(input, config);
        let parsed = rawResult;
        if (this.parser) {
            parsed = await this.parser.invoke(rawResult, config);
        } else if (typeof rawResult === "string") {
            try {
                let cleanText = rawResult.trim();
                if (cleanText.startsWith("```json")) cleanText = cleanText.slice(7).trim();
                else if (cleanText.startsWith("```")) cleanText = cleanText.slice(3).trim();
                if (cleanText.endsWith("```")) cleanText = cleanText.slice(0, -3).trim();
                parsed = JSON.parse(cleanText);
            } catch (e) {
                return { success: false, error: `Invalid JSON format received (${e.message}). You must respond strictly in JSON syntax conforming to schema.` };
            }
        }

        if (parsed && typeof parsed === "object" && "success" in parsed && "parsed" in parsed) {
            if (!parsed.success) return parsed;
            parsed = parsed.parsed;
        }

        const validation = validateJSONSchema(this.schema, parsed);
        if (!validation.valid) {
            return {
                success: false,
                error: `JSON Schema validation failed: ${validation.errors.join("; ")}`,
                parsed: null,
                validationErrors: validation.errors
            };
        }

        return {
            success: true,
            parsed
        };
    }
}

