import { Runnable } from "./runnable.js";

/**
 * Hybrid Cloud Fallback Runnable.
 * Executes remote API calls (e.g. Gemini API) when local on-device LLM inference fails or is unavailable.
 *
 * @extends Runnable
 */
export class CloudFallbackLLMRunnable extends Runnable {
    /**
     * @param {Object} [options={}] - Configuration options.
     * @param {string} [options.apiUrl] - Endpoint URL for the cloud API.
     * @param {string|null} [options.apiKey=null] - API key if required.
     * @param {Object} [options.headers] - HTTP headers.
     * @param {Function} [options.requestBuilder] - Custom request payload builder function.
     * @param {Function} [options.responseParser] - Custom response payload parser function.
     * @param {Function} [options.logToMain] - Logging callback function.
     */
    constructor(options = {}) {
        super();
        this.apiUrl = options.apiUrl || "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent";
        this.apiKey = options.apiKey || null;
        this.headers = options.headers || { "Content-Type": "application/json" };
        this.requestBuilder = options.requestBuilder || ((prompt) => ({
            contents: [{ parts: [{ text: typeof prompt === "string" ? prompt : JSON.stringify(prompt) }] }]
        }));
        this.responseParser = options.responseParser || ((data) => data?.candidates?.[0]?.content?.parts?.[0]?.text || JSON.stringify(data));
        this.logToMain = options.logToMain || (() => {});
    }

    /**
     * Executes remote cloud LLM inference.
     * @param {string|Object} prompt - Input prompt to send.
     * @param {Object} [config={}] - Execution options.
     * @returns {Promise<string>} Parsed string response.
     */
    async invoke(prompt, config = {}) {
        this.logToMain("☁️ CloudFallback: Executing remote fallback inference...");
        if (!this.apiUrl) {
            throw new Error("CloudFallbackLLMRunnable requires a valid apiUrl.");
        }
        const url = this.apiKey ? `${this.apiUrl}?key=${this.apiKey}` : this.apiUrl;
        const body = JSON.stringify(this.requestBuilder(prompt));

        const response = await fetch(url, {
            method: "POST",
            headers: this.headers,
            body
        });
        if (!response.ok) {
            throw new Error(`Cloud API Error: HTTP status ${response.status}`);
        }
        const data = await response.json();
        return this.responseParser(data);
    }
}
