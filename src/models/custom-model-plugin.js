import { BaseModelPlugin } from "./base-model-plugin.js";

/**
 * Model Plugin wrapper for functional callbacks or custom LLM backends.
 * Allows developers to define custom generate, init, measure, and destroy logic.
 * @extends BaseModelPlugin
 */
export class CustomModelPlugin extends BaseModelPlugin {
    /**
     * @param {Object} options
     * @param {Function} options.generateFn - Async function (payload, onToken) => string | object.
     * @param {Function} [options.initFn] - Async function (systemPrompt, options) => void.
     * @param {Function} [options.measureContextFn] - Async function (input) => number.
     * @param {Function} [options.getStatsFn] - Function () => { usage: number, window: number }.
     * @param {Function} [options.destroyFn] - Async function () => void.
     */
    constructor(options = {}) {
        super();
        if (typeof options.generateFn !== 'function') {
            throw new Error("CustomModelPlugin requires a generateFn function in options.");
        }
        this.generateFn = options.generateFn;
        this.initFn = options.initFn || null;
        this.measureContextFn = options.measureContextFn || null;
        this.getStatsFn = options.getStatsFn || null;
        this.destroyFn = options.destroyFn || null;
    }

    async init(systemPrompt, options = {}) {
        if (typeof this.initFn === 'function') {
            await this.initFn(systemPrompt, options);
        }
    }

    async generate(payload, onToken) {
        return await this.generateFn(payload, onToken);
    }

    async measureContextUsage(input) {
        if (typeof this.measureContextFn === 'function') {
            return await this.measureContextFn(input);
        }
        return await super.measureContextUsage(input);
    }

    getContextStats() {
        if (typeof this.getStatsFn === 'function') {
            return this.getStatsFn();
        }
        return super.getContextStats();
    }

    async destroy() {
        if (typeof this.destroyFn === 'function') {
            await this.destroyFn();
        }
    }
}
