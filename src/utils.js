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

export async function compressHistory(historyTurns, conversationSummary, askLLM, logToMain) {
    const SUMMARIZATION_THRESHOLD = 5;
    const RECENCY_TURNS_TO_KEEP = 2;

    if (historyTurns.length < SUMMARIZATION_THRESHOLD) {
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
