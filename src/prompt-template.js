import { Runnable } from "./runnable.js";

export class PromptTemplate extends Runnable {
    constructor() {
        super();
        this.systemInstruction = `You are an autonomous AI agent with long-term memory. Think step-by-step.
            You must STRICTLY output valid JSON matching the schema.
            
            Rules:
            1. If you need data or action, set "toolName" to a tool and "toolInput" to the required arguments (either a string or a structured JSON object matching the tool's Parameters schema). Leave "finalAnswer" as "".
            2. If you know the answer, set "toolName" to "none" and put the answer in "finalAnswer".`;

        this.fewShotExamples = `
            --- Example 1: Using a Simple Tool ---
            User: What is the current stock price of Apple?
            {"thought": "I need to look up the real-time stock price for Apple (AAPL).", "toolName": "FetchStockPrice", "toolInput": "AAPL", "finalAnswer": ""}
            Observation from FetchStockPrice: 175.50
            {"thought": "I have the observation. I can now provide the final answer.", "toolName": "none", "toolInput": "", "finalAnswer": "The current stock price of Apple is $175.50."}
            
            --- Example 2: Using a Multi-Parameter Structured Tool ---
            User: Book 2 flight tickets from NYC to LAX.
            {"thought": "I need to invoke bookFlight with origin NYC, dest LAX, and 2 passengers.", "toolName": "bookFlight", "toolInput": {"origin": "NYC", "dest": "LAX", "passengers": 2}, "finalAnswer": ""}
            Observation from bookFlight: Flight BF-101 booked successfully for 2 passengers from NYC to LAX.
            {"thought": "The flight is booked. I can now confirm to the user.", "toolName": "none", "toolInput": "", "finalAnswer": "Your flight from NYC to LAX for 2 passengers has been booked successfully (Confirmation: BF-101)."}
            
            --- Example 3: Answering Directly ---
            User: What is the capital of France?
            {"thought": "I know the capital of France is Paris. No tool is needed.", "toolName": "none", "toolInput": "", "finalAnswer": "The capital of France is Paris."}
            `;
    }

    formatMessage(msg) {
        if (typeof msg === "string") return msg;
        const type = typeof msg?.getType === "function" ? msg.getType() : msg?.type;
        const content = msg?.content || "";
        switch (type) {
            case "human": return `User: ${content}`;
            case "ai": return `Assistant: ${content}`;
            case "system": return `System: ${content}`;
            case "tool": return `Observation (${msg.tool_name || "Tool"}): ${content}`;
            default: return content;
        }
    }

    format(relevantTools, historyTurns, userPrompt, summary = "", skillInstructions = "") {
        const toolDescriptions = relevantTools.length > 0
            ? relevantTools.map(t => {
                const schemaStr = t.schema ? ` | Parameters: ${JSON.stringify(t.schema)}` : ` | Parameters: string`;
                return `- ${t.name}: ${t.description}${schemaStr}`;
            }).join('\n')
            : "- none: No external tools available for this query.";

        const summaryPart = summary
            ? `Conversation Summary (Background Context):\n${summary}\n\n`
            : "";

        const skillPart = skillInstructions
            ? `Active Skill Instructions & Guidelines:\n${skillInstructions}\n\n`
            : "";

        const formattedHistory = historyTurns.length > 0
            ? historyTurns.map(m => this.formatMessage(m)).join('\n')
            : "No prior history.";

        return `${this.systemInstruction}           
            Available tools for this request:
            ${toolDescriptions}
            - none: Use this if you do not need a tool.
            
            ${this.fewShotExamples}
            
            --- Current Conversation ---
            ${summaryPart}${skillPart}Prior History:
            ${formattedHistory}
            
            User: ${userPrompt}
            Output your next step as JSON:`;
    }

    async invoke(input, config = {}) {
        const { relevantTools = [], historyTurns = [], userPrompt = "", summary = "", skillInstructions = "" } = input;
        return this.format(relevantTools, historyTurns, userPrompt, summary, skillInstructions);
    }
}