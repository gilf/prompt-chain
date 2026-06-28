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

export async function runWithTimeout(executeFn, input, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            const err = new Error("Tool execution timed out.");
            err.name = "TimeoutError";
            reject(err);
        }, timeoutMs);

        Promise.resolve(executeFn(input))
            .then(result => {
                clearTimeout(timer);
                resolve(result);
            })
            .catch(err => {
                clearTimeout(timer);
                reject(err);
            });
    });
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
        const rawSummary = await askLLM(summaryPrompt, null);
        updatedSummary = rawSummary.trim();
        logToMain(`New Conversation Summary: ${updatedSummary}`);
        updatedHistory = historyTurns.slice(-RECENCY_TURNS_TO_KEEP);
    } catch (err) {
        logToMain(`Failed to summarize conversation: ${err.message}. Saving history without summarization.`);
    }

    return { historyTurns: updatedHistory, updatedSummary };
}
