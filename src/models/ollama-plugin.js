import { BaseModelPlugin } from "./base-model-plugin.js";

/**
 * Model Plugin for Ollama local REST API (Zero external dependencies).
 * Supports /api/chat and /api/generate with native fetch streaming.
 * @extends BaseModelPlugin
 */
export class OllamaPlugin extends BaseModelPlugin {
    /**
     * @param {Object} [options]
     * @param {string} [options.model="llama3"] - Ollama model identifier (e.g., "llama3", "mistral", "qwen2.5").
     * @param {string} [options.baseUrl="http://localhost:11434"] - Ollama server host URL.
     * @param {string} [options.apiEndpoint="/api/chat"] - Endpoint path ("/api/chat" or "/api/generate").
     * @param {number} [options.temperature=0.7] - Generation temperature.
     * @param {number} [options.contextWindow=8192] - Context window size.
     * @param {Object} [options.headers] - Custom HTTP headers.
     * @param {Function} [options.fetch] - Custom fetch function override.
     */
    constructor(options = {}) {
        super();
        this.model = options.model || "llama3";
        this.baseUrl = (options.baseUrl || "http://localhost:11434").replace(/\/$/, "");
        this.apiEndpoint = options.apiEndpoint || "/api/chat";
        this.temperature = options.temperature ?? 0.7;
        this.contextWindow = options.contextWindow || 8192;
        this.headers = options.headers || {};
        this.fetchFn = options.fetch || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
        this.systemPrompt = "";
        this.lastTokenUsage = 0;
    }

    /**
     * Stores system prompt instruction.
     */
    async init(systemPrompt) {
        if (systemPrompt) {
            this.systemPrompt = systemPrompt;
        }
    }

    /**
     * Executes prompt request against Ollama REST endpoint.
     */
    async generate(payload, onToken) {
        if (!this.fetchFn) {
            throw new Error("Native fetch function is unavailable in this environment.");
        }

        const promptText = typeof payload === 'string' ? payload : (payload.prompt || '');
        const schema = payload?.schema;

        const isChat = this.apiEndpoint === "/api/chat";
        const url = `${this.baseUrl}${this.apiEndpoint}`;

        let requestBody;

        if (isChat) {
            const messages = [];
            if (this.systemPrompt) {
                messages.push({ role: "system", content: this.systemPrompt });
            }
            messages.push({ role: "user", content: promptText });

            requestBody = {
                model: this.model,
                messages,
                stream: typeof onToken === 'function',
                options: {
                    temperature: payload?.temperature ?? this.temperature
                }
            };
        } else {
            requestBody = {
                model: this.model,
                prompt: promptText,
                system: this.systemPrompt || undefined,
                stream: typeof onToken === 'function',
                options: {
                    temperature: payload?.temperature ?? this.temperature
                }
            };
        }

        if (schema) {
            requestBody.format = "json";
        }

        const response = await this.fetchFn(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...this.headers
            },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Ollama API error (${response.status}): ${errText}`);
        }

        if (requestBody.stream && response.body && typeof response.body.getReader === 'function') {
            const reader = response.body.getReader();
            const decoder = new TextDecoder("utf-8");
            let fullText = "";
            let buffer = "";

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });

                const lines = buffer.split("\n");
                buffer = lines.pop() || "";

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;
                    try {
                        const parsed = JSON.parse(trimmed);
                        let token = "";
                        if (isChat) {
                            token = parsed.message?.content || "";
                        } else {
                            token = parsed.response || "";
                        }
                        if (token) {
                            fullText += token;
                            if (typeof onToken === 'function') {
                                onToken(token);
                            }
                        }
                        if (parsed.eval_count) {
                            this.lastTokenUsage = (parsed.prompt_eval_count || 0) + (parsed.eval_count || 0);
                        }
                    } catch (e) {
                        // ignore parse errors for partial chunks
                    }
                }
            }

            if (buffer.trim()) {
                try {
                    const parsed = JSON.parse(buffer.trim());
                    const token = isChat ? parsed.message?.content : parsed.response;
                    if (token) {
                        fullText += token;
                        if (typeof onToken === 'function') onToken(token);
                    }
                } catch (e) {}
            }

            return fullText;
        } else {
            const json = await response.json();
            const output = isChat ? (json.message?.content || "") : (json.response || "");
            if (json.eval_count) {
                this.lastTokenUsage = (json.prompt_eval_count || 0) + (json.eval_count || 0);
            }
            if (typeof onToken === 'function' && output) {
                onToken(output);
            }
            return output;
        }
    }

    async measureContextUsage(input) {
        const str = typeof input === 'string' ? input : JSON.stringify(input || '');
        return Math.ceil(str.length / 4);
    }

    getContextStats() {
        return { usage: this.lastTokenUsage, window: this.contextWindow };
    }
}
