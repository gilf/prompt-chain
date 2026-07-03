import { Runnable } from './runnable.js';
import { validateJSONSchema } from './validate-json-schema.js';

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
