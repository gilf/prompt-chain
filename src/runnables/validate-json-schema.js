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
