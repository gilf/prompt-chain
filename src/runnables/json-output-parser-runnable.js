import { Runnable } from "./runnable.js";

/**
 * Output parser runnable that extracts and parses JSON objects from raw LLM text outputs (including markdown code blocks).
 *
 * @extends Runnable
 */
export class JSONOutputParserRunnable extends Runnable {
    /**
     * Parses raw response text into a structured JSON result.
     * @param {string} responseText - Raw text string output from LLM.
     * @param {Object} [config={}] - Execution config.
     * @returns {Promise<{success: boolean, parsed?: Object, error?: string}>} Parsing result container.
     */
    async invoke(responseText, config = {}) {
        if (typeof responseText === 'object' && responseText !== null) {
            if (Array.isArray(responseText.toolCalls) && responseText.toolCalls.length > 0) {
                const primary = responseText.toolCalls[0];
                return {
                    success: true,
                    parsed: {
                        thought: responseText.text || "Executing native tool call",
                        toolName: primary.name,
                        toolInput: primary.arguments || {},
                        finalAnswer: ""
                    }
                };
            }
            if (responseText.parsed) return responseText;
            return { success: true, parsed: responseText };
        }

        try {
            let cleanText = (responseText || "").trim();
            if (cleanText.startsWith("```json")) {
                cleanText = cleanText.slice(7).trim();
            } else if (cleanText.startsWith("```")) {
                cleanText = cleanText.slice(3).trim();
            }
            if (cleanText.endsWith("```")) {
                cleanText = cleanText.slice(0, -3).trim();
            }
            return { success: true, parsed: JSON.parse(cleanText) };
        } catch (e) {
            return { success: false, error: `Invalid JSON format received (${e.message}). You must respond strictly in JSON syntax.` };
        }
    }
}
