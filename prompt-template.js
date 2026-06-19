export class PromptTemplate {
    constructor() {
        this.systemInstruction = `You are an autonomous AI agent with long-term memory. Think step-by-step.
            You must STRICTLY output valid JSON matching the schema.
            
            Rules:
            1. If you need data, set "toolName" to a tool and "toolInput" to the query. Leave "finalAnswer" as "".
            2. If you know the answer, set "toolName" to "none" and put the answer in "finalAnswer".`;

        this.fewShotExamples = `
            --- Example 1: Using a Tool ---
            User: What is the current stock price of Apple?
            {"thought": "I need to look up the real-time stock price for Apple (AAPL).", "toolName": "FetchStockPrice", "toolInput": "AAPL", "finalAnswer": ""}
            Observation from FetchStockPrice: 175.50
            {"thought": "I have the observation. I can now provide the final answer.", "toolName": "none", "toolInput": "", "finalAnswer": "The current stock price of Apple is $175.50."}
            
            --- Example 2: Answering Directly ---
            User: What is the capital of France?
            {"thought": "I know the capital of France is Paris. No tool is needed.", "toolName": "none", "toolInput": "", "finalAnswer": "The capital of France is Paris."}
            `;
    }

    format(relevantTools, historyTurns, userPrompt, summary = "") {
        const toolDescriptions = relevantTools.length > 0
            ? relevantTools.map(t => `- ${t.name}: ${t.description}`).join('\n')
            : "- none: No external tools available for this query.";

        const summaryPart = summary
            ? `Conversation Summary (Background Context):\n${summary}\n\n`
            : "";

        return `${this.systemInstruction}           
            Available tools for this request:
            ${toolDescriptions}
            - none: Use this if you do not need a tool.
            
            ${this.fewShotExamples}
            
            --- Current Conversation ---
            ${summaryPart}Prior History:
            ${historyTurns.length > 0 ? historyTurns.join('\n') : "No prior history."}
            
            User: ${userPrompt}
            Output your next step as JSON:`;
    }
}