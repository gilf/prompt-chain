export function isRecoverableError(error) {
    const msg = error.message.toLowerCase();
    return (
        msg.includes("timeout") ||
        msg.includes("time out") ||
        msg.includes("fetch") ||
        msg.includes("network") ||
        msg.includes("http error") ||
        msg.includes("status 5") ||
        msg.includes("status 429") ||
        msg.includes("rate limit") ||
        error.name === "TimeoutError"
    );
}

/**
 * Settles as soon as work finishes or signal aborts.
 * Prevents hanging on long operations if execution is aborted.
 */
export async function untilAborted(work, signal) {
    if (!signal) return await work;
    if (signal.aborted) {
        throw signal.reason || new Error("Execution was aborted.");
    }
    if (typeof work?.catch === 'function') {
        work.catch(() => {});
    }
    const done = new AbortController();
    try {
        return await Promise.race([
            Promise.resolve(work),
            new Promise((_, reject) => {
                signal.addEventListener('abort', () => {
                    reject(signal.reason || new Error("Execution was aborted."));
                }, { once: true, signal: done.signal });
            })
        ]);
    } finally {
        done.abort();
    }
}

export async function runWithTimeout(executeFn, input, timeoutMs = 3000, context = {}) {
    const { signal } = context;
    if (signal?.aborted) {
        throw signal.reason || new Error("Execution was aborted.");
    }

    const timeoutPromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            const err = new Error("Tool execution timed out.");
            err.name = "TimeoutError";
            reject(err);
        }, timeoutMs);

        Promise.resolve(executeFn(input, context))
            .then(result => {
                clearTimeout(timer);
                resolve(result);
            })
            .catch(err => {
                clearTimeout(timer);
                reject(err);
            });
    });

    return await untilAborted(timeoutPromise, signal);
}

export function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export function pruneObservation(input, maxTokens = 3400) {
    if (typeof input === 'string') {
        const maxChars = maxTokens * 3;
        if (input.length > maxChars) {
            return input.slice(0, Math.floor(maxChars / 2)) + "\n...[Observation Truncated due to Token Buffer]...\n" + input.slice(-Math.floor(maxChars / 2));
        }
    } else if (typeof input === 'object' && input !== null && Array.isArray(input.historyTurns)) {
        if (input.historyTurns.length > 2) {
            return { ...input, historyTurns: input.historyTurns.slice(-2) };
        }
    }
    return input;
}

export async function compressHistory(historyTurns, conversationSummary, askLLM, logToMain, options = {}) {
    const SUMMARIZATION_THRESHOLD = options.threshold || 5;
    const RECENCY_TURNS_TO_KEEP = options.recency || 2;
    const forceSummarize = options.forceSummarize || false;

    let shouldSummarize = historyTurns.length >= SUMMARIZATION_THRESHOLD || forceSummarize;
    if (!shouldSummarize && typeof options.measureTokensFn === 'function' && options.maxTokens) {
        try {
            const currentTokens = await options.measureTokensFn(historyTurns);
            const count = typeof currentTokens === 'number' ? currentTokens : (currentTokens?.count ?? 0);
            if (count > options.maxTokens) {
                shouldSummarize = true;
            }
        } catch (e) {
            // Ignore measurement error
        }
    }

    if (!shouldSummarize) {
        return { historyTurns, updatedSummary: conversationSummary };
    }

    logToMain("Summarizing conversation context to compress memory...");
    
    const formatTurn = item => {
        if (typeof item === "string") return item;
        const type = typeof item?.getType === "function" ? item.getType() : item?.type;
        return `${type || "Turn"}: ${item?.content || ""}`;
    };
    const historyStr = historyTurns.map(formatTurn).join('\n');

    let summaryPrompt;
    if (conversationSummary) {
        summaryPrompt = `Based on the following existing summary and the new conversation history, write an updated, concise summary that retains all key facts, decisions, and user preferences.
            Existing Summary:
            ${conversationSummary}
            
            New Conversation History:
            ${historyStr}
            
            Output only the updated summary text. Do not output JSON.`;
    } else {
        summaryPrompt = `Based on the following conversation history, write a concise summary that retains all key facts, decisions, and user preferences.
            Conversation History:
            ${historyStr}
            
            Output only the summary text. Do not output JSON.`;
    }

    let updatedSummary = conversationSummary;
    let updatedHistory = historyTurns;
    try {
        let rawSummary;
        if (typeof options.summarizerFn === 'function') {
            rawSummary = await options.summarizerFn(historyStr, conversationSummary);
        } else if (options.builtInSummarizer && typeof options.builtInSummarizer.summarize === 'function') {
            rawSummary = await options.builtInSummarizer.summarize(historyStr, { context: conversationSummary });
        } else {
            rawSummary = await askLLM(summaryPrompt, null);
        }
        updatedSummary = (rawSummary || '').trim();
        logToMain(`New Conversation Summary: ${updatedSummary}`);
        updatedHistory = historyTurns.slice(-RECENCY_TURNS_TO_KEEP);
    } catch (err) {
        logToMain(`Failed to summarize conversation: ${err.message}. Saving history without summarization.`);
    }

    return { historyTurns: updatedHistory, updatedSummary };
}

