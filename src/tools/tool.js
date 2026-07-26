import { Runnable } from "../runnables/runnable.js";
import { runWithTimeout } from "../utils.js";

/**
 * Enterprise Tool runnable primitive.
 * Encapsulates executable function logic, parameter schemas, and Human-in-the-Loop (HITL) approval flags.
 *
 * @extends Runnable
 */
export class Tool extends Runnable {
    /**
     * Creates a new Tool instance.
     * @param {string} name - The unique identifier/name for the tool.
     * @param {string} description - Description of what the tool does and when to use it.
     * @param {Function} executeFn - Async execution function receiving tool parameters.
     * @param {Object|null} [schema=null] - Optional JSON Schema validating input parameters.
     * @param {Object} [options={}] - Additional options.
     * @param {boolean} [options.requiresApproval=false] - Whether tool requires human approval prior to execution.
     */
    constructor(name, description, executeFn, schema = null, options = {}) {
        super();
        this.name = name;
        this.description = description;
        this.executeFn = executeFn;
        this.schema = schema;
        this.requiresApproval = Boolean(options.requiresApproval);
    }

    /**
     * Invokes the tool execution logic with optional input schema validation and timeout safeguards.
     * @param {Object|string} input - Input arguments passed to the tool.
     * @param {Object} [config={}] - Execution config (e.g. timeoutMs).
     * @returns {Promise<any>} The result of executing the tool function.
     * @throws {Error} If required schema parameters are missing or execution times out.
     */
    async invoke(input, config = {}) {
        if (this.schema && Array.isArray(this.schema.required) && typeof input === "object" && input !== null) {
            const missing = this.schema.required.filter(key => !(key in input));
            if (missing.length > 0) {
                throw new Error(`Tool '${this.name}' missing required parameter(s): ${missing.join(", ")}`);
            }
        }
        return await runWithTimeout(this.executeFn, input, config.timeoutMs || 3000);
    }
}