export function openIndexedDB(dbName, requiredStores = []) {
    return new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
            resolve(null);
            return;
        }
        const request = indexedDB.open(dbName);

        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            for (const store of requiredStores) {
                const storeName = typeof store === 'string' ? store : store.name;
                const keyPath = typeof store === 'string' ? (storeName === 'conversations' ? 'sessionId' : (storeName === 'checkpoints' ? 'checkpointId' : (storeName === 'traces' ? 'traceId' : 'id'))) : store.keyPath;
                if (!db.objectStoreNames.contains(storeName)) {
                    db.createObjectStore(storeName, { keyPath });
                }
            }
        };

        request.onsuccess = (e) => {
            const db = e.target.result;
            const missingStores = [];
            for (const store of requiredStores) {
                const storeName = typeof store === 'string' ? store : store.name;
                if (!db.objectStoreNames.contains(storeName)) {
                    missingStores.push(store);
                }
            }

            if (missingStores.length > 0) {
                const nextVersion = db.version + 1;
                db.close();
                const upgradeReq = indexedDB.open(dbName, nextVersion);
                upgradeReq.onupgradeneeded = (evt) => {
                    const upgradeDb = evt.target.result;
                    for (const store of requiredStores) {
                        const storeName = typeof store === 'string' ? store : store.name;
                        const keyPath = typeof store === 'string' ? (storeName === 'conversations' ? 'sessionId' : (storeName === 'checkpoints' ? 'checkpointId' : (storeName === 'traces' ? 'traceId' : 'id'))) : store.keyPath;
                        if (!upgradeDb.objectStoreNames.contains(storeName)) {
                            upgradeDb.createObjectStore(storeName, { keyPath });
                        }
                    }
                };
                upgradeReq.onsuccess = (evt) => resolve(evt.target.result);
                upgradeReq.onerror = (evt) => reject(evt.target.error);
            } else {
                resolve(db);
            }
        };

        request.onerror = (e) => reject(e.target.error);
    });
}

/**
 * Finds where an unfinished HTML tag starts at the end of text, or -1.
 * Prevents split-tag injection vulnerabilities when streaming HTML chunks.
 */
export function pendingTagStart(text) {
    if (typeof text !== 'string') return -1;
    const match = /<[a-zA-Z!/][^>]*$/.exec(text);
    return match ? match.index : -1;
}

/**
 * Checks if a string contains common markdown formatting patterns.
 */
export function looksLikeMarkdown(text) {
    if (typeof text !== 'string') return false;
    return /(?:^#{1,6} |^[-*+] |\d+\. |\*\*|__|\[.+?\]\(|^> |^```)/m.test(text);
}

/**
 * Splits text into alternating prose and markdown code-fence chunks.
 * Preserves code snippets with raw HTML formatting during sanitization.
 */
export function splitByCodeFences(text) {
    if (typeof text !== 'string') return [];
    const parts = [];
    const fence = /^```[^\n]*\n[\s\S]*?^```[ \t]*$/gm;
    let lastIndex = 0;
    let match;
    while ((match = fence.exec(text)) !== null) {
        if (match.index > lastIndex) {
            parts.push({
                type: 'prose',
                content: text.slice(lastIndex, match.index)
            });
        }
        parts.push({ type: 'code', content: match[0] });
        lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) {
        parts.push({ type: 'prose', content: text.slice(lastIndex) });
    }
    return parts;
}

/**
 * Removes dangerous protocol URLs (javascript:, vbscript:, data:) from href and src.
 */
export function stripUnsafeUrls(html) {
    if (typeof html !== 'string') return html;
    return html.replace(/(href|src)\s*=\s*(["'])\s*(?:javascript|data|vbscript):[\s\S]*?\2/gi, '$1="#"');
}

/**
 * Zero-dependency HTML Sanitizer.
 * Uses native browser Sanitizer API if available, with a resilient fallback for Node.js / older browsers.
 * Preserves fenced code blocks when ignoreFencedCode is enabled.
 */
export function sanitizeHtml(html, options = {}) {
    if (typeof html !== 'string') return '';
    const ignoreFencedCode = options.ignoreFencedCode !== false;

    if (ignoreFencedCode && html.includes('```')) {
        const segments = splitByCodeFences(html);
        return segments.map(seg => {
            if (seg.type === 'code') return seg.content;
            return sanitizeHtml(seg.content, { ...options, ignoreFencedCode: false });
        }).join('');
    }

    // 1. Browser Sanitizer API if available
    if (typeof document !== 'undefined' && typeof Element !== 'undefined' && typeof Element.prototype.setHTML === 'function') {
        const inertDoc = document.implementation.createHTMLDocument('');
        const container = inertDoc.createElement('div');
        if (options.sanitizer && options.sanitizer !== 'default') {
            container.setHTML(html, { sanitizer: options.sanitizer });
        } else {
            container.setHTML(html);
        }
        return stripUnsafeUrls(container.innerHTML);
    }

    // 2. Resilient universal regex fallback for Node.js and standard browsers
    let sanitized = html
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
        .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
        .replace(/<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi, '')
        .replace(/<embed\b[^<]*(?:(?!<\/embed>)<[^<]*)*<\/embed>/gi, '')
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
        .replace(/\son\w+\s*=\s*(["'])[\s\S]*?\1/gi, '')
        .replace(/\son\w+\s*=\s*[^>\s]+/gi, '');

    return stripUnsafeUrls(sanitized);
}

/**
 * State-preserving streaming HTML sanitizer.
 * Buffers partial tags across chunk boundaries to prevent tag-boundary injection.
 */
export class StreamingHtmlSanitizer {
    constructor(options = {}) {
        this.options = options;
        this.buffer = "";
    }

    push(chunk) {
        if (!chunk) return "";
        this.buffer += chunk;
        const tagIndex = pendingTagStart(this.buffer);
        let toEmit = "";
        if (tagIndex !== -1) {
            toEmit = this.buffer.slice(0, tagIndex);
            this.buffer = this.buffer.slice(tagIndex);
        } else {
            toEmit = this.buffer;
            this.buffer = "";
        }
        return toEmit ? sanitizeHtml(toEmit, this.options) : "";
    }

    flush() {
        const remaining = this.buffer;
        this.buffer = "";
        return remaining ? sanitizeHtml(remaining, this.options) : "";
    }
}

